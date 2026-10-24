// Public business contact channels other than email (email: extract.ts). Only what the site
// publishes as a way to reach the business: explicit tel:/WhatsApp/Telegram links, labelled
// phone numbers on the contact page or in the header/footer, and enquiry forms. Nothing is
// ever sent or submitted.
import type { MarketCode } from '../config/schema.js';
import { hasInquiryForm } from '../inspect/page.js';
import type { PageContext } from '../inspect/types.js';

export type ChannelKind = 'form' | 'phone' | 'whatsapp' | 'telegram';

export interface ContactChannel {
  channel: ChannelKind;
  /** Page URL, phone (+E.164 only when certain, otherwise as published), https://wa.me/<digits>, https://t.me/<username>. */
  value: string;
  /** De-duplication key; for a national-format phone the assumed +E.164, so "0161…" and "+44 161…" match. */
  matchKey: string;
  /** True when the value could not be confirmed, e.g. the country of a national-format phone. */
  uncertain: boolean;
  /** What is uncertain (operator-facing, Russian), or null. */
  note: string | null;
  /** As published on the site. */
  display: string | null;
  sourceUrl: string;
}

// Third-party voices on the page (comments, reviews, quotes): their numbers are not the business's.
const FOREIGN_TOKEN = /^(comments?|reviews?|testimonials?|disqus|quote)([-_]|$)/i;

/** A DOM node as accepted by the page's cheerio instance (avoids importing parser internals). */
type DomNode = Parameters<PageContext['$']>[0];

function inForeignContent(page: PageContext, el: DomNode): boolean {
  // The element itself and its ancestors.
  return page
    .$(el)
    .parents()
    .addBack()
    .toArray()
    .some((p) => {
      if ('tagName' in p && p.tagName === 'blockquote') return true;
      const tokens = `${page.$(p).attr('class') ?? ''} ${page.$(p).attr('id') ?? ''}`.split(/\s+/);
      return tokens.some((t) => FOREIGN_TOKEN.test(t));
    });
}

const NATIONAL_PREFIX: Partial<Record<MarketCode, string>> = { UK: '44', IE: '353', NL: '31' };

export interface NormalizedPhone {
  /** +E.164 when certain; otherwise the digits as published (never a guessed international number). */
  value: string;
  /** Assumed +E.164 for de-duplication, or the digits when nothing can be assumed. */
  matchKey: string;
  uncertain: boolean;
  note: string | null;
}

/**
 * Certain only with an international prefix (+ / 00) or the unambiguous +7 national format
 * (8/7 + 10 digits). A national number ("0161 …") keeps its published digits and is flagged:
 * the business may list a number from another country. Null if it cannot be a phone number.
 */
export function normalizePhone(raw: string, market: MarketCode): NormalizedPhone | null {
  // "+44 (0)161 …": the bracketed trunk 0 is not dialled internationally.
  const cleaned = raw.replace(/\(\s*0\s*\)/g, '').replace(/[^\d+]/g, '');
  let digits = cleaned.replace(/\+/g, '');
  let international = cleaned.startsWith('+');
  if (!international && digits.startsWith('00')) {
    digits = digits.slice(2);
    international = true;
  }
  if (digits.length < 8 || digits.length > 15) return null;
  if (international) return { value: `+${digits}`, matchKey: `+${digits}`, uncertain: false, note: null };

  if ((market === 'RU' || market === 'KZ') && digits.length === 11 && /^[78]/.test(digits)) {
    const e164 = `+7${digits.slice(1)}`;
    return { value: e164, matchKey: e164, uncertain: false, note: null };
  }
  const cc = NATIONAL_PREFIX[market];
  if (cc && /^0[1-9]/.test(digits)) {
    return {
      value: digits,
      matchKey: `+${cc}${digits.slice(1)}`,
      uncertain: true,
      note: `национальный формат: страна предположительно ${market} (+${cc}), не подтверждено`,
    };
  }
  return { value: digits, matchKey: digits, uncertain: true, note: 'формат номера не распознан, сохранён как опубликован' };
}

// "Tel: 0161 496 0000", "Телефон: +7 (727) 000-00-00", "Telefoon 020 123 4567".
const LABELLED_PHONE =
  /(?:\btel(?:ephone)?|\bphone|\bcall(?: us)?|\bmob(?:ile)?|\btelefoon|\bbel ons|телефон|\bтел)\.?\s*[:.]?\s*(\+?\d[\d\s().-]{6,}\d)/giu;

