// Buyer category of a public post (config/intent.yaml → buyer): does the author want to commission a
// finished deliverable, ask for a provider recommendation, only describe a need, look for a
// subcontractor, hire staff, or sell their own services? Decided on explicit phrases only.
import type { IntentConfig } from '../config/schema.js';
import type { FitResult } from './capabilities.js';
import { hasTerm, hasTermOrPlural } from './text.js';
import type { RequestType } from './types.js';

export type BuyerCategory =
  | 'PROJECT_BUYER'
  | 'SERVICE_RECOMMENDATION'
  | 'POTENTIAL_BUYER'
  | 'AGENCY_PARTNERSHIP'
  | 'STAFFING'
  | 'SERVICE_PROVIDER'
  | 'IRRELEVANT';

export interface BuyerResult {
  category: BuyerCategory;
  /** The phrase that decided it, as matched (lower-case); the quote is taken from the text around it. */
  marker: string | null;
  reason: string;
}

/** How far into the post the author introduces themselves ("Hi, we are a web agency…"). */
const OPENING = 240;
/** A recommendation request names the kind of provider within this many characters. */
const NEAR = 80;

const first = (textLower: string, terms: readonly string[]) => terms.find((t) => hasTerm(textLower, t)) ?? null;

/** Cheap title filter for busy forum categories: worth reading the post only if the title asks for someone or something. */
const REQUEST_TITLE = /\b(hire|hiring|looking for|need|needed|wanted|seeking|recommend|recommendation|quote|developer|freelancer|expert|agency|build|built|someone|help me|paid|budget|zoek|gezocht)\b/;
export function titleLooksLikeRequest(titleLower: string, cfg: IntentConfig): boolean {
  return REQUEST_TITLE.test(titleLower) || cfg.buyer.project.some((p) => titleLower.includes(p)) || cfg.buyer.recommendation.some((p) => titleLower.includes(p));
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const askCache = new WeakMap<IntentConfig['buyer'], RegExp>();
/** "<ask> [up to 3 words] <provider noun>" — "looking for an experienced Shopify developer", "need someone to automate…". */
function askFor(textLower: string, cfg: IntentConfig['buyer']): string | null {
  let re = askCache.get(cfg);
  if (!re) {
    const alt = (xs: readonly string[]) => [...xs].sort((a, b) => b.length - a.length).map(esc).join('|');
    re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt(cfg.ask)})\\s+(?:[\\p{L}\\p{N}.+#'/-]+\\s+){0,3}?(?:${alt(cfg.provider_nouns)})(?![\\p{L}\\p{N}])`, 'u');
    askCache.set(cfg, re);
  }
  return re.exec(textLower)?.[0] ?? null;
}

function recommendationOf(textLower: string, cfg: IntentConfig['buyer']): string | null {
  for (const phrase of cfg.recommendation) {
    let from = 0;
    for (;;) {
      const at = textLower.indexOf(phrase, from);
      if (at < 0) break;
      const around = textLower.slice(Math.max(0, at - NEAR), at + phrase.length + NEAR);
      if (cfg.provider_nouns.some((n) => hasTerm(around, n))) return phrase;
      from = at + phrase.length;
    }
  }
  return null;
}

/**
 * Sources with structure (HN "SEEKING FREELANCER", tenders) already know the request type; forum
 * posts are read from their title and text. `fit` tells whether the post concerns software at all.
 */
export function buyerCategory(source: string, requestType: RequestType | null, header: string, text: string, fit: FitResult, cfg: IntentConfig): BuyerResult {
  // Typographic apostrophes ("I’m available") match the plain ones used in config.
  const lower = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'");
  const h = lower(header);
  const t = lower(`${header}\n${text}`);
  const b = cfg.buyer;
  const staffing = first(t, b.staffing);

  if (requestType) {
    switch (requestType) {
      case 'service_offer':
        return { category: 'SERVICE_PROVIDER', marker: null, reason: 'разработчик предлагает свои услуги — не заказчик' };
      case 'vacancy':
        return { category: 'STAFFING', marker: null, reason: 'штатная вакансия — не заказ' };
      case 'contract_role':
        return { category: 'STAFFING', marker: null, reason: 'компания ищет подрядчика в команду (контрактная роль) — это найм, а не готовый результат' };
      case 'recruiter':
        return { category: 'STAFFING', marker: null, reason: 'размещено рекрутером / посредником — не прямой заказчик' };
      case 'advice_only':
      case 'irrelevant':
        return { category: 'IRRELEVANT', marker: null, reason: source === 'uk_contracts_finder' ? 'закупка ПО/лицензий/обслуживания, а не разработка' : 'не запрос на работу' };
      case 'rfp':
        return { category: 'PROJECT_BUYER', marker: null, reason: 'публичный тендер на разработку' };
      case 'direct_request':
        if (staffing) return { category: 'STAFFING', marker: staffing, reason: `ищут человека в команду, а не результат: «${staffing}»` };
        return { category: 'PROJECT_BUYER', marker: null, reason: 'прямой запрос: ищут исполнителя для своего проекта' };
    }
  }

  const provider = first(h, b.service_provider) ?? first(t.slice(0, header.length + OPENING), b.service_provider);
  if (provider) return { category: 'SERVICE_PROVIDER', marker: provider, reason: `автор предлагает свои услуги / продукт: «${provider}»` };
  const software = fit.core.length > 0 || fit.adjacent.length > 0 || fit.mandatory.length > 0 || fit.optional.length > 0 || b.software.some((w) => hasTermOrPlural(t, w));
  if (!software || fit.nonDev) return { category: 'IRRELEVANT', marker: null, reason: software ? fit.reason : 'не о разработке ПО / сайтов' };
  const agency = first(t, b.agency_partnership);
  const paying = first(t, b.payment);
  const aboutBuilding = b.provider_nouns.some((n) => hasTerm(t, n)) || b.build_verbs.some((v) => hasTerm(t, v));
  const project = first(t, b.project) ?? askFor(t, b) ?? (paying && aboutBuilding ? paying : null);
  if (agency && project) return { category: 'AGENCY_PARTNERSHIP', marker: agency, reason: `агентство ищет технического субподрядчика: «${agency}»` };
  if (staffing && (project || first(t, ['hiring', 'hire']))) return { category: 'STAFFING', marker: staffing, reason: `найм в команду, а не готовый результат: «${staffing}»` };
  const equity = first(t, b.equity_only);
  if (equity && !/[$£€]\s?\d|\b\d+\s?(?:usd|gbp|eur)\b/i.test(t)) return { category: 'IRRELEVANT', marker: equity, reason: `оплата долей / партнёрство, без бюджета: «${equity}»` };
  const recommendation = recommendationOf(t, b);
  if (recommendation) return { category: 'SERVICE_RECOMMENDATION', marker: recommendation, reason: `просят порекомендовать исполнителя: «${recommendation}»` };
  if (project) return { category: 'PROJECT_BUYER', marker: project, reason: `явное намерение заказать работу: «${project}»` };
  const need = first(t.slice(0, header.length + OPENING * 2), b.need);
  if (need && (fit.fit === 'core' || fit.fit === 'adjacent')) return { category: 'POTENTIAL_BUYER', marker: need, reason: `описана потребность, но готовность нанять не подтверждена: «${need}»` };
  return { category: 'IRRELEVANT', marker: null, reason: 'нет ни запроса на исполнителя, ни описанной потребности' };
}
