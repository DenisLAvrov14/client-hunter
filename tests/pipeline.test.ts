import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { openDb, type Db } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { currentContactChannels, upsertDiscovered, type CompanyRow } from '../src/db/repo.js';
import { DomainThrottle, FetchError, type Fetcher, type FetchOptions, type FetchResult } from '../src/inspect/fetcher.js';
import { confirmBrokenImages } from '../src/inspect/links.js';
import { MAX_BROWSER_LAUNCH_ATTEMPTS, PlaywrightInspector } from '../src/inspect/mobile.js';
import { processCompany, type ProcessDeps } from '../src/pipeline/processCompany.js';

const config = loadConfig();
const fixture = (name: string) => readFileSync(path.resolve('tests/fixtures/sites', name), 'utf8');

/** In-memory site: url -> [status, contentType, body]. Records every request. */
class FakeFetcher implements Fetcher {
  readonly requests: string[] = [];
  constructor(private readonly site: Record<string, [number, string, string] | 'tls'>) {}
  async fetch(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
    this.requests.push(`${opts.method ?? 'GET'} ${url}`);
    const entry = this.site[url];
    if (entry === 'tls') throw new FetchError('TLS error: CERT_HAS_EXPIRED', 'tls');
    const [status, contentType, body] = entry ?? [404, 'text/html', 'not found'];
    return { requestedUrl: url, finalUrl: url, status, contentType, body, truncated: false };
  }
}

const ORIGIN = 'https://www.northbridge-example.co.uk';
const html = 'text/html; charset=utf-8';

function setup(site: ConstructorParameters<typeof FakeFetcher>[0], suppressed = false) {
  const db = openDb(':memory:');
  migrate(db);
  const { id } = upsertDiscovered(
    db,
    { name: 'Northbridge', websiteUrl: `${ORIGIN}/`, city: 'Manchester', sourceRef: null, query: null },
    { market: 'UK', segment: 'S2', sourceId: 'csv', termsNote: 'test' },
  )!;
  if (suppressed) {
    db.prepare("INSERT INTO suppression (id, domain, reason, source, created_at) VALUES ('sup_1', ?, 'test', 'command', '')").run(
      'northbridge-example.co.uk',
    );
  }
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(id) as CompanyRow;
  const fetcher = new FakeFetcher(site);
  const deps: ProcessDeps = {
    db,
    fetcher,
    mobile: null,
    renderer: null,
    mxCheck: async () => true,
    market: config.markets.get('UK')!,
    segment: 'S2',
    robotsToken: 'ClientHunterBot',
    maxPages: 3,
    maxNavLinks: 2,
    mainTextMaxChars: 4000,
    linksMax: 40,
    screenshotRoot: 'unused',
    mode: 'discover',
  };
  return { db, company, fetcher, deps };
}

const fullSite = {
  [`${ORIGIN}/robots.txt`]: [200, 'text/plain', 'User-agent: *\nDisallow: /about'] as [number, string, string],
  [`${ORIGIN}/`]: [200, html, fixture('b2b-home.html')] as [number, string, string],
  [`${ORIGIN}/contact-us`]: [200, html, fixture('b2b-contact.html')] as [number, string, string],
  [`${ORIGIN}/products`]: [200, html, '<h1>Products</h1>'] as [number, string, string],
};

