import 'dotenv/config';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config/load.js';
import { MARKET_CODES, MarketCode } from '../config/schema.js';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { buildDigest } from '../inspect/digest.js';
import { Budget, BudgetExceededError, estimateInputTokens } from '../llm/budget.js';
import { AnthropicLlmClient } from '../llm/client.js';
import { SCREEN_PROMPT, SCREEN_PROMPT_VERSION, screenCompany } from '../llm/screen.js';

const USAGE = `Usage: npm run screen -- [--market UK] [--limit 10] [--domain example.co.uk] [--dry-run] [--force]

Stage B: screens inspected companies with Claude Haiku (paid API, see config/llm.yaml and
the budgets in config/limits.yaml). Companies already screened with the same input and
prompt are skipped at no cost.

  --market    one market (default: all enabled)
  --limit     max companies (default 10)
  --domain    screen one company by domain
  --dry-run   show the digest and the cost estimate; no API call
  --force     screen again even if this exact input was already screened (costs money)
`;

const { values } = parseArgs({
  options: {
    market: { type: 'string' },
    limit: { type: 'string' },
    domain: { type: 'string' },
    'dry-run': { type: 'boolean' },
    force: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const config = loadConfig();
const stage = config.llm.stages.screen;
const limit = values.limit === undefined ? 10 : Number(values.limit);
if (!Number.isInteger(limit) || limit < 1) {
  process.stderr.write(`--limit must be a positive integer\n\n${USAGE}`);
  process.exit(2);
}
let markets = [...config.markets.values()].filter((m) => m.enabled).map((m) => m.code);
if (values.market) {
  const m = MarketCode.safeParse(values.market.toUpperCase());
  if (!m.success) {
    process.stderr.write(`--market must be one of ${MARKET_CODES.join(', ')}\n\n${USAGE}`);
    process.exit(2);
  }
  markets = [m.data];
}

const db = openDb(path.resolve(config.app.db_file));
migrate(db);

const companies = values.domain
  ? (db.prepare('SELECT id, domain FROM companies WHERE domain = ?').all(values.domain.toLowerCase()) as { id: string; domain: string }[])
  : (db
      .prepare(
        `SELECT c.id, c.domain FROM companies c
         WHERE c.status = 'inspected' AND c.last_inspection_id IS NOT NULL
           AND c.market IN (${markets.map(() => '?').join(', ')})
           ${values.force ? '' : `AND NOT EXISTS (SELECT 1 FROM assessments a WHERE a.company_id = c.id AND a.stage = 'screen')`}
         ORDER BY random() LIMIT ?`,
      )
      .all(...markets, limit) as { id: string; domain: string }[]);

if (companies.length === 0) {
  process.stdout.write('Нет компаний для отбора (нужен статус inspected после npm run reinspect).\n');
  process.exit(0);
}

const price = config.llm.prices[stage.model]!;
if (values['dry-run']) {
  const first = buildDigest(db, companies[0]!.id, stage.digest_max_chars);
  if (first) process.stdout.write(`${'='.repeat(70)}\nСводка для ${companies[0]!.domain}:\n${'='.repeat(70)}\n${first.text}\n\n`);
  let tokens = 0;
  for (const c of companies) {
    const d = buildDigest(db, c.id, stage.digest_max_chars);
    if (d) tokens += estimateInputTokens(SCREEN_PROMPT, d.text) + 500;
  }
  const est = (tokens * price.input + companies.length * 1000 * price.output) / 1_000_000;
  const worst = (tokens * price.input + companies.length * stage.max_output_tokens * price.output) / 1_000_000;
  process.stdout.write(
    `Компаний: ${companies.length} · модель ${stage.model} · промпт ${SCREEN_PROMPT_VERSION}\n` +
      `Вход ≈ ${tokens} токенов · оценка ≈ $${est.toFixed(4)} (максимум $${worst.toFixed(4)}) · API не вызывался\n`,
  );
  process.exit(0);
}

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  process.stderr.write('ANTHROPIC_API_KEY не задан в .env\n');
  process.exit(2);
}

const llm = new AnthropicLlmClient({ apiKey, timeoutMs: config.llm.request_timeout_ms, maxRetries: config.llm.sdk_max_retries });
const budget = new Budget(db, config, (msg) => process.stdout.write(`⚠ ${msg}\n`));
const tally = { deep: 0, maybe: 0, skip: 0, failed: 0, no_data: 0, cached: 0 };

process.stdout.write(`Отбор (этап B): ${companies.length} компаний · ${stage.model} · промпт ${SCREEN_PROMPT_VERSION}\n\n`);
for (const [i, c] of companies.entries()) {
  const n = `[${String(i + 1).padStart(String(companies.length).length)}/${companies.length}] ${c.domain.padEnd(32)}`;
  try {
    const out = await screenCompany(c.id, { db, config, llm, budget, force: values.force ?? false });
    if (out.status === 'no_data') {
      tally.no_data++;
      process.stdout.write(`${n} — нет данных инспекции\n`);
    } else if (out.status === 'failed') {
      tally.failed++;
      process.stdout.write(`${n} ⚠ ошибка: ${out.error} · $${out.cost.toFixed(4)}\n`);
    } else {
      if (out.status === 'cached') tally.cached++;
      tally[out.decision]++;
      const top = out.result.opportunities[0];
      const hook = out.validation.opportunities[0]?.hookVerified ? '✓' : '·';
      process.stdout.write(
        `${n} ${out.decision.padEnd(5)} ${out.status === 'cached' ? '(кэш) ' : ''}· ${out.result.business_type}` +
          (top ? ` · ${hook} ${top.title}` : '') +
          ` · $${out.cost.toFixed(4)}\n`,
      );
    }
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      process.stdout.write(`\n⛔ Остановлено по бюджету: ${err.message}\n`);
      break;
    }
    throw err;
  }
}

process.stdout.write(
  `\ndeep ${tally.deep} · maybe ${tally.maybe} · skip ${tally.skip} · ошибок ${tally.failed} · без данных ${tally.no_data}` +
    (tally.cached ? ` · из кэша ${tally.cached}` : '') +
    `\nВызовов API: ${budget.runCalls} · потрачено за прогон $${budget.runSpent.toFixed(4)} · за месяц $${budget.monthSpent().toFixed(4)}\n`,
);
db.close();
