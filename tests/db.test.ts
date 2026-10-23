import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { companiesForReinspection } from '../src/db/repo.js';

describe('migrate', () => {
  it('creates all spec tables and is idempotent', () => {
    const db = openDb(':memory:');
    expect(migrate(db)).toEqual(['001_init.sql', '002_opportunities.sql']);
    expect(migrate(db)).toEqual([]);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'companies',
        'company_sources',
        'pages',
        'observations',
        'triggers',
        'contacts',
        'dossiers',
        'outreach',
        'replies',
        'operator_decisions',
        'deals',
        'suppression',
        'llm_calls',
        'runs',
        'events',
        'inspections',
        'outreach_risk',
        'schema_migrations',
      ]),
    );
    db.close();
  });

  it('enforces foreign keys and unique domains', () => {
    const db = openDb(':memory:');
    migrate(db);
    const now = new Date().toISOString();
    const insertCompany = db.prepare(
      'INSERT INTO companies (id, domain, market, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insertCompany.run('cmp_1', 'example.co.uk', 'UK', 'discovered', now, now);
    expect(() => insertCompany.run('cmp_2', 'example.co.uk', 'UK', 'discovered', now, now)).toThrow(/UNIQUE/);
    expect(() =>
      db
        .prepare(
          'INSERT INTO observations (id, company_id, code, status, description, collected_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('obs_1', 'cmp_missing', 'PDF_CATALOG', 'verified', 'x', now),
    ).toThrow(/FOREIGN KEY/);
    db.close();
  });
});

describe('companiesForReinspection', () => {
  it('selects old rejections and legacy candidates once, never unusable sites', () => {
    const db = openDb(':memory:');
    migrate(db);
    const add = db.prepare(
      `INSERT INTO companies (id, domain, market, status, reject_reason, created_at, updated_at) VALUES (?, ?, 'UK', ?, ?, '', '')`,
    );
    add.run('cmp_a', 'a.co.uk', 'rejected_auto', 'entity_unknown');
    add.run('cmp_b', 'b.co.uk', 'rejected_auto', 'site_unreachable: timeout');
    add.run('cmp_c', 'c.co.uk', 'contact_found', null);
    add.run('cmp_d', 'd.co.uk', 'rejected_auto', 'no_verified_observation');
    const pick = () =>
      companiesForReinspection(db, {
        markets: ['UK'],
        reasons: ['entity_unknown', 'no_verified_observation'],
        includeLegacyCandidates: true,
        limit: 10,
      }).map((c) => c.id);
    expect(pick()).toEqual(['cmp_a', 'cmp_c', 'cmp_d']);

    db.prepare("UPDATE companies SET last_inspection_id = 'ins_1' WHERE id = 'cmp_a'").run();
    expect(pick()).toEqual(['cmp_c', 'cmp_d']);
    db.close();
  });
});
