import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkMailtoOnlyContact,
  checkMultipleInquiryChannels,
  checkNoHttps,
  checkNoQuoteForm,
  checkNoSiteSearch,
  checkNoViewportMeta,
  checkOutdatedCopyright,
  checkPdfCatalog,
} from '../src/inspect/checks.js';
import { isPublicAddress } from '../src/inspect/fetcher.js';
import { buildPageContext, hasInquiryForm } from '../src/inspect/page.js';
import { pickPages } from '../src/inspect/pagePicker.js';
import { detectPlatform, looksParked, shopifyThemeName } from '../src/inspect/platform.js';
import { parseRobots } from '../src/inspect/robots.js';

const fixture = (name: string) => readFileSync(path.resolve('tests/fixtures/sites', name), 'utf8');
const BASE = 'https://www.northbridge-example.co.uk/';
const home = buildPageContext(BASE, 'home', 200, fixture('b2b-home.html'));
const contact = buildPageContext(`${BASE}contact-us`, 'contact', 200, fixture('b2b-contact.html'));
const shop = buildPageContext('https://bloomandthread.co.uk/', 'home', 200, fixture('shop-home.html'));

describe('HTML checks', () => {
  it('PDF_CATALOG: catalogue PDF link is verified with the PDF url as evidence', () => {
    const o = checkPdfCatalog([home]);
    expect(o).toMatchObject({ code: 'PDF_CATALOG', status: 'verified' });
    expect(o?.evidenceDetail).toBe(`${BASE}files/Northbridge-Catalogue-2019.pdf`);
  });

  it('PDF_CATALOG: ignores unrelated PDFs', () => {
    const page = buildPageContext(BASE, 'home', 200, '<a href="/terms.pdf">Terms and conditions</a>');
    expect(checkPdfCatalog([page])).toBeNull();
  });

  it('NO_QUOTE_FORM: POA + mailto/tel and no form', () => {
    expect(checkNoQuoteForm([home])).toMatchObject({ code: 'NO_QUOTE_FORM', status: 'verified', evidenceDetail: 'POA' });
  });

  it('NO_QUOTE_FORM and PDF_CATALOG in Dutch and Russian', () => {
    const nl = buildPageContext(BASE, 'catalog', 200, '<p>Prijs op aanvraag</p><a href="mailto:info@x.nl">mail</a><a href="/files/prijslijst.pdf">Download</a>');
    expect(checkNoQuoteForm([nl])?.code).toBe('NO_QUOTE_FORM');
    expect(checkPdfCatalog([nl])?.code).toBe('PDF_CATALOG');
    const ru = buildPageContext(BASE, 'catalog', 200, '<p>Цена по запросу</p><a href="tel:+7495">звоните</a><a href="/doc/1.pdf">Скачать прайс-лист</a>');
    expect(checkNoQuoteForm([ru])?.code).toBe('NO_QUOTE_FORM');
    expect(checkPdfCatalog([ru])?.code).toBe('PDF_CATALOG');
  });

  it('NO_QUOTE_FORM: not reported when an enquiry form exists', () => {
    const page = buildPageContext(
      BASE,
      'workflow',
      200,
      '<p>Price on request</p><a href="mailto:a@b.co.uk">a</a><form><input name="name"><textarea name="msg"></textarea></form>',
    );
    expect(checkNoQuoteForm([page])).toBeNull();
  });

  it('newsletter-only forms do not count as enquiry forms', () => {
    expect(hasInquiryForm(contact)).toBe(false);
    expect(checkMailtoOnlyContact([home, contact])).toMatchObject({ code: 'MAILTO_ONLY_CONTACT', status: 'likely' });
  });

  it('NO_VIEWPORT_META', () => {
    expect(checkNoViewportMeta(home)).toMatchObject({ code: 'NO_VIEWPORT_META', status: 'verified' });
    expect(checkNoViewportMeta(shop)).toBeNull();
  });

  it('OUTDATED_COPYRIGHT is only "likely"', () => {
    expect(checkOutdatedCopyright(home, new Date('2026-10-21'))).toMatchObject({ status: 'likely', evidenceDetail: '2019' });
    expect(checkOutdatedCopyright(shop, new Date('2026-10-21'))).toBeNull();
  });

  it('NO_SITE_SEARCH needs a known large catalogue', () => {
    expect(checkNoSiteSearch([home], null)).toBeNull();
    expect(checkNoSiteSearch([home], 20)).toBeNull();
    expect(checkNoSiteSearch([home], 120)).toMatchObject({ code: 'NO_SITE_SEARCH', status: 'verified' });
    expect(checkNoSiteSearch([shop], 120)).toBeNull();
  });

  it('MULTIPLE_INQUIRY_CHANNELS needs 3+ distinct mailto addresses', () => {
    expect(checkMultipleInquiryChannels([home, contact])).toBeNull();
    const many = buildPageContext(BASE, 'home', 200, ['a', 'b', 'c'].map((l) => `<a href="mailto:${l}@x.co.uk">x</a>`).join(''));
    expect(checkMultipleInquiryChannels([many])).toMatchObject({ status: 'likely' });
  });

  it('NO_HTTPS / SSL_ERROR', () => {
    expect(checkNoHttps('http://x.co.uk/', null)?.code).toBe('NO_HTTPS');
    expect(checkNoHttps('http://x.co.uk/', 'TLS error: CERT_HAS_EXPIRED')?.code).toBe('SSL_ERROR');
    expect(checkNoHttps('https://x.co.uk/', null)).toBeNull();
  });
});

