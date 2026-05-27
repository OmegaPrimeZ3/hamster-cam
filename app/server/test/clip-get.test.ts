// Tests for clip.get tRPC procedure and the clip_available flag in diaryToDTO.
//
// Covers:
//   1. clip.get maps FfmpegError → PRECONDITION_FAILED (not 500) and does NOT
//      leak ffmpeg stderr to the client.
//   2. clip_available is false for camera_id entries older than the retention
//      window and true for recent ones.
//   3. clip_available remains true for clip_path entries regardless of age.
//   4. clip_available remains true for timelapse mp4 entries regardless of age.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

// ---------------------------------------------------------------------------
// Mock ensureClip from clips.js so we can simulate FfmpegError without
// spawning ffmpeg or hitting Frigate.
// ---------------------------------------------------------------------------

vi.mock('../src/clips.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/clips.js')>();
  return { ...original, ensureClip: vi.fn() };
});

// ---------------------------------------------------------------------------
// Environment wiring — mirrors other test files.
// ---------------------------------------------------------------------------

let workdir: string;
const baseEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  workdir = mkdtempSync(join(tmpdir(), 'hamster-clip-get-'));
  mkdirSync(join(workdir, 'clips'), { recursive: true });
  mkdirSync(join(workdir, 'timelapse'), { recursive: true });
  mkdirSync(join(workdir, 'thumbnails'), { recursive: true });

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

