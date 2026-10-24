import path from 'node:path';
import type { MarketConfig, SegmentCode } from '../config/schema.js';
import { extractChannels } from '../contacts/channels.js';
import { extractContacts } from '../contacts/extract.js';
import type { MxChecker } from '../contacts/mx.js';
import type { Db } from '../db/connection.js';
import {
  finishInspection,
  insertObservation,
  insertOutreachRisk,
  insertPage,
  isSuppressed,
  logEvent,
  setStatus,
  startInspection,
  updateCompany,
  upsertContact,
  upsertContactChannel,
  type CompanyRow,
} from '../db/repo.js';
import { detectEntity } from '../entity/detect.js';
import { detectCapabilities, type Capabilities } from '../inspect/capabilities.js';
import { runHtmlChecks } from '../inspect/checks.js';
import { extractMainTexts, internalLinks } from '../inspect/extract.js';
import { FetchError, type Fetcher, type FetchResult } from '../inspect/fetcher.js';
import { checkBrokenNavLinks, confirmBrokenImages } from '../inspect/links.js';
import type { MobileInspector, MobileTarget, PageRenderer } from '../inspect/mobile.js';
import { buildPageContext, hasInquiryForm } from '../inspect/page.js';
import { pickPages } from '../inspect/pagePicker.js';
import { detectPlatform, isShopifyPasswordPage, looksParked } from '../inspect/platform.js';
import { robotsFromResponse, type RobotsPolicy } from '../inspect/robots.js';
import { countShopifyProducts } from '../inspect/shopify.js';
import type { ObservationDraft, PageContext } from '../inspect/types.js';
import { contactStatusOf, type ContactStatus } from '../outreach/contactStatus.js';
import { assessOutreachRisk, RISK_RULES_VERSION, type OutreachRisk } from '../outreach/risk.js';
import { registrableDomain } from '../util/domain.js';

export interface ProcessDeps {
  db: Db;
  fetcher: Fetcher;
  mobile: MobileInspector | null;
  /** Renders the home page with JavaScript when the server HTML has almost no text. */
  renderer: PageRenderer | null;
  mxCheck: MxChecker;
  market: MarketConfig;
  segment: SegmentCode;
  robotsToken: string;
  maxPages: number;
  maxNavLinks: number;
  mainTextMaxChars: number;
  linksMax: number;
  screenshotRoot: string;
  mode: 'discover' | 'reinspect';
}

export interface ProcessResult {
  status: CompanyRow['status'];
  reason: string | null;
  platform: string | null;
  entity: string | null;
  verified: string[];
  likely: string[];
  /** Best public email (lowest risk first), if any. */
  contact: string | null;
  /** Outreach risk for the recipient (market + recipient type), independent of contacts. Never part of qualification. */
  risk: OutreachRisk | null;
  /** Outreach risk of `contact` specifically (e.g. a public mailbox can be riskier than the company). */
  contactRisk: OutreachRisk | null;
  /** How the business can be reached; null if the inspection did not get that far. */
  contactStatus: ContactStatus | null;
  /** Mobile checks in Chromium: 'incomplete' means some pages were NOT checked (not "no problems"). */
  browserChecks: 'not_requested' | 'done' | 'incomplete';
  /** Browser failures (launch, rendering, mobile checks); also logged to events. */
  browserIssues: string[];
}

/** Below this many characters of main text on all pages, the home page is rendered with JavaScript. */
const THIN_TEXT_CHARS = 300;

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

