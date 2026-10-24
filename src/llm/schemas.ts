// Structured outputs. Kept to plain JSON-schema features (objects, strings, enums, arrays):
// length/count rules are enforced afterwards by validate.ts, not by the schema.
import { z } from 'zod';

export const ScreenOpportunity = z.object({
  title: z.string().describe('Short name of the improvement, in Russian'),
  category: z.enum(['website_rescue', 'business_improvement']),
  hook_type: z
    .enum(['finding', 'quote', 'none'])
    .describe('What on the site supports it: a technical finding id, a verbatim quote from the page text, or nothing'),
  hook: z
    .string()
    .describe('The finding id (e.g. obs_abc123), or a short verbatim quote copied exactly from the page text, or empty'),
  hook_page_url: z.string().describe('URL of the page the quote comes from; empty for findings or none'),
  why: z.string().describe('Why this could help this business, 1-2 sentences in Russian, no numbers or invented facts'),
});

export const ScreenResult = z.object({
  business_summary: z.string().describe('What the business does, 1-2 sentences in Russian'),
  business_type: z.string().describe('Short category in Russian, e.g. "поставщик металлопроката"'),
  customers: z.enum(['b2b', 'b2c', 'both', 'unknown']),
  commercial_activity: z.enum(['clear', 'likely', 'unclear', 'none']),
  commercial_signals: z
    .array(
      z.object({
        signal: z.string().describe('What it shows, in Russian'),
        quote: z.string().describe('Short verbatim quote copied exactly from the page text'),
        page_url: z.string(),
      }),
    )
    .describe('0-3 items'),
  size: z.enum(['solo_or_micro', 'small', 'medium', 'large_or_chain', 'unknown']),
  is_it_or_web_agency: z.boolean().describe('True if the business itself sells IT, software or web design services'),
  opportunities: z.array(ScreenOpportunity).describe('1-3 items, strongest first'),
  decision: z.enum(['deep', 'maybe', 'skip']),
  decision_reason: z.string().describe('In Russian'),
  unknowns: z.array(z.string()).describe('Important things the site does not tell, in Russian'),
});

export type ScreenResult = z.infer<typeof ScreenResult>;

// ---- Stage C: deep analysis ----

/** Reasons against "pursue" the model must name; code checks them against the evidence. */
export const RECOMMENDATION_BLOCKERS = [
  'best_has_no_fact', // the best proposal rests on inferences only
  'relevance_unclear', // unclear whether it matters to how this business sells or serves customers
  'problem_not_shown', // whether the problem really exists is not visible on the site
  'already_exists', // the site already offers it
  'nothing_grounded', // no opportunity is grounded in anything observed
  'not_a_fit', // IT/web agency, closed business, large chain, not a business
  'unknown_internal_metrics', // volumes, revenue, staff unknown: normal, never a reason on its own
] as const;
export type RecommendationBlocker = (typeof RECOMMENDATION_BLOCKERS)[number];

export const Evidence = z.object({
  type: z.enum(['finding', 'quote', 'capability', 'none']),
  ref: z
    .string()
    .describe('finding id (obs_…), a short verbatim quote from the page text, or a capability key from the digest; empty for none'),
  page_url: z.string().describe('URL of the page the quote comes from; empty otherwise'),
});

export const Statement = z.object({
  text: z.string().describe('In Russian'),
  kind: z
    .enum(['fact', 'inference', 'hypothesis', 'unknown'])
    .describe('fact: directly shown by the evidence; inference: concluded from evidence; hypothesis: plausible but unshown; unknown: not knowable from the site'),
  evidence: z.array(Evidence).describe('fact and inference need at least one; hypothesis and unknown may have none'),
});

export const DeepOpportunity = z.object({
  title: z.string().describe('In Russian'),
  category: z.enum(['website_rescue', 'business_improvement']),
  observed: z.array(Statement).describe('What the site shows that motivates this (facts/inferences with evidence)'),
  proposal: z.string().describe('What to build or fix, concretely, in Russian, plain language'),
  value: z.array(Statement).describe('Why it could matter to this business; usually hypotheses; no numbers'),
  already_exists: z.enum(['no', 'partially', 'yes', 'unknown']).describe('Does the site already offer this?'),
  already_exists_note: z.string().describe('What exists today and how it differs; in Russian'),
  project_size: z.enum(['small', 'medium', 'large']),
  portfolio: z.enum(['pinpinpin', 'cryptovigil', 'both', 'none']),
  open_questions: z.array(z.string()).describe('What to ask the business before proposing; in Russian'),
});

export const DeepResult = z.object({
  business_summary: z.string().describe('2-3 sentences, Russian'),
  business_model: z.string().describe('How they sell and to whom, Russian'),
  offering: z.array(z.string()).describe('Main products/services, Russian'),
  customer_journey: z.array(Statement).describe('How a customer finds, chooses, asks, orders or books today'),
  existing_capabilities: z.array(Statement).describe('What the site already does well or already offers'),
  opportunities: z.array(DeepOpportunity).describe('1-3, strongest first'),
  best_opportunity_index: z.number().int().describe('Index in opportunities of the single strongest proposal'),
  best_reason: z.string().describe('Why that one, Russian'),
  recommendation: z.enum(['pursue', 'maybe', 'drop']),
  recommendation_reason: z.string().describe('Russian'),
  recommendation_blockers: z
    .array(z.enum(RECOMMENDATION_BLOCKERS))
    .describe('What stands against "pursue"; empty for a clear pursue. unknown_internal_metrics alone never justifies maybe or drop'),
  unknowns: z.array(z.string()).describe('Important things the site does not tell, Russian'),
  outreach: z.object({
    language: z.enum(['en', 'ru', 'nl']),
    subject: z.string(),
    body: z.string().describe('Greeting + one observation + one proposal + one question. No signature, no opt-out line'),
    opportunity_index: z.number().int().describe('Index in opportunities of the proposal this draft makes; must be best_opportunity_index'),
    observation_index: z
      .number()
      .int()
      .describe("Index in that opportunity's `observed` of the ONE observation the body mentions"),
    framing: z
      .enum(['observation', 'question'])
      .describe('observation: the body states what was seen (only for a fact); question: the body asks about it (required for an inference)'),
  }),
  need_pages: z
    .array(z.object({ url: z.string(), reason: z.string() }))
    .describe('Up to 3 URLs from the "Known internal links" list to read before concluding; empty if not needed'),
});

export type DeepResult = z.infer<typeof DeepResult>;
export type StatementT = z.infer<typeof Statement>;
