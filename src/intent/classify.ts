// Deterministic buyer-intent classification (config/intent.yaml + config/capabilities.yaml). Cheap
// rules first; what they cannot decide is marked `ambiguous` for the optional LLM check. Nothing is
// inferred: status comes from explicit markers or the source itself, contacts only as published.
import type { CapabilitiesConfig, IntentConfig } from '../config/schema.js';
import { buyerCategory, type BuyerCategory } from './buyer.js';
import { techFit, type FitResult } from './capabilities.js';
import { hasTerm, quoteAround } from './text.js';
import type { ClassifiedRequest, Engagement, Geo, Level, RawRequest, Remote, RequestStatus, RequestType } from './types.js';

/** What classification reads: the intent rules and the Service Capability Profile. */
export interface IntentContext {
  intent: IntentConfig;
  capabilities: CapabilitiesConfig;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL = /\bhttps?:\/\/[^\s)>\]]+/gi;
const BUDGET = /(?:[$£€]\s?\d[\d,.]*\s?(?:k|K)?(?:\s?(?:[-–]|to)\s?[$£€]?\s?\d[\d,.]*\s?(?:k|K)?)?(?:\s?(?:\/|per)\s?(?:hr|hour|h|day|month|mo|year|yr))?|\d[\d,.]*\s?(?:usd|eur|gbp)(?:\s?(?:\/|per)\s?(?:hr|hour|h|day))?)/i;
const DEADLINE = /\b(?:start(?:ing)? by|deadline|by (?:end of )?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*|asap|immediately|within \d+ (?:days|weeks))\b[^.\n|]{0,40}/i;
const ONSITE = /\bon-?site\b|\bin office\b|\bhybrid\b/i;
const REMOTE = /\bremote\b/i;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const REGION = /\b(europe|eu|emea|worldwide|anywhere|global|international)\b/i;
const TIMEZONE_ONLY = /time ?zones?|overlap|\b(et|est|pst|pt|cet|gmt|utc)\b/i;

export function geoOf(textLower: string, headerLower: string, cfg: IntentConfig): { geo: Geo; location: string | null } {
  const restricted = cfg.geo.restricted_other.find((t) => textLower.includes(t));
  if (restricted) return { geo: 'restricted_other', location: restricted };
  // On site only: not reachable for a remote team.
  if (ONSITE.test(headerLower) && !REMOTE.test(headerLower)) return { geo: 'restricted_other', location: 'onsite' };
  // "REMOTE (Poland or Romania)", "Remote (US)": remote limited to named countries outside our markets.
  const scope = /remote\s*[([]([^)\]]+)[)\]]/i.exec(headerLower)?.[1]?.trim();
  if (scope && !REGION.test(scope) && !TIMEZONE_ONLY.test(scope) && !cfg.geo.target.some((t) => hasTerm(scope, t))) {
    return { geo: 'restricted_other', location: `remote (${scope})` };
  }
  const target = cfg.geo.target.find((t) => hasTerm(headerLower, t) || hasTerm(textLower, t));
  if (target) return { geo: 'target', location: target };
  if (REMOTE.test(headerLower) && !ONSITE.test(headerLower)) return { geo: 'open', location: 'remote' };
  return { geo: 'unknown', location: null };
}

/** Remote work from abroad: prohibited by a named restriction or an in-person requirement; permitted only when said. */
export function remoteOf(textLower: string, geo: Geo, cfg: IntentConfig): { remote: Remote; basis: string | null } {
  if (geo === 'restricted_other') return { remote: 'prohibited', basis: null };
  const local = cfg.geo.local_only.find((t) => hasTerm(textLower, t));
  if (local) return { remote: 'prohibited', basis: local };
  if (REMOTE.test(textLower) || REGION.test(textLower)) return { remote: 'permitted', basis: 'remote' };
  return { remote: 'unknown', basis: null };
}

const RECRUITER_WINDOW = 300;
const CONTRACT = /\b(contracts?|contractors?|freelance|freelancers?)\b/i;
/** An explicit negation in the role line: "Product Engineer (Product Manager role, not a Full-stack role)". */
const NOT_DEV_ROLE = /\bnot an? (?:full[- ]?stack|engineering|developer|dev|software)\b[^|]*\brole\b/i;
const DEV_ROLE = /\b(engineers?|developers?|programmers?|full[- ]?stack|front[- ]?end|back[- ]?end)\b/i;

