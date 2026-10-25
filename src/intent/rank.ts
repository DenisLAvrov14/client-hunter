// Ranking of buyer-intent requests: explicit willingness to hire/pay, recency and openness, skill
// match, direct access to the decision-maker, clarity of scope, feasibility of replying. Intent
// confidence (evidence quality) is kept apart from this commercial score.
import { createHash } from 'node:crypto';
import type { ClassifiedRequest } from './types.js';

export interface ScoreParts {
  willingness: number;
  recency: number;
  skill: number;
  access: number;
  clarity: number;
  channel: number;
  total: number;
}

export function ageDays(c: ClassifiedRequest, now: Date): number | null {
  return c.publishedAt ? Math.max(0, Math.floor((now.getTime() - new Date(c.publishedAt).getTime()) / 86400_000)) : null;
}

export function score(c: ClassifiedRequest, now = new Date()): ScoreParts {
  const willingness = { direct_request: 3, contract_role: 2.5, rfp: 2 }[c.requestType as 'direct_request'] ?? 0;
  const age = ageDays(c, now);
  // A clear request from yesterday outranks a vague one from months ago.
  const recency = (age === null ? 0 : age <= 14 ? 3 : age <= 45 ? 2 : age <= 120 ? 1 : 0) + (c.status === 'open' ? 1 : 0);
  const skill = { high: 3, medium: 2, low: 1, none: 0 }[c.skillFit];
  const access = c.requestType === 'direct_request' ? 2 : c.requestType === 'contract_role' ? 1.5 : c.requestType === 'rfp' ? 1 : 0;
  const clarity = (c.budget ? 1 : 0) + (c.technologies.length >= 2 ? 0.5 : 0) + (c.deadline ? 0.5 : 0);
  const channel = c.contactChannel ? (c.geo === 'target' || c.geo === 'open' ? 1 : 0.5) : 0;
  return { willingness, recency, skill, access, clarity, channel, total: willingness + recency + skill + access + clarity + channel };
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
