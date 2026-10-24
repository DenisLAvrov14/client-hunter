// Stage C: deep analysis of one shortlisted company with Claude Haiku (docs/decisions.md).
// Pass 1 may ask for up to 3 extra pages from the site's known links; code reads them (bounded)
// and pass 2 answers with them. Each pass allows one retry on fixable validation problems.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config/load.js';
import type { MarketCode } from '../config/schema.js';
import type { Db } from '../db/connection.js';
import { recordSupplementPages } from '../db/repo.js';
import { fetchExtraPages } from '../inspect/extraPages.js';
import type { Fetcher } from '../inspect/fetcher.js';
import { newId } from '../util/ids.js';
import { estimateInputTokens, type Budget } from './budget.js';
import { LlmError, type LlmClient, type LlmUsage } from './client.js';
import { buildDeepInput, type DeepInput, type ExtraPage } from './deepInput.js';
import { finalizeDeep, validateDeep, type DeepContext, type DeepValidation } from './deepValidate.js';
import { DeepResult } from './schemas.js';

export const DEEP_PROMPT = readFileSync(fileURLToPath(new URL('./prompts/deep.md', import.meta.url)), 'utf8');
/** Changes whenever the prompt text changes, so edited prompts are never served from the cache. */
export const DEEP_PROMPT_VERSION = `deep-${createHash('sha256').update(DEEP_PROMPT).digest('hex').slice(0, 12)}`;

export interface DeepMeta {
  extraPages: string[];
  skippedPages: { url: string; reason: string }[];
  outreachIssues: string[];
  issues: string[];
  eligible: boolean[];
  calls: number;
}

export type DeepOutcome =
  | { status: 'analyzed' | 'cached'; result: DeepResult; meta: DeepMeta; cost: number }
  | { status: 'no_data' }
  | { status: 'failed'; error: string; cost: number };

export interface DeepDeps {
  db: Db;
  config: Config;
  llm: LlmClient;
  budget: Budget;
  fetcher: Fetcher;
  /** Ignore an existing analysis of the same input (costs money). */
  force?: boolean;
}

interface CompanyInfo {
  id: string;
  domain: string;
  name: string | null;
  market: string;
}

export function deepInputHash(model: string, promptVersion: string, inputText: string): string {
  return createHash('sha256').update(`${model}\n${promptVersion}\n${inputText}`).digest('hex');
}

export async function analyzeCompany(companyId: string, deps: DeepDeps): Promise<DeepOutcome> {
  const { db, config, llm, budget } = deps;
  const stage = config.llm.stages.deep;
  const company = db.prepare('SELECT id, domain, name, market FROM companies WHERE id = ?').get(companyId) as CompanyInfo | undefined;
  if (!company) return { status: 'no_data' };
  const market = config.markets.get(company.market as MarketCode);
  if (!market) return { status: 'failed', error: `no market config for ${company.market}`, cost: 0 };

  const base = buildDeepInput(db, companyId, stage.digest_max_chars);
  if (!base) return { status: 'no_data' };
  const inputHash = deepInputHash(stage.model, DEEP_PROMPT_VERSION, base.text);
  if (!deps.force) {
    const cached = db
      .prepare(`SELECT payload_json, validation_json FROM assessments WHERE company_id = ? AND stage = 'deep' AND input_hash = ? ORDER BY created_at DESC LIMIT 1`)
      .get(companyId, inputHash) as { payload_json: string; validation_json: string } | undefined;
    if (cached) {
      return { status: 'cached', result: JSON.parse(cached.payload_json) as DeepResult, meta: JSON.parse(cached.validation_json) as DeepMeta, cost: 0 };
    }
  }

  const ctx = (allowExtraPages: boolean): DeepContext => ({
    rules: config.copyRules,
    expectedLanguage: market.language,
    mode: market.first_touch_mode,
    companyDomain: company.domain,
    companyName: company.name,
    allowExtraPages,
  });
  const header = `Analyse this company.\nOutreach draft: language=${market.language}, mode=${market.first_touch_mode}.\n\n`;
  let cost = 0;
  let calls = 0;
  let lastError = '';

  /** One pass: a call, and one more with feedback if validation found fixable problems. */
  const pass = async (input: DeepInput, allowExtraPages: boolean): Promise<DeepValidation | null> => {
    let feedback = '';
    let validation: DeepValidation | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const user = `${header}${input.text}${feedback ? `\n\n${feedback}` : ''}`;
      const worst: LlmUsage = {
        inputTokens: estimateInputTokens(DEEP_PROMPT, user) + 1000, // + schema overhead
        outputTokens: stage.max_output_tokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      const p = config.llm.prices[stage.model]!;
      budget.assertCanSpend((worst.inputTokens * p.input + worst.outputTokens * p.output) / 1_000_000);
      try {
        const res = await llm.complete({
          model: stage.model,
          effort: stage.effort,
          maxOutputTokens: stage.max_output_tokens,
          system: DEEP_PROMPT,
          user,
          schema: DeepResult,
        });
        calls++;
        cost += budget.record({ purpose: 'deep', companyId, model: stage.model, usage: res.usage, worstCaseUsage: worst, ok: true }).cost;
        validation = validateDeep(res.data, input, ctx(allowExtraPages));
        if (!validation.retry) break;
        feedback = validation.feedback;
      } catch (err) {
        if (!(err instanceof LlmError)) throw err;
        calls++;
        lastError = `${err.code}: ${err.message}`;
        cost += budget.record({ purpose: 'deep', companyId, model: stage.model, usage: err.usage, worstCaseUsage: worst, ok: false, error: lastError }).cost;
        if (validation || !err.retryable) break;
      }
    }
    return validation;
  };

  let validation = await pass(base, true);
  if (!validation) return { status: 'failed', error: lastError || 'no valid answer', cost };

  const extraPages: string[] = [];
  let skippedPages: { url: string; reason: string }[] = [];
  if (validation.needPages.length > 0) {
    const read = await fetchExtraPages(deps.fetcher, validation.needPages, company.domain, config.app.robots_token, config.limits.page_main_text_max_chars);
    skippedPages = read.skipped;
    if (read.pages.length > 0) {
      recordSupplementPages(db, companyId, read.pages.map((page, i) => ({ page, mainText: read.texts[i]?.text ?? '' })));
      extraPages.push(...read.texts.map((t) => t.url));
      const extra: ExtraPage[] = read.texts;
      const second = buildDeepInput(db, companyId, stage.digest_max_chars, extra);
      const v2 = second ? await pass(second, false) : null;
      if (v2) validation = v2;
    }
  }
  validation = finalizeDeep(validation);

  const meta: DeepMeta = {
    extraPages,
    skippedPages,
    outreachIssues: validation.outreachIssues,
    issues: validation.issues,
    eligible: validation.eligible,
    calls,
  };
  db.prepare(
    `INSERT INTO assessments (id, company_id, inspection_id, stage, model, prompt_version, input_hash, decision, payload_json,
       validation_json, llm_call_id, created_at)
     VALUES (?, ?, ?, 'deep', ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    newId('assessment'),
    companyId,
    base.digest.inspectionId,
    stage.model,
    DEEP_PROMPT_VERSION,
    inputHash,
    validation.result.recommendation,
    JSON.stringify(validation.result),
    JSON.stringify(meta),
    new Date().toISOString(),
  );
  return { status: 'analyzed', result: validation.result, meta, cost };
}
