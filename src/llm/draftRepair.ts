// Stage C draft repair: when the analysis is valid but only its outreach draft fails the checks,
// ONE small request regenerates just the draft (subject, body, basis) from the evidence-checked
// statements — instead of regenerating the whole dossier. The repaired draft goes through the same
// copy-rule and grounding checks; if it still fails, the dossier is kept and the draft marked unusable.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config/load.js';
import { BudgetExceededError, estimateInputTokens, type Budget } from './budget.js';
import { LlmError, type LlmClient, type LlmUsage } from './client.js';
import { checkOutreach, type DraftContext } from './deepValidate.js';
import { DraftRepair, type DeepResult, type StatementT } from './schemas.js';

const read = (name: string) => readFileSync(fileURLToPath(new URL(`./prompts/${name}`, import.meta.url)), 'utf8');

/** The "Outreach draft" section of the stage C prompt: one source for the draft rules. */
function outreachRules(deepPrompt: string): string {
  const start = deepPrompt.indexOf('## Outreach draft');
  const end = deepPrompt.indexOf('\nWrite all analysis text', start);
  if (start === -1 || end === -1) throw new Error('prompts/deep.md: "## Outreach draft" section not found');
  return deepPrompt.slice(start, end).trim();
}

export const DRAFT_PROMPT = read('draft-repair.md').replace('{{OUTREACH_RULES}}', outreachRules(read('deep.md')));

/** Overhead per repair call on top of the prompt and the user message (schema, format). */
const REPAIR_OVERHEAD_TOKENS = 500;
/** Typical repair input beyond the prompt (proposal, statements, previous draft), for estimates. */
const TYPICAL_REPAIR_INPUT_CHARS = 4000;

export type DraftRepairStatus = 'not_needed' | 'repaired' | 'failed' | 'skipped';

export interface DraftRepairOutcome {
  status: Exclude<DraftRepairStatus, 'not_needed'>;
  /** The result with the repaired draft (status "repaired" only). */
  result?: DeepResult;
  /** Operator-facing reason when not repaired (Russian). */
  reason?: string;
  notes: string[];
  calls: number;
  cost: number;
}

function evidenceSummary(s: StatementT): string {
  const ev = s.evidence.map((e) => (e.type === 'quote' ? `«${e.ref}»` : e.type === 'none' ? '' : `${e.type} ${e.ref}`)).filter(Boolean);
  return ev.length ? ` — evidence: ${ev.join('; ')}` : '';
}

/** The request: only verified material from the analysis, never website text beyond checked quotes. */
export function draftRepairInput(result: DeepResult, ctx: DraftContext, problems: string[]): string {
  const i = result.best_opportunity_index;
  const best = result.opportunities[i]!;
  return [
    `Rewrite the outreach draft. Language=${ctx.expectedLanguage}, mode=${ctx.mode}. Company: ${ctx.companyName ?? ctx.companyDomain} (${ctx.companyDomain}).`,
    '',
    `Chosen proposal (opportunity_index = ${i}): ${best.title}`,
    `What we propose: ${best.proposal}`,
    'Observed on the site — choose ONE as observation_index; a "fact" may be stated (framing "observation"), an "inference" only asked about (framing "question"), the others cannot be used:',
    ...best.observed.map((s, n) => `- [${n}] ${s.kind}: ${s.text}${evidenceSummary(s)}`),
    '',
    'Previous draft:',
    `Subject: ${result.outreach.subject}`,
    result.outreach.body,
    '',
    'Problems code found in it:',
    ...problems.map((p) => `- ${p}`),
  ].join('\n');
}

export function repairWorstUsd(config: Config): number {
  const stage = config.llm.stages.deep;
  if (!stage.draft_repair) return 0;
  const p = config.llm.prices[stage.model]!;
  const input = estimateInputTokens(DRAFT_PROMPT, 'x'.repeat(TYPICAL_REPAIR_INPUT_CHARS)) + REPAIR_OVERHEAD_TOKENS;
  return (input * p.input + stage.draft_repair.max_output_tokens * p.output) / 1_000_000;
}

/**
 * ONE repair request for the draft of `result` (already finalized). Never throws for budget or
 * API problems — a failed repair must not lose a valid dossier; the caller marks the draft unusable.
 */
export async function repairDraft(
  result: DeepResult,
  eligible: boolean[],
  ctx: DraftContext,
  problems: string[],
  deps: { config: Config; llm: LlmClient; budget: Budget; companyId: string },
): Promise<DraftRepairOutcome> {
  const stage = deps.config.llm.stages.deep;
  const none = { notes: [], calls: 0, cost: 0 };
  if (!stage.draft_repair) return { status: 'skipped', reason: 'ремонт черновика не настроен (llm.stages.deep.draft_repair)', ...none };
  if (!eligible[result.best_opportunity_index]) return { status: 'skipped', reason: 'нет обоснованного предложения, на котором можно построить письмо', ...none };

  const user = draftRepairInput(result, ctx, problems);
  const worst: LlmUsage = {
    inputTokens: estimateInputTokens(DRAFT_PROMPT, user) + REPAIR_OVERHEAD_TOKENS,
    outputTokens: stage.draft_repair.max_output_tokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const p = deps.config.llm.prices[stage.model]!;
  try {
    deps.budget.assertCanSpend((worst.inputTokens * p.input + worst.outputTokens * p.output) / 1_000_000);
  } catch (err) {
    if (err instanceof BudgetExceededError) return { status: 'skipped', reason: `бюджет не позволил ремонт черновика (${err.message})`, ...none };
    throw err;
  }

  let repaired: DraftRepair;
  try {
    const res = await deps.llm.complete({
      model: stage.model,
      effort: stage.draft_repair.effort,
      maxOutputTokens: stage.draft_repair.max_output_tokens,
      system: DRAFT_PROMPT,
      user,
      schema: DraftRepair,
    });
    const cost = deps.budget.record({ purpose: 'deep_draft', companyId: deps.companyId, model: stage.model, usage: res.usage, worstCaseUsage: worst, ok: true }).cost;
    repaired = res.data;
    const candidate: DeepResult = { ...structuredClone(result), outreach: repaired.outreach };
    const check = checkOutreach(candidate, eligible, ctx);
    const left = [...check.draftRuleIssues, ...check.groundingIssues];
    if (left.length) return { status: 'failed', reason: `исправленный черновик тоже не прошёл проверку: ${left.join('; ')}`, notes: check.notes, calls: 1, cost };
    return { status: 'repaired', result: candidate, notes: check.notes, calls: 1, cost };
  } catch (err) {
    if (!(err instanceof LlmError)) throw err;
    const error = `${err.code}: ${err.message}`;
    const cost = deps.budget.record({ purpose: 'deep_draft', companyId: deps.companyId, model: stage.model, usage: err.usage, worstCaseUsage: worst, ok: false, error }).cost;
    return { status: 'failed', reason: `запрос на ремонт черновика не удался (${err.code})`, notes: [], calls: 1, cost };
  }
}
