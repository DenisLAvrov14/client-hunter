import { parseArgs } from 'node:util';
import { MARKET_CODES, MarketCode, SEGMENT_CODES, SegmentCode } from '../config/schema.js';

export const PIPELINE_USAGE = `Usage: npm run pipeline -- --market <${MARKET_CODES.join('|')}> --segment <${SEGMENT_CODES.join('|')}> [options]

Finds companies in OpenStreetMap for the market's discovery_cities, then inspects their
sites, detects the legal entity and extracts contacts. Nothing is sent anywhere: results
are printed to the console and saved to data/reports/.

Options:
  --market        market code (must be enabled in config/markets/*.yaml)
  --segment       segment code (config/segments/*.yaml)
  --limit N       companies to inspect this run (default: limits.max_companies_per_run)
  --no-discovery  skip OpenStreetMap; inspect companies already in the database
  --no-browser    skip Playwright mobile checks (faster, no screenshots)
  --help          show this help
`;

export interface PipelineArgs {
  market: MarketCode;
  segment: SegmentCode;
  limit: number;
}

export interface PipelineCliArgs extends PipelineArgs {
  discover: boolean;
  browser: boolean;
}

export class UsageError extends Error {}

export function parsePipelineArgs(argv: string[], maxLimit: number): PipelineCliArgs | 'help' {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        market: { type: 'string' },
        segment: { type: 'string' },
        limit: { type: 'string' },
        'no-discovery': { type: 'boolean' },
        'no-browser': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
    }));
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  if (values.help) return 'help';

  const market = MarketCode.safeParse(values.market?.toUpperCase());
  if (!market.success) throw new UsageError(`--market must be one of ${MARKET_CODES.join(', ')}`);
  const segment = SegmentCode.safeParse(values.segment?.toUpperCase());
  if (!segment.success) throw new UsageError(`--segment must be one of ${SEGMENT_CODES.join(', ')}`);

  const limit = values.limit === undefined ? maxLimit : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError('--limit must be a positive integer');
  if (limit > maxLimit) throw new UsageError(`--limit exceeds limits.max_companies_per_run (${maxLimit})`);

  return {
    market: market.data,
    segment: segment.data,
    limit,
    discover: !values['no-discovery'],
    browser: !values['no-browser'],
  };
}
