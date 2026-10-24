import 'dotenv/config';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config/load.js';
import { openDb } from '../db/connection.js';
import { migrate, pendingMigrations } from '../db/migrate.js';
import { DomainThrottle, HttpFetcher } from '../inspect/fetcher.js';
import { Budget, BudgetExceededError } from '../llm/budget.js';
import { AnthropicLlmClient } from '../llm/client.js';
import { analyzeCompany, DEEP_PROMPT_VERSION, estimateDeepRun } from '../llm/deep.js';
import { dossierMarkdown, writeDossiers } from '../reports/dossier.js';
import { registrableDomain } from '../util/domain.js';

const USAGE = `Usage: npm run deep -- --domain a.co.uk [--domain b.kz ...] [--dry-run] [--force]

Stage C: deep business analysis with Claude Haiku (paid API) for the given companies, and a
Markdown dossier with a draft first message FOR HUMAN REVIEW ONLY — nothing is sent.
Companies whose input did not change since their last analysis are served from cache at no cost.

  --domain    company domain (repeat for several)
  --dry-run   show the input for the first company and a cost estimate; read-only, no API call
  --force     analyse again even if this exact input was analysed before (costs money)
`;

const { values } = parseArgs({
  options: {
    domain: { type: 'string', multiple: true },
    'dry-run': { type: 'boolean' },
    force: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (values.help || !values.domain?.length) {
  process.stdout.write(USAGE);
  process.exit(values.help ? 0 : 2);
}

const config = loadConfig();
const stage = config.llm.stages.deep;
const dryRun = values['dry-run'] ?? false;
const dbFile = path.resolve(config.app.db_file);
if (dryRun && !existsSync(dbFile)) {
  process.stderr.write(`База ${dbFile} не найдена\n`);
  process.exit(2);
}
// A dry run never writes: read-only connection, no migrations, no API.
const db = openDb(dbFile, { readonly: dryRun });
if (dryRun) {
  const pending = pendingMigrations(db);
  if (pending.length) {
    process.stderr.write(`В базе не применены миграции: ${pending.join(', ')}. Сделайте резервную копию базы и выполните npm run migrate.\n`);
    process.exit(2);
  }
} else {
  migrate(db);
}

const companies = values.domain.map((d) => {
  const domain = registrableDomain(d) ?? d.toLowerCase();
  const row = db.prepare('SELECT id, domain FROM companies WHERE domain = ?').get(domain) as { id: string; domain: string } | undefined;
  if (!row) {
    process.stderr.write(`Компания ${d} не найдена в базе\n`);
    process.exit(2);
  }
  return row;
});

if (dryRun) {
  const est = estimateDeepRun(
    db,
    config,
    companies.map((c) => c.id),
    values.force ?? false,
  );
  const first = est.first && companies.find((c) => c.id === est.first!.companyId);
  if (est.first && first) process.stdout.write(`${'='.repeat(70)}\nВход для ${first.domain}:\n${'='.repeat(70)}\n${est.first.text}\n\n`);
  process.stdout.write(
    `Компаний: ${companies.length} · к анализу: ${est.toAnalyze} · из кэша (бесплатно): ${est.cached} · нет данных инспекции: ${est.noData}` +
      ` · ${stage.model} · промпт ${DEEP_PROMPT_VERSION}\n` +
      `Вход ≈ ${est.inputTokens} токенов · оценка ≈ $${est.estimateUsd.toFixed(4)} (максимум ~$${est.worstUsd.toFixed(4)} при всех повторах и доп. страницах)` +
      ` · лимит на запуск $${config.limits.max_llm_cost_usd_per_run} · API не вызывался\n`,
  );
  db.close();
  process.exit(0);
}

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  process.stderr.write('ANTHROPIC_API_KEY не задан в .env\n');
  process.exit(2);
}
const llm = new AnthropicLlmClient({ apiKey, timeoutMs: config.llm.request_timeout_ms * 2, maxRetries: config.llm.sdk_max_retries });
const budget = new Budget(db, config, (msg) => process.stdout.write(`⚠ ${msg}\n`));
const fetcher = new HttpFetcher({
  userAgent: config.app.user_agent,
  timeoutMs: config.limits.request_timeout_ms,
  maxBytes: config.limits.max_response_bytes,
  maxRedirects: config.limits.max_redirects,
  throttle: new DomainThrottle(config.limits.per_domain_delay_ms),
});

process.stdout.write(`Глубокий анализ (этап C): ${companies.length} компаний · ${stage.model} · промпт ${DEEP_PROMPT_VERSION}\n\n`);
const sections: string[] = [];
const tally = { pursue: 0, maybe: 0, drop: 0, failed: 0 };
for (const [i, c] of companies.entries()) {
  const n = `[${i + 1}/${companies.length}] ${c.domain.padEnd(28)}`;
  try {
    const out = await analyzeCompany(c.id, { db, config, llm, budget, fetcher, force: values.force ?? false });
    if (out.status === 'no_data') {
      tally.failed++;
      process.stdout.write(`${n} — нет данных инспекции\n`);
    } else if (out.status === 'failed') {
      tally.failed++;
      process.stdout.write(`${n} ⚠ ошибка: ${out.error} · $${out.cost.toFixed(4)}\n`);
    } else {
      tally[out.result.recommendation]++;
      const best = out.result.opportunities[out.result.best_opportunity_index];
      process.stdout.write(
        `${n} ${out.result.recommendation.padEnd(6)} ${out.status === 'cached' ? '(кэш) ' : ''}· ${best?.title ?? '—'}` +
          `${out.meta.outreachIssues.length ? ' · ⚠ черновик не прошёл проверку' : ''} · $${out.cost.toFixed(4)}\n`,
      );
      sections.push(dossierMarkdown(db, config, c.id, out.result, out.meta, out.cost));
    }
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      process.stdout.write(`\n⛔ Остановлено по бюджету: ${err.message}\n`);
      break;
    }
    throw err;
  }
}

const summary =
  `Компаний: ${companies.length} · стоит предложить: ${tally.pursue} · возможно: ${tally.maybe} · не предлагать: ${tally.drop} · ошибок: ${tally.failed}` +
  ` · вызовов API: ${budget.runCalls} · стоимость: $${budget.runSpent.toFixed(4)} · модель ${stage.model} · промпт ${DEEP_PROMPT_VERSION}`;
const file = writeDossiers(config.app.data_dir, sections, summary);
process.stdout.write(`\n${summary}\nЗа месяц: $${budget.monthSpent().toFixed(4)}\nДосье: ${file}\n`);
db.close();
