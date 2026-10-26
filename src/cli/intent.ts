import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, type Config } from '../config/load.js';
import { openDb } from '../db/connection.js';
import { pendingMigrations } from '../db/migrate.js';
import { DomainThrottle, HttpFetcher, type Fetcher } from '../inspect/fetcher.js';
import { robotsFromResponse } from '../inspect/robots.js';
import { titleLooksLikeRequest } from '../intent/buyer.js';
import { classify } from '../intent/classify.js';
import { checkAmbiguous } from '../intent/llmCheck.js';
import { rankRequests } from '../intent/rank.js';
import { CF_API, fetchContractsFinder } from '../intent/sources/contractsFinder.js';
import { fetchDiscourse, parseRss, threadStartDate } from '../intent/sources/forums.js';
import { fetchHn, HN_API } from '../intent/sources/hn.js';
import { saveRequests } from '../intent/store.js';
import type { BuiltinSource, ClassifiedRequest, RawRequest } from '../intent/types.js';
import { Budget } from '../llm/budget.js';
import { AnthropicLlmClient } from '../llm/client.js';
import { writeIntentReport, type IntentRunInfo } from '../reports/intent.js';

const USAGE = `Usage: npm run intent -- [--source <ids>] [--secondary] [--dry-run] [--llm --max-llm-usd 0.02]

Finds PUBLIC requests where someone explicitly wants to commission development work (buyer
intent), classifies them with rules (config/intent.yaml) and the Service Capability Profile
(config/capabilities.yaml), saves them to intent_leads and writes data/reports/intent-*.md and .csv.
Public APIs and feeds only, robots.txt respected, nothing is sent.

  --source        comma-separated ids: hn_freelance, hn_hiring, uk_contracts_finder and the forum
                  feed ids in config/intent.yaml (default: all enabled)
  --secondary     also read the secondary platform-specialist forums (Bubble, n8n, Make)
  --dry-run       fetch and classify, write the report, but do not write to the database
  --llm           PAID: let Claude Haiku decide only requests the rules marked ambiguous
  --max-llm-usd   hard cap for --llm in this run (default 0.02)
`;

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    secondary: { type: 'boolean' },
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
const builtin: BuiltinSource[] = ['hn_freelance', 'hn_hiring', 'uk_contracts_finder'];
const feeds = config.intent.sources.forums.feeds;
const known = [...builtin, ...feeds.map((f) => f.id)];
const chosen = values.source
  ? values.source.split(',').map((s) => s.trim())
  : [...builtin.filter((s) => config.intent.sources[s].enabled), ...feeds.filter((f) => f.enabled || (values.secondary && f.secondary)).map((f) => f.id)];
const bad = chosen.filter((s) => !known.includes(s));
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

/** robots.txt of the host must allow the path we read (RFC 9309; 4xx = no restrictions). */
async function allowed(f: Fetcher, url: string, cfg: Config): Promise<boolean> {
  const res = await f.fetch(new URL('/robots.txt', url).toString());
  return robotsFromResponse(res, cfg.app.robots_token).isAllowed(url);
}

