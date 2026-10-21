import type { MarketCode } from '../config/schema.js';
import { logger } from '../util/logger.js';
import { normalizeWebsite, type CandidateCompany, type DiscoveryParams, type DiscoverySource } from './types.js';

const ENDPOINT = 'https://overpass-api.de/api/interpreter';

interface OverpassElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
}

/** Builds an Overpass QL query for elements with a website in the named city. */
export function buildOverpassQuery(city: string, osmTags: string[], timeoutS: number): string {
  const safeCity = city.replace(/["\\]/g, '');
  const selectors = osmTags.flatMap((tag) => {
    const [key, value] = tag.split('=') as [string, string];
    const filter = value === '*' ? `["${key}"]` : `["${key}"="${value}"]`;
    return [`nwr${filter}["website"](area.city);`, `nwr${filter}["contact:website"](area.city);`];
  });
  return [
    `[out:json][timeout:${timeoutS}];`,
    `area["name"="${safeCity}"]["boundary"="administrative"]->.city;`,
    '(',
    ...selectors.map((s) => `  ${s}`),
    ');',
    'out tags;',
  ].join('\n');
}

export function elementToCandidate(el: OverpassElement, city: string): CandidateCompany | null {
  const tags = el.tags ?? {};
  const raw = tags.website ?? tags['contact:website'];
  const websiteUrl = raw ? normalizeWebsite(raw) : null;
  if (!websiteUrl) return null;
  return {
    name: tags.name ?? tags.operator ?? null,
    websiteUrl,
    city,
    sourceRef: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    query: null,
  };
}

export class OsmSource implements DiscoverySource {
  readonly id = 'osm' as const;
  readonly markets: MarketCode[] = ['UK', 'IE', 'NL', 'KZ', 'RU'];
  readonly termsNote = 'ODbL; internal use only, no redistribution. Overpass fair use ~10k req/day. See docs/verification-log.md';

  constructor(
    private readonly userAgent: string,
    private readonly timeoutS: number,
  ) {}

  async *discover(params: DiscoveryParams): AsyncIterable<CandidateCompany> {
    for (const city of params.cities) {
      const query = buildOverpassQuery(city, params.segment.osm_tags, this.timeoutS);
      let elements: OverpassElement[];
      try {
        elements = await this.run(query);
      } catch (err) {
        logger.error({ city, err: (err as Error).message }, 'overpass failed for city, skipping');
        continue;
      }
      logger.info({ city, elements: elements.length }, 'overpass results');
      for (const el of elements) {
        const candidate = elementToCandidate(el, city);
        if (candidate) yield { ...candidate, query: `${params.segment.code} @ ${city}` };
      }
    }
  }

  private async run(query: string): Promise<OverpassElement[]> {
    const attempts = 4;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'user-agent': this.userAgent, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout((this.timeoutS + 30) * 1000),
      });
      if ([429, 502, 503, 504].includes(res.status)) {
        await res.body?.cancel();
        if (attempt === attempts) break;
        // Busy server or no free slot: exponential backoff, as the server itself asks (fair use).
        const wait = 30_000 * 2 ** (attempt - 1);
        logger.warn({ status: res.status, waitMs: wait }, 'overpass busy, backing off');
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
      const data = (await res.json()) as { elements?: OverpassElement[] };
      return data.elements ?? [];
    }
    throw new Error(`Overpass busy after ${attempts} attempts`);
  }
}
