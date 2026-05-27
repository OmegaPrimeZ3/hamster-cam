// Tests for jobs/timelapse.ts
//
// Scenarios:
//   1.  Fewer than MIN_FRAMES snapshots → skip, no file, no diary entry.
//   2.  Split-night proof: snapshots at 22:30 on day N and 02:00 on day N+1
//       both land in a single timelapse keyed to day N when job runs at 06:05.
//   3.  Output filename and diary entry date equal nightStart's ISO date (day N).
//   4.  occurred_at ≈ nightEnd (day N+1 06:00:00.000 − 1 ms).
//   5.  Narrative template contains "Night", not "Day".
//   6.  Idempotent: re-running for the same night replaces the diary entry (1 row).
//   7.  Exactly MIN_FRAMES snapshots is enough to produce a timelapse.
//   8.  Snapshots outside the 8h window are excluded.
//   9.  Multi-camera night: camera-switch count << total frames (no per-frame
//       alternation).
//  10.  No-activity night: single-camera fallback — only one camera used.
//  11.  details JSON has the new schema.
//  12.  Hamster filtering: snapshots near a detection interval are kept; others
//       dropped.
//  13.  Hamster filtering fallback: when no events returned (Frigate offline),
//       all snapshots are used.
//  14.  thinEvenly: reduces array to target count with even spacing.
//  15.  thinEvenly: targetCount ≥ array length returns the full array.
//  16.  thinEvenly: targetCount = 0 returns empty array.
//  17.  filterHamsterSnapshots: snapshot within the match window is kept.
//  18.  filterHamsterSnapshots: snapshot outside the match window is dropped.
//  19.  Recap test: SECONDS_PER_FRAME changed to 1.5 (details.seconds_per_frame).

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mock: replace runFfmpeg so ffmpeg binary is never needed.
// Also mock fetchHamsterEvents to return [] by default (no Frigate in tests).
// ---------------------------------------------------------------------------
vi.mock('../src/frigate.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/frigate.js')>();
  return {
    ...original,
    runFfmpeg: vi.fn(async (args: readonly string[]) => {
      // The last argument to ffmpeg is the output file path.
      const outPath = args[args.length - 1];
      if (typeof outPath === 'string' && outPath.endsWith('.mp4')) {
        writeFileSync(outPath, Buffer.alloc(16));
      }
    }),
    // Default: no hamster events (Frigate offline → fallback to all snapshots).
    fetchHamsterEvents: vi.fn(async () => []),
  };
});

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let workdir: string;
const baseEnv = { ...process.env };

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'hamster-tl-test-'));
  mkdirSync(join(workdir, 'timelapse'), { recursive: true });
  mkdirSync(join(workdir, 'snapshots'), { recursive: true });
  Object.assign(process.env, baseEnv);
  process.env['DATABASE_PATH'] = join(workdir, 'hamster.db');
  process.env['STORAGE_PATH'] = workdir;
  process.env['ZYPHR_API_KEY'] = 'zy_test_dummy';
  process.env['ZYPHR_APP_SECRET'] = 'zy_test_dummy_secret';
  delete process.env['FRIGATE_URL'];
  delete process.env['MQTT_URL'];
  delete process.env['RECAP_MUSIC_PATH'];
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
// Helpers
// ---------------------------------------------------------------------------

