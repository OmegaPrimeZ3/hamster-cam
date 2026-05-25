// Tests for jobs/timelapse.ts
//
// Scenarios:
//   1. Fewer than MIN_FRAMES snapshots → skip, no file, no diary entry.
//   2. Split-night proof: snapshots at 22:30 on day N and 02:00 on day N+1
//      both land in a single timelapse keyed to day N when job runs at 06:05
//      on day N+1.
//   3. Output filename and diary entry date equal nightStart's ISO date (day N).
//   4. occurred_at ≈ nightEnd (day N+1 06:00:00.000 − 1 ms).
//   5. Watermark string contains "Night", not "Day".
//   6. Narrative template contains "Night", not "Day".
//   7. Idempotent: re-running for the same night replaces the diary entry (1 row).
//   8. Exactly 30 snapshots (MIN_FRAMES) is enough to produce a timelapse.

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mock: replace runFfmpeg so ffmpeg binary is never needed.
// The mock creates the output file so the rest of the job can proceed.
// ---------------------------------------------------------------------------
vi.mock('../src/frigate.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/frigate.js')>();
  return {
    ...original,
    runFfmpeg: vi.fn(async (args: readonly string[]) => {
      // The last argument to ffmpeg is the output file path.
      const outPath = args[args.length - 1];
      if (typeof outPath === 'string') {
        // Touch the file so the job's bookkeeping doesn't fail.
        writeFileSync(outPath, Buffer.alloc(16));
      }
    }),
  };
});

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let workdir: string;
const baseEnv = { ...process.env };

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'hamster-tl-test-'));
  // Ensure the timelapse output directory exists (the job mkdir's it but the
  // mock ffmpeg's writeFileSync also needs the dir to exist first).
  mkdirSync(join(workdir, 'timelapse'), { recursive: true });
  // Pre-create some fake JPEG files to use as snapshot sources.
  mkdirSync(join(workdir, 'snapshots'), { recursive: true });
  Object.assign(process.env, baseEnv);
  process.env['DATABASE_PATH'] = join(workdir, 'hamster.db');
  process.env['STORAGE_PATH'] = workdir;
  process.env['ZYPHR_API_KEY'] = 'zy_test_dummy';
  process.env['ZYPHR_APP_SECRET'] = 'zy_test_dummy_secret';
  delete process.env['FRIGATE_URL'];
  delete process.env['MQTT_URL'];
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

