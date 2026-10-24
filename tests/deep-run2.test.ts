// Regressions from the second paid stage C run (2026-10-24): A1 Designs cut off at 8000 output
// tokens twice (the SDK threw on the broken JSON, the retry repeated the same request); Freza
// "maybe" justified only by unknown order volumes; Freza's draft rejected for "Здравствуйте!".
// Plus the email-first contact view. No network, no LLM.
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { Config } from '../src/config/load.js';
import { insertOutreachRisk, latestSuccessfulInspection, upsertContact } from '../src/db/repo.js';
import type { Fetcher, FetchResult } from '../src/inspect/fetcher.js';
import { initialSettings, nextSettings, TRUNCATION_FEEDBACK } from '../src/llm/attempt.js';
import { Budget, BudgetExceededError } from '../src/llm/budget.js';
import { AnthropicLlmClient, LlmError, type LlmClient, type LlmRequest, type LlmResponse } from '../src/llm/client.js';
import { analyzeCompany, estimateDeepRun } from '../src/llm/deep.js';
import { finalizeDeep, recommendationConsistency, validateDeep } from '../src/llm/deepValidate.js';
import { DeepResult } from '../src/llm/schemas.js';
import { screenCompany } from '../src/llm/screen.js';
import { checkDraft, normalizeGreeting } from '../src/outreach/copyCheck.js';
import { RISK_RULES_VERSION } from '../src/outreach/risk.js';
import { emailContactLine, emailContactOf } from '../src/reports/candidates.js';
import { dossierMarkdown } from '../src/reports/dossier.js';
import { a1Answer, a1Site, config, ctx, fact, finding, freshDb, inspected, jnhSite, type Site } from './fixtures/deep-sites.js';

