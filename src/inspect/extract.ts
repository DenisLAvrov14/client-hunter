import { load } from 'cheerio';
import { registrableDomain } from '../util/domain.js';
import { pageLinks } from './page.js';
import type { PageContext } from './types.js';

// Chrome, boilerplate and widgets that say nothing about the business itself. Not <form>:
// old ASP.NET sites wrap the whole page in one form.
const DROP_SELECTORS = [
  'script', 'style', 'noscript', 'template', 'svg', 'iframe', 'button', 'select', 'input', 'textarea', 'label',
  'nav', 'aside',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="dialog"]', '[aria-hidden="true"]',
].join(', ');
// Whole class/id tokens only, so a wrapper like id="shared-layout" survives.
const DROP_CLASS_OR_ID =
  /(^|[\s_-])(cookies?|consent|gdpr|newsletter|popup|modal|breadcrumbs?|skip-link|share|sharing|social)([\s_-]|$)/i;

const BLOCK_TAGS = 'p, h1, h2, h3, h4, h5, h6, li, dt, dd, td, th, blockquote, figcaption, address, div, section, article, br';

/** Main content lines of a page: largest of main/article/body after dropping chrome; one line per block. */
export function mainTextLines(html: string): string[] {
  const $ = load(html);
  $(DROP_SELECTORS).remove();
  // Site header/footer go; an article's own <header> (its title) stays.
  $('header, footer')
    .filter((_, el) => $(el).parents('main, article').length === 0)
    .remove();
  $('[class], [id]').each((_, el) => {
    const node = $(el);
    if (DROP_CLASS_OR_ID.test(`${node.attr('class') ?? ''} ${node.attr('id') ?? ''}`)) node.remove();
  });

  const candidates = [...$('main, [role="main"], article').toArray()];
  let root = $('body');
  let best = 0;
  for (const el of candidates) {
    const len = $(el).text().replace(/\s+/g, ' ').length;
    if (len > best) {
      best = len;
      root = $(el);
    }
  }
  // A <main> holding only a fragment of the content is worse than the whole body.
  if (best < 200) root = $('body');

  root.find(BLOCK_TAGS).each((_, el) => {
    $(el).prepend('\n').append('\n');
  });
  return root
    .text()
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length >= 3);
}

/**
 * Removes lines repeated on two or more pages of the same site (menus, footers, banners
 * that survived DROP_SELECTORS) and duplicate lines within a page.
 */
export function dedupeAcrossPages(pagesLines: string[][]): string[][] {
  const seenOn = new Map<string, number>();
  for (const lines of pagesLines) {
    for (const line of new Set(lines)) seenOn.set(line, (seenOn.get(line) ?? 0) + 1);
  }
  const shared = pagesLines.length >= 2;
  return pagesLines.map((lines) => {
    const out: string[] = [];
    const local = new Set<string>();
    for (const line of lines) {
      if (local.has(line) || (shared && (seenOn.get(line) ?? 0) >= 2)) continue;
      local.add(line);
      out.push(line);
    }
    return out;
  });
}

export function capText(lines: string[], maxChars: number): string {
  let out = '';
  for (const line of lines) {
    if (out.length + line.length + 1 > maxChars) {
      if (out.length === 0) out = line.slice(0, maxChars);
      break;
    }
    out += (out ? '\n' : '') + line;
  }
  return out;
}

export interface PageLink {
  url: string;
  text: string;
}

/** Internal links with anchor text, nav links first, deduplicated, capped. Used to pick targeted extra pages. */
export function internalLinks(page: PageContext, max: number): PageLink[] {
  const domain = registrableDomain(page.url);
  const links = pageLinks(page).filter((l) => registrableDomain(l.href) === domain && l.text.length > 0);
  links.sort((a, b) => Number(b.inNav) - Number(a.inNav));
  const seen = new Set<string>();
  const out: PageLink[] = [];
  for (const l of links) {
    const key = l.href.replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: l.href, text: l.text.slice(0, 80) });
    if (out.length >= max) break;
  }
  return out;
}

/** Main text for every page, deduplicated across the site and capped per page. */
export function extractMainTexts(pages: PageContext[], maxCharsPerPage: number): string[] {
  return dedupeAcrossPages(pages.map((p) => mainTextLines(p.html))).map((lines) => capText(lines, maxCharsPerPage));
}
