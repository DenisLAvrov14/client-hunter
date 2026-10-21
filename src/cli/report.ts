import 'dotenv/config';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config/load.js';
import { MarketCode } from '../config/schema.js';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { writeCandidatesReport } from '../reports/candidates.js';

const { values } = parseArgs({ options: { market: { type: 'string' } } });
const market = MarketCode.safeParse(values.market?.toUpperCase());
if (!market.success) {
  process.stderr.write('Usage: npm run report:candidates -- --market UK\n');
  process.exit(2);
}

const config = loadConfig();
const db = openDb(path.resolve(config.app.db_file));
migrate(db);
const { md, csv, report } = writeCandidatesReport(db, market.data, config.app.data_dir);
db.close();
process.stdout.write(`Кандидатов: ${report.candidates.length}\nОтчёт: ${md}\nCSV:   ${csv}\n`);
