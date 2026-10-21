import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { openDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { upsertDiscovered, type CompanyRow } from '../src/db/repo.js';
import { DomainThrottle, FetchError, type Fetcher, type FetchOptions, type FetchResult } from '../src/inspect/fetcher.js';
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
    screenshotRoot: 'unused',
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
  it('runs a B2B site end to end and stores observations and contacts', async () => {
    const { db, company, deps } = setup(fullSite);
    const r = await processCompany(company, deps);
    expect(r.status).toBe('contact_found');
    expect(r.entity).toBe('ltd');
    expect(r.verified).toEqual(expect.arrayContaining(['PDF_CATALOG', 'NO_QUOTE_FORM', 'NO_VIEWPORT_META']));
    expect(r.contact).toBe('sales@northbridge-example.co.uk');

    const row = db.prepare('SELECT status, registry_id, platform FROM companies WHERE id = ?').get(company.id);
    expect(row).toEqual({ status: 'contact_found', registry_id: '01234567', platform: 'custom' });
    expect((db.prepare('SELECT COUNT(*) AS n FROM pages').get() as { n: number }).n).toBeGreaterThanOrEqual(2);
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
    await processCompany(company, { ...deps, maxPages: 1 });
    const pageGets = fetcher.requests.filter((r) => r.startsWith('GET') && !r.endsWith('robots.txt') && !r.includes('/old-page'));
    expect(pageGets).toEqual([`GET ${ORIGIN}/`]);
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

  it('rejects companies without a detectable legal entity', async () => {
    const { company, deps } = setup({
      [`${ORIGIN}/robots.txt`]: [404, html, ''],
      [`${ORIGIN}/`]: [200, html, '<p>Welcome to our shop. Email <a href="mailto:info@northbridge-example.co.uk">us</a>.</p>'],
    });
    expect(await processCompany(company, deps)).toMatchObject({ status: 'rejected_auto', reason: 'entity_unknown' });
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
