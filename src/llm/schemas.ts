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
