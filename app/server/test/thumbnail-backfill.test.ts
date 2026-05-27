// Unit tests for jobs/thumbnail-backfill.ts and the supporting
// db.listDiaryEntriesMissingThumbnail query helper.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock generateThumbnailForEntry so tests don't need a real ffmpeg/Frigate.
// The mock honours a per-test override registered on `thumbnailResults`.
// ---------------------------------------------------------------------------

const thumbnailResults = new Map<number, boolean>();

vi.mock('../src/thumbnails.js', () => ({
  generateThumbnailForEntry: vi.fn(async (entry: { id: number }) => {
    const succeed = thumbnailResults.get(entry.id) ?? false;
    if (succeed) {
      // Persist the thumbnail path on the DB row so the re-fetch check passes.
      const db = await import('../src/db.js');
      db.updateDiaryEntryThumbnailPath(entry.id, join('thumbnails', `entry-${entry.id}-thumb.jpg`));
    }
  }),
}));

let workdir: string;
const baseEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  thumbnailResults.clear();
  workdir = mkdtempSync(join(tmpdir(), 'hamster-thumb-backfill-'));
  mkdirSync(join(workdir, 'thumbnails'), { recursive: true });
  Object.assign(process.env, baseEnv);
  process.env['DATABASE_PATH'] = join(workdir, 'hamster.db');
  process.env['STORAGE_PATH'] = workdir;
  process.env['ZYPHR_API_KEY'] = 'zy_test_dummy';
  process.env['ZYPHR_APP_SECRET'] = 'zy_test_dummy_secret';
  // FRIGATE_URL set per-test when needed.
  delete process.env['FRIGATE_URL'];
});

