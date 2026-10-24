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
import { buildDeepInput, EXTRA_PAGE_MAX_CHARS, type DeepInput, type ExtraPage } from './deepInput.js';
import { finalizeDeep, MAX_EXTRA_PAGES, validateDeep, type DeepContext, type DeepValidation } from './deepValidate.js';
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

const deepHeader = (language: string, mode: string) => `Analyse this company.\nOutreach draft: language=${language}, mode=${mode}.\n\n`;
/** Schema and format overhead per call, on top of the prompt and the user message. */
const SCHEMA_OVERHEAD_TOKENS = 1000;
/** Typical answer size, for the dry-run estimate only; limits always use max_output_tokens. */
const TYPICAL_OUTPUT_TOKENS = 3000;

function cachedAssessment(db: Db, companyId: string, inputHash: string): { payload_json: string; validation_json: string } | undefined {
  return db
    .prepare(`SELECT payload_json, validation_json FROM assessments WHERE company_id = ? AND stage = 'deep' AND input_hash = ? ORDER BY created_at DESC LIMIT 1`)
    .get(companyId, inputHash) as { payload_json: string; validation_json: string } | undefined;
}

export interface DeepEstimate {
  /** The first company with data and its input, to show the operator what would be sent. */
  first: { companyId: string; text: string } | null;
  toAnalyze: number;
  cached: number;
  noData: number;
  inputTokens: number;
  /** One call per company with a typical answer. */
  estimateUsd: number;
  /** Every retry and the second pass with the maximum of extra pages, each at max output. */
  worstUsd: number;
}

/** Dry run of analyzeCompany for a batch: reads the database only, never calls the API. */
export function estimateDeepRun(db: Db, config: Config, companyIds: string[], force = false): DeepEstimate {
  const stage = config.llm.stages.deep;
  const p = config.llm.prices[stage.model]!;
  const extraTokens = estimateInputTokens('x'.repeat(MAX_EXTRA_PAGES * EXTRA_PAGE_MAX_CHARS));
  const est: DeepEstimate = { first: null, toAnalyze: 0, cached: 0, noData: 0, inputTokens: 0, estimateUsd: 0, worstUsd: 0 };
  for (const id of companyIds) {
    const company = db.prepare('SELECT market FROM companies WHERE id = ?').get(id) as { market: string } | undefined;
    const market = company && config.markets.get(company.market as MarketCode);
    const input = market ? buildDeepInput(db, id, stage.digest_max_chars) : null;
    if (!market || !input) {
      est.noData++;
      continue;
    }
    est.first ??= { companyId: id, text: input.text };
    if (!force && cachedAssessment(db, id, deepInputHash(stage.model, DEEP_PROMPT_VERSION, input.text))) {
      est.cached++;
      continue;
    }
    const tokens = estimateInputTokens(DEEP_PROMPT, deepHeader(market.language, market.first_touch_mode), input.text) + SCHEMA_OVERHEAD_TOKENS;
    est.toAnalyze++;
    est.inputTokens += tokens;
    est.estimateUsd += (tokens * p.input + TYPICAL_OUTPUT_TOKENS * p.output) / 1_000_000;
    // Two passes of two attempts; the second pass also carries the extra pages (and feedback, ~overhead).
    const worstIn = 2 * (tokens + SCHEMA_OVERHEAD_TOKENS) + 2 * (tokens + extraTokens + SCHEMA_OVERHEAD_TOKENS);
    est.worstUsd += (worstIn * p.input + 4 * stage.max_output_tokens * p.output) / 1_000_000;
  }
  return est;
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
    const cached = cachedAssessment(db, companyId, inputHash);
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
  const header = deepHeader(market.language, market.first_touch_mode);
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
        inputTokens: estimateInputTokens(DEEP_PROMPT, user) + SCHEMA_OVERHEAD_TOKENS,
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
