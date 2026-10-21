import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Db } from './connection.js';

const MIGRATION_FILE = /^(\d{3})_[a-z0-9_]+\.sql$/;

/** Applies pending `migrations/NNN_name.sql` files in order. Returns the names applied. */
export function migrate(db: Db, dir = path.resolve('migrations')): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const applied = new Set(
    db
      .prepare('SELECT name FROM schema_migrations')
      .all()
      .map((row) => (row as { name: string }).name),
  );

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    if (!MIGRATION_FILE.test(f)) throw new Error(`Bad migration file name: ${f} (expected NNN_name.sql)`);
  }

  const record = db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)');
  const done: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      record.run(file, new Date().toISOString());
    })();
    done.push(file);
  }
  return done;
}