afterEach(async () => {
  vi.clearAllMocks();
  const { resetDbForTests } = await import('../src/db.js');
  const { resetConfigForTests } = await import('../src/config.js');
  resetDbForTests();
  resetConfigForTests();
  rmSync(workdir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// db.listDiaryEntriesMissingThumbnail
// ---------------------------------------------------------------------------

describe('db.listDiaryEntriesMissingThumbnail', () => {
  it('returns entries with NULL thumbnail_path within the retention window', async () => {
    const db = await import('../src/db.js');

    const camera = db.createCamera({
      name: 'cam-backfill',
      emoji: '📷',
      stream_url: 'rtsp://cam',
      enabled: true,
    });

    const now = Date.now();
    const recent = db.createDiaryEntry({
      occurred_at: now - 60_000, // 1 minute ago — within any window
      kind: 'narrative',
      activity: 'wheel',
      narrative: 'spinning',
      pet_name: null,
      camera_id: camera.id,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: 30_000,
      snapshot_id: null,
      media_path: null,
      details: null,
    });

    const cutoff = now - 10 * 24 * 60 * 60 * 1000; // 10-day window
    const results = db.listDiaryEntriesMissingThumbnail(cutoff, 50);

    expect(results.some((r) => r.id === recent.id)).toBe(true);
  });

  it('excludes entries older than the retention cutoff', async () => {
    const db = await import('../src/db.js');

    const camera = db.createCamera({
      name: 'cam-old',
      emoji: '📷',
      stream_url: 'rtsp://cam-old',
      enabled: true,
    });

    const old = db.createDiaryEntry({
      occurred_at: 1_000, // epoch + 1s — way outside any retention window
      kind: 'narrative',
      activity: 'food',
      narrative: 'eating',
      pet_name: null,
      camera_id: camera.id,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: null,
      snapshot_id: null,
      media_path: null,
      details: null,
    });

    const cutoff = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const results = db.listDiaryEntriesMissingThumbnail(cutoff, 50);

    expect(results.some((r) => r.id === old.id)).toBe(false);
  });

  it('excludes entries that already have a thumbnail_path', async () => {
    const db = await import('../src/db.js');

    const camera = db.createCamera({
      name: 'cam-has-thumb',
      emoji: '📷',
      stream_url: 'rtsp://cam-has-thumb',
      enabled: true,
    });

    const entry = db.createDiaryEntry({
      occurred_at: Date.now() - 60_000,
      kind: 'narrative',
      activity: 'resting',
      narrative: 'nap',
      pet_name: null,
      camera_id: camera.id,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: null,
      snapshot_id: null,
      media_path: null,
      details: null,
    });
    // Write the thumbnail path so the entry is no longer a candidate.
    db.updateDiaryEntryThumbnailPath(entry.id, join('thumbnails', `entry-${entry.id}-thumb.jpg`));
    writeFileSync(join(workdir, 'thumbnails', `entry-${entry.id}-thumb.jpg`), Buffer.alloc(8));

    const cutoff = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const results = db.listDiaryEntriesMissingThumbnail(cutoff, 50);

    expect(results.some((r) => r.id === entry.id)).toBe(false);
  });

  it('excludes recap entries', async () => {
    const db = await import('../src/db.js');

    const camera = db.createCamera({
      name: 'cam-recap',
      emoji: '📷',
      stream_url: 'rtsp://cam-recap',
      enabled: true,
    });

    const recap = db.createDiaryEntry({
      occurred_at: Date.now() - 60_000,
      kind: 'recap',
      activity: 'recap',
      narrative: 'Today recap',
      pet_name: null,
      camera_id: camera.id,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: null,
      snapshot_id: null,
      media_path: null,
      details: null,
    });

    const cutoff = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const results = db.listDiaryEntriesMissingThumbnail(cutoff, 50);

    expect(results.some((r) => r.id === recap.id)).toBe(false);
  });

  it('excludes entries with no resolvable camera', async () => {
    const db = await import('../src/db.js');

    const no_cam = db.createDiaryEntry({
      occurred_at: Date.now() - 60_000,
      kind: 'narrative',
      activity: 'exploring',
      narrative: 'exploring',
      pet_name: null,
      camera_id: null,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: null,
      snapshot_id: null,
      media_path: null,
      details: null,
    });

    const cutoff = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const results = db.listDiaryEntriesMissingThumbnail(cutoff, 50);

    expect(results.some((r) => r.id === no_cam.id)).toBe(false);
  });

  it('respects limit parameter', async () => {
    const db = await import('../src/db.js');

    const camera = db.createCamera({
      name: 'cam-limit',
      emoji: '📷',
      stream_url: 'rtsp://cam-limit',
      enabled: true,
    });

    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      db.createDiaryEntry({
        occurred_at: now - (i + 1) * 60_000,
        kind: 'narrative',
        activity: 'wheel',
        narrative: `spin ${i}`,
        pet_name: null,
        camera_id: camera.id,
        from_camera_id: null,
        to_camera_id: null,
        duration_ms: null,
        snapshot_id: null,
        media_path: null,
        details: null,
      });
    }

    const cutoff = now - 10 * 24 * 60 * 60 * 1000;
    const results = db.listDiaryEntriesMissingThumbnail(cutoff, 3);

    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('accepts entries where only to_camera_id or from_camera_id is set', async () => {
    const db = await import('../src/db.js');

    const camA = db.createCamera({
      name: 'cam-a',
      emoji: '📷',
      stream_url: 'rtsp://cam-a',
      enabled: true,
    });
    const camB = db.createCamera({
      name: 'cam-b',
      emoji: '📷',
      stream_url: 'rtsp://cam-b',
      enabled: true,
    });

    const now = Date.now();
    const transition = db.createDiaryEntry({
      occurred_at: now - 60_000,
      kind: 'narrative',
      activity: 'transition',
      narrative: 'moved from A to B',
      pet_name: null,
      camera_id: null,
      from_camera_id: camA.id,
      to_camera_id: camB.id,
      duration_ms: null,
      snapshot_id: null,
      media_path: null,
      details: null,
    });

    const cutoff = now - 10 * 24 * 60 * 60 * 1000;
    const results = db.listDiaryEntriesMissingThumbnail(cutoff, 50);

    expect(results.some((r) => r.id === transition.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runThumbnailBackfillJob
// ---------------------------------------------------------------------------

describe('runThumbnailBackfillJob', () => {
  it('skips immediately when FRIGATE_URL is not configured', async () => {
    delete process.env['FRIGATE_URL'];
    const { runThumbnailBackfillJob } = await import('../src/jobs/thumbnail-backfill.js');
    const { generateThumbnailForEntry } = await import('../src/thumbnails.js');

    const result = await runThumbnailBackfillJob();

    expect(result).toEqual({ candidates: 0, succeeded: 0, still_missing: 0 });
    expect(generateThumbnailForEntry).not.toHaveBeenCalled();
  });

  it('returns zeros when there are no candidates', async () => {
    process.env['FRIGATE_URL'] = 'http://frigate:5000';
    const { runThumbnailBackfillJob } = await import('../src/jobs/thumbnail-backfill.js');
    const { generateThumbnailForEntry } = await import('../src/thumbnails.js');

    const result = await runThumbnailBackfillJob();

    expect(result.candidates).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(generateThumbnailForEntry).not.toHaveBeenCalled();
  });

  it('calls generateThumbnailForEntry for each candidate and counts successes', async () => {
    process.env['FRIGATE_URL'] = 'http://frigate:5000';
    const db = await import('../src/db.js');

    const camera = db.createCamera({
      name: 'cam-job',
      emoji: '📷',
      stream_url: 'rtsp://cam-job',
      enabled: true,
    });

    const now = Date.now();
    const entry1 = db.createDiaryEntry({
      occurred_at: now - 60_000,
      kind: 'narrative',
      activity: 'wheel',
      narrative: 'spin',
      pet_name: null,
      camera_id: camera.id,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: null,
      snapshot_id: null,
      media_path: null,
      details: null,
    });
    const entry2 = db.createDiaryEntry({
      occurred_at: now - 120_000,
      kind: 'narrative',
      activity: 'food',
      narrative: 'eating',
      pet_name: null,
      camera_id: camera.id,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: null,
      snapshot_id: null,
      media_path: null,
      details: null,
    });

    // entry1 will succeed; entry2 will not.
    thumbnailResults.set(entry1.id, true);
    thumbnailResults.set(entry2.id, false);

    const { runThumbnailBackfillJob } = await import('../src/jobs/thumbnail-backfill.js');
    const result = await runThumbnailBackfillJob();

    expect(result.candidates).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.still_missing).toBe(1);

    const { generateThumbnailForEntry } = await import('../src/thumbnails.js');
    expect(generateThumbnailForEntry).toHaveBeenCalledTimes(2);
  });

  it('does not process candidates outside the retention window', async () => {
    process.env['FRIGATE_URL'] = 'http://frigate:5000';
    const db = await import('../src/db.js');

    const camera = db.createCamera({
      name: 'cam-stale',
      emoji: '📷',
      stream_url: 'rtsp://cam-stale',
      enabled: true,
    });

    // Occurred 11 days ago — outside the 10-day retention window.
    db.createDiaryEntry({
      occurred_at: Date.now() - 11 * 24 * 60 * 60 * 1000,
      kind: 'narrative',
      activity: 'resting',
      narrative: 'nap',
      pet_name: null,
      camera_id: camera.id,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: null,
      snapshot_id: null,
      media_path: null,
      details: null,
    });

    const { runThumbnailBackfillJob } = await import('../src/jobs/thumbnail-backfill.js');
    const result = await runThumbnailBackfillJob();

    expect(result.candidates).toBe(0);
    const { generateThumbnailForEntry } = await import('../src/thumbnails.js');
    expect(generateThumbnailForEntry).not.toHaveBeenCalled();
  });
});
