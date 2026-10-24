// Spend accounting and limits (spec 6.2, 9.5). Every call is recorded in llm_calls, failed ones
// included; when the API reports no usage we charge a worst-case estimate instead of zero.
import type { Config } from '../config/load.js';
import type { Db } from '../db/connection.js';
import { newId } from '../util/ids.js';
import type { LlmUsage } from './client.js';

export class BudgetExceededError extends Error {}

/** Rough upper estimate of input tokens before a call (~3 chars/token covers Cyrillic). */
export function estimateInputTokens(...texts: string[]): number {
  return Math.ceil(texts.reduce((n, t) => n + t.length, 0) / 3);
}

export function costUsd(config: Config, model: string, usage: LlmUsage): number {
  const p = config.llm.prices[model];
  if (!p) throw new Error(`No price configured for model ${model}`);
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cache_read +
      usage.cacheWriteTokens * p.cache_write) /
    1_000_000
  );
}

function monthStartUtc(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export class Budget {
  private calls = 0;
  private spent = 0;
  private warned = false;
  private readonly byPurpose = new Map<string, { calls: number; cost: number }>();

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly onWarning: (message: string) => void = () => {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  monthSpent(): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM llm_calls WHERE created_at >= ?')
      .get(monthStartUtc(this.now())) as { s: number };
    return row.s;
  }

  get runSpent(): number {
    return this.spent;
  }

  get runCalls(): number {
    return this.calls;
  }

  /** Calls and cost of this run for one purpose (e.g. full analysis vs draft repair). */
  runFor(purpose: string): { calls: number; cost: number } {
    return this.byPurpose.get(purpose) ?? { calls: 0, cost: 0 };
  }

  /** Throws before a call that could break a run or monthly limit. `worstCaseUsd` = full input + max output. */
  assertCanSpend(worstCaseUsd: number): void {
    const l = this.config.limits;
    if (this.calls >= l.max_llm_calls_per_run) {
      throw new BudgetExceededError(`Run limit reached: ${this.calls} LLM calls (max_llm_calls_per_run)`);
    }
    if (this.spent + worstCaseUsd > l.max_llm_cost_usd_per_run) {
      throw new BudgetExceededError(`Run budget $${l.max_llm_cost_usd_per_run} would be exceeded (spent $${this.spent.toFixed(4)})`);
    }
    const month = this.monthSpent();
    if (month + worstCaseUsd > l.max_llm_cost_usd_per_month) {
      throw new BudgetExceededError(`Monthly budget $${l.max_llm_cost_usd_per_month} would be exceeded (spent $${month.toFixed(4)})`);
    }
    if (!this.warned && month >= l.max_llm_cost_usd_per_month * this.config.llm.budget_warn_ratio) {
      this.warned = true;
      this.onWarning(`LLM spend this month: $${month.toFixed(2)} of $${l.max_llm_cost_usd_per_month}`);
    }
  }

  /** Records one API call. With `usage` null the worst-case estimate is charged. Returns the llm_calls id. */
  record(args: {
    purpose: string;
    companyId: string | null;
    model: string;
    usage: LlmUsage | null;
    worstCaseUsage: LlmUsage;
    ok: boolean;
    error?: string;
  }): { id: string; cost: number } {
    const usage = args.usage ?? args.worstCaseUsage;
    const cost = costUsd(this.config, args.model, usage);
    const id = newId('llmCall');
    this.db
      .prepare(
        `INSERT INTO llm_calls (id, purpose, company_id, model, input_tokens, output_tokens, cached_tokens, cost_usd, ok, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        args.purpose,
        args.companyId,
        args.model,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheReadTokens,
        cost,
        args.ok ? 1 : 0,
        args.error ? (args.usage ? args.error : `${args.error} (usage unknown: worst case charged)`).slice(0, 500) : null,
        this.now().toISOString(),
      );
    this.calls++;
    this.spent += cost;
    const p = this.runFor(args.purpose);
    this.byPurpose.set(args.purpose, { calls: p.calls + 1, cost: p.cost + cost });
    return { id, cost };
  }
}
