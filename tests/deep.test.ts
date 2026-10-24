import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { loadConfig, type Config } from '../src/config/load.js';
import { openDb, type Db } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import {
  finishInspection,
  insertObservation,
  insertOutreachRisk,
  insertPage,
  latestSuccessfulInspection,
  startInspection,
  updateCompany,
  upsertContact,
  upsertContactChannel,
  upsertDiscovered,
} from '../src/db/repo.js';
import { detectCapabilities } from '../src/inspect/capabilities.js';
import type { Fetcher, FetchOptions, FetchResult } from '../src/inspect/fetcher.js';
import { internalLinks } from '../src/inspect/extract.js';
import { buildPageContext } from '../src/inspect/page.js';
import type { PageKind } from '../src/inspect/types.js';
import { Budget, BudgetExceededError } from '../src/llm/budget.js';
import { AnthropicLlmClient, LlmError, type LlmClient, type LlmRequest, type LlmResponse } from '../src/llm/client.js';
import { analyzeCompany, estimateDeepRun, type DeepMeta } from '../src/llm/deep.js';
import { buildDeepInput } from '../src/llm/deepInput.js';
import { finalizeDeep, validateDeep, type DeepContext } from '../src/llm/deepValidate.js';
import { DeepResult } from '../src/llm/schemas.js';
import { checkDraft, withOptOut } from '../src/outreach/copyCheck.js';
import { LEGACY_NO_EMAIL_RULES_VERSION, RISK_RULES_VERSION, type RiskAssessment } from '../src/outreach/risk.js';
import { dossierMarkdown, writeDossiers } from '../src/reports/dossier.js';

const config = loadConfig();
const rules = config.copyRules;
const ORIGIN = 'https://www.oakstairs.co.uk';
const HOME = `${ORIGIN}/`;
const PRICES = `${ORIGIN}/prices`;
const BOOKING = `${ORIGIN}/book-a-survey`;

