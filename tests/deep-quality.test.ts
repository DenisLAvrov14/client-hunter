// Regressions from the first paid stage C run (2026-10-24, docs/decisions.md): answers shaped like
// what the model actually returned — capability labels instead of keys, invented keys, drafts about
// another proposal or stating an inference as seen — checked against fixtures built from the same
// sites' published text. No network, no LLM.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { openDb, type Db } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { finishInspection, insertObservation, insertPage, startInspection, updateCompany, upsertDiscovered } from '../src/db/repo.js';
import type { ContactChannelRow } from '../src/db/repo.js';
import { detectCapabilities, resolveCapabilityRef } from '../src/inspect/capabilities.js';
import { internalLinks } from '../src/inspect/extract.js';
import { buildPageContext } from '../src/inspect/page.js';
import type { ObservationCode, PageKind, Platform } from '../src/inspect/types.js';
import { DEEP_PROMPT, estimateDeepRun } from '../src/llm/deep.js';
import { buildDeepInput, type DeepInput } from '../src/llm/deepInput.js';
import { draftGrounding, finalizeDeep, mixedLanguage, validateDeep, type DeepContext } from '../src/llm/deepValidate.js';
import type { DeepResult, StatementT } from '../src/llm/schemas.js';
import { channelLines } from '../src/reports/candidates.js';

const config = loadConfig();

