import { describe, expect, it } from 'vitest';
import { emailOnDomain, registrableDomain } from '../src/util/domain.js';
import { newId } from '../src/util/ids.js';
import { UsageError, parsePipelineArgs } from '../src/pipeline/args.js';

describe('registrableDomain', () => {
  it.each([
    ['https://www.shop.example.co.uk/products?x=1', 'example.co.uk'],
    ['WWW.Example.NL', 'example.nl'],
    ['sales@mail.example.ie', 'example.ie'],
    ['http://example.com.kz', 'example.com.kz'],
    ['https://пример.рф/', 'пример.рф'],
  ])('%s -> %s', (input, expected) => {
    expect(registrableDomain(input)).toBe(expected);
  });

  it('returns null for IPs and bare suffixes', () => {
    expect(registrableDomain('http://192.168.1.1/')).toBeNull();
    expect(registrableDomain('co.uk')).toBeNull();
  });

  it('matches emails on the company domain or its subdomains only', () => {
    expect(emailOnDomain('info@uk.example.com', 'https://example.com')).toBe(true);
    expect(emailOnDomain('example.shop@gmail.com', 'https://example.com')).toBe(false);
  });
});

describe('newId', () => {
  it('uses the kind prefix', () => {
    expect(newId('company')).toMatch(/^cmp_[0-9a-z]{16}$/);
    expect(newId('observation')).toMatch(/^obs_/);
  });
});

describe('parsePipelineArgs', () => {
  it('parses and normalizes', () => {
    expect(parsePipelineArgs(['--market', 'uk', '--segment', 's2', '--limit', '50'], 100)).toEqual({
      market: 'UK',
      segment: 'S2',
      limit: 50,
    });
  });

  it('rejects bad input', () => {
    expect(() => parsePipelineArgs(['--market', 'US', '--segment', 'S1'], 100)).toThrow(UsageError);
    expect(() => parsePipelineArgs(['--market', 'UK', '--segment', 'S1', '--limit', '500'], 100)).toThrow(
      /max_companies_per_run/,
    );
    expect(() => parsePipelineArgs(['--bogus'], 100)).toThrow(UsageError);
  });
});
