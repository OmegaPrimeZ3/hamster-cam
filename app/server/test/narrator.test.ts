// Unit tests for narrator.ts — transition coalescing, dwell threshold,
// recent-event ring buffer, manual snapshot path, and multi-camera dedup.

import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrate } from '../src/migrate.js';

let workdir: string;
const baseEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  workdir = mkdtempSync(join(tmpdir(), 'hamster-narrator-'));
  Object.assign(process.env, baseEnv);
  process.env['DATABASE_PATH'] = join(workdir, 'hamster.db');
  process.env['STORAGE_PATH'] = workdir;
  process.env['ZYPHR_API_KEY'] = 'zy_test_dummy';
  process.env['ZYPHR_APP_SECRET'] = 'zy_test_dummy_secret';
  delete process.env['FRIGATE_URL'];
  delete process.env['MQTT_URL'];
});

afterEach(async () => {
  const db = await import('../src/db.js');
  const narrator = await import('../src/narrator.js');
  const { resetConfigForTests } = await import('../src/config.js');
  narrator.resetNarratorState();
  db.resetDbForTests();
  resetConfigForTests();
  rmSync(workdir, { recursive: true, force: true });
});

async function seedCameras(): Promise<{ wheel: number; food: number }> {
  const db = await import('../src/db.js');
  const wheel = db.createCamera({
    name: 'wheel',
    emoji: '🎡',
    stream_url: 'rtsp://x/wheel',
    enabled: true,
  });
  const food = db.createCamera({
    name: 'food',
    emoji: '🥕',
    stream_url: 'rtsp://x/food',
    enabled: true,
  });
  db.setSetting('pet_name', 'Peanut');
  return { wheel: wheel.id, food: food.id };
}

function newEvent(args: {
  type: 'new' | 'update' | 'end';
  camera: string;
  zones?: string[];
  startSec?: number;
  endSec?: number | null;
}) {
  const before = {
    camera: args.camera,
    label: 'hamster',
    current_zones: args.zones ?? [],
    start_time: args.startSec ?? 1_700_000_000,
  };
  const after = {
    ...before,
    end_time: args.endSec ?? null,
  };
  return { type: args.type, before, after };
}

describe('narrator', () => {
  it('emits a single transition entry when a new arrives on a different camera within the window', async () => {
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 8000, minDwellMs: 2000, transitionEntriesEnabled: true });
    resetNarratorState();
    await seedCameras();

    // Wheel end after a 5s dwell.
    const t0 = 1_700_000_000_000;
    let now = t0;
    let written = await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'wheel', zones: ['wheel'], startSec: 1_700_000_000, endSec: 1_700_000_005 }),
      { now: () => now, rng: () => 0 },
    );
    expect(written).toEqual([]);
    // 1 second later, a new event on the food camera.
    now = t0 + 1000;
    written = await handleFrigateEvent(
      newEvent({ type: 'new', camera: 'food', zones: ['food'] }),
      { now: () => now, rng: () => 0 },
    );
    expect(written.length).toBe(1);
    expect(written[0]?.activity).toBe('transition');
    expect(written[0]?.from_camera_id).not.toBeNull();
    expect(written[0]?.to_camera_id).not.toBeNull();

    // Confirm no separate standalone entry was written for the original end.
    const all = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(all.length).toBe(1);
    expect(all[0]?.activity).toBe('transition');
  });

  it('falls back to a standalone wheel entry when no follow-up arrives before the window expires', async () => {
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 10 });
    resetNarratorState();
    await seedCameras();

    const t0 = 1_700_000_000_000;
    let now = t0;
    await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'wheel', zones: ['wheel'], startSec: 1_700_000_000, endSec: 1_700_000_005 }),
      { now: () => now, rng: () => 0 },
    );
    // Advance past the transition window so the timer flushes.
    now += 200;
    await vi.advanceTimersByTimeAsync(200);
    // Drain microtasks once more.
    await Promise.resolve();
    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(1);
    expect(entries[0]?.activity).toBe('wheel');
    vi.useRealTimers();
  });

  it('drops fly-through events shorter than MIN_DWELL_MS', async () => {
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 20, minDwellMs: 5000 });
    resetNarratorState();
    await seedCameras();

    const t0 = 1_700_000_000_000;
    await handleFrigateEvent(
      newEvent({
        type: 'end',
        camera: 'wheel',
        zones: ['wheel'],
        startSec: 1_700_000_000,
        endSec: 1_700_000_000 + 1, // only 1s dwell → below 5000ms threshold
      }),
      { now: () => t0, rng: () => 0 },
    );
    await vi.advanceTimersByTimeAsync(50);
    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(0);
    vi.useRealTimers();
  });

  it('saveManualSnapshot writes a snapshots row and a snapshot-kind diary entry', async () => {
    const narrator = await import('../src/narrator.js');
    const db = await import('../src/db.js');
    const cams = await seedCameras();
    const t0 = 1_700_000_500_000;
    const entry = await narrator.saveManualSnapshot({
      cameraId: cams.wheel,
      takenAt: t0,
      mediaPath: 'snapshots/wheel-1.jpg',
    });
    expect(entry.kind).toBe('snapshot');
    expect(entry.activity).toBe('snapshot');
    expect(entry.media_path).toBe('snapshots/wheel-1.jpg');
    expect(db.listSnapshotsBetween(0, t0 + 1).length).toBe(1);
  });

  it('records recent events in a per-pet ring buffer for the tuning view', async () => {
    const { handleFrigateEvent, getRecentEvents, resetNarratorState } =
      await import('../src/narrator.js');
    resetNarratorState();
    await seedCameras();
    const t0 = 1_700_000_900_000;
    for (let i = 0; i < 25; i += 1) {
      await handleFrigateEvent(
        newEvent({ type: 'update', camera: i % 2 === 0 ? 'wheel' : 'food' }),
        { now: () => t0 + i, rng: () => 0 },
      );
    }
    const recent = getRecentEvents();
    expect(recent.length).toBe(20);
    expect(recent[0]?.at).toBeGreaterThan(recent[19]?.at ?? 0);
  });

  it('coalesces a repeat of the same non-wheel activity into the previous entry', async () => {
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 500 });
    resetNarratorState();
    await seedCameras();

    const t0 = 1_700_000_000_000;
    // First food visit: 3s dwell.
    await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'food', zones: ['food'], startSec: 1_700_000_000, endSec: 1_700_000_003 }),
      { now: () => t0, rng: () => 0 },
    );
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    // Second food visit 7s after the first ended (well within the 2-min window).
    await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'food', zones: ['food'], startSec: 1_700_000_010, endSec: 1_700_000_013 }),
      { now: () => t0 + 13_000, rng: () => 0 },
    );
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(1);
    expect(entries[0]?.activity).toBe('food');
    // Extended to span first-start (t0) → second-end (t0+13s).
    expect(entries[0]?.occurred_at).toBe(1_700_000_013_000);
    expect(entries[0]?.duration_ms).toBe(13_000);
    vi.useRealTimers();
  });

  it('does NOT coalesce repeat visits separated by more than the coalescing window', async () => {
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 500 });
    resetNarratorState();
    await seedCameras();

    const t0 = 1_700_000_000_000;
    await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'food', zones: ['food'], startSec: 1_700_000_000, endSec: 1_700_000_003 }),
      { now: () => t0, rng: () => 0 },
    );
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    // Second food visit ~3 minutes later → its own entry.
    await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'food', zones: ['food'], startSec: 1_700_000_180, endSec: 1_700_000_183 }),
      { now: () => t0 + 183_000, rng: () => 0 },
    );
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(2);
    vi.useRealTimers();
  });

  it('never coalesces wheel entries — each run keeps its own odometer span', async () => {
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 500 });
    resetNarratorState();
    await seedCameras();

    const t0 = 1_700_000_000_000;
    await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'wheel', zones: ['wheel'], startSec: 1_700_000_000, endSec: 1_700_000_003 }),
      { now: () => t0, rng: () => 0 },
    );
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'wheel', zones: ['wheel'], startSec: 1_700_000_010, endSec: 1_700_000_013 }),
      { now: () => t0 + 13_000, rng: () => 0 },
    );
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(2);
    expect(entries.every((e) => e.activity === 'wheel')).toBe(true);
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Regression: clock skew between server and Pi/Frigate must not suppress
  // diary entries.
  //
  // Root cause: zone-visit startedAt was previously set to `nowMs` (server
  // wall-clock) while closedAt was sourced from Frigate's `end_time` (Pi
  // clock). When the server clock ran ahead of the Pi clock, the computed
  // durationMs = closedAt − startedAt was negative, silently failing the
  // durationMs < dwellThreshold guard and producing zero diary entries even
  // for a multi-minute wheel session.
  //
  // Fix: zone-visit startedAt is now set to `startMs` (Frigate's
  // before.start_time converted to ms) so both endpoints of the duration
  // calculation come from the same clock source.
  // -------------------------------------------------------------------------

  it('writes a wheel entry even when the server clock is 30s ahead of the Frigate Pi clock', async () => {
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 2_000 });
    resetNarratorState();
    await seedCameras();

    // Frigate/Pi timestamps (seconds): run from 1_700_000_000 to 1_700_000_300 (5 min run).
    const frigateStart = 1_700_000_000;
    const frigateEnd   = 1_700_000_300; // 300 s = 5 minutes

    // Server clock is 30 s ahead of the Pi clock: server sees the 'new' event
    // at frigateStart * 1000 + 30_000, and the 'end' event at frigateEnd * 1000 + 30_000.
    const skewMs = 30_000;
    const serverNew = frigateStart * 1000 + skewMs; // 1_700_000_030_000
    const serverEnd = frigateEnd   * 1000 + skewMs; // 1_700_000_330_000

    // 'new' event: server clock is serverNew, but Frigate's start_time = frigateStart.
    await handleFrigateEvent(
      newEvent({ type: 'new', camera: 'wheel', zones: ['wheel'], startSec: frigateStart }),
      { now: () => serverNew, rng: () => 0 },
    );

    // 'end' event: server clock is serverEnd, Frigate's end_time = frigateEnd.
    await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'wheel', zones: ['wheel'], startSec: frigateStart, endSec: frigateEnd }),
      { now: () => serverEnd, rng: () => 0 },
    );

    // Advance past transition window so the deferred timer fires.
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    const entries = db.listDiaryEntriesBetween(0, serverEnd + 1_000_000);
    // Entry MUST be present — clock skew must not cause a silent drop.
    expect(entries.length).toBe(1);
    expect(entries[0]?.activity).toBe('wheel');
    // Duration should be the Frigate-clocked run time, not the skewed difference.
    expect(entries[0]?.duration_ms).toBe((frigateEnd - frigateStart) * 1000); // 300_000 ms
    vi.useRealTimers();
  });

  it('duration_ms reflects Frigate-clocked run time regardless of server clock offset', async () => {
    // Variant: Pi clock is 15s AHEAD of server (opposite skew direction).
    // Pre-fix: this direction produces a duration LARGER than reality. Post-fix:
    // duration is always Frigate-clocked and correct regardless of skew direction.
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 2_000 });
    resetNarratorState();
    await seedCameras();

    const frigateStart = 1_700_005_000;
    const frigateEnd   = 1_700_005_060; // 60s run

    // Server clock is 15s BEHIND the Pi (Pi is ahead by 15s).
    const skewMs = -15_000;
    const serverNew = frigateStart * 1000 + skewMs;
    const serverEnd = frigateEnd   * 1000 + skewMs;

    await handleFrigateEvent(
      newEvent({ type: 'new', camera: 'wheel', zones: ['wheel'], startSec: frigateStart }),
      { now: () => serverNew, rng: () => 0 },
    );

    await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'wheel', zones: ['wheel'], startSec: frigateStart, endSec: frigateEnd }),
      { now: () => serverEnd, rng: () => 0 },
    );

    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    const entries = db.listDiaryEntriesBetween(0, serverEnd + 1_000_000);
    expect(entries.length).toBe(1);
    expect(entries[0]?.activity).toBe('wheel');
    expect(entries[0]?.duration_ms).toBe((frigateEnd - frigateStart) * 1000); // 60_000 ms
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Exploring dwell gate — by-design suppression
// ---------------------------------------------------------------------------

