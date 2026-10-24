import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/connection.js';
import { migrate, pendingMigrations } from '../src/db/migrate.js';
import { companiesForReinspection } from '../src/db/repo.js';

describe('migrate', () => {
  it('creates all spec tables and is idempotent', () => {
    const db = openDb(':memory:');
    expect(migrate(db)).toEqual([
      '001_init.sql',
      '002_opportunities.sql',
      '003_assessments.sql',
      '004_contact_status.sql',
      '005_contact_channels.sql',
    ]);
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
        'assessments',
        'contact_channels',
        'schema_migrations',
      ]),
    );
    db.close();
  });

  it('pendingMigrations lists what migrate would apply, without changing a read-only database', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'ch-pending-')), 'db.sqlite');
    const rw = openDb(file);
    expect(pendingMigrations(rw)).toHaveLength(5);
    migrate(rw, path.resolve('migrations'));
    rw.prepare('DELETE FROM schema_migrations WHERE name = ?').run('005_contact_channels.sql');
    rw.close();

    const ro = openDb(file, { readonly: true });
    expect(pendingMigrations(ro)).toEqual(['005_contact_channels.sql']);
    expect(() => ro.prepare('DELETE FROM schema_migrations').run()).toThrow(/readonly/);
    ro.close();
    expect(() => openDb(path.join(path.dirname(file), 'missing.sqlite'), { readonly: true })).toThrow();
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

describe('migration 004 (contact_status)', () => {
  it('applies on top of existing data without changing it, and only once', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ch-migrations-'));
    const all = readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort();
    for (const f of all.filter((f) => f < '004')) copyFileSync(path.join('migrations', f), path.join(dir, f));

    const db = openDb(':memory:');
    expect(migrate(db, dir)).toEqual(['001_init.sql', '002_opportunities.sql', '003_assessments.sql']);
    db.prepare(`INSERT INTO companies (id, domain, market, status, created_at, updated_at) VALUES ('cmp_1', 'a.co.uk', 'UK', 'inspected', '', '')`).run();
    db.prepare(`INSERT INTO inspections (id, company_id, mode, started_at, result_status) VALUES ('ins_1', 'cmp_1', 'reinspect', 't', 'inspected')`).run();
    db.prepare(
      `INSERT INTO outreach_risk (id, company_id, inspection_id, contact_id, jurisdiction, recipient_type, risk, reason, confidence,
         unknowns_json, to_verify_json, rules_version, created_at)
       VALUES ('ork_1', 'cmp_1', 'ins_1', NULL, 'UK', 'unknown', 'review_required', 'old', 'high', '[]', '[]', '2026-10-23.1', 't')`,
    ).run();

    copyFileSync(path.join('migrations', '004_contact_status.sql'), path.join(dir, '004_contact_status.sql'));
    expect(migrate(db, dir)).toEqual(['004_contact_status.sql']);
    expect(migrate(db, dir)).toEqual([]);

    expect(db.prepare('SELECT id, result_status, contact_status FROM inspections').all()).toEqual([
      { id: 'ins_1', result_status: 'inspected', contact_status: null },
    ]);
    expect(db.prepare('SELECT id, risk, rules_version FROM outreach_risk').all()).toEqual([
      { id: 'ork_1', risk: 'review_required', rules_version: '2026-10-23.1' },
    ]);
    db.close();
  });
});
