// What the next paid attempt may look like after a failed one. A cut-off answer is never repeated
// with identical settings: it gets at most ONE retry with the stage's `on_truncation` settings
// (less reasoning, a higher output limit) and a request to be brief. Every attempt still goes
// through Budget.assertCanSpend with its own output limit; the stages cap attempts per pass.
import type { Config } from '../config/load.js';
import type { LlmError, LlmRequest } from './client.js';

type Stage = Config['llm']['stages']['deep'];

export interface AttemptSettings {
  effort: LlmRequest<never>['effort'];
  maxOutputTokens: number;
  /** These are the after-truncation settings: a further truncation ends the analysis. */
  afterTruncation: boolean;
}

export function initialSettings(stage: Stage): AttemptSettings {
  return { effort: stage.effort, maxOutputTokens: stage.max_output_tokens, afterTruncation: false };
}

/** Settings for the next attempt after `err`, or null when the request must not be repeated. */
export function nextSettings(stage: Stage, current: AttemptSettings, err: LlmError): AttemptSettings | null {
  if (err.code !== 'truncated') return err.retryable ? current : null;
  if (!stage.on_truncation || current.afterTruncation) return null;
  return { effort: stage.on_truncation.effort, maxOutputTokens: stage.on_truncation.max_output_tokens, afterTruncation: true };
}

/** Largest output limit any attempt of this stage may use (budget and worst-case estimates). */
export function maxOutputTokensOf(stage: Stage): number {
  return Math.max(stage.max_output_tokens, stage.on_truncation?.max_output_tokens ?? 0);
}

export const TRUNCATION_FEEDBACK =
  'Your previous answer was cut off at the output limit and could not be used. Answer much more briefly: ' +
  'at most 2 opportunities, at most 3 statements per list, one short sentence each, no repetition.';
