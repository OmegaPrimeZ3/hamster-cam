// Unit tests for src/thumbnails.ts — generateThumbnailForEntry kind routing.
//
// We test:
//   1. Idempotency: if thumbnail_path set and file exists → skip.
//   2. 'recap' kind → skip with no ffmpeg call.
//   3. 'snapshot' (image media_path) → ffmpeg called with scale filter.
//   4. 'timelapse' (video media_path) → ffmpeg called with -frames:v 1.
//   5. 'narrative' with camera → extractFrame called.
//   6. 'narrative' without camera → skip silently, no throw.
//   7. ffmpeg failure → warn + return, no throw (never crashes caller).

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mock: both runFfmpeg and extractFrame are replaced.
// ---------------------------------------------------------------------------
vi.mock('../src/frigate.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/frigate.js')>();
  return {
    ...original,
    runFfmpeg: vi.fn(async (args: readonly string[]) => {
      // Create the output file so the caller's non-empty check passes.
      const outPath = args[args.length - 1];
      if (typeof outPath === 'string') {
        writeFileSync(outPath, Buffer.alloc(8));
      }
    }),
    extractFrame: vi.fn(async (_input: unknown) => {
      // Return captured:false by default; tests that need a real result override.
      return { path: 'thumbnails/noop.jpg', captured: false };
    }),
  };
});