/** Structural request type for sources that have one; forum posts return null (read by buyerCategory). */
function typeOf(r: RawRequest, headerLower: string, textLower: string, cfg: IntentConfig): { type: RequestType | null; engagement: Engagement; ambiguous: boolean; evidence: RegExp } {
  // Start of the post only (header + first lines): "email our recruiter" in a company's own post is not a recruiter post.
  const recruiter = cfg.markers.recruiter.some((m) => textLower.slice(0, RECRUITER_WINDOW).includes(m));
  if (r.source === 'uk_contracts_finder') {
    const notDev = cfg.markers.procurement_not_dev.some((m) => hasTerm(textLower, m));
    return { type: notDev ? 'irrelevant' : 'rfp', engagement: 'agency', ambiguous: false, evidence: /./ };
  }
  if (r.source === 'hn_freelance') {
    if (/^\s*seeking\s+work\b/i.test(r.header)) return { type: 'service_offer', engagement: 'unknown', ambiguous: false, evidence: /seeking\s+work/i };
    if (/seeking\s+(?:a\s+)?freelancers?\b/i.test(r.header)) {
      return { type: recruiter ? 'recruiter' : 'direct_request', engagement: 'contractor', ambiguous: false, evidence: /seeking\s+(?:a\s+)?freelancers?/i };
    }
    return { type: 'irrelevant', engagement: 'unknown', ambiguous: true, evidence: /./ };
  }
  if (r.source === 'hn_hiring') {
    // A job post; contract / freelance roles are work for a contractor — but still staffing, not a deliverable.
    const contract = CONTRACT.test(headerLower);
    if (recruiter) return { type: 'recruiter', engagement: contract ? 'contractor' : 'employee', ambiguous: false, evidence: /./ };
    if (contract) return { type: 'contract_role', engagement: 'contractor', ambiguous: false, evidence: CONTRACT };
    // "Contract" only further down the post: unclear whether a contractor is wanted.
    return { type: 'vacancy', engagement: 'employee', ambiguous: CONTRACT.test(textLower), evidence: /./ };
  }
  return { type: null, engagement: recruiter ? 'agency' : 'unknown', ambiguous: false, evidence: /./ };
}

function statusOf(r: RawRequest, headerLower: string, cfg: IntentConfig): { status: RequestStatus; basis: string } {
  if (r.sourceStatus) return { status: r.sourceStatus.open === null ? 'unknown' : r.sourceStatus.open ? 'open' : 'closed', basis: r.sourceStatus.basis };
  const closed = cfg.markers.closed.find((m) => headerLower.includes(m));
  if (closed) return { status: 'closed', basis: `в посте: «${closed}»` };
  return { status: 'unknown', basis: 'источник не сообщает, открыт ли запрос; судить только по дате публикации' };
}

/** A request type decided outside the rules (the optional LLM check), with its verbatim evidence. */
export interface TypeOverride {
  type: RequestType;
  engagement: Engagement;
  evidenceQuote: string;
}

/** Job posts list the company's whole stack; a non-development role in the header is not our work, whatever the body says. */
function jobFit(headerLower: string, fit: FitResult, cfg: IntentConfig): FitResult {
  const negated = NOT_DEV_ROLE.exec(headerLower)?.[0];
  const nonDev = negated ?? (DEV_ROLE.test(headerLower) ? undefined : cfg.markers.non_dev_roles.find((m) => headerLower.includes(m)));
  return nonDev ? { ...fit, fit: 'poor', reason: `роль не разработчика: «${nonDev}»` } : fit;
}

export function ageDays(publishedAt: string | null, now: Date): number | null {
  return publishedAt ? Math.max(0, Math.floor((now.getTime() - new Date(publishedAt).getTime()) / 86400_000)) : null;
}

const SHORTLIST: BuyerCategory[] = ['PROJECT_BUYER', 'SERVICE_RECOMMENDATION'];
const CONFIDENCE: Record<BuyerCategory, Exclude<Level, 'none'>> = {
  PROJECT_BUYER: 'high',
  SERVICE_RECOMMENDATION: 'medium',
  AGENCY_PARTNERSHIP: 'medium',
  POTENTIAL_BUYER: 'low',
  STAFFING: 'low',
  SERVICE_PROVIDER: 'low',
  IRRELEVANT: 'low',
};
export const FIT_LABEL = { core: 'CORE_FIT', adjacent: 'ADJACENT_FIT', conditional: 'CONDITIONAL_FIT', poor: 'POOR_FIT' } as const;

