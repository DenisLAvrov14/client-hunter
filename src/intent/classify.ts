// Deterministic buyer-intent classification (config/intent.yaml). Cheap rules first; what they
// cannot decide is marked `ambiguous` for the optional LLM check. Nothing is inferred: status comes
// from explicit markers or the source itself, contacts only as published in the request.
import type { IntentConfig } from '../config/schema.js';
import { hasTerm, quoteAround } from './text.js';
import type { ClassifiedRequest, Engagement, Geo, Level, RawRequest, RequestStatus, RequestType } from './types.js';

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL = /\bhttps?:\/\/[^\s)>\]]+/gi;
const BUDGET = /(?:[$£€]\s?\d[\d,.]*\s?(?:k|K)?(?:\s?[-–]\s?[$£€]?\s?\d[\d,.]*\s?(?:k|K)?)?(?:\s?(?:\/|per)\s?(?:hr|hour|h|day|month|mo|year|yr))?|\d[\d,.]*\s?(?:usd|eur|gbp)(?:\s?(?:\/|per)\s?(?:hr|hour|h|day))?)/i;
const DEADLINE = /\b(?:start(?:ing)? by|deadline|by (?:end of )?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*|asap|immediately|within \d+ (?:days|weeks))\b[^.\n|]{0,40}/i;
const ONSITE = /\bon-?site\b|\bin office\b|\bhybrid\b/i;
const REMOTE = /\bremote\b/i;

export function skillFit(textLower: string, cfg: IntentConfig): { level: Level; strong: string[]; partial: string[] } {
  const strong = cfg.skills.strong.filter((t) => hasTerm(textLower, t));
  const partial = cfg.skills.partial.filter((t) => hasTerm(textLower, t));
  const level: Level = strong.length >= 2 ? 'high' : strong.length === 1 ? 'medium' : partial.length ? 'low' : 'none';
  return { level, strong, partial };
}

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

const RECRUITER_WINDOW = 300;
const CONTRACT = /\b(contracts?|contractors?|freelance|freelancers?)\b/i;
/** An explicit negation in the role line: "Product Engineer (Product Manager role, not a Full-stack role)". */
const NOT_DEV_ROLE = /\bnot an? (?:full[- ]?stack|engineering|developer|dev|software)\b[^|]*\brole\b/i;

