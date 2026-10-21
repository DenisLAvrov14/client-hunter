import path from 'node:path';
import type { MarketConfig, SegmentCode } from '../config/schema.js';
import { extractContacts } from '../contacts/extract.js';
import type { MxChecker } from '../contacts/mx.js';
import type { Db } from '../db/connection.js';
import {
  insertContact,
  insertObservation,
  insertPage,
  isSuppressed,
  setStatus,
  updateCompany,
  type CompanyRow,
} from '../db/repo.js';
import { detectEntity } from '../entity/detect.js';
import { runHtmlChecks } from '../inspect/checks.js';
import { FetchError, type Fetcher, type FetchResult } from '../inspect/fetcher.js';
import { checkBrokenNavLinks } from '../inspect/links.js';
import type { MobileInspector, MobileTarget } from '../inspect/mobile.js';
import { buildPageContext, hasInquiryForm } from '../inspect/page.js';
import { pickPages } from '../inspect/pagePicker.js';
import { detectPlatform, isShopifyPasswordPage, looksParked } from '../inspect/platform.js';
import { robotsFromResponse, type RobotsPolicy } from '../inspect/robots.js';
import { countShopifyProducts } from '../inspect/shopify.js';
import type { ObservationDraft, PageContext } from '../inspect/types.js';
import { registrableDomain } from '../util/domain.js';

export interface ProcessDeps {
  db: Db;
  fetcher: Fetcher;
  mobile: MobileInspector | null;
  mxCheck: MxChecker;
  market: MarketConfig;
  segment: SegmentCode;
  robotsToken: string;
  maxPages: number;
  maxNavLinks: number;
  screenshotRoot: string;
}

export interface ProcessResult {
  status: CompanyRow['status'];
  reason: string | null;
  platform: string | null;
  entity: string | null;
  verified: string[];
  likely: string[];
  contact: string | null;
}

class Reject extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Fetches robots.txt over HTTPS, falling back to HTTP only on a TLS error (which becomes SSL_ERROR). */
async function resolveOrigin(
  fetcher: Fetcher,
  domainUrl: string,
): Promise<{ robotsRes: FetchResult; sslError: string | null }> {
  const host = new URL(domainUrl).hostname;
  try {
    return { robotsRes: await fetcher.fetch(`https://${host}/robots.txt`), sslError: null };
  } catch (err) {
    if (!(err instanceof FetchError) || err.code !== 'tls') throw err;
    const robotsRes = await fetcher.fetch(`http://${host}/robots.txt`);
    return { robotsRes, sslError: err.message };
  }
}

