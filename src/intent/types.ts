// Buyer-intent leads: public requests where someone explicitly wants to hire or pay for
// development work. Nothing here is inferred from a website's shortcomings (docs/decisions.md).

export type IntentSource = 'hn_freelance' | 'hn_hiring' | 'uk_contracts_finder';

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
  /** E.g. the monthly HN thread the comment belongs to. */
  context?: string;
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

export interface ClassifiedRequest extends RawRequest {
  requestType: RequestType;
  engagement: Engagement;
  status: RequestStatus;
  statusBasis: string;
  geo: Geo;
  location: string | null;
  technologies: string[];
  skillFit: Level;
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
