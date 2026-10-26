// Buyer-intent leads: public requests where someone explicitly wants to hire or pay for
// development work. Nothing here is inferred from a website's shortcomings (docs/decisions.md).

import type { BuyerCategory } from './buyer.js';
import type { TechFit } from './capabilities.js';

/** Built-in API sources; forum feeds use their id from config/intent.yaml (sources.forums.feeds). */
export type BuiltinSource = 'hn_freelance' | 'hn_hiring' | 'uk_contracts_finder';
export type IntentSource = BuiltinSource | (string & {});

/** A request as published by its source, before any judgement. */
export interface RawRequest {
  source: IntentSource;
  /** Id of the request at the source (HN comment id, tender id). */
  itemId: string;
  /** Exact original request URL. */
  url: string;
  publishedAt: string | null;
  author: string | null;
  organisation: string | null;
  title: string | null;
  /** Plain text of the request. */
  text: string;
  /** First line / title: where sources put structural markers ("SEEKING FREELANCER", "Contract"). */
  header: string;
  /** Status stated by the source itself (procurement), never inferred from the page being online. */
  sourceStatus?: { open: boolean | null; basis: string };
  deadline?: string | null;
  budget?: string | null;
  /** Contact published by the source for this request (procurement contact point). */
  contact?: string | null;
  cpv?: string | null;
  /** E.g. the monthly HN thread the comment belongs to, or the forum section. */
  context?: string;
  /** How a reader replies at this source, when it is not a reply in the thread (job boards). */
  replyHint?: string;
  /** publishedAt is the thread's last activity, not its start (forum feeds), until checked. */
  dateIsActivity?: boolean;
  /** Replies so far, when the source says (forums). */
  replies?: number | null;
}

export type RequestType =
  | 'direct_request' // someone looking for a freelancer / developer for their project
  | 'contract_role' // a company hiring a contractor / freelancer for a role
  | 'rfp' // public request for proposals / tender
  | 'vacancy' // permanent employment
  | 'service_offer' // a developer offering services
  | 'recruiter' // posted by a recruiter / staffing agency on behalf of a client
  | 'advice_only'
  | 'irrelevant';

export type Engagement = 'contractor' | 'agency' | 'employee' | 'unknown';
export type RequestStatus = 'open' | 'closed' | 'unknown';
export type Geo = 'open' | 'target' | 'restricted_other' | 'unknown';
export type Level = 'high' | 'medium' | 'low' | 'none';
/** Whether a contractor working remotely from abroad can take it, as far as the post says. */
export type Remote = 'permitted' | 'prohibited' | 'unknown';

export interface ClassifiedRequest extends RawRequest {
  /** Structural type from the source (HN header, tender); forum posts have none. */
  requestType: RequestType | null;
  buyerCategory: BuyerCategory;
  techFit: TechFit;
  /** Matched capability areas (config/capabilities.yaml). */
  fitAreas: string[];
  /** Poor-fit technologies the request requires / only mentions. */
  mandatoryTech: string[];
  optionalTech: string[];
  remote: Remote;
  /** Older than max_age_days without the source saying it is open, or dated only by its last reply. */
  stale: boolean;
  /** What the operator would still need to know before replying (Russian). */
  missing: string[];
  engagement: Engagement;
  status: RequestStatus;
  statusBasis: string;
  geo: Geo;
  location: string | null;
  technologies: string[];
  intentConfidence: Exclude<Level, 'none'>;
  evidenceQuote: string;
  workRequested: string;
  contactChannel: string | null;
  qualified: boolean;
  /** Why it qualifies or not (operator-facing, Russian). */
  reasons: string[];
  /** Rules could not decide the request type; a candidate for the optional LLM check. */
  ambiguous: boolean;
  classifier: 'rules' | 'llm';
}
