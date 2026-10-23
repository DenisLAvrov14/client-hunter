import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { detectCapabilities } from '../src/inspect/capabilities.js';
import { capText, dedupeAcrossPages, extractMainTexts, internalLinks, mainTextLines } from '../src/inspect/extract.js';
import { buildPageContext } from '../src/inspect/page.js';
import { contactStatusOf } from '../src/outreach/contactStatus.js';
import { assessOutreachRisk } from '../src/outreach/risk.js';

const config = loadConfig();
const market = (code: 'UK' | 'IE' | 'NL' | 'KZ' | 'RU') => config.markets.get(code)!;
const role = { kind: 'role' as const, isFreemail: false };
const named = { kind: 'named' as const, isFreemail: false };
const gmail = { kind: 'named' as const, isFreemail: true };

describe('mainTextLines', () => {
  it('keeps main content and drops site chrome, cookie banners and form fields', () => {
    const html = `<body>
      <header><nav><a href="/">Home</a><a href="/about">About</a></nav></header>
      <div class="cookie-banner">We use cookies</div>
      <main><h1>Bespoke oak staircases</h1><p>Made to measure in our Leeds workshop.</p>
        <form><label>Name</label><input name="n"><button>Send</button></form></main>
      <footer>© 2026 Oak & Co</footer></body>`;
    expect(mainTextLines(html)).toEqual(['Bespoke oak staircases', 'Made to measure in our Leeds workshop.']);
  });

  it('keeps the whole page of an ASP.NET-style site wrapped in one form', () => {
    const html = '<body><form id="aspnetForm"><h1>Industrial valves</h1><p>Stockist since 1985.</p></form></body>';
    expect(mainTextLines(html)).toEqual(['Industrial valves', 'Stockist since 1985.']);
  });

  it('never drops <body> because of a class like "no-breadcrumb" (real site)', () => {
    const html = '<body class="page-index no-breadcrumb no-sidebar"><div class="page"><p>Plumbing and heating supplies</p></div></body>';
    expect(mainTextLines(html)).toEqual(['Plumbing and heating supplies']);
  });

  it('uses the whole page when <main> holds only a small part of the text', () => {
    const long = 'Trade counter open to the public, next-day delivery across the region. '.repeat(10);
    const html = `<body><main><p>${'Welcome to our store. '.repeat(10)}</p></main><div><p>${long}</p></div></body>`;
    expect(mainTextLines(html).join(' ')).toContain('Trade counter open to the public');
  });

  it('does not drop a wrapper whose id merely contains "share"', () => {
    const html = '<body><div id="shared-layout"><p>Wedding photography in Galway</p></div></body>';
    expect(mainTextLines(html)).toEqual(['Wedding photography in Galway']);
  });
});

describe('dedupeAcrossPages / capText', () => {
  it('removes lines repeated on several pages and duplicates within a page', () => {
    const out = dedupeAcrossPages([
      ['Call us 0161 000', 'Steel sections', 'Steel sections'],
      ['Call us 0161 000', 'Fasteners and fixings'],
    ]);
    expect(out).toEqual([['Steel sections'], ['Fasteners and fixings']]);
  });

  it('keeps a long description shared by two pages once, on the first page', () => {
    const desc = 'Особенность вагонки штиль – мягкие скругленные фаски по бокам каждой доски.';
    expect(dedupeAcrossPages([['Каталог', desc, 'Сосна'], ['Каталог', desc, 'Лиственница']])).toEqual([
      [desc, 'Сосна'],
      ['Лиственница'],
    ]);
  });

  it('keeps a single page intact', () => {
    expect(dedupeAcrossPages([['a b c', 'd e f']])).toEqual([['a b c', 'd e f']]);
  });

  it('caps at whole lines', () => {
    expect(capText(['aaaa', 'bbbb', 'cccc'], 9)).toBe('aaaa\nbbbb');
    expect(capText(['a'.repeat(20)], 5)).toBe('aaaaa');
  });

  it('extractMainTexts combines extraction, de-duplication and the cap', () => {
    const footer = '<footer>x</footer><p>Opening hours Mon-Fri</p>';
    const pages = [
      buildPageContext('https://a.co.uk/', 'home', 200, `<p>Hair salon in Leith</p>${footer}`),
      buildPageContext('https://a.co.uk/prices', 'workflow', 200, `<p>Cut and finish from £35</p>${footer}`),
    ];
    expect(extractMainTexts(pages, 4000)).toEqual(['Hair salon in Leith', 'Cut and finish from £35']);
  });
});

