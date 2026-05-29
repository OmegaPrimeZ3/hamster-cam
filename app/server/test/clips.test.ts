// Unit tests for src/clips.ts — ensureClip caching logic.
//
// We test the three resolution branches:
//   1. Cache hit: clip_path set and file non-empty → return immediately.
//   2. Timelapse path: media_path ends with .mp4 → return media_path directly.
//   3. Extract path: no clip, no video media → call extractClip, persist, return.
//   4. Error path: no camera, no media → throw a descriptive error.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mock: extractClip returns a fake path; never touches Frigate.
// ---------------------------------------------------------------------------
vi.mock('../src/frigate.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/frigate.js')>();
  return {
    ...original,
    extractClip: vi.fn(),
  };
});

let workdir: string;
const baseEnv = { ...process.env };

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'hamster-clips-test-'));
  mkdirSync(join(workdir, 'clips'), { recursive: true });
  mkdirSync(join(workdir, 'timelapse'), { recursive: true });
  Object.assign(process.env, baseEnv);
  process.env['DATABASE_PATH'] = join(workdir, 'hamster.db');
  process.env['STORAGE_PATH'] = workdir;
  process.env['ZYPHR_API_KEY'] = 'zy_test_dummy';
  process.env['ZYPHR_APP_SECRET'] = 'zy_test_dummy_secret';
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
// Helpers
// ---------------------------------------------------------------------------

import type { DiaryEntryRow } from '../src/db.js';

