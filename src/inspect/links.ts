import { registrableDomain } from '../util/domain.js';
import type { Fetcher } from './fetcher.js';
import { pageLinks } from './page.js';
import type { RobotsPolicy } from './robots.js';
import type { ObservationDraft, PageContext } from './types.js';

/** Status of a URL via HEAD, confirmed with GET when HEAD fails (some servers mishandle HEAD). */
async function probeStatus(url: string, fetcher: Fetcher): Promise<number | null> {
  try {
    let res = await fetcher.fetch(url, { method: 'HEAD' });
    if (res.status >= 400) res = await fetcher.fetch(url, { discardBody: true });
    return res.status;
  } catch {
    // Network errors on a single URL are not evidence either way.
    return null;
  }
}

const isBroken = (status: number | null) => status === 404 || status === 410 || (status !== null && status >= 500);

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
    const status = await probeStatus(url, fetcher);
    if (isBroken(status)) broken.push(`${status} ${url}`);
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

/**
 * Confirms a browser BROKEN_IMAGES suspicion over HTTP: only images on the site's own domain
 * that answer 404/410/5xx count. Lazy-load placeholders, 403s and third-party pixels are dropped.
 */
export async function confirmBrokenImages(
  suspicion: ObservationDraft,
  siteDomain: string,
  fetcher: Fetcher,
): Promise<ObservationDraft | null> {
  const urls = (suspicion.evidenceDetail ?? '').split('\n').filter(Boolean);
  const confirmed: string[] = [];
  for (const url of urls) {
    if (registrableDomain(url) !== siteDomain) continue;
    const status = await probeStatus(url, fetcher);
    if (isBroken(status)) confirmed.push(`${status} ${url}`);
  }
  if (confirmed.length === 0) return null;
  return {
    ...suspicion,
    status: 'verified',
    description: `${confirmed.length} image(s) on the home page are missing on the server`,
    evidenceDetail: confirmed.join('\n'),
  };
}
