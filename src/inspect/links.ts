import { registrableDomain } from '../util/domain.js';
import type { Fetcher } from './fetcher.js';
import { pageLinks } from './page.js';
import type { RobotsPolicy } from './robots.js';
import type { ObservationDraft, PageContext } from './types.js';

/** BROKEN_INTERNAL_LINKS: GET internal header/nav links, report 404/5xx (spec 8.3). */
export async function checkBrokenNavLinks(
  home: PageContext,
  fetcher: Fetcher,
  robots: RobotsPolicy,
  max: number,
): Promise<ObservationDraft | null> {
  const domain = registrableDomain(home.url);
  const urls = [
    ...new Set(
      pageLinks(home)
        .filter((l) => l.inNav && registrableDomain(l.href) === domain && robots.isAllowed(l.href))
        .map((l) => l.href),
    ),
  ].slice(0, max);

  const broken: string[] = [];
  for (const url of urls) {
    try {
      // Some servers answer HEAD with 405/404 incorrectly; confirm with GET before reporting.
      let res = await fetcher.fetch(url, { method: 'HEAD' });
      if (res.status >= 400) res = await fetcher.fetch(url, { discardBody: true });
      if (res.status === 404 || res.status === 410 || res.status >= 500) broken.push(`${res.status} ${url}`);
    } catch {
      // Network errors on a single link are not evidence of a broken link.
    }
  }
  if (broken.length === 0) return null;
  return {
    code: 'BROKEN_INTERNAL_LINKS',
    status: 'verified',
    description: `${broken.length} navigation link(s) return an error page`,
    evidenceUrl: home.url,
    evidenceDetail: broken.join('\n'),
  };
}
