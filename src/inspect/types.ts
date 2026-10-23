import type { CheerioAPI } from 'cheerio';

// 'workflow' = a customer action page: quote request, booking, ordering, pricing. Pages saved
// before migration 002 may still carry the old kind 'quote'.
export type PageKind =
  | 'home'
  | 'about'
  | 'services'
  | 'catalog'
  | 'contact'
  | 'workflow'
  | 'product'
  | 'legal'
  | 'other';

export type ObservationCode =
  | 'PDF_CATALOG'
  | 'NO_QUOTE_FORM'
  | 'MAILTO_ONLY_CONTACT'
  | 'NO_SITE_SEARCH'
  | 'MOBILE_OVERFLOW'
  | 'NO_VIEWPORT_META'
  | 'SMALL_TAP_TARGETS'
  | 'SLOW_MOBILE'
  | 'BROKEN_INTERNAL_LINKS'
  | 'BROKEN_IMAGES'
  | 'OUTDATED_COPYRIGHT'
  | 'NO_HTTPS'
  | 'SSL_ERROR'
  | 'FORM_JS_ERROR'
  | 'MULTIPLE_INQUIRY_CHANNELS';

export type ObservationStatus = 'verified' | 'likely' | 'unknown';

/** An observation before it is persisted (no id/company yet). */
export interface ObservationDraft {
  code: ObservationCode;
  status: ObservationStatus;
  description: string;
  evidenceUrl?: string;
  evidenceDetail?: string;
  screenshotPath?: string;
}

export interface PageContext {
  url: string;
  kind: PageKind;
  status: number;
  html: string;
  $: CheerioAPI;
  /** Visible text, whitespace-collapsed. */
  text: string;
}

export type Platform =
  | 'shopify'
  | 'woocommerce'
  | 'wordpress'
  | 'wix'
  | 'squarespace'
  | 'tilda'
  | 'bitrix'
  | 'custom'
  | 'unknown';