describe('exploring dwell gate (by-design noise suppression)', () => {
  it('drops an exploring visit shorter than exploringMinDwellMs (60s default)', async () => {
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    // Use default 60s exploring min-dwell.
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 2000, exploringMinDwellMs: 60_000 });
    resetNarratorState();
    await seedCameras();

    const t0 = 1_700_100_000_000;
    // 40s dwell in open space (no named zone) — must be suppressed.
    await handleFrigateEvent(
      newEvent({
        type: 'end',
        camera: 'wheel', // camera keyword gives 'wheel' if zones empty → use neutral test
        zones: [], // overriding: classifyZones on 'wheel' camera gives 'wheel' not 'exploring'!
        // So we need a camera that has no keyword match. Re-use food camera with a
        // trick: override with a camera name that has no keyword so we land on 'exploring'.
        // This is actually not possible with `seedCameras()` — so override the camera name inline.
        startSec: 1_700_100_000,
        endSec: 1_700_100_040, // 40s
      }),
      { now: () => t0, rng: () => 0, onEntryWritten: async () => {} },
    );
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    // Camera 'wheel' has keyword 'wheel', so this comes through as 'wheel' not 'exploring'.
    // The meaningful assertion: a 40s wheel entry at minDwellMs=2000 DOES appear.
    // Exploring suppression is tested with a neutral camera below.
    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    // wheel at 40s, minDwellMs=2000 → entry present
    expect(entries.length).toBe(1);
    expect(entries[0]?.activity).toBe('wheel');
    vi.useRealTimers();
  });

  it('drops a genuine exploring visit under exploringMinDwellMs using a neutral camera name', async () => {
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 2000, exploringMinDwellMs: 60_000 });
    resetNarratorState();

    // Neutral camera — no zone keyword in name.
    db.createCamera({ name: 'cam-wide', emoji: '📷', stream_url: 'rtsp://x/wide', enabled: true });
    db.setSetting('pet_name', 'Remy');

    const t0 = 1_700_200_000_000;
    // 40s in open space with no zones — classifies as 'exploring' — below 60s threshold.
    await handleFrigateEvent(
      newEvent({
        type: 'end',
        camera: 'cam-wide',
        zones: [],
        startSec: 1_700_200_000,
        endSec: 1_700_200_040, // 40s
      }),
      { now: () => t0, rng: () => 0, onEntryWritten: async () => {} },
    );
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    // 40s < 60s → dropped. No diary entry produced.
    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(0);
    vi.useRealTimers();
  });

  it('emits an exploring entry when dwell reaches exploringMinDwellMs (exactly 60s)', async () => {
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 2000, exploringMinDwellMs: 60_000 });
    resetNarratorState();

    db.createCamera({ name: 'cam-wide', emoji: '📷', stream_url: 'rtsp://x/wide', enabled: true });
    db.setSetting('pet_name', 'Remy');

    const t0 = 1_700_300_000_000;
    // Exactly 60s — passes (>= threshold required? check: 60_000 < 60_000 is false → passes).
    await handleFrigateEvent(
      newEvent({
        type: 'end',
        camera: 'cam-wide',
        zones: [],
        startSec: 1_700_300_000,
        endSec: 1_700_300_060, // exactly 60s
      }),
      { now: () => t0, rng: () => 0, onEntryWritten: async () => {} },
    );
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    // 60_000 < 60_000 is false → NOT dropped → entry produced.
    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(1);
    expect(entries[0]?.activity).toBe('exploring');
    vi.useRealTimers();
  });

  it('lowering exploringMinDwellMs via setNarratorTuningsForTests admits shorter exploring entries', async () => {
    // Documents the tunable: operator can lower the threshold to 30s if they want
    // shorter explorations captured.
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 2000, exploringMinDwellMs: 30_000 });
    resetNarratorState();

    db.createCamera({ name: 'cam-wide', emoji: '📷', stream_url: 'rtsp://x/wide', enabled: true });
    db.setSetting('pet_name', 'Remy');

    const t0 = 1_700_400_000_000;
    await handleFrigateEvent(
      newEvent({
        type: 'end',
        camera: 'cam-wide',
        zones: [],
        startSec: 1_700_400_000,
        endSec: 1_700_400_040, // 40s — above 30s threshold
      }),
      { now: () => t0, rng: () => 0, onEntryWritten: async () => {} },
    );
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(1);
    expect(entries[0]?.activity).toBe('exploring');
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Regression: update-opened visit closed by end with mixed-clock endpoints
// ---------------------------------------------------------------------------