/** Runs one company through website → entity → inspection → contacts (spec 6, 8). Never throws for site problems. */
export async function processCompany(company: CompanyRow, deps: ProcessDeps): Promise<ProcessResult> {
  const { db, fetcher, market } = deps;
  const result: ProcessResult = {
    status: 'discovered',
    reason: null,
    platform: null,
    entity: null,
    verified: [],
    likely: [],
    contact: null,
  };

  try {
    if (isSuppressed(db, company.domain)) throw new Reject('suppressed');

    // 1. robots.txt first (spec 8.1 step 1), then the home page.
    let origin: { robotsRes: FetchResult; sslError: string | null };
    try {
      origin = await resolveOrigin(fetcher, company.website_url ?? `https://${company.domain}/`);
    } catch (err) {
      throw new Reject(`site_unreachable: ${(err as Error).message}`.slice(0, 200));
    }
    const robotsByOrigin = new Map<string, RobotsPolicy>();
    const siteOrigin = new URL(origin.robotsRes.finalUrl).origin;
    robotsByOrigin.set(siteOrigin, robotsFromResponse(origin.robotsRes, deps.robotsToken));
    if (origin.robotsRes.status >= 500) throw new Reject('robots_unavailable');

    const robotsFor = async (url: string): Promise<RobotsPolicy> => {
      const o = new URL(url).origin;
      let policy = robotsByOrigin.get(o);
      if (!policy) {
        try {
          policy = robotsFromResponse(await fetcher.fetch(`${o}/robots.txt`), deps.robotsToken);
        } catch {
          policy = { isAllowed: () => false };
        }
        robotsByOrigin.set(o, policy);
      }
      return policy;
    };

    const homeUrl = `${siteOrigin}/`;
    if (!(await robotsFor(homeUrl)).isAllowed(homeUrl)) throw new Reject('robots_disallow');

    let homeRes: FetchResult;
    try {
      homeRes = await fetcher.fetch(homeUrl);
    } catch (err) {
      throw new Reject(`site_unreachable: ${(err as Error).message}`.slice(0, 200));
    }
    if (registrableDomain(homeRes.finalUrl) !== company.domain) {
      throw new Reject(`redirects_offsite: ${new URL(homeRes.finalUrl).hostname}`);
    }
    if (!(await robotsFor(homeRes.finalUrl)).isAllowed(homeRes.finalUrl)) throw new Reject('robots_disallow');
    if (homeRes.status >= 400) throw new Reject(`home_http_${homeRes.status}`);
    if (!homeRes.contentType.includes('html')) throw new Reject('home_not_html');

    const home = buildPageContext(homeRes.finalUrl, 'home', homeRes.status, homeRes.body);
    // Parking pages often render their text via JS, so also look at raw HTML when there is little text.
    if (looksParked(home.text) || (home.text.length < 200 && looksParked(home.html))) throw new Reject('parked_domain');

    const platform = detectPlatform(home.html);
    result.platform = platform;
    updateCompany(db, company.id, { platform, website_url: homeRes.finalUrl });
    if (deps.segment === 'S1') {
      if (platform !== 'shopify') throw new Reject('not_shopify');
      if (isShopifyPasswordPage(homeRes.finalUrl, home.html)) throw new Reject('store_closed');
    }

    // 2. Pick and fetch important pages.
    const pages: PageContext[] = [home];
    for (const target of pickPages(home, deps.maxPages - 1)) {
      if (!(await robotsFor(target.url)).isAllowed(target.url)) continue;
      try {
        const res = await fetcher.fetch(target.url);
        if (res.status < 400 && res.contentType.includes('html')) {
          pages.push(buildPageContext(res.finalUrl, target.kind, res.status, res.body));
        }
      } catch {
        // One failing subpage does not fail the company.
      }
    }
    for (const page of pages) insertPage(db, company.id, page);
    setStatus(db, company.id, 'website_resolved');

    // 3. Legal entity (spec 8.6). No registry lookup without a Companies House key.
    const entity = detectEntity(pages, market);
    result.entity = entity.entityType;
    updateCompany(db, company.id, {
      entity_type: entity.entityType,
      entity_evidence: entity.evidence ? `${entity.evidence} (${entity.evidenceUrl})` : null,
      registry_id: entity.registryId,
      registry_status: 'not_checked',
    });
    if (market.require_corporate_entity) {
      if (entity.entityType === 'sole_trader') throw new Reject('entity_sole_trader');
      if (entity.entityType === 'unknown') throw new Reject('entity_unknown');
    }
    setStatus(db, company.id, 'entity_checked');

    // 4. Inspection.
    const productCount =
      platform === 'shopify' ? await countShopifyProducts(siteOrigin, fetcher, await robotsFor(siteOrigin)) : null;
    if (deps.segment === 'S1' && productCount !== null && productCount < 10) throw new Reject('too_few_products');

    const observations: ObservationDraft[] = runHtmlChecks(pages, {
      finalUrl: homeRes.finalUrl,
      sslError: origin.sslError,
      productCount,
    });
    const broken = await checkBrokenNavLinks(home, fetcher, await robotsFor(home.url), deps.maxNavLinks);
    if (broken) observations.push(broken);
    if (deps.mobile) {
      const targets: MobileTarget[] = [{ url: home.url, kind: 'home' }];
      for (const p of pages) if ((p.kind === 'contact' || p.kind === 'quote') && hasInquiryForm(p)) targets.push({ url: p.url, kind: 'form' });
      observations.push(...(await deps.mobile.inspect(targets, path.join(deps.screenshotRoot, company.id))));
    }
    for (const o of observations) insertObservation(db, company.id, o);
    result.verified = observations.filter((o) => o.status === 'verified').map((o) => o.code);
    result.likely = observations.filter((o) => o.status === 'likely').map((o) => o.code);
    setStatus(db, company.id, 'inspected');

    // 5. Contacts (spec 8.5).
    const candidates = extractContacts(pages, company.domain, market, deps.segment);
    if (candidates.length === 0) throw new Reject('no_contact');
    const mxCache = new Map<string, boolean>();
    let firstOk: string | null = null;
    for (const c of candidates) {
      const host = c.email.split('@')[1]!;
      if (!mxCache.has(host)) mxCache.set(host, await deps.mxCheck(host));
      const ok = mxCache.get(host)!;
      insertContact(db, company.id, c, ok);
      if (ok && !firstOk) firstOk = c.email;
    }
    if (!firstOk) throw new Reject('no_mx');
    result.contact = firstOk;

    if (result.verified.length === 0) throw new Reject('no_verified_observation');
    setStatus(db, company.id, 'contact_found');
    result.status = 'contact_found';
  } catch (err) {
    if (err instanceof Reject) {
      setStatus(db, company.id, 'rejected_auto', err.reason);
      result.status = 'rejected_auto';
      result.reason = err.reason;
    } else {
      const message = (err as Error).message?.slice(0, 300) ?? String(err);
      setStatus(db, company.id, 'error', message);
      result.status = 'error';
      result.reason = message;
    }
  }
  return result;
}
