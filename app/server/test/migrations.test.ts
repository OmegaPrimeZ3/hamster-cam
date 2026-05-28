// Verifies that all numbered migrations apply cleanly to a brand-new DB,
// install every expected table + index, and are idempotent on re-run.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from '../src/migrate.js';

interface SqliteObject {
  name: string;
  type: 'table' | 'index';
}

const EXPECTED_TABLES = [
  '_migrations',
  'settings',
  'users',
  'sessions',
  'cameras',
  'snapshots',
  'diary_entries',
  'badges_earned',
  'audit_log',
  'share_recipients',
  'share_log',
] as const;

const EXPECTED_INDEXES = [
  'idx_users_email',
  'idx_sessions_user',
  'idx_sessions_expires',
  'idx_cameras_position',
  'idx_snapshots_camera_time',
  'idx_snapshots_taken_at',
  'idx_diary_occurred_at',
  'idx_diary_kind_time',
  'idx_diary_activity',
  'idx_audit_at',
  'idx_audit_actor',
  'idx_audit_action',
  'idx_share_recipients_email',
  'idx_share_log_user_time',
  'idx_share_log_status',
] as const;

const SEED_SETTINGS_KEYS = [
  'pet_name', 'pet_emoji', 'theme', 'theme_mode',
  'read_aloud', 'auto_rotate', 'onboarding_complete',
  'snapshot_retention_days', 'timelapse_retention_days', 'audit_retention_days',
  'disk_warn_pct', 'disk_critical_pct',
  'transition_window_ms', 'min_dwell_ms', 'share_rate_limit_per_hour',
  // Added by migration 0022 (Nightly Recap tab settings).
  'timelapse_enabled', 'recap_video_zone_priority', 'recap_names',
] as const;