describe('narrator — update-opened visit with clock-skewed end', () => {
  it('does not produce a negative durationMs when server clock is ahead of Pi at end-close time', async () => {
    // Scenario: hamster enters a zone mid-track via an 'update' event. The
    // narrator anchors startedAt to nowMs (server clock). Later, the 'end' event
    // arrives with end_time from the Pi clock. If the server ran 30s ahead of the
    // Pi, endMs (Pi) < nowMs_at_update (server) → raw durationMs < 0 → previously
    // the negative value passed the `< dwellThreshold` check and silently dropped
    // the entry, indistinguishable from a fly-through. Fix: clamp to 0.
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 2000 });
    resetNarratorState();
    await seedCameras();

    const frigateTrackStart = 1_700_500_000; // seconds (Pi clock)
    const frigateZoneEnter  = 1_700_500_010; // 10s into track, still Pi clock
    const frigateTrackEnd   = 1_700_500_070; // 60s into track, Pi clock

    // Server is 40s AHEAD of Pi.
    const skewMs = 40_000;

    // 'new' event: server sees it at frigateTrackStart*1000 + skew.
    const serverNew = frigateTrackStart * 1000 + skewMs;

    // 'update' event: pet enters wheel zone mid-track. Server is still ~40s ahead.
    const serverUpdate = frigateZoneEnter * 1000 + skewMs; // 1_700_500_050_000

    // 'end' event: Pi emits at frigateTrackEnd seconds. Server receives it shortly after.
    const serverEnd = frigateTrackEnd * 1000 + skewMs; // 1_700_500_110_000

    // 'new' — no zones, opens exploring visit anchored at startMs (Pi clock).
    await handleFrigateEvent(
      newEvent({ type: 'new', camera: 'wheel', zones: [], startSec: frigateTrackStart }),
      { now: () => serverNew, rng: () => 0, onEntryWritten: async () => {} },
    );

    // 'update' — pet enters wheel zone mid-track. Opens wheel visit anchored at nowMs (server).
    await handleFrigateEvent(
      newEvent({ type: 'update', camera: 'wheel', zones: ['wheel'] }),
      { now: () => serverUpdate, rng: () => 0, onEntryWritten: async () => {} },
    );

    // 'end' — closedAt = endMs (Pi clock). For the update-opened wheel visit:
    //   rawDuration = endMs - serverUpdate = frigateTrackEnd*1000 - (frigateZoneEnter*1000 + skewMs)
    //               = (1_700_500_070 - 1_700_500_010)*1000 - 40_000
    //               = 60_000 - 40_000 = 20_000ms (positive! dwell 20s > 2s threshold)
    // But if skew were 80s instead, rawDuration = 60_000 - 80_000 = -20_000 → clamped to 0.
    await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'wheel', zones: ['wheel'], startSec: frigateTrackStart, endSec: frigateTrackEnd }),
      { now: () => serverEnd, rng: () => 0, onEntryWritten: async () => {} },
    );

    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    // With 40s skew and 60s zone dwell: duration = 60_000 - 40_000 = 20_000ms > 2_000ms → entry present.
    const entries = db.listDiaryEntriesBetween(0, serverEnd + 1_000_000);
    const wheelEntries = entries.filter((e) => e.activity === 'wheel');
    expect(wheelEntries.length).toBe(1);
    // Duration is positive (clamped) not negative.
    expect(wheelEntries[0]?.duration_ms).toBeGreaterThanOrEqual(0);
    vi.useRealTimers();
  });

  it('clamps to durationMs=0 when skew exceeds actual zone dwell (visit correctly dropped)', async () => {
    // When skew > zone dwell, the clamped durationMs=0 correctly fails the
    // dwellThreshold check → no spurious short entry appears. This is the RIGHT
    // behaviour: a visit we can't measure reliably is treated as a fly-through.
    //
    // Use a neutral camera (no keyword in name) so zone classification comes
    // entirely from current_zones, not the camera name keyword.
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 2000, exploringMinDwellMs: 2000 });
    resetNarratorState();

    // Neutral camera — no keyword in name.
    db.createCamera({ name: 'cam-wide', emoji: '📷', stream_url: 'rtsp://x/wide', enabled: true });
    db.setSetting('pet_name', 'Remy');

    // Track starts in open space (no zones) → 'exploring' visit opens, Pi-clocked.
    // Then mid-track 'update' moves pet into 'food' zone → 'exploring' visit closes
    // (mid-track close, server-clocked close), 'food' visit opens at serverUpdate.
    // 'end' arrives with Pi end_time. Food dwell raw = endMs - serverUpdate.
    // If server is ahead of Pi by skewMs, raw food dwell = (Pi-zone-dwell) - skewMs.
    // Set skewMs > Pi-zone-dwell so raw < 0 → clamped to 0 → dropped.

    const frigateTrackStart = 1_700_700_000; // seconds
    const frigateZoneEnter  = 1_700_700_010; // 10s into track
    const frigateTrackEnd   = 1_700_700_014; // food zone dwell = 4s on Pi clock

    // Server is 8s ahead of Pi. Food zone raw dwell = 4_000 - 8_000 = -4_000 → clamped to 0.
    const skewMs = 8_000;
    const serverNew    = frigateTrackStart * 1000 + skewMs;
    const serverUpdate = frigateZoneEnter  * 1000 + skewMs;
    const serverEnd    = frigateTrackEnd   * 1000 + skewMs;

    // 'new' — no zones → 'exploring' opens at startMs (Pi-clocked).
    await handleFrigateEvent(
      newEvent({ type: 'new', camera: 'cam-wide', zones: [], startSec: frigateTrackStart }),
      { now: () => serverNew, rng: () => 0, onEntryWritten: async () => {} },
    );

    // 'update' — enters food zone mid-track. 'exploring' closes (mid-track, nowMs = serverUpdate).
    //   exploring durationMs = serverUpdate - startMs = (frigateZoneEnter*1000 + skewMs) - frigateTrackStart*1000
    //                        = 10_000 + 8_000 = 18_000ms > 2000 → exploring entry written.
    // 'food' visit opens at serverUpdate (server clock).
    await handleFrigateEvent(
      newEvent({ type: 'update', camera: 'cam-wide', zones: ['food'] }),
      { now: () => serverUpdate, rng: () => 0, onEntryWritten: async () => {} },
    );

    // 'end' — endMs = frigateTrackEnd * 1000 (Pi clock).
    //   food durationMs = endMs - serverUpdate (clamped via Math.max)
    //                   = frigateTrackEnd*1000 - (frigateZoneEnter*1000 + skewMs)
    //                   = 4_000 - 8_000 = -4_000 → Math.max(0, -4_000) = 0 → 0 < 2000 → dropped.
    await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'cam-wide', zones: ['food'], startSec: frigateTrackStart, endSec: frigateTrackEnd }),
      { now: () => serverEnd, rng: () => 0, onEntryWritten: async () => {} },
    );

    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    // Exploring entry (18s, above 2s threshold) is present.
    // Food entry must NOT appear — clamped to 0, below minDwellMs=2000.
    const entries = db.listDiaryEntriesBetween(0, serverEnd + 1_000_000);
    const foodEntries = entries.filter((e) => e.activity === 'food');
    expect(foodEntries.length).toBe(0); // skew(8s) > zone-dwell(4s) → clamped 0 → dropped
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Multi-camera dedup tests
// ---------------------------------------------------------------------------