const info: IntentRunInfo = {
  generatedAt: new Date(),
  sources: [],
  unavailable: [
    'Reddit — robots.txt запрещает автоматический доступ (Disallow: /); поисковый инструмент тоже не отдаёт reddit.com',
    'Indie Hackers — robots.txt прямо запрещает ClaudeBot / Claude-SearchBot',
    'Squarespace Forum — robots.txt запрещает ClaudeBot',
    'boards.ie — защита Cloudflare (проверка браузера), обходить нельзя',
    'Upscale Method — HTTP 403 на robots.txt и страницы',
    'Госзакупки Казахстана (goszakup.gov.kz) — API требует токен (регистрация)',
  ],
  llm: 'только правила, без LLM',
};
const since = new Date(info.generatedAt.getTime() - config.intent.sources.forums.days * 86400_000);
const raws: RawRequest[] = [];
for (const s of chosen) {
  const feed = feeds.find((f) => f.id === s);
  try {
    if (feed) {
      const probe = feed.kind === 'rss' ? feed.url : `${feed.url.replace(/\/$/, '')}/c/${feed.categories[0]!.path}.json`;
      if (!(await allowed(fetcher, probe, config))) throw new Error('robots.txt запрещает доступ');
      if (feed.kind === 'rss') {
        const res = await fetcher.fetch(feed.url);
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        const requests = parseRss(res.body, feed, since);
        raws.push(...requests);
        info.sources.push({ source: s, label: feed.label, scanned: (res.body.match(/<item[\s>]/gi) ?? []).length, requests: requests.length, note: `Лента RSS, темы за ${config.intent.sources.forums.days} дн.` });
      } else {
        const { requests, listed } = await fetchDiscourse(fetcher, feed, since, (t) => titleLooksLikeRequest(t, config.intent));
        raws.push(...requests);
        info.sources.push({ source: s, label: feed.label, scanned: listed, requests: requests.length, note: `Discourse, темы за ${config.intent.sources.forums.days} дн.; в загруженных разделах прочитаны только темы с заголовком-запросом.` });
      }
    } else if (s === 'uk_contracts_finder') {
      const c = config.intent.sources.uk_contracts_finder;
      if (!(await allowed(fetcher, CF_API, config))) throw new Error('robots.txt запрещает доступ');
      const { requests, scanned } = await fetchContractsFinder(fetcher, c.days, c.cpv_prefixes);
      raws.push(...requests);
      info.sources.push({ source: s, scanned, requests: requests.length, note: `Уведомления за ${c.days} дн. с CPV ${c.cpv_prefixes.join('/')}*; повторные версии склеены.` });
    } else {
      const hnSource = s as 'hn_freelance' | 'hn_hiring';
      if (!(await allowed(fetcher, `${HN_API}/search_by_date`, config))) throw new Error('robots.txt запрещает доступ');
      const months = config.intent.sources[hnSource].months;
      const { requests, threads } = await fetchHn(fetcher, hnSource, months);
      raws.push(...requests);
      info.sources.push({ source: s, scanned: requests.length, requests: requests.length, note: `Ветки за ${months} мес.: ${threads.length ? threads.map((t) => t.split(' — ')[0]).join('; ') : 'нет'}.` });
    }
    process.stdout.write(`✔ ${s}: ${info.sources.at(-1)!.requests}\n`);
  } catch (err) {
    info.unavailable.unshift(`${feed?.label ?? s} — не удалось получить данные: ${(err as Error).message}`);
    process.stdout.write(`✖ ${s}: ${(err as Error).message}\n`);
  }
}

// Forum feeds date threads by their last reply: for the posts that read like a buyer, fetch the
// thread page once to learn when it was actually started (robots.txt checked), then judge again.
const BUYERISH = new Set(['PROJECT_BUYER', 'SERVICE_RECOMMENDATION', 'POTENTIAL_BUYER', 'AGENCY_PARTNERSHIP']);
let checkedDates = 0;
for (const [i, r] of raws.entries()) {
  if (!r.dateIsActivity || !BUYERISH.has(classify(r, config, { now: info.generatedAt }).buyerCategory)) continue;
  try {
    if (!(await allowed(fetcher, r.url, config))) continue;
    const started = await threadStartDate(fetcher, r.url);
    if (started) {
      raws[i] = { ...r, publishedAt: started, dateIsActivity: false };
      checkedDates++;
    }
  } catch {
    // Left as activity-dated: reported, not shortlisted.
  }
}
if (checkedDates) process.stdout.write(`Дата создания темы проверена: ${checkedDates}\n`);
let classified: ClassifiedRequest[] = raws.map((r) => classify(r, config, { now: info.generatedAt }));
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

/**
 * URLs already presented as leads in earlier discovery reports (data/reports/*.csv): marked, never
 * shown as new. From intent-*.csv only shortlisted rows count (a rejected post was never a lead);
 * other CSVs in the folder are hand-made experiment shortlists and count in full.
 */
function previouslyReported(dir: string): Map<string, string> {
  const seen = new Map<string, string>();
  let csvs: string[];
  try {
    csvs = readdirSync(dir).filter((f) => f.endsWith('.csv'));
  } catch {
    return seen;
  }
  for (const f of csvs) {
    const lines = readFileSync(path.join(dir, f), 'utf8').split('\n');
    for (const l of f.startsWith('intent-') ? lines.filter((x) => /^\uFEFF?yes,/.test(x)) : lines) {
      for (const m of l.matchAll(/https?:\/\/[^\s",]+/g)) if (!seen.has(m[0])) seen.set(m[0], f);
    }
  }
  return seen;
}
const seen = previouslyReported(path.resolve(config.app.data_dir, 'reports'));
const ranked = rankRequests(classified, info.generatedAt).map((r) => ({ ...r, seenBefore: seen.get(r.url) ?? null }));
const saved = db ? saveRequests(db, classified) : null;
db?.close();
const files = writeIntentReport(config.app.data_dir, ranked, info);
const ambiguous = classified.filter((c) => c.ambiguous).length;
process.stdout.write(
  `\nЗапросов: ${classified.length} · уникальных: ${ranked.length} · в шорт-листе: ${ranked.filter((r) => r.qualified && !r.seenBefore).length}` +
    ` · неоднозначных: ${ambiguous}${values.llm ? '' : ' (без --llm не проверялись)'}\n` +
    (saved ? `В базе: новых ${saved.inserted}, обновлено ${saved.updated}\n` : 'dry-run: база не изменялась\n') +
    `Отчёт: ${files.md}\nCSV: ${files.csv}\n`,
);
