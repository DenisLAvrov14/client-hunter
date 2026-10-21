import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config/load.js';
import { loadEnv } from '../src/config/env.js';

const realConfig = path.resolve('config');

function copyConfig(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ch-config-'));
  cpSync(realConfig, dir, { recursive: true });
  return dir;
}

function patch(dir: string, file: string, from: string, to: string): void {
  const full = path.join(dir, file);
  const text = readFileSync(full, 'utf8');
  if (!text.includes(from)) throw new Error(`fixture patch: "${from}" not found in ${file}`);
  writeFileSync(full, text.replace(from, to));
}

describe('loadConfig', () => {
  it('loads the repository config', () => {
    const config = loadConfig(realConfig);
    expect([...config.markets.keys()].sort()).toEqual(['IE', 'KZ', 'NL', 'RU', 'UK']);
    expect([...config.segments.keys()].sort()).toEqual(['S1', 'S2']);
    expect(config.markets.get('UK')?.registry).toBe('companies_house');
  });

  it('ships with every market legally unreviewed (sending blocked) and discovery cities set', () => {
    const config = loadConfig(realConfig);
    for (const m of config.markets.values()) {
      expect(m.legal_review_done).toBe(false);
      if (m.enabled) expect(m.discovery_cities.length).toBeGreaterThan(0);
    }
  });

  it('keeps RU and KZ in permission_request mode with a single follow-up', () => {
    const config = loadConfig(realConfig);
    for (const code of ['RU', 'KZ'] as const) {
      const m = config.markets.get(code);
      expect(m?.first_touch_mode).toBe('permission_request');
      expect(m?.followups).toBe(1);
      expect(m?.requires_manual_legal_review).toBe(true);
    }
  });

  it('rejects unknown keys (typos)', () => {
    const dir = copyConfig();
    patch(dir, 'limits.yaml', 'max_pages_per_site:', 'max_page_per_site:');
    expect(() => loadConfig(dir)).toThrow(ConfigError);
  });

  it('rejects follow-up delays that do not match the follow-up count', () => {
    const dir = copyConfig();
    patch(dir, 'markets/uk.yaml', 'followup_delays_days: [4, 9]', 'followup_delays_days: [4]');
    expect(() => loadConfig(dir)).toThrow(/followup_delays_days/);
  });

  it('rejects scoring weights that do not sum to 1', () => {
    const dir = copyConfig();
    patch(dir, 'scoring.yaml', 'friction: 0.30', 'friction: 0.50');
    expect(() => loadConfig(dir)).toThrow(/sum to 1/);
  });

  it('rejects an unknown timezone', () => {
    const dir = copyConfig();
    patch(dir, 'markets/uk.yaml', 'Europe/London', 'Europe/Londn');
    expect(() => loadConfig(dir)).toThrow(/timezone/);
  });
});

describe('loadEnv', () => {
  it('defaults to sending disabled and dry-run on', () => {
    const env = loadEnv({});
    expect(env.SENDING_ENABLED).toBe(false);
    expect(env.DRY_RUN).toBe(true);
  });

  it('only accepts the literal strings true/false for safety flags', () => {
    expect(() => loadEnv({ SENDING_ENABLED: 'yes' })).toThrow(/SENDING_ENABLED/);
    expect(loadEnv({ SENDING_ENABLED: 'true', DRY_RUN: 'false' })).toMatchObject({
      SENDING_ENABLED: true,
      DRY_RUN: false,
    });
  });
});