/**
 * Runs one company through website → entity → inspection → contacts → outreach risk (spec 6, 8).
 * Only an unusable site rejects (unreachable, robots, parked, offsite redirect). Legal form,
 * missing contacts and the absence of technical problems are recorded, never rejected
 * (docs/decisions.md). Never throws for site problems.
 */
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
    risk: null,
    contactRisk: null,
    contactStatus: null,
    browserChecks: 'not_requested',
    browserIssues: [],
  };
  const inspectionId = startInspection(db, company.id, deps.mode);
  updateCompany(db, company.id, { last_inspection_id: inspectionId });
  let capabilities: Capabilities | null = null;
  let contactStatus: ContactStatus | null = null;

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
    // Pages disallowed by robots.txt do not use up the budget; fetch attempts stay bounded.
    const pages: PageContext[] = [home];
    let attempts = 0;
    for (const target of pickPages(home, deps.maxPages * 3)) {
      if (pages.length >= deps.maxPages || attempts >= deps.maxPages * 2) break;
      if (!(await robotsFor(target.url)).isAllowed(target.url)) continue;
      attempts++;
      try {
        const res = await fetcher.fetch(target.url);
        if (res.status < 400 && res.contentType.includes('html')) {
          pages.push(buildPageContext(res.finalUrl, target.kind, res.status, res.body));
        }
      } catch {
        // One failing subpage does not fail the company.
      }
    }
    // Text for understanding the business. JavaScript-only sites send almost no text in their
    // HTML; then the home page is rendered once in Chromium. Technical checks below keep using
    // the server HTML (`pages`), which is what they are about.
    let textPages = pages;
    let mainTexts = extractMainTexts(textPages, deps.mainTextMaxChars);
    if (deps.renderer && mainTexts.join('').length < THIN_TEXT_CHARS) {
      // A browser failure keeps the server HTML; it never fails the company.
      const rendered = await deps.renderer.renderHtml(home.url).catch((err: unknown) => ({ error: String(err) }));
      if ('html' in rendered) {
        textPages = [buildPageContext(home.url, 'home', home.status, rendered.html), ...pages.slice(1)];
        mainTexts = extractMainTexts(textPages, deps.mainTextMaxChars);
      } else {
        result.browserIssues.push(`render: ${rendered.error}`);
        logEvent(db, company.id, 'browser_render_failed', { url: home.url, error: rendered.error });
      }
    }
    textPages.forEach((page, i) =>
      insertPage(db, company.id, inspectionId, page, {
        mainText: mainTexts[i] ?? '',
        links: internalLinks(page, deps.linksMax),
      }),
    );
    setStatus(db, company.id, 'website_resolved');

    // 3. Legal entity (spec 8.6): recorded for outreach risk only, never a filter.
    // No registry lookup without a Companies House key.
    const entity = detectEntity(textPages, market);
    result.entity = entity.entityType;
    updateCompany(db, company.id, {
      entity_type: entity.entityType,
      entity_evidence: entity.evidence ? `${entity.evidence} (${entity.evidenceUrl})` : null,
      registry_id: entity.registryId,
      registry_status: 'not_checked',
    });
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
      for (const p of pages) if ((p.kind === 'contact' || p.kind === 'workflow') && hasInquiryForm(p)) targets.push({ url: p.url, kind: 'form' });
      const mobileRun = await deps.mobile
        .inspect(targets, path.join(deps.screenshotRoot, company.id))
        .catch((err: unknown) => ({ observations: [], failures: targets.map((t) => `${t.url}: ${String(err)}`) }));
      result.browserChecks = mobileRun.failures.length ? 'incomplete' : 'done';
      if (mobileRun.failures.length) {
        result.browserIssues.push(...mobileRun.failures.map((f) => `mobile: ${f}`));
        logEvent(db, company.id, 'browser_checks_incomplete', { failures: mobileRun.failures });
      }
      for (const o of mobileRun.observations) {
        if (o.code !== 'BROKEN_IMAGES') {
          observations.push(o);
          continue;
        }
        const confirmed = await confirmBrokenImages(o, company.domain, fetcher);
        if (confirmed) observations.push(confirmed);
      }
    }
    for (const o of observations) insertObservation(db, company.id, inspectionId, o);
    result.verified = observations.filter((o) => o.status === 'verified').map((o) => o.code);
    result.likely = observations.filter((o) => o.status === 'likely').map((o) => o.code);
    capabilities = detectCapabilities(textPages, platform, productCount);

    // 5. Outreach risk for the recipient as such (market rules + recipient type) — always, whether
    // or not an email exists. Then contacts (spec 8.5), each with a per-address refinement, and
    // contact availability. None of this affects qualification; no contact is a note, not a rejection.
    const recipientRisk = assessOutreachRisk(market, entity.entityType, null);
    insertOutreachRisk(db, company.id, inspectionId, null, recipientRisk, RISK_RULES_VERSION);
    result.risk = recipientRisk.risk;

    const mxCache = new Map<string, boolean>();
    const order: Record<OutreachRisk, number> = { low: 0, review_required: 1, high: 2 };
    let usableEmails = 0;
    for (const c of extractContacts(textPages, company.domain)) {
      const host = c.email.split('@')[1]!;
      if (!mxCache.has(host)) mxCache.set(host, await deps.mxCheck(host));
      const mxOk = mxCache.get(host)!;
      const contactId = upsertContact(db, company.id, c, mxOk);
      if (!mxOk) continue;
      usableEmails++;
      const risk = assessOutreachRisk(market, entity.entityType, c);
      insertOutreachRisk(db, company.id, inspectionId, contactId, risk, RISK_RULES_VERSION);
      // Contacts come best-first; keep the first one unless a later one carries lower risk.
      if (!result.contact || order[risk.risk] < order[result.contactRisk!]) {
        result.contact = c.email;
        result.contactRisk = risk.risk;
      }
    }
    // Other public channels (form page, phone, WhatsApp, Telegram); stored, never used to send anything.
    const channels = extractChannels(textPages, market.code);
    for (const ch of channels) upsertContactChannel(db, company.id, inspectionId, ch);
    contactStatus = contactStatusOf({
      usableEmails,
      inquiryForm: channels.some((c) => c.channel === 'form'),
      phone: channels.some((c) => c.channel === 'phone'),
      messenger: channels.some((c) => c.channel === 'whatsapp' || c.channel === 'telegram'),
    });
    result.contactStatus = contactStatus;

    setStatus(db, company.id, 'inspected');
    result.status = 'inspected';
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
  finishInspection(db, inspectionId, { status: result.status, reason: result.reason, capabilities, contactStatus });
  return result;
}