describe('internalLinks', () => {
  it('returns internal links with text, nav first, capped', () => {
    const p = buildPageContext(
      'https://www.acme.co.uk/',
      'home',
      200,
      '<p><a href="/blog">Blog</a><a href="https://other.com/x">Other</a></p><nav><a href="/services">Services</a></nav><a href="/x"></a>',
    );
    expect(internalLinks(p, 10)).toEqual([
      { url: 'https://www.acme.co.uk/services', text: 'Services' },
      { url: 'https://www.acme.co.uk/blog', text: 'Blog' },
    ]);
    expect(internalLinks(p, 1)).toHaveLength(1);
  });
});

describe('detectCapabilities', () => {
  const page = (html: string, kind: 'home' | 'catalog' | 'contact' = 'home', url = 'https://a.co.uk/') =>
    buildPageContext(url, kind, 200, html);

  it('finds booking widgets, chat, messengers and visible prices', () => {
    const caps = detectCapabilities(
      [
        page(
          '<html lang="en-GB"><body><a href="https://calendly.com/oak/visit">Book a visit</a>' +
            '<script src="https://embed.tawk.to/123"></script><a href="https://wa.me/447000">WhatsApp</a>' +
            '<p>Cut and finish from £35</p></body></html>',
        ),
      ],
      'wordpress',
      null,
    );
    expect(caps.flags.online_booking).toMatchObject({ present: true, detail: 'calendly.com' });
    expect(caps.flags.live_chat.present).toBe(true);
    expect(caps.flags.messenger_links.present).toBe(true);
    expect(caps.flags.prices_visible.present).toBe(true);
    expect(caps.flags.cart_checkout.present).toBe(false);
    expect(caps.languages).toEqual(['en']);
  });

  it('an empty mini-cart (£0.00) is not a visible price', () => {
    const caps = detectCapabilities([page('<div class="mini-cart">Basket £0.00</div>')], 'custom', null);
    expect(caps.flags.prices_visible.present).toBe(false);
  });

  it('does not take the product word "intercom" for a chat widget', () => {
    const caps = detectCapabilities([page('<p>Door entry intercom systems for apartments</p>')], 'custom', null);
    expect(caps.flags.live_chat.present).toBe(false);
  });

  it('treats Shopify/WooCommerce as having a cart and records price-on-request', () => {
    const caps = detectCapabilities([page('<p>Price on application</p>')], 'shopify', 120);
    expect(caps.flags.cart_checkout.present).toBe(true);
    expect(caps.flags.price_on_request.present).toBe(true);
    expect(caps.productLinkCount).toBe(120);
  });

  it('counts product links on catalog pages when no product count is known', () => {
    const catalog = page(
      '<a href="/products/a">A</a><a href="/products/b">B</a><a href="/about">About</a>',
      'catalog',
      'https://a.co.uk/shop',
    );
    expect(detectCapabilities([catalog], 'custom', null).productLinkCount).toBe(2);
  });
});

