// The only module that talks to the Anthropic API. Everything else depends on LlmClient,
// so tests use a fake and the provider/model can change without touching callers.
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number; // includes thinking tokens
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmRequest<S extends z.ZodType> {
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxOutputTokens: number;
  system: string;
  user: string;
  schema: S;
}

export interface LlmResponse<T> {
  data: T;
  usage: LlmUsage;
  model: string;
}

export type LlmErrorCode = 'refusal' | 'truncated' | 'invalid_output' | 'rate_limited' | 'auth' | 'bad_request' | 'api';

export class LlmError extends Error {
  constructor(
    message: string,
    readonly code: LlmErrorCode,
    /** Tokens were billed even though the call failed (e.g. truncated or refused output). */
    readonly usage: LlmUsage | null = null,
  ) {
    super(message);
  }

  /** Worth one more attempt with the same input. */
  get retryable(): boolean {
    return this.code === 'truncated' || this.code === 'invalid_output' || this.code === 'rate_limited' || this.code === 'api';
  }
}

export interface LlmClient {
  complete<S extends z.ZodType>(req: LlmRequest<S>): Promise<LlmResponse<z.infer<S>>>;
}

function usageOf(u: Anthropic.Usage): LlmUsage {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;

  /**
   * SDK retries are always off (the SDK default is 2): one complete() is exactly one HTTP request,
   * so every paid attempt passes through the caller's Budget.assertCanSpend and Budget.record.
   * Callers retry transient errors themselves. `fetch` is a test seam only.
   */
  constructor(opts: { apiKey: string; timeoutMs: number; fetch?: typeof globalThis.fetch }) {
    this.client = new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs, maxRetries: 0, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  }

  async complete<S extends z.ZodType>(req: LlmRequest<S>): Promise<LlmResponse<z.infer<S>>> {
    const format = zodOutputFormat(req.schema);
    let response;
    try {
      // create(), not parse(): parse() throws on an incomplete JSON before stop_reason and usage can
      // be read, so a truncated answer looked like "invalid output" with unknown (worst-case) cost.
      response = await this.client.messages.create({
        model: req.model,
        max_tokens: req.maxOutputTokens,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
        output_config: { effort: req.effort, format },
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        throw new LlmError(`API key rejected: ${err.message}`, 'auth');
      }
      if (err instanceof Anthropic.RateLimitError) throw new LlmError(err.message, 'rate_limited');
      if (err instanceof Anthropic.BadRequestError) throw new LlmError(err.message, 'bad_request');
      if (err instanceof Anthropic.APIError) throw new LlmError(`API error ${err.status ?? ''}: ${err.message}`, 'api');
      throw new LlmError(`Request failed: ${(err as Error).message}`, 'api');
    }

    const usage = usageOf(response.usage);
    // stop_reason first: a cut-off answer is "truncated" even though its JSON is also broken.
    if (response.stop_reason === 'refusal') throw new LlmError('Model declined the request', 'refusal', usage);
    if (response.stop_reason === 'max_tokens') throw new LlmError(`Output truncated at max_tokens (${req.maxOutputTokens})`, 'truncated', usage);
    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    if (!text.trim()) throw new LlmError('No structured output in response', 'invalid_output', usage);
    try {
      return { data: format.parse(text) as z.infer<S>, usage, model: response.model };
    } catch (err) {
      throw new LlmError(`Invalid model output: ${(err as Error).message.slice(0, 300)}`, 'invalid_output', usage);
    }
  }
}