describe('platform', () => {
  it('detects Shopify and its theme', () => {
    expect(detectPlatform(shop.html)).toBe('shopify');
    expect(shopifyThemeName(shop.html)).toBe('Dawn');
    expect(detectPlatform(home.html)).toBe('custom');
    expect(detectPlatform('<link href="/wp-content/plugins/woocommerce/x.css">')).toBe('woocommerce');
  });

  it('detects parked domains', () => {
    expect(looksParked('This domain is for sale! Buy this domain today')).toBe(true);
    expect(looksParked('Steel sections and fasteners')).toBe(false);
  });
});

describe('pickPages', () => {
  it('picks internal pages by kind, business pages first', () => {
    const picked = pickPages(home, 5);
    expect(picked[0]).toEqual({ url: `${BASE}about`, kind: 'about' });
    expect(picked.map((p) => p.kind)).toEqual(expect.arrayContaining(['contact', 'catalog', 'about']));
    expect(picked.some((p) => p.url.endsWith('.pdf'))).toBe(false);
  });

  it('respects the page budget', () => {
    expect(pickPages(home, 1)).toHaveLength(1);
  });

  it('prefers business pages over legal ones and never opens blog articles', () => {
    const site = buildPageContext(
      BASE,
      'home',
      200,
      [
        '<a href="/privacy-policy">Privacy</a>',
        '<a href="/blog/how-to-order-steel">How to order steel</a>',
        '<a href="/our-services">Services</a>',
        '<a href="/request-a-quote">Get a quote</a>',
        '<a href="/about-us">About</a>',
      ].join(''),
    );
    expect(pickPages(site, 3)).toEqual([
      { url: `${BASE}about-us`, kind: 'about' },
      { url: `${BASE}our-services`, kind: 'services' },
      { url: `${BASE}request-a-quote`, kind: 'workflow' },
    ]);
    expect(pickPages(site, 10).some((p) => p.url.includes('/blog/'))).toBe(false);
  });
});

describe('robots', () => {
  const robots = parseRobots(
    'https://shop.example.co.uk/robots.txt',
    ['User-agent: *', 'Disallow: /checkout', 'Disallow: /*.json', '', 'User-agent: ClientHunterBot', 'Disallow: /private'].join('\n'),
    'ClientHunterBot',
  );

  it('applies the group for our token (not *)', () => {
    expect(robots.isAllowed('https://shop.example.co.uk/private/x')).toBe(false);
    expect(robots.isAllowed('https://shop.example.co.uk/checkout')).toBe(true);
  });

  it('handles wildcard rules like Disallow: /*.json', () => {
    const star = parseRobots('https://a.co.uk/robots.txt', 'User-agent: *\nDisallow: /*.json', 'ClientHunterBot');
    expect(star.isAllowed('https://a.co.uk/products.json?limit=250')).toBe(false);
    expect(star.isAllowed('https://a.co.uk/products')).toBe(true);
  });

  it('treats URLs on another origin as not allowed', () => {
    expect(robots.isAllowed('https://other.co.uk/')).toBe(false);
  });
});

describe('SSRF guard', () => {
  it.each(['127.0.0.1', '10.1.2.3', '192.168.0.10', '172.20.0.1', '169.254.169.254', '::1', 'fe80::1', '::ffff:127.0.0.1'])(
    'blocks %s',
    (ip) => expect(isPublicAddress(ip)).toBe(false),
  );
  it('allows public addresses', () => {
    expect(isPublicAddress('93.184.216.34')).toBe(true);
    expect(isPublicAddress('2606:4700::1111')).toBe(true);
  });
});
