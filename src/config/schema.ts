import { z } from 'zod';

export const MARKET_CODES = ['UK', 'IE', 'NL', 'KZ', 'RU'] as const;
export const MarketCode = z.enum(MARKET_CODES);
export type MarketCode = z.infer<typeof MarketCode>;

export const SEGMENT_CODES = ['S1', 'S2', 'S3'] as const;
export const SegmentCode = z.enum(SEGMENT_CODES);
export type SegmentCode = z.infer<typeof SegmentCode>;

export const OfferCode = z.enum(['O1', 'O2', 'O3']);
export type OfferCode = z.infer<typeof OfferCode>;

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');

const ianaTimezone = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'unknown IANA timezone' },
);

const range = z.tuple([z.number().nonnegative(), z.number().nonnegative()]).refine(([a, b]) => a <= b, {
  message: 'range min must be <= max',
});

export const AppSchema = z.strictObject({
  operator_timezone: ianaTimezone,
  review_time_local: timeOfDay,
  summary_time_local: timeOfDay,
  queue_score_threshold: z.number().int().min(0).max(100),
  data_dir: z.string().min(1),
  db_file: z.string().min(1),
  backups_keep: z.number().int().positive(),
  user_agent: z.string().min(10),
  robots_token: z.string().regex(/^[A-Za-z][\w-]*$/),
});

export const LimitsSchema = z.strictObject({
  max_companies_per_run: z.number().int().positive(),
  max_pages_per_site: z.number().int().positive(),
  request_timeout_ms: z.number().int().positive(),
  max_response_bytes: z.number().int().positive(),
  max_redirects: z.number().int().min(0),
  per_domain_delay_ms: z.number().int().min(0),
  max_concurrent_sites: z.number().int().positive(),
  max_llm_calls_per_run: z.number().int().min(0),
  max_llm_cost_usd_per_run: z.number().min(0),
  max_llm_cost_usd_per_month: z.number().min(0),
  max_queue_per_day: z.number().int().positive(),
  max_nav_links_checked: z.number().int().min(0).max(20),
  overpass_timeout_s: z.number().int().positive().max(180),
  page_main_text_max_chars: z.number().int().min(500).max(20000),
  page_links_max: z.number().int().min(0).max(200),
});

const TokenPrice = z.strictObject({
  input: z.number().min(0),
  output: z.number().min(0),
  cache_read: z.number().min(0),
  cache_write: z.number().min(0),
});

const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

const LlmStage = z
  .strictObject({
    model: z.string().min(1),
    effort: Effort,
    max_output_tokens: z.number().int().min(256).max(64000),
    digest_max_chars: z.number().int().min(1000).max(60000),
    /** Settings for the ONE retry after an answer cut off at max_output_tokens; absent = no retry. */
    on_truncation: z.strictObject({ effort: Effort, max_output_tokens: z.number().int().min(256).max(64000) }).optional(),
    /** Stage C: ONE small request that regenerates only a failing outreach draft; absent = no repair. */
    draft_repair: z.strictObject({ effort: Effort, max_output_tokens: z.number().int().min(256).max(16000) }).optional(),
  })
  .refine((s) => !s.on_truncation || s.on_truncation.max_output_tokens >= s.max_output_tokens, {
    message: 'on_truncation.max_output_tokens must not be lower than max_output_tokens',
  });

export const LlmSchema = z
  .strictObject({
    stages: z.strictObject({ screen: LlmStage, deep: LlmStage }),
    request_timeout_ms: z.number().int().positive(),
    prices: z.record(z.string(), TokenPrice),
    budget_warn_ratio: z.number().gt(0).lte(1),
  })
  .refine((c) => Object.values(c.stages).every((s) => s.model in c.prices), {
    message: 'every configured model needs a price entry (never assume an API call is free)',
  });

export type LlmStageConfig = z.infer<typeof LlmStage>;

const scoreTable = z.record(z.string(), z.number().min(0).max(100));

