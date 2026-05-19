// app/server/src/migrate.ts
// Numbered-SQL-file migration runner. Idempotent: every file is applied at
// most once and the apply is wrapped in a transaction so a syntactically-bad
// file leaves the DB unchanged. PLAN §5.1.5.
//
// Usage:
//   import { migrate } from './migrate';
//   const db = migrate(process.env.DATABASE_PATH!);
//
// Also runnable standalone via `pnpm migrate` (the bin entry).

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The migrations directory sits one level above the compiled JS (dist/) and
// one level above the source TS (src/) — same relative layout in both, so a
// single `..` works whether we're running from src via tsx or dist via node.
export const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

export interface MigrateOptions {
  /** Override migrations directory; defaults to ../migrations. */
  migrationsDir?: string;
  /** When true, prints `migrated: <file>` for each applied file. */
  log?: boolean;
}

export function migrate(
  dbPath: string,
  opts: MigrateOptions = {},
): Database.Database {
  const db = new Database(dbPath);
  // Enforce foreign-key constraints and use WAL for concurrent reads.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    )
  `);

  const appliedRows = db.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>;
  const applied = new Set(appliedRows.map((r) => r.name));

  const dir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const recordStmt = db.prepare(
    'INSERT INTO _migrations (name, applied_at) VALUES (?, ?)',
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      recordStmt.run(file, Date.now());
    });
    apply();
    if (opts.log) {
      // eslint-disable-next-line no-console
      console.log(`migrated: ${file}`);
    }
  }

  return db;
}

// Standalone entrypoint: `pnpm migrate` or `node dist/migrate.js`.
// Only run when invoked directly, not when imported as a module.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const dbPath = process.env['DATABASE_PATH'];
  if (!dbPath) {
    // eslint-disable-next-line no-console
    console.error('DATABASE_PATH env var is required');
    process.exit(1);
  }
  const db = migrate(dbPath, { log: true });
  db.close();
}
