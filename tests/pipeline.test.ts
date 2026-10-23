import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { openDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { upsertDiscovered, type CompanyRow } from '../src/db/repo.js';
import { DomainThrottle, FetchError, type Fetcher, type FetchOptions, type FetchResult } from '../src/inspect/fetcher.js';
import { confirmBrokenImages } from '../src/inspect/links.js';
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
    expect(r).toMatchObject({ status: 'inspected', entity: 'unknown', verified: [], contact: null, risk: 'review_required' });
    expect(db.prepare('SELECT contact_id, risk FROM outreach_risk').all()).toEqual([{ contact_id: null, risk: 'review_required' }]);
  });

  it('keeps sole traders, marking cold email as high risk', async () => {
    const { company, deps } = setup({
      [`${ORIGIN}/robots.txt`]: [404, html, ''],
      [`${ORIGIN}/`]: [200, html, '<p>Jo Bloggs Photography is a sole trader. <a href="mailto:jo@northbridge-example.co.uk">Email</a></p>'],
    });
    expect(await processCompany(company, deps)).toMatchObject({ status: 'inspected', entity: 'sole_trader', risk: 'high' });
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