export function classify(r: RawRequest, ctx: IntentContext, opts: { override?: TypeOverride; now?: Date } = {}): ClassifiedRequest {
  const cfg = ctx.intent;
  const { override } = opts;
  const now = opts.now ?? new Date();
  const textLower = r.text.toLowerCase();
  const headerLower = r.header.toLowerCase();
  const ruled = typeOf(r, headerLower, textLower, cfg);
  const t = override ? { type: override.type, engagement: override.engagement, ambiguous: false, evidence: ruled.evidence } : ruled;
  const s = statusOf(r, headerLower, cfg);
  const rawFit = techFit(r.title ?? r.header, r.text, ctx.capabilities);
  const fit = r.source === 'hn_hiring' ? jobFit(headerLower, rawFit, cfg) : rawFit;
  const buyer = buyerCategory(r.source, t.type, r.title ?? r.header, r.text, fit, cfg);
  const g = geoOf(textLower, headerLower, cfg);
  const rem = remoteOf(textLower, g.geo, cfg);
  const notOurWork = cfg.markers.not_our_work.find((m) => textLower.includes(m));
  const budget = r.budget ?? (BUDGET.exec(r.text)?.[0]?.trim().replace(/[.,]+$/, '') || null);
  const deadline = r.deadline ?? (DEADLINE.exec(r.text)?.[0]?.trim() || null);
  // A reply channel the requester published: the source's contact (procurement), e-mails / links
  // written into the request, or a reply where it was posted (HN comment, forum thread).
  const linked = [...new Set([...(r.text.match(EMAIL) ?? []), ...(r.text.match(URL) ?? [])])].slice(0, 3);
  const contactChannel = r.contact
    ? `${r.contact} (контакт закупки) · ${r.url}`
    : linked.length
      ? `${linked.join(' · ')} (указано в запросе)`
      : r.source.startsWith('hn_')
        ? `ответ на комментарий в HN: ${r.url}`
        : `${r.replyHint ?? 'ответ в теме на форуме (нужна учётная запись форума)'}: ${r.url}`;

  const age = ageDays(r.publishedAt, now);
  const stale = age !== null && age > cfg.max_age_days && s.status !== 'open';
  const large = r.source === 'uk_contracts_finder' && !!r.budget && Number.parseFloat(r.budget) > cfg.sources.uk_contracts_finder.large_value_gbp;

  const reasons: string[] = [buyer.reason, `${FIT_LABEL[fit.fit]}: ${fit.reason}`];
  if (s.status === 'closed') reasons.push(`закрыт: ${s.basis}`);
  if (notOurWork) reasons.push(`не наша работа: «${notOurWork}»`);
  if (g.geo === 'restricted_other') reasons.push(`ограничение по географии: «${g.location}»`);
  else if (rem.remote === 'prohibited') reasons.push(`нужен исполнитель на месте: «${rem.basis}»`);
  if (large) reasons.push('крупный контракт — формальный тендер масштаба компании');
  if (stale) reasons.push(`старше ${cfg.max_age_days} дн. (${age} дн.) — актуальность не подтверждена`);
  // A feed date that is only the last reply says nothing about when the request was made.
  if (r.dateIsActivity) reasons.push('дата — последняя активность в теме; когда тема создана, не проверено');

  // A tender is formal and specific: only one that clearly names our kind of work is worth a bid.
  const fitOk = t.type === 'rfp' ? fit.fit === 'core' || fit.fit === 'adjacent' : fit.fit !== 'poor';
  if (t.type === 'rfp' && !fitOk) reasons.push('предмет тендера не совпадает с профилем услуг явно');
  const qualified = SHORTLIST.includes(buyer.category) && fitOk && s.status !== 'closed' && rem.remote !== 'prohibited' && !notOurWork && !large && !stale && !r.dateIsActivity;
  const intentConfidence = buyer.category === 'PROJECT_BUYER' && t.type === 'rfp' ? (s.status === 'open' ? 'high' : 'medium') : CONFIDENCE[buyer.category];
  const evidenceQuote =
    override?.evidenceQuote ??
    (r.source === 'uk_contracts_finder'
      ? (r.title ?? r.header).slice(0, 220)
      : buyer.marker
        ? quoteAround(`${r.title ? `${r.title}\n` : ''}${r.text}`, new RegExp(esc(buyer.marker), 'i'))
        : quoteAround(r.text, t.evidence));
  const missing = [
    ...(budget ? [] : ['бюджет']),
    ...(rem.remote === 'unknown' ? ['можно ли работать удалённо из-за рубежа'] : []),
    ...(fit.fit === 'conditional' ? ['технология / объём работ'] : []),
    ...(s.status === 'unknown' ? ['актуален ли запрос'] : []),
  ];

  return {
    ...r,
    requestType: t.type,
    buyerCategory: buyer.category,
    techFit: fit.fit,
    fitAreas: fit.areas,
    mandatoryTech: fit.mandatory,
    optionalTech: fit.optional,
    remote: rem.remote,
    stale: stale || !!r.dateIsActivity,
    missing,
    engagement: t.engagement,
    status: s.status,
    statusBasis: s.basis,
    geo: g.geo,
    location: g.location,
    technologies: [...new Set([...fit.core, ...fit.adjacent, ...fit.mandatory, ...fit.optional])],
    intentConfidence,
    evidenceQuote,
    workRequested: (r.title ?? r.text.split('\n').slice(0, 3).join(' ')).slice(0, 300).trim(),
    budget,
    deadline,
    contactChannel,
    qualified,
    reasons,
    ambiguous: t.ambiguous,
    classifier: override ? 'llm' : 'rules',
  };
}