const usage = (outputTokens: number) => ({ inputTokens: 9576, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
const truncated = () => new LlmError('Output truncated at max_tokens (8000)', 'truncated', usage(8000));

class FakeLlm implements LlmClient {
  readonly requests: LlmRequest<z.ZodType>[] = [];
  constructor(private readonly answers: (unknown | LlmError)[]) {}
  async complete<S extends z.ZodType>(req: LlmRequest<S>): Promise<LlmResponse<z.infer<S>>> {
    this.requests.push(req);
    const next = this.answers.shift();
    if (next === undefined) throw new Error('FakeLlm: no more answers');
    if (next instanceof LlmError) throw next;
    return { data: structuredClone(next) as z.infer<S>, usage: usage(5000), model: req.model };
  }
}

const noFetch: Fetcher = {
  async fetch(url: string): Promise<FetchResult> {
    return { requestedUrl: url, finalUrl: url, status: 404, contentType: 'text/html', body: '', truncated: false };
  },
};

describe('truncated answers (A1 Designs: two identical requests cut off at 8000 tokens)', () => {
  /** A fetch that answers like the Messages API with the given stop reason and text. */
  const apiFetch = (stop_reason: string, text: string) =>
    (async () =>
      new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-5-5',
          content: [{ type: 'text', text }],
          stop_reason,
          stop_sequence: null,
          usage: { input_tokens: 9576, output_tokens: 8000, cache_creation_input_tokens: null, cache_read_input_tokens: null },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof globalThis.fetch;
  const request = { model: 'claude-haiku-5-5', effort: 'medium' as const, maxOutputTokens: 8000, system: 's', user: 'u', schema: DeepResult };

  it('the client reports a cut-off answer as "truncated" with its real usage, not as invalid output at worst-case cost', async () => {
    const client = new AnthropicLlmClient({ apiKey: 'test-key', timeoutMs: 1000, fetch: apiFetch('max_tokens', '{"business_summary":"Лондонская мастерская') });
    const err = await client.complete(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ code: 'truncated', usage: { inputTokens: 9576, outputTokens: 8000 } });
  });

  it('a complete but malformed answer is "invalid_output", also with its usage', async () => {
    const client = new AnthropicLlmClient({ apiKey: 'test-key', timeoutMs: 1000, fetch: apiFetch('end_turn', '{"business_summary": 1}') });
    await expect(client.complete(request)).rejects.toMatchObject({ code: 'invalid_output', usage: { outputTokens: 8000 } });
  });

  it('a valid answer is parsed by the schema', async () => {
    const client = new AnthropicLlmClient({ apiKey: 'test-key', timeoutMs: 1000, fetch: apiFetch('end_turn', JSON.stringify(a1Answer())) });
    const res = await client.complete(request);
    expect(res.data.recommendation).toBe('pursue');
    expect(res.usage.outputTokens).toBe(8000);
  });

  it('settings after a truncation: once, never identical; without on_truncation no retry at all', () => {
    const stage = config.llm.stages.deep;
    const first = initialSettings(stage);
    expect(first).toEqual({ effort: 'medium', maxOutputTokens: 8000, afterTruncation: false });
    const second = nextSettings(stage, first, truncated());
    expect(second).toEqual({ effort: 'low', maxOutputTokens: 12000, afterTruncation: true });
    expect(nextSettings(stage, second!, truncated())).toBeNull();
    expect(nextSettings({ ...stage, on_truncation: undefined }, first, truncated())).toBeNull();
    // Transient errors keep the settings; non-retryable ones stop.
    expect(nextSettings(stage, first, new LlmError('busy', 'api'))).toBe(first);
    expect(nextSettings(stage, first, new LlmError('no', 'bad_request'))).toBeNull();
  });

  it('A1 reproduction: cut off twice → one recovery attempt (low effort, 12000, asked to be brief), then failed; both billed at real usage', async () => {
    const db = freshDb();
    const { companyId } = inspected(db, a1Site);
    const llm = new FakeLlm([truncated(), new LlmError('Output truncated at max_tokens (12000)', 'truncated', usage(12000))]);
    const out = await analyzeCompany(companyId, { db, config, llm, budget: new Budget(db, config), fetcher: noFetch });
    expect(out).toMatchObject({ status: 'failed' });
    expect(llm.requests.map((r) => [r.effort, r.maxOutputTokens])).toEqual([
      ['medium', 8000],
      ['low', 12000],
    ]);
    expect(llm.requests[1]!.user).toContain(TRUNCATION_FEEDBACK);
    const rows = db.prepare("SELECT output_tokens, error FROM llm_calls WHERE purpose = 'deep' ORDER BY created_at").all() as { output_tokens: number; error: string }[];
    expect(rows.map((r) => r.output_tokens)).toEqual([8000, 12000]);
    expect(rows.every((r) => r.error.startsWith('truncated:') && !r.error.includes('worst case'))).toBe(true);
  });

  it('cut off once, then a valid brief answer: the dossier is produced and the recovery is recorded', async () => {
    const db = freshDb();
    const { companyId } = inspected(db, a1Site);
    const llm = new FakeLlm([truncated(), a1Answer()]);
    const out = await analyzeCompany(companyId, { db, config, llm, budget: new Budget(db, config), fetcher: noFetch });
    expect(out.status).toBe('analyzed');
    if (out.status !== 'analyzed') return;
    expect(out.meta.truncationRetries).toBe(1);
    expect(out.meta.calls).toBe(2);
  });

  it('the recovery attempt is budgeted at its own higher limit: refused before any request if it would break the run cap', async () => {
    const db = freshDb();
    const { companyId } = inspected(db, a1Site);
    const p = config.llm.prices[config.llm.stages.deep.model]!;
    // Room for exactly the first attempt's worst case (the budget's own input estimate, 8000 out);
    // after its real cost is spent, the 12000-token recovery's worst case no longer fits.
    const firstWorst = (estimateDeepRun(db, config, [companyId]).inputTokens * p.input + 8000 * p.output) / 1e6;
    const tight: Config = { ...config, limits: { ...config.limits, max_llm_cost_usd_per_run: firstWorst + 0.0001 } };
    const llm = new FakeLlm([truncated(), a1Answer()]);
    await expect(analyzeCompany(companyId, { db, config: tight, llm, budget: new Budget(db, tight), fetcher: noFetch })).rejects.toThrow(BudgetExceededError);
    expect(llm.requests).toHaveLength(1);
  });

  it('stage B screening no longer repeats a cut-off request identically either', async () => {
    const db = freshDb();
    const { companyId } = inspected(db, a1Site);
    const llm = new FakeLlm([new LlmError('Output truncated', 'truncated', usage(3000)), new LlmError('Output truncated', 'truncated', usage(5000))]);
    const out = await screenCompany(companyId, { db, config, llm, budget: new Budget(db, config) });
    expect(out.status).toBe('failed');
    expect(llm.requests.map((r) => [r.effort, r.maxOutputTokens])).toEqual([
      ['low', 3000],
      ['low', 5000],
    ]);
    expect(llm.requests[1]!.user).toContain(TRUNCATION_FEEDBACK);
  });
});

// ---- Freza: verified facts behind a concrete proposal, "maybe" because volumes are unknown ----
const FREZA = 'https://freza.ru/';
const FREZA_CAT = `${FREZA}katalogi/`;
const frezaSite: Site = {
  name: 'freza',
  home: FREZA,
  market: 'UK', // market only drives language/mode here; RU outreach risk is not under test
  platform: 'custom',
  pages: [
    [
      FREZA_CAT,
      'catalog',
      '<p>Соберите список с артикулами и количеством;</p><p>Наши специалисты вышлют коммерческое предложение в течение 2 суток и уточнят сроки поставки.</p>',
    ],
  ],
  findings: [{ code: 'PDF_CATALOG', status: 'verified', evidenceUrl: FREZA_CAT }],
};

function frezaAnswer(pdfFinding: string, over: Partial<DeepResult> = {}): DeepResult {
  const a = a1Answer();
  return {
    ...a,
    customer_journey: [],
    existing_capabilities: [],
    opportunities: [
      {
        ...a.opportunities[0]!,
        title: 'Заявка на позиции под заказ прямо с сайта вместо письма на почту',
        observed: [
          fact('Для предзаказа клиент собирает список артикулов и отправляет его на почту', [
            { type: 'quote', ref: 'Соберите список с артикулами и количеством;', page_url: FREZA_CAT },
          ]),
          fact('Каталоги опубликованы как PDF', [finding(pdfFinding)]),
        ],
        already_exists: 'partially',
      },
    ],
    // As returned in the second run.
    recommendation: 'maybe',
    recommendation_reason: 'Есть факт о предзаказе письмом, но сайт не показывает, сколько таких заявок приходит. Нужна проверка объёма.',
    recommendation_blockers: ['unknown_internal_metrics'],
    outreach: {
      language: 'en',
      subject: 'Ordering catalogue items on your site',
      body: 'Hello, your catalogue page asks customers to collect item codes and quantities and send them by email. A simple request list on the site could let them send this directly. Would a short outline be useful?',
      opportunity_index: 0,
      observation_index: 0,
      framing: 'observation',
    },
    ...over,
  };
}

describe('recommendation consistency (Freza: "maybe" only because order volumes are unknown)', () => {
  const c = ctx('freza.ru', 'freza');

  it('Freza reproduction: the model is asked to correct it; code does not upgrade, and flags it if it stays', () => {
    const db = freshDb();
    const { input, findings } = inspected(db, frezaSite);
    const v = validateDeep(frezaAnswer(findings[0]!), input, c);
    expect(v.retry).toBe(true);
    expect(v.feedback).toContain('never justify "maybe" on their own');
    const final = finalizeDeep(v);
    expect(final.result.recommendation).toBe('maybe');
    expect(final.recommendationIssues).toEqual(['«возможно» без настоящей причины: обосновано только неизвестными внутренними показателями']);
  });

  it('pursue: the corrected answer (no blockers, metrics as open questions) passes untouched', () => {
    const db = freshDb();
    const { input, findings } = inspected(db, frezaSite);
    const v = validateDeep(frezaAnswer(findings[0]!, { recommendation: 'pursue', recommendation_blockers: [] }), input, c);
    expect(recommendationConsistency(v.result, v.eligible)).toEqual([]);
    const final = finalizeDeep(v);
    expect(final.result.recommendation).toBe('pursue');
    expect(final.recommendationIssues).toEqual([]);
  });

  it('maybe with a real blocker is legitimate uncertainty and stays as it is', () => {
    const db = freshDb();
    const { input, findings } = inspected(db, frezaSite);
    const v = validateDeep(
      frezaAnswer(findings[0]!, {
        recommendation_reason: 'Неясно, важны ли предзаказы для этого магазина: на сайте они упомянуты один раз.',
        recommendation_blockers: ['relevance_unclear', 'unknown_internal_metrics'],
      }),
      input,
      c,
    );
    expect(recommendationConsistency(v.result, v.eligible)).toEqual([]);
    expect(finalizeDeep(v).result.recommendation).toBe('maybe');
  });

  it('a blocker the evidence contradicts is flagged ("no fact" while the best proposal has two)', () => {
    const db = freshDb();
    const { input, findings } = inspected(db, frezaSite);
    const v = validateDeep(frezaAnswer(findings[0]!, { recommendation_blockers: ['best_has_no_fact'] }), input, c);
    expect(v.feedback).toContain('best_has_no_fact is wrong');
  });

  it('pursue that lists real blockers is inconsistent', () => {
    const db = freshDb();
    const { input, findings } = inspected(db, frezaSite);
    const v = validateDeep(frezaAnswer(findings[0]!, { recommendation: 'pursue', recommendation_blockers: ['problem_not_shown'] }), input, c);
    expect(v.feedback).toContain('recommendation is "pursue" but recommendation_blockers lists problem_not_shown');
  });

  it('drop needs a reason that justifies it; with one it stays "drop"', () => {
    const db = freshDb();
    const { input, findings } = inspected(db, frezaSite);
    const bare = validateDeep(frezaAnswer(findings[0]!, { recommendation: 'drop', recommendation_blockers: [] }), input, c);
    expect(bare.feedback).toContain('"drop" needs nothing_grounded, already_exists, not_a_fit or relevance_unclear');
    const agency = validateDeep(frezaAnswer(findings[0]!, { recommendation: 'drop', recommendation_blockers: ['not_a_fit'] }), input, c);
    expect(recommendationConsistency(agency.result, agency.eligible)).toEqual([]);
    expect(finalizeDeep(agency).result.recommendation).toBe('drop');
  });

  it('a flagged recommendation is shown to the human in the dossier', () => {
    const db = freshDb();
    const { companyId, input, findings } = inspected(db, frezaSite);
    const final = finalizeDeep(validateDeep(frezaAnswer(findings[0]!), input, c));
    const md = dossierMarkdown(
      db,
      config,
      companyId,
      final.result,
      { extraPages: [], skippedPages: [], outreachIssues: final.outreachIssues, issues: final.issues, eligible: final.eligible, calls: 2, recommendationIssues: final.recommendationIssues },
      0,
    );
    expect(md).toContain('⚠ Рекомендация противоречит критериям (код её не менял, решает человек)');
  });
});

describe('greeting punctuation fixed locally (Freza: "Здравствуйте!" rejected twice)', () => {
  const FREZA_BODY =
    'Здравствуйте! Я веб-разработчик и просматривал сайт freza.ru. Заметил, что для заказа позиций из каталогов нужно собрать список артикулов и количества и отправить его на электронную почту. Могло бы быть удобнее оформлять такие заявки прямо на сайте. Хотели бы вы получить короткое описание того, как это можно было бы улучшить?';

  it('only the "!" right after the greeting changes; every other character stays', () => {
    const fixed = normalizeGreeting(FREZA_BODY, 'ru');
    expect(fixed).toBe(FREZA_BODY.replace('Здравствуйте!', 'Здравствуйте.'));
    expect(normalizeGreeting('Hello Oak Stairs team! Your prices page', 'en')).toBe('Hello Oak Stairs team. Your prices page');
    expect(normalizeGreeting('Hello!\n\nYour prices page', 'en')).toBe('Hello,\n\nYour prices page');
    expect(normalizeGreeting('Добрый день! Заметил', 'ru')).toBe('Добрый день. Заметил');
    // Not a greeting, or "!" elsewhere: untouched, so the copy rules still reject it.
    expect(normalizeGreeting('Great news! Your site', 'en')).toBe('Great news! Your site');
    const elsewhere = 'Здравствуйте. Это сильно поможет вашим продажам!';
    expect(normalizeGreeting(elsewhere, 'ru')).toBe(elsewhere);
    expect(checkDraft(config.copyRules, { subject: 'Тема', body: elsewhere, language: 'ru', expectedLanguage: 'ru', mode: 'permission_request', companyDomain: 'freza.ru' }))
      .toContain('восклицательные знаки недопустимы');
  });

  it('Freza reproduction: the draft passes without a paid retry; grounding is still checked', () => {
    const db = freshDb();
    const { input, findings } = inspected(db, frezaSite);
    const a = frezaAnswer(findings[0]!, { recommendation: 'pursue', recommendation_blockers: [] });
    a.outreach = { ...a.outreach, language: 'ru', subject: 'Заказ позиций из каталогов на сайте', body: FREZA_BODY };
    const v = validateDeep(a, input, ctx('freza.ru', 'freza', { expectedLanguage: 'ru', mode: 'permission_request' }));
    expect(v.result.outreach.body.startsWith('Здравствуйте. Я веб-разработчик')).toBe(true);
    expect(v.retry).toBe(false);
    expect(v.issues).toContain('draft: "!" after the greeting replaced (formatting only)');
    expect(finalizeDeep(v).outreachIssues).toEqual([]);

    // Normalisation never rescues an ungrounded draft.
    const shaky = structuredClone(a);
    shaky.opportunities[0]!.observed.push({ text: 'Клиенты, вероятно, теряются', kind: 'hypothesis', evidence: [] });
    shaky.outreach.observation_index = 2;
    expect(finalizeDeep(validateDeep(shaky, input, ctx('freza.ru', 'freza', { expectedLanguage: 'ru', mode: 'permission_request' }))).outreachIssues.join('\n')).toContain(
      'непроверенное предположение',
    );
  });
});

describe('email-first contact view', () => {
  it('a public email (company domain or public mailbox) is the primary channel; without one, manual discovery', () => {
    expect(emailContactOf(1)).toBe('available');
    expect(emailContactOf(0)).toBe('manual_discovery');
    expect(emailContactLine({ currentEmails: 2, unconfirmedEmails: 0, protectedOn: [], hasForm: true })).toBe('**Email:** есть — основной канал (адресов: 2)');
    expect(emailContactLine({ currentEmails: 0, unconfirmedEmails: 0, protectedOn: [], hasForm: false })).toBe('**Email:** не найден — нужен ручной поиск контакта');
    expect(emailContactLine({ currentEmails: 0, unconfirmedEmails: 1, protectedOn: [], hasForm: true })).toBe(
      '**Email:** не найден — нужен ручной поиск контакта: есть адрес из прошлой проверки, его страница не перепроверялась — проверить вручную; запасной канал — форма на сайте (заполняет только человек)',
    );
  });

  it('JNH: an address hidden by anti-harvesting protection is pointed out for manual lookup, never decoded', () => {
    const db = freshDb();
    const { companyId } = inspected(db, jnhSite);
    const md = dossierMarkdown(db, config, companyId, a1Answer(), { extraPages: [], skippedPages: [], outreachIssues: [], issues: [], eligible: [true], calls: 1 }, 0);
    expect(md).toContain('**Email:** не найден — нужен ручной поиск контакта: адрес на https://jnhlogistics.com/ скрыт защитой от сбора');
    expect(md).not.toMatch(/@jnhlogistics/);
  });

  it('with a public mailbox the dossier shows email first, with its source and its own risk, separate from the recipient risk', () => {
    const db = freshDb();
    const { companyId } = inspected(db, a1Site);
    const ins = latestSuccessfulInspection(db, companyId)!;
    const id = upsertContact(db, companyId, { email: 'a1designs@gmail.com', kind: 'named', roleHint: 'named', isFreemail: true, foundOnUrl: `${a1Site.home}contact/` }, true);
    const risk = { jurisdiction: 'UK', recipientType: 'company_likely' as const, confidence: 'medium' as const, unknowns: [], toVerify: [] };
    insertOutreachRisk(db, companyId, ins, null, { ...risk, risk: 'low', reason: 'Компания' }, RISK_RULES_VERSION);
    insertOutreachRisk(db, companyId, ins, id, { ...risk, risk: 'review_required', reason: 'Публичная почта' }, RISK_RULES_VERSION);
    const md = dossierMarkdown(db, config, companyId, a1Answer(), { extraPages: [], skippedPages: [], outreachIssues: [], issues: [], eligible: [true], calls: 1 }, 0);
    const contacts = md.slice(md.indexOf('### Контакты'));
    expect(contacts.indexOf('**Email:** есть — основной канал (адресов: 1)')).toBeLessThan(contacts.indexOf('- email: a1designs@gmail.com (публичная почта)'));
    expect(contacts).toContain(`источник: ${a1Site.home}contact/ · риск адреса: 🟡 review_required`);
    expect(contacts).toContain('**Риск обращения (отдельно от доступности):** 🟢 low — Компания');
  });
});
