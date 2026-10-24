// Sites from the paid stage C runs (2026-10-24) rebuilt from their published text, and answers
// shaped like what the model actually returned. Shared by the stage C regression tests.
import { loadConfig } from '../../src/config/load.js';
import { openDb, type Db } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { finishInspection, insertObservation, insertPage, startInspection, updateCompany, upsertDiscovered } from '../../src/db/repo.js';
import { detectCapabilities } from '../../src/inspect/capabilities.js';
import { internalLinks } from '../../src/inspect/extract.js';
import { buildPageContext } from '../../src/inspect/page.js';
import type { ObservationCode, PageKind, Platform } from '../../src/inspect/types.js';
import { buildDeepInput, type DeepInput } from '../../src/llm/deepInput.js';
import type { DeepContext } from '../../src/llm/deepValidate.js';
import type { DeepResult, StatementT } from '../../src/llm/schemas.js';

export const config = loadConfig();

export function freshDb(): Db {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

export interface Site {
  name: string;
  home: string;
  market: 'UK' | 'NL' | 'KZ';
  platform: Platform;
  pages: [string, PageKind, string][];
  findings?: { code: ObservationCode; status: 'verified' | 'likely'; evidenceUrl?: string }[];
}

export function inspected(db: Db, s: Site): { companyId: string; input: DeepInput; findings: string[] } {
  const { id } = upsertDiscovered(
    db,
    { name: s.name, websiteUrl: s.home, city: null, sourceRef: null, query: null },
    { market: s.market, segment: 'S2', sourceId: 'csv', termsNote: 't' },
  )!;
  const ins = startInspection(db, id, 'reinspect');
  const ctxs = s.pages.map(([url, kind, html]) => buildPageContext(url, kind, 200, html));
  ctxs.forEach((p) => insertPage(db, id, ins, p, { mainText: p.text, links: internalLinks(p, 40) }));
  const findings = (s.findings ?? []).map((f) =>
    insertObservation(db, id, ins, { code: f.code, status: f.status, description: f.code, evidenceUrl: f.evidenceUrl ?? s.home }),
  );
  finishInspection(db, ins, { status: 'inspected', reason: null, capabilities: detectCapabilities(ctxs, s.platform, null), contactStatus: 'form_only' });
  updateCompany(db, id, { status: 'inspected', last_inspection_id: ins, platform: s.platform });
  return { companyId: id, input: buildDeepInput(db, id, 16000)!, findings };
}

export const ctx = (domain: string, name: string, over: Partial<DeepContext> = {}): DeepContext => ({
  rules: config.copyRules,
  expectedLanguage: 'en',
  mode: 'offer',
  companyDomain: domain,
  companyName: name,
  allowExtraPages: false,
  ...over,
});

export const fact = (text: string, evidence: StatementT['evidence']): StatementT => ({ text, kind: 'fact', evidence });
export const inference = (text: string, evidence: StatementT['evidence']): StatementT => ({ text, kind: 'inference', evidence });
export const cap = (ref: string) => ({ type: 'capability' as const, ref, page_url: '' });
export const quote = (ref: string, page_url: string) => ({ type: 'quote' as const, ref, page_url });
export const finding = (ref: string) => ({ type: 'finding' as const, ref, page_url: '' });

// ---- A1deSIGNS: WooCommerce shop with prices, an enquiry form, sign-in; no calculator ----
export const A1 = 'https://www.a1designs.co.uk/';
export const A1_WORDS = `${A1}product-category/led-flex-neon-signs/quote-words/`;
export const A1_CONTACT = `${A1}contact/`;
export const a1Site: Site = {
  name: 'A1deSIGNS',
  home: A1,
  market: 'UK',
  platform: 'woocommerce',
  pages: [
    [A1, 'home', '<h1>A1deSIGNS - London Based Sign Maker</h1><p>personalised consultations via phone, email, or in-person</p><a href="/my-account">Sign in</a>'],
    [
      A1_WORDS,
      'workflow',
      '<h1>Quotes &amp; Words</h1><p>Price range: £204.00 through £520.00</p><p>If what you want is not listed here, or if you would like to customise one of the items, please get in touch via the button below.</p>',
    ],
    [
      A1_CONTACT,
      'contact',
      '<p>Please provide as much information as you can with your enquiry</p><form><input name="name"><input name="email" type="email"><textarea name="message"></textarea></form>',
    ],
  ],
};

export function a1Answer(over: Partial<DeepResult> = {}): DeepResult {
  return {
    business_summary: 'Лондонская мастерская вывесок и неона.',
    business_model: 'Готовые изделия в онлайн-магазине и индивидуальные заказы.',
    offering: ['неоновые вывески', 'LED-неон'],
    customer_journey: [
      fact('Клиент видит диапазоны цен на готовые надписи', [quote('Price range: £204.00 through £520.00', A1_WORDS)]),
      inference('Форма заявки просит подробные данные перед оценкой', [quote('Please provide as much information as you can with your enquiry', A1_CONTACT)]),
    ],
    // As returned: capability LABELS from the input, not keys.
    existing_capabilities: [
      fact('Работающий онлайн-магазин с корзиной', [cap('online shop / cart')]),
      fact('Цены на готовые изделия показаны на сайте', [cap('prices shown on the site')]),
      fact('Форма обратной связи для заявок', [cap('enquiry or contact form')]),
      fact('Вход в личный кабинет клиента', [cap('customer login / account')]),
    ],
    opportunities: [
      {
        title: 'Конфигуратор индивидуальной надписи с ориентировочной ценой',
        category: 'business_improvement',
        observed: [
          inference('Индивидуальные заказы идут через общую кнопку связи, а не через расчёт на сайте', [cap('calculator or configurator')]),
          fact('Сайт прямо указывает, что изменение товара требует связи с компанией', [
            quote('If what you want is not listed here, or if you would like to customise one of the items, please get in touch via the button below.', A1_WORDS),
          ]),
        ],
        proposal: 'Страница, где клиент вводит текст, выбирает размер и цвет и видит ориентир цены.',
        value: [{ text: 'Заявки будут приходить более подготовленными', kind: 'hypothesis', evidence: [] }],
        already_exists: 'partially',
        already_exists_note: 'Есть магазин с ценами на готовые товары, но нет расчёта для своего текста.',
        project_size: 'medium',
        portfolio: 'pinpinpin',
        open_questions: ['Какая доля заказов индивидуальные?'],
      },
    ],
    best_opportunity_index: 0,
    best_reason: 'Индивидуальные надписи — заметная часть ассортимента.',
    recommendation: 'pursue',
    recommendation_reason: 'Есть конкретное наблюдение на сайте.',
    recommendation_blockers: [],
    unknowns: ['Объём индивидуальных заказов'],
    outreach: {
      language: 'en',
      subject: 'Quote form for custom neon wording',
      body: 'Hello, on your Quotes and Words page custom wording is handled through a general contact button. A short guided form that shows an indicative price range could help enquiries arrive ready to quote. I build quote tools like this, for example https://pinpinpin.it. Would a short write-up be useful?',
      opportunity_index: 0,
      observation_index: 1,
      framing: 'observation',
    },
    need_pages: [],
    ...over,
  };
}

// ---- JNH Logistics: quote form, no customer login, a thin services page with sub-pages ----
export const JNH = 'https://jnhlogistics.com/';
export const JNH_ABOUT = `${JNH}about-us/`;
export const jnhSite: Site = {
  name: 'JNH Logistics B.V.',
  home: JNH,
  market: 'NL',
  platform: 'wordpress',
  pages: [
    [
      JNH,
      'home',
      '<p>Curious about the rates for transporting your goods with JNH Logistics?</p><a href="/services/full-truck-load">Full truck load</a>' +
        '<a href="/cdn-cgi/l/email-protection#abc">[email protected]</a><a href="/wp-content/uploads/2024/03/Privacy.pdf">Privacy statement</a>',
    ],
    [JNH_ABOUT, 'about', '<p>We keep you informed about the progress of your shipments, so you always know where your goods are.</p>'],
    [`${JNH}services/`, 'services', '<h1>Our Services</h1>'],
    [`${JNH}quote/`, 'workflow', '<p>Request quote</p><form><input name="from"><input name="to"><textarea name="cargo"></textarea></form>'],
  ],
  findings: [{ code: 'BROKEN_INTERNAL_LINKS', status: 'verified' }],
};

export function jnhAnswer(over: Partial<DeepResult['outreach']> = {}): DeepResult {
  return {
    ...a1Answer(),
    customer_journey: [],
    existing_capabilities: [fact('Есть форма заявки на перевозку', [cap('inquiry_form')])],
    opportunities: [
      {
        title: 'Статус отправки для клиентов',
        category: 'business_improvement',
        observed: [
          fact('Компания заявляет, что информирует клиентов о ходе отправок', [quote('We keep you informed about the progress of your shipments', JNH_ABOUT)]),
          // As returned: the absence is concluded from "no login" — an inference, not something seen.
          inference('На сайте не видно способа клиенту самому узнать статус груза', [cap('customer login / account')]),
        ],
        proposal: 'Раздел, где клиент вводит номер отправки и видит статус.',
        value: [],
        already_exists: 'no',
        already_exists_note: 'Страницы статуса нет.',
        project_size: 'medium',
        portfolio: 'cryptovigil',
        open_questions: ['Откуда известен статус груза?'],
      },
    ],
    outreach: {
      language: 'en',
      subject: 'Shipment status on your website',
      // As drafted: the inference stated as an observation.
      body: 'Hello, your About page says you keep clients informed about their shipments, while the site has no way for a customer to check a status without contacting you. Would a short outline of a status page be useful?',
      opportunity_index: 0,
      observation_index: 1,
      framing: 'observation',
      ...over,
    },
  };
}

// ---- PRO-POTOLOK: calculator and form exist; tap targets only "likely" ----
export const PP = 'https://potolok-pro.kz/';
export const ppSite: Site = {
  name: 'PRO-POTOLOK',
  home: PP,
  market: 'KZ',
  platform: 'tilda',
  pages: [
    [
      PP,
      'home',
      '<h1>ПОСЧИТАТЬ ПРИМЕРНУЮ ЦЕНУ</h1><p>Калькулятор стоимости</p><p>Он приедет к вам в течении часа или в любое удобное для вас время.</p>' +
        '<form><input name="name"><input name="phone"></form>',
    ],
  ],
  findings: [{ code: 'SMALL_TAP_TARGETS', status: 'likely' }],
};

export function ppAnswer(tapFinding: string, over: Partial<DeepResult['outreach']> = {}): DeepResult {
  return {
    ...a1Answer(),
    customer_journey: [],
    existing_capabilities: [fact('Калькулятор примерной стоимости', [cap('calculator or configurator')])],
    opportunities: [
      {
        title: 'Онлайн-запись на бесплатный замер с выбором времени',
        category: 'business_improvement',
        observed: [inference('Сайт обещает выезд в удобное время, но выбора времени на сайте нет', [quote('Он приедет к вам в течении часа или в любое удобное для вас время.', PP)])],
        proposal: 'Форма записи на замер с выбором дня и времени.',
        value: [],
        already_exists: 'partially',
        already_exists_note: 'Есть форма заявки, нет выбора времени.',
        project_size: 'small',
        portfolio: 'cryptovigil',
        open_questions: [],
      },
      {
        title: 'Исправить размер кнопок для телефона',
        category: 'website_rescue',
        observed: [inference('На телефоне кнопки мелкие', [finding(tapFinding)])],
        proposal: 'Увеличить кнопки и ссылки в мобильной версии.',
        value: [],
        already_exists: 'no',
        already_exists_note: '',
        project_size: 'small',
        portfolio: 'none',
        open_questions: [],
      },
    ],
    recommendation: 'maybe',
    outreach: {
      language: 'ru',
      subject: 'Наблюдение по мобильной версии сайта',
      // As drafted: about the tap targets (opportunity 2), stated as seen — but the pick is booking.
      body: 'Здравствуйте. Посмотрел сайт и заметил, что на телефоне многие кнопки маленькие. Я веб-разработчик. Не хотели бы вы получить короткий разбор того, как это можно улучшить?',
      opportunity_index: 1,
      observation_index: 0,
      framing: 'observation',
      ...over,
    },
  };
}