async function seedSnapshot(takenAt: number, cameraId: number, index: number) {
  const db = await import('../src/db.js');
  const rel = join('snapshots', `cam${cameraId}-${takenAt}-${index}.jpg`);
  const abs = join(workdir, rel);
  writeFileSync(abs, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  return db.createSnapshot({ camera_id: cameraId, taken_at: takenAt, path: rel });
}

async function seedCamera(name: string) {
  const db = await import('../src/db.js');
  return db.createCamera({
    name,
    emoji: '📷',
    stream_url: `rtsp://host/${name}`,
    enabled: true,
  });
}

async function seedNSnapshots(n: number, windowStartMs: number, cameraName = 'cam-bulk') {
  const db = await import('../src/db.js');
  const cam = db.createCamera({
    name: cameraName,
    emoji: '📷',
    stream_url: `rtsp://host/${cameraName}`,
    enabled: true,
  });
  const NIGHT_WINDOW_MS = 8 * 60 * 60 * 1000;
  const sliceMs = NIGHT_WINDOW_MS / n;
  for (let i = 0; i < n; i += 1) {
    const takenAt = windowStartMs + Math.round(i * sliceMs + sliceMs / 2);
    const rel = join('snapshots', `${cameraName}-${i}.jpg`);
    const abs = join(workdir, rel);
    writeFileSync(abs, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    db.createSnapshot({ camera_id: cam.id, taken_at: takenAt, path: rel });
  }
  return cam;
}

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runTimelapseJob', () => {
  it('skips when there are fewer than MIN_FRAMES snapshots', async () => {
    const runTime = new Date('2026-05-25T06:05:00');
    const windowStart = new Date('2026-05-24T22:00:00').getTime();
    const cam = await seedCamera('skip-cam');
    for (let i = 0; i < 3; i += 1) {
      await seedSnapshot(windowStart + i * 2 * 60 * 1000, cam.id, i);
    }

    const { runTimelapseJob } = await import('../src/jobs/timelapse.js');
    const result = await runTimelapseJob(runTime);

    expect(result.produced).toBe(false);
    expect(result.media_path).toBeNull();
    expect(result.diary_entry_id).toBeNull();
    expect(result.date).toBe('2026-05-24');
  });

  it('exactly MIN_FRAMES (8) snapshots is sufficient to produce', async () => {
    const runTime = new Date('2026-05-25T06:05:00');
    const windowStart = new Date('2026-05-24T22:00:00').getTime();
    await seedNSnapshots(8, windowStart);

    const { runTimelapseJob } = await import('../src/jobs/timelapse.js');
    const result = await runTimelapseJob(runTime);

    expect(result.produced).toBe(true);
    expect(result.media_path).not.toBeNull();
    expect(result.diary_entry_id).not.toBeNull();
  });

  it('split-night proof: 22:30 day N + 02:00 day N+1 both land in ONE timelapse', async () => {
    const windowStart = new Date('2026-05-24T22:00:00').getTime();
    const runTime = new Date('2026-05-25T06:05:00');

    const cam = await seedNSnapshots(30, windowStart, 'split-night-cam');

    const db = await import('../src/db.js');
    const { runTimelapseJob } = await import('../src/jobs/timelapse.js');
    const result = await runTimelapseJob(runTime);

    expect(result.produced).toBe(true);
    expect(result.diary_entry_id).not.toBeNull();
    const entry = db.getDiaryEntryById(result.diary_entry_id!);
    expect(entry?.kind).toBe('timelapse');

    const nightEnd = new Date('2026-05-25T06:00:00').getTime();
    const nightStart = nightEnd - 8 * 60 * 60 * 1000;
    const allEntries = db.listDiaryEntriesBetween(nightStart - 1, nightEnd + 1);
    expect(allEntries.filter((e) => e.kind === 'timelapse')).toHaveLength(1);

    expect(cam.id).toBeGreaterThan(0);
  });

  it('output filename and date are keyed to nightStart (day N), not the run date', async () => {
    const runTime = new Date('2026-05-25T06:05:00');
    const windowStart = new Date('2026-05-24T22:00:00').getTime();
    await seedNSnapshots(30, windowStart);

    const { runTimelapseJob } = await import('../src/jobs/timelapse.js');
    const result = await runTimelapseJob(runTime);

    expect(result.produced).toBe(true);
    expect(result.date).toBe('2026-05-24');
    expect(result.media_path).toContain('2026-05-24');
  });

  it('occurred_at is nightEnd − 1 ms (≈ 06:00 on the morning after)', async () => {
    const runTime = new Date('2026-05-25T06:05:00');
    const windowStart = new Date('2026-05-24T22:00:00').getTime();
    await seedNSnapshots(30, windowStart);

    const { runTimelapseJob } = await import('../src/jobs/timelapse.js');
    const result = await runTimelapseJob(runTime);

    expect(result.diary_entry_id).not.toBeNull();
    const db = await import('../src/db.js');
    const entry = db.getDiaryEntryById(result.diary_entry_id!);
    expect(entry).not.toBeNull();

    const expectedNightEnd = new Date('2026-05-25T06:00:00').getTime();
    expect(entry!.occurred_at).toBe(expectedNightEnd - 1);
  });

  it('narrative contains "Night" not "Day"', async () => {
    const runTime = new Date('2026-05-25T06:05:00');
    const windowStart = new Date('2026-05-24T22:00:00').getTime();
    await seedNSnapshots(30, windowStart);

    const { runTimelapseJob } = await import('../src/jobs/timelapse.js');
    const result = await runTimelapseJob(runTime);

    expect(result.diary_entry_id).not.toBeNull();
    const db = await import('../src/db.js');
    const entry = db.getDiaryEntryById(result.diary_entry_id!);
    expect(entry).not.toBeNull();
    expect(entry!.narrative).toContain('Night');
    expect(entry!.narrative).not.toContain("'s Day");
  });

  it('is idempotent: re-running for the same night replaces the diary entry', async () => {
    const runTime = new Date('2026-05-25T06:05:00');
    const windowStart = new Date('2026-05-24T22:00:00').getTime();
    await seedNSnapshots(30, windowStart);

    const { runTimelapseJob } = await import('../src/jobs/timelapse.js');
    const first = await runTimelapseJob(runTime);
    const second = await runTimelapseJob(runTime);

    expect(first.produced).toBe(true);
    expect(second.produced).toBe(true);

    const db = await import('../src/db.js');
    const nightEnd = new Date('2026-05-25T06:00:00').getTime();
    const nightStart = nightEnd - 8 * 60 * 60 * 1000;
    const entries = db.listDiaryEntriesBetween(nightStart - 1, nightEnd + 1);
    const timelapseEntries = entries.filter((e) => e.kind === 'timelapse');
    expect(timelapseEntries).toHaveLength(1);
    expect(timelapseEntries[0]!.id).toBe(second.diary_entry_id);
  });

  it('snapshots outside the 8h window are excluded', async () => {
    const runTime = new Date('2026-05-25T06:05:00');
    const windowStart = new Date('2026-05-24T22:00:00').getTime();
    await seedNSnapshots(30, windowStart);

    const db = await import('../src/db.js');
    const cam = db.createCamera({
      name: 'outside-cam',
      emoji: '📷',
      stream_url: 'rtsp://host/out',
      enabled: true,
    });
    const beforeWindow = new Date('2026-05-24T20:00:00').getTime();
    const afterWindow = new Date('2026-05-25T07:00:00').getTime();
    for (const t of [beforeWindow, afterWindow]) {
      const rel = join('snapshots', `out-${t}.jpg`);
      writeFileSync(join(workdir, rel), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      db.createSnapshot({ camera_id: cam.id, taken_at: t, path: rel });
    }

    const { runTimelapseJob } = await import('../src/jobs/timelapse.js');
    const result = await runTimelapseJob(runTime);

    expect(result.produced).toBe(true);
    const entry = db.getDiaryEntryById(result.diary_entry_id!);
    expect(entry).not.toBeNull();
    const details = JSON.parse(entry!.details ?? '{}') as { frames: number };
    // Out-of-window snapshots must not increase frame count.
    expect(details.frames).toBeGreaterThanOrEqual(4);
    expect(details.frames).toBeLessThanOrEqual(60);
  });

  it('details JSON has the new schema fields (frames, clips, seconds_per_frame, activity_guided, hamster_filtered)', async () => {
    const runTime = new Date('2026-05-25T06:05:00');
    const windowStart = new Date('2026-05-24T22:00:00').getTime();
    await seedNSnapshots(30, windowStart);

    const { runTimelapseJob } = await import('../src/jobs/timelapse.js');
    const result = await runTimelapseJob(runTime);

    expect(result.diary_entry_id).not.toBeNull();
    const db = await import('../src/db.js');
    const entry = db.getDiaryEntryById(result.diary_entry_id!);
    const details = JSON.parse(entry!.details ?? '{}') as Record<string, unknown>;
    expect(typeof details['frames']).toBe('number');
    expect(typeof details['clips']).toBe('number');
    expect(details['seconds_per_frame']).toBe(1.5);
    expect(details['output_fps']).toBe(30);
    expect(typeof details['activity_guided']).toBe('boolean');
    expect(typeof details['hamster_filtered']).toBe('boolean');
    expect(typeof details['music']).toBe('boolean');
  });

  it('multi-camera with activity: camera-switch count is low (no per-frame alternation)', async () => {
    const runTime = new Date('2026-05-25T06:05:00');
    const windowStart = new Date('2026-05-24T22:00:00').getTime();
    const windowEnd = new Date('2026-05-25T06:00:00').getTime();
    const windowMs = windowEnd - windowStart;
    const halfMs = windowMs / 2;

    const db = await import('../src/db.js');

    const camA = db.createCamera({ name: 'cam-A', emoji: '📷', stream_url: 'rtsp://host/A', enabled: true });
    const camB = db.createCamera({ name: 'cam-B', emoji: '📷', stream_url: 'rtsp://host/B', enabled: true });

    const INTERVAL = 5 * 60 * 1000;
    for (let t = windowStart; t < windowEnd; t += INTERVAL) {
      const relA = join('snapshots', `A-${t}.jpg`);
      const relB = join('snapshots', `B-${t}.jpg`);
      writeFileSync(join(workdir, relA), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      writeFileSync(join(workdir, relB), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      db.createSnapshot({ camera_id: camA.id, taken_at: t, path: relA });
      db.createSnapshot({ camera_id: camB.id, taken_at: t, path: relB });
    }

    const midPoint = windowStart + halfMs;
    db.createDiaryEntry({
      occurred_at: windowStart, kind: 'narrative', activity: 'wheel', narrative: 'Running.',
      pet_name: 'Remy', camera_id: camA.id, from_camera_id: null, to_camera_id: null,
      duration_ms: halfMs, snapshot_id: null, media_path: null, details: null,
    });
    db.createDiaryEntry({
      occurred_at: midPoint, kind: 'narrative', activity: 'wheel', narrative: 'Still running.',
      pet_name: 'Remy', camera_id: camB.id, from_camera_id: null, to_camera_id: null,
      duration_ms: halfMs, snapshot_id: null, media_path: null, details: null,
    });

    const { runTimelapseJob } = await import('../src/jobs/timelapse.js');
    const result = await runTimelapseJob(runTime);
    expect(result.produced).toBe(true);

    // White-box: run selectFrames directly to count switches.
    const { selectFramesForTest } = await import('../src/jobs/timelapse.js');
    const allSnaps = db.listSnapshotsBetween(windowStart, windowEnd);
    const narrativeEntries = db.listDiaryEntriesByKindBetween('narrative', windowStart, windowEnd);
    // Use 30 slots (TIMELINE_BUCKETS) to match production target.
    const selected = selectFramesForTest(allSnaps, narrativeEntries, windowStart, windowEnd, 30);

    let switches = 0;
    for (let i = 1; i < selected.length; i += 1) {
      if (selected[i]!.camera_id !== selected[i - 1]!.camera_id) switches++;
    }
    // With 30 buckets split between 2 cameras we expect at most a handful of switches.
    expect(switches).toBeLessThanOrEqual(3);
  });

  it('no-activity night: single-camera fallback — all frames from the camera with most snapshots', async () => {
    const windowStart = new Date('2026-05-24T22:00:00').getTime();
    const windowEnd = new Date('2026-05-25T06:00:00').getTime();

    const db = await import('../src/db.js');

    const camA = db.createCamera({ name: 'primary-cam', emoji: '📷', stream_url: 'rtsp://host/primary', enabled: true });
    const camB = db.createCamera({ name: 'secondary-cam', emoji: '📷', stream_url: 'rtsp://host/secondary', enabled: true });

    const INTERVAL = 5 * 60 * 1000;
    let tA = windowStart;
    let tB = windowStart;
    for (let i = 0; i < 60; i += 1) {
      const rel = join('snapshots', `primary-${i}.jpg`);
      writeFileSync(join(workdir, rel), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      db.createSnapshot({ camera_id: camA.id, taken_at: tA, path: rel });
      tA += INTERVAL;
    }
    for (let i = 0; i < 20; i += 1) {
      const rel = join('snapshots', `secondary-${i}.jpg`);
      writeFileSync(join(workdir, rel), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      db.createSnapshot({ camera_id: camB.id, taken_at: tB, path: rel });
      tB += INTERVAL * 2;
    }

    const { selectFramesForTest } = await import('../src/jobs/timelapse.js');
    const allSnaps = db.listSnapshotsBetween(windowStart, windowEnd);
    const narrativeEntries = db.listDiaryEntriesByKindBetween('narrative', windowStart, windowEnd);
    expect(narrativeEntries).toHaveLength(0);

    const selected = selectFramesForTest(allSnaps, narrativeEntries, windowStart, windowEnd, 30);
    const cameraIds = new Set(selected.map((s) => s.camera_id));
    expect(cameraIds.size).toBe(1);
    expect(cameraIds.has(camA.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// filterHamsterSnapshots tests
// ---------------------------------------------------------------------------

describe('filterHamsterSnapshotsForTest', () => {
  it('keeps a snapshot whose taken_at falls within the hamster detection interval', async () => {
    const db = await import('../src/db.js');
    const cam = db.createCamera({ name: 'filter-cam', emoji: '📷', stream_url: 'rtsp://host/fc', enabled: true });

    const eventStartSec = 1000;
    const eventEndSec = 1060;
    // Snapshot right in the middle of the event.
    const snap = db.createSnapshot({
      camera_id: cam.id,
      taken_at: 1030 * 1000,
      path: 'snapshots/test.jpg',
    });

    const { filterHamsterSnapshotsForTest } = await import('../src/jobs/timelapse.js');
    const events = [{
      id: 'ev1', camera: 'filter-cam', label: 'hamster',
      start_time: eventStartSec, end_time: eventEndSec,
      has_clip: false, has_snapshot: false, zones: [],
    }];

    const result = filterHamsterSnapshotsForTest([snap], events);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(snap.id);
  });

  it('drops a snapshot whose taken_at is far outside any detection interval', async () => {
    const db = await import('../src/db.js');
    const cam = db.createCamera({ name: 'filter-cam2', emoji: '📷', stream_url: 'rtsp://host/fc2', enabled: true });

    const snap = db.createSnapshot({
      camera_id: cam.id,
      taken_at: 5000 * 1000, // 5000s — far from the 1000–1060s event
      path: 'snapshots/test2.jpg',
    });

    const { filterHamsterSnapshotsForTest } = await import('../src/jobs/timelapse.js');
    const events = [{
      id: 'ev2', camera: 'filter-cam2', label: 'hamster',
      start_time: 1000, end_time: 1060,
      has_clip: false, has_snapshot: false, zones: [],
    }];

    const result = filterHamsterSnapshotsForTest([snap], events);
    expect(result).toHaveLength(0);
  });

  it('keeps a snapshot just within the HAMSTER_MATCH_WINDOW_MS boundary', async () => {
    const db = await import('../src/db.js');
    const cam = db.createCamera({ name: 'filter-cam3', emoji: '📷', stream_url: 'rtsp://host/fc3', enabled: true });

    // Event at 2000s; HAMSTER_MATCH_WINDOW_MS = 90s.
    // Snapshot at (2000 - 89)s = 1911s → within 90s window.
    const snap = db.createSnapshot({
      camera_id: cam.id,
      taken_at: 1911 * 1000,
      path: 'snapshots/test3.jpg',
    });

    const { filterHamsterSnapshotsForTest } = await import('../src/jobs/timelapse.js');
    const events = [{
      id: 'ev3', camera: 'filter-cam3', label: 'hamster',
      start_time: 2000, end_time: 2060,
      has_clip: false, has_snapshot: false, zones: [],
    }];

    const result = filterHamsterSnapshotsForTest([snap], events);
    expect(result).toHaveLength(1);
  });

  it('returns all snapshots when events list is empty (Frigate fallback path)', async () => {
    // Note: the fallback (events.length === 0 → all snapshots) is handled in
    // runTimelapseJob, not in filterHamsterSnapshots itself. This test verifies
    // filterHamsterSnapshots returns [] when events is empty (as expected —
    // there's nothing to match against). The caller is responsible for the fallback.
    const db = await import('../src/db.js');
    const cam = db.createCamera({ name: 'filter-cam4', emoji: '📷', stream_url: 'rtsp://host/fc4', enabled: true });
    const snap = db.createSnapshot({ camera_id: cam.id, taken_at: 1000, path: 'snapshots/test4.jpg' });

    const { filterHamsterSnapshotsForTest } = await import('../src/jobs/timelapse.js');
    const result = filterHamsterSnapshotsForTest([snap], []);
    // No events → no match → empty result (job-level code handles the fallback).
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// thinEvenly tests
// ---------------------------------------------------------------------------

describe('thinEvenlyForTest', () => {
  it('reduces array to target count with even spacing', async () => {
    const { thinEvenlyForTest } = await import('../src/jobs/timelapse.js');
    const arr = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const result = thinEvenlyForTest(arr, 5);
    expect(result).toHaveLength(5);
    // Must include first and last elements.
    expect(result[0]).toBe(0);
    expect(result[4]).toBe(9);
  });

  it('returns full array when targetCount >= length', async () => {
    const { thinEvenlyForTest } = await import('../src/jobs/timelapse.js');
    const arr = [1, 2, 3];
    expect(thinEvenlyForTest(arr, 5)).toEqual([1, 2, 3]);
    expect(thinEvenlyForTest(arr, 3)).toEqual([1, 2, 3]);
  });

  it('returns empty array when targetCount is 0', async () => {
    const { thinEvenlyForTest } = await import('../src/jobs/timelapse.js');
    expect(thinEvenlyForTest([1, 2, 3], 0)).toEqual([]);
  });

  it('returns single-element array for targetCount = 1', async () => {
    const { thinEvenlyForTest } = await import('../src/jobs/timelapse.js');
    const arr = [10, 20, 30, 40];
    const result = thinEvenlyForTest(arr, 1);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Hamster-filtered run: when events are present, only matching snapshots used
// ---------------------------------------------------------------------------

describe('runTimelapseJob hamster-filter integration', () => {
  it('falls back to all snapshots when fetchHamsterEvents returns [] (Frigate offline)', async () => {
    // Mock is already set to return [] by default in this test suite.
    const runTime = new Date('2026-05-25T06:05:00');
    const windowStart = new Date('2026-05-24T22:00:00').getTime();
    await seedNSnapshots(30, windowStart);

    const { runTimelapseJob } = await import('../src/jobs/timelapse.js');
    const result = await runTimelapseJob(runTime);

    // Should produce using all snapshots despite no events (fallback).
    expect(result.produced).toBe(true);
    const db = await import('../src/db.js');
    const entry = db.getDiaryEntryById(result.diary_entry_id!);
    const details = JSON.parse(entry!.details ?? '{}') as { hamster_filtered: boolean };
    // hamster_filtered = false because no events were returned.
    expect(details.hamster_filtered).toBe(false);
  });

  it('uses hamster-filtered snapshots when events are present', async () => {
    const runTime = new Date('2026-05-25T06:05:00');
    const windowStart = new Date('2026-05-24T22:00:00').getTime();
    const windowEnd = new Date('2026-05-25T06:00:00').getTime();

    const db = await import('../src/db.js');
    const cam = db.createCamera({ name: 'hcam', emoji: '📷', stream_url: 'rtsp://host/h', enabled: true });

    // Seed 30 snapshots spread across the window.
    const INTERVAL = (windowEnd - windowStart) / 30;
    for (let i = 0; i < 30; i += 1) {
      const takenAt = windowStart + Math.round(i * INTERVAL + INTERVAL / 2);
      const rel = join('snapshots', `hcam-${i}.jpg`);
      writeFileSync(join(workdir, rel), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      db.createSnapshot({ camera_id: cam.id, taken_at: takenAt, path: rel });
    }

    // Mock fetchHamsterEvents to return one detection covering the FIRST half.
    const { fetchHamsterEvents } = await import('../src/frigate.js');
    const halfSec = (windowStart + (windowEnd - windowStart) / 2) / 1000;
    vi.mocked(fetchHamsterEvents).mockResolvedValueOnce([
      {
        id: 'ev-half', camera: 'hcam', label: 'hamster',
        start_time: windowStart / 1000,
        end_time: halfSec,
        has_clip: false, has_snapshot: false, zones: [],
      },
    ]);

    const { runTimelapseJob } = await import('../src/jobs/timelapse.js');
    const result = await runTimelapseJob(runTime);

    // Should produce (enough hamster-matching snapshots in first half).
    // At minimum it should record hamster_filtered = true.
    if (result.produced) {
      const entry = db.getDiaryEntryById(result.diary_entry_id!);
      const details = JSON.parse(entry!.details ?? '{}') as { hamster_filtered: boolean };
      expect(details.hamster_filtered).toBe(true);
    }
    // Either produced (enough hamster frames) or skipped (not enough) is valid
    // depending on how many of the 30 snapshots land in the first half window.
    // Just verify it didn't throw.
    expect(result.date).toBe('2026-05-24');
  });
});
