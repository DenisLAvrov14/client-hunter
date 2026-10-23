// Outreach risk: may a cold commercial email to this contact be lawful? Deliberately separate
// from commercial qualification — it never hides a prospect or lowers its rank (docs/decisions.md).
// Rule-based working configuration, NOT legal advice; the operator confirms each market (spec 3).
// Operator-facing texts are Russian.
import type { MarketConfig } from '../config/schema.js';
import type { ContactCandidate } from '../contacts/extract.js';
import type { EntityType } from '../entity/detect.js';

export const RISK_RULES_VERSION = '2026-10-23.1';

export type OutreachRisk = 'low' | 'review_required' | 'high';
export type RecipientType =
  | 'company_confirmed' // legal form confirmed in a registry (not implemented yet: no registry keys)
  | 'company_likely' // legal form stated on the site
  | 'sole_trader_confirmed' // the site itself says sole trader / ИП Фамилия / eenmanszaak
  | 'unknown'; // includes freemail-only contacts: a gmail address alone does not prove an individual

export interface RiskAssessment {
  jurisdiction: string;
  recipientType: RecipientType;
  risk: OutreachRisk;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
  unknowns: string[];
  toVerify: string[];
}

const CORPORATE: ReadonlySet<EntityType> = new Set(['ltd', 'plc', 'llp', 'dac', 'bv', 'nv', 'ooo', 'ao', 'too']);

export function recipientTypeOf(entity: EntityType): RecipientType {
  if (CORPORATE.has(entity)) return 'company_likely';
  if (entity === 'sole_trader') return 'sole_trader_confirmed';
  return 'unknown';
}

/** Classifies one contact (or the absence of one) for one company in one market. */
export function assessOutreachRisk(
  market: MarketConfig,
  entity: EntityType,
  contact: Pick<ContactCandidate, 'kind' | 'isFreemail'> | null,
): RiskAssessment {
  const recipientType = recipientTypeOf(entity);
  const base = { jurisdiction: market.code, recipientType };
  const registryNote = 'юрлицо определено по тексту сайта, в реестре не проверено';

  if (market.cold_email_baseline === 'consent_required_all') {
    return {
      ...base,
      risk: 'high',
      reason: 'Реклама по email допускается только с предварительного согласия получателя (38-ФЗ ст. 18), согласия нет.',
      confidence: 'medium',
      unknowns: ['будет ли первое письмо признано рекламой'],
      toVerify: ['консультация юриста: допустимо ли персональное обращение без рекламы (режим permission_request)'],
    };
  }
  if (market.cold_email_baseline === 'unverified') {
    return {
      ...base,
      risk: 'review_required',
      reason: 'Правила email-рекламы для этого рынка ещё не проверены.',
      confidence: 'low',
      unknowns: ['требуется ли согласие для писем юрлицам и ИП'],
      toVerify: ['проверить закон о рекламе и защите персональных данных рынка (спецификация, раздел 3.6)'],
    };
  }

  // allowed_for_companies: companies may be emailed without prior consent; individuals and
  // sole traders may not (UK PECR, IE S.I. 336/2011, NL Telecommunicatiewet 11.7).
  if (!contact) {
    return {
      ...base,
      risk: 'review_required',
      reason: 'Рабочий публичный email не найден (на сайте нет адреса или у его домена нет MX-записи).',
      confidence: 'high',
      unknowns: ['доступный бизнес-контакт'],
      toVerify: ['найти публичный ролевой адрес компании'],
    };
  }
  if (recipientType === 'sole_trader_confirmed') {
    return {
      ...base,
      risk: 'high',
      reason: 'На сайте указано, что это ИП / sole trader: холодное маркетинговое письмо требует предварительного согласия.',
      confidence: 'medium',
      unknowns: [],
      toVerify: ['законный способ первого контакта без email-рекламы'],
    };
  }
  if (recipientType === 'unknown') {
    return {
      ...base,
      risk: 'review_required',
      reason: contact.isFreemail
        ? 'Юридическая форма неизвестна, адрес на публичной почте — получатель может быть физлицом.'
        : 'Юридическая форма неизвестна: если это ИП или физлицо, нужно согласие.',
      confidence: 'low',
      unknowns: ['юридическая форма получателя'],
      toVerify: ['проверить юридическую форму в реестре или на сайте'],
    };
  }
  // company_likely
  if (contact.isFreemail) {
    return {
      ...base,
      risk: 'review_required',
      reason: 'Компания, но адрес на публичной почте — похоже на личный ящик сотрудника или владельца.',
      confidence: 'low',
      unknowns: ['чей это ящик'],
      toVerify: [registryNote, 'найти ролевой адрес на домене компании'],
    };
  }
  if (contact.kind === 'named' && !market.allow_named_business_address) {
    return {
      ...base,
      risk: 'review_required',
      reason: 'Именной адрес сотрудника: на этом рынке может считаться адресом физлица.',
      confidence: 'medium',
      unknowns: ['считается ли именной корпоративный адрес адресом физлица'],
      toVerify: [registryNote, 'найти ролевой адрес (info@, sales@)'],
    };
  }
  return {
    ...base,
    risk: 'low',
    reason:
      contact.kind === 'named'
        ? 'Компания (по тексту сайта), именной адрес на домене компании, опубликован как бизнес-контакт.'
        : 'Компания (по тексту сайта), ролевой адрес на домене компании.',
    confidence: 'medium',
    unknowns: [registryNote],
    toVerify: ['проверить юрлицо в реестре', 'законный интерес (LIA) для рынка заполнен'],
  };
}
