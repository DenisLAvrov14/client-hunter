import { parseArgs } from 'node:util';
import { MARKET_CODES, MarketCode, SEGMENT_CODES, SegmentCode } from '../config/schema.js';

export const PIPELINE_USAGE = `Usage: npm run pipeline -- --market <${MARKET_CODES.join('|')}> --segment <${SEGMENT_CODES.join('|')}> [--limit N]

Runs discovery -> inspection -> contacts for one market and segment.

Options:
  --market   market code (must be enabled in config/markets/*.yaml)
  --segment  segment code (config/segments/*.yaml)
  --limit    max companies this run (default: limits.max_companies_per_run)
  --help     show this help
`;

export interface PipelineArgs {
  market: MarketCode;
  segment: SegmentCode;
  limit: number;
}

export class UsageError extends Error {}

export function parsePipelineArgs(argv: string[], maxLimit: number): PipelineArgs | 'help' {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        market: { type: 'string' },
        segment: { type: 'string' },
        limit: { type: 'string' },
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

  return { market: market.data, segment: segment.data, limit };
}
