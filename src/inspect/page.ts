import { load } from 'cheerio';
import type { PageContext, PageKind } from './types.js';

const BLOCK_OR_LINK =
  'p, div, section, article, header, footer, nav, aside, main, h1, h2, h3, h4, h5, h6, li, dt, dd, td, th, tr, br, a, button, label, option, blockquote, figcaption';

export function buildPageContext(url: string, kind: PageKind, status: number, html: string): PageContext {
  const $ = load(html);
  const $text = load(html);
  $text('script, style, noscript, template, svg').remove();
  // cheerio's text() glues adjacent elements ("<h1>A</h1><p>Sign in</p>" → "ASign in"), which breaks
  // word-boundary patterns such as the login and booking detectors. Separate them first.
  $text(BLOCK_OR_LINK).after(' ');
  const text = $text('body').text().replace(/\s+/g, ' ').trim();
  return { url, kind, status, html, $, text };
}

/** Absolute http(s) links from the page, with their visible text. */
export function pageLinks(page: PageContext): { href: string; text: string; inNav: boolean }[] {
  const out: { href: string; text: string; inNav: boolean }[] = [];
  page.$('a[href]').each((_, el) => {
    const raw = page.$(el).attr('href')?.trim();
    if (!raw || raw.startsWith('#') || /^(javascript|mailto|tel):/i.test(raw)) return;
    let href: string;
    try {
      href = new URL(raw, page.url).toString();
    } catch {
      return;
    }
    if (!/^https?:/.test(href)) return;
    const inNav = page.$(el).closest('nav, header, [role="navigation"]').length > 0;
    out.push({ href: href.split('#')[0]!, text: page.$(el).text().replace(/\s+/g, ' ').trim(), inNav });
  });
  return out;
}

export function mailtoAddresses(page: PageContext): string[] {
  const out = new Set<string>();
  page.$('a[href^="mailto:" i]').each((_, el) => {
    const addr = decodeURIComponent(page.$(el).attr('href')!.slice(7).split('?')[0]!)
      .trim()
      .toLowerCase();
    if (addr) out.add(addr);
  });
  return [...out];
}

/** Forms that look like real user input forms (not newsletter or site search). */
export function hasInquiryForm(page: PageContext): boolean {
  let found = false;
  page.$('form').each((_, el) => {
    const form = page.$(el);
    const isSearch =
      form.attr('role') === 'search' || form.find('input[type="search"], input[name="q"], input[name="s"]').length > 0;
    const fields = form.find('textarea, input:not([type="hidden"]):not([type="submit"]):not([type="button"])').length;
    const newsletterOnly = fields <= 1 && form.find('input[type="email"]').length === 1 && !form.find('textarea').length;
    if (!isSearch && !newsletterOnly && fields >= 2) found = true;
  });
  // Embedded form builders render via iframes/scripts.
  if (!found && /hsforms|hs-form|typeform|jotform|formstack|wpforms|gravityforms|contact-form-7|wpcf7/i.test(page.html)) {
    found = true;
  }
  return found;
}

export function hasSiteSearch(page: PageContext): boolean {
  return (
    page.$('input[type="search"], form[role="search"], [role="search"], form[action*="search" i], input[name="q"]')
      .length > 0
  );
}