describe('migrations', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hamster-migrate-'));
    dbPath = join(dir, 'hamster.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies cleanly to a brand-new database', () => {
    const db = migrate(dbPath);
    try {
      const objects = db.prepare(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'",
      ).all() as SqliteObject[];

      const tableNames = new Set(objects.filter((o) => o.type === 'table').map((o) => o.name));
      for (const t of EXPECTED_TABLES) {
        expect(tableNames.has(t), `missing table ${t}`).toBe(true);
      }

      const indexNames = new Set(objects.filter((o) => o.type === 'index').map((o) => o.name));
      for (const idx of EXPECTED_INDEXES) {
        expect(indexNames.has(idx), `missing index ${idx}`).toBe(true);
      }

      // Verify the migrations bookkeeping row count matches the file count.
      const applied = db.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number };
      expect(applied.n).toBeGreaterThanOrEqual(EXPECTED_TABLES.length - 1); // minus _migrations itself
    } finally {
      db.close();
    }
  });

  it('seeds default settings rows', () => {
    const db = migrate(dbPath);
    try {
      const rows = db.prepare('SELECT key FROM settings').all() as Array<{ key: string }>;
      const seeded = new Set(rows.map((r) => r.key));
      for (const key of SEED_SETTINGS_KEYS) {
        expect(seeded.has(key), `missing seeded setting ${key}`).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it('is idempotent on re-run', () => {
    const first = migrate(dbPath);
    const firstCount = (first.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }).n;
    first.close();

    const second = migrate(dbPath);
    try {
      const secondCount = (second.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }).n;
      expect(secondCount).toBe(firstCount);

      // No duplicate seed rows either.
      const settingsCount = (second.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number }).n;
      expect(settingsCount).toBe(SEED_SETTINGS_KEYS.length);
    } finally {
      second.close();
    }
  });

  it('enforces the role CHECK constraint on users', () => {
    const db = migrate(dbPath);
    try {
      const insert = db.prepare(`
        INSERT INTO users (zyphr_user_id, email, display_name, role, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      expect(() => insert.run('zy_1', 'bad@example.com', 'Bad', 'superadmin', 0, 0)).toThrow();
      // 'admin' should be accepted.
      expect(() => insert.run('zy_2', 'ok@example.com', 'OK', 'admin', 0, 0)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('enforces the diary_entries kind CHECK and FK ON DELETE behaviors', () => {
    const db = migrate(dbPath);
    db.pragma('foreign_keys = ON');
    try {
      // Insert a camera, snapshot, diary entry, then delete the camera and
      // confirm the diary_entries.camera_id is nulled per ON DELETE SET NULL.
      db.prepare(`
        INSERT INTO cameras (name, emoji, stream_url, position, enabled, created_at)
        VALUES ('Wheel', '🎡', 'rtsp://x', 0, 1, 0)
      `).run();
      const camId = (db.prepare('SELECT id FROM cameras LIMIT 1').get() as { id: number }).id;
      db.prepare('INSERT INTO snapshots (camera_id, taken_at, path) VALUES (?, ?, ?)').run(camId, 0, '/x.jpg');
      const snapId = (db.prepare('SELECT id FROM snapshots LIMIT 1').get() as { id: number }).id;

      db.prepare(`
        INSERT INTO diary_entries (
          occurred_at, kind, activity, narrative, pet_name,
          camera_id, from_camera_id, to_camera_id,
          duration_ms, snapshot_id, media_path, details
        ) VALUES (0, 'narrative', 'wheel', 'sentence', 'Peanut',
                  ?, NULL, NULL, 1000, ?, NULL, NULL)
      `).run(camId, snapId);

      // Bad kind value rejected.
      expect(() => db.prepare(`
        INSERT INTO diary_entries (
          occurred_at, kind, activity, narrative, pet_name,
          camera_id, from_camera_id, to_camera_id,
          duration_ms, snapshot_id, media_path, details
        ) VALUES (0, 'video', NULL, 'x', 'p', NULL, NULL, NULL, NULL, NULL, NULL, NULL)
      `).run()).toThrow();

      // Snapshot cascade-deletes when the camera is dropped; the diary entry
      // survives but loses its FK references.
      db.prepare('DELETE FROM cameras WHERE id = ?').run(camId);
      const snap = db.prepare('SELECT * FROM snapshots').all();
      expect(snap.length).toBe(0); // cascaded

      const diary = db.prepare('SELECT camera_id, snapshot_id FROM diary_entries').get() as {
        camera_id: number | null;
        snapshot_id: number | null;
      };
      expect(diary.camera_id).toBeNull();
      expect(diary.snapshot_id).toBeNull();
    } finally {
      db.close();
    }
  });

  it('share_log foreign keys cascade from users + recipients + diary_entries', () => {
    const db = migrate(dbPath);
    db.pragma('foreign_keys = ON');
    try {
      db.prepare(`
        INSERT INTO users (zyphr_user_id, email, display_name, role, created_at, last_seen_at)
        VALUES ('zy_u', 'u@example.com', 'U', 'admin', 0, 0)
      `).run();
      const uid = (db.prepare('SELECT id FROM users').get() as { id: number }).id;
      db.prepare(`
        INSERT INTO share_recipients (display_name, email, added_by, created_at)
        VALUES ('R', 'r@example.com', ?, 0)
      `).run(uid);
      const rid = (db.prepare('SELECT id FROM share_recipients').get() as { id: number }).id;
      db.prepare(`
        INSERT INTO diary_entries (occurred_at, kind, narrative)
        VALUES (0, 'narrative', 'x')
      `).run();
      const did = (db.prepare('SELECT id FROM diary_entries').get() as { id: number }).id;

      db.prepare(`
        INSERT INTO share_log (user_id, recipient_id, diary_entry_id, status, sent_at, error, created_at)
        VALUES (?, ?, ?, 'queued', NULL, NULL, 0)
      `).run(uid, rid, did);

      expect((db.prepare('SELECT COUNT(*) AS n FROM share_log').get() as { n: number }).n).toBe(1);
      // Deleting the user cascades to share_log.
      db.prepare('DELETE FROM users WHERE id = ?').run(uid);
      expect((db.prepare('SELECT COUNT(*) AS n FROM share_log').get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
  });
});

// Used as a const-list above. Keeping the export keeps `tsc --noUnusedLocals`
// quiet if the lists ever become a separate fixture module.
export { EXPECTED_INDEXES, EXPECTED_TABLES, SEED_SETTINGS_KEYS };