export const ScoringSchema = z
  .strictObject({
    weights: z.strictObject({
      friction: z.number().min(0),
      trigger: z.number().min(0),
      benefit: z.number().min(0),
      capacity: z.number().min(0),
      fit: z.number().min(0),
      contact: z.number().min(0),
    }),
    friction: z.strictObject({
      second_signal_bonus: z.number().min(0).max(100),
      by_code: scoreTable,
    }),
    benefit_default_by_code: scoreTable,
    trigger: scoreTable,
    contact: scoreTable,
  })
  .refine((c) => Math.abs(Object.values(c.weights).reduce((a, b) => a + b, 0) - 1) < 1e-6, {
    message: 'scoring weights must sum to 1',
  });

export const OffersSchema = z.strictObject({
  offers: z.record(
    OfferCode,
    z.strictObject({
      name: z.string().min(1),
      duration_weeks: range,
      portfolio: z.url(),
      prices: z.record(z.string().length(3), range),
    }),
  ),
});

export const CopyRulesSchema = z.strictObject({
  limits: z.strictObject({
    subject_max_words: z.number().int().positive(),
    first_email_max_words: z.number().int().positive(),
    followup_1_max_words: z.number().int().positive(),
    followup_2_max_words: z.number().int().positive(),
  }),
  banned_terms: z.array(z.string().min(1)),
  banned_patterns: z.array(
    z.string().refine(
      (p) => {
        try {
          new RegExp(p, 'u');
          return true;
        } catch {
          return false;
        }
      },
      { message: 'invalid regex' },
    ),
  ),
  opt_out: z.record(z.string(), z.string().min(1)),
  allowed_link_hosts: z.array(z.string().min(1)),
});

export const MarketSchema = z
  .strictObject({
    code: MarketCode,
    enabled: z.boolean(),
    legal_review_done: z.boolean(),
    requires_manual_legal_review: z.boolean().default(false),
    language: z.enum(['en', 'nl', 'ru']),
    timezone: ianaTimezone,
    currency: z.string().length(3),
    send_window_local: z.strictObject({
      days: z.array(z.number().int().min(1).max(7)).min(1), // ISO weekday: 1 = Monday … 7 = Sunday
      from: timeOfDay,
      to: timeOfDay,
    }),
    daily_cap: z.number().int().min(0),
    first_touch_mode: z.enum(['offer', 'permission_request']),
    followups: z.number().int().min(0).max(2),
    followup_delays_days: z.array(z.number().int().positive()),
    require_corporate_entity: z.boolean(),
    require_registry_check: z.boolean(),
    allow_named_business_address: z.boolean(),
    allow_freemail_addresses: z.boolean(),
    entity_markers_allow: z.array(z.string().min(1)).min(1),
    entity_markers_deny: z.array(z.string().min(1)),
    registry: z.enum(['companies_house', 'none']),
    discovery_cities: z.array(z.string().min(1)).default([]),
    // Baseline for outreach risk (src/outreach/risk.ts), not a discovery filter:
    // allowed_for_companies = companies yes, individuals/sole traders need consent (PECR, ePrivacy, Tw 11.7);
    // consent_required_all = prior consent for any advertising email (RU 38-FZ);
    // unverified = the rules for this market have not been checked yet.
    cold_email_baseline: z.enum(['allowed_for_companies', 'consent_required_all', 'unverified']),
  })
  .refine((m) => m.followup_delays_days.length === m.followups, {
    message: 'followup_delays_days must have exactly `followups` entries',
  })
  .refine((m) => m.send_window_local.from < m.send_window_local.to, {
    message: 'send window must end after it starts',
  });

export const SegmentSchema = z.looseObject({
  code: SegmentCode,
  name: z.string().min(1),
  markets: z.array(MarketCode).min(1),
  osm_tags: z.array(z.string().regex(/^[a-z_:]+=[^=\s]+$/, 'expected key=value')).default([]),
});

