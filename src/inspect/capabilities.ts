// What the site already offers its customers. Computed by code so the LLM never proposes
// something the business already has (e.g. "add online booking" next to a Calendly widget).
import { PRICE_ON_REQUEST } from './checks.js';
import { hasInquiryForm, hasSiteSearch, pageLinks } from './page.js';
import type { PageContext, Platform } from './types.js';

export type CapabilityKey =
  | 'cart_checkout'
  | 'inquiry_form'
  | 'online_booking'
  | 'calculator_configurator'
  | 'site_search'
  | 'prices_visible'
  | 'price_on_request'
  | 'customer_login'
  | 'live_chat'
  | 'messenger_links';

export interface Capability {
  present: boolean;
  evidenceUrl?: string;
  detail?: string;
}

export interface Capabilities {
  flags: Record<CapabilityKey, Capability>;
  languages: string[];
  productLinkCount: number | null;
}

const BOOKING_WIDGETS =
  /calendly\.com|fresha\.com|booksy\.com|setmore\.com|acuityscheduling\.com|simplybook\.|treatwell\.|yclients\.com|dikidi\.|squareup\.com\/appointments|timely\.|youcanbook\.me|salonized\.com|bookings\.|zcal\.co|cal\.com\//i;
const BOOKING_TEXT =
  /book (now|online|an appointment|a table|a session)|online booking|schedule (a|an|your) (call|appointment|visit)|online (boeken|reserveren)|afspraak maken|записаться (онлайн|на приём|на прием)|онлайн[- ]запись|забронировать/i;
const CALCULATOR = /calculator|configurator|build your own|price estimator|rekenmodule|калькулятор|конфигуратор|рассчитать стоимость/i;
// Non-zero amounts only: an empty mini-cart ("£0.00") is not a price list. The whole amount is
// captured ("£204.00", not "£2"): the match is shown to the model as evidence.
const PRICE_VISIBLE = /[£€$]\s?[1-9][\d,]*(?:\.\d{1,2})?|[1-9][\d\s.,]*\s?(€|eur\b|gbp\b|руб|₽|₸|тг\b|тенге)/i;
const LOGIN = /\b(log ?in|sign in|my account|customer portal|client area|inloggen|mijn account)\b|личный кабинет|войти/i;
// Matched on widget script hosts, not product words ("intercom" is also a door-entry product).
const LIVE_CHAT =
  /embed\.tawk\.to|widget\.intercom\.io|js\.intercomcdn\.com|code\.jivosite\.com|code\.jivo\.ru|client\.crisp\.chat|cdn\.livechatinc\.com|code\.tidio\.co|static\.zdassets\.com|js\.driftt\.com|js\.hs-scripts\.com|static\.olark\.com|smartsuppchat\.com|call\.chatra\.io|crm\/site_button|b24-widget|livetex\.ru|carrotquest\.io/i;
const MESSENGERS = /wa\.me\/|api\.whatsapp\.com|web\.whatsapp\.com|t\.me\/|telegram\.me\/|viber:\/\/|m\.me\//i;
const CART = /\/(cart|basket|checkout|winkelwagen|korzina|корзина)\b|add[-_ ]to[-_ ]cart|woocommerce-cart|data-add-to-cart|в корзину|in winkelwagen/i;
const PRODUCT_URL = /\/(products?|product-page|item|p|shop|tovar|catalog|catalogue|produkt|artikel)\/[^/?#]+/i;

function find(pages: PageContext[], test: (p: PageContext) => string | null): Capability {
  for (const p of pages) {
    const detail = test(p);
    if (detail) return { present: true, evidenceUrl: p.url, detail: detail.slice(0, 120) };
  }
  return { present: false };
}

const match = (re: RegExp, s: string) => s.match(re)?.[0] ?? null;

export function detectCapabilities(pages: PageContext[], platform: Platform, productCount: number | null): Capabilities {
  const flags: Record<CapabilityKey, Capability> = {
    cart_checkout:
      platform === 'shopify' || platform === 'woocommerce'
        ? { present: true, evidenceUrl: pages[0]?.url, detail: `${platform} store` }
        : find(pages, (p) => match(CART, p.html)),
    inquiry_form: find(pages, (p) => (hasInquiryForm(p) ? 'enquiry form' : null)),
    online_booking: find(pages, (p) => match(BOOKING_WIDGETS, p.html) ?? match(BOOKING_TEXT, p.text)),
    calculator_configurator: find(pages, (p) => match(CALCULATOR, p.text)),
    site_search: find(pages, (p) => (hasSiteSearch(p) ? 'search box' : null)),
    prices_visible: find(pages, (p) => match(PRICE_VISIBLE, p.text)),
    price_on_request: find(pages, (p) => match(PRICE_ON_REQUEST, p.text)),
    customer_login: find(pages, (p) => match(LOGIN, p.text)),
    live_chat: find(pages, (p) => match(LIVE_CHAT, p.html)),
    messenger_links: find(pages, (p) => match(MESSENGERS, p.html)),
  };

  const languages = new Set<string>();
  for (const p of pages) {
    const lang = p.$('html').attr('lang')?.trim().toLowerCase().slice(0, 2);
    if (lang) languages.add(lang);
    p.$('link[rel="alternate"][hreflang]').each((_, el) => {
      const hl = p.$(el).attr('hreflang')?.toLowerCase().slice(0, 2);
      if (hl && hl !== 'x-') languages.add(hl);
    });
  }

  let productLinkCount: number | null = productCount;
  if (productLinkCount === null) {
    const catalogPages = pages.filter((p) => p.kind === 'catalog');
    if (catalogPages.length > 0) {
      const urls = new Set(catalogPages.flatMap((p) => pageLinks(p).map((l) => l.href)).filter((h) => PRODUCT_URL.test(new URL(h).pathname)));
      productLinkCount = urls.size;
    }
  }

  return { flags, languages: [...languages].sort(), productLinkCount };
}
