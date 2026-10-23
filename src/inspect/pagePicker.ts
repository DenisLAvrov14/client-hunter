import { registrableDomain } from '../util/domain.js';
import { pageLinks } from './page.js';
import type { PageContext, PageKind } from './types.js';

// Order = priority when the page budget is tight: pages that explain the business and how
// customers buy come first; legal pages only fill spare slots.
// EN / NL / RU words, plus RU transliterations common in URLs (kontakty, katalog, o-kompanii).
const KIND_RULES: [PageKind, RegExp][] = [
  ['about', /about|who-we-are|our-story|company|over-ons|over-|o-kompanii|o-nas|о-компании|о-нас|о компании/i],
  ['services', /services|diensten|what-we-do|solutions|oplossingen|portfolio|our-work|werkzaamheden|uslugi|услуг|наши работы/i],
  ['catalog', /catalog|catalogue|catalogus|products|producten|assortiment|range|shop|collections|brochure|katalog|produkc|tovar|каталог|продукц|товар/i],
  ['contact', /contact|get-in-touch|kontakt|контакт|enquir|svyaz|связь/i],
  ['workflow', /quote|quotation|request-a-price|offerte|booking|book-online|appointment|reserv|afspraak|how-to-order|bestellen|order|pricing|prices|price|tarieven|prijs|zakaz|zapis|prais|stoimost|заказ|запис|прайс|стоимост|цен[аы]/i],
  ['legal', /terms|legal|privacy|impressum|imprint|disclaimer|cookie|voorwaarden|privacybeleid|rekvizit|politika|konfidenc|реквизит|политик/i],
];

// Files, account/checkout flows, and individual blog/news articles (we read about the business, not its blog).
const SKIP =
  /\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?)(\?|$)|\/(cart|checkout|account|login|basket|wp-admin)\b|\/(blog|news|nieuws|novosti|articles?|stati|press|tag|category)\/[^/?#]+/i;

export function classifyLink(href: string, text: string): PageKind | null {
  const path = new URL(href).pathname;
  for (const [kind, re] of KIND_RULES) if (re.test(path) || re.test(text)) return kind;
  return null;
}

/** Picks up to `max` internal pages to fetch, one per kind first (spec 8.1 step 4). */
export function pickPages(home: PageContext, max: number): { url: string; kind: PageKind }[] {
  const domain = registrableDomain(home.url);
  const seen = new Set<string>([home.url.replace(/\/$/, '')]);
  const byKind = new Map<PageKind, string[]>();

  for (const link of pageLinks(home)) {
    if (registrableDomain(link.href) !== domain || SKIP.test(link.href)) continue;
    const key = link.href.replace(/\/$/, '');
    if (seen.has(key)) continue;
    const kind = classifyLink(link.href, link.text);
    if (!kind) continue;
    seen.add(key);
    byKind.set(kind, [...(byKind.get(kind) ?? []), link.href]);
  }

  const picked: { url: string; kind: PageKind }[] = [];
  // Round-robin over kinds in priority order: first about, first services, ..., then second of each.
  for (let round = 0; picked.length < max; round++) {
    let added = false;
    for (const [kind] of KIND_RULES) {
      const url = byKind.get(kind)?.[round];
      if (url && picked.length < max) {
        picked.push({ url, kind });
        added = true;
      }
    }
    if (!added) break;
  }
  return picked;
}
