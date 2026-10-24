// Commercial lead qualification: ranks companies by a project worth selling, not by website
// defects. Technical findings are kept as a separate quality view and never qualify a lead on
// their own. Contact availability and outreach risk are separate axes as well (docs/decisions.md).
// Pure functions over stored data: no LLM, no network.

export type ProjectType =
  | 'integration' // CRM / inventory / accounting integrations
  | 'portal' // customer portal, order or shipment status
  | 'quote_system' // B2B catalogue + quote request, pre-order lists
  | 'calculator' // price calculator / configurator
  | 'booking' // booking and scheduling
  | 'order_flow' // routing enquiries, order handling, notifications
  | 'catalogue' // searchable online catalogue
  | 'website_fix' // mobile, HTTPS, links, small UI defects — technical only
  | 'other';

export const PROJECT_LABEL: Record<ProjectType, string> = {
  integration: 'Интеграция с CRM, складом или учётом',
  portal: 'Кабинет клиента / статус заказа',
  quote_system: 'B2B-каталог с запросом цены (КП)',
  calculator: 'Калькулятор цены / конфигуратор',
  booking: 'Онлайн-запись и расписание',
  order_flow: 'Обработка заявок и уведомления',
  catalogue: 'Онлайн-каталог с поиском',
  website_fix: 'Техническая правка сайта',
  other: 'Другое',
};

// Most specific first. Matched on the model's title + proposal (stage B/C), which describe the
// business workflow; the classification only labels them, the evidence is scored separately.
// W = letters/digits of any script ("\w" alone is ASCII-only and misses Cyrillic endings).
const W = String.raw`[\p{L}\p{N}_]*`;
const rule = (src: string) => new RegExp(src.replaceAll('~', W), 'iu');
const TYPE_RULES: [ProjectType, RegExp][] = [
  ['integration', rule(String.raw`\bcrm\b|интеграц|\b1с|склад|учётн|учетн|inventory|accounting`)],
  ['portal', rule(String.raw`личн~ кабинет|кабинет клиента|портал|portal|статус~ (заказа|отправ|груза|доставки)|отслежив|tracking`)],
  [
    'quote_system',
    rule(String.raw`запрос~ (цен|стоимост|кп|коммерческ)|коммерческ~ предложени|предзаказ|request.?a.?quote|quote request|заявк~ на (позици|расч[её]т|подбор|кп)|корзин~ (запроса|заявки)|список (позиций|заявки)|заявк~.{0,40}на заказ|индивидуальн~ заказ`),
  ],
  ['calculator', rule(String.raw`калькулятор|конфигуратор|calculator|configurator|(оценк|расч[её]т)~ (цены|стоимост|ориентир)|ориентир~ (цен|стоимост)`)],
  ['booking', rule(String.raw`запис~ на|онлайн-запис|брон|booking|appointment|schedul|выбор~ (времени|даты|дня)|расписани`)],
  ['order_flow', rule(String.raw`маршрутизац|routing|уведомлен|notification|обработк~ (заявок|заказов)|заявк~ (к|для) (нужн|сотрудник|менеджер)`)],
  ['catalogue', rule(String.raw`каталог|поиск|фильтр|catalog|search`)],
  ['website_fix', rule(String.raw`мобильн|телефон|https|сертификат|ссылк|кнопк|копирайт|viewport|вёрстк|верстк`)],
];

export function projectTypeOf(text: string, category: 'website_rescue' | 'business_improvement'): ProjectType {
  if (category === 'website_rescue') return 'website_fix';
  return TYPE_RULES.find(([, re]) => re.test(text))?.[0] ?? 'other';
}

/** Typical scope of each project type (1 small … 3 large), used when stage C gave no size. */
const TYPE_SCOPE: Record<ProjectType, number> = {
  integration: 3,
  portal: 3,
  quote_system: 3,
  calculator: 2,
  booking: 2,
  order_flow: 2,
  catalogue: 2,
  website_fix: 1,
  other: 1,
};

export type EvidenceKind = 'fact' | 'inference' | 'hypothesis' | 'quote' | 'finding_verified' | 'finding_likely' | 'none';

export interface EvidenceItem {
  kind: EvidenceKind;
  text: string;
  url?: string;
  /** Rests only on "the site does not show X" (an absent capability): never strong. */
  absenceOnly?: boolean;
}

