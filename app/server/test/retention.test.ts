// Tests for jobs/retention.ts
//
// Focus: A.1 fix — after pruning thumbnail files, retention must null out
// diary_entries.thumbnail_path so the backfill job can re-queue those rows.
//
// Also covers: basic smoke test of the retention job completing without error.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let workdir: string;
const baseEnv = { ...process.env };

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'hamster-retention-'));
  mkdirSync(join(workdir, 'thumbnails'), { recursive: true });
  mkdirSync(join(workdir, 'clips'), { recursive: true });
  mkdirSync(join(workdir, 'snapshots'), { recursive: true });
  mkdirSync(join(workdir, 'timelapse'), { recursive: true });
  Object.assign(process.env, baseEnv);
  process.env['DATABASE_PATH'] = join(workdir, 'hamster.db');
  process.env['STORAGE_PATH'] = workdir;
  process.env['ZYPHR_API_KEY'] = 'zy_test_dummy';
  process.env['ZYPHR_APP_SECRET'] = 'zy_test_dummy_secret';
  delete process.env['FRIGATE_URL'];
  delete process.env['MQTT_URL'];
});

afterEach(async () => {
  const { resetDbForTests } = await import('../src/db.js');
  const { resetConfigForTests } = await import('../src/config.js');
  resetDbForTests();
  resetConfigForTests();
  rmSync(workdir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedCamera(name = 'cam-1') {
  const db = await import('../src/db.js');
  return db.createCamera({ name, emoji: '📷', stream_url: `rtsp://host/${name}`, enabled: true });
}

async function seedDiaryEntry(cameraId: number, occurredAt: number, thumbnailRel: string | null) {
  const db = await import('../src/db.js');
  const entry = db.createDiaryEntry({
    occurred_at: occurredAt,
    kind: 'narrative',
    activity: 'exploring',
    narrative: 'Remy explored.',
    pet_name: 'Remy',
    camera_id: cameraId,
    from_camera_id: null,
    to_camera_id: null,
    duration_ms: 60_000,
    snapshot_id: null,
    media_path: null,
    details: null,
  });
  if (thumbnailRel !== null) {
    db.updateDiaryEntryThumbnailPath(entry.id, thumbnailRel);
  }
  return db.getDiaryEntryById(entry.id)!;
}

// ---------------------------------------------------------------------------
// A.1: retention nulls thumbnail_path after pruning files
// ---------------------------------------------------------------------------

describe('retention.runRetentionJob — thumbnail_path cleanup (A.1)', () => {
  it('nulls thumbnail_path for entries whose thumbnail file was pruned', async () => {
    const db = await import('../src/db.js');
    const cam = await seedCamera();

    // Retention window for thumbnails/clips defaults to 14 days.
    // Create an entry that is 20 days old (older than 14-day window).
    const twentyDaysAgo = Date.now() - 20 * 24 * 60 * 60 * 1000;

    // Write a real thumbnail file (retention only checks mtime, not content).
    const thumbName = `entry-999-thumb.jpg`;
    const thumbRel = join('thumbnails', thumbName);
    const thumbAbs = join(workdir, thumbRel);
    writeFileSync(thumbAbs, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

    // Backdate the file's mtime so pruneMediaDir considers it old.
    const { utimesSync } = await import('node:fs');
    const oldDate = new Date(twentyDaysAgo);
    utimesSync(thumbAbs, oldDate, oldDate);

    const entry = await seedDiaryEntry(cam.id, twentyDaysAgo, thumbRel);
    expect(entry.thumbnail_path).toBe(thumbRel);

    const { runRetentionJob } = await import('../src/jobs/retention.ts');
    const result = await runRetentionJob();

    // File should be deleted by pruneMediaDir.
    expect(result.thumbnails_deleted).toBeGreaterThanOrEqual(1);

    // thumbnail_path column should now be NULL.
    expect(result.thumbnail_paths_cleared).toBeGreaterThanOrEqual(1);
    const refreshed = db.getDiaryEntryById(entry.id);
    expect(refreshed?.thumbnail_path).toBeNull();
  });

  it('re-queues the entry for backfill after thumbnail_path is cleared', async () => {
    const db = await import('../src/db.js');
    const cam = await seedCamera();

    // An entry 20 days old — outside the 14-day clip/thumbnail window.
    const twentyDaysAgo = Date.now() - 20 * 24 * 60 * 60 * 1000;

    const thumbName = `entry-888-thumb.jpg`;
    const thumbRel = join('thumbnails', thumbName);
    const thumbAbs = join(workdir, thumbRel);
    writeFileSync(thumbAbs, Buffer.from([0xff, 0xd8, 0xff]));

    const { utimesSync } = await import('node:fs');
    const oldDate = new Date(twentyDaysAgo);
    utimesSync(thumbAbs, oldDate, oldDate);

    const entry = await seedDiaryEntry(cam.id, twentyDaysAgo, thumbRel);

    // Before retention: entry has thumbnail_path → NOT in backfill candidate list.
    // (listDiaryEntriesMissingThumbnail filters thumbnail_path IS NULL)
    const beforeCandidates = db.listDiaryEntriesMissingThumbnail(0, 100);
    expect(beforeCandidates.some((e) => e.id === entry.id)).toBe(false);

    const { runRetentionJob } = await import('../src/jobs/retention.ts');
    await runRetentionJob();

    // After retention: thumbnail_path is NULL → entry IS in backfill candidate list.
    // (listDiaryEntriesMissingThumbnail uses retentionCutoff=0 here so age is not a gate)
    const afterCandidates = db.listDiaryEntriesMissingThumbnail(0, 100);
    expect(afterCandidates.some((e) => e.id === entry.id)).toBe(true);
  });

  it('does not clear thumbnail_path for entries within the retention window', async () => {
    const db = await import('../src/db.js');
    const cam = await seedCamera();

    // Entry 3 days old — well within the 14-day window.
    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;

    const thumbName = `entry-777-thumb.jpg`;
    const thumbRel = join('thumbnails', thumbName);
    const thumbAbs = join(workdir, thumbRel);
    writeFileSync(thumbAbs, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

    // File mtime is recent — pruneMediaDir should NOT delete it.
    const recentDate = new Date(threeDaysAgo);
    const { utimesSync } = await import('node:fs');
    utimesSync(thumbAbs, recentDate, recentDate);

    const entry = await seedDiaryEntry(cam.id, threeDaysAgo, thumbRel);
    expect(entry.thumbnail_path).toBe(thumbRel);

    const { runRetentionJob } = await import('../src/jobs/retention.ts');
    await runRetentionJob();

    // Both the file and the column should still be intact.
    const refreshed = db.getDiaryEntryById(entry.id);
    expect(refreshed?.thumbnail_path).toBe(thumbRel);
  });
});