describe('processCompany', () => {
  it('runs a B2B site end to end: observations, clean text, capabilities, contacts, outreach risk', async () => {
    const { db, company, deps } = setup(fullSite);
    const r = await processCompany(company, deps);
    expect(r.status).toBe('inspected');
    expect(r.entity).toBe('ltd');
    expect(r.verified).toEqual(expect.arrayContaining(['PDF_CATALOG', 'NO_QUOTE_FORM', 'NO_VIEWPORT_META']));
    expect(r).toMatchObject({ contact: 'sales@northbridge-example.co.uk', risk: 'low' });

    const row = db.prepare('SELECT status, registry_id, platform, last_inspection_id FROM companies WHERE id = ?').get(company.id) as {
      last_inspection_id: string;
    };
    expect(row).toMatchObject({ status: 'inspected', registry_id: '01234567', platform: 'custom' });

    const inspection = db.prepare('SELECT * FROM inspections WHERE id = ?').get(row.last_inspection_id) as {
      result_status: string;
      capabilities_json: string;
    };
    expect(inspection.result_status).toBe('inspected');
    expect(JSON.parse(inspection.capabilities_json).flags.price_on_request.present).toBe(true);

    const pages = db.prepare('SELECT url, main_text, links_json FROM pages WHERE inspection_id = ?').all(row.last_inspection_id) as {
      url: string;
      main_text: string;
    }[];
    // /about is disallowed by robots.txt, so its slot goes to the next page (contact).
    expect(pages.map((p) => p.url)).toEqual([`${ORIGIN}/`, `${ORIGIN}/products`, `${ORIGIN}/contact-us`]);
    expect(pages[0]!.main_text).toContain('Steel sections, fasteners and fixings');
    expect(pages[0]!.main_text).not.toContain('Registered in England');

    const risks = db
      .prepare('SELECT k.email, r.risk FROM outreach_risk r JOIN contacts k ON k.id = r.contact_id ORDER BY k.email')
      .all();
    expect(risks).toEqual([
      { email: 'info@northbridge-example.co.uk', risk: 'low' },
      { email: 'john.smith@gmail.com', risk: 'review_required' },
      { email: 'sales@northbridge-example.co.uk', risk: 'low' },
    ]);
  });

  it('never fetches paths disallowed by robots.txt', async () => {
    const { company, fetcher, deps } = setup(fullSite);
    await processCompany(company, deps);
    expect(fetcher.requests[0]).toBe(`GET ${ORIGIN}/robots.txt`);
    expect(fetcher.requests.some((r) => r.includes('/about'))).toBe(false);
  });

  it('rejects the whole site when robots.txt disallows it, fetching nothing else', async () => {
    const { company, fetcher, deps } = setup({
      [`${ORIGIN}/robots.txt`]: [200, 'text/plain', 'User-agent: ClientHunterBot\nDisallow: /'],
    });
    const r = await processCompany(company, deps);
    expect(r).toMatchObject({ status: 'rejected_auto', reason: 'robots_disallow' });
    expect(fetcher.requests).toEqual([`GET ${ORIGIN}/robots.txt`]);
  });

  it('respects the per-site page budget (max_pages_per_site)', async () => {
    const { company, fetcher, deps } = setup(fullSite);
    await processCompany(company, { ...deps, maxPages: 2 });
    const pageGets = fetcher.requests.filter((r) => r.startsWith('GET') && !r.endsWith('robots.txt') && !r.includes('/old-page'));
    expect(pageGets).toEqual([`GET ${ORIGIN}/`, `GET ${ORIGIN}/products`]);
  });

  it('skips suppressed domains without any request', async () => {
    const { company, fetcher, deps } = setup(fullSite, true);
    const r = await processCompany(company, deps);
    expect(r).toMatchObject({ status: 'rejected_auto', reason: 'suppressed' });
    expect(fetcher.requests).toEqual([]);
  });

  it('falls back to HTTP on a TLS error and records SSL_ERROR', async () => {
    const http = 'http://www.northbridge-example.co.uk';
    const { db, company, deps } = setup({
      [`${ORIGIN}/robots.txt`]: 'tls',
      [`${http}/robots.txt`]: [404, html, ''],
      [`${http}/`]: [200, html, fixture('b2b-home.html')],
    });
    const r = await processCompany(company, deps);
    expect(r.verified).toContain('SSL_ERROR');
    expect(db.prepare("SELECT 1 FROM observations WHERE code = 'SSL_ERROR'").get()).toBeTruthy();
  });

  it('keeps companies without a legal entity, technical problems or email (only the risk differs)', async () => {
    const { db, company, deps } = setup({
      [`${ORIGIN}/robots.txt`]: [404, html, ''],
      [`${ORIGIN}/`]: [
        200,
        html,
        '<html><head><meta name="viewport" content="width=device-width"></head><body><p>Wedding photography. Call 0161 000 000.</p></body></html>',
      ],
    });
    const r = await processCompany(company, deps);
    expect(r).toMatchObject({
      status: 'inspected',
      entity: 'unknown',
      verified: [],
      contact: null,
      contactStatus: 'none',
      risk: 'review_required',
    });
    expect(db.prepare('SELECT contact_id, risk FROM outreach_risk').all()).toEqual([{ contact_id: null, risk: 'review_required' }]);
    expect(db.prepare('SELECT contact_status FROM inspections').get()).toEqual({ contact_status: 'none' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM contact_channels').get()).toEqual({ n: 0 });
  });

  it('a company without email but with a form: contact form_only, outreach risk still low', async () => {
    const { company, deps } = setup({
      [`${ORIGIN}/robots.txt`]: [404, html, ''],
      [`${ORIGIN}/`]: [
        200,
        html,
        '<p>Northbridge Steel Ltd, company number 01234567.</p><form><input name="name"><textarea name="msg"></textarea></form>',
      ],
    });
    expect(await processCompany(company, deps)).toMatchObject({ contact: null, contactStatus: 'form_only', risk: 'low' });
  });

  it('phone links only: contact phone_or_messenger', async () => {
    const { company, deps } = setup({
      [`${ORIGIN}/robots.txt`]: [404, html, ''],
      [`${ORIGIN}/`]: [200, html, '<p>Jo Bloggs Photography</p><a href="tel:+441610000000">Call us</a>'],
    });
    expect(await processCompany(company, deps)).toMatchObject({ contactStatus: 'phone_or_messenger', risk: 'review_required' });
  });

  it('stores other public channels with source and discovery time, next to the existing emails and risks', async () => {
    const { db, company, deps } = setup(fullSite);
    await processCompany(company, deps);
    expect(db.prepare('SELECT channel, value, source_url FROM contact_channels').all()).toEqual([
      { channel: 'phone', value: '+441610000000', source_url: `${ORIGIN}/` },
    ]);
    expect(db.prepare('SELECT first_seen_at FROM contact_channels').get()).toMatchObject({ first_seen_at: expect.stringMatching(/^\d{4}-/) });
    // Emails and their legal assessments are unchanged by the new channels.
    expect((db.prepare('SELECT COUNT(*) AS n FROM contacts').get() as { n: number }).n).toBe(3);
    expect((db.prepare('SELECT COUNT(*) AS n FROM outreach_risk WHERE contact_id IS NOT NULL').get() as { n: number }).n).toBe(3);
  });

  it('a channel seen again on re-inspection is not duplicated and keeps its first source and time', async () => {
    const { db, company, deps } = setup(fullSite);
    await processCompany(company, deps);
    type Row = { id: string; first_seen_at: string; source_url: string; last_seen_at: string; last_inspection_id: string };
    const first = db.prepare('SELECT id, first_seen_at, source_url, last_seen_at, last_inspection_id FROM contact_channels').get() as Row;
    const fresh = db.prepare('SELECT * FROM companies WHERE id = ?').get(company.id) as CompanyRow;
    await new Promise((r) => setTimeout(r, 5));
    await processCompany(fresh, { ...deps, mode: 'reinspect' });
    const rows = db.prepare('SELECT id, first_seen_at, source_url, last_seen_at, last_inspection_id FROM contact_channels').all() as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.id, first_seen_at: first.first_seen_at, source_url: first.source_url });
    expect(rows[0]!.last_inspection_id).not.toBe(first.last_inspection_id);
    expect(rows[0]!.last_seen_at > first.first_seen_at).toBe(true);
  });

  describe('current contacts across inspections', () => {
    const home: [number, string, string] = [200, html, '<p>Studio</p><a href="/contact">Contact</a>'];
    const withPhone: [number, string, string] = [200, html, '<h1>Contact</h1><a href="tel:+441614960000">Call</a>'];
    const robots: [number, string, string] = [404, html, ''];
    const site = (contact: [number, string, string] | null) => ({
      [`${ORIGIN}/robots.txt`]: robots,
      [`${ORIGIN}/`]: home,
      ...(contact ? { [`${ORIGIN}/contact`]: contact } : {}),
    });
    const again = async (db: Db, id: string, deps: ProcessDeps, s: ConstructorParameters<typeof FakeFetcher>[0]) => {
      const fresh = db.prepare('SELECT * FROM companies WHERE id = ?').get(id) as CompanyRow;
      return processCompany(fresh, { ...deps, fetcher: new FakeFetcher(s), mode: 'reinspect' });
    };

    it('a contact whose page could not be loaded this time is kept as unconfirmed, not dropped', async () => {
      const { db, company, deps } = setup(site(withPhone));
      await processCompany(company, deps);
      await again(db, company.id, deps, site([500, html, 'error']));
      expect(currentContactChannels(db, company.id)).toMatchObject([{ channel: 'phone', value: '+441614960000', confirmed: 0 }]);
    });

    it('a contact absent from a page that WAS re-checked is no longer current', async () => {
      const { db, company, deps } = setup(site(withPhone));
      await processCompany(company, deps);
      await again(db, company.id, deps, site([200, html, '<h1>Contact</h1><p>Visit us.</p>']));
      expect(currentContactChannels(db, company.id)).toEqual([]);
    });

    it('a failed latest inspection does not hide the contacts of the last successful one', async () => {
      const { db, company, deps } = setup(site(withPhone));
      await processCompany(company, deps);
      const failed = await again(db, company.id, deps, { [`${ORIGIN}/robots.txt`]: robots, [`${ORIGIN}/`]: [500, html, 'down'] });
      expect(failed.status).toBe('rejected_auto');
      expect(currentContactChannels(db, company.id)).toMatchObject([{ channel: 'phone', confirmed: 1 }]);
    });
  });

  it('WhatsApp/Telegram only: contact phone_or_messenger, stored as channels', async () => {
    const { db, company, deps } = setup({
      [`${ORIGIN}/robots.txt`]: [404, html, ''],
      [`${ORIGIN}/`]: [200, html, '<p>Nail studio</p><a href="https://wa.me/447700900123">WhatsApp</a><a href="https://t.me/nailstudio">Telegram</a>'],
    });
    expect(await processCompany(company, deps)).toMatchObject({ contact: null, contactStatus: 'phone_or_messenger' });
    expect(db.prepare('SELECT channel FROM contact_channels ORDER BY channel').all()).toEqual([{ channel: 'telegram' }, { channel: 'whatsapp' }]);
  });

  it('a WhatsApp share button alone is not a contact', async () => {
    const { company, deps } = setup({
      [`${ORIGIN}/robots.txt`]: [404, html, ''],
      [`${ORIGIN}/`]: [200, html, '<p>Blog</p><a href="https://wa.me/?text=read%20this">Share</a>'],
    });
    expect((await processCompany(company, deps)).contactStatus).toBe('none');
  });

  it('records one recipient-level risk plus one row per usable email', async () => {
    const { db, company, deps } = setup(fullSite);
    const r = await processCompany(company, deps);
    expect(r).toMatchObject({ contactStatus: 'email', risk: 'low', contactRisk: 'low' });
    const rows = db.prepare('SELECT contact_id IS NULL AS recipient, risk FROM outreach_risk ORDER BY recipient DESC').all();
    expect(rows[0]).toEqual({ recipient: 1, risk: 'low' });
    expect(rows.filter((x) => (x as { recipient: number }).recipient === 0)).toHaveLength(3);
  });

  it('keeps sole traders, marking cold email as high risk', async () => {
    const { company, deps } = setup({
      [`${ORIGIN}/robots.txt`]: [404, html, ''],
      [`${ORIGIN}/`]: [200, html, '<p>Jo Bloggs Photography is a sole trader. <a href="mailto:jo@northbridge-example.co.uk">Email</a></p>'],
    });
    expect(await processCompany(company, deps)).toMatchObject({
      status: 'inspected',
      entity: 'sole_trader',
      risk: 'high',
      contactRisk: 'high',
      contactStatus: 'email',
    });
  });

  it('renders a JavaScript-only home page in a browser, but runs technical checks on the server HTML', async () => {
    const { db, company, deps } = setup({
      [`${ORIGIN}/robots.txt`]: [404, html, ''],
      [`${ORIGIN}/`]: [200, html, '<html><body><div id="root"></div><script src="/app.js"></script></body></html>'],
    });
    const rendered: string[] = [];
    const renderer = {
      renderHtml: async (url: string) => {
        rendered.push(url);
        return { html: '<html><body><h1>Tattoo studio in Amsterdam</h1><p>Walk-ins welcome. Mail us at info@northbridge-example.co.uk</p></body></html>' };
      },
      close: async () => {},
    };
    const r = await processCompany(company, { ...deps, renderer });
    expect(rendered).toEqual([`${ORIGIN}/`]);
    expect(r).toMatchObject({ status: 'inspected', contact: 'info@northbridge-example.co.uk' });
    // NO_VIEWPORT_META is about what the server sends, so it is still reported.
    expect(r.verified).toContain('NO_VIEWPORT_META');
    const page = db.prepare('SELECT main_text FROM pages WHERE inspection_id = (SELECT last_inspection_id FROM companies WHERE id = ?)').get(company.id) as { main_text: string };
    expect(page.main_text).toContain('Tattoo studio in Amsterdam');
  });

  it('does not render sites that already have text', async () => {
    const text = [1, 2, 3, 4, 5]
      .map((n) => `<p>Branch ${n}: steel sections, fasteners, fixings and fabrication consumables for trade customers.</p>`)
      .join('');
    const { company, deps } = setup({
      [`${ORIGIN}/robots.txt`]: [404, html, ''],
      [`${ORIGIN}/`]: [200, html, `<html><body>${text}</body></html>`],
    });
    let calls = 0;
    await processCompany(company, { ...deps, renderer: { renderHtml: async () => (calls++, { error: 'unused' }), close: async () => {} } });
    expect(calls).toBe(0);
  });

  describe('browser failures', () => {
    const thinSite = {
      [`${ORIGIN}/robots.txt`]: [404, html, ''] as [number, string, string],
      [`${ORIGIN}/`]: [200, html, '<html><body><div id="root"></div><a href="mailto:info@northbridge-example.co.uk">mail</a></body></html>'] as [number, string, string],
    };
    const events = (db: Db) => db.prepare('SELECT type, data_json FROM events WHERE type LIKE ?').all('browser_%') as { type: string; data_json: string }[];

    it('a failed render keeps the server HTML, records the reason and still inspects the company', async () => {
      const { db, company, deps } = setup(thinSite);
      const renderer = { renderHtml: async () => ({ error: 'Chromium failed to launch: executable not found' }), close: async () => {} };
      const r = await processCompany(company, { ...deps, renderer });
      expect(r).toMatchObject({ status: 'inspected', contact: 'info@northbridge-example.co.uk' });
      expect(r.verified).toContain('NO_VIEWPORT_META');
      expect(r.browserIssues).toEqual(['render: Chromium failed to launch: executable not found']);
      expect(events(db)).toEqual([{ type: 'browser_render_failed', data_json: expect.stringContaining('executable not found') }]);
    });

    it('a renderer that throws is treated the same way', async () => {
      const { company, deps } = setup(thinSite);
      const renderer = { renderHtml: async (): Promise<never> => { throw new Error('boom'); }, close: async () => {} };
      const r = await processCompany(company, { ...deps, renderer });
      expect(r.status).toBe('inspected');
      expect(r.browserIssues[0]).toContain('boom');
    });

    it('mobile checks that could not run are reported as incomplete, never as passed', async () => {
      const { db, company, deps } = setup(fullSite);
      const mobile = {
        inspect: async () => ({ observations: [], failures: [`${ORIGIN}/: Chromium unavailable after 2 launch attempts`] }),
        close: async () => {},
      };
      const r = await processCompany(company, { ...deps, mobile });
      expect(r).toMatchObject({ status: 'inspected', browserChecks: 'incomplete' });
      expect(r.verified).toEqual(expect.arrayContaining(['PDF_CATALOG', 'NO_VIEWPORT_META']));
      expect(events(db).map((e) => e.type)).toEqual(['browser_checks_incomplete']);
    });

    it('mobile checks that ran are "done"; without a mobile inspector they are "not_requested"', async () => {
      const ok = setup(fullSite);
      const mobile = { inspect: async () => ({ observations: [], failures: [] }), close: async () => {} };
      expect((await processCompany(ok.company, { ...ok.deps, mobile })).browserChecks).toBe('done');
      const none = setup(fullSite);
      expect((await processCompany(none.company, none.deps)).browserChecks).toBe('not_requested');
    });

    it('after the launch limit, every later company needing the browser gets "incomplete" without new launches', async () => {
      let launches = 0;
      const inspector = new PlaywrightInspector('TestBot/1', 1000, () => {
        launches++;
        return Promise.reject(new Error('Executable does not exist'));
      });
      const outcomes: string[] = [];
      for (let i = 0; i < MAX_BROWSER_LAUNCH_ATTEMPTS + 2; i++) {
        const { company, deps } = setup(fullSite);
        const r = await processCompany(company, { ...deps, mobile: inspector, renderer: inspector });
        expect(r.status).toBe('inspected');
        outcomes.push(r.browserChecks);
      }
      expect(outcomes).toEqual(Array(MAX_BROWSER_LAUNCH_ATTEMPTS + 2).fill('incomplete'));
      expect(launches).toBe(MAX_BROWSER_LAUNCH_ATTEMPTS);
    });

    it('an unreachable site is rejected before any browser work, not turned into a pass', async () => {
      const { company, deps } = setup({});
      let used = false;
      const renderer = { renderHtml: async () => ((used = true), { html: '<p>x</p>' }), close: async () => {} };
      const mobile = { inspect: async () => ((used = true), { observations: [], failures: [] }), close: async () => {} };
      const r = await processCompany(company, { ...deps, renderer, mobile });
      expect(r.status).toBe('rejected_auto');
      expect(r.browserChecks).toBe('not_requested');
      expect(used).toBe(false);
    });
  });

  it('re-inspection adds a new inspection and keeps the earlier pages and observations', async () => {
    const { db, company, deps } = setup(fullSite);
    await processCompany(company, deps);
    const fresh = db.prepare('SELECT * FROM companies WHERE id = ?').get(company.id) as CompanyRow;
    await processCompany(fresh, { ...deps, mode: 'reinspect' });
    expect(db.prepare('SELECT mode FROM inspections ORDER BY started_at, mode').all()).toEqual([
      { mode: 'discover' },
      { mode: 'reinspect' },
    ]);
    const perInspection = db
      .prepare('SELECT COUNT(DISTINCT inspection_id) AS n FROM observations WHERE code = ?')
      .get('PDF_CATALOG') as { n: number };
    expect(perInspection.n).toBe(2);
    // Contacts are refreshed, not duplicated.
    expect((db.prepare('SELECT COUNT(*) AS n FROM contacts').get() as { n: number }).n).toBe(3);
  });
});

