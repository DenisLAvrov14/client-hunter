import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { extractContacts } from '../src/contacts/extract.js';
import { detectEntity } from '../src/entity/detect.js';
import { buildPageContext } from '../src/inspect/page.js';
import { parseCandidatesCsv } from '../src/sources/csv.js';
import { buildOverpassQuery, elementToCandidate } from '../src/sources/osm.js';
import { normalizeWebsite } from '../src/sources/types.js';

const config = loadConfig();
const uk = config.markets.get('UK')!;
const nl = config.markets.get('NL')!;
const ru = config.markets.get('RU')!;
const ie = config.markets.get('IE')!;
const fixture = (name: string) => readFileSync(path.resolve('tests/fixtures/sites', name), 'utf8');
const page = (html: string, url = 'https://acme.co.uk/', kind: 'home' | 'contact' | 'legal' = 'home') =>
  buildPageContext(url, kind, 200, html);

describe('detectEntity', () => {
  it('UK: Ltd with company number from footer', () => {
    const r = detectEntity([page(fixture('b2b-home.html'))], uk);
    expect(r.entityType).toBe('ltd');
    expect(r.evidence).toBe('Northbridge Industrial Supplies Ltd');
    expect(r.registryId).toBe('01234567');
  });

  it('UK: name words in parentheses', () => {
    expect(detectEntity([page('<p>Privacy Policy Emerson Developments (Holdings) Limited, Subsidiaries</p>')], uk)).toMatchObject({
      entityType: 'ltd',
      evidence: 'Privacy Policy Emerson Developments (Holdings) Limited',
    });
  });

  it('UK: "limited" in ordinary prose is not an entity marker', () => {
    expect(detectEntity([page('<p>Offer for a limited time only. Stock is limited.</p>')], uk).entityType).toBe('unknown');
  });

  it('UK: sole trader marker wins', () => {
    expect(detectEntity([page('<p>John Smith trading as Smith Joinery (sole trader)</p>')], uk).entityType).toBe('sole_trader');
  });

  it('NL: B.V. accepted, eenmanszaak denied', () => {
    expect(detectEntity([page('<footer>Van Dijk Metaal B.V. · KvK 12345678</footer>')], nl)).toMatchObject({
      entityType: 'bv',
      registryId: '12345678',
    });
    expect(detectEntity([page('<footer>Van Dijk Metaal B.V. eenmanszaak</footer>')], nl).entityType).toBe('sole_trader');
  });

  it('RU: ООО accepted, 12-digit ИНН means sole trader', () => {
    expect(detectEntity([page('<p>ООО «Металлсервис», ОГРН 1027700132195</p>')], ru)).toMatchObject({
      entityType: 'ooo',
      registryId: '1027700132195',
    });
    expect(detectEntity([page('<p>Иванов И.И., ИНН 772012345678</p>')], ru).entityType).toBe('sole_trader');
  });

  it('RU: "ИП" in policy boilerplate is not a sole trader; "ИП Фамилия" is', () => {
    const boilerplate = '<p>Политика распространяется на юридических лиц и ИП. ООО «Максидом» обрабатывает данные.</p>';
    expect(detectEntity([page(boilerplate)], ru)).toMatchObject({ entityType: 'ooo', evidence: 'ООО «Максидом»' });
    expect(detectEntity([page('<p>Продавец: ИП Иванов И.И., ОГРНИП 304770000000000</p>')], ru)).toMatchObject({
      entityType: 'sole_trader',
      evidence: expect.stringContaining('ИП Иванов'),
    });
  });

  it('IE: Limited with CRO number', () => {
    expect(detectEntity([page('<p>Celtic Fixings Limited, CRO No. 123456</p>')], ie)).toMatchObject({
      entityType: 'ltd',
      registryId: '123456',
    });
  });
});

describe('extractContacts', () => {
  const pages = [
    page(fixture('b2b-home.html'), 'https://www.northbridge-example.co.uk/'),
    page(fixture('b2b-contact.html'), 'https://www.northbridge-example.co.uk/contact-us', 'contact'),
  ];

  it('keeps role addresses on the company domain, best first; drops freemail and blocked locals', () => {
    const emails = extractContacts(pages, 'northbridge-example.co.uk', uk, 'S2').map((c) => c.email);
    expect(emails).toEqual(['sales@northbridge-example.co.uk', 'info@northbridge-example.co.uk']);
  });

  it('de-obfuscates "name [at] domain"', () => {
    const c = extractContacts([page('<p>quotes [at] acme.co.uk</p>')], 'acme.co.uk', uk, 'S2');
    expect(c).toMatchObject([{ email: 'quotes@acme.co.uk', roleHint: 'enquiries' }]);
  });

  it('named addresses only where the market allows them', () => {
    const p = [page('<a href="mailto:jane.doe@acme.co.uk">Jane</a>')];
    expect(extractContacts(p, 'acme.co.uk', uk, 'S2')).toHaveLength(1);
    expect(extractContacts(p, 'acme.ie', ie, 'S2')).toHaveLength(0);
  });

  it('support@ only as an S1 fallback', () => {
    const p = [page('<a href="mailto:support@acme.co.uk">s</a>')];
    expect(extractContacts(p, 'acme.co.uk', uk, 'S2')).toHaveLength(0);
    expect(extractContacts(p, 'acme.co.uk', uk, 'S1')).toHaveLength(1);
  });
});

describe('sources', () => {
  it('normalizes OSM website values', () => {
    expect(normalizeWebsite('www.acme.co.uk')).toBe('https://www.acme.co.uk/');
    expect(normalizeWebsite('http://acme.co.uk/shop?x=1')).toBe('http://acme.co.uk/');
    expect(normalizeWebsite('https://a.co.uk; https://b.co.uk')).toBe('https://a.co.uk/');
    expect(normalizeWebsite('ftp://acme.co.uk')).toBeNull();
  });

  it('builds an Overpass query for tags with a website', () => {
    const q = buildOverpassQuery('UK', 'Manchester', ['shop=trade', 'industrial=*'], 120);
    expect(q).toContain('area["ISO3166-1"="GB"]["admin_level"="2"]->.country;');
    expect(q).toContain('rel(area.country)["boundary"="administrative"]["name"="Manchester"];');
    expect(q).toContain('nwr["shop"="trade"]["website"](area.city);');
    expect(q).toContain('nwr["industrial"]["contact:website"](area.city);');
  });

  it('maps an OSM element to a candidate', () => {
    expect(
      elementToCandidate({ type: 'node', id: 42, tags: { name: 'Acme Fixings', website: 'acme.co.uk' } }, 'Liverpool'),
    ).toEqual({
      name: 'Acme Fixings',
      websiteUrl: 'https://acme.co.uk/',
      city: 'Liverpool',
      sourceRef: 'https://www.openstreetmap.org/node/42',
      query: null,
    });
    expect(elementToCandidate({ type: 'node', id: 1, tags: { name: 'No site' } }, 'Liverpool')).toBeNull();
  });

  it('parses CSV with and without a header', () => {
    expect(parseCandidatesCsv('﻿name,website,city\nAcme,acme.co.uk,Leeds\n')).toEqual([
      { name: 'Acme', websiteUrl: 'https://acme.co.uk/', city: 'Leeds', sourceRef: null, query: null },
    ]);
    expect(parseCandidatesCsv('acme.co.uk\nbeta.nl\n').map((c) => c.websiteUrl)).toEqual([
      'https://acme.co.uk/',
      'https://beta.nl/',
    ]);
  });
});
