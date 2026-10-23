import 'dotenv/config';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config/load.js';
import { MARKET_CODES, MarketCode } from '../config/schema.js';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { companiesForReinspection } from '../db/repo.js';
import { inspectCompanies } from '../pipeline/run.js';
import { describeResult } from './format.js';

// Reasons that no longer reject since migration 002 (docs/decisions.md). Unusable sites
// (unreachable, robots, 403, offsite redirects) are not re-inspected.
const DEFAULT_REASONS = ['entity_unknown', 'entity_sole_trader', 'no_verified_observation', 'no_contact', 'no_mx'];

const USAGE = `Usage: npm run reinspect -- [--market UK] [--limit 50] [--random] [--refresh] [--browser] [--dry-run]

Re-inspects companies rejected under the old rules (${DEFAULT_REASONS.join(', ')}) and the
old candidates, with the new extraction (clean text, capabilities, all public emails,
outreach risk). Earlier pages and observations are kept; each company is re-inspected once.

  --market    one market (default: all enabled)
  --limit     max companies (default: limits.max_companies_per_run)
  --random    random sample instead of alphabetical order
  --refresh   re-inspect companies already inspected under the new rules (after an extraction fix)
  --browser   also run the Chromium mobile checks (slower; normally only for shortlisted companies)
  --dry-run   only count what would be re-inspected
`;

const { values } = parseArgs({
  options: {
    market: { type: 'string' },
    limit: { type: 'string' },
    random: { type: 'boolean' },
    refresh: { type: 'boolean' },
    browser: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const config = loadConfig();
let markets: MarketCode[];
if (values.market) {
  const m = MarketCode.safeParse(values.market.toUpperCase());
  if (!m.success) {
    process.stderr.write(`--market must be one of ${MARKET_CODES.join(', ')}\n\n${USAGE}`);
    process.exit(2);
  }
  markets = [m.data];
} else {
  markets = [...config.markets.values()].filter((m) => m.enabled).map((m) => m.code);
}
const limit = values.limit === undefined ? config.limits.max_companies_per_run : Number(values.limit);
if (!Number.isInteger(limit) || limit < 1) {
  process.stderr.write(`--limit must be a positive integer\n\n${USAGE}`);
  process.exit(2);
}

const db = openDb(path.resolve(config.app.db_file));
migrate(db);
const companies = companiesForReinspection(db, { markets, reasons: DEFAULT_REASONS, includeLegacyCandidates: true, limit, random: values.random ?? false, refresh: values.refresh ?? false });
process.stdout.write(`К переинспекции: ${companies.length} (${markets.join(', ')})${values['dry-run'] ? ' — dry run' : ''}\n\n`);
if (values['dry-run'] || companies.length === 0) {
  db.close();
  process.exit(0);
}

const { results, errors } = await inspectCompanies(
  db,
  config,
  companies,
  { browser: values.browser ?? false, mode: 'reinspect' },
  (done, total, domain, r) => {
    process.stdout.write(`[${String(done).padStart(String(total).length)}/${total}] ${domain.padEnd(32)} ${describeResult(r)}\n`);
  },
);
db.close();

const count = (s: string) => results.filter((r) => r.result.status === s).length;
process.stdout.write(
  `\nГотово: пригодны для анализа ${count('inspected')} · отсеяно ${count('rejected_auto')} · ошибок ${errors.length}\n` +
    'Отчёт по рынку: npm run report:candidates -- --market UK\n',
);
