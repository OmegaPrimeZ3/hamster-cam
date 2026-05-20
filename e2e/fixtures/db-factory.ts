// e2e/fixtures/db-factory.ts
//
// Builds a fresh hamster.db for one e2e spec, runs migrations against it,
// and exposes a tiny seed API the specs use to put users / cameras /
// recipients / diary rows in place before the backend starts.
//
// Why not import the backend's db.ts? We're a sibling workspace and the
// backend module caches a singleton handle keyed off DATABASE_PATH, which
// would conflict with the seeded handle here. Instead we run the same
// migrations against a fresh path, and the backend opens its own handle when
// it boots. Both sides see the same on-disk rows because better-sqlite3 uses
// WAL.

import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// We import the migrate runner from the backend workspace. The .ts file works
// here because tsx compiles on the fly.
import { migrate } from '../../app/server/src/migrate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_MIGRATIONS = join(__dirname, '..', '..', 'app', 'server', 'migrations');

export interface SeededUser {
  id: number;
  email: string;
  display_name: string;
  role: 'admin' | 'child';
  zyphr_user_id: string;
}

export interface SeededCamera {
  id: number;
  name: string;
  emoji: string;
  stream_url: string;
  position: number;
  enabled: 0 | 1;
}

export interface SeededRecipient {
  id: number;
  display_name: string;
  email: string;
}

export interface DiarySeedInput {
  occurred_at: number;
  kind: 'narrative' | 'snapshot' | 'timelapse';
  activity: string | null;
  narrative: string;
  pet_name?: string | null;
  camera_id?: number | null;
  from_camera_id?: number | null;
  to_camera_id?: number | null;
  duration_ms?: number | null;
  media_path?: string | null;
  snapshot_id?: number | null;
  details?: string | null;
}

export interface TestDbHandle {
  /** Absolute path to the SQLite file (also goes to DATABASE_PATH). */
  path: string;
  /** Open the read/write handle (single-writer; specs should close before backend uses it heavily). */
  open: () => Database.Database;
  /** Seed a user, returns the inserted row. */
  seedUser: (input: SeedUserInput) => SeededUser;
  /** Seed a camera (auto-assigns position when omitted). */
  seedCamera: (input: SeedCameraInput) => SeededCamera;
  /** Seed a share recipient. */
  seedRecipient: (input: SeedRecipientInput) => SeededRecipient;
  /** Seed a diary entry. */
  seedDiary: (input: DiarySeedInput) => number;
  /** Set a single settings row. */
  setSetting: (key: string, value: string) => void;
  /** Read a single settings row (null when absent). */
  getSetting: (key: string) => string | null;
  /** Close the seed handle. */
  close: () => void;
  /** Delete the temp DB + parent dir. */
  cleanup: () => Promise<void>;
}

export interface SeedUserInput {
  email: string;
  display_name: string;
  role: 'admin' | 'child';
  zyphr_user_id?: string;
}

export interface SeedCameraInput {
  name: string;
  emoji?: string;
  stream_url: string;
  enabled?: boolean;
  position?: number;
}

export interface SeedRecipientInput {
  display_name: string;
  email: string;
}

/**
 * Create a fresh on-disk SQLite DB inside a unique tmp dir. The caller is
 * responsible for handing `path` to the backend via DATABASE_PATH; the seed
 * helpers below operate on the same file.
 */
export async function createTestDb(): Promise<TestDbHandle> {
  const dir = await mkdtemp(join(tmpdir(), 'hamster-cam-e2e-'));
  const dbPath = join(dir, 'hamster.db');

  // Apply migrations. We close the migrator's handle right away — the seed
  // helpers open their own handle so we don't keep a write lock open between
  // calls.
  const migrated = migrate(dbPath, { migrationsDir: SERVER_MIGRATIONS });
  migrated.close();

  let openHandle: Database.Database | null = null;
  const open = (): Database.Database => {
    if (!openHandle) {
      openHandle = new Database(dbPath);
      openHandle.pragma('journal_mode = WAL');
      openHandle.pragma('foreign_keys = ON');
    }
    return openHandle;
  };

  function seedUser(input: SeedUserInput): SeededUser {
    const db = open();
    const now = Date.now();
    const zyphrId = input.zyphr_user_id ?? `zyphr_${input.email}`;
    const info = db
      .prepare(
        `INSERT INTO users (zyphr_user_id, email, display_name, role, created_at, last_seen_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(zyphrId, input.email, input.display_name, input.role, now, now);
    const id = Number(info.lastInsertRowid);
    return {
      id,
      email: input.email,
      display_name: input.display_name,
      role: input.role,
      zyphr_user_id: zyphrId,
    };
  }

  function seedCamera(input: SeedCameraInput): SeededCamera {
    const db = open();
    let position = input.position;
    if (position === undefined) {
      const max = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM cameras').get() as { p: number };
      position = max.p + 1;
    }
    const emoji = input.emoji ?? '📷';
    const enabledNum = input.enabled === false ? 0 : 1;
    const info = db
      .prepare(
        `INSERT INTO cameras (name, emoji, stream_url, position, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.name, emoji, input.stream_url, position, enabledNum, Date.now());
    return {
      id: Number(info.lastInsertRowid),
      name: input.name,
      emoji,
      stream_url: input.stream_url,
      position,
      enabled: enabledNum as 0 | 1,
    };
  }

  function seedRecipient(input: SeedRecipientInput): SeededRecipient {
    const db = open();
    const info = db
      .prepare(
        `INSERT INTO share_recipients (display_name, email, added_by, created_at)
         VALUES (?, ?, NULL, ?)`,
      )
      .run(input.display_name, input.email, Date.now());
    return {
      id: Number(info.lastInsertRowid),
      display_name: input.display_name,
      email: input.email,
    };
  }

  function seedDiary(input: DiarySeedInput): number {
    const db = open();
    const info = db
      .prepare(
        `INSERT INTO diary_entries (
           occurred_at, kind, activity, narrative, pet_name,
           camera_id, from_camera_id, to_camera_id,
           duration_ms, snapshot_id, media_path, details
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.occurred_at,
        input.kind,
        input.activity,
        input.narrative,
        input.pet_name ?? null,
        input.camera_id ?? null,
        input.from_camera_id ?? null,
        input.to_camera_id ?? null,
        input.duration_ms ?? null,
        input.snapshot_id ?? null,
        input.media_path ?? null,
        input.details ?? null,
      );
    return Number(info.lastInsertRowid);
  }

  function setSetting(key: string, value: string): void {
    const db = open();
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
  }

  function getSetting(key: string): string | null {
    const db = open();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  function close(): void {
    if (openHandle) {
      openHandle.close();
      openHandle = null;
    }
  }

  async function cleanup(): Promise<void> {
    close();
    await rm(dir, { recursive: true, force: true });
  }

  return {
    path: dbPath,
    open,
    seedUser,
    seedCamera,
    seedRecipient,
    seedDiary,
    setSetting,
    getSetting,
    close,
    cleanup,
  };
}
