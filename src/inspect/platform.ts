import type { Platform } from './types.js';

const SIGNATURES: [Platform, RegExp][] = [
  ['shopify', /cdn\.shopify\.com|Shopify\.theme|shopify-section/],
  ['woocommerce', /wp-content\/plugins\/woocommerce|woocommerce-/],
  ['wordpress', /wp-content\/|wp-includes\//],
  ['wix', /static\.wixstatic\.com|wix-bolt|_wixCssImports/],
  ['squarespace', /static1\.squarespace\.com|squarespace-cdn/],
  ['tilda', /tildacdn\.|tilda-blocks/],
  ['bitrix', /\/bitrix\/(js|templates|cache)\//],
];

export function detectPlatform(html: string): Platform {
  if (!html) return 'unknown';
  for (const [platform, re] of SIGNATURES) if (re.test(html)) return platform;
  return 'custom';
}

/** Shopify theme name from the inline `Shopify.theme = {...}` object, if present. */
export function shopifyThemeName(html: string): string | null {
  const m = html.match(/Shopify\.theme\s*=\s*\{[^}]*?"name"\s*:\s*"([^"]+)"/);
  return m?.[1] ?? null;
}

export function isShopifyPasswordPage(finalUrl: string, html: string): boolean {
  return /\/password\/?$/.test(new URL(finalUrl).pathname) || /template-password|password-page/i.test(html);
}

const PARKED = /domain (is )?for sale|buy this domain|this domain (name )?(may be|is) (for sale|parked)|parked (free|domain)|sedoparking|hugedomains|dan\.com/i;

export function looksParked(text: string): boolean {
  return PARKED.test(text.slice(0, 5000));
}