function typeOf(r: RawRequest, headerLower: string, textLower: string, cfg: IntentConfig): { type: RequestType; engagement: Engagement; ambiguous: boolean; evidence: RegExp } {
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
  // hn_hiring: a job post; only contract / freelance roles are buyer intent for a contractor.
  const contract = CONTRACT.test(headerLower);
  if (recruiter) return { type: 'recruiter', engagement: contract ? 'contractor' : 'employee', ambiguous: false, evidence: /./ };
  if (contract) return { type: 'contract_role', engagement: 'contractor', ambiguous: false, evidence: CONTRACT };
  // "Contract" only further down the post: unclear whether a contractor is wanted.
  const later = CONTRACT.test(textLower);
  return { type: 'vacancy', engagement: 'employee', ambiguous: later, evidence: /./ };
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

const DEV_ROLE = /\b(engineers?|developers?|programmers?|full[- ]?stack|front[- ]?end|back[- ]?end)\b/i;
const LOWER: Record<Level, Level> = { high: 'medium', medium: 'low', low: 'low', none: 'none' };

/**
 * Job posts list the company's whole stack; the role is in the header. Header skills decide; a
 * header naming only a non-core stack (Swift, Java…) is a partial match; skills found only in the
 * body count one level lower; a non-development role (product manager, designer…) is not our work.
 */
export function jobSkillFit(headerLower: string, textLower: string, cfg: IntentConfig): { level: Level; strong: string[]; partial: string[]; nonDev: string | null } {
  const head = skillFit(headerLower, cfg);
  const body = skillFit(textLower, cfg);
  const negated = NOT_DEV_ROLE.exec(headerLower)?.[0];
  if (negated) return { level: 'none', strong: [], partial: [], nonDev: negated };
  const nonDev = cfg.markers.non_dev_roles.find((m) => headerLower.includes(m)) ?? null;
  if (nonDev && !DEV_ROLE.test(headerLower)) return { level: 'none', strong: [], partial: [], nonDev };
  if (head.strong.length) return { level: head.strong.length >= 2 || body.strong.length >= 2 ? 'high' : 'medium', strong: body.strong, partial: body.partial, nonDev: null };
  if (head.partial.length) return { level: 'low', strong: [], partial: head.partial, nonDev: null };
  return { level: LOWER[body.level], strong: body.strong, partial: body.partial, nonDev: null };
}

export function classify(r: RawRequest, cfg: IntentConfig, override?: TypeOverride): ClassifiedRequest {
  const textLower = r.text.toLowerCase();
  const headerLower = r.header.toLowerCase();
  const ruled = typeOf(r, headerLower, textLower, cfg);
  const t = override ? { type: override.type, engagement: override.engagement, ambiguous: false, evidence: ruled.evidence } : ruled;
  const s = statusOf(r, headerLower, cfg);
  const job = r.source === 'hn_hiring' ? jobSkillFit(headerLower, textLower, cfg) : null;
  const fit = job ?? skillFit(textLower, cfg);
  const g = geoOf(textLower, headerLower, cfg);
  const notOurWork = cfg.markers.not_our_work.find((m) => textLower.includes(m)) ?? job?.nonDev ?? undefined;
  const budget = r.budget ?? (BUDGET.exec(r.text)?.[0]?.trim() || null);
  const deadline = r.deadline ?? (DEADLINE.exec(r.text)?.[0]?.trim() || null);
  // A reply channel the requester published: the source's contact (procurement), e-mails / links
  // written into the request, or — on HN — replying to the comment itself.
  const linked = [...new Set([...(r.text.match(EMAIL) ?? []), ...(r.text.match(URL) ?? [])])].slice(0, 3);
  const contactChannel = r.contact
    ? `${r.contact} (контакт закупки) · ${r.url}`
    : linked.length
      ? `${linked.join(' · ')} (указано в запросе)`
      : r.source.startsWith('hn_')
        ? `ответ на комментарий в HN: ${r.url}`
        : null;

  const reasons: string[] = [];
  const intentful = t.type === 'direct_request' || t.type === 'contract_role' || t.type === 'rfp';
  const LABEL: Record<RequestType, string> = {
    direct_request: 'прямой запрос: ищут фрилансера для своего проекта',
    contract_role: 'компания ищет подрядчика (контракт / фриланс)',
    rfp: 'публичный тендер (запрос предложений)',
    vacancy: 'штатная вакансия — не заказ',
    service_offer: 'разработчик предлагает свои услуги — не заказчик',
    recruiter: 'размещено рекрутером / посредником — не прямой заказчик',
    advice_only: 'просят только совет',
    irrelevant: r.source === 'uk_contracts_finder' ? 'закупка ПО/лицензий/обслуживания, а не разработка' : 'не запрос на работу',
  };
  reasons.push(LABEL[t.type]);
  if (s.status === 'closed') reasons.push(`закрыт: ${s.basis}`);
  if (notOurWork) reasons.push(`не наша работа: «${notOurWork}»`);
  if (fit.level === 'none' || fit.level === 'low') reasons.push(fit.partial.length ? `навыки лишь частично: ${fit.partial.join(', ')}` : 'не совпадает с нашими навыками');
  else reasons.push(`совпадение навыков: ${fit.strong.join(', ')}`);
  if (g.geo === 'restricted_other') reasons.push(`ограничение по географии: «${g.location}»`);
  const large = r.source === 'uk_contracts_finder' && r.budget && Number.parseFloat(r.budget) > cfg.sources.uk_contracts_finder.large_value_gbp;
  if (large) reasons.push('крупный контракт — формальный тендер масштаба компании');

  const qualified = intentful && s.status !== 'closed' && !notOurWork && (fit.level === 'high' || fit.level === 'medium') && g.geo !== 'restricted_other';
  const intentConfidence: Exclude<Level, 'none'> = !intentful ? 'low' : t.type === 'rfp' ? (s.status === 'open' ? 'high' : 'medium') : 'high';
  const evidenceQuote = override?.evidenceQuote ?? (r.source === 'uk_contracts_finder' ? (r.title ?? r.header).slice(0, 220) : quoteAround(r.text, t.evidence));

  return {
    ...r,
    requestType: t.type,
    engagement: t.engagement,
    status: s.status,
    statusBasis: s.basis,
    geo: g.geo,
    location: g.location,
    technologies: [...fit.strong, ...fit.partial],
    skillFit: fit.level,
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