describe('confirmBrokenImages', () => {
  it('keeps only own-domain images that are really missing on the server', async () => {
    const fetcher = new FakeFetcher({
      [`${ORIGIN}/img/ok.png`]: [200, 'image/png', ''],
      [`${ORIGIN}/img/gone.png`]: [404, 'text/html', ''],
    });
    const suspicion = {
      code: 'BROKEN_IMAGES' as const,
      status: 'unknown' as const,
      description: 'x',
      evidenceDetail: [`${ORIGIN}/img/ok.png`, `${ORIGIN}/img/gone.png`, 'https://bat.bing.com/action/0?ti=1'].join('\n'),
    };
    const r = await confirmBrokenImages(suspicion, 'northbridge-example.co.uk', fetcher);
    expect(r).toMatchObject({ status: 'verified', evidenceDetail: `404 ${ORIGIN}/img/gone.png` });
    expect(fetcher.requests.some((u) => u.includes('bing.com'))).toBe(false);
  });

  it('drops the suspicion when every image loads over HTTP (lazy-load artefacts)', async () => {
    const fetcher = new FakeFetcher({ [`${ORIGIN}/a.png`]: [200, 'image/png', ''] });
    const suspicion = { code: 'BROKEN_IMAGES' as const, status: 'unknown' as const, description: 'x', evidenceDetail: `${ORIGIN}/a.png` };
    expect(await confirmBrokenImages(suspicion, 'northbridge-example.co.uk', fetcher)).toBeNull();
  });
});

describe('DomainThrottle', () => {
  it('spaces requests to the same domain by the configured delay', async () => {
    const throttle = new DomainThrottle(50);
    const start = Date.now();
    await throttle.wait('https://a.example.co.uk/1');
    await throttle.wait('https://www.example.co.uk/2');
    await throttle.wait('https://example.co.uk/3');
    expect(Date.now() - start).toBeGreaterThanOrEqual(95);
  });

  it('does not delay different domains', async () => {
    const throttle = new DomainThrottle(200);
    const start = Date.now();
    await Promise.all([throttle.wait('https://a.co.uk/'), throttle.wait('https://b.co.uk/')]);
    expect(Date.now() - start).toBeLessThan(150);
  });
});
