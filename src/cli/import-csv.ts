import 'dotenv/config';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config/load.js';
import { MarketCode, SegmentCode } from '../config/schema.js';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { upsertDiscovered } from '../db/repo.js';
import { readCandidatesCsv } from '../sources/csv.js';

const USAGE = `Usage: npm run import-csv -- --file list.csv --market UK --segment S2

CSV: header with website|domain|url (+ optional name, city), or one domain per line.
Imported companies are inspected by: npm run pipeline -- --market UK --segment S2 --no-discovery
`;

const { values } = parseArgs({
  options: { file: { type: 'string' }, market: { type: 'string' }, segment: { type: 'string' } },
});
const market = MarketCode.safeParse(values.market?.toUpperCase());
const segment = SegmentCode.safeParse(values.segment?.toUpperCase());
if (!values.file || !market.success || !segment.success) {
  process.stderr.write(USAGE);
  process.exit(2);
}

const config = loadConfig();
const db = openDb(path.resolve(config.app.db_file));
migrate(db);
let created = 0;
let skipped = 0;
const candidates = readCandidatesCsv(values.file);
for (const c of candidates) {
  const res = upsertDiscovered(db, c, {
    market: market.data,
    segment: segment.data,
    sourceId: 'csv',
    termsNote: `operator CSV import: ${path.basename(values.file)}`,
  });
  if (res?.created) created++;
  else skipped++;
}
db.close();
process.stdout.write(`Импортировано: ${created} новых, ${skipped} уже были в базе или без домена (строк: ${candidates.length})\n`);