function makeEntry(overrides: Partial<DiaryEntryRow> & { id: number }): DiaryEntryRow {
  return {
    occurred_at: Date.now(),
    kind: 'narrative',
    activity: 'wheel',
    narrative: 'test',
    pet_name: null,
    camera_id: null,
    from_camera_id: null,
    to_camera_id: null,
    duration_ms: null,
    snapshot_id: null,
    media_path: null,
    details: null,
    ai_model: null,
    created_by: null,
    thumbnail_path: null,
    clip_path: null,
    media_backfill_attempts: 0,
    media_backfill_last_error: null,
    media_unavailable: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ensureClip', () => {
  it('returns clip_path directly when file already exists and is non-empty (cache hit)', async () => {
    const { ensureClip } = await import('../src/clips.js');
    const { extractClip } = await import('../src/frigate.js');

    // Write a fake cached clip on disk.
    const cachedRel = join('clips', 'cam1-100-110.mp4');
    const cachedAbs = join(workdir, cachedRel);
    writeFileSync(cachedAbs, Buffer.alloc(16));

    const entry = makeEntry({ id: 1, clip_path: cachedRel });
    const result = await ensureClip(entry);

    expect(result.relPath).toBe(cachedRel);
    // extractClip must NOT have been called.
    expect(extractClip).not.toHaveBeenCalled();
  });

  it('returns media_path directly for timelapse entries (no extraction)', async () => {
    const { ensureClip } = await import('../src/clips.js');
    const { extractClip } = await import('../src/frigate.js');

    const tlRel = join('timelapse', '2026-05-24.mp4');
    const tlAbs = join(workdir, tlRel);
    writeFileSync(tlAbs, Buffer.alloc(16));

    const entry = makeEntry({ id: 2, kind: 'timelapse', media_path: tlRel });
    const result = await ensureClip(entry);

    expect(result.relPath).toBe(tlRel);
    expect(extractClip).not.toHaveBeenCalled();
  });

  it('calls extractClip with midpoint centerMs and adaptive durationMs for a narrative entry', async () => {
    const db = await import('../src/db.js');
    const { ensureClip } = await import('../src/clips.js');
    const frigateModule = await import('../src/frigate.js');
    const extractClip = vi.mocked(frigateModule.extractClip);

    // Seed camera and diary entry in the DB so getCameraById works.
    const camera = db.createCamera({
      name: 'testcam',
      emoji: '🎥',
      stream_url: 'rtsp://testcam',
      live_src: 'testcam',
      enabled: true,
    });
    // Entry: occurred_at=10000 ms (end of activity), duration=6000 ms.
    // Expected: centerMs = 10000 - floor(6000/2) = 7000
    //           durationMs = clamp(6000 + 4000, 8000, 20000) = 10000
    const entry = db.createDiaryEntry({
      occurred_at: 10_000,
      kind: 'narrative',
      activity: 'wheel',
      narrative: 'running',
      pet_name: 'Remy',
      camera_id: camera.id,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: 6_000,
      snapshot_id: null,
      media_path: null,
      details: null,
    });

    // Fake the extracted clip on disk.
    const extractedAbs = join(workdir, 'clips', 'testcam-100-110.mp4');
    writeFileSync(extractedAbs, Buffer.alloc(32));

    extractClip.mockResolvedValueOnce({ path: extractedAbs, duration_ms: 10_000 });

    const result = await ensureClip(entry);

    expect(extractClip).toHaveBeenCalledOnce();
    const callArg = extractClip.mock.calls[0]![0] as { centerMs: number; durationMs: number };
    expect(callArg.centerMs).toBe(7_000);   // midpoint = occurred_at − dur/2
    expect(callArg.durationMs).toBe(10_000); // clamp(6000+4000, 8000, 20000) = 10000
    expect(result.relPath).toContain('clips');

    // Check it was persisted in the DB.
    const refreshed = db.getDiaryEntryById(entry.id);
    expect(refreshed?.clip_path).toBe(result.relPath);
  });

  it('uses occurred_at as centerMs and 8000 ms window when duration_ms is null', async () => {
    const db = await import('../src/db.js');
    const { ensureClip } = await import('../src/clips.js');
    const frigateModule = await import('../src/frigate.js');
    const extractClip = vi.mocked(frigateModule.extractClip);

    const camera = db.createCamera({
      name: 'nulldur',
      emoji: '📷',
      stream_url: 'rtsp://nulldur',
      live_src: 'nulldur',
      enabled: true,
    });
    const entry = db.createDiaryEntry({
      occurred_at: 50_000,
      kind: 'narrative',
      activity: 'food',
      narrative: 'eating',
      pet_name: null,
      camera_id: camera.id,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: null,   // no duration recorded
      snapshot_id: null,
      media_path: null,
      details: null,
    });

    const extractedAbs = join(workdir, 'clips', 'nulldur-0-8.mp4');
    writeFileSync(extractedAbs, Buffer.alloc(16));
    extractClip.mockResolvedValueOnce({ path: extractedAbs, duration_ms: 8_000 });

    await ensureClip(entry);

    const callArg = extractClip.mock.calls[0]![0] as { centerMs: number; durationMs: number };
    // dur=0, so centerMs = occurred_at − 0 = 50000; durationMs = clamp(0+4000,8000,20000)=8000
    expect(callArg.centerMs).toBe(50_000);
    expect(callArg.durationMs).toBe(8_000);
  });

  it('clamps durationMs to 20000 for very long activities', async () => {
    const db = await import('../src/db.js');
    const { ensureClip } = await import('../src/clips.js');
    const frigateModule = await import('../src/frigate.js');
    const extractClip = vi.mocked(frigateModule.extractClip);

    const camera = db.createCamera({
      name: 'longrun',
      emoji: '🐹',
      stream_url: 'rtsp://longrun',
      live_src: 'longrun',
      enabled: true,
    });
    // 8-minute (480000 ms) wheel run — clamp should cap durationMs at 20000.
    // centerMs = 600000 − floor(480000/2) = 600000 − 240000 = 360000
    const entry = db.createDiaryEntry({
      occurred_at: 600_000,
      kind: 'narrative',
      activity: 'wheel',
      narrative: 'marathon session',
      pet_name: null,
      camera_id: camera.id,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: 480_000,
      snapshot_id: null,
      media_path: null,
      details: null,
    });

    const extractedAbs = join(workdir, 'clips', 'longrun-350-370.mp4');
    writeFileSync(extractedAbs, Buffer.alloc(16));
    extractClip.mockResolvedValueOnce({ path: extractedAbs, duration_ms: 20_000 });

    await ensureClip(entry);

    const callArg = extractClip.mock.calls[0]![0] as { centerMs: number; durationMs: number };
    expect(callArg.centerMs).toBe(360_000); // mid-run
    expect(callArg.durationMs).toBe(20_000); // capped
  });

  it('re-extracts when cached file is missing from disk', async () => {
    const db = await import('../src/db.js');
    const { ensureClip } = await import('../src/clips.js');
    const frigateModule2 = await import('../src/frigate.js');
    const extractClip = vi.mocked(frigateModule2.extractClip);

    const camera = db.createCamera({
      name: 'cam2',
      emoji: '📷',
      stream_url: 'rtsp://cam2',
      live_src: 'cam2',
      enabled: true,
    });
    const entry = db.createDiaryEntry({
      occurred_at: Date.now(),
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

    // Point to a non-existent cached file.
    db.updateDiaryEntryClipPath(entry.id, 'clips/gone.mp4');
    const staleEntry = { ...entry, clip_path: 'clips/gone.mp4' };

    const newAbs = join(workdir, 'clips', 'cam2-200-210.mp4');
    writeFileSync(newAbs, Buffer.alloc(16));
    extractClip.mockResolvedValueOnce({ path: newAbs, duration_ms: 10_000 });

    const result = await ensureClip(staleEntry);

    expect(extractClip).toHaveBeenCalledOnce();
    expect(result.relPath).toContain('cam2');
  });

  it('throws a descriptive error when no camera_id and no video media', async () => {
    const { ensureClip } = await import('../src/clips.js');

    const entry = makeEntry({ id: 99, camera_id: null, media_path: null });
    await expect(ensureClip(entry)).rejects.toThrow(/no camera_id/);
  });
});
