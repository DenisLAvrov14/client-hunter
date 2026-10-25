import 'dotenv/config';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, type Config } from '../config/load.js';
import { openDb } from '../db/connection.js';
import { pendingMigrations } from '../db/migrate.js';
import { DomainThrottle, HttpFetcher, type Fetcher } from '../inspect/fetcher.js';
import { robotsFromResponse } from '../inspect/robots.js';
import { classify } from '../intent/classify.js';
import { checkAmbiguous } from '../intent/llmCheck.js';
import { rankRequests } from '../intent/rank.js';
import { CF_API, fetchContractsFinder } from '../intent/sources/contractsFinder.js';
import { fetchHn, HN_API } from '../intent/sources/hn.js';
import { saveRequests } from '../intent/store.js';
import type { ClassifiedRequest, IntentSource, RawRequest } from '../intent/types.js';
import { Budget } from '../llm/budget.js';
import { AnthropicLlmClient } from '../llm/client.js';
import { writeIntentReport, type IntentRunInfo } from '../reports/intent.js';

const USAGE = `Usage: npm run intent -- [--source hn_freelance,hn_hiring,uk_contracts_finder] [--dry-run] [--llm --max-llm-usd 0.02]

Finds PUBLIC requests where someone explicitly wants to hire / pay for development work (buyer
intent), classifies them with rules (config/intent.yaml), saves them to intent_leads and writes
data/reports/intent-*.md and .csv. Public APIs only, robots.txt respected, nothing is sent.

  --source        comma-separated sources (default: all enabled in config/intent.yaml)
  --dry-run       fetch and classify, write the report, but do not write to the database
  --llm           PAID: let Claude Haiku decide only requests the rules marked ambiguous
  --max-llm-usd   hard cap for --llm in this run (default 0.02)
`;

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    'dry-run': { type: 'boolean' },
    llm: { type: 'boolean' },
    'max-llm-usd': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const config = loadConfig();
const all: IntentSource[] = ['hn_freelance', 'hn_hiring', 'uk_contracts_finder'];
const chosen = values.source ? (values.source.split(',').map((s) => s.trim()) as IntentSource[]) : all.filter((s) => config.intent.sources[s].enabled);
const bad = chosen.filter((s) => !all.includes(s));
if (bad.length) {
  process.stderr.write(`Неизвестный источник: ${bad.join(', ')}\n\n${USAGE}`);
  process.exit(2);
}

const dbFile = path.resolve(config.app.db_file);
const dryRun = values['dry-run'] ?? false;
const db = dryRun ? null : openDb(dbFile);
if (db) {
  const pending = pendingMigrations(db);
  if (pending.length) {
    process.stderr.write(`В базе не применены миграции: ${pending.join(', ')}. Сделайте резервную копию базы и выполните npm run migrate.\n`);
    process.exit(2);
  }
}

const fetcher = new HttpFetcher({
  userAgent: config.app.user_agent,
  timeoutMs: config.limits.request_timeout_ms * 2,
  maxBytes: config.limits.max_response_bytes,
  maxRedirects: config.limits.max_redirects,
  throttle: new DomainThrottle(config.limits.per_domain_delay_ms),
});

/** robots.txt of the API host must allow the path we read (RFC 9309; 4xx = no restrictions). */
async function allowed(f: Fetcher, url: string, cfg: Config): Promise<boolean> {
  const res = await f.fetch(new URL('/robots.txt', url).toString());
  return robotsFromResponse(res, cfg.app.robots_token).isAllowed(url);
}

const info: IntentRunInfo = {
  generatedAt: new Date(),
  sources: [],
  unavailable: [
    'Reddit — robots.txt запрещает автоматический доступ (Disallow: /); нужен официальный API с регистрацией приложения',
    'Госзакупки Казахстана (goszakup.gov.kz) — API требует токен (регистрация)',
    'Ирландия / Нидерланды (eTenders, TenderNed, TED) — не подключены в этой версии',
  ],
  llm: 'только правила, без LLM',
};
const raws: RawRequest[] = [];
for (const s of chosen) {
  try {
    if (s === 'uk_contracts_finder') {
      const c = config.intent.sources.uk_contracts_finder;
      if (!(await allowed(fetcher, CF_API, config))) throw new Error('robots.txt запрещает доступ');
      const { requests, scanned } = await fetchContractsFinder(fetcher, c.days, c.cpv_prefixes);
      raws.push(...requests);
      info.sources.push({ source: s, scanned, requests: requests.length, note: `Уведомления за ${c.days} дн. с CPV ${c.cpv_prefixes.join('/')}*; повторные версии склеены.` });
    } else {
      if (!(await allowed(fetcher, `${HN_API}/search_by_date`, config))) throw new Error('robots.txt запрещает доступ');
      const months = config.intent.sources[s].months;
      const { requests, threads } = await fetchHn(fetcher, s, months);
      raws.push(...requests);
      info.sources.push({ source: s, scanned: requests.length, requests: requests.length, note: `Ветки за ${months} мес.: ${threads.length ? threads.map((t) => t.split(' — ')[0]).join('; ') : 'нет'}.` });
    }
    process.stdout.write(`✔ ${s}: ${info.sources.at(-1)!.requests}\n`);
  } catch (err) {
    info.unavailable.unshift(`${s} — не удалось получить данные: ${(err as Error).message}`);
    process.stdout.write(`✖ ${s}: ${(err as Error).message}\n`);
  }
}

let classified: ClassifiedRequest[] = raws.map((r) => classify(r, config.intent));
if (values.llm) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    process.stderr.write('--llm: ANTHROPIC_API_KEY не задан в .env\n');
    process.exit(2);
  }
  const cap = Number(values['max-llm-usd'] ?? '0.02');
  const capped: Config = { ...config, limits: { ...config.limits, max_llm_cost_usd_per_run: Math.min(cap, config.limits.max_llm_cost_usd_per_run) } };
  const llmDb = db ?? openDb(dbFile);
  const budget = new Budget(llmDb, capped);
  const llm = new AnthropicLlmClient({ apiKey, timeoutMs: config.llm.request_timeout_ms });
  const res = await checkAmbiguous(new Map(raws.map((r) => [`${r.source}:${r.itemId}`, r])), classified, { config: capped, llm, budget });
  classified = res.list;
  info.llm = `Haiku для неоднозначных: проверено ${res.checked}, принято ${res.accepted}, $${budget.runSpent.toFixed(4)}${res.stoppedByBudget ? ' (остановлено по бюджету)' : ''}`;
}

const ranked = rankRequests(classified, info.generatedAt);
const saved = db ? saveRequests(db, classified) : null;
db?.close();
const files = writeIntentReport(config.app.data_dir, ranked, info);
const ambiguous = classified.filter((c) => c.ambiguous).length;
process.stdout.write(
  `\nЗапросов: ${classified.length} · уникальных: ${ranked.length} · квалифицировано: ${ranked.filter((r) => r.qualified).length}` +
    ` · неоднозначных: ${ambiguous}${values.llm ? '' : ' (без --llm не проверялись)'}\n` +
    (saved ? `В базе: новых ${saved.inserted}, обновлено ${saved.updated}\n` : 'dry-run: база не изменялась\n') +
    `Отчёт: ${files.md}\nCSV: ${files.csv}\n`,
);