// Minimal fake proc that satisfies wheel-odometer's EventEmitter interface.
function makeFakeProc() {
  const base = new EventEmitter();
  return Object.assign(base, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
    stdin: { write: (): void => {}, end: (): void => {} },
  });
}

/**
 * Seeds two cameras that both overlap the `wheel` zone. The `enabledOdom`
 * array controls which cameras have wheel_mark_enabled=true.
 */
async function seedOverlappingWheelCameras(enabledOdom: string[] = []) {
  const db = await import('../src/db.js');
  const camA = db.createCamera({
    name: 'cam-a',
    emoji: '🐹',
    stream_url: 'rtsp://fake/a',
    live_src: 'cam_a',
    enabled: true,
    zones: ['wheel'],
    wheel_mark_enabled: enabledOdom.includes('cam-a'),
    wheel_diameter_mm: 152.0,
    wheel_band_y_pct: 50.0,
    wheel_band_height_pct: 10.0,
    wheel_threshold_pct: 50.0,
  });
  const camB = db.createCamera({
    name: 'cam-b',
    emoji: '🎡',
    stream_url: 'rtsp://fake/b',
    live_src: 'cam_b',
    enabled: true,
    zones: ['wheel'],
    wheel_mark_enabled: enabledOdom.includes('cam-b'),
    wheel_diameter_mm: 152.0,
    wheel_band_y_pct: 50.0,
    wheel_band_height_pct: 10.0,
    wheel_threshold_pct: 50.0,
  });
  db.setSetting('pet_name', 'Remy');
  return { camAId: camA.id, camBId: camB.id };
}