let workdir: string;
const baseEnv = { ...process.env };

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'hamster-thumbs-test-'));
  mkdirSync(join(workdir, 'thumbnails'), { recursive: true });
  mkdirSync(join(workdir, 'snapshots'), { recursive: true });
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generateThumbnailForEntry', () => {
  it('returns immediately when thumbnail_path set and file exists (idempotent)', async () => {
    const { generateThumbnailForEntry } = await import('../src/thumbnails.js');
    const { runFfmpeg, extractFrame } = await import('../src/frigate.js');

    const thumbRel = join('thumbnails', 'entry-1-thumb.jpg');
    writeFileSync(join(workdir, thumbRel), Buffer.alloc(16));

    const entry = makeEntry({ id: 1, thumbnail_path: thumbRel });
    await generateThumbnailForEntry(entry);

    expect(runFfmpeg).not.toHaveBeenCalled();
    expect(extractFrame).not.toHaveBeenCalled();
  });

  it("skips 'recap' entries entirely — no ffmpeg, no extractFrame", async () => {
    const { generateThumbnailForEntry } = await import('../src/thumbnails.js');
    const { runFfmpeg, extractFrame } = await import('../src/frigate.js');

    const entry = makeEntry({ id: 2, kind: 'recap', activity: 'recap' });
    await generateThumbnailForEntry(entry);

    expect(runFfmpeg).not.toHaveBeenCalled();
    expect(extractFrame).not.toHaveBeenCalled();
  });

  it("calls ffmpeg with scale filter for 'snapshot' entries", async () => {
    const db = await import('../src/db.js');
    const { generateThumbnailForEntry } = await import('../src/thumbnails.js');
    const { runFfmpeg } = await import('../src/frigate.js');

    // Write a fake source image.
    const snapRel = join('snapshots', 'cam-123.jpg');
    writeFileSync(join(workdir, snapRel), Buffer.alloc(32));

    const entry = db.createDiaryEntry({
      occurred_at: Date.now(),
      kind: 'snapshot',
      activity: 'snapshot',
      narrative: 'snap',
      pet_name: null,
      camera_id: null,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: null,
      snapshot_id: null,
      media_path: snapRel,
      details: null,
    });

    await generateThumbnailForEntry(entry);

    expect(runFfmpeg).toHaveBeenCalledOnce();
    const args = (runFfmpeg as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string[];
    expect(args.join(' ')).toContain('scale=480:-1');

    // Thumbnail path should now be persisted on the DB row.
    const refreshed = db.getDiaryEntryById(entry.id);
    expect(refreshed?.thumbnail_path).toContain('thumbnails');
  });

  it("calls ffmpeg with -frames:v 1 for 'timelapse' entries", async () => {
    const db = await import('../src/db.js');
    const { generateThumbnailForEntry } = await import('../src/thumbnails.js');
    const { runFfmpeg } = await import('../src/frigate.js');

    const tlRel = join('timelapse', '2026-05-24.mp4');
    writeFileSync(join(workdir, tlRel), Buffer.alloc(32));

    const entry = db.createDiaryEntry({
      occurred_at: Date.now(),
      kind: 'timelapse',
      activity: 'timelapse',
      narrative: 'night reel',
      pet_name: null,
      camera_id: null,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: 30_000,
      snapshot_id: null,
      media_path: tlRel,
      details: null,
    });

    await generateThumbnailForEntry(entry);

    expect(runFfmpeg).toHaveBeenCalledOnce();
    const args = (runFfmpeg as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string[];
    expect(args).toContain('-frames:v');
    expect(args).toContain('1');
  });

  it("calls extractFrame at mid-activity time for 'narrative' entries with a resolvable camera", async () => {
    const db = await import('../src/db.js');
    const { generateThumbnailForEntry } = await import('../src/thumbnails.js');
    const frigateModule = await import('../src/frigate.js');
    const extractFrame = vi.mocked(frigateModule.extractFrame);

    const camera = db.createCamera({
      name: 'cam-narrative',
      emoji: '📷',
      stream_url: 'rtsp://cam-narrative',
      live_src: 'cam-narrative',
      enabled: true,
    });

    // Entry: occurred_at=10000 ms (end of activity), duration_ms=6000.
    // Expected atMs = 10000 − floor(6000/2) = 7000  (middle of activity).
    const thumbRel = join('thumbnails', 'cam-narrative-7000.jpg');
    const thumbAbs = join(workdir, thumbRel);
    writeFileSync(thumbAbs, Buffer.alloc(16));
    extractFrame.mockResolvedValueOnce({ path: thumbRel, captured: true });

    const entry = db.createDiaryEntry({
      occurred_at: 10_000,
      kind: 'narrative',
      activity: 'wheel',
      narrative: 'spinning',
      pet_name: null,
      camera_id: camera.id,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: 6_000,
      snapshot_id: null,
      media_path: null,
      details: null,
    });

    await generateThumbnailForEntry(entry);

    expect(extractFrame).toHaveBeenCalledOnce();
    const callArg = extractFrame.mock.calls[0]![0] as { cameraName: string; atMs: number };
    expect(callArg.cameraName).toBe('cam-narrative');
    // Must be mid-activity, not the end.
    expect(callArg.atMs).toBe(7_000);
  });

  it("uses occurred_at as atMs when duration_ms is null for 'narrative' entries", async () => {
    const db = await import('../src/db.js');
    const { generateThumbnailForEntry } = await import('../src/thumbnails.js');
    const frigateModule = await import('../src/frigate.js');
    const extractFrame = vi.mocked(frigateModule.extractFrame);

    const camera = db.createCamera({
      name: 'cam-nodur',
      emoji: '📷',
      stream_url: 'rtsp://cam-nodur',
      live_src: 'cam-nodur',
      enabled: true,
    });

    const thumbRel = join('thumbnails', 'cam-nodur-5000.jpg');
    const thumbAbs = join(workdir, thumbRel);
    writeFileSync(thumbAbs, Buffer.alloc(16));
    extractFrame.mockResolvedValueOnce({ path: thumbRel, captured: true });

    const entry = db.createDiaryEntry({
      occurred_at: 5_000,
      kind: 'narrative',
      activity: 'food',
      narrative: 'eating',
      pet_name: null,
      camera_id: camera.id,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: null,  // no duration
      snapshot_id: null,
      media_path: null,
      details: null,
    });

    await generateThumbnailForEntry(entry);

    expect(extractFrame).toHaveBeenCalledOnce();
    const callArg = extractFrame.mock.calls[0]![0] as { cameraName: string; atMs: number };
    // dur=0, so atMs = occurred_at − 0 = 5000 (unchanged)
    expect(callArg.atMs).toBe(5_000);
  });

  it("skips silently for 'narrative' with no camera (no throw)", async () => {
    const { generateThumbnailForEntry } = await import('../src/thumbnails.js');
    const { extractFrame, runFfmpeg } = await import('../src/frigate.js');

    const entry = makeEntry({ id: 99, kind: 'narrative', camera_id: null });
    // Must not throw.
    await expect(generateThumbnailForEntry(entry)).resolves.toBeUndefined();

    expect(extractFrame).not.toHaveBeenCalled();
    expect(runFfmpeg).not.toHaveBeenCalled();
  });

  it('does not throw when ffmpeg fails — logs warn and returns', async () => {
    const db = await import('../src/db.js');
    const { generateThumbnailForEntry } = await import('../src/thumbnails.js');
    const frigateModule2 = await import('../src/frigate.js');
    const runFfmpeg = vi.mocked(frigateModule2.runFfmpeg);

    // Make ffmpeg fail.
    runFfmpeg.mockRejectedValueOnce(new Error('ffmpeg not found'));

    const snapRel = join('snapshots', 'cam-fail.jpg');
    writeFileSync(join(workdir, snapRel), Buffer.alloc(32));

    const entry = db.createDiaryEntry({
      occurred_at: Date.now(),
      kind: 'snapshot',
      activity: 'snapshot',
      narrative: 'snap',
      pet_name: null,
      camera_id: null,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: null,
      snapshot_id: null,
      media_path: snapRel,
      details: null,
    });

    // The key contract: this must NOT throw even though ffmpeg failed.
    await expect(generateThumbnailForEntry(entry)).resolves.toBeUndefined();
  });
});
