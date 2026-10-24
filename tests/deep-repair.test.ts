// Regressions from the A1 Designs check run (2026-10-25): the analysis was valid, only the draft's
// subject had 8 words instead of 7 — the whole dossier was regenerated for it, and that retry was
// cut off. Now a draft-only problem gets ONE small draft-repair request; the dossier is kept
// whatever happens to it. No network, no LLM.
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { Config } from '../src/config/load.js';
import type { Db } from '../src/db/connection.js';
import type { Fetcher, FetchResult } from '../src/inspect/fetcher.js';
import { Budget, BudgetExceededError } from '../src/llm/budget.js';
import { LlmError, type LlmClient, type LlmRequest, type LlmResponse } from '../src/llm/client.js';
import { analyzeCompany, estimateDeepRun } from '../src/llm/deep.js';
import { validateDeep } from '../src/llm/deepValidate.js';
import { DRAFT_PROMPT, draftRepairInput } from '../src/llm/draftRepair.js';
import { DraftRepair, type DeepResult } from '../src/llm/schemas.js';
import { dossierMarkdown } from '../src/reports/dossier.js';
import { a1Answer, a1Site, config, ctx, freshDb, inspected } from './fixtures/deep-sites.js';

const usage = (outputTokens: number) => ({ inputTokens: 9000, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });

class FakeLlm implements LlmClient {
  readonly requests: LlmRequest<z.ZodType>[] = [];
  constructor(private readonly answers: (unknown | LlmError)[]) {}
  async complete<S extends z.ZodType>(req: LlmRequest<S>): Promise<LlmResponse<z.infer<S>>> {
    this.requests.push(req);
    const next = this.answers.shift();
    if (next === undefined) throw new Error('FakeLlm: no more answers');
    if (next instanceof LlmError) throw next;
    return { data: structuredClone(next) as z.infer<S>, usage: usage((req.schema as unknown) === DraftRepair ? 600 : 5000), model: req.model };
  }
}

const noFetch: Fetcher = {
  async fetch(url: string): Promise<FetchResult> {
    return { requestedUrl: url, finalUrl: url, status: 404, contentType: 'text/html', body: '', truncated: false };
  },
};

/** As returned in the check run: a valid analysis whose subject has eight words. */
const LONG_SUBJECT = 'A quick note on your custom sign enquiries';
function a1LongSubject(over: Partial<DeepResult> = {}): DeepResult {
  const a = a1Answer(over);
  return { ...a, outreach: { ...a.outreach, subject: LONG_SUBJECT } };
}
const repairedDraft = (): DraftRepair => ({ outreach: { ...a1Answer().outreach, subject: 'Custom neon wording quotes' } });

const run = (db: Db, companyId: string, llm: LlmClient, cfg: Config = config, budget = new Budget(db, cfg)) =>
  analyzeCompany(companyId, { db, config: cfg, llm, budget, fetcher: noFetch });

const purposes = (db: Db) => (db.prepare('SELECT purpose FROM llm_calls ORDER BY created_at, rowid').all() as { purpose: string }[]).map((r) => r.purpose);