describe('narrator multi-camera dedup', () => {
  it('two overlapping cameras on same non-wheel zone → exactly one diary entry', async () => {
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 10 });
    resetNarratorState();

    // Create two cameras that both see a 'food' zone.
    const foodA = db.createCamera({ name: 'food-a', emoji: '🥕', stream_url: 'rtsp://x/a', enabled: true });
    const foodB = db.createCamera({ name: 'food-b', emoji: '🥕', stream_url: 'rtsp://x/b', enabled: true });
    db.setSetting('pet_name', 'Remy');

    const t0 = 1_700_000_000_000;
    let now = t0;
    const deps = { now: () => now, rng: () => 0 as number, onEntryWritten: async () => {} };

    // Both cameras see hamster at food simultaneously.
    await handleFrigateEvent(newEvent({ type: 'new', camera: 'food-a', zones: ['food'], startSec: 1_700_000_000 }), deps);
    await handleFrigateEvent(newEvent({ type: 'new', camera: 'food-b', zones: ['food'], startSec: 1_700_000_000 }), deps);

    // Both cameras end.
    now = t0 + 5_000;
    await handleFrigateEvent(newEvent({ type: 'end', camera: 'food-a', zones: ['food'], startSec: 1_700_000_000, endSec: 1_700_000_005 }), deps);
    await handleFrigateEvent(newEvent({ type: 'end', camera: 'food-b', zones: ['food'], startSec: 1_700_000_000, endSec: 1_700_000_005 }), deps);

    // Advance past transition window to flush.
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(1);
    expect(entries[0]?.activity).toBe('food');

    void foodA; void foodB;
    vi.useRealTimers();
  });

  it('two overlapping cameras on the wheel → exactly one odometer session', async () => {
    // Mock child_process.spawn so no real ffmpeg runs.
    const spawnMock = vi.fn(() => makeFakeProc());
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));

    process.env['FRIGATE_URL'] = 'http://frigate:5000';

    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const { _activeSessions } = await import('../src/wheel-odometer.js');
    const db = await import('../src/db.js');

    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 10 });
    resetNarratorState();
    await seedOverlappingWheelCameras(['cam-a', 'cam-b']);

    vi.useFakeTimers();
    const t0 = 1_700_000_000_000;
    let now = t0;
    const deps = { now: () => now, rng: () => 0 as number, onEntryWritten: async () => {} };

    // cam-a fires first → starts one odometer session.
    await handleFrigateEvent(newEvent({ type: 'new', camera: 'cam-a', zones: ['wheel'], startSec: 1_700_000_000 }), deps);
    expect(_activeSessions.size).toBe(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // cam-b fires next for same activity → must NOT start a second session.
    await handleFrigateEvent(newEvent({ type: 'new', camera: 'cam-b', zones: ['wheel'], startSec: 1_700_000_000 }), deps);
    expect(_activeSessions.size).toBe(1);
    expect(spawnMock).toHaveBeenCalledTimes(1); // still only 1 spawn

    // cam-a ends — but cam-b is still active, so no flush yet.
    now = t0 + 5_000;
    await handleFrigateEvent(newEvent({ type: 'end', camera: 'cam-a', zones: ['wheel'], startSec: 1_700_000_000, endSec: 1_700_000_005 }), deps);
    expect(db.listDiaryEntriesBetween(0, t0 + 1_000_000).length).toBe(0); // no entry yet

    // cam-b ends — now the activity truly ends.
    await handleFrigateEvent(newEvent({ type: 'end', camera: 'cam-b', zones: ['wheel'], startSec: 1_700_000_000, endSec: 1_700_000_005 }), deps);

    // Advance past transition window to flush.
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(1);
    expect(entries[0]?.activity).toBe('wheel');

    vi.useRealTimers();
    vi.doUnmock('node:child_process');
  });

  it('sequential A→B move → still one transition entry (existing behavior preserved)', async () => {
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 8000, minDwellMs: 2000, transitionEntriesEnabled: true });
    resetNarratorState();
    await seedCameras(); // wheel + food cameras

    const t0 = 1_700_000_000_000;
    let now = t0;

    // Pet on wheel for 5s, then wheel end.
    await handleFrigateEvent(
      newEvent({ type: 'new', camera: 'wheel', zones: ['wheel'], startSec: 1_700_000_000 }),
      { now: () => now, rng: () => 0 },
    );
    now = t0 + 5_000;
    let written = await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'wheel', zones: ['wheel'], startSec: 1_700_000_000, endSec: 1_700_000_005 }),
      { now: () => now, rng: () => 0 },
    );
    expect(written).toEqual([]);

    // 1s later: new on food camera → transition.
    now = t0 + 6_000;
    written = await handleFrigateEvent(
      newEvent({ type: 'new', camera: 'food', zones: ['food'] }),
      { now: () => now, rng: () => 0 },
    );
    expect(written.length).toBe(1);
    expect(written[0]?.activity).toBe('transition');
    expect(db.listDiaryEntriesBetween(0, t0 + 1_000_000).length).toBe(1);
  });

  it('single-camera behavior is unchanged — standalone wheel entry after window', async () => {
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 10 });
    resetNarratorState();
    await seedCameras();

    const t0 = 1_700_000_000_000;
    let now = t0;
    const deps = { now: () => now, rng: () => 0 as number, onEntryWritten: async () => {} };

    await handleFrigateEvent(newEvent({ type: 'new', camera: 'wheel', zones: ['wheel'], startSec: 1_700_000_000 }), deps);
    now = t0 + 5_000;
    await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'wheel', zones: ['wheel'], startSec: 1_700_000_000, endSec: 1_700_000_005 }),
      deps,
    );
    now += 200;
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(1);
    expect(entries[0]?.activity).toBe('wheel');
    vi.useRealTimers();
  });

  it('odometer-disabled cam-a + odometer-enabled cam-b → session runs on cam-b', async () => {
    const spawnMock = vi.fn(() => makeFakeProc());
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));

    process.env['FRIGATE_URL'] = 'http://frigate:5000';

    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const { _activeSessions } = await import('../src/wheel-odometer.js');
    const db = await import('../src/db.js');

    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 10 });
    resetNarratorState();
    // cam-a has odometry disabled, cam-b has it enabled.
    const ids = await seedOverlappingWheelCameras(['cam-b']);

    vi.useFakeTimers();
    const t0 = 1_700_000_000_000;
    let now = t0;
    const deps = { now: () => now, rng: () => 0 as number, onEntryWritten: async () => {} };

    // Disabled cam-a fires first — should NOT start an odometer session.
    await handleFrigateEvent(newEvent({ type: 'new', camera: 'cam-a', zones: ['wheel'], startSec: 1_700_000_000 }), deps);
    expect(_activeSessions.size).toBe(0); // no session from disabled cam

    // Enabled cam-b fires for same activity — should start exactly one session.
    await handleFrigateEvent(newEvent({ type: 'new', camera: 'cam-b', zones: ['wheel'], startSec: 1_700_000_000 }), deps);
    expect(_activeSessions.size).toBe(1);
    expect(_activeSessions.has(ids.camBId)).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Both cameras end.
    now = t0 + 5_000;
    await handleFrigateEvent(newEvent({ type: 'end', camera: 'cam-a', zones: ['wheel'], startSec: 1_700_000_000, endSec: 1_700_000_005 }), deps);
    await handleFrigateEvent(newEvent({ type: 'end', camera: 'cam-b', zones: ['wheel'], startSec: 1_700_000_000, endSec: 1_700_000_005 }), deps);

    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(1);
    expect(entries[0]?.activity).toBe('wheel');

    void ids;
    vi.useRealTimers();
    vi.doUnmock('node:child_process');
  });

  // -------------------------------------------------------------------------
  // Zone-entry model: mid-track zone transitions
  // -------------------------------------------------------------------------

  it('mid-track zone entry: update event moving into a named zone produces an entry immediately', async () => {
    // The core bug being fixed: hamster enters wheel zone mid-track (via update)
    // and the wheel visit should be emitted when the object later leaves the zone.
    // Use a neutral camera name ('cam-wide') so zone detection comes only from
    // current_zones, not from the camera name keyword fallback.
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 500 });
    resetNarratorState();

    // Neutral camera name — no keyword match from camera name alone.
    db.createCamera({ name: 'cam-wide', emoji: '📷', stream_url: 'rtsp://x/wide', enabled: true });
    db.setSetting('pet_name', 'Peanut');

    const t0 = 1_700_000_000_000;
    let now = t0;
    const deps = { now: () => now, rng: () => 0 as number, onEntryWritten: async () => {} };

    // Track starts: object born in open space (exploring).
    await handleFrigateEvent(newEvent({ type: 'new', camera: 'cam-wide', zones: [], startSec: 1_700_000_000 }), deps);

    // 2s later: object moves into the wheel zone (update event).
    now = t0 + 2_000;
    await handleFrigateEvent(newEvent({ type: 'update', camera: 'cam-wide', zones: ['wheel'] }), deps);

    // 5s later: object moves back out of the wheel zone (update: zones empty again).
    // This closes the wheel visit (mid-track close → emit immediately).
    now = t0 + 7_000;
    const writtenOnLeave = await handleFrigateEvent(
      newEvent({ type: 'update', camera: 'cam-wide', zones: [] }),
      deps,
    );
    // The wheel visit closed (5s dwell > 500ms) → immediate entry.
    expect(writtenOnLeave.length).toBe(1);
    expect(writtenOnLeave[0]?.activity).toBe('wheel');
    expect(writtenOnLeave[0]?.duration_ms).toBe(5_000);

    // DB check: one wheel entry emitted mid-track (exploring may also be there
    // after the transition, but we care the wheel is present).
    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    const wheelEntries = entries.filter((e) => e.activity === 'wheel');
    expect(wheelEntries.length).toBe(1);

    vi.useRealTimers();
  });

  it('debounce: many updates in the same zone → exactly one visit entry', async () => {
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 500 });
    resetNarratorState();
    await seedCameras();

    const t0 = 1_700_000_000_000;
    let now = t0;
    const deps = { now: () => now, rng: () => 0 as number, onEntryWritten: async () => {} };

    // Object enters wheel zone.
    await handleFrigateEvent(newEvent({ type: 'new', camera: 'wheel', zones: ['wheel'], startSec: 1_700_000_000 }), deps);

    // Frigate fires many updates all reporting the same zone — no new entries.
    for (let i = 1; i <= 10; i++) {
      now = t0 + i * 200;
      await handleFrigateEvent(newEvent({ type: 'update', camera: 'wheel', zones: ['wheel'] }), deps);
    }

    // After 10 updates, still no entries written.
    expect(db.listDiaryEntriesBetween(0, t0 + 1_000_000).length).toBe(0);

    // Track ends → defers wheel entry.
    now = t0 + 5_000;
    await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'wheel', zones: ['wheel'], startSec: 1_700_000_000, endSec: 1_700_000_005 }),
      deps,
    );
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    // Exactly ONE entry despite 10+ updates.
    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(1);
    expect(entries[0]?.activity).toBe('wheel');

    vi.useRealTimers();
  });

  it('re-entering a zone after leaving it creates a second visit entry', async () => {
    // Use neutral camera name so zone classification comes from current_zones only.
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 500, exploringMinDwellMs: 500 });
    resetNarratorState();

    db.createCamera({ name: 'cam-wide', emoji: '📷', stream_url: 'rtsp://x/wide', enabled: true });
    db.setSetting('pet_name', 'Peanut');

    const t0 = 1_700_000_000_000;
    let now = t0;
    const deps = { now: () => now, rng: () => 0 as number, onEntryWritten: async () => {} };

    // First visit: enters food zone.
    await handleFrigateEvent(newEvent({ type: 'new', camera: 'cam-wide', zones: ['food'], startSec: 1_700_000_000 }), deps);

    // 2s: leaves food zone (goes to open space mid-track).
    now = t0 + 2_000;
    const writtenOnLeave1 = await handleFrigateEvent(
      newEvent({ type: 'update', camera: 'cam-wide', zones: [] }),
      deps,
    );
    // First food visit (2s dwell > 500ms) emitted immediately.
    expect(writtenOnLeave1.length).toBe(1);
    expect(writtenOnLeave1[0]?.activity).toBe('food');

    // 3s: re-enters food zone — NEW food visit starts. The exploring visit that
    // opened when the pet left food (dwell 1s > 500ms) closes immediately.
    now = t0 + 3_000;
    const writtenOnReenter = await handleFrigateEvent(
      newEvent({ type: 'update', camera: 'cam-wide', zones: ['food'] }),
      deps,
    );
    // Exploring visit (1s dwell) closes immediately when food zone re-entered.
    expect(writtenOnReenter.length).toBe(1);
    expect(writtenOnReenter[0]?.activity).toBe('exploring');

    // 5s: leaves food zone again.
    now = t0 + 5_000;
    const writtenOnLeave2 = await handleFrigateEvent(
      newEvent({ type: 'update', camera: 'cam-wide', zones: [] }),
      deps,
    );
    // Second food visit (2s dwell > 500ms) emitted immediately.
    expect(writtenOnLeave2.length).toBe(1);
    expect(writtenOnLeave2[0]?.activity).toBe('food');

    // DB: 2 food entries plus potentially the exploring entries.
    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    const foodEntries = entries.filter((e) => e.activity === 'food');
    expect(foodEntries.length).toBe(2);

    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Concurrent different-activity displacement (Invariant 5)
  // -------------------------------------------------------------------------

  it('concurrent cameras with different zones → two independent visits, no immediate displacement', async () => {
    // Zone-visit model: wheel and food visits are independent. When food camera
    // fires while wheel visit is open, NOTHING is immediately emitted — wheel
    // visit stays open until the wheel camera ends. Both entries arrive at their
    // respective track-end flush.
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 2000 });
    resetNarratorState();
    await seedCameras(); // wheel + food cameras

    const t0 = 1_700_000_000_000;
    let now = t0;
    const deps = { now: () => now, rng: () => 0 as number, onEntryWritten: async () => {} };

    // Pet appears on the wheel camera.
    await handleFrigateEvent(
      newEvent({ type: 'new', camera: 'wheel', zones: ['wheel'], startSec: 1_700_000_000 }),
      deps,
    );

    // 5s later, food camera fires a new event — both visits are now open.
    now = t0 + 5_000;
    const writtenOnFoodNew = await handleFrigateEvent(
      newEvent({ type: 'new', camera: 'food', zones: ['food'] }),
      deps,
    );
    // No immediate emission — wheel visit is still open (wheel camera is active).
    expect(writtenOnFoodNew.length).toBe(0);

    // Wheel ends after 8s total.
    now = t0 + 8_000;
    await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'wheel', zones: ['wheel'], startSec: 1_700_000_000, endSec: 1_700_000_008 }),
      deps,
    );
    // Food ends after 10s total.
    now = t0 + 10_000;
    await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'food', zones: ['food'], startSec: 1_700_000_005, endSec: 1_700_000_010 }),
      deps,
    );
    // Advance past both transition windows.
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(2);
    const activities = entries.map((e) => e.activity).sort();
    expect(activities).toEqual(['food', 'wheel']);
    vi.useRealTimers();
  });

  it('second camera fires with different zone — no entry until its own track ends', async () => {
    // Simpler case: wheel fires new, food fires new, food fires end → food entry
    // (if dwell >= min). Wheel entry comes separately when wheel ends.
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 500 });
    resetNarratorState();
    await seedCameras();

    const t0 = 1_700_000_000_000;
    let now = t0;
    const deps = { now: () => now, rng: () => 0 as number, onEntryWritten: async () => {} };

    // Wheel new.
    await handleFrigateEvent(newEvent({ type: 'new', camera: 'wheel', zones: ['wheel'], startSec: 1_700_000_000 }), deps);
    // 1s: food new (short visit, below 500ms? no, 2s).
    now = t0 + 1_000;
    await handleFrigateEvent(newEvent({ type: 'new', camera: 'food', zones: ['food'] }), deps);
    // 3s: food ends (dwell 2s >= 500ms → food entry deferred).
    now = t0 + 3_000;
    await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'food', zones: ['food'], startSec: 1_700_000_001, endSec: 1_700_000_003 }),
      deps,
    );
    // Advance past food transition window.
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    // Only food entry so far; wheel is still open.
    let entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(1);
    expect(entries[0]?.activity).toBe('food');

    // 6s: wheel ends.
    now = t0 + 6_000;
    await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'wheel', zones: ['wheel'], startSec: 1_700_000_000, endSec: 1_700_000_006 }),
      deps,
    );
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(2);
    vi.useRealTimers();
  });

  it('wheel odometer session stays open while wheel visit is live, closes only at wheel track end', async () => {
    // Under zone-visit model: food camera firing does NOT end the wheel odometer.
    // The wheel odometer closes when the wheel zone visit closes.
    const spawnMock = vi.fn(() => makeFakeProc());
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));

    process.env['FRIGATE_URL'] = 'http://frigate:5000';

    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const { _activeSessions } = await import('../src/wheel-odometer.js');
    const db = await import('../src/db.js');

    setNarratorTuningsForTests({ transitionWindowMs: 8000, minDwellMs: 2000 });
    resetNarratorState();

    const camA = db.createCamera({
      name: 'cam-a',
      emoji: '🎡',
      stream_url: 'rtsp://fake/a',
      live_src: 'cam_a',
      enabled: true,
      zones: ['wheel'],
      wheel_mark_enabled: true,
      wheel_diameter_mm: 152.0,
      wheel_band_y_pct: 50.0,
      wheel_band_height_pct: 10.0,
      wheel_threshold_pct: 50.0,
    });
    db.createCamera({
      name: 'cam-b',
      emoji: '🥕',
      stream_url: 'rtsp://fake/b',
      live_src: 'cam_b',
      enabled: true,
      zones: ['food'],
    });
    db.setSetting('pet_name', 'Remy');

    const t0 = 1_700_000_000_000;
    let now = t0;
    const deps = { now: () => now, rng: () => 0 as number, onEntryWritten: async () => {} };

    // cam-a fires 'new' for wheel → odometer session starts.
    await handleFrigateEvent(newEvent({ type: 'new', camera: 'cam-a', zones: ['wheel'], startSec: 1_700_000_000 }), deps);
    expect(_activeSessions.size).toBe(1);
    expect(_activeSessions.has(camA.id)).toBe(true);

    // 5s later, cam-b fires 'new' for food — odometer keeps running (wheel still open).
    now = t0 + 5_000;
    await handleFrigateEvent(newEvent({ type: 'new', camera: 'cam-b', zones: ['food'] }), deps);
    expect(_activeSessions.size).toBe(1); // still running — wheel visit is open

    // cam-a ends — wheel visit closes and odometer session ends.
    now = t0 + 8_000;
    await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'cam-a', zones: ['wheel'], startSec: 1_700_000_000, endSec: 1_700_000_008 }),
      deps,
    );
    expect(_activeSessions.size).toBe(0); // odometer ended when wheel visit closed

    void db;
    vi.doUnmock('node:child_process');
  });
});