function freshDb(): Db {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

interface Site {
  name: string;
  home: string;
  market: 'UK' | 'NL' | 'KZ';
  platform: Platform;
  pages: [string, PageKind, string][];
  findings?: { code: ObservationCode; status: 'verified' | 'likely'; evidenceUrl?: string }[];
}

function inspected(db: Db, s: Site): { companyId: string; input: DeepInput; findings: string[] } {
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

const ctx = (domain: string, name: string, over: Partial<DeepContext> = {}): DeepContext => ({
  rules: config.copyRules,
  expectedLanguage: 'en',
  mode: 'offer',
  companyDomain: domain,
  companyName: name,
  allowExtraPages: false,
  ...over,
});

const fact = (text: string, evidence: StatementT['evidence']): StatementT => ({ text, kind: 'fact', evidence });
const inference = (text: string, evidence: StatementT['evidence']): StatementT => ({ text, kind: 'inference', evidence });
const cap = (ref: string) => ({ type: 'capability' as const, ref, page_url: '' });
const quote = (ref: string, page_url: string) => ({ type: 'quote' as const, ref, page_url });
const finding = (ref: string) => ({ type: 'finding' as const, ref, page_url: '' });

// ---- A1deSIGNS: WooCommerce shop with prices, an enquiry form, sign-in; no calculator ----
const A1 = 'https://www.a1designs.co.uk/';
const A1_WORDS = `${A1}product-category/led-flex-neon-signs/quote-words/`;
const A1_CONTACT = `${A1}contact/`;
const a1Site: Site = {
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

function a1Answer(over: Partial<DeepResult> = {}): DeepResult {
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
const JNH = 'https://jnhlogistics.com/';
const JNH_ABOUT = `${JNH}about-us/`;
const jnhSite: Site = {
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

function jnhAnswer(over: Partial<DeepResult['outreach']> = {}): DeepResult {
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
const PP = 'https://potolok-pro.kz/';
const ppSite: Site = {
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

function ppAnswer(tapFinding: string, over: Partial<DeepResult['outreach']> = {}): DeepResult {
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

describe('capability evidence (first run: every capability claim was downgraded)', () => {
  it('the input shows each capability with its machine key, and the model may cite the key or the exact label', () => {
    const db = freshDb();
    const { input } = inspected(db, a1Site);
    expect(input.text).toContain('- cart_checkout · online shop / cart: yes (woocommerce store)');
    expect(input.text).toContain('- prices_visible · prices shown on the site: yes (£204.00)');
    expect(input.text).toContain('- calculator_configurator · calculator or configurator: no');
    expect(resolveCapabilityRef('cart_checkout')).toBe('cart_checkout');
    expect(resolveCapabilityRef('Online shop / cart')).toBe('cart_checkout');
    expect(resolveCapabilityRef('cart_checkout · online shop / cart: yes (woocommerce store)')).toBe('cart_checkout');
    expect(resolveCapabilityRef('prices shown on the site: yes')).toBe('prices_visible');
    // Invented keys are never guessed.
    expect(resolveCapabilityRef('online_shop')).toBeNull();
    expect(resolveCapabilityRef('enquiry_form')).toBeNull();
  });

  it('A1: detected capabilities cited by label stay facts, with canonical keys stored', () => {
    const db = freshDb();
    const { input } = inspected(db, a1Site);
    const v = validateDeep(a1Answer(), input, ctx('a1designs.co.uk', 'A1deSIGNS'));
    expect(v.result.existing_capabilities.map((s) => s.kind)).toEqual(['fact', 'fact', 'fact', 'fact']);
    expect(v.result.existing_capabilities.map((s) => s.evidence[0]!.ref)).toEqual(['cart_checkout', 'prices_visible', 'inquiry_form', 'customer_login']);
    // "No calculator" (capability absent) supports the inference that motivates the proposal.
    expect(v.result.opportunities[0]!.observed[0]).toMatchObject({ kind: 'inference', evidence: [{ ref: 'calculator_configurator' }] });
    expect(v.issues.join('\n')).not.toContain('unverifiable');
    expect(v.eligible).toEqual([true]);
  });

  it('freza-style invented keys are unverifiable: the claim becomes a hypothesis and the model is told the real keys', () => {
    const db = freshDb();
    const { input } = inspected(db, a1Site);
    const v = validateDeep(a1Answer({ existing_capabilities: [fact('Работает интернет-магазин', [cap('online_shop')])] }), input, ctx('a1designs.co.uk', 'A1deSIGNS'));
    expect(v.result.existing_capabilities[0]).toMatchObject({ kind: 'hypothesis', evidence: [] });
    expect(v.feedback).toContain('"online_shop" is not a capability key');
  });

  it('a capability the code does not detect cannot become "the site already has it"', () => {
    const db = freshDb();
    const { input } = inspected(db, a1Site);
    const v = validateDeep(
      a1Answer({ existing_capabilities: [fact('На сайте есть калькулятор стоимости', [cap('calculator or configurator')])] }),
      input,
      ctx('a1designs.co.uk', 'A1deSIGNS'),
    );
    expect(v.result.existing_capabilities[0]).toMatchObject({ kind: 'hypothesis', evidence: [] });
    expect(v.issues.join('\n')).toContain('says the site has calculator_configurator, but code does not detect it');
  });

  it('proposing what the site already has is not eligible, even with already_exists "unknown"', () => {
    const db = freshDb();
    const { input } = inspected(db, a1Site);
    const a = a1Answer();
    a.opportunities = [{ ...a.opportunities[0]!, title: 'Интернет-магазин с корзиной', already_exists: 'unknown' }];
    const v = validateDeep(a, input, ctx('a1designs.co.uk', 'A1deSIGNS'));
    expect(v.eligible).toEqual([false]);
    expect(v.feedback).toContain('the site already shows cart_checkout');
  });
});

describe('outreach grounding (first run: drafts stated inferences as seen, or pitched another proposal)', () => {
  it('A1: a draft built on the quoted fact passes; the same draft built on the inference must be a question', () => {
    const db = freshDb();
    const { input } = inspected(db, a1Site);
    const c = ctx('a1designs.co.uk', 'A1deSIGNS');
    const ok = finalizeDeep(validateDeep(a1Answer(), input, c));
    expect(ok.outreachIssues).toEqual([]);
    expect(ok.result.recommendation).toBe('pursue');

    const onInference = a1Answer();
    onInference.outreach = { ...onInference.outreach, observation_index: 0 };
    const v = validateDeep(onInference, input, c);
    expect(v.retry).toBe(true);
    expect(v.feedback).toContain('is only an inference: the draft must ask about it');
    expect(finalizeDeep(v).outreachIssues.join('\n')).toContain('черновик подаёт как наблюдение то, что является только выводом');
  });

  it('JNH: "the site has no way to check a status" is an inference — stated as seen it is unusable, asked as a question it passes', () => {
    const db = freshDb();
    const { input } = inspected(db, jnhSite);
    const c = ctx('jnhlogistics.com', 'JNH Logistics B.V.');
    const stated = finalizeDeep(validateDeep(jnhAnswer(), input, c));
    expect(stated.result.opportunities[0]!.observed[1]!.kind).toBe('inference');
    expect(stated.outreachIssues.join('\n')).toContain('только выводом');

    const asked = finalizeDeep(
      validateDeep(
        jnhAnswer({
          framing: 'question',
          body: 'Hello, I could not find a way for customers to check a shipment status on your site. Do they usually ask you by phone? A small status page could answer that. Would a short outline be useful?',
        }),
        input,
        c,
      ),
    );
    expect(asked.outreachIssues).toEqual([]);
  });

  it('PRO-POTOLOK: a draft about another proposal than the chosen one is flagged, also after the retry', () => {
    const db = freshDb();
    const { input, findings } = inspected(db, ppSite);
    const c = ctx('potolok-pro.kz', 'PRO-POTOLOK', { expectedLanguage: 'ru', mode: 'permission_request' });
    const v = validateDeep(ppAnswer(findings[0]!), input, c);
    expect(v.retry).toBe(true);
    expect(v.feedback).toContain('Write the draft about the best opportunity');
    const final = finalizeDeep(v);
    expect(final.outreachIssues.join('\n')).toContain('черновик предлагает «Исправить размер кнопок для телефона», а выбранное предложение — «Онлайн-запись');
    // Even pointed at the right proposal, its basis is an inference: only a question is acceptable.
    const right = finalizeDeep(validateDeep(ppAnswer(findings[0]!, { opportunity_index: 0, framing: 'observation' }), input, c));
    expect(right.outreachIssues.join('\n')).toContain('только выводом');
  });

  it('a draft resting on a hypothesis is unusable whatever its framing', () => {
    const db = freshDb();
    const { input } = inspected(db, a1Site);
    const a = a1Answer();
    a.opportunities[0]!.observed.push({ text: 'Клиенты, вероятно, уходят без заказа', kind: 'hypothesis', evidence: [] });
    a.outreach = { ...a.outreach, observation_index: 2, framing: 'question' };
    expect(finalizeDeep(validateDeep(a, input, ctx('a1designs.co.uk', 'A1deSIGNS'))).outreachIssues.join('\n')).toContain(
      'черновик опирается на непроверенное предположение',
    );
  });

  it('when code moves the best pick, the draft is judged against the new pick', () => {
    const r = a1Answer();
    const second = { ...r.opportunities[0]!, title: 'Второе предложение' };
    r.opportunities = [r.opportunities[0]!, second];
    r.best_opportunity_index = 1;
    r.outreach = { ...r.outreach, opportunity_index: 1 };
    const v = finalizeDeep({ result: r, issues: [], retry: false, feedback: '', eligible: [true, false], draftRuleIssues: [], outreachIssues: [], needPages: [] });
    expect(v.result.best_opportunity_index).toBe(0);
    expect(v.outreachIssues.join('\n')).toContain('черновик предлагает «Второе предложение»');
    expect(draftGrounding(v.result, [true, false]).length).toBeGreaterThan(0);
  });
});

describe('recommendation calibration (first run: all five "maybe" because volumes were unknown)', () => {
  const kz = (): Site => ({
    name: 'Мебель',
    home: 'http://kazbelmebel.kz/',
    market: 'KZ',
    platform: 'custom',
    pages: [['http://kazbelmebel.kz/', 'home', '<p>Салон Белорусской мебели</p><p>Цена 20 400 тенге</p>']],
    findings: [
      { code: 'SSL_ERROR', status: 'verified' },
      { code: 'MOBILE_OVERFLOW', status: 'verified' },
    ],
  });
  const rescue = (findings: string[], recommendation: DeepResult['recommendation'], kind: 'fact' | 'inference' = 'fact'): DeepResult => {
    const a = a1Answer();
    return {
      ...a,
      existing_capabilities: [],
      customer_journey: [],
      opportunities: [
        {
          ...a.opportunities[0]!,
          title: 'Исправить мобильную версию и HTTPS',
          category: 'website_rescue',
          observed: findings.map((f) => ({ text: 'Страница шире экрана телефона, сертификат с ошибкой', kind, evidence: [finding(f)] })),
          already_exists: 'no',
        },
      ],
      recommendation,
      recommendation_reason: 'Неизвестно, сколько заявок приходит через сайт.',
      outreach: { ...a.outreach, language: 'ru', body: 'Здравствуйте. Заметил, что страницы сайта на телефоне шире экрана. Я веб-разработчик. Хотели бы вы получить короткий разбор?' },
    };
  };
  const c = ctx('kazbelmebel.kz', 'Мебель', { expectedLanguage: 'ru', mode: 'permission_request' });

  it('clear pursue: verified technical findings behind the best proposal keep "pursue", unknown volumes notwithstanding', () => {
    const db = freshDb();
    const { input, findings } = inspected(db, kz());
    const v = finalizeDeep(validateDeep(rescue(findings, 'pursue'), input, c));
    expect(v.result.recommendation).toBe('pursue');
    expect(v.outreachIssues).toEqual([]);
  });

  it('justified maybe: a proposal resting on inferences only cannot be "pursue"', () => {
    const db = freshDb();
    const { input } = inspected(db, ppSite);
    const a = ppAnswer('obs_x', { opportunity_index: 0, framing: 'question' });
    a.recommendation = 'pursue';
    const v = finalizeDeep(validateDeep(a, input, ctx('potolok-pro.kz', 'PRO-POTOLOK', { expectedLanguage: 'ru', mode: 'permission_request' })));
    expect(v.result.recommendation).toBe('maybe');
    expect(v.issues.join('\n')).toContain('pursue → maybe: the chosen proposal rests on inferences only');
  });

  it('code never inflates: a model "maybe" stays "maybe" even with verified evidence', () => {
    const db = freshDb();
    const { input, findings } = inspected(db, kz());
    expect(finalizeDeep(validateDeep(rescue(findings, 'maybe'), input, c)).result.recommendation).toBe('maybe');
  });

  it('drop: nothing grounded stays "drop" and its draft is marked not to use', () => {
    const db = freshDb();
    const { input } = inspected(db, kz());
    const v = finalizeDeep(validateDeep(rescue(['obs_made_up'], 'drop'), input, c));
    expect(v.result.recommendation).toBe('drop');
    expect(v.eligible).toEqual([false]);
    expect(v.outreachIssues.join('\n')).toContain('рекомендация «не предлагать» — черновик не использовать');
  });

  it('the prompt states that unknown metrics do not block "pursue" and defines all three outcomes', () => {
    expect(DEEP_PROMPT).toContain('they do not block `pursue`');
    expect(DEEP_PROMPT).toContain('Never choose `maybe` only because metrics are unknown');
    for (const r of ['- `pursue`:', '- `maybe`:', '- `drop`:']) expect(DEEP_PROMPT).toContain(r);
  });
});

describe('minor fixes from the first run', () => {
  it('English function words mixed into Russian text are caught ("how часто"); quotes and brand names are fine', () => {
    expect(mixedLanguage('Как клиенты сейчас узнают о статусе отправки и how часто задают этот вопрос?')).toBe(true);
    expect(mixedLanguage('Готовые LED-надписи и магазин на Shopify, перевозки FTL')).toBe(false);
    expect(mixedLanguage('На странице написано «We keep you informed about the progress of your shipments»')).toBe(false);
    expect(mixedLanguage('We keep you informed')).toBe(false); // not Russian text at all

    const db = freshDb();
    const { input } = inspected(db, jnhSite);
    const a = jnhAnswer({ framing: 'question' });
    a.opportunities[0]!.open_questions = ['Как клиенты узнают о статусе и how часто спрашивают?'];
    const v = validateDeep(a, input, ctx('jnhlogistics.com', 'JNH Logistics B.V.'));
    expect(v.retry).toBe(true);
    expect(v.feedback).toContain('fully in Russian');
  });

  it('known links skip anti-scraping endpoints and documents; nearly empty pages are pointed out', () => {
    const db = freshDb();
    const { input } = inspected(db, jnhSite);
    expect([...input.knownLinks.keys()]).toEqual(['https://jnhlogistics.com/services/full-truck-load']);
    expect(input.text).not.toContain('cdn-cgi');
    expect(input.text).not.toContain('.pdf');
    // Every page of this small fixture is short, so all are listed; the empty services page among them.
    expect(input.text).toMatch(/## Pages read but with almost no text \(content may be on their sub-pages\): [^\n]*https:\/\/jnhlogistics\.com\/services\//);
  });

  it('page text keeps adjacent elements apart, so word-boundary detectors work ("in-person</p><a>Sign in" was "in-personSign in")', () => {
    const page = buildPageContext(A1, 'home', 200, '<h1>A1</h1><p>or in-person</p><a href="/my-account">Sign in</a><ul><li>Home</li><li>About</li></ul>');
    expect(page.text).toBe('A1 or in-person Sign in Home About');
    expect(detectCapabilities([page], 'custom', null).flags.customer_login.present).toBe(true);
  });

  it('a site-wide form is one line in reports, contact page first; unconfirmed forms keep their own line', () => {
    const form = (url: string, confirmed = 1): ContactChannelRow => ({
      channel: 'form',
      value: url,
      uncertain: 0,
      note: null,
      display: null,
      source_url: url,
      first_seen_at: 't',
      confirmed,
    });
    const phone: ContactChannelRow = { ...form(A1), channel: 'phone', value: '+442086469886', display: '020 8646 9886' };
    const lines = channelLines([form(A1), form(`${A1}about/`), form(A1_CONTACT), form(`${A1}neon-signs/`), phone, form(`${A1}old/`, 0)]);
    expect(lines[0]).toBe(`форма: ${A1_CONTACT} — форма обращения есть на 4 страницах сайта (также /, /about/, /neon-signs/)`);
    expect(lines.filter((l) => l.startsWith('форма:'))).toHaveLength(2); // + the unconfirmed one
    expect(lines.some((l) => l.startsWith('телефон: +442086469886'))).toBe(true);
    expect(channelLines([form(A1_CONTACT)])).toEqual([`форма: ${A1_CONTACT} — источник: ${A1_CONTACT}`]);
  });

  it('the typical dry-run estimate assumes ~5,500 output tokens; the worst case still uses max_output_tokens', () => {
    const db = freshDb();
    const { companyId } = inspected(db, a1Site);
    const est = estimateDeepRun(db, config, [companyId]);
    const p = config.llm.prices[config.llm.stages.deep.model]!;
    expect(est.estimateUsd).toBeCloseTo((est.inputTokens * p.input + 5500 * p.output) / 1_000_000, 10);
    expect(est.worstUsd).toBeGreaterThanOrEqual((4 * config.llm.stages.deep.max_output_tokens * p.output) / 1_000_000);
  });
});
