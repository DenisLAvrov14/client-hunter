// Ranking of buyer-intent requests: explicit willingness to commission work, fit with our actual
// services (config/capabilities.yaml), freshness and openness, direct access to the buyer, clarity
// of scope, feasibility of replying. Intent confidence (evidence quality) is kept apart from this score.
import { createHash } from 'node:crypto';
import type { BuyerCategory } from './buyer.js';
import type { TechFit } from './capabilities.js';
import { ageDays } from './classify.js';
import type { ClassifiedRequest } from './types.js';

export interface ScoreParts {
  willingness: number;
  recency: number;
  fit: number;
  access: number;
  clarity: number;
  channel: number;
  total: number;
}

const WILLINGNESS: Record<BuyerCategory, number> = {
  PROJECT_BUYER: 3,
  SERVICE_RECOMMENDATION: 2.5,
  AGENCY_PARTNERSHIP: 1.5,
  POTENTIAL_BUYER: 1,
  STAFFING: 0,
  SERVICE_PROVIDER: 0,
  IRRELEVANT: 0,
};
const FIT: Record<TechFit, number> = { core: 3, adjacent: 2, conditional: 1, poor: 0 };

export function score(c: ClassifiedRequest, now = new Date()): ScoreParts {
  const willingness = WILLINGNESS[c.buyerCategory];
  const age = ageDays(c.publishedAt, now);
  // Last 7 days first, then the last 30; older only with evidence it is still open.
  const recency = (age === null ? 0 : age <= 7 ? 3 : age <= 30 ? 2 : age <= 90 ? 0.5 : 0) + (c.status === 'open' ? 1 : 0);
  const fit = FIT[c.techFit];
  // The person who needs the work (a merchant, a founder) beats an intermediary or a tender process.
  const access = c.buyerCategory === 'PROJECT_BUYER' ? (c.requestType === 'rfp' ? 1 : 2) : c.buyerCategory === 'SERVICE_RECOMMENDATION' ? 1.5 : c.buyerCategory === 'AGENCY_PARTNERSHIP' ? 1 : 0;
  const clarity = (c.budget ? 1 : 0) + (c.fitAreas.length ? 0.5 : 0) + (c.deadline ? 0.5 : 0);
  const channel = c.contactChannel ? (c.remote === 'permitted' ? 1 : c.remote === 'unknown' ? 0.5 : 0) : 0;
  return { willingness, recency, fit, access, clarity, channel, total: willingness + recency + fit + access + clarity + channel };
}

/** Same request reposted (HN companies repost every month): same poster + same normalised header. */
export function contentHash(c: Pick<ClassifiedRequest, 'source' | 'author' | 'organisation' | 'header'>): string {
  const norm = c.header.toLowerCase().replace(/\d+/g, '#').replace(/[^\p{L}#]+/gu, ' ').trim();
  return createHash('sha256').update(`${c.source}|${(c.organisation ?? c.author ?? '').toLowerCase()}|${norm}`).digest('hex').slice(0, 32);
}

export interface RankedRequest extends ClassifiedRequest {
  score: ScoreParts;
  /** Older posts of the same request that were collapsed into this one. */
  reposts: string[];
  /** The URL already appeared in an earlier discovery report (not a new lead). */
  seenBefore?: string | null;
}

/** Qualified first, then by score; reposts collapsed into their newest post. */
export function rankRequests(list: ClassifiedRequest[], now = new Date()): RankedRequest[] {
  const groups = new Map<string, ClassifiedRequest[]>();
  for (const c of list) {
    const h = contentHash(c);
    groups.set(h, [...(groups.get(h) ?? []), c]);
  }
  const ranked = [...groups.values()].map((g): RankedRequest => {
    const sorted = [...g].sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
    return { ...sorted[0]!, score: score(sorted[0]!, now), reposts: sorted.slice(1).map((x) => x.url) };
  });
  return ranked.sort((a, b) => Number(b.qualified) - Number(a.qualified) || b.score.total - a.score.total || (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
}
