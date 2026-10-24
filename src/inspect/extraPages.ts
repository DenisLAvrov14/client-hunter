// Bounded, targeted page reads for stage C: at most a few URLs that the model picked from the
// site's own known links. Same domain only, robots.txt respected, the usual fetcher limits
// (throttle, size, timeout, SSRF guard). Nothing is submitted; failures are simply skipped.
import { registrableDomain } from '../util/domain.js';
import { extractMainTexts } from './extract.js';
import type { Fetcher } from './fetcher.js';
import { buildPageContext } from './page.js';
import { robotsFromResponse, type RobotsPolicy } from './robots.js';
import type { PageContext } from './types.js';

export const MAX_EXTRA_PAGES = 3;

export interface ExtraPageResult {
  pages: PageContext[];
  texts: { url: string; text: string }[];
  skipped: { url: string; reason: string }[];
}

export async function fetchExtraPages(
  fetcher: Fetcher,
  urls: string[],
  companyDomain: string,
  robotsToken: string,
  mainTextMaxChars: number,
): Promise<ExtraPageResult> {
  const pages: PageContext[] = [];
  const skipped: { url: string; reason: string }[] = [];
  const robotsByOrigin = new Map<string, RobotsPolicy>();

  for (const url of urls.slice(0, MAX_EXTRA_PAGES)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      skipped.push({ url, reason: 'invalid URL' });
      continue;
    }
    if (registrableDomain(url) !== companyDomain) {
      skipped.push({ url, reason: 'other domain' });
      continue;
    }
    let robots = robotsByOrigin.get(parsed.origin);
    if (!robots) {
      try {
        robots = robotsFromResponse(await fetcher.fetch(`${parsed.origin}/robots.txt`), robotsToken);
      } catch {
        robots = { isAllowed: () => false };
      }
      robotsByOrigin.set(parsed.origin, robots);
    }
    if (!robots.isAllowed(url)) {
      skipped.push({ url, reason: 'robots.txt' });
      continue;
    }
    try {
      const res = await fetcher.fetch(url);
      if (res.status >= 400 || !res.contentType.includes('html')) {
        skipped.push({ url, reason: `HTTP ${res.status}` });
        continue;
      }
      if (registrableDomain(res.finalUrl) !== companyDomain) {
        skipped.push({ url, reason: 'redirected to another domain' });
        continue;
      }
      pages.push(buildPageContext(res.finalUrl, 'other', res.status, res.body));
    } catch (err) {
      skipped.push({ url, reason: (err as Error).message.slice(0, 120) });
    }
  }

  const mainTexts = extractMainTexts(pages, mainTextMaxChars);
  return { pages, texts: pages.map((p, i) => ({ url: p.url, text: mainTexts[i] ?? '' })), skipped };
}
