import 'dotenv/config';
import { ConfigError, loadConfig } from '../config/load.js';
import { PIPELINE_USAGE, UsageError, parsePipelineArgs } from '../pipeline/args.js';
import { logger } from '../util/logger.js';

function main(): number {
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

  logger.info({ ...args }, 'pipeline stages are not implemented yet (Phase 1)');
  return 1;
}

try {
  process.exitCode = main();
} catch (err) {
  if (err instanceof UsageError) {
    process.stderr.write(`${err.message}\n\n${PIPELINE_USAGE}`);
    process.exitCode = 2;
  } else if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 2;
  } else {
    throw err;
  }
}