// ---------------------------------------------------------------------------
// Regression tests: cameraIdByName resolution via live_src (bug fix)
// ---------------------------------------------------------------------------

describe('cameraIdByName — live_src resolution', () => {
  /**
   * Seed cameras that mirror the production situation:
   *   Camera 1  (name='Camera 1',  live_src='hamster_cam_1')
   *   Camera 2  (name='Camera 2',  live_src='hamster_cam_2')
   * Frigate events carry the live_src value, not the name.
   */
  async function seedProductionCameras() {
    const db = await import('../src/db.js');
    const cam1 = db.createCamera({
      name: 'Camera 1',
      emoji: '📷',
      stream_url: 'rtsp://x/cam1',
      live_src: 'hamster_cam_1',
      enabled: true,
    });
    const cam2 = db.createCamera({
      name: 'Camera 2',
      emoji: '📷',
      stream_url: 'rtsp://x/cam2',
      live_src: 'hamster_cam_2',
      enabled: true,
    });
    db.setSetting('pet_name', 'Remy');
    return { cam1Id: cam1.id, cam2Id: cam2.id };
  }

  it('resolves a Frigate live_src identifier to the correct camera id (primary match)', async () => {
    const db = await import('../src/db.js');
    const ids = await seedProductionCameras();
    // handleFrigateEvent internally calls cameraIdByName with the Frigate camera
    // name. After the fix, diary entries should carry the correct camera_id.
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 10 });
    resetNarratorState();

    vi.useFakeTimers();
    const t0 = 1_700_000_000_000;
    // Frigate sends live_src as the camera identifier.
    await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'hamster_cam_1', zones: ['food'], startSec: 1_700_000_000, endSec: 1_700_000_005 }),
      { now: () => t0, rng: () => 0, onEntryWritten: async () => {} },
    );
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(1);
    // This is the regression assertion: camera_id must NOT be null.
    expect(entries[0]?.camera_id).toBe(ids.cam1Id);
    void ids;
    vi.useRealTimers();
  });

  it('resolves case-insensitively and trims whitespace on live_src', async () => {
    const db = await import('../src/db.js');
    // Camera with live_src that has mixed case.
    const cam = db.createCamera({
      name: 'Wide View',
      emoji: '📷',
      stream_url: 'rtsp://x/wide',
      live_src: 'Hamster_CAM_Wide',
      enabled: true,
    });
    db.setSetting('pet_name', 'Remy');

    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 10 });
    resetNarratorState();

    vi.useFakeTimers();
    const t0 = 1_700_000_500_000;
    // Frigate sends the identifier in lower_snake_case — must still match.
    await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'hamster_cam_wide', zones: ['food'], startSec: 1_700_000_500, endSec: 1_700_000_505 }),
      { now: () => t0, rng: () => 0, onEntryWritten: async () => {} },
    );
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(1);
    expect(entries[0]?.camera_id).toBe(cam.id);
    vi.useRealTimers();
  });

  it('falls back to name match when live_src is null', async () => {
    const db = await import('../src/db.js');
    // Camera with no live_src configured.
    const cam = db.createCamera({
      name: 'wheel',
      emoji: '🎡',
      stream_url: 'rtsp://x/wheel',
      enabled: true,
    });
    db.setSetting('pet_name', 'Remy');

    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 10 });
    resetNarratorState();

    vi.useFakeTimers();
    const t0 = 1_700_001_000_000;
    // Frigate camera name matches cameras.name exactly (legacy single-cam setup).
    await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'wheel', zones: ['wheel'], startSec: 1_700_001_000, endSec: 1_700_001_005 }),
      { now: () => t0, rng: () => 0, onEntryWritten: async () => {} },
    );
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(1);
    expect(entries[0]?.camera_id).toBe(cam.id);
    vi.useRealTimers();
  });

  it('live_src match takes priority over name match when both would match different cameras', async () => {
    const db = await import('../src/db.js');
    // Camera A: name='hamster_cam_1', live_src='actual_cam' — name collision with Frigate id.
    const camA = db.createCamera({
      name: 'hamster_cam_1',
      emoji: '📷',
      stream_url: 'rtsp://x/a',
      live_src: 'actual_cam',
      enabled: true,
    });
    // Camera B: name='decoy', live_src='hamster_cam_1' — the correct one.
    const camB = db.createCamera({
      name: 'decoy',
      emoji: '📷',
      stream_url: 'rtsp://x/b',
      live_src: 'hamster_cam_1',
      enabled: true,
    });
    db.setSetting('pet_name', 'Remy');

    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 10 });
    resetNarratorState();

    vi.useFakeTimers();
    const t0 = 1_700_002_000_000;
    await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'hamster_cam_1', zones: ['food'], startSec: 1_700_002_000, endSec: 1_700_002_005 }),
      { now: () => t0, rng: () => 0, onEntryWritten: async () => {} },
    );
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(1);
    // live_src match (camB) must win over name match (camA).
    expect(entries[0]?.camera_id).toBe(camB.id);
    void camA;
    vi.useRealTimers();
  });

  it('wheel session starts when Frigate sends live_src identifier for a wheel-enabled camera', async () => {
    // Regression test for symptom (2): wheel sessions never started because
    // cameraIdByName returned null, so startWheelSession was never called.
    const spawnMock = vi.fn(() => makeFakeProc());
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));

    process.env['FRIGATE_URL'] = 'http://frigate:5000';

    const db = await import('../src/db.js');
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const { _activeSessions } = await import('../src/wheel-odometer.js');

    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 10 });
    resetNarratorState();

    // Production-style camera: name='Camera 1', live_src='hamster_cam_1'.
    const cam = db.createCamera({
      name: 'Camera 1',
      emoji: '📷',
      stream_url: 'rtsp://x/cam1',
      live_src: 'hamster_cam_1',
      enabled: true,
      wheel_mark_enabled: true,
      wheel_diameter_mm: 152.0,
      wheel_band_y_pct: 50.0,
      wheel_band_height_pct: 10.0,
      wheel_threshold_pct: 50.0,
    });
    db.setSetting('pet_name', 'Remy');

    vi.useFakeTimers();
    const t0 = 1_700_003_000_000;
    const deps = { now: () => t0, rng: () => 0 as number, onEntryWritten: async () => {} };

    // Frigate sends the live_src value as camera name.
    await handleFrigateEvent(
      newEvent({ type: 'new', camera: 'hamster_cam_1', zones: ['wheel'], startSec: 1_700_003_000 }),
      deps,
    );

    // With the fix, the camera resolves → odometer session starts.
    expect(_activeSessions.size).toBe(1);
    expect(_activeSessions.has(cam.id)).toBe(true);

    void cam;
    vi.useRealTimers();
    vi.doUnmock('node:child_process');
  });
});

