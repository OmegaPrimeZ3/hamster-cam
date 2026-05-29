// Unit tests for jobs/thumbnail-backfill.ts and the supporting
// db.listDiaryEntriesMissingThumbnail query helper.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock generateThumbnailForEntryUnguarded so tests don't need a real ffmpeg/Frigate.
// The mock honours a per-test override registered on `thumbnailResults`.
// thumbnailResults.get(id):
//   true      → success (writes thumbnail_path to DB)
//   Error     → throws that error (enables classify-path testing)
//   undefined → success with no path written (simulates skipped entry)
// ---------------------------------------------------------------------------

type ThumbnailOutcome = true | Error | undefined;
const thumbnailResults = new Map<number, ThumbnailOutcome>();

vi.mock('../src/thumbnails.js', () => ({
  generateThumbnailForEntry: vi.fn(async (entry: { id: number }) => {
    const outcome = thumbnailResults.get(entry.id) ?? undefined;
    if (outcome === true) {
      const db = await import('../src/db.js');
      db.updateDiaryEntryThumbnailPath(entry.id, join('thumbnails', `entry-${entry.id}-thumb.jpg`));
    }
    // undefined = return without writing path (silent skip)
  }),
  generateThumbnailForEntryUnguarded: vi.fn(async (entry: { id: number }) => {
    const outcome = thumbnailResults.get(entry.id) ?? undefined;
    if (outcome instanceof Error) {
      throw outcome;
    }
    if (outcome === true) {
      const db = await import('../src/db.js');
      db.updateDiaryEntryThumbnailPath(entry.id, join('thumbnails', `entry-${entry.id}-thumb.jpg`));
    }
    // undefined = return without writing path (silent skip)
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
// Helper: create a camera + diary entry within the retention window
// ---------------------------------------------------------------------------

async function makeEntry(cameraName: string, overrides?: Partial<{
  occurred_at: number;
  kind: string;
  activity: string;
  narrative: string;
}>) {
  const db = await import('../src/db.js');
  const camera = db.createCamera({
    name: cameraName,
    emoji: '📷',
    stream_url: 'rtsp://cam',
    enabled: true,
  });
  const entry = db.createDiaryEntry({
    occurred_at: overrides?.occurred_at ?? Date.now() - 60_000,
    kind: (overrides?.kind ?? 'narrative') as Parameters<typeof db.createDiaryEntry>[0]['kind'],
    activity: (overrides?.activity ?? 'wheel') as Parameters<typeof db.createDiaryEntry>[0]['activity'],
    narrative: overrides?.narrative ?? 'spinning',
    pet_name: null,
    camera_id: camera.id,
    from_camera_id: null,
    to_camera_id: null,
    duration_ms: 30_000,
    snapshot_id: null,
    media_path: null,
    details: null,
  });
  return { camera, entry };
}

// ---------------------------------------------------------------------------
// classifyBackfillError
// ---------------------------------------------------------------------------

describe('classifyBackfillError', () => {
  it('classifies HTTP 400 as permanent', async () => {
    const { classifyBackfillError } = await import('../src/jobs/thumbnail-backfill.js');
    const { FfmpegError } = await import('../src/frigate.js');
    const err = new FfmpegError('ffmpeg exited with code 1', 1, 'Server returned 400 Bad Request\n');
    expect(classifyBackfillError(err)).toBe('permanent');
  });

  it('classifies HTTP 404 as permanent', async () => {
    const { classifyBackfillError } = await import('../src/jobs/thumbnail-backfill.js');
    const { FfmpegError } = await import('../src/frigate.js');
    const err = new FfmpegError('ffmpeg exited with code 1', 1, 'Server returned 404 Not Found\n');
    expect(classifyBackfillError(err)).toBe('permanent');
  });

  it('classifies HTTP 410 as permanent', async () => {
    const { classifyBackfillError } = await import('../src/jobs/thumbnail-backfill.js');
    const { FfmpegError } = await import('../src/frigate.js');
    const err = new FfmpegError('ffmpeg exited with code 1', 1, 'Server returned 410 Gone\n');
    expect(classifyBackfillError(err)).toBe('permanent');
  });

  it('classifies HTTP 401 as permanent', async () => {
    const { classifyBackfillError } = await import('../src/jobs/thumbnail-backfill.js');
    const { FfmpegError } = await import('../src/frigate.js');
    const err = new FfmpegError('ffmpeg exited with code 1', 1, 'Server returned 401 Unauthorized\n');
    expect(classifyBackfillError(err)).toBe('permanent');
  });

  it('classifies ECONNRESET as transient', async () => {
    const { classifyBackfillError } = await import('../src/jobs/thumbnail-backfill.js');
    const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(classifyBackfillError(err)).toBe('transient');
  });

  it('classifies ECONNREFUSED as transient', async () => {
    const { classifyBackfillError } = await import('../src/jobs/thumbnail-backfill.js');
    const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(classifyBackfillError(err)).toBe('transient');
  });

  it('classifies HTTP 429 as transient', async () => {
    const { classifyBackfillError } = await import('../src/jobs/thumbnail-backfill.js');
    const { FfmpegError } = await import('../src/frigate.js');
    const err = new FfmpegError('ffmpeg exited with code 1', 1, 'Server returned 429 Too Many Requests\n');
    expect(classifyBackfillError(err)).toBe('transient');
  });

  it('classifies HTTP 503 as transient', async () => {
    const { classifyBackfillError } = await import('../src/jobs/thumbnail-backfill.js');
    const { FfmpegError } = await import('../src/frigate.js');
    const err = new FfmpegError('ffmpeg exited with code 1', 1, 'Server returned 503 Service Unavailable\n');
    expect(classifyBackfillError(err)).toBe('transient');
  });

  it('classifies unknown errors as transient (conservative default)', async () => {
    const { classifyBackfillError } = await import('../src/jobs/thumbnail-backfill.js');
    const err = new Error('something completely unknown went wrong');
    expect(classifyBackfillError(err)).toBe('transient');
  });
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

  it('excludes entries marked media_unavailable', async () => {
    const db = await import('../src/db.js');

    const { entry } = await makeEntry('cam-unavailable');
    db.markDiaryEntryMediaUnavailable(entry.id, 'http_400');

    const cutoff = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const results = db.listDiaryEntriesMissingThumbnail(cutoff, 50);

    expect(results.some((r) => r.id === entry.id)).toBe(false);
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
// runThumbnailBackfillJob — basic behaviour
// ---------------------------------------------------------------------------

describe('runThumbnailBackfillJob', () => {
  it('skips immediately when FRIGATE_URL is not configured', async () => {
    delete process.env['FRIGATE_URL'];
    const { runThumbnailBackfillJob } = await import('../src/jobs/thumbnail-backfill.js');
    const { generateThumbnailForEntryUnguarded } = await import('../src/thumbnails.js');

    const result = await runThumbnailBackfillJob();

    expect(result).toEqual({ candidates: 0, succeeded: 0, still_missing: 0 });
    expect(generateThumbnailForEntryUnguarded).not.toHaveBeenCalled();
  });

  it('returns zeros when there are no candidates', async () => {
    process.env['FRIGATE_URL'] = 'http://frigate:5000';
    const { runThumbnailBackfillJob } = await import('../src/jobs/thumbnail-backfill.js');
    const { generateThumbnailForEntryUnguarded } = await import('../src/thumbnails.js');

    const result = await runThumbnailBackfillJob();

    expect(result.candidates).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(generateThumbnailForEntryUnguarded).not.toHaveBeenCalled();
  });

  it('calls generateThumbnailForEntryUnguarded for each candidate and counts successes', async () => {
    process.env['FRIGATE_URL'] = 'http://frigate:5000';
    const db = await import('../src/db.js');

    const { entry: entry1 } = await makeEntry('cam-job-1');
    const { entry: entry2 } = await makeEntry('cam-job-2');

    // entry1 will succeed; entry2 will not (no thumbnail written, no throw).
    thumbnailResults.set(entry1.id, true);
    // entry2 left as undefined — generator returns without writing path

    const { runThumbnailBackfillJob } = await import('../src/jobs/thumbnail-backfill.js');
    const result = await runThumbnailBackfillJob();

    expect(result.candidates).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.still_missing).toBe(1);

    const { generateThumbnailForEntryUnguarded } = await import('../src/thumbnails.js');
    expect(generateThumbnailForEntryUnguarded).toHaveBeenCalledTimes(2);

    // entry2: no path written and no error → marked unavailable
    const refreshed2 = db.getDiaryEntryById(entry2.id);
    expect(refreshed2?.media_unavailable).toBe(1);
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
    const { generateThumbnailForEntryUnguarded } = await import('../src/thumbnails.js');
    expect(generateThumbnailForEntryUnguarded).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Attempt counter — increments only on transient failures
// ---------------------------------------------------------------------------

describe('runThumbnailBackfillJob — attempt tracking', () => {
  it('increments media_backfill_attempts on a transient failure', async () => {
    process.env['FRIGATE_URL'] = 'http://frigate:5000';
    const db = await import('../src/db.js');
    const { FfmpegError } = await import('../src/frigate.js');

    const { entry } = await makeEntry('cam-transient');
    const transientErr = new FfmpegError('ffmpeg exited with code 1', 1, 'Server returned 503 Service Unavailable\n');
    thumbnailResults.set(entry.id, transientErr);

    const { runThumbnailBackfillJob } = await import('../src/jobs/thumbnail-backfill.js');
    await runThumbnailBackfillJob();

    const refreshed = db.getDiaryEntryById(entry.id);
    expect(refreshed?.media_backfill_attempts).toBe(1);
    expect(refreshed?.media_unavailable).toBe(0);
    expect(refreshed?.media_backfill_last_error).toBe('http_503');
  });

  it('does NOT increment attempts on a permanent failure (marks unavailable directly)', async () => {
    process.env['FRIGATE_URL'] = 'http://frigate:5000';
    const db = await import('../src/db.js');
    const { FfmpegError } = await import('../src/frigate.js');

    const { entry } = await makeEntry('cam-perm');
    const permErr = new FfmpegError('ffmpeg exited with code 1', 1, 'Server returned 400 Bad Request\n');
    thumbnailResults.set(entry.id, permErr);

    const { runThumbnailBackfillJob } = await import('../src/jobs/thumbnail-backfill.js');
    await runThumbnailBackfillJob();

    const refreshed = db.getDiaryEntryById(entry.id);
    // Attempt counter stays 0 — permanent failures go straight to unavailable.
    expect(refreshed?.media_backfill_attempts).toBe(0);
    expect(refreshed?.media_unavailable).toBe(1);
  });

  it('marks media_unavailable after MAX_TRANSIENT_ATTEMPTS transient failures', async () => {
    process.env['FRIGATE_URL'] = 'http://frigate:5000';
    const db = await import('../src/db.js');
    const { FfmpegError } = await import('../src/frigate.js');
    const { MAX_TRANSIENT_ATTEMPTS } = await import('../src/jobs/thumbnail-backfill.js');

    const { entry } = await makeEntry('cam-maxretry');
    const transientErr = new FfmpegError('ffmpeg exited with code 1', 1, 'Server returned 503 Service Unavailable\n');
    thumbnailResults.set(entry.id, transientErr);

    const { runThumbnailBackfillJob } = await import('../src/jobs/thumbnail-backfill.js');

    // Run MAX_TRANSIENT_ATTEMPTS - 1 times — should still be retrying.
    for (let i = 0; i < MAX_TRANSIENT_ATTEMPTS - 1; i++) {
      await runThumbnailBackfillJob();
      // Re-read DB row after each run to update the entry for the next tick.
      // The job re-queries from DB each tick — no state persists in memory.
    }

    let refreshed = db.getDiaryEntryById(entry.id);
    expect(refreshed?.media_backfill_attempts).toBe(MAX_TRANSIENT_ATTEMPTS - 1);
    expect(refreshed?.media_unavailable).toBe(0);

    // One more run should tip it over the limit.
    await runThumbnailBackfillJob();

    refreshed = db.getDiaryEntryById(entry.id);
    expect(refreshed?.media_backfill_attempts).toBe(MAX_TRANSIENT_ATTEMPTS);
    expect(refreshed?.media_unavailable).toBe(1);
    expect(refreshed?.media_backfill_last_error).toBe('max_transient_attempts');
  });

  it('stops picking up a candidate once media_unavailable is set', async () => {
    process.env['FRIGATE_URL'] = 'http://frigate:5000';
    const db = await import('../src/db.js');

    const { entry } = await makeEntry('cam-excluded');
    db.markDiaryEntryMediaUnavailable(entry.id, 'http_400');

    const { runThumbnailBackfillJob } = await import('../src/jobs/thumbnail-backfill.js');
    const { generateThumbnailForEntryUnguarded } = await import('../src/thumbnails.js');

    await runThumbnailBackfillJob();

    // generateThumbnailForEntryUnguarded should never have been called for
    // this entry since it was already excluded from the candidate query.
    expect(generateThumbnailForEntryUnguarded).not.toHaveBeenCalled();
  });
});
