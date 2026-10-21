import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';

describe('migrate', () => {
  it('creates all spec tables and is idempotent', () => {
    const db = openDb(':memory:');
    expect(migrate(db)).toEqual(['001_init.sql']);
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
