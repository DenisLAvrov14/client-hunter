// Hacker News monthly threads via the public HN Algolia API (no login; robots.txt checked by the
// caller). "Ask HN: Freelancer? Seeking freelancer?" holds direct requests ("SEEKING FREELANCER")
// next to developers offering work ("SEEKING WORK"); "Ask HN: Who is hiring?" holds jobs, among them
// contract / freelance roles. Only top-level comments are requests; replies are discussion.
import type { Fetcher } from '../../inspect/fetcher.js';
import { htmlToText } from '../text.js';
import type { IntentSource, RawRequest } from '../types.js';

export const HN_API = 'https://hn.algolia.com/api/v1';
const itemUrl = (id: string | number) => `https://news.ycombinator.com/item?id=${id}`;

interface AlgoliaHit {
  objectID: string;
  title: string;
  created_at: string;
  author: string;
  num_comments?: number;
}
interface AlgoliaItem {
  id: number;
  created_at: string;
  author: string | null;
  text: string | null;
  title?: string | null;
  children?: AlgoliaItem[];
}

const THREADS: Record<'hn_freelance' | 'hn_hiring', { query: string; title: RegExp }> = {
  hn_freelance: { query: '"Freelancer? Seeking freelancer?"', title: /^Ask HN: Freelancer\? Seeking freelancer\? \(/ },
  hn_hiring: { query: '"Ask HN: Who is hiring?"', title: /^Ask HN: Who is hiring\? \(/ },
};

async function getJson<T>(fetcher: Fetcher, url: string): Promise<T> {
  const res = await fetcher.fetch(url);
  if (res.status !== 200) throw new Error(`${url}: HTTP ${res.status}`);
  if (res.truncated) throw new Error(`${url}: response larger than the size limit`);
  return JSON.parse(res.body) as T;
}

/** The monthly threads of the last `months` months, newest first (titles matched exactly). */
export async function hnThreads(fetcher: Fetcher, source: 'hn_freelance' | 'hn_hiring', months: number, now = new Date()): Promise<AlgoliaHit[]> {
  const since = Math.floor(now.getTime() / 1000) - months * 31 * 86400;
  const t = THREADS[source];
  const url = `${HN_API}/search_by_date?query=${encodeURIComponent(t.query)}&tags=story&numericFilters=${encodeURIComponent(`created_at_i>${since}`)}&hitsPerPage=50`;
  const { hits } = await getJson<{ hits: AlgoliaHit[] }>(fetcher, url);
  // One thread per month: the most discussed one with the exact title (same-titled reposts by
  // others, e.g. two "Seeking freelancer?" threads in September 2026, are ignored).
  const byMonth = new Map<string, AlgoliaHit>();
  for (const h of hits.filter((x) => t.title.test(x.title))) {
    const month = h.created_at.slice(0, 7);
    const cur = byMonth.get(month);
    if (!cur || (h.num_comments ?? 0) > (cur.num_comments ?? 0)) byMonth.set(month, h);
  }
  return [...byMonth.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Top-level comments of one thread as raw requests. */
export function commentsOf(thread: AlgoliaItem, source: IntentSource): RawRequest[] {
  return (thread.children ?? [])
    .filter((c) => c.text && c.author) // deleted / flagged comments have no text or author
    .map((c) => {
      const text = htmlToText(c.text!);
      const header = text.split('\n')[0] ?? '';
      // Who-is-hiring headers start with the company: "Acme | Role | REMOTE | Contract".
      const organisation = source === 'hn_hiring' ? (header.split('|')[0]?.trim() || null) : null;
      return {
        source,
        itemId: String(c.id),
        url: itemUrl(c.id),
        publishedAt: new Date(c.created_at).toISOString(),
        author: c.author,
        organisation,
        title: null,
        text,
        header,
        context: thread.title ?? undefined,
      };
    });
}

export async function fetchHn(fetcher: Fetcher, source: 'hn_freelance' | 'hn_hiring', months: number, now = new Date()): Promise<{ requests: RawRequest[]; threads: string[] }> {
  const threads = await hnThreads(fetcher, source, months, now);
  const requests: RawRequest[] = [];
  for (const t of threads) {
    const item = await getJson<AlgoliaItem>(fetcher, `${HN_API}/items/${t.objectID}`);
    requests.push(...commentsOf({ ...item, title: t.title }, source));
  }
  return { requests, threads: threads.map((t) => `${t.title} — ${itemUrl(t.objectID)}`) };
}
