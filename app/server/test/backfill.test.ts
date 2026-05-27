// Tests for backfill.ts — dedupe/idempotency logic and event→entry mapping.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NOTE: DEDUPE_SLOP_MS and isDuplicate are pure functions with no side-effects;
// they do not need vi.resetModules() isolation. We import them once statically.
import { DEDUPE_SLOP_MS, isDuplicate } from '../src/backfill.js';

let workdir: string;
const baseEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
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