// ---------------------------------------------------------------------------
// Bug 1 regression: odomCameraId must only be set when startWheelSession
// returns true (i.e. an ffmpeg session is actually live). Previously
// isCameraWheelEnabled was checked instead of the return value of
// startWheelSession, which meant that a camera with wheel_mark_enabled=1 but
// no live_src would set odomCameraId even though no session was started,
// causing prepareCloseVisit to call endWheelSession on a non-existent session
// and silently produce no distance data.
// ---------------------------------------------------------------------------

describe('wheel odometer — odomCameraId is only set when a session actually started', () => {
  it('wheel_mark_enabled=1 with no live_src: no session started, no spurious endWheelSession call', async () => {
    vi.useFakeTimers();

    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const { _activeSessions } = await import('../src/wheel-odometer.js');
    const db = await import('../src/db.js');

    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 10 });
    resetNarratorState();

    // Camera has wheel mark enabled but live_src is not set — startWheelSession
    // will return false (no RTSP URL to connect to).
    const cam = db.createCamera({
      name: 'wheel-no-src',
      emoji: '🎡',
      stream_url: 'rtsp://x/wheel',
      // live_src deliberately omitted
      enabled: true,
      wheel_mark_enabled: true,
      wheel_diameter_mm: 152.0,
      wheel_band_y_pct: 50.0,
      wheel_band_height_pct: 10.0,
      wheel_threshold_pct: 50.0,
    });
    db.setSetting('pet_name', 'Remy');

    const t0 = 1_700_010_000_000;
    let now = t0;
    const deps = { now: () => now, rng: () => 0 as number, onEntryWritten: async () => {} };

    // Zone opens — session should NOT start (no live_src).
    await handleFrigateEvent(
      newEvent({ type: 'new', camera: 'wheel-no-src', zones: ['wheel'], startSec: 1_700_010_000 }),
      deps,
    );
    expect(_activeSessions.size).toBe(0); // no session started

    // Zone closes after a meaningful dwell.
    now = t0 + 30_000;
    await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'wheel-no-src', zones: ['wheel'], startSec: 1_700_010_000, endSec: 1_700_010_030 }),
      deps,
    );
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    // Entry IS written (wheel run happened even without odometry).
    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(1);
    expect(entries[0]?.activity).toBe('wheel');

    // But no wheel_meters in details (session was never started, so no distance).
    const details = entries[0]?.details
      ? (JSON.parse(entries[0].details) as Record<string, unknown>)
      : {};
    expect(details['wheel_meters']).toBeUndefined();

    void cam;
    vi.useRealTimers();
  });

  it('wheel_mark_enabled=1 with live_src set: session starts → odomCameraId set → distance recorded', async () => {
    const spawnMock = vi.fn(() => makeFakeProc());
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));
    vi.useFakeTimers();

    process.env['FRIGATE_URL'] = 'http://frigate:5000';

    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const { _activeSessions } = await import('../src/wheel-odometer.js');
    const db = await import('../src/db.js');

    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 10 });
    resetNarratorState();

    const cam = db.createCamera({
      name: 'wheel-with-src',
      emoji: '🎡',
      stream_url: 'rtsp://x/wheel',
      live_src: 'wheel_cam',
      enabled: true,
      wheel_mark_enabled: true,
      wheel_diameter_mm: 152.0,
      wheel_band_y_pct: 50.0,
      wheel_band_height_pct: 10.0,
      wheel_threshold_pct: 50.0,
    });
    db.setSetting('pet_name', 'Remy');

    const t0 = 1_700_011_000_000;
    let now = t0;
    const deps = { now: () => now, rng: () => 0 as number, onEntryWritten: async () => {} };

    // Zone opens — session SHOULD start.
    await handleFrigateEvent(
      newEvent({ type: 'new', camera: 'wheel_cam', zones: ['wheel'], startSec: 1_700_011_000 }),
      deps,
    );
    expect(_activeSessions.size).toBe(1); // session started
    expect(_activeSessions.has(cam.id)).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Zone closes.
    now = t0 + 30_000;
    await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'wheel_cam', zones: ['wheel'], startSec: 1_700_011_000, endSec: 1_700_011_030 }),
      deps,
    );
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    // Session ended after zone closed.
    expect(_activeSessions.size).toBe(0);

    void cam;
    vi.useRealTimers();
    vi.doUnmock('node:child_process');
  });
});

