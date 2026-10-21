import 'dotenv/config';
import path from 'node:path';
import { ConfigError, loadConfig } from '../config/load.js';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { PIPELINE_USAGE, UsageError, parsePipelineArgs } from '../pipeline/args.js';
import type { ProcessResult } from '../pipeline/processCompany.js';
import { runPipeline } from '../pipeline/run.js';
import { writeCandidatesReport } from '../reports/candidates.js';
import { OsmSource } from '../sources/osm.js';

function describe(r: ProcessResult): string {
  if (r.status === 'contact_found') return `✅ кандидат · ${r.verified.join(', ')} · ${r.contact}`;
  if (r.status === 'rejected_auto') return `✖ ${r.reason}`;
  return `⚠ ошибка: ${r.reason}`;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(PIPELINE_USAGE);
    return 0;
  }

  const config = loadConfig();
  const args = parsePipelineArgs(argv, config.limits.max_companies_per_run);
  if (args === 'help') {
    process.stdout.write(PIPELINE_USAGE);
    return 0;
  }

  const market = config.markets.get(args.market);
  if (!market?.enabled) throw new UsageError(`Market ${args.market} is disabled in config/markets`);
  const segment = config.segments.get(args.segment);
  if (!segment) throw new UsageError(`Segment ${args.segment} has no config in config/segments`);
  if (!segment.markets.includes(args.market)) {
    throw new UsageError(`Segment ${args.segment} does not target market ${args.market}`);
  }
  if (args.discover && market.discovery_cities.length === 0) {
    throw new UsageError(`Market ${args.market} has no discovery_cities in its config`);
  }

  const db = openDb(path.resolve(config.app.db_file));
  migrate(db);

  const out = process.stdout;
  out.write(
    `\n${args.market} · ${args.segment} · до ${args.limit} компаний` +
      (args.discover ? ` · поиск в OSM: ${market.discovery_cities.join(', ')}` : ' · без нового поиска') +
      (args.browser ? '' : ' · без браузера') +
      '\n\n',
  );
  if (args.discover) out.write('Ищу компании в OpenStreetMap (может занять пару минут)...\n');

  const source = new OsmSource(config.app.user_agent, config.limits.overpass_timeout_s);
  const outcome = await runPipeline(db, config, args, source, (done, total, domain, r) => {
    out.write(`[${String(done).padStart(String(total).length)}/${total}] ${domain.padEnd(32)} ${describe(r)}\n`);
  });

  const { md, csv, report } = writeCandidatesReport(db, args.market, config.app.data_dir);
  db.close();

  const results = outcome.results.map((r) => r.result);
  const count = (s: ProcessResult['status']) => results.filter((r) => r.status === s).length;
  out.write(
    [
      '',
      '── Итог прогона ──',
      `Новых компаний найдено: ${outcome.discoveredNew}`,
      `Проверено: ${results.length} · кандидатов: ${count('contact_found')} · отсеяно: ${count('rejected_auto')} · ошибок: ${count('error')}`,
      `Всего кандидатов по ${args.market} в базе: ${report.candidates.length}`,
      '',
      `Отчёт: ${md}`,
      `CSV:   ${csv}`,
      '',
    ].join('\n'),
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n\n${PIPELINE_USAGE}`);
      process.exitCode = 2;
    } else if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 2;
    } else {
      throw err;
    }
  });
