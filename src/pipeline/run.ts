import path from 'node:path';
import pLimit from 'p-limit';
import type { Config } from '../config/load.js';
import { dnsMxChecker } from '../contacts/mx.js';
import type { Db } from '../db/connection.js';
import { companiesToProcess, finishRun, startRun, upsertDiscovered, type CompanyRow } from '../db/repo.js';
import { DomainThrottle, HttpFetcher } from '../inspect/fetcher.js';
import { PlaywrightInspector } from '../inspect/mobile.js';
import type { DiscoverySource } from '../sources/types.js';
import { logger } from '../util/logger.js';
import type { PipelineArgs } from './args.js';
import { processCompany, type ProcessResult } from './processCompany.js';

export interface RunOptions extends PipelineArgs {
  discover: boolean;
  browser: boolean;
}

export interface RunOutcome {
  runId: string;
  discoveredNew: number;
  results: { domain: string; name: string | null; city: string | null; result: ProcessResult }[];
}

export async function runPipeline(
  db: Db,
  config: Config,
  opts: RunOptions,
  source: DiscoverySource | null,
  onProgress: (done: number, total: number, domain: string, r: ProcessResult) => void = () => {},
): Promise<RunOutcome> {
  const market = config.markets.get(opts.market)!;
  const segment = config.segments.get(opts.segment)!;
  const runId = startRun(db, opts);
  const errors: string[] = [];

  let discoveredNew = 0;
  if (opts.discover && source) {
    try {
      for await (const candidate of source.discover({
        market: opts.market,
        segment,
        cities: market.discovery_cities,
        limit: opts.limit,
      })) {
        const res = upsertDiscovered(db, candidate, {
          market: opts.market,
          segment: opts.segment,
          sourceId: source.id,
          termsNote: source.termsNote,
        });
        if (res?.created) discoveredNew++;
      }
    } catch (err) {
      errors.push(`discovery: ${(err as Error).message}`);
      logger.error({ err: (err as Error).message }, 'discovery failed; continuing with already discovered companies');
    }
  }

  const companies = companiesToProcess(db, opts.market, opts.segment, opts.limit);
  const { results, errors: inspectErrors } = await inspectCompanies(
    db,
    config,
    companies,
    { browser: opts.browser, mode: 'discover' },
    onProgress,
  );
  errors.push(...inspectErrors);

  finishRun(db, runId, {
    discovered: discoveredNew,
    inspected: results.filter((r) => r.result.status === 'inspected').length,
    rejected_auto: results.filter((r) => r.result.status === 'rejected_auto').length,
    errors,
  });
  return { runId, discoveredNew, results };
}

/** Inspects the given companies with bounded concurrency; market and segment come from each company row. */
export async function inspectCompanies(
  db: Db,
  config: Config,
  companies: CompanyRow[],
  opts: { browser: boolean; mode: 'discover' | 'reinspect' },
  onProgress: (done: number, total: number, domain: string, r: ProcessResult) => void = () => {},
): Promise<{ results: RunOutcome['results']; errors: string[] }> {
  const fetcher = new HttpFetcher({
    userAgent: config.app.user_agent,
    timeoutMs: config.limits.request_timeout_ms,
    maxBytes: config.limits.max_response_bytes,
    maxRedirects: config.limits.max_redirects,
    throttle: new DomainThrottle(config.limits.per_domain_delay_ms),
  });
  const mobile = opts.browser ? new PlaywrightInspector(config.app.user_agent, config.limits.request_timeout_ms * 2) : null;
  const limit = pLimit(config.limits.max_concurrent_sites);
  const results: RunOutcome['results'] = [];
  const errors: string[] = [];

  try {
    await Promise.all(
      companies.map((company) =>
        limit(async () => {
          const result = await processCompany(company, {
            db,
            fetcher,
            mobile,
            mxCheck: dnsMxChecker,
            market: config.markets.get(company.market)!,
            segment: company.segment ?? 'S2',
            robotsToken: config.app.robots_token,
            maxPages: config.limits.max_pages_per_site,
            maxNavLinks: config.limits.max_nav_links_checked,
            mainTextMaxChars: config.limits.page_main_text_max_chars,
            linksMax: config.limits.page_links_max,
            screenshotRoot: path.resolve(config.app.data_dir, 'screenshots'),
            mode: opts.mode,
          });
          if (result.status === 'error') errors.push(`${company.domain}: ${result.reason}`);
          results.push({ domain: company.domain, name: company.name, city: company.city, result });
          onProgress(results.length, companies.length, company.domain, result);
        }),
      ),
    );
  } finally {
    await mobile?.close();
  }
  return { results, errors };
}