function freshDb(): Db {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

/** One inspected company: home + prices page, a verified and a likely finding, a link to an unread booking page. */
function setup(db: Db) {
  const { id } = upsertDiscovered(
    db,
    { name: 'Oak Stairs', websiteUrl: HOME, city: 'Leeds', sourceRef: null, query: null },
    { market: 'UK', segment: 'S3', sourceId: 'csv', termsNote: 't' },
  )!;
  const ins = startInspection(db, id, 'reinspect');
  const pages: [string, PageKind, string][] = [
    [HOME, 'home', `<h1>Bespoke oak staircases</h1><p>Made to measure in our Leeds workshop.</p><a href="/book-a-survey">Book a survey</a>`],
    [PRICES, 'workflow', '<p>Prices on request — email us your measurements and we will reply within two days.</p>'],
  ];
  const ctxs = pages.map(([url, kind, html]) => buildPageContext(url, kind, 200, html));
  ctxs.forEach((p) => insertPage(db, id, ins, p, { mainText: p.text, links: internalLinks(p, 40) }));
  const verified = insertObservation(db, id, ins, { code: 'NO_VIEWPORT_META', status: 'verified', description: 'no viewport', evidenceUrl: HOME });
  const likely = insertObservation(db, id, ins, { code: 'MULTIPLE_INQUIRY_CHANNELS', status: 'likely', description: '3 emails' });
  finishInspection(db, ins, { status: 'inspected', reason: null, capabilities: detectCapabilities(ctxs, 'wordpress', null), contactStatus: 'email' });
  updateCompany(db, id, { status: 'inspected', last_inspection_id: ins });
  return { companyId: id, inspectionId: ins, verified, likely };
}

const ctx = (over: Partial<DeepContext> = {}): DeepContext => ({
  rules,
  expectedLanguage: 'en',
  mode: 'offer',
  companyDomain: 'oakstairs.co.uk',
  companyName: 'Oak Stairs',
  allowExtraPages: true,
  ...over,
});

function answer(verified: string, over: Partial<DeepResult> = {}): DeepResult {
  return {
    business_summary: 'Мастерская дубовых лестниц на заказ в Лидсе.',
    business_model: 'Индивидуальные заказы для частных клиентов.',
    offering: ['лестницы на заказ'],
    customer_journey: [
      { text: 'Цену узнают по email после отправки размеров', kind: 'fact', evidence: [{ type: 'quote', ref: 'email us your measurements', page_url: PRICES }] },
    ],
    existing_capabilities: [{ text: 'Есть форма или email для заявок', kind: 'inference', evidence: [{ type: 'capability', ref: 'price_on_request', page_url: '' }] }],
    opportunities: [
      {
        title: 'Онлайн-калькулятор стоимости лестницы',
        category: 'business_improvement',
        observed: [{ text: 'Цены только по запросу', kind: 'fact', evidence: [{ type: 'quote', ref: 'Prices on request', page_url: PRICES }] }],
        proposal: 'Форма с выбором размеров и породы дерева, дающая ориентир цены.',
        value: [{ text: 'Клиент быстрее понимает порядок цены', kind: 'hypothesis', evidence: [] }],
        already_exists: 'no',
        already_exists_note: 'Сейчас только email.',
        project_size: 'medium',
        portfolio: 'cryptovigil',
        open_questions: ['Есть ли типовые цены?'],
      },
      {
        title: 'Мобильная версия сайта',
        category: 'website_rescue',
        observed: [{ text: 'Нет viewport', kind: 'fact', evidence: [{ type: 'finding', ref: verified, page_url: '' }] }],
        proposal: 'Адаптировать сайт под телефоны.',
        value: [],
        already_exists: 'no',
        already_exists_note: '',
        project_size: 'small',
        portfolio: 'pinpinpin',
        open_questions: [],
      },
    ],
    best_opportunity_index: 0,
    best_reason: 'Цены только по запросу.',
    recommendation: 'pursue',
    recommendation_reason: 'Есть конкретная зацепка.',
    recommendation_blockers: [],
    unknowns: ['Сколько заявок приходит'],
    outreach: {
      language: 'en',
      subject: 'Prices on your website',
      body: 'Hello Oak Stairs team,\n\nYour prices page asks customers to email their measurements for a price. A simple form that gives a rough estimate could help customers before they get in touch.\n\nI build tools like this (https://cryptovigil.net). Would a short outline be useful?',
      opportunity_index: 0,
      observation_index: 0,
      framing: 'observation',
    },
    need_pages: [],
    ...over,
  };
}

class FakeLlm implements LlmClient {
  readonly requests: LlmRequest<z.ZodType>[] = [];
  constructor(private readonly answers: (DeepResult | LlmError)[]) {}
  async complete<S extends z.ZodType>(req: LlmRequest<S>): Promise<LlmResponse<z.infer<S>>> {
    this.requests.push(req);
    const next = this.answers.shift();
    if (!next) throw new Error('FakeLlm: no more answers');
    if (next instanceof LlmError) throw next;
    return { data: structuredClone(next) as z.infer<S>, usage: { inputTokens: 6000, outputTokens: 3000, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: req.model };
  }
}

class FakeFetcher implements Fetcher {
  readonly requests: string[] = [];
  constructor(private readonly site: Record<string, [number, string, string]>) {}
  async fetch(url: string, _opts: FetchOptions = {}): Promise<FetchResult> {
    this.requests.push(url);
    const [status, contentType, body] = this.site[url] ?? [404, 'text/html', ''];
    return { requestedUrl: url, finalUrl: url, status, contentType, body, truncated: false };
  }
}

describe('checkDraft', () => {
  const draft = answer('obs_x').outreach;
  const input = { ...draft, expectedLanguage: 'en', mode: 'offer' as const, companyDomain: 'oakstairs.co.uk', companyName: 'Oak Stairs' };

  it('passes a plain, rule-following draft and adds the opt-out line in code', () => {
    expect(checkDraft(rules, input)).toEqual([]);
    expect(withOptOut(rules, draft.body, 'en')).toMatch(/I won't contact you again\.$/);
  });

  it('rejects digits, foreign links, banned phrases, exclamation marks, wrong language and a model-written opt-out', () => {
    const bad = checkDraft(rules, {
      ...input,
      language: 'ru',
      body: `${draft.body} You could get 30% more leads! See https://example.com. I hope this email finds you well. If this isn't relevant, just reply "no".`,
    });
    expect(bad.join('\n')).toMatch(/язык письма/);
    expect(bad.join('\n')).toMatch(/цифры, проценты/);
    expect(bad.join('\n')).toMatch(/example\.com/);
    expect(bad.join('\n')).toMatch(/i hope this email finds you well/);
    expect(bad.join('\n')).toMatch(/восклицательные/);
    expect(bad.join('\n')).toMatch(/строку отказа/);
  });

  it('allows digits that are part of the company name (A1deSIGNS)', () => {
    expect(checkDraft(rules, { ...input, companyName: 'A1deSIGNS', companyDomain: 'a1designs.co.uk', body: 'Hello A1deSIGNS team, would a short outline help?' })).toEqual([]);
  });

  it('permission_request mode: no portfolio links in the first message', () => {
    expect(checkDraft(rules, { ...input, mode: 'permission_request' }).join()).toMatch(/permission_request/);
  });

  it('long subjects and bodies fail', () => {
    expect(checkDraft(rules, { ...input, subject: 'one two three four five six seven eight' }).join()).toMatch(/тема/);
    expect(checkDraft(rules, { ...input, body: 'word '.repeat(130) }).join()).toMatch(/длиннее/);
  });
});

describe('validateDeep', () => {
  const db = freshDb();
  const { companyId, verified, likely } = setup(db);
  const input = buildDeepInput(db, companyId, 16000)!;

  it('keeps grounded facts and a valid draft as they are', () => {
    const v = validateDeep(answer(verified), input, ctx());
    expect(v.retry).toBe(false);
    expect(v.eligible).toEqual([true, true]);
    expect(v.result.opportunities[0]!.observed[0]!.kind).toBe('fact');
    expect(v.outreachIssues).toEqual([]);
  });

  it('a "likely" finding can support an inference, never a fact or a "confirmed" claim', () => {
    const a = answer(verified);
    a.opportunities[1]!.observed = [{ text: 'Подтверждено: много адресов для заявок', kind: 'fact', evidence: [{ type: 'finding', ref: likely, page_url: '' }] }];
    const v = validateDeep(a, input, ctx());
    expect(v.result.opportunities[1]!.observed[0]!.kind).toBe('inference');
    expect(v.retry).toBe(true);
    expect(v.feedback).toMatch(/heuristic/);
  });

  it('an invented quote is removed and the claim downgraded to a hypothesis', () => {
    const a = answer(verified);
    a.customer_journey = [{ text: 'Отвечают за час', kind: 'fact', evidence: [{ type: 'quote', ref: 'we reply within one hour', page_url: PRICES }] }];
    const v = validateDeep(a, input, ctx());
    expect(v.result.customer_journey[0]).toMatchObject({ kind: 'hypothesis', evidence: [] });
    expect(v.feedback).toMatch(/not in the page text/);
  });

  it('a quote from another page than cited is not a fact: URL corrected to the real page, claim → inference, retry asked', () => {
    const a = answer(verified);
    // "Bespoke oak staircases" is on the home page, the model cites the prices page.
    a.customer_journey = [{ text: 'Делают лестницы на заказ', kind: 'fact', evidence: [{ type: 'quote', ref: 'Bespoke oak staircases', page_url: PRICES }] }];
    const v = validateDeep(a, input, ctx());
    expect(v.result.customer_journey[0]).toMatchObject({ kind: 'inference', evidence: [{ type: 'quote', ref: 'Bespoke oak staircases', page_url: HOME }] });
    expect(v.issues.join('\n')).toContain(`is on ${HOME}, not on the cited ${PRICES}`);
    expect(v.retry).toBe(true);
    expect(v.feedback).toContain('Cite the page the quote is on');

    // The same quote cited on its own page (trailing slash dropped) stays a fact.
    a.customer_journey = [{ text: 'Делают лестницы на заказ', kind: 'fact', evidence: [{ type: 'quote', ref: 'Bespoke oak staircases', page_url: ORIGIN }] }];
    expect(validateDeep(a, input, ctx()).result.customer_journey[0]!.kind).toBe('fact');
  });

  it('a capability the code sees as absent supports only an inference ("there is no online booking")', () => {
    const a = answer(verified);
    a.customer_journey = [{ text: 'Онлайн-брони нет', kind: 'fact', evidence: [{ type: 'capability', ref: 'online_booking', page_url: '' }] }];
    expect(validateDeep(a, input, ctx()).result.customer_journey[0]!.kind).toBe('inference');
  });

  it('"the site already has X" with X absent is contradicted: never a fact, not even an inference', () => {
    const a = answer(verified);
    a.existing_capabilities = [{ text: 'Есть онлайн-запись', kind: 'fact', evidence: [{ type: 'capability', ref: 'online_booking', page_url: '' }] }];
    const v = validateDeep(a, input, ctx());
    expect(v.result.existing_capabilities[0]).toMatchObject({ kind: 'hypothesis', evidence: [] });
    expect(v.feedback).toContain('code does not detect online_booking');
  });

  it('proposing what the site already has is not eligible; "pursue" without a grounded proposal becomes "maybe"', () => {
    const a = answer(verified);
    a.opportunities = [{ ...a.opportunities[0]!, observed: [{ text: 'Наверное, звонят', kind: 'hypothesis', evidence: [] }] }];
    const v = validateDeep(a, input, ctx());
    expect(v.eligible).toEqual([false]);
    expect(v.retry).toBe(true);
    expect(finalizeDeep(v).result.recommendation).toBe('maybe');
  });

  it('a best pick that is not grounded is replaced by the first grounded one', () => {
    const a = answer(verified);
    a.opportunities[0]!.already_exists = 'yes';
    a.best_opportunity_index = 0;
    expect(finalizeDeep(validateDeep(a, input, ctx())).result.best_opportunity_index).toBe(1);
  });

  it('extra pages only from known internal links, max 3, first pass only', () => {
    const a = answer(verified, { need_pages: [{ url: BOOKING, reason: 'booking flow' }, { url: 'https://evil.example/x', reason: 'x' }] });
    expect(validateDeep(a, input, ctx()).needPages).toEqual([BOOKING]);
    expect(validateDeep(a, input, ctx({ allowExtraPages: false })).needPages).toEqual([]);
  });
});

describe('analyzeCompany', () => {
  const deps = (db: Db, llm: LlmClient, fetcher: Fetcher = new FakeFetcher({}), cfg: Config = config) => ({
    db,
    config: cfg,
    llm,
    budget: new Budget(db, cfg),
    fetcher,
  });

  it('stores a validated deep assessment; the same input is then served from cache for free', async () => {
    const db = freshDb();
    const { companyId, verified } = setup(db);
    const llm = new FakeLlm([answer(verified)]);
    const out = await analyzeCompany(companyId, deps(db, llm));
    expect(out).toMatchObject({ status: 'analyzed', result: { recommendation: 'pursue' } });
    expect(llm.requests[0]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'medium' });
    expect(llm.requests[0]!.user).toContain('language=en, mode=offer');
    expect(db.prepare(`SELECT stage, decision FROM assessments`).all()).toEqual([{ stage: 'deep', decision: 'pursue' }]);
    expect(await analyzeCompany(companyId, deps(db, llm))).toMatchObject({ status: 'cached', cost: 0 });
    expect(llm.requests).toHaveLength(1);
  });

  it('reads requested extra pages (bounded, robots respected) and answers again with them', async () => {
    const db = freshDb();
    const { companyId, verified } = setup(db);
    const fetcher = new FakeFetcher({
      [`${ORIGIN}/robots.txt`]: [200, 'text/plain', 'User-agent: *\nAllow: /'],
      [BOOKING]: [200, 'text/html', '<h1>Book a survey</h1><p>Call us to arrange a home survey.</p>'],
    });
    const second = answer(verified);
    second.customer_journey.push({ text: 'Замер назначают по телефону', kind: 'fact', evidence: [{ type: 'quote', ref: 'Call us to arrange a home survey', page_url: BOOKING }] });
    const llm = new FakeLlm([answer(verified, { need_pages: [{ url: BOOKING, reason: 'how surveys are booked' }] }), second]);
    const out = await analyzeCompany(companyId, deps(db, llm, fetcher));
    expect(out.status).toBe('analyzed');
    if (out.status !== 'analyzed') return;
    expect(out.meta.extraPages).toEqual([BOOKING]);
    expect(out.result.customer_journey[1]!.kind).toBe('fact');
    expect(llm.requests[1]!.user).toContain('Call us to arrange a home survey');
    // Extra pages are kept as evidence without touching the latest real inspection.
    expect(db.prepare(`SELECT result_status FROM inspections WHERE mode = 'deep_pages'`).all()).toEqual([{ result_status: 'supplement' }]);
    expect(latestSuccessfulInspection(db, companyId)).not.toBeNull();
    expect(db.prepare(`SELECT mode FROM inspections WHERE id = ?`).get(latestSuccessfulInspection(db, companyId))).toEqual({ mode: 'reinspect' });
  });

  it('does not read pages disallowed by robots.txt and then skips the second pass', async () => {
    const db = freshDb();
    const { companyId, verified } = setup(db);
    const fetcher = new FakeFetcher({ [`${ORIGIN}/robots.txt`]: [200, 'text/plain', 'User-agent: *\nDisallow: /book-a-survey'] });
    const llm = new FakeLlm([answer(verified, { need_pages: [{ url: BOOKING, reason: 'x' }] })]);
    const out = await analyzeCompany(companyId, deps(db, llm, fetcher));
    expect(out.status === 'analyzed' && out.meta.skippedPages).toEqual([{ url: BOOKING, reason: 'robots.txt' }]);
    expect(fetcher.requests).not.toContain(BOOKING);
    expect(llm.requests).toHaveLength(1);
  });

  it('a draft that still breaks the copy rules after the retry is withheld (issues recorded)', async () => {
    const db = freshDb();
    const { companyId, verified } = setup(db);
    const bad = answer(verified, { outreach: { ...answer(verified).outreach, subject: 'Hi', body: 'You lose 30% of customers!' } });
    const out = await analyzeCompany(companyId, deps(db, new FakeLlm([bad, bad])));
    expect(out.status === 'analyzed' && out.meta.outreachIssues.length).toBeGreaterThan(0);
  });

  it('records failed calls and never calls the API beyond the budget', async () => {
    const db = freshDb();
    const { companyId } = setup(db);
    const refusal = new LlmError('declined', 'refusal', { inputTokens: 5000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(await analyzeCompany(companyId, deps(db, new FakeLlm([refusal])))).toMatchObject({ status: 'failed' });
    expect(db.prepare(`SELECT purpose, ok FROM llm_calls`).all()).toEqual([{ purpose: 'deep', ok: 0 }]);

    const broke: Config = { ...config, limits: { ...config.limits, max_llm_cost_usd_per_run: 0 } };
    const llm = new FakeLlm([]);
    await expect(analyzeCompany(companyId, deps(db, llm, undefined, broke))).rejects.toThrow(BudgetExceededError);
    expect(llm.requests).toHaveLength(0);
  });
});

describe('dossierMarkdown', () => {
  const meta = (over: Partial<DeepMeta> = {}): DeepMeta => ({ extraPages: [], skippedPages: [], outreachIssues: [], issues: [], eligible: [true, true], calls: 1, ...over });
  const risk = (over: Partial<RiskAssessment>): RiskAssessment => ({
    jurisdiction: 'UK',
    recipientType: 'company_likely',
    risk: 'low',
    reason: 'Компания (Ltd на сайте)',
    confidence: 'medium',
    unknowns: [],
    toVerify: [],
    ...over,
  });

  /** setup() plus contacts and risk rows: a current recipient row, a legacy one, a per-address one and a phone. */
  function withContacts(db: Db) {
    const s = setup(db);
    insertOutreachRisk(db, s.companyId, s.inspectionId, null, risk({}), RISK_RULES_VERSION);
    insertOutreachRisk(db, s.companyId, s.inspectionId, null, risk({ risk: 'review_required', reason: 'Рабочий публичный email не найден' }), LEGACY_NO_EMAIL_RULES_VERSION);
    const contact = upsertContact(db, s.companyId, { email: 'info@oakstairs.co.uk', kind: 'role', roleHint: 'info', isFreemail: false, foundOnUrl: HOME }, true);
    insertOutreachRisk(db, s.companyId, s.inspectionId, contact, risk({ reason: 'Ролевой адрес компании' }), RISK_RULES_VERSION);
    upsertContactChannel(db, s.companyId, s.inspectionId, {
      channel: 'phone',
      value: '+441131234567',
      matchKey: '+441131234567',
      uncertain: false,
      note: null,
      display: '0113 123 4567',
      sourceUrl: HOME,
    });
    return s;
  }

  it('labels every claim, resolves finding evidence and marks the draft as not sent, with the opt-out line added by code', () => {
    const db = freshDb();
    const { companyId, verified } = withContacts(db);
    const md = dossierMarkdown(db, config, companyId, answer(verified), meta(), 0.0123);
    expect(md).toContain('## Oak Stairs — oakstairs.co.uk (UK, Leeds)');
    expect(md).toContain('**Рекомендация:** 🟢 стоит предложить');
    expect(md).toContain('✅ факт: Цену узнают по email');
    expect(md).toContain('«email us your measurements»');
    expect(md).toContain('💭 гипотеза: Клиент быстрее понимает порядок цены');
    expect(md).toContain('### Лучшее предложение: Онлайн-калькулятор стоимости лестницы');
    expect(md).toContain('- **Мобильная версия сайта**');
    expect(md).toContain('ТОЛЬКО ДЛЯ ПРОСМОТРА, НЕ ОТПРАВЛЕНО');
    expect(md).toContain("I won't contact you again.\n```");
    expect(md).toContain('Вызовов API: 1 · стоимость: $0.0123');

    // A finding cited as evidence is shown with its code, status and evidence URL from the database.
    const mobileFirst = dossierMarkdown(db, config, companyId, answer(verified, { best_opportunity_index: 1 }), meta(), 0);
    expect(mobileFirst).toContain('### Лучшее предложение: Мобильная версия сайта');
    expect(mobileFirst).toContain(`✅ факт: Нет viewport — находка NO_VIEWPORT_META (verified) ${HOME}`);
  });

  it('shows contact availability and outreach risk separately; ignores legacy "no email" risk rows', () => {
    const db = freshDb();
    const { companyId, verified } = withContacts(db);
    const md = dossierMarkdown(db, config, companyId, answer(verified), meta(), 0);
    expect(md).toContain('Доступность контакта: есть email (email)');
    expect(md).toContain('- email: info@oakstairs.co.uk — источник: https://www.oakstairs.co.uk/ · риск адреса: 🟢 low');
    expect(md).toContain('+441131234567 (0113 123 4567)');
    expect(md).toContain('**Риск обращения (отдельно от доступности):** 🟢 low — Компания (Ltd на сайте)');
    expect(md).not.toContain('Рабочий публичный email не найден');
  });

  it('without any risk row the risk is "not determined", never inferred from the contacts', () => {
    const db = freshDb();
    const { companyId, verified } = setup(db);
    expect(dossierMarkdown(db, config, companyId, answer(verified), meta(), 0)).toContain('**Риск обращения (отдельно от доступности):** не определён');
  });

  it('a draft that failed the copy rules is flagged as unusable', () => {
    const db = freshDb();
    const { companyId, verified } = setup(db);
    const md = dossierMarkdown(db, config, companyId, answer(verified), meta({ outreachIssues: ['цифры в письме'] }), 0);
    expect(md).toContain('использовать его нельзя: цифры в письме');
  });

  it('model text with a code fence cannot break out of the draft block', () => {
    const db = freshDb();
    const { companyId, verified } = setup(db);
    const a = answer(verified, { outreach: { ...answer(verified).outreach, subject: 'Hi', body: 'Hello\n```\n# Injected heading\n```' } });
    const md = dossierMarkdown(db, config, companyId, a, meta(), 0);
    expect(md).toContain('````text\nSubject: Hi');
    expect(md).toMatch(/I won't contact you again\.\n````\n/);
  });

  it('writeDossiers writes one Markdown file with the summary and the review-only notice', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ch-dossier-'));
    const file = writeDossiers(dir, ['## A\n', '## B\n'], 'Компаний: 2');
    expect(path.dirname(file)).toBe(path.join(dir, 'reports'));
    expect(path.basename(file)).toMatch(/^dossiers-\d{12}\.md$/);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('Компаний: 2');
    expect(text).toContain('Ничего не отправлено');
    expect(text).toContain('## A\n\n## B');
  });
});

describe('estimateDeepRun (dry run)', () => {
  const stage = config.llm.stages.deep;
  const price = config.llm.prices[stage.model]!;

  it('works on a read-only database: shows the first input, counts tokens, worst case covers every retry', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'ch-deep-')), 'db.sqlite');
    const rw = openDb(file);
    migrate(rw);
    const { companyId } = setup(rw);
    const empty = upsertDiscovered(
      rw,
      { name: 'No Data', websiteUrl: 'https://nodata.co.uk/', city: null, sourceRef: null, query: null },
      { market: 'UK', segment: 'S3', sourceId: 'csv', termsNote: 't' },
    )!.id;
    const expectedText = buildDeepInput(rw, companyId, stage.digest_max_chars)!.text;
    rw.close();

    const db = openDb(file, { readonly: true });
    const est = estimateDeepRun(db, config, [empty, companyId]);
    expect(est.first).toEqual({ companyId, text: expectedText });
    expect(est).toMatchObject({ toAnalyze: 1, cached: 0, noData: 1 });
    expect(est.inputTokens).toBeGreaterThan(expectedText.length / 3);
    expect(est.estimateUsd).toBeGreaterThan(0);
    expect(est.worstUsd).toBeGreaterThan(est.estimateUsd);
    expect(est.worstUsd).toBeGreaterThanOrEqual((4 * est.inputTokens * price.input + 4 * stage.max_output_tokens * price.output) / 1_000_000);
    expect(() => db.prepare(`DELETE FROM companies`).run()).toThrow(/readonly/);
    db.close();
  });

  it('an input analysed before is free (cache); --force counts it again', async () => {
    const db = freshDb();
    const { companyId, verified } = setup(db);
    await analyzeCompany(companyId, { db, config, llm: new FakeLlm([answer(verified)]), budget: new Budget(db, config), fetcher: new FakeFetcher({}) });
    const calls = db.prepare('SELECT COUNT(*) AS n FROM llm_calls').get();
    expect(estimateDeepRun(db, config, [companyId])).toMatchObject({ toAnalyze: 0, cached: 1, inputTokens: 0, estimateUsd: 0, worstUsd: 0 });
    expect(estimateDeepRun(db, config, [companyId], true)).toMatchObject({ toAnalyze: 1, cached: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM llm_calls').get()).toEqual(calls);
  });
});

describe('paid requests stay inside the budget', () => {
  /** A fetch that answers every request with `status` and asks the SDK to retry; counts requests. */
  function failingFetch(status: number) {
    const calls: string[] = [];
    const fetch = (async (input: string | URL | Request) => {
      calls.push(String(input instanceof Request ? input.url : input));
      return new Response(JSON.stringify({ type: 'error', error: { type: status === 429 ? 'rate_limit_error' : 'overloaded_error', message: 'busy' } }), {
        status,
        headers: { 'content-type': 'application/json', 'x-should-retry': 'true', 'retry-after': '0' },
      });
    }) as typeof globalThis.fetch;
    return { fetch, calls };
  }
  const request = { model: 'claude-haiku-5-5', effort: 'medium' as const, maxOutputTokens: 100, system: 's', user: 'u', schema: DeepResult };

  it('the Anthropic client never retries on its own: one complete() is one HTTP request (no network, fake fetch)', async () => {
    for (const [status, code] of [[529, 'api'], [429, 'rate_limited'], [500, 'api']] as const) {
      const { fetch, calls } = failingFetch(status);
      const client = new AnthropicLlmClient({ apiKey: 'test-key', timeoutMs: 1000, fetch });
      await expect(client.complete(request)).rejects.toMatchObject({ code });
      expect(calls).toHaveLength(1);
    }
    let attempts = 0;
    const offline = (async () => {
      attempts++;
      throw new TypeError('network down');
    }) as typeof globalThis.fetch;
    await expect(new AnthropicLlmClient({ apiKey: 'test-key', timeoutMs: 1000, fetch: offline }).complete(request)).rejects.toBeInstanceOf(LlmError);
    expect(attempts).toBe(1);
  });

  it('every retry of a transient error is checked and recorded by the budget, at worst case when usage is unknown', async () => {
    const busy = () => new LlmError('overloaded', 'api');
    const db = freshDb();
    const { companyId } = setup(db);
    const llm = new FakeLlm([busy(), busy()]);
    const budget = new Budget(db, config);
    expect(await analyzeCompany(companyId, { db, config, llm, budget, fetcher: new FakeFetcher({}) })).toMatchObject({ status: 'failed' });
    const rows = db.prepare('SELECT ok, cost_usd FROM llm_calls').all() as { ok: number; cost_usd: number }[];
    expect(llm.requests).toHaveLength(2);
    expect(rows).toHaveLength(2);
    const worst = rows[0]!.cost_usd;
    expect(worst).toBeGreaterThanOrEqual((config.llm.stages.deep.max_output_tokens * config.llm.prices['claude-haiku-5-5']!.output) / 1_000_000);
    expect(rows.every((r) => r.ok === 0 && r.cost_usd === worst)).toBe(true);
    expect(budget.runSpent).toBeCloseTo(2 * worst, 10);

    // A run limit that covers one attempt but not the retry: the retry is refused before any request.
    const db2 = freshDb();
    const s2 = setup(db2);
    const tight: Config = { ...config, limits: { ...config.limits, max_llm_cost_usd_per_run: worst * 1.5 } };
    const llm2 = new FakeLlm([busy(), busy()]);
    await expect(
      analyzeCompany(s2.companyId, { db: db2, config: tight, llm: llm2, budget: new Budget(db2, tight), fetcher: new FakeFetcher({}) }),
    ).rejects.toThrow(BudgetExceededError);
    expect(llm2.requests).toHaveLength(1);
    expect(db2.prepare('SELECT COUNT(*) AS n FROM llm_calls').get()).toEqual({ n: 1 });
  });
});