export interface OpportunityInput {
  source: 'deep' | 'screen';
  title: string;
  proposal: string;
  category: 'website_rescue' | 'business_improvement';
  /** Why it could matter (model hypotheses, already labelled as such). */
  value: string[];
  evidence: EvidenceItem[];
  /** What still needs to be asked or checked. */
  openQuestions: string[];
  projectSize?: 'small' | 'medium' | 'large';
  alreadyExists?: 'no' | 'partially' | 'yes' | 'unknown';
  /** A capability code already detects on the site that this proposal would duplicate. */
  duplicates?: string | null;
  /** Stage C: grounded in observed evidence and not already on the site. */
  eligible?: boolean;
}

export interface BusinessInput {
  summary: string;
  type: string;
  customers: 'b2b' | 'b2c' | 'both' | 'unknown';
  activity: 'clear' | 'likely' | 'unclear' | 'none';
  size: 'solo_or_micro' | 'small' | 'medium' | 'large_or_chain' | 'unknown';
  isIt: boolean;
  decision: 'deep' | 'maybe' | 'skip';
  decisionReason: string;
}

export interface CompanyInput {
  domain: string;
  name: string;
  website: string;
  market: string;
  /** Stage B result; null when the business was never assessed. */
  business: BusinessInput | null;
  deepRecommendation: 'pursue' | 'maybe' | 'drop' | null;
  opportunities: OpportunityInput[];
  technical: { code: string; status: 'verified' | 'likely'; url: string | null }[];
  email: { address: string; freemail: boolean; source: string } | null;
  emailHiddenOn: string[];
  risk: { level: 'low' | 'review_required' | 'high' | null; note: string };
  /** Inspected before the current rules (phase 1): data must be refreshed before contact. */
  legacy: boolean;
}

export interface ScoredOpportunity extends OpportunityInput {
  type: ProjectType;
  relevance: number;
  evidenceScore: number;
  scope: number;
  duplication: number;
  total: number;
}

export type Tier = 'strong' | 'investigate' | 'minor_technical' | 'exclude' | 'no_signal';

export interface Qualification {
  company: CompanyInput;
  tier: Tier;
  best: ScoredOpportunity | null;
  /** Why the company is in its tier (operator-facing). */
  reasons: string[];
  /** Technical website quality, shown apart: never decides the tier. */
  technicalSummary: string;
  contact: 'email' | 'manual_discovery';
  readyForContactReview: boolean;
}

// Only stage C ties evidence to the claim (fact / inference labels checked by code). A stage B
// quote proves only that the text exists; a technical finding is not a business need. Both are weak.
const EVIDENCE_STRENGTH: Record<EvidenceKind, number> = {
  fact: 3,
  inference: 2,
  quote: 1,
  finding_verified: 1,
  finding_likely: 1,
  hypothesis: 0,
  none: 0,
};

/** Business relevance 0–3 from the stage B assessment; null when never assessed. */
export function relevanceOf(b: BusinessInput | null): number | null {
  if (!b) return null;
  if (b.isIt || b.size === 'large_or_chain' || b.activity === 'none') return 0;
  let r = { clear: 3, likely: 2, unclear: 1, none: 0 }[b.activity];
  if (b.size === 'solo_or_micro') r -= 1; // custom development is rarely bought by a one-person business
  return Math.max(0, r);
}

export function evidenceScoreOf(o: OpportunityInput): number {
  const best = Math.max(0, ...o.evidence.map((e) => (e.absenceOnly ? 1 : EVIDENCE_STRENGTH[e.kind])));
  return o.eligible === false ? Math.min(best, 1) : best;
}

export function scoreOpportunity(o: OpportunityInput, relevance: number | null): ScoredOpportunity {
  const type = projectTypeOf(`${o.title} ${o.proposal}`, o.category);
  const scope = o.projectSize ? { small: 1, medium: 2, large: 3 }[o.projectSize] : TYPE_SCOPE[type];
  const duplication = o.duplicates || o.alreadyExists === 'yes' ? -3 : o.alreadyExists === 'partially' ? -1 : 0;
  const evidenceScore = evidenceScoreOf(o);
  const rel = relevance ?? 1; // unknown business: neither boost nor zero
  return { ...o, type, relevance: rel, evidenceScore, scope, duplication, total: rel + evidenceScore + scope + duplication };
}