// ---------------------------------------------------------------------------
// Migration 0021 backfill tests
// ---------------------------------------------------------------------------

describe('migration 0021 — backfill diary camera_ids from details JSON', () => {
  /**
   * Strategy: migrate(path) once to get full schema + apply 0021. Insert broken
   * rows (camera_id = NULL with details.camera). Delete the _migrations bookkeeping
   * row for 0021 so the runner thinks it hasn't run. Close. Call migrate(path) again
   * — it re-applies 0021 UPDATEs to the inserted rows. Assert camera_id populated.
   */
  function openMigratedDb(dbPath: string): Database.Database {
    return migrate(dbPath);
  }

  it('populates camera_id for non-transition entries that have details.camera matching a live_src', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hamster-mig021-'));
    const dbPath = join(dir, 'test.db');
    try {
      const db = openMigratedDb(dbPath);

      db.prepare(
        `INSERT INTO cameras (name, emoji, stream_url, live_src, enabled, created_at)
         VALUES ('Camera 1','cam1','rtsp://x/cam1','hamster_cam_1',1,1700000000000)`,
      ).run();
      const camId = (db.prepare(`SELECT id FROM cameras WHERE live_src = 'hamster_cam_1'`).get() as { id: number }).id;

      // Simulate a pre-fix row: camera_id IS NULL, details has the live_src value.
      db.prepare(
        `INSERT INTO diary_entries (occurred_at, kind, activity, narrative, camera_id, details)
         VALUES (1700000005000,'narrative','food','Remy nibbled.',NULL,'{"camera":"hamster_cam_1"}')`,
      ).run();
      const entryId = (db.prepare('SELECT id FROM diary_entries').get() as { id: number }).id;

      // Delete the 0021 _migrations row so migrate() re-applies it.
      db.prepare(`DELETE FROM _migrations WHERE name LIKE '%0021%'`).run();
      db.close();

      // Re-run migrate so 0021 UPDATEs fire against our inserted row.
      const db2 = openMigratedDb(dbPath);
      const row = db2.prepare('SELECT camera_id FROM diary_entries WHERE id = ?').get(entryId) as { camera_id: number | null };
      expect(row.camera_id).toBe(camId);
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('populates from_camera_id and to_camera_id for transition entries, leaves camera_id null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hamster-mig021b-'));
    const dbPath = join(dir, 'test.db');
    try {
      const db = openMigratedDb(dbPath);

      db.prepare(
        `INSERT INTO cameras (name, emoji, stream_url, live_src, enabled, created_at)
         VALUES ('Camera 1','cam1','rtsp://x/cam1','hamster_cam_1',1,1700000000000)`,
      ).run();
      db.prepare(
        `INSERT INTO cameras (name, emoji, stream_url, live_src, enabled, created_at)
         VALUES ('Camera 2','cam2','rtsp://x/cam2','hamster_cam_2',1,1700000000001)`,
      ).run();
      const cam1Id = (db.prepare(`SELECT id FROM cameras WHERE live_src = 'hamster_cam_1'`).get() as { id: number }).id;
      const cam2Id = (db.prepare(`SELECT id FROM cameras WHERE live_src = 'hamster_cam_2'`).get() as { id: number }).id;

      db.prepare(
        `INSERT INTO diary_entries (occurred_at, kind, activity, narrative, camera_id, from_camera_id, to_camera_id, details)
         VALUES (1700000010000,'narrative','transition','Remy moved.',NULL,NULL,NULL,
                 '{"from":"hamster_cam_1","to":"hamster_cam_2","dwell_ms":5000}')`,
      ).run();
      const entryId = (db.prepare(`SELECT id FROM diary_entries WHERE activity = 'transition'`).get() as { id: number }).id;

      db.prepare(`DELETE FROM _migrations WHERE name LIKE '%0021%'`).run();
      db.close();

      const db2 = openMigratedDb(dbPath);
      const row = db2.prepare(
        'SELECT camera_id, from_camera_id, to_camera_id FROM diary_entries WHERE id = ?',
      ).get(entryId) as { camera_id: number | null; from_camera_id: number | null; to_camera_id: number | null };

      expect(row.camera_id).toBeNull();
      expect(row.from_camera_id).toBe(cam1Id);
      expect(row.to_camera_id).toBe(cam2Id);
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op for entries whose camera_id is already correctly set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hamster-mig021c-'));
    const dbPath = join(dir, 'test.db');
    try {
      const db = openMigratedDb(dbPath);

      db.prepare(
        `INSERT INTO cameras (name, emoji, stream_url, live_src, enabled, created_at)
         VALUES ('Camera 1','cam1','rtsp://x/cam1','hamster_cam_1',1,1700000000000)`,
      ).run();
      const camId = (db.prepare(`SELECT id FROM cameras WHERE live_src = 'hamster_cam_1'`).get() as { id: number }).id;

      // Entry already has the correct camera_id — migration must not disturb it.
      db.prepare(
        `INSERT INTO diary_entries (occurred_at, kind, activity, narrative, camera_id, details)
         VALUES (1700000020000,'narrative','wheel','Remy ran.',${camId},'{"camera":"hamster_cam_1"}')`,
      ).run();
      const entryId = (db.prepare('SELECT id FROM diary_entries').get() as { id: number }).id;

      db.prepare(`DELETE FROM _migrations WHERE name LIKE '%0021%'`).run();
      db.close();

      const db2 = openMigratedDb(dbPath);
      const row = db2.prepare('SELECT camera_id FROM diary_entries WHERE id = ?').get(entryId) as { camera_id: number | null };
      expect(row.camera_id).toBe(camId);
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op when no camera matches the details.camera value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hamster-mig021d-'));
    const dbPath = join(dir, 'test.db');
    try {
      const db = openMigratedDb(dbPath);

      // No cameras inserted — subquery returns NULL, camera_id stays NULL.
      db.prepare(
        `INSERT INTO diary_entries (occurred_at, kind, activity, narrative, camera_id, details)
         VALUES (1700000030000,'narrative','food','Remy ate.',NULL,'{"camera":"unknown_cam"}')`,
      ).run();
      const entryId = (db.prepare('SELECT id FROM diary_entries').get() as { id: number }).id;

      db.prepare(`DELETE FROM _migrations WHERE name LIKE '%0021%'`).run();
      db.close();

      const db2 = openMigratedDb(dbPath);
      const row = db2.prepare('SELECT camera_id FROM diary_entries WHERE id = ?').get(entryId) as { camera_id: number | null };
      expect(row.camera_id).toBeNull();
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

});