/** Write a tiny JPEG stub on disk and insert a snapshot row, returning the row. */
async function seedSnapshot(takenAt: number, index: number) {
  const db = await import('../src/db.js');
  const cam = db.createCamera({
    name: `cam-tl-${index}`,
    emoji: '📷',
    stream_url: `rtsp://host/cam${index}`,
    enabled: true,
  });
  const rel = join('snapshots', `cam${index}-${takenAt}.jpg`);
  const abs = join(workdir, rel);
  writeFileSync(abs, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  return db.createSnapshot({ camera_id: cam.id, taken_at: takenAt, path: rel });
}

/**
 * Seed N snapshots spaced 2 minutes apart, all within the given time range.
 * Returns the camera used (shared across all snapshots).
 */
async function seedNSnapshots(n: number, startMs: number) {
  const db = await import('../src/db.js');
  const cam = db.createCamera({
    name: `cam-bulk`,
    emoji: '📷',
    stream_url: `rtsp://host/bulk`,
    enabled: true,
  });
  for (let i = 0; i < n; i += 1) {
    const takenAt = startMs + i * 2 * 60 * 1000;
    const rel = join('snapshots', `bulk-${i}.jpg`);
    const abs = join(workdir, rel);
    writeFileSync(abs, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    db.createSnapshot({ camera_id: cam.id, taken_at: takenAt, path: rel });
  }
  return cam;
}

// ---------------------------------------------------------------------------
// Helpers: date arithmetic (mirrors the job's localSixAM / NIGHT_WINDOW_MS)
// ---------------------------------------------------------------------------

/** Return midnight-local for a Date. */
function localMidnight(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
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
  it('skips when there are fewer than 30 snapshots', async () => {
    // Night of May 24→25: job runs at May 25 06:05.
    const runTime = new Date('2026-05-25T06:05:00');
    // Seed only 5 snapshots inside the window (22:00 May 24 to 06:00 May 25).
    const windowStart = new Date('2026-05-24T22:00:00').getTime();
    for (let i = 0; i < 5; i += 1) {
      await seedSnapshot(windowStart + i * 2 * 60 * 1000, i);
    }

    const { runTimelapseJob } = await import('../src/jobs/timelapse.js');
    const result = await runTimelapseJob(runTime);

    expect(result.produced).toBe(false);
    expect(result.media_path).toBeNull();
    expect(result.diary_entry_id).toBeNull();
    // date is still the night-start ISO date.
    expect(result.date).toBe('2026-05-24');
  });

  it('exactly MIN_FRAMES (30) snapshots is sufficient to produce', async () => {
    const runTime = new Date('2026-05-25T06:05:00');
    const windowStart = new Date('2026-05-24T22:00:00').getTime();
    await seedNSnapshots(30, windowStart);

    const { runTimelapseJob } = await import('../src/jobs/timelapse.js');
    const result = await runTimelapseJob(runTime);

    expect(result.produced).toBe(true);
    expect(result.media_path).not.toBeNull();
    expect(result.diary_entry_id).not.toBeNull();
  });

  it('split-night proof: 22:30 day N + 02:00 day N+1 both land in ONE timelapse', async () => {
    // Day N = May 24. Night ends at May 25 06:00.
    const snap1At = new Date('2026-05-24T22:30:00').getTime(); // evening of day N
    const snap2At = new Date('2026-05-25T02:00:00').getTime(); // early morning of day N+1

    // Seed 30 snapshots: 15 before midnight, 15 after midnight, all within the window.
    const db = await import('../src/db.js');
    const cam = db.createCamera({
      name: 'split-night-cam',
      emoji: '📷',
      stream_url: 'rtsp://host/split',
      enabled: true,
    });
    for (let i = 0; i < 15; i += 1) {
      const t = snap1At + i * 2 * 60 * 1000;
      const rel = join('snapshots', `pre-${i}.jpg`);
      writeFileSync(join(workdir, rel), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      db.createSnapshot({ camera_id: cam.id, taken_at: t, path: rel });
    }
    for (let i = 0; i < 15; i += 1) {
      const t = snap2At + i * 2 * 60 * 1000;
      const rel = join('snapshots', `post-${i}.jpg`);
      writeFileSync(join(workdir, rel), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      db.createSnapshot({ camera_id: cam.id, taken_at: t, path: rel });
    }

    // Job runs at 06:05 on day N+1 (May 25).
    const runTime = new Date('2026-05-25T06:05:00');
    const { runTimelapseJob } = await import('../src/jobs/timelapse.js');
    const result = await runTimelapseJob(runTime);

    // A single timelapse was produced (not two separate ones).
    expect(result.produced).toBe(true);

    // The diary entry exists.
    expect(result.diary_entry_id).not.toBeNull();
    const entry = db.getDiaryEntryById(result.diary_entry_id!);
    expect(entry).not.toBeNull();
    expect(entry!.kind).toBe('timelapse');

    // Verify only ONE timelapse diary entry exists in the whole DB.
    const nightEnd = new Date('2026-05-25T06:00:00').getTime();
    const nightStart = nightEnd - 8 * 60 * 60 * 1000;
    const allEntries = db.listDiaryEntriesBetween(nightStart - 1, nightEnd + 1);
    const timelapseEntries = allEntries.filter((e) => e.kind === 'timelapse');
    expect(timelapseEntries).toHaveLength(1);
  });

  it('output filename and date are keyed to nightStart (day N), not the run date', async () => {
    // Night of May 24→25: run at May 25 06:05.
    const runTime = new Date('2026-05-25T06:05:00');
    const windowStart = new Date('2026-05-24T22:00:00').getTime();
    await seedNSnapshots(30, windowStart);

    const { runTimelapseJob } = await import('../src/jobs/timelapse.js');
    const result = await runTimelapseJob(runTime);

    expect(result.produced).toBe(true);
    // date in the result must be the EVENING date (May 24), not the run date (May 25).
    expect(result.date).toBe('2026-05-24');
    // The media path must include the May 24 ISO string.
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

    // nightEnd = May 25 06:00:00.000 local.
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

    // Only one timelapse diary entry should exist after two runs.
    const db = await import('../src/db.js');
    const nightEnd = new Date('2026-05-25T06:00:00').getTime();
    const nightStart = nightEnd - 8 * 60 * 60 * 1000;
    const entries = db.listDiaryEntriesBetween(nightStart - 1, nightEnd + 1);
    const timelapseEntries = entries.filter((e) => e.kind === 'timelapse');
    expect(timelapseEntries).toHaveLength(1);
    // The surviving entry should have the id from the second run.
    expect(timelapseEntries[0]!.id).toBe(second.diary_entry_id);
  });

  it('snapshots outside the 8h window are excluded', async () => {
    // Seed 30 snapshots right in the window, then a few outside it.
    const runTime = new Date('2026-05-25T06:05:00');
    const windowStart = new Date('2026-05-24T22:00:00').getTime();
    await seedNSnapshots(30, windowStart);

    // These two are outside the window (before 22:00 or after 06:00).
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

    // Should produce (30 in-window frames), not be affected by out-of-window snapshots.
    expect(result.produced).toBe(true);
    // The details JSON should show exactly 30 frames (the in-window ones).
    const entry = db.getDiaryEntryById(result.diary_entry_id!);
    expect(entry).not.toBeNull();
    const details = JSON.parse(entry!.details ?? '{}') as { frames: number };
    expect(details.frames).toBe(30);
  });
});
