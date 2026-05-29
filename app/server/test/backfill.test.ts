// Tests for backfill.ts — dedupe/idempotency logic and event→entry mapping.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted file-scope mock for wheel-odometer.
//
// vi.mock() is hoisted by Vitest before any imports, so it takes effect for
// every dynamic import in this file regardless of parallel scheduling.
// importOriginal preserves the real RotationCounter (used by pure state-machine
// tests); only replayWheelDistance is replaced with a controllable spy.
// ---------------------------------------------------------------------------
vi.mock('../src/wheel-odometer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/wheel-odometer.js')>();
  return {
    ...actual,
    replayWheelDistance: vi.fn(),
  };
});

// NOTE: DEDUPE_SLOP_MS and isDuplicate are pure functions with no side-effects;
// they do not need vi.resetModules() isolation. We import them once statically.
import { DEFAULT_HOURS, DEDUPE_SLOP_MS, isDuplicate } from '../src/backfill.js';
import { replayWheelDistance } from '../src/wheel-odometer.js';

let workdir: string;
const baseEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  // Reset the hoisted replayWheelDistance spy so each test starts clean.
  vi.mocked(replayWheelDistance).mockReset();
  workdir = mkdtempSync(join(tmpdir(), 'hamster-backfill-'));
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
// isDuplicate unit tests — pure function, no DB required
// ---------------------------------------------------------------------------