const MINOR_CODES = new Set(['BROKEN_INTERNAL_LINKS', 'OUTDATED_COPYRIGHT', 'PDF_CATALOG', 'NO_VIEWPORT_META', 'MOBILE_OVERFLOW', 'SMALL_TAP_TARGETS', 'SSL_ERROR']);

export function qualify(c: CompanyInput): Qualification {
  const relevance = relevanceOf(c.business);
  // Equal totals: the better-evidenced proposal wins (a stage C fact over a stage B quote).
  const scored = c.opportunities.map((o) => scoreOpportunity(o, relevance)).sort((a, b) => b.total - a.total || b.evidenceScore - a.evidenceScore);
  const projects = scored.filter((o) => o.type !== 'website_fix' && o.duplication > -3);
  const best = projects[0] ?? null;
  const verified = c.technical.filter((t) => t.status === 'verified');
  const technicalSummary = c.technical.length
    ? `${verified.length ? `проверено: ${verified.map((t) => t.code).join(', ')}` : 'проверенных нет'}${c.technical.length > verified.length ? `; вероятно: ${c.technical.filter((t) => t.status === 'likely').map((t) => t.code).join(', ')}` : ''}`
    : 'технических находок нет';
  const contact = c.email ? 'email' : 'manual_discovery';
  const base = { company: c, technicalSummary, contact } as const;
  const result = (tier: Tier, reasons: string[], b: ScoredOpportunity | null = best): Qualification => ({
    ...base,
    tier,
    best: b,
    reasons,
    readyForContactReview: tier === 'strong' && contact === 'email' && c.risk.level !== 'high' && !c.legacy,
  });

  const b = c.business;
  if (b?.isIt) return result('exclude', ['сам продаёт IT или веб-разработку'], null);
  if (b?.size === 'large_or_chain') return result('exclude', ['крупная компания или сеть — не наш размер'], null);
  if (b?.decision === 'skip') return result('exclude', [`этап B: ${b.decisionReason}`], null);
  if (c.deepRecommendation === 'drop') return result('exclude', ['этап C: «не предлагать»'], null);

  if (best && best.evidenceScore >= 2 && (relevance ?? 0) >= 2 && best.scope >= 2 && best.duplication > -2 && best.total >= 7) {
    return result('strong', [
      `проект: ${PROJECT_LABEL[best.type]}`,
      `доказательство ${best.evidenceScore}/3, значимость ${relevance}/3, масштаб ${best.scope}/3${best.duplication ? `, частично уже есть (${best.duplication})` : ''}`,
    ]);
  }
  if (best && (best.evidenceScore >= 1 || (relevance ?? 0) >= 2) && best.total >= 4) {
    const gaps = [
      best.evidenceScore < 2 ? 'доказательство слабое (вывод из отсутствия функции или вероятная находка)' : '',
      relevance === null ? 'бизнес не оценивался' : relevance < 2 ? 'значимость для бизнеса неясна' : '',
      best.scope < 2 ? 'проект небольшой' : '',
      best.duplication <= -1 ? 'на сайте это частично уже есть' : '',
    ].filter(Boolean);
    return result('investigate', [`возможный проект: ${PROJECT_LABEL[best.type]}`, ...(gaps.length ? [`нужно проверить: ${gaps.join('; ')}`] : [])]);
  }
  if (c.technical.length || scored.some((o) => o.type === 'website_fix')) {
    const minorOnly = c.technical.every((t) => MINOR_CODES.has(t.code));
    return result(
      'minor_technical',
      [minorOnly ? 'только мелкие технические дефекты — сами по себе не проект' : 'только технические находки', ...(best ? [] : ['коммерческого проекта не найдено'])],
      null,
    );
  }
  return result('no_signal', ['нет ни проекта, ни находок'], null);
}

const TIER_ORDER: Record<Tier, number> = { strong: 0, investigate: 1, minor_technical: 2, exclude: 3, no_signal: 4 };

/** Commercial potential first; contactability and risk only break ties inside a tier. */
export function rank(list: Qualification[]): Qualification[] {
  const contactScore = (q: Qualification) => (q.contact === 'email' ? 0 : 1) + (q.company.risk.level === 'high' ? 2 : 0);
  return [...list].sort(
    (a, b) =>
      TIER_ORDER[a.tier] - TIER_ORDER[b.tier] ||
      (b.best?.total ?? 0) - (a.best?.total ?? 0) ||
      contactScore(a) - contactScore(b) ||
      a.company.domain.localeCompare(b.company.domain),
  );
}
