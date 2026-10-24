// Input for stage C: the regular digest with a larger budget, plus the site's known internal
// links (the only URLs the model may ask to read), contact availability, and any extra pages
// already read for this analysis. Website text stays fenced as untrusted data.
import type { Db } from '../db/connection.js';
import { buildDigest, type Digest } from '../inspect/digest.js';
import type { PageLink } from '../inspect/extract.js';

export interface ExtraPage {
  url: string;
  text: string;
}

export interface DeepInput {
  digest: Digest;
  text: string;
  /** URLs the model may request (normalized without trailing slash/hash). */
  knownLinks: Map<string, string>;
}

const LINKS_MAX_CHARS = 3000;
export const EXTRA_PAGE_MAX_CHARS = 3000;

export const normalizeLink = (u: string) => u.split('#')[0]!.replace(/\/$/, '');

// Not pages the model can usefully request: CDN/anti-scraping endpoints (Cloudflare email
// protection is an anti-harvesting measure, never fetched) and documents or media, which the
// extra-page reader skips as non-HTML anyway.
const NOT_A_PAGE = /\/cdn-cgi\/|\.(pdf|docx?|xlsx?|pptx?|zip|rar|jpe?g|png|gif|webp|svg|mp4|mp3)(\?|$)/i;
/** A page read with less main text than this is flagged: content may sit on its sub-pages. */
const THIN_PAGE_CHARS = 200;

export function buildDeepInput(db: Db, companyId: string, digestMaxChars: number, extra: ExtraPage[] = []): DeepInput | null {
  const digest = buildDigest(db, companyId, digestMaxChars);
  if (!digest) return null;

  const pages = db
    .prepare(`SELECT url, links_json, length(trim(coalesce(main_text, ''))) AS chars FROM pages WHERE inspection_id = ? ORDER BY fetched_at, url`)
    .all(digest.inspectionId) as { url: string; links_json: string | null; chars: number }[];
  const thinPages = pages.filter((p) => p.chars < THIN_PAGE_CHARS).map((p) => p.url);
  const read = new Set([...pages.map((p) => normalizeLink(p.url)), ...extra.map((e) => normalizeLink(e.url))]);
  const knownLinks = new Map<string, string>();
  for (const p of pages) {
    for (const l of (p.links_json ? JSON.parse(p.links_json) : []) as PageLink[]) {
      const key = normalizeLink(l.url);
      if (!read.has(key) && !knownLinks.has(key) && !NOT_A_PAGE.test(key)) knownLinks.set(key, l.text);
    }
  }

  const contact = db
    .prepare('SELECT contact_status FROM inspections WHERE id = ?')
    .get(digest.inspectionId) as { contact_status: string | null } | undefined;
  const channelKinds = (
    db
      .prepare('SELECT DISTINCT channel FROM contact_channels WHERE company_id = ? AND last_inspection_id = ? ORDER BY channel')
      .all(companyId, digest.inspectionId) as { channel: string }[]
  ).map((r) => r.channel);

  const linkLines: string[] = [];
  let used = 0;
  for (const [url, anchor] of knownLinks) {
    const line = `- ${url} — ${anchor}`;
    if (used + line.length > LINKS_MAX_CHARS) break;
    linkLines.push(line);
    used += line.length;
  }

  const extraBlocks = extra.map((e) => {
    const text = e.text.replace(/<\/?website_content>/gi, '').slice(0, EXTRA_PAGE_MAX_CHARS);
    digest.pageTexts.set(e.url, text);
    return `### [extra] ${e.url}\n${text}`;
  });

  const text = [
    digest.text,
    '',
    `## Contact availability (code): ${contact?.contact_status ?? 'unknown'}${channelKinds.length ? ` · other channels: ${channelKinds.join(', ')}` : ''}`,
    '',
    ...(thinPages.length
      ? [`## Pages read but with almost no text (content may be on their sub-pages): ${thinPages.join(', ')}`, '']
      : []),
    '## Known internal links (you may request up to 3 of these exact URLs in need_pages)',
    linkLines.length ? linkLines.join('\n') : '- none',
    ...(extraBlocks.length
      ? ['', '## Additional pages read for this analysis', '<website_content>', extraBlocks.join('\n\n'), '</website_content>']
      : []),
  ].join('\n');

  return { digest, text, knownLinks };
}