describe('draft repair instead of a full regeneration (A1: eight-word subject)', () => {
  it('a draft-only problem does not trigger a full retry', () => {
    const db = freshDb();
    const { input } = inspected(db, a1Site);
    const v = validateDeep(a1LongSubject(), input, ctx('a1designs.co.uk', 'A1deSIGNS'));
    expect(v.retry).toBe(false);
    expect(v.draftFeedback.join(' ')).toContain('тема длиннее 7 слов');
  });

  it('A1 reproduction: one analysis call + one small repair call; the analysis is kept, the repaired draft is checked and used', async () => {
    const db = freshDb();
    const { companyId } = inspected(db, a1Site);
    const llm = new FakeLlm([a1LongSubject(), repairedDraft()]);
    const out = await run(db, companyId, llm);
    expect(out.status).toBe('analyzed');
    if (out.status !== 'analyzed') return;
    // No second full analysis: the second request is the draft repair, small and cheap.
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]).toMatchObject({ schema: DraftRepair, system: DRAFT_PROMPT, effort: 'low', maxOutputTokens: config.llm.stages.deep.draft_repair!.max_output_tokens });
    expect(llm.requests[1]!.user).toContain('тема длиннее 7 слов');
    expect(out.result.outreach.subject).toBe('Custom neon wording quotes');
    expect(out.result.business_summary).toBe(a1Answer().business_summary); // analysis untouched
    expect(out.meta).toMatchObject({ outreachIssues: [], draftRepair: 'repaired', analysisCalls: 1, repairCalls: 1, calls: 2 });
    expect(purposes(db)).toEqual(['deep', 'deep_draft']);
    expect(db.prepare("SELECT decision FROM assessments WHERE stage = 'deep'").all()).toEqual([{ decision: 'pursue' }]);
  });

  it('the repair request carries only evidence-checked statements, never the website text', () => {
    const db = freshDb();
    const { input } = inspected(db, a1Site);
    const v = validateDeep(a1LongSubject(), input, ctx('a1designs.co.uk', 'A1deSIGNS'));
    const user = draftRepairInput(v.result, ctx('a1designs.co.uk', 'A1deSIGNS'), v.draftFeedback);
    expect(user).toContain('- [1] fact: Сайт прямо указывает');
    expect(user).toContain('- [0] inference:');
    expect(user).not.toContain('London Based Sign Maker'); // page text not in any checked quote
    expect(user).not.toContain('<website_content>');
  });

  it('a repaired draft that still fails is not used: the dossier is stored with the draft marked unusable', async () => {
    const db = freshDb();
    const { companyId } = inspected(db, a1Site);
    const stillLong: DraftRepair = { outreach: { ...a1Answer().outreach, subject: 'Another long subject line about your custom signs' } };
    const out = await run(db, companyId, new FakeLlm([a1LongSubject(), stillLong]));
    expect(out.status).toBe('analyzed');
    if (out.status !== 'analyzed') return;
    expect(out.meta.draftRepair).toBe('failed');
    expect(out.result.outreach.subject).toBe(LONG_SUBJECT); // the original draft stays, flagged
    expect(out.meta.outreachIssues.join('\n')).toContain('тема длиннее 7 слов');
    expect(out.meta.outreachIssues.join('\n')).toContain('исправленный черновик тоже не прошёл проверку');
    expect(db.prepare("SELECT COUNT(*) AS n FROM assessments WHERE stage = 'deep'").get()).toEqual({ n: 1 });
  });

  it('a repaired draft that rests on an inference stated as seen is rejected by the same grounding check', async () => {
    const db = freshDb();
    const { companyId } = inspected(db, a1Site);
    const onInference: DraftRepair = { outreach: { ...repairedDraft().outreach, observation_index: 0, framing: 'observation' } };
    const out = await run(db, companyId, new FakeLlm([a1LongSubject(), onInference]));
    expect(out.status === 'analyzed' && out.meta.outreachIssues.join('\n')).toContain('только выводом');
  });

  it('a failed repair request (cut off) is not retried and does not lose the dossier', async () => {
    const db = freshDb();
    const { companyId } = inspected(db, a1Site);
    const llm = new FakeLlm([a1LongSubject(), new LlmError('Output truncated at max_tokens (2000)', 'truncated', usage(2000))]);
    const out = await run(db, companyId, llm);
    expect(out.status).toBe('analyzed');
    expect(llm.requests).toHaveLength(2);
    expect(out.status === 'analyzed' && out.meta.outreachIssues.join('\n')).toContain('запрос на ремонт черновика не удался (truncated)');
    expect(purposes(db)).toEqual(['deep', 'deep_draft']);
  });

  it('when the budget does not allow the repair, it is skipped — no request, no exception, dossier stored', async () => {
    const db = freshDb();
    const { companyId } = inspected(db, a1Site);
    class OneCallBudget extends Budget {
      private n = 0;
      override assertCanSpend(worst: number): void {
        if (++this.n > 1) throw new BudgetExceededError('cap reached');
        super.assertCanSpend(worst);
      }
    }
    const llm = new FakeLlm([a1LongSubject()]);
    const out = await run(db, companyId, llm, config, new OneCallBudget(db, config));
    expect(out.status).toBe('analyzed');
    expect(llm.requests).toHaveLength(1);
    expect(out.status === 'analyzed' && out.meta).toMatchObject({ draftRepair: 'skipped', repairCalls: 0 });
    expect(out.status === 'analyzed' && out.meta.outreachIssues.join('\n')).toContain('бюджет не позволил ремонт черновика');
  });

  it('analysis and draft problems together: one full retry (fixing both); the repair runs only if the draft still fails', async () => {
    const db = freshDb();
    const { companyId } = inspected(db, a1Site);
    const badQuote = a1LongSubject();
    badQuote.customer_journey = [{ text: 'Отвечают за час', kind: 'fact', evidence: [{ type: 'quote', ref: 'we reply within one hour', page_url: a1Site.home }] }];
    const llm = new FakeLlm([badQuote, a1LongSubject(), repairedDraft()]);
    const out = await run(db, companyId, llm);
    expect(llm.requests.map((r) => (r.schema === DraftRepair ? 'repair' : 'analysis'))).toEqual(['analysis', 'analysis', 'repair']);
    expect(llm.requests[1]!.user).toContain('тема длиннее 7 слов'); // the full retry was told about the draft too
    expect(out.status === 'analyzed' && out.meta).toMatchObject({ analysisCalls: 2, repairCalls: 1, draftRepair: 'repaired' });
  });

  it('a "drop" never pays for a draft repair', async () => {
    const db = freshDb();
    const { companyId } = inspected(db, a1Site);
    const llm = new FakeLlm([a1LongSubject({ recommendation: 'drop', recommendation_blockers: ['not_a_fit'] })]);
    const out = await run(db, companyId, llm);
    expect(llm.requests).toHaveLength(1);
    expect(out.status === 'analyzed' && out.meta.draftRepair).toBe('not_needed');
  });

  it('a model-written opt-out line is removed locally, without any paid request', async () => {
    const db = freshDb();
    const { companyId } = inspected(db, a1Site);
    const a = a1Answer();
    a.outreach.body = `${a.outreach.body}\n\nIf this isn't relevant, just reply "no" and I won't contact you again.`;
    const llm = new FakeLlm([a]);
    const out = await run(db, companyId, llm);
    expect(llm.requests).toHaveLength(1);
    expect(out.status === 'analyzed' && out.meta).toMatchObject({ outreachIssues: [], draftRepair: 'not_needed' });
    expect(out.status === 'analyzed' && out.result.outreach.body).not.toContain("won't contact you again");
  });
});

