import type { MarketCode, SegmentConfig } from '../config/schema.js';

export interface CandidateCompany {
  name: string | null;
  websiteUrl: string;
  city: string | null;
  sourceRef: string | null;
  query: string | null;
}

export interface DiscoveryParams {
  market: MarketCode;
  segment: SegmentConfig;
  cities: string[];
  limit: number;
}

export interface DiscoverySource {
  id: 'osm' | 'csv';
  markets: MarketCode[];
  termsNote: string;
  discover(params: DiscoveryParams): AsyncIterable<CandidateCompany>;
}

/** OSM `website` values are often missing a scheme or have junk around them. */
export function normalizeWebsite(raw: string): string | null {
  const first = raw.split(/[;\s]/).find(Boolean);
  if (!first) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(first) && !/^https?:\/\//i.test(first)) return null;
  const withScheme = /^https?:\/\//i.test(first) ? first : `https://${first}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin + '/';
  } catch {
    return null;
  }
}
