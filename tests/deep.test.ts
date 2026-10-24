import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { loadConfig, type Config } from '../src/config/load.js';
import { openDb, type Db } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import {
  finishInspection,
  insertObservation,
  insertPage,
  latestSuccessfulInspection,
  startInspection,
  updateCompany,
  upsertDiscovered,
} from '../src/db/repo.js';
import { detectCapabilities } from '../src/inspect/capabilities.js';
import type { Fetcher, FetchOptions, FetchResult } from '../src/inspect/fetcher.js';
import { internalLinks } from '../src/inspect/extract.js';
import { buildPageContext } from '../src/inspect/page.js';
import type { PageKind } from '../src/inspect/types.js';
import { Budget, BudgetExceededError } from '../src/llm/budget.js';
import { LlmError, type LlmClient, type LlmRequest, type LlmResponse } from '../src/llm/client.js';
import { analyzeCompany } from '../src/llm/deep.js';
import { buildDeepInput } from '../src/llm/deepInput.js';
import { finalizeDeep, validateDeep, type DeepContext } from '../src/llm/deepValidate.js';
import type { DeepResult } from '../src/llm/schemas.js';
import { checkDraft, withOptOut } from '../src/outreach/copyCheck.js';

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
    unknowns: ['Сколько заявок приходит'],
    outreach: {
      language: 'en',
      subject: 'Prices on your website',
      body: 'Hello Oak Stairs team,\n\nYour prices page asks customers to email their measurements for a price. A simple form that gives a rough estimate could help customers before they get in touch.\n\nI build tools like this (https://cryptovigil.net). Would a short outline be useful?',
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

  it('a capability the code sees as absent supports only an inference', () => {
    const a = answer(verified);
    a.existing_capabilities = [{ text: 'Онлайн-брони нет', kind: 'fact', evidence: [{ type: 'capability', ref: 'online_booking', page_url: '' }] }];
    expect(validateDeep(a, input, ctx()).result.existing_capabilities[0]!.kind).toBe('inference');
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
    const bad = answer(verified, { outreach: { language: 'en', subject: 'Hi', body: 'You lose 30% of customers!' } });
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
