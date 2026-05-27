// Validates that the badge-snapshot-cleanup.sql remediation removes only
// unearned snapshot badges and leaves legitimately-earned ones intact.
//
// We use a real in-memory DB (same migrate() pipeline as production) and
// execute the SQL from badge-snapshot-cleanup.sql directly — so any drift
// between the test SQL and the shipped script is caught immediately.

import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from '../src/migrate.js';

let workdir: string;
let db: Database.Database;

const SCRIPT_PATH = join(
  new URL('..', import.meta.url).pathname,
  'scripts/badge-snapshot-cleanup.sql',
);

/**
 * Execute ONLY the remediation block (the BEGIN / DELETE / DELETE / COMMIT
 * block) from the cleanup script. We strip the diagnostic SELECT statements
 * so the db.exec() call doesn't fail on returning result sets to a void call.
 *
 * The SQL file is structured such that Section 2 is clearly delimited; we
 * extract everything from the first BEGIN to the COMMIT.
 */
function runRemediation(database: Database.Database): void {
  const full = readFileSync(SCRIPT_PATH, 'utf-8');
  // Extract everything between (and including) BEGIN and COMMIT.
  const match = full.match(/BEGIN;[\s\S]*?COMMIT;/);
  if (!match) throw new Error('Could not find BEGIN/COMMIT block in cleanup script');
  database.exec(match[0]);
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'hamster-badge-cleanup-'));
  const dbPath = join(workdir, 'hamster.db');
  db = migrate(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

// Helpers ----------------------------------------------------------------

function insertBadge(badgeId: string): void {
  db.prepare(
    "INSERT INTO badges_earned (badge_id, earned_at, earned_day) VALUES (?, ?, '2026-05-20')",
  ).run(badgeId, Date.now());
}

function insertSnapshotDiaryEntry(): void {
  db.prepare(`
    INSERT INTO diary_entries
      (occurred_at, kind, activity, narrative, pet_name,
       camera_id, from_camera_id, to_camera_id,
       duration_ms, snapshot_id, media_path, details, ai_model, created_by)
    VALUES
      (?, 'snapshot', 'snapshot', 'photo taken', NULL,
       NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
  `).run(Date.now());
}

function countBadge(badgeId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM badges_earned WHERE badge_id = ?').get(badgeId) as { n: number };
  return row.n;
}

// ------------------------------------------------------------------------

describe('badge-snapshot-cleanup.sql', () => {
  it('deletes memory_keeper when genuine snapshot count < 5', () => {
    // Insert 4 genuine snapshots — one below threshold.
    for (let i = 0; i < 4; i++) insertSnapshotDiaryEntry();
    insertBadge('memory_keeper');

    expect(countBadge('memory_keeper')).toBe(1);

    runRemediation(db);

    expect(countBadge('memory_keeper')).toBe(0);
  });

  it('preserves memory_keeper when genuine snapshot count >= 5', () => {
    for (let i = 0; i < 5; i++) insertSnapshotDiaryEntry();
    insertBadge('memory_keeper');

    runRemediation(db);

    expect(countBadge('memory_keeper')).toBe(1);
  });

  it('deletes paparazzi when genuine snapshot count < 50', () => {
    // Insert 49 genuine snapshots — one below threshold.
    for (let i = 0; i < 49; i++) insertSnapshotDiaryEntry();
    insertBadge('paparazzi');

    runRemediation(db);

    expect(countBadge('paparazzi')).toBe(0);
  });

  it('preserves paparazzi when genuine snapshot count >= 50', () => {
    for (let i = 0; i < 50; i++) insertSnapshotDiaryEntry();
    insertBadge('paparazzi');

    runRemediation(db);

    expect(countBadge('paparazzi')).toBe(1);
  });

  it('is a no-op when neither badge exists', () => {
    // No snapshot entries, no badge rows.
    const before = (db.prepare('SELECT COUNT(*) AS n FROM badges_earned').get() as { n: number }).n;
    runRemediation(db);
    const after = (db.prepare('SELECT COUNT(*) AS n FROM badges_earned').get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it('does not touch unrelated badges', () => {
    insertBadge('marathon');
    insertBadge('memory_keeper'); // 0 snapshots → should be deleted
    insertBadge('night_owl');

    runRemediation(db);

    expect(countBadge('marathon')).toBe(1);
    expect(countBadge('night_owl')).toBe(1);
    expect(countBadge('memory_keeper')).toBe(0);
  });

  it('is idempotent — running twice produces the same result', () => {
    for (let i = 0; i < 3; i++) insertSnapshotDiaryEntry();
    insertBadge('memory_keeper');
    insertBadge('paparazzi');

    runRemediation(db);
    const after1 = (db.prepare('SELECT COUNT(*) AS n FROM badges_earned').get() as { n: number }).n;

    runRemediation(db);
    const after2 = (db.prepare('SELECT COUNT(*) AS n FROM badges_earned').get() as { n: number }).n;

    expect(after1).toBe(after2);
    expect(countBadge('memory_keeper')).toBe(0);
    expect(countBadge('paparazzi')).toBe(0);
  });

  it('correctly handles the boundary: exactly 5 snapshots keeps memory_keeper, 4 removes it', () => {
    // Case A: exactly 5 → keep
    for (let i = 0; i < 5; i++) insertSnapshotDiaryEntry();
    insertBadge('memory_keeper');
    runRemediation(db);
    expect(countBadge('memory_keeper')).toBe(1);

    // Reset and try 4.
    db.prepare("DELETE FROM badges_earned WHERE badge_id = 'memory_keeper'").run();
    db.prepare("DELETE FROM diary_entries WHERE kind = 'snapshot'").run();

    for (let i = 0; i < 4; i++) insertSnapshotDiaryEntry();
    insertBadge('memory_keeper');
    runRemediation(db);
    expect(countBadge('memory_keeper')).toBe(0);
  });
});