const words = z.array(z.string().min(1).regex(/^[^A-Z]*$/, 'lower-case only')).min(1);

const ForumFeed = z.strictObject({
  id: z.string().regex(/^[a-z0-9_]+$/),
  label: z.string().min(1),
  enabled: z.boolean(),
  /** secondary: platform-specialist communities (Bubble, n8n…) — kept, but off unless asked for. */
  secondary: z.boolean().default(false),
  kind: z.enum(['rss', 'discourse']),
  /** rss: the feed URL. discourse: the forum base URL. */
  url: z.url(),
  /** discourse only: "slug/id" categories; `all: false` = read only topics whose title looks like a request. */
  categories: z.array(z.strictObject({ path: z.string().regex(/^[a-z0-9-]+(?:\/[a-z0-9-]+)*\/\d+$/), all: z.boolean() })).default([]),
  max_pages: z.number().int().min(1).max(20).default(3),
  /** How a reader replies at this source (operator-facing, Russian); default: a reply in the thread. */
  reply: z.string().min(1).optional(),
});

/** Buyer-intent discovery (config/intent.yaml). */
export const IntentSchema = z.strictObject({
  sources: z.strictObject({
    hn_freelance: z.strictObject({ enabled: z.boolean(), months: z.number().int().min(1).max(24) }),
    hn_hiring: z.strictObject({ enabled: z.boolean(), months: z.number().int().min(1).max(12) }),
    uk_contracts_finder: z.strictObject({
      enabled: z.boolean(),
      days: z.number().int().min(1).max(365),
      cpv_prefixes: z.array(z.string().regex(/^\d{2,8}$/)).min(1),
      large_value_gbp: z.number().positive(),
    }),
    forums: z.strictObject({ days: z.number().int().min(1).max(365), feeds: z.array(ForumFeed).min(1) }),
  }),
  /** Older requests are reported but not shortlisted unless the source says they are open. */
  max_age_days: z.number().int().min(1).max(365),
  markers: z.strictObject({ recruiter: words, closed: words, not_our_work: words, non_dev_roles: words, procurement_not_dev: words }),
  /** What the post says the author wants (lower-case phrases). */
  buyer: z.strictObject({
    project: words,
    payment: words,
    build_verbs: words,
    ask: words,
    recommendation: words,
    provider_nouns: words,
    need: words,
    staffing: words,
    service_provider: words,
    agency_partnership: words,
    equity_only: words,
    software: words,
  }),
  geo: z.strictObject({ target: words, restricted_other: words, local_only: words }),
});

/** Service Capability Profile (config/capabilities.yaml): what we deliver, in one place. */
export const CapabilitiesSchema = z.strictObject({
  areas: z.record(
    z.string().regex(/^[a-z0-9_]+$/),
    z.strictObject({ label: z.string().min(1), fit: z.enum(['core', 'conditional']), technologies: words, services: words }),
  ),
  poor_fit: z.strictObject({
    platforms: words,
    native_mobile: words,
    games: words,
    specialist_platforms: words,
    enterprise_stack: words,
    data_science: words,
    non_dev: words,
    alternatives_ok: words,
  }),
});

export type AppConfig = z.infer<typeof AppSchema>;
export type IntentConfig = z.infer<typeof IntentSchema>;
export type ForumFeedConfig = z.infer<typeof ForumFeed>;
export type CapabilitiesConfig = z.infer<typeof CapabilitiesSchema>;
export type LimitsConfig = z.infer<typeof LimitsSchema>;
export type LlmConfig = z.infer<typeof LlmSchema>;
export type ScoringConfig = z.infer<typeof ScoringSchema>;
export type OffersConfig = z.infer<typeof OffersSchema>;
export type CopyRulesConfig = z.infer<typeof CopyRulesSchema>;
export type MarketConfig = z.infer<typeof MarketSchema>;
export type SegmentConfig = z.infer<typeof SegmentSchema>;
