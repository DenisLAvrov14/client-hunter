// Deterministic HTML checks (spec 8.3). Each is a pure function over fetched pages.
// Only `verified` observations may ever reach an email; `likely` is for the operator's dossier.
import { hasInquiryForm, hasSiteSearch, mailtoAddresses, pageLinks } from './page.js';
import type { ObservationDraft, PageContext } from './types.js';

const CATALOG_PDF_TEXT =
  /catalog|catalogue|catalogus|brochure|price\s*-?\s*list|pricelist|prijslijst|prices|product\s+guide|katalog|prais|каталог|прайс/i;

export function checkPdfCatalog(pages: PageContext[]): ObservationDraft | null {
  for (const page of pages) {
    for (const link of pageLinks(page)) {
      if (!/\.pdf(\?|$)/i.test(link.href)) continue;
      if (CATALOG_PDF_TEXT.test(link.text) || CATALOG_PDF_TEXT.test(new URL(link.href).pathname)) {
        return {
          code: 'PDF_CATALOG',
          status: 'verified',
          description: `Catalogue/price list is published as a PDF (link "${link.text || 'PDF'}" on ${page.url})`,
          evidenceUrl: page.url,
          evidenceDetail: link.href,
        };
      }
    }
  }
  return null;
}

export const PRICE_ON_REQUEST =
  /price on (application|request)|\bPOA\b|call for (a )?price|request (a )?price|contact us for (a )?(price|pricing|quote)|prijs op aanvraag|op aanvraag|цена по запросу|цену уточняйте|узнать цену|цена договорная/i;

export function checkNoQuoteForm(pages: PageContext[]): ObservationDraft | null {
  for (const page of pages) {
    const match = page.text.match(PRICE_ON_REQUEST);
    if (!match) continue;
    const contactOnly = mailtoAddresses(page).length > 0 || page.$('a[href^="tel:" i]').length > 0;
    if (!hasInquiryForm(page) && contactOnly) {
      return {
        code: 'NO_QUOTE_FORM',
        status: 'verified',
        description: `Prices are "${match[0]}" but the page has no enquiry form, only email/phone links`,
        evidenceUrl: page.url,
        evidenceDetail: match[0],
      };
    }
  }
  return null;
}

export function checkMailtoOnlyContact(pages: PageContext[]): ObservationDraft | null {
  const contact = pages.find((p) => p.kind === 'contact');
  if (!contact || hasInquiryForm(contact) || mailtoAddresses(contact).length === 0) return null;
  return {
    code: 'MAILTO_ONLY_CONTACT',
    status: 'likely',
    description: 'Contact page has no form, only email links',
    evidenceUrl: contact.url,
    evidenceDetail: mailtoAddresses(contact).join(', '),
  };
}

export function checkNoSiteSearch(pages: PageContext[], productCount: number | null): ObservationDraft | null {
  if (productCount === null || productCount < 50) return null;
  const home = pages.find((p) => p.kind === 'home');
  if (!home || pages.some(hasSiteSearch)) return null;
  return {
    code: 'NO_SITE_SEARCH',
    status: 'verified',
    description: `No site search found although the catalogue has ${productCount}+ items`,
    evidenceUrl: home.url,
    evidenceDetail: `products>=${productCount}`,
  };
}

export function checkNoViewportMeta(home: PageContext): ObservationDraft | null {
  if (home.$('meta[name="viewport" i]').length > 0) return null;
  return {
    code: 'NO_VIEWPORT_META',
    status: 'verified',
    description: 'Home page has no viewport meta tag, so phones render it as a shrunken desktop page',
    evidenceUrl: home.url,
  };
}

export function checkOutdatedCopyright(home: PageContext, now = new Date()): ObservationDraft | null {
  const years = [...home.text.matchAll(/(?:©|\(c\)|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)].map((m) => Number(m[1]));
  if (years.length === 0) return null;
  const latest = Math.max(...years);
  if (latest > now.getUTCFullYear() - 3 || latest < 1995) return null;
  return {
    code: 'OUTDATED_COPYRIGHT',
    status: 'likely',
    description: `Footer copyright year is ${latest}`,
    evidenceUrl: home.url,
    evidenceDetail: String(latest),
  };
}

export function checkMultipleInquiryChannels(pages: PageContext[]): ObservationDraft | null {
  const all = new Set(pages.flatMap(mailtoAddresses));
  if (all.size < 3) return null;
  return {
    code: 'MULTIPLE_INQUIRY_CHANNELS',
    status: 'likely',
    description: `${all.size} different email addresses for enquiries across the site`,
    evidenceDetail: [...all].join(', '),
  };
}

export function checkNoHttps(finalUrl: string, sslError: string | null): ObservationDraft | null {
  if (sslError) {
    return {
      code: 'SSL_ERROR',
      status: 'verified',
      description: 'HTTPS version of the site fails with a certificate error',
      evidenceUrl: finalUrl,
      evidenceDetail: sslError,
    };
  }
  if (finalUrl.startsWith('http:')) {
    return {
      code: 'NO_HTTPS',
      status: 'verified',
      description: 'Site is served over plain HTTP without HTTPS',
      evidenceUrl: finalUrl,
    };
  }
  return null;
}

/** Runs every HTML-only check. Network/browser checks live in links.ts and mobile.ts. */
export function runHtmlChecks(
  pages: PageContext[],
  opts: { finalUrl: string; sslError: string | null; productCount: number | null },
): ObservationDraft[] {
  const home = pages.find((p) => p.kind === 'home');
  const results = [
    checkPdfCatalog(pages),
    checkNoQuoteForm(pages),
    checkMailtoOnlyContact(pages),
    checkNoSiteSearch(pages, opts.productCount),
    home ? checkNoViewportMeta(home) : null,
    home ? checkOutdatedCopyright(home) : null,
    checkMultipleInquiryChannels(pages),
    checkNoHttps(opts.finalUrl, opts.sslError),
  ];
  return results.filter((r): r is ObservationDraft => r !== null);
}
