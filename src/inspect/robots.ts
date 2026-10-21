import { createRequire } from 'node:module';
import type { FetchResult } from './fetcher.js';

// robots-parser is CommonJS but its typings declare an ES default export; load it the CJS way.
const robotsParser = createRequire(import.meta.url)('robots-parser') as (
  url: string,
  body: string,
) => { isAllowed(url: string, ua?: string): boolean | undefined };

export interface RobotsPolicy {
  isAllowed(url: string): boolean;
}

const ALLOW_ALL: RobotsPolicy = { isAllowed: () => true };

export function parseRobots(robotsUrl: string, body: string, token: string): RobotsPolicy {
  const robots = robotsParser(robotsUrl, body);
  // robots-parser returns undefined for URLs on another origin; treat that as "not ours to decide" = disallow.
  return { isAllowed: (url) => robots.isAllowed(url, token) === true };
}

/**
 * Policy from a robots.txt response, per RFC 9309: 2xx = parse, 4xx = no restrictions,
 * 5xx = assume full disallow. Rules apply to the origin the file was finally served from.
 */
export function robotsFromResponse(res: FetchResult, token: string): RobotsPolicy {
  if (res.status >= 200 && res.status < 300) {
    // A robots.txt that redirects to an HTML page has no rules.
    const body = res.contentType.includes('html') ? '' : res.body;
    return parseRobots(new URL('/robots.txt', res.finalUrl).toString(), body, token);
  }
  if (res.status >= 400 && res.status < 500) return ALLOW_ALL;
  return { isAllowed: () => false };
}