describe('cost reporting for analysis vs draft repair', () => {
  it('the budget, the meta and the dossier keep analysis and repair costs apart', async () => {
    const db = freshDb();
    const { companyId } = inspected(db, a1Site);
    const budget = new Budget(db, config);
    const out = await run(db, companyId, new FakeLlm([a1LongSubject(), repairedDraft()]), config, budget);
    expect(budget.runFor('deep').calls).toBe(1);
    expect(budget.runFor('deep_draft').calls).toBe(1);
    expect(budget.runFor('deep_draft').cost).toBeLessThan(budget.runFor('deep').cost);
    expect(budget.runFor('deep').cost + budget.runFor('deep_draft').cost).toBeCloseTo(budget.runSpent, 12);
    if (out.status !== 'analyzed') throw new Error('expected analyzed');
    expect(out.meta.analysisCost! + out.meta.repairCost!).toBeCloseTo(out.cost, 12);
    const md = dossierMarkdown(db, config, companyId, out.result, out.meta, out.cost);
    expect(md).toContain('(анализ: 1 · $');
    expect(md).toContain('ремонт черновика: 1 · $');
    expect(md).toContain('черновик исправлен');
    expect(md).toContain('Черновик исправлен отдельным небольшим запросом (анализ не перегенерировался)');
  });

  it('the dry-run worst case includes one draft repair per company; without draft_repair it is zero', () => {
    const db = freshDb();
    const { companyId } = inspected(db, a1Site);
    const est = estimateDeepRun(db, config, [companyId]);
    expect(est.repairWorstUsd).toBeGreaterThan(0);
    const p = config.llm.prices[config.llm.stages.deep.model]!;
    expect(est.repairWorstUsd).toBeGreaterThanOrEqual((config.llm.stages.deep.draft_repair!.max_output_tokens * p.output) / 1e6);
    const noRepair: Config = { ...config, llm: { ...config.llm, stages: { ...config.llm.stages, deep: { ...config.llm.stages.deep, draft_repair: undefined } } } };
    const est0 = estimateDeepRun(db, noRepair, [companyId]);
    expect(est0.repairWorstUsd).toBe(0);
    expect(est.worstUsd - est0.worstUsd).toBeCloseTo(est.repairWorstUsd, 12);
  });

  it('the repair prompt uses the same draft rules as the analysis prompt, and nothing about the analysis', () => {
    expect(DRAFT_PROMPT).toContain('## Outreach draft');
    expect(DRAFT_PROMPT).toContain('`framing`');
    expect(DRAFT_PROMPT).not.toContain('## Label every claim');
    expect(DRAFT_PROMPT).not.toContain('{{OUTREACH_RULES}}');
  });
});

describe('token efficiency (A1 near the output limit)', () => {
  it('the base output limit leaves headroom above what A1 used, and truncation recovery stays a larger fallback', () => {
    const stage = config.llm.stages.deep;
    expect(stage.max_output_tokens).toBeGreaterThanOrEqual(10000); // A1 used 7249-8000+ in five attempts
    expect(stage.on_truncation!.max_output_tokens).toBeGreaterThan(stage.max_output_tokens);
    expect(stage.draft_repair!.max_output_tokens).toBeLessThan(stage.max_output_tokens / 4);
  });
});