function phonesFrom(page: PageContext, market: MarketCode, add: (c: ContactChannel) => void): void {
  page.$('a[href^="tel:" i]').each((_, el) => {
    if (inForeignContent(page, el)) return;
    const raw = decodeURIComponent(page.$(el).attr('href')!.slice(4));
    const phone = normalizePhone(raw, market);
    if (phone) add({ channel: 'phone', ...phone, display: page.$(el).text().trim() || raw, sourceUrl: page.url });
  });
  // Labelled numbers in plain text: only where a business lists its own contacts.
  const regions = page.kind === 'contact' ? page.$('body') : page.$('header, footer, address, [itemprop="telephone"]');
  regions.each((_, region) => {
    if (inForeignContent(page, region)) return;
    const text = page
      .$(region)
      .find('*')
      .addBack()
      .contents()
      .toArray()
      .filter((n) => n.type === 'text' && (!n.parent || !inForeignContent(page, n.parent)))
      .map((n) => ('data' in n ? String(n.data) : ''))
      .join(' ');
    for (const m of text.matchAll(LABELLED_PHONE)) {
      const phone = normalizePhone(m[1]!, market);
      if (phone) add({ channel: 'phone', ...phone, display: m[1]!.trim(), sourceUrl: page.url });
    }
  });
}

/** Only links that open a chat with the business; "share this page" links are not contacts. */
export function whatsappValue(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, '');
  if (host === 'wa.me') {
    const [first, second] = url.pathname.split('/').filter(Boolean);
    if (first && /^\d{8,15}$/.test(first)) return `https://wa.me/${first}`;
    if (first === 'message' && second) return `https://wa.me/message/${second}`; // WhatsApp Business short link
    return null;
  }
  if (host === 'api.whatsapp.com' || host === 'web.whatsapp.com' || url.protocol === 'whatsapp:') {
    const phone = (url.searchParams.get('phone') ?? '').replace(/\D/g, '');
    return /^\d{8,15}$/.test(phone) ? `https://wa.me/${phone}` : null;
  }
  return null;
}

const TELEGRAM_RESERVED = new Set(['share', 'joinchat', 'addstickers', 'addemoji', 'proxy', 'socks', 'iv', 'login', 'setlanguage']);

/** Public username links only; share links and private group invites are skipped. */
export function telegramValue(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  let name: string | undefined;
  if (url.protocol === 'tg:') {
    name = url.searchParams.get('domain') ?? undefined;
  } else if (['t.me', 'telegram.me', 'telegram.dog'].includes(url.hostname.replace(/^www\./, ''))) {
    const parts = url.pathname.split('/').filter(Boolean);
    name = parts[0] === 's' ? parts[1] : parts[0]; // t.me/s/<channel> is a channel preview
  }
  if (!name || name.startsWith('+') || TELEGRAM_RESERVED.has(name.toLowerCase())) return null;
  return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(name) ? `https://t.me/${name.toLowerCase()}` : null;
}

const certain = (channel: ChannelKind, value: string, display: string | null, sourceUrl: string): ContactChannel => ({
  channel,
  value,
  matchKey: value,
  uncertain: false,
  note: null,
  display,
  sourceUrl,
});

/**
 * All non-email channels found on the inspected pages, de-duplicated per channel + match key.
 * The first source wins; an uncertain value is replaced by a certain one for the same key.
 */
export function extractChannels(pages: PageContext[], market: MarketCode): ContactChannel[] {
  const found = new Map<string, ContactChannel>();
  const add = (c: ContactChannel) => {
    const key = `${c.channel}|${c.matchKey}`;
    const prev = found.get(key);
    if (!prev) found.set(key, c);
    else if (prev.uncertain && !c.uncertain) found.set(key, { ...prev, value: c.value, uncertain: false, note: null });
  };
  for (const page of pages) {
    // A login or account form is not a way to contact the business.
    if (hasInquiryForm(page) && page.$('form input[type="password"]').length === 0) {
      add(certain('form', page.url.split('#')[0]!, null, page.url));
    }
    phonesFrom(page, market, add);
    page.$('a[href]').each((_, el) => {
      if (inForeignContent(page, el)) return;
      const href = page.$(el).attr('href')!.trim();
      const wa = whatsappValue(href);
      if (wa) add(certain('whatsapp', wa, href, page.url));
      const tg = telegramValue(href);
      if (tg) add(certain('telegram', tg, href, page.url));
    });
  }
  return [...found.values()];
}
