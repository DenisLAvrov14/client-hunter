import 'dotenv/config';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config/load.js';
import { openDb } from '../db/connection.js';
import { loadLeadInputs } from '../leads/load.js';
import { qualify, rank } from '../leads/qualify.js';
import { writeLeads } from '../reports/leads.js';

const USAGE = `Usage: npm run leads

Commercial lead report from stored data only (inspections, stage B and C results, contacts, risk):
companies ranked by a project worth selling, not by website defects. Read-only, no LLM, no network.
Writes data/reports/leads-*.md and .csv.
`;

const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' } } });
if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const config = loadConfig();
const dbFile = path.resolve(config.app.db_file);
if (!existsSync(dbFile)) {
  process.stderr.write(`База ${dbFile} не найдена\n`);
  process.exit(2);
}
const db = openDb(dbFile, { readonly: true });
const inputs = loadLeadInputs(db);
const list = rank(inputs.map(qualify));
db.close();

const files = writeLeads(config.app.data_dir, list, inputs.length);
const count = (t: string) => list.filter((q) => q.tier === t).length;
process.stdout.write(
  `Сильных возможностей: ${count('strong')} · проверить: ${count('investigate')} · только мелкие дефекты: ${count('minor_technical')} · исключить: ${count('exclude')}\n` +
    `Отчёт: ${files.md}\nCSV: ${files.csv}\n`,
);