describe('isDuplicate', () => {
  function makeEntry(
    overrides: Partial<import('../src/db.js').DiaryEntryRow>,
  ): import('../src/db.js').DiaryEntryRow {
    return {
      id: 1,
      occurred_at: 1_700_000_000_000,
      kind: 'narrative',
      activity: 'wheel',
      narrative: 'ran',
      pet_name: 'Remy',
      camera_id: 1,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: 60_000,
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

  it('detects an exact-match duplicate', () => {
    const existing = [makeEntry({ camera_id: 1, activity: 'wheel', occurred_at: 1_000_000 })];
    expect(isDuplicate(1, 'wheel', 1_000_000, existing)).toBe(true);
  });

  it('detects a duplicate within the slop window', () => {
    const existing = [makeEntry({ camera_id: 1, activity: 'wheel', occurred_at: 1_000_000 })];
    expect(isDuplicate(1, 'wheel', 1_000_000 + DEDUPE_SLOP_MS - 1, existing)).toBe(true);
    expect(isDuplicate(1, 'wheel', 1_000_000 - DEDUPE_SLOP_MS + 1, existing)).toBe(true);
  });

  it('does NOT flag an entry just outside the slop window as a duplicate', () => {
    const existing = [makeEntry({ camera_id: 1, activity: 'wheel', occurred_at: 1_000_000 })];
    expect(isDuplicate(1, 'wheel', 1_000_000 + DEDUPE_SLOP_MS + 1, existing)).toBe(false);
    expect(isDuplicate(1, 'wheel', 1_000_000 - DEDUPE_SLOP_MS - 1, existing)).toBe(false);
  });

  it('does NOT flag as duplicate when activity differs', () => {
    const existing = [makeEntry({ camera_id: 1, activity: 'food', occurred_at: 1_000_000 })];
    expect(isDuplicate(1, 'wheel', 1_000_000, existing)).toBe(false);
  });

  it('does NOT flag as duplicate when camera_id differs', () => {
    const existing = [makeEntry({ camera_id: 2, activity: 'wheel', occurred_at: 1_000_000 })];
    expect(isDuplicate(1, 'wheel', 1_000_000, existing)).toBe(false);
  });

  it('does NOT flag as duplicate when one camera_id is null and the other is not', () => {
    const existing = [makeEntry({ camera_id: null, activity: 'wheel', occurred_at: 1_000_000 })];
    expect(isDuplicate(1, 'wheel', 1_000_000, existing)).toBe(false);
  });

  it('correctly deduplicates when both camera_ids are null', () => {
    const existing = [makeEntry({ camera_id: null, activity: 'exploring', occurred_at: 1_000_000 })];
    expect(isDuplicate(null, 'exploring', 1_000_000, existing)).toBe(true);
  });

  it('returns false when the existing list is empty', () => {
    expect(isDuplicate(1, 'wheel', 1_000_000, [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runBackfill integration tests — uses a real DB but mocked fetch
// ---------------------------------------------------------------------------

describe('runBackfill', () => {
  /** Builds a minimal valid Frigate REST event. */
  function frigateEvent(overrides: {
    id?: string;
    camera?: string;
    label?: string;
    start_time?: number;
    end_time?: number | null;
    zones?: string[];
  }) {
    return {
      id: overrides.id ?? 'evt-001',
      camera: overrides.camera ?? 'hamster_cam_1',
      label: overrides.label ?? 'hamster',
      start_time: overrides.start_time ?? 1_700_000_000,
      end_time: overrides.end_time !== undefined ? overrides.end_time : 1_700_000_120,
      has_snapshot: true,
      zones: overrides.zones ?? ['wheel'],
    };
  }

  /** Patch global fetch to return a fixed array of events. Restores original on teardown. */
  function mockFetch(events: unknown[]) {
    const original = globalThis.fetch;
    globalThis.fetch = async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(JSON.stringify(events), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    return () => { globalThis.fetch = original; };
  }

  it('queries Frigate with has_clip=1 (integer), not the string "true"', async () => {
    // Regression: Frigate 0.17's FastAPI validates has_clip as an int and
    // rejects 'true' with a 422, which previously surfaced as "0 events".
    process.env['FRIGATE_URL'] = 'http://localhost:5000';
    const { runBackfill } = await import('../src/backfill.js');
    const db = await import('../src/db.js');
    db.getDb();

    let capturedUrl = '';
    const original = globalThis.fetch;
    globalThis.fetch = async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
      await runBackfill({ nowMs: Date.now(), days: 1 });
      expect(capturedUrl).toContain('has_clip=1');
      expect(capturedUrl).not.toContain('has_clip=true');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('throws (does not report 0 events) when Frigate returns a non-OK status', async () => {
    process.env['FRIGATE_URL'] = 'http://localhost:5000';
    const { runBackfill } = await import('../src/backfill.js');
    const db = await import('../src/db.js');
    db.getDb();

    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('{"detail":"bad"}', { status: 422 });
    try {
      await expect(runBackfill({ nowMs: Date.now(), days: 1 })).rejects.toThrow(/422/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('exits cleanly when FRIGATE_URL is not set', async () => {
    const { runBackfill } = await import('../src/backfill.js');
    const db = await import('../src/db.js');
    db.getDb();
    const result = await runBackfill({ nowMs: Date.now() });
    expect(result.eventsScanned).toBe(0);
    expect(result.written).toBe(0);
  });

  it('writes a new entry for a valid wheel event', async () => {
    process.env['FRIGATE_URL'] = 'http://localhost:5000';
    const { runBackfill } = await import('../src/backfill.js');
    const db = await import('../src/db.js');
    db.getDb();
    db.createCamera({
      name: 'Cam 1',
      emoji: '📷',
      stream_url: 'rtsp://x/1',
      live_src: 'hamster_cam_1',
      enabled: true,
    });

    const nowMs = Date.now();
    const evt = frigateEvent({
      start_time: nowMs / 1000 - 120,
      end_time: nowMs / 1000,
      zones: ['wheel'],
    });
    const restore = mockFetch([evt]);

    try {
      const result = await runBackfill({ nowMs, days: 1, rng: () => 0 });
      expect(result.eventsScanned).toBe(1);
      expect(result.written).toBe(1);
      expect(result.skippedDuplicate).toBe(0);

      const entries = db.listDiaryEntriesBetween(nowMs - 24 * 60 * 60 * 1000, nowMs + 1);
      expect(entries.some((e) => e.activity === 'wheel')).toBe(true);
    } finally {
      restore();
    }
  });

  it('skips an event that already exists in the DB (idempotency)', async () => {
    process.env['FRIGATE_URL'] = 'http://localhost:5000';
    const { runBackfill } = await import('../src/backfill.js');
    const db = await import('../src/db.js');
    db.getDb();
    const cam = db.createCamera({
      name: 'Cam 1',
      emoji: '📷',
      stream_url: 'rtsp://x/1',
      live_src: 'hamster_cam_1',
      enabled: true,
    });

    const nowMs = Date.now();
    const endMs = nowMs - 1000;

    db.createDiaryEntry({
      occurred_at: endMs,
      kind: 'narrative',
      activity: 'wheel',
      narrative: 'pre-existing',
      pet_name: null,
      camera_id: cam.id,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: 120_000,
      snapshot_id: null,
      media_path: null,
      details: null,
    });

    const evt = frigateEvent({
      start_time: endMs / 1000 - 120,
      end_time: endMs / 1000,
      zones: ['wheel'],
    });
    const restore = mockFetch([evt]);

    try {
      const result = await runBackfill({ nowMs, days: 1 });
      expect(result.eventsScanned).toBe(1);
      expect(result.skippedDuplicate).toBe(1);
      expect(result.written).toBe(0);
    } finally {
      restore();
    }
  });

  it('running twice produces the same DB state (idempotency)', async () => {
    process.env['FRIGATE_URL'] = 'http://localhost:5000';
    const { runBackfill } = await import('../src/backfill.js');
    const db = await import('../src/db.js');
    db.getDb();
    db.createCamera({
      name: 'Cam 1',
      emoji: '📷',
      stream_url: 'rtsp://x/1',
      live_src: 'hamster_cam_1',
      enabled: true,
    });

    const nowMs = Date.now();
    // Use end_time slightly in the past so the entry's occurred_at is strictly < nowMs,
    // ensuring it falls within the listDiaryEntriesBetween window on the second run.
    const endMs = nowMs - 5000;
    const evt = frigateEvent({
      start_time: endMs / 1000 - 120,
      end_time: endMs / 1000,
      zones: ['wheel'],
    });

    const restore = mockFetch([evt]);
    try {
      const r1 = await runBackfill({ nowMs, days: 1, rng: () => 0 });
      const r2 = await runBackfill({ nowMs, days: 1, rng: () => 0 });

      expect(r1.written).toBe(1);
      expect(r2.skippedDuplicate).toBe(1);
      expect(r2.written).toBe(0);

      const entries = db.listDiaryEntriesBetween(nowMs - 24 * 60 * 60 * 1000, nowMs + 1);
      const wheelEntries = entries.filter((e) => e.activity === 'wheel');
      expect(wheelEntries).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('skips events with no end_time', async () => {
    process.env['FRIGATE_URL'] = 'http://localhost:5000';
    const { runBackfill } = await import('../src/backfill.js');
    const db = await import('../src/db.js');
    db.getDb();

    const nowMs = Date.now();
    const evt = frigateEvent({ end_time: null });
    const restore = mockFetch([evt]);

    try {
      const result = await runBackfill({ nowMs, days: 1 });
      expect(result.eventsScanned).toBe(1);
      expect(result.skippedNoDuration).toBe(1);
      expect(result.written).toBe(0);
    } finally {
      restore();
    }
  });

  it('skips events below the dwell threshold', async () => {
    process.env['FRIGATE_URL'] = 'http://localhost:5000';
    const { runBackfill } = await import('../src/backfill.js');
    const db = await import('../src/db.js');
    db.getDb();

    const nowMs = Date.now();
    // 1-second duration — below the minDwellMs of 2000.
    const evt = frigateEvent({
      start_time: nowMs / 1000 - 1,
      end_time: nowMs / 1000,
      zones: ['food'],
    });
    const restore = mockFetch([evt]);

    try {
      const result = await runBackfill({ nowMs, days: 1, minDwellMs: 2000 });
      expect(result.skippedBelowDwell).toBe(1);
      expect(result.written).toBe(0);
    } finally {
      restore();
    }
  });

  it('dry-run does not write to the DB', async () => {
    process.env['FRIGATE_URL'] = 'http://localhost:5000';
    const { runBackfill } = await import('../src/backfill.js');
    const db = await import('../src/db.js');
    db.getDb();
    db.createCamera({
      name: 'Cam 1',
      emoji: '📷',
      stream_url: 'rtsp://x/1',
      live_src: 'hamster_cam_1',
      enabled: true,
    });

    const nowMs = Date.now();
    const evt = frigateEvent({
      start_time: nowMs / 1000 - 120,
      end_time: nowMs / 1000 - 5,
      zones: ['wheel'],
    });
    const restore = mockFetch([evt]);

    try {
      const result = await runBackfill({ nowMs, days: 1, dryRun: true });
      expect(result.written).toBe(1);

      // Nothing was actually inserted.
      const entries = db.listDiaryEntriesBetween(nowMs - 24 * 60 * 60 * 1000, nowMs + 1);
      expect(entries.filter((e) => e.activity === 'wheel')).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('classifies events by zone keyword (food, water, etc.)', async () => {
    process.env['FRIGATE_URL'] = 'http://localhost:5000';
    const { runBackfill } = await import('../src/backfill.js');
    const db = await import('../src/db.js');
    db.getDb();
    db.createCamera({
      name: 'Cam 1',
      emoji: '📷',
      stream_url: 'rtsp://x/1',
      live_src: 'hamster_cam_1',
      enabled: true,
    });

    const nowMs = Date.now();
    const events = [
      frigateEvent({ id: 'e1', start_time: nowMs / 1000 - 60, end_time: nowMs / 1000 - 50, zones: ['food'] }),
      frigateEvent({ id: 'e2', start_time: nowMs / 1000 - 40, end_time: nowMs / 1000 - 30, zones: ['water'] }),
    ];
    const restore = mockFetch(events);

    try {
      await runBackfill({ nowMs, days: 1, minDwellMs: 1, rng: () => 0 });
      const entries = db.listDiaryEntriesBetween(nowMs - 24 * 60 * 60 * 1000, nowMs + 1);
      expect(entries.some((e) => e.activity === 'food')).toBe(true);
      expect(entries.some((e) => e.activity === 'water')).toBe(true);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Default window / --hours arg tests
// ---------------------------------------------------------------------------

describe('runBackfill default 12-hour window', () => {
  it('DEFAULT_HOURS constant is 12', () => {
    expect(DEFAULT_HOURS).toBe(12);
  });

  it('uses 12-hour window when neither hours nor days is supplied', async () => {
    process.env['FRIGATE_URL'] = 'http://localhost:5000';
    const { runBackfill } = await import('../src/backfill.js');
    const db = await import('../src/db.js');
    db.getDb();

    // Set nowMs to a known value. Event is 11 hours ago — inside 12h window.
    const nowMs = 1_700_000_000_000;
    const elevenHoursAgoMs = nowMs - 11 * 60 * 60 * 1000;
    const evt = {
      id: 'w1',
      camera: 'hamster_cam_1',
      label: 'hamster',
      start_time: elevenHoursAgoMs / 1000 - 120,
      end_time: elevenHoursAgoMs / 1000,
      has_snapshot: true,
      zones: ['food'],
    };

    let capturedUrl = '';
    const original = globalThis.fetch;
    globalThis.fetch = async (url: string | URL | Request) => {
      capturedUrl = url.toString();
      return new Response(JSON.stringify([evt]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    try {
      db.createCamera({
        name: 'Cam 1',
        emoji: '📷',
        stream_url: 'rtsp://x/1',
        live_src: 'hamster_cam_1',
        enabled: true,
      });
      await runBackfill({ nowMs, minDwellMs: 1, rng: () => 0 });

      // The 'after' param in the URL should be approximately nowMs - 12h.
      const parsedUrl = new URL(capturedUrl);
      const afterParam = Number(parsedUrl.searchParams.get('after'));
      const expectedAfter = Math.floor((nowMs - 12 * 60 * 60 * 1000) / 1000);
      expect(afterParam).toBe(expectedAfter);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('hours option overrides days option', async () => {
    process.env['FRIGATE_URL'] = 'http://localhost:5000';
    const { runBackfill } = await import('../src/backfill.js');
    const db = await import('../src/db.js');
    db.getDb();

    const nowMs = 1_700_000_000_000;
    let capturedUrl = '';
    const original = globalThis.fetch;
    globalThis.fetch = async (url: string | URL | Request) => {
      capturedUrl = url.toString();
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    try {
      // hours=6 with days=3 — hours should win → window = 6h.
      await runBackfill({ nowMs, hours: 6, days: 3 });

      const parsedUrl = new URL(capturedUrl);
      const afterParam = Number(parsedUrl.searchParams.get('after'));
      const expectedAfter = Math.floor((nowMs - 6 * 60 * 60 * 1000) / 1000);
      expect(afterParam).toBe(expectedAfter);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('runCli defaults to 12h window (no args)', async () => {
    process.env['FRIGATE_URL'] = 'http://localhost:5000';
    const { runCli } = await import('../src/backfill.js');
    const db = await import('../src/db.js');
    db.getDb();

    let capturedUrl = '';
    const original = globalThis.fetch;
    globalThis.fetch = async (url: string | URL | Request) => {
      capturedUrl = url.toString();
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    };

    try {
      const code = await runCli([]);
      expect(code).toBe(0);

      const parsedUrl = new URL(capturedUrl);
      const afterParam = Number(parsedUrl.searchParams.get('after'));
      const nowApprox = Date.now();
      const expectedWindowMs = 12 * 60 * 60 * 1000;
      // Allow ±5s for test timing slop.
      expect(afterParam).toBeGreaterThan(Math.floor((nowApprox - expectedWindowMs) / 1000) - 5);
      expect(afterParam).toBeLessThan(Math.floor((nowApprox - expectedWindowMs) / 1000) + 5);
    } finally {
      globalThis.fetch = original;
      process.stdout.write = origWrite;
    }
  });

  it('runCli --hours 3 sets a 3-hour window', async () => {
    process.env['FRIGATE_URL'] = 'http://localhost:5000';
    const { runCli } = await import('../src/backfill.js');
    const db = await import('../src/db.js');
    db.getDb();

    let capturedUrl = '';
    const original = globalThis.fetch;
    globalThis.fetch = async (url: string | URL | Request) => {
      capturedUrl = url.toString();
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;

    try {
      const code = await runCli(['--hours', '3']);
      expect(code).toBe(0);

      const parsedUrl = new URL(capturedUrl);
      const afterParam = Number(parsedUrl.searchParams.get('after'));
      const nowApprox = Date.now();
      expect(afterParam).toBeGreaterThan(Math.floor((nowApprox - 3 * 60 * 60 * 1000) / 1000) - 5);
      expect(afterParam).toBeLessThan(Math.floor((nowApprox - 3 * 60 * 60 * 1000) / 1000) + 5);
    } finally {
      globalThis.fetch = original;
      process.stdout.write = origWrite;
    }
  });
});

// ---------------------------------------------------------------------------
// Wheel distance replay via RotationCounter (pure state-machine path)
// ---------------------------------------------------------------------------

describe('wheel distance backfill — RotationCounter state machine', () => {
  // These tests exercise the pure RotationCounter directly — no ffmpeg, no DB,
  // no mocking of child_process. They verify the rotation-count → metres math
  // that replayWheelDistance uses (same RotationCounter class).

  it('synthetic LIGHT/DARK sequence → correct rotation count and metres', async () => {
    const { RotationCounter } = await import('../src/wheel-odometer.js');
    const LIGHT = 0.0;
    const DARK = 1.0;
    const counter = new RotationCounter(50);

    // 3 rotations: each is 3 light + 3 dark + 3 light (rising edge = 1 rotation).
    for (let r = 0; r < 3; r += 1) {
      for (let i = 0; i < 3; i += 1) counter.feed(LIGHT);
      for (let i = 0; i < 3; i += 1) counter.feed(DARK);
      for (let i = 0; i < 3; i += 1) counter.feed(LIGHT);
    }

    expect(counter.getRotations()).toBe(3);
    // metres = 3 × π × 152 / 1000
    const diameterMm = 152.0;
    const metres = counter.getRotations() * Math.PI * diameterMm / 1000;
    expect(metres).toBeCloseTo(3 * Math.PI * 152 / 1000, 4);
  });

  it('zero rotations when frames never go dark', async () => {
    const { RotationCounter } = await import('../src/wheel-odometer.js');
    const counter = new RotationCounter(50);
    for (let i = 0; i < 20; i += 1) counter.feed(0.0);
    expect(counter.getRotations()).toBe(0);
    const metres = counter.getRotations() * Math.PI * 152 / 1000;
    expect(metres).toBe(0);
  });

  it('a 2-frame dark pulse at 30fps IS counted as one rotation (real fast pass)', async () => {
    // At 30fps a 2-frame dark pulse = ~66ms — this is exactly the kind of brief
    // marker pass that was being dropped by the old 3-frame sustained-dark
    // debounce. Under the new refractory-period scheme it must count.
    // No refractory concern on the first rotation (lastCountedFrame = -Infinity).
    const { RotationCounter } = await import('../src/wheel-odometer.js');
    const counter = new RotationCounter(50);
    // Establish light.
    for (let i = 0; i < 3; i += 1) counter.feed(0.0);
    // 2-frame dark pulse — real fast pass at 30fps.
    counter.feed(1.0);
    counter.feed(1.0);
    // Back to light — rising edge triggers count.
    for (let i = 0; i < 3; i += 1) counter.feed(0.0);
    expect(counter.getRotations()).toBe(1);
  });

  it('distance backfill writes wheel_meters onto an existing wheel entry', async () => {
    process.env['FRIGATE_URL'] = 'http://localhost:5000';

    // Hoisted mock (see top of file) — control per-test via vi.mocked().
    vi.mocked(replayWheelDistance).mockResolvedValue(1.234);

    const { runBackfill } = await import('../src/backfill.js');
    const db = await import('../src/db.js');
    db.getDb();

    // Create a camera with the odometer enabled.
    const cam = db.createCamera({
      name: 'Cam 1',
      emoji: '📷',
      stream_url: 'rtsp://x/1',
      live_src: 'hamster_cam_1',
      enabled: true,
      wheel_mark_enabled: true,
      wheel_diameter_mm: 152.0,
      wheel_band_x_pct: 0,
      wheel_band_width_pct: 100,
      wheel_band_y_pct: 50,
      wheel_band_height_pct: 10,
      wheel_threshold_pct: 50,
    });
    expect(cam).toBeDefined();

    const nowMs = Date.now();
    const evt = {
      id: 'w-dist-1',
      camera: 'hamster_cam_1',
      label: 'hamster',
      start_time: nowMs / 1000 - 120,
      end_time: nowMs / 1000 - 5,
      has_snapshot: true,
      zones: ['wheel'],
    };

    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify([evt]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    try {
      const result = await runBackfill({ nowMs, hours: 1, rng: () => 0 });
      expect(result.written).toBe(1);
      expect(result.distanceReplayed).toBe(1);
      expect(result.distanceSkipped).toBe(0);

      const entries = db.listDiaryEntriesBetween(nowMs - 60 * 60 * 1000, nowMs + 1);
      const wheelEntry = entries.find((e) => e.activity === 'wheel');
      expect(wheelEntry).toBeDefined();
      const details = JSON.parse(wheelEntry?.details ?? '{}') as Record<string, unknown>;
      expect(details['wheel_meters']).toBeCloseTo(1.234, 3);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('distance backfill skips when camera has wheel_mark_enabled=false', async () => {
    process.env['FRIGATE_URL'] = 'http://localhost:5000';

    // Should never be reached — if it is, the returned value would corrupt results.
    vi.mocked(replayWheelDistance).mockResolvedValue(9999);

    const { runBackfill } = await import('../src/backfill.js');
    const db = await import('../src/db.js');
    db.getDb();

    // Odometer disabled.
    db.createCamera({
      name: 'Cam 1',
      emoji: '📷',
      stream_url: 'rtsp://x/1',
      live_src: 'hamster_cam_1',
      enabled: true,
      wheel_mark_enabled: false,
    });

    const nowMs = Date.now();
    const evt = {
      id: 'w-skip-1',
      camera: 'hamster_cam_1',
      label: 'hamster',
      start_time: nowMs / 1000 - 120,
      end_time: nowMs / 1000 - 5,
      has_snapshot: true,
      zones: ['wheel'],
    };

    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify([evt]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    try {
      const result = await runBackfill({ nowMs, hours: 1, rng: () => 0 });
      expect(result.written).toBe(1);
      expect(result.distanceReplayed).toBe(0);
      expect(result.distanceSkipped).toBe(1);

      // wheel_meters should NOT be in the details.
      const entries = db.listDiaryEntriesBetween(nowMs - 60 * 60 * 1000, nowMs + 1);
      const wheelEntry = entries.find((e) => e.activity === 'wheel');
      expect(wheelEntry).toBeDefined();
      const details = JSON.parse(wheelEntry?.details ?? '{}') as Record<string, unknown>;
      expect(details['wheel_meters']).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('distance backfill is idempotent — does not clobber existing wheel_meters on second run', async () => {
    process.env['FRIGATE_URL'] = 'http://localhost:5000';

    vi.mocked(replayWheelDistance).mockResolvedValue(2.0);

    const { runBackfill } = await import('../src/backfill.js');
    const db = await import('../src/db.js');
    db.getDb();

    db.createCamera({
      name: 'Cam 1',
      emoji: '📷',
      stream_url: 'rtsp://x/1',
      live_src: 'hamster_cam_1',
      enabled: true,
      wheel_mark_enabled: true,
      wheel_diameter_mm: 152.0,
      wheel_band_x_pct: 0,
      wheel_band_width_pct: 100,
      wheel_band_y_pct: 50,
      wheel_band_height_pct: 10,
      wheel_threshold_pct: 50,
    });

    const nowMs = Date.now();
    const evt = {
      id: 'w-idem-1',
      camera: 'hamster_cam_1',
      label: 'hamster',
      start_time: nowMs / 1000 - 120,
      end_time: nowMs / 1000 - 5,
      has_snapshot: true,
      zones: ['wheel'],
    };

    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify([evt]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    try {
      // First run: writes entry + distance.
      const r1 = await runBackfill({ nowMs, hours: 1, rng: () => 0 });
      expect(r1.written).toBe(1);
      expect(r1.distanceReplayed).toBe(1);
      expect(vi.mocked(replayWheelDistance).mock.calls.length).toBe(1);

      // Second run: entry is duplicate (skipped), and wheel_meters already set.
      const r2 = await runBackfill({ nowMs, hours: 1, rng: () => 0 });
      expect(r2.written).toBe(0);
      expect(r2.skippedDuplicate).toBe(1);
      expect(r2.distanceReplayed).toBe(0);
      expect(r2.distanceSkipped).toBe(1);
      // replayWheelDistance must not have been called a second time.
      expect(vi.mocked(replayWheelDistance).mock.calls.length).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});