async function makeAdminCtx() {
  const db = await import('../src/db.js');
  const admin = db.createUser({
    zyphr_user_id: 'zy_seed',
    email: 'seed@example.com',
    display_name: 'Seed',
    role: 'admin',
    created_by: null,
  });
  return {
    user: admin,
    sessionId: 'fake-session',
    req: {} as never,
    res: {} as never,
    audit: {} as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// clip.get — FfmpegError maps to PRECONDITION_FAILED
// ---------------------------------------------------------------------------

describe('clip.get — FfmpegError handling', () => {
  it('maps FfmpegError to PRECONDITION_FAILED with a friendly message and does not leak stderr', async () => {
    const db = await import('../src/db.js');
    const clipsModule = await import('../src/clips.js');
    const { FfmpegError } = await import('../src/frigate.js');
    const { appRouter } = await import('../src/trpc.js');

    // Seed a camera and a diary entry with a camera_id so clip.get attempts extraction.
    const camera = db.createCamera({
      name: 'remy-cam',
      emoji: '🐹',
      stream_url: 'rtsp://remy-cam',
      live_src: 'remy-cam',
      enabled: true,
    });
    const entry = db.createDiaryEntry({
      occurred_at: Date.now(),
      kind: 'narrative',
      activity: 'wheel',
      narrative: 'running',
      pet_name: 'Remy',
      camera_id: camera.id,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: 5000,
      snapshot_id: null,
      media_path: null,
      details: null,
    });

    // Make ensureClip throw an FfmpegError with sensitive stderr content.
    const sensitiveStderr = 'SECRET_AUTH_TOKEN=abc123 ffmpeg error details';
    vi.mocked(clipsModule.ensureClip).mockRejectedValueOnce(
      new FfmpegError('ffmpeg exited with code 1', 1, sensitiveStderr),
    );

    const ctx = await makeAdminCtx();
    const caller = appRouter.createCaller(ctx);

    let caught: TRPCError | null = null;
    try {
      await caller.clip.get({ diary_entry_id: entry.id });
    } catch (err) {
      if (err instanceof TRPCError) caught = err;
      else throw err;
    }

    expect(caught).not.toBeNull();
    expect(caught?.code).toBe('PRECONDITION_FAILED');
    // The friendly message must not expose ffmpeg internals.
    expect(caught?.message).toContain("isn't available anymore");
    expect(caught?.message).not.toContain('ffmpeg exited');
    expect(caught?.message).not.toContain(sensitiveStderr);
  });

  it('returns PRECONDITION_FAILED (not 500) for generic Frigate-unreachable errors', async () => {
    // A non-FfmpegError that contains 'no camera_id' still maps to 412.
    const db = await import('../src/db.js');
    const clipsModule = await import('../src/clips.js');
    const { appRouter } = await import('../src/trpc.js');

    const entry = db.createDiaryEntry({
      occurred_at: Date.now(),
      kind: 'narrative',
      activity: 'wheel',
      narrative: 'running',
      pet_name: null,
      camera_id: null,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: null,
      snapshot_id: null,
      media_path: null,
      details: null,
    });

    vi.mocked(clipsModule.ensureClip).mockRejectedValueOnce(
      new Error('no camera_id and no mp4 media — cannot produce a clip'),
    );

    const ctx = await makeAdminCtx();
    const caller = appRouter.createCaller(ctx);

    let caught: TRPCError | null = null;
    try {
      await caller.clip.get({ diary_entry_id: entry.id });
    } catch (err) {
      if (err instanceof TRPCError) caught = err;
      else throw err;
    }

    expect(caught?.code).toBe('PRECONDITION_FAILED');
  });
});

// ---------------------------------------------------------------------------
// clip_available — retention window gate
// We test via activity.list so we exercise diaryToDTO in production.
// ---------------------------------------------------------------------------

describe('clip_available — retention window in activity.list', () => {
  const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;

  it('is false for a camera_id entry older than the 10-day retention window', async () => {
    const db = await import('../src/db.js');
    const { appRouter } = await import('../src/trpc.js');

    const camera = db.createCamera({
      name: 'old-cam',
      emoji: '🎥',
      stream_url: 'rtsp://old-cam',
      live_src: 'old-cam',
      enabled: true,
    });

    // occurred_at = 11 days ago → outside the 10-day retention window.
    const elevenDaysAgo = Date.now() - (TEN_DAYS_MS + 24 * 60 * 60 * 1000);
    db.createDiaryEntry({
      occurred_at: elevenDaysAgo,
      kind: 'narrative',
      activity: 'wheel',
      narrative: 'old run',
      pet_name: null,
      camera_id: camera.id,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: null,
      snapshot_id: null,
      media_path: null,
      details: null,
    });

    const ctx = await makeAdminCtx();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.activity.range({ from: elevenDaysAgo - 1000, to: elevenDaysAgo + 1000 });

    const entry = result[0];
    expect(entry).toBeDefined();
    expect(entry?.camera_id).toBe(camera.id);
    expect(entry?.clip_available).toBe(false);
  });

  it('is true for a camera_id entry within the 10-day retention window', async () => {
    const db = await import('../src/db.js');
    const { appRouter } = await import('../src/trpc.js');

    const camera = db.createCamera({
      name: 'fresh-cam',
      emoji: '🐹',
      stream_url: 'rtsp://fresh-cam',
      live_src: 'fresh-cam',
      enabled: true,
    });

    // occurred_at = 1 hour ago → well inside the 10-day retention window.
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    db.createDiaryEntry({
      occurred_at: oneHourAgo,
      kind: 'narrative',
      activity: 'food',
      narrative: 'fresh eating',
      pet_name: 'Remy',
      camera_id: camera.id,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: null,
      snapshot_id: null,
      media_path: null,
      details: null,
    });

    const ctx = await makeAdminCtx();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.activity.range({ from: oneHourAgo - 1000, to: oneHourAgo + 1000 });

    const entry = result[0];
    expect(entry?.clip_available).toBe(true);
  });

  it('is true for an aged-out entry that already has a clip_path (cached clip)', async () => {
    const db = await import('../src/db.js');
    const { appRouter } = await import('../src/trpc.js');

    // Write a fake cached clip so the file check doesn't block.
    const cachedRel = join('clips', 'remy-100-110.mp4');
    const cachedAbs = join(workdir, cachedRel);
    writeFileSync(cachedAbs, Buffer.alloc(16));

    const elevenDaysAgo = Date.now() - (TEN_DAYS_MS + 24 * 60 * 60 * 1000);
    const entry = db.createDiaryEntry({
      occurred_at: elevenDaysAgo,
      kind: 'narrative',
      activity: 'wheel',
      narrative: 'cached old run',
      pet_name: null,
      camera_id: null, // no camera_id — but clip_path is set
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: 10_000,
      snapshot_id: null,
      media_path: null,
      details: null,
    });
    db.updateDiaryEntryClipPath(entry.id, cachedRel);

    const ctx = await makeAdminCtx();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.activity.range({ from: elevenDaysAgo - 1000, to: elevenDaysAgo + 1000 });

    const dto = result[0];
    expect(dto?.clip_available).toBe(true);
  });

  it('is true for a timelapse mp4 entry regardless of age', async () => {
    const db = await import('../src/db.js');
    const { appRouter } = await import('../src/trpc.js');

    const tlRel = join('timelapse', '2026-05-01.mp4');
    const tlAbs = join(workdir, tlRel);
    writeFileSync(tlAbs, Buffer.alloc(16));

    // Way in the past — definitely outside retention.
    const oldDate = Date.now() - 30 * 24 * 60 * 60 * 1000;
    db.createDiaryEntry({
      occurred_at: oldDate,
      kind: 'timelapse',
      activity: 'timelapse',
      narrative: "Remy's night",
      pet_name: null,
      camera_id: null,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: null,
      snapshot_id: null,
      media_path: tlRel,
      details: null,
    });

    const ctx = await makeAdminCtx();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.activity.range({ from: oldDate - 1000, to: oldDate + 1000 });

    const dto = result[0];
    expect(dto?.clip_available).toBe(true);
  });
});
