// Stage B: cheap screening of one company with Claude Haiku (docs/decisions.md).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config/load.js';
import type { Db } from '../db/connection.js';
import { buildDigest, type Digest } from '../inspect/digest.js';
import { newId } from '../util/ids.js';
import { estimateInputTokens, type Budget } from './budget.js';
import { LlmError, type LlmClient, type LlmUsage } from './client.js';
import { ScreenResult } from './schemas.js';
import { finalizeScreen, validateScreen, type ScreenValidation } from './validate.js';

export const SCREEN_PROMPT = readFileSync(fileURLToPath(new URL('./prompts/screen.md', import.meta.url)), 'utf8');
/** Changes whenever the prompt text changes, so edited prompts are never served from the cache. */
export const SCREEN_PROMPT_VERSION = `screen-${createHash('sha256').update(SCREEN_PROMPT).digest('hex').slice(0, 12)}`;

export type ScreenOutcome =
  | { status: 'screened' | 'cached'; decision: ScreenResult['decision']; result: ScreenResult; validation: ScreenValidation; cost: number }
  | { status: 'no_data' }
  | { status: 'failed'; error: string; cost: number };

export interface ScreenDeps {
  db: Db;
  config: Config;
  llm: LlmClient;
  budget: Budget;
  /** Ignore an existing assessment with the same input hash. */
  force?: boolean;
}

export function screenInputHash(model: string, promptVersion: string, digestText: string): string {
  return createHash('sha256').update(`${model}\n${promptVersion}\n${digestText}`).digest('hex');
}

function userMessage(digest: Digest, feedback: string): string {
  return `Screen this company.\n\n${digest.text}${feedback ? `\n\n${feedback}` : ''}`;
}

/** Screens one company. Throws BudgetExceededError before any call that could break a limit. */
export async function screenCompany(companyId: string, deps: ScreenDeps): Promise<ScreenOutcome> {
  const { db, config, llm, budget } = deps;
  const stage = config.llm.stages.screen;
  const digest = buildDigest(db, companyId, stage.digest_max_chars);
  if (!digest) return { status: 'no_data' };
  if (digest.injectionSuspected) db.prepare('UPDATE companies SET injection_suspected = 1 WHERE id = ?').run(companyId);

  const inputHash = screenInputHash(stage.model, SCREEN_PROMPT_VERSION, digest.text);
  if (!deps.force) {
    const cached = db
      .prepare(
        `SELECT decision, payload_json, validation_json FROM assessments
         WHERE company_id = ? AND stage = 'screen' AND input_hash = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(companyId, inputHash) as { decision: ScreenResult['decision']; payload_json: string; validation_json: string } | undefined;
    if (cached) {
      const result = JSON.parse(cached.payload_json) as ScreenResult;
      const stored = JSON.parse(cached.validation_json) as Pick<ScreenValidation, 'opportunities' | 'issues'>;
      return {
        status: 'cached',
        decision: cached.decision,
        result,
        validation: { result, ...stored, retry: false, feedback: '' },
        cost: 0,
      };
    }
  }

  let feedback = '';
  let validation: ScreenValidation | null = null;
  let lastCallId: string | null = null;
  let cost = 0;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const user = userMessage(digest, feedback);
    const worstCase: LlmUsage = {
      inputTokens: estimateInputTokens(SCREEN_PROMPT, user) + 500, // + schema/format overhead
      outputTokens: stage.max_output_tokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const p = config.llm.prices[stage.model]!;
    budget.assertCanSpend((worstCase.inputTokens * p.input + worstCase.outputTokens * p.output) / 1_000_000);

    try {
      const res = await llm.complete({
        model: stage.model,
        effort: stage.effort,
        maxOutputTokens: stage.max_output_tokens,
        system: SCREEN_PROMPT,
        user,
        schema: ScreenResult,
      });
      const rec = budget.record({ purpose: 'screen', companyId, model: stage.model, usage: res.usage, worstCaseUsage: worstCase, ok: true });
      lastCallId = rec.id;
      cost += rec.cost;
      validation = validateScreen(res.data, digest);
      if (!validation.retry) break;
      feedback = validation.feedback;
    } catch (err) {
      if (!(err instanceof LlmError)) throw err;
      const rec = budget.record({
        purpose: 'screen',
        companyId,
        model: stage.model,
        usage: err.usage,
        worstCaseUsage: worstCase,
        ok: false,
        error: `${err.code}: ${err.message}`,
      });
      cost += rec.cost;
      // A failed retry must not discard a usable first answer.
      if (validation) break;
      if (!err.retryable || attempt === 2) return { status: 'failed', error: `${err.code}: ${err.message}`, cost };
    }
  }
  if (!validation) return { status: 'failed', error: 'no valid answer', cost };
  validation = finalizeScreen(validation);

  db.prepare(
    `INSERT INTO assessments (id, company_id, inspection_id, stage, model, prompt_version, input_hash, decision, payload_json,
       validation_json, llm_call_id, created_at)
     VALUES (?, ?, ?, 'screen', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId('assessment'),
    companyId,
    digest.inspectionId,
    stage.model,
    SCREEN_PROMPT_VERSION,
    inputHash,
    validation.result.decision,
    JSON.stringify(validation.result),
    JSON.stringify({ opportunities: validation.opportunities, issues: validation.issues }),
    lastCallId,
    new Date().toISOString(),
  );
  return { status: 'screened', decision: validation.result.decision, result: validation.result, validation, cost };
}