describe('assessOutreachRisk', () => {
  it('UK company with a role address on its domain: low (never "guaranteed")', () => {
    const r = assessOutreachRisk(market('UK'), 'ltd', role);
    expect(r).toMatchObject({ risk: 'low', recipientType: 'company_likely', confidence: 'medium', jurisdiction: 'UK' });
    expect(r.toVerify).toContain('проверить юрлицо в реестре');
  });

  it('UK sole trader: high (PECR needs prior consent)', () => {
    expect(assessOutreachRisk(market('UK'), 'sole_trader', role)).toMatchObject({
      risk: 'high',
      recipientType: 'sole_trader_confirmed',
    });
  });

  it('unknown legal form: review_required, whatever the address', () => {
    for (const c of [role, named, gmail]) {
      expect(assessOutreachRisk(market('UK'), 'unknown', c)).toMatchObject({ risk: 'review_required', recipientType: 'unknown' });
    }
  });

  it('public mailbox never gives low, even for a company', () => {
    expect(assessOutreachRisk(market('UK'), 'ltd', gmail).risk).toBe('review_required');
  });

  it('named address: low in UK, review_required in IE/NL where only role addresses are allowed', () => {
    expect(assessOutreachRisk(market('UK'), 'ltd', named).risk).toBe('low');
    expect(assessOutreachRisk(market('IE'), 'ltd', named).risk).toBe('review_required');
    expect(assessOutreachRisk(market('NL'), 'bv', named).risk).toBe('review_required');
  });

  it('RU: high for any cold commercial email (38-FZ); KZ: review_required until checked', () => {
    expect(assessOutreachRisk(market('RU'), 'ooo', role).risk).toBe('high');
    expect(assessOutreachRisk(market('KZ'), 'too', role).risk).toBe('review_required');
  });

  it('recipient-level risk (no contact given) does not depend on whether an email exists', () => {
    // A company is low risk even if no email was found; availability is contact_status.
    expect(assessOutreachRisk(market('NL'), 'bv', null)).toMatchObject({ risk: 'low', recipientType: 'company_likely' });
    expect(assessOutreachRisk(market('UK'), 'ltd', null).reason).not.toMatch(/email не найден/i);
    // "low" is a preliminary risk, never worded as a legal permission.
    expect(assessOutreachRisk(market('UK'), 'ltd', null).reason).toContain('Это не юридическое разрешение');
  });

  it('unknown legal status: review_required, explained by the legal form, not by contacts', () => {
    const r = assessOutreachRisk(market('UK'), 'unknown', null);
    expect(r).toMatchObject({ risk: 'review_required', confidence: 'low' });
    expect(r.reason).toContain('Юридическая форма получателя неизвестна');
    expect(r.toVerify).toContain('проверить юридическую форму в реестре или на сайте');
  });

  it('sole trader: high whether or not an email exists', () => {
    expect(assessOutreachRisk(market('UK'), 'sole_trader', null).risk).toBe('high');
    expect(assessOutreachRisk(market('UK'), 'sole_trader', role).risk).toBe('high');
  });

  it('market rules apply without a contact too: RU high, KZ review_required', () => {
    expect(assessOutreachRisk(market('RU'), 'ooo', null).risk).toBe('high');
    expect(assessOutreachRisk(market('KZ'), 'too', null).risk).toBe('review_required');
  });

  it('a public mailbox is treated as a possible working address, but not as low risk', () => {
    const r = assessOutreachRisk(market('UK'), 'ltd', gmail);
    expect(r.risk).toBe('review_required');
    expect(r.reason).toContain('может быть рабочий ящик');
  });
});

describe('contactStatusOf', () => {
  const none = { usableEmails: 0, inquiryForm: false, phone: false, messenger: false };
  it('prefers email, then form, then phone/messenger', () => {
    expect(contactStatusOf({ ...none, usableEmails: 1, inquiryForm: true, phone: true })).toBe('email');
    expect(contactStatusOf({ ...none, inquiryForm: true, phone: true })).toBe('form_only');
    expect(contactStatusOf({ ...none, phone: true })).toBe('phone_or_messenger');
    expect(contactStatusOf({ ...none, messenger: true })).toBe('phone_or_messenger');
    expect(contactStatusOf(none)).toBe('none');
  });
});

describe('candidates report: risk vs contact availability', () => {
  it('never shows an old "no email" row (rules 2026-10-23.1) as the recipient risk', async () => {
    const { openDb } = await import('../src/db/connection.js');
    const { migrate } = await import('../src/db/migrate.js');
    const { buildCandidatesReport } = await import('../src/reports/candidates.js');
    const db = openDb(':memory:');
    migrate(db);
    db.prepare(`INSERT INTO companies (id, domain, market, status, last_inspection_id, created_at, updated_at) VALUES ('cmp_1', 'a.co.uk', 'UK', 'inspected', 'ins_1', '', '')`).run();
    db.prepare(`INSERT INTO inspections (id, company_id, mode, started_at, contact_status) VALUES ('ins_1', 'cmp_1', 'reinspect', 't', 'form_only')`).run();
    const add = db.prepare(
      `INSERT INTO outreach_risk (id, company_id, inspection_id, contact_id, jurisdiction, recipient_type, risk, reason, confidence,
         unknowns_json, to_verify_json, rules_version, created_at)
       VALUES (?, 'cmp_1', 'ins_1', NULL, 'UK', 'company_likely', ?, ?, 'medium', '[]', '[]', ?, 't')`,
    );
    add.run('ork_old', 'review_required', 'Рабочий публичный email не найден', '2026-10-23.1');
    const legacy = buildCandidatesReport(db, 'UK').companies[0]!;
    expect(legacy.recipientRisk).toBeNull();
    expect(legacy.contact_status).toBe('form_only');

    add.run('ork_new', 'low', 'Компания', '2026-10-23.2');
    expect(buildCandidatesReport(db, 'UK').companies[0]!.recipientRisk).toMatchObject({ risk: 'low' });
    db.close();
  });
});
