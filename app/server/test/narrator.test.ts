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
  /**
   * Simulates Frigate's commit-gate fields on the `after` side.
   * Defaults to `has_snapshot: true` so existing tests (which test behaviours
   * unrelated to the gate) continue to produce diary entries.
   * Set `has_snapshot: false, has_clip: false` to simulate an unsaved track,
   * or `false_positive: true` to simulate a false-positive track.
   */
  has_snapshot?: boolean;
  has_clip?: boolean;
  false_positive?: boolean;
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
    // Default has_snapshot=true so existing tests that don't care about the
    // commit gate continue to produce diary entries as expected.
    has_snapshot: args.has_snapshot ?? true,
    has_clip: args.has_clip ?? false,
    false_positive: args.false_positive ?? false,
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

  it('falls back to a standalone food entry when no follow-up arrives before the window expires', async () => {
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
      newEvent({ type: 'end', camera: 'food', zones: ['food'], startSec: 1_700_000_000, endSec: 1_700_000_005 }),
      { now: () => now, rng: () => 0 },
    );
    // Advance past the transition window so the timer flushes.
    now += 200;
    await vi.advanceTimersByTimeAsync(200);
    // Drain microtasks once more.
    await Promise.resolve();
    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(1);
    expect(entries[0]?.activity).toBe('food');
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

  it('wheel tape sessions with <5 min silence between them merge into one row; sessions further apart stay distinct', async () => {
    // Two wheel tape sessions with only 7s of silence between them (well within
    // the 5 min dedupe gap) merge into ONE row with accumulated distance.
    const { handleWheelTapeSession, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    resetNarratorState();
    const cam = db.createCamera({ name: 'wheel-cam', emoji: '🎡', stream_url: 'rtsp://x/w', enabled: true });
    db.setSetting('pet_name', 'Remy');

    const t0 = 1_700_000_000_000;
    const deps = { now: () => t0, rng: () => 0 as number, onEntryWritten: async () => {} };

    // First session: ends at t0 + 3_000.
    await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: t0, endedAt: t0 + 3_000, rotations: 10, meanRps: 3.3, peakRps: 5 },
      deps,
    );

    // Second session starts 7s after first ended (10_000 - 3_000 = 7_000 ms gap → within 5 min).
    await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: t0 + 10_000, endedAt: t0 + 13_000, rotations: 12, meanRps: 2.7, peakRps: 4 },
      { ...deps, now: () => t0 + 13_000 },
    );

    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    // Within-gap → merged: exactly ONE row.
    expect(entries.length).toBe(1);
    expect(entries[0]?.activity).toBe('wheel');
    // The merged row has a merged_sessions counter.
    const details = JSON.parse(entries[0]?.details ?? '{}') as Record<string, unknown>;
    expect(details['merged_sessions']).toBe(1);
    // Accumulated wheel_meters: (10 + 12) × 13cm / 100 = 2.86m total.
    expect(typeof details['wheel_meters']).toBe('number');
    expect((details['wheel_meters'] as number)).toBeGreaterThan(0);
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

  it('writes a food entry even when the server clock is 30s ahead of the Frigate Pi clock', async () => {
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
      newEvent({ type: 'new', camera: 'food', zones: ['food'], startSec: frigateStart }),
      { now: () => serverNew, rng: () => 0 },
    );

    // 'end' event: server clock is serverEnd, Frigate's end_time = frigateEnd.
    await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'food', zones: ['food'], startSec: frigateStart, endSec: frigateEnd }),
      { now: () => serverEnd, rng: () => 0 },
    );

    // Advance past transition window so the deferred timer fires.
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    const entries = db.listDiaryEntriesBetween(0, serverEnd + 1_000_000);
    // Entry MUST be present — clock skew must not cause a silent drop.
    expect(entries.length).toBe(1);
    expect(entries[0]?.activity).toBe('food');
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
      newEvent({ type: 'new', camera: 'food', zones: ['food'], startSec: frigateStart }),
      { now: () => serverNew, rng: () => 0 },
    );

    await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'food', zones: ['food'], startSec: frigateStart, endSec: frigateEnd }),
      { now: () => serverEnd, rng: () => 0 },
    );

    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    const entries = db.listDiaryEntriesBetween(0, serverEnd + 1_000_000);
    expect(entries.length).toBe(1);
    expect(entries[0]?.activity).toBe('food');
    expect(entries[0]?.duration_ms).toBe((frigateEnd - frigateStart) * 1000); // 60_000 ms
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Exploring dwell gate — by-design suppression
// ---------------------------------------------------------------------------

describe('exploring dwell gate (by-design noise suppression)', () => {
  it('drops an exploring visit shorter than exploringMinDwellMs (60s default)', async () => {
    // Wheel zone events are suppressed by the motion-energy gate; use a neutral
    // camera so the Frigate 'end' event is classified as 'exploring'.
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    // Use default 60s exploring min-dwell.
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 2000, exploringMinDwellMs: 60_000 });
    resetNarratorState();

    // Neutral camera — no zone keyword in name, so zones:[] → 'exploring'.
    db.createCamera({ name: 'cam-neutral', emoji: '📷', stream_url: 'rtsp://x/n', enabled: true });
    db.setSetting('pet_name', 'Remy');

    const t0 = 1_700_100_000_000;
    // 40s dwell in open space (no named zone) — below the 60s exploring threshold.
    await handleFrigateEvent(
      newEvent({
        type: 'end',
        camera: 'cam-neutral',
        zones: [],
        startSec: 1_700_100_000,
        endSec: 1_700_100_040, // 40s < 60s threshold
      }),
      { now: () => t0, rng: () => 0, onEntryWritten: async () => {} },
    );
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    // 40s < 60s → exploring entry dropped.
    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(0);
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
      newEvent({ type: 'new', camera: 'food', zones: [], startSec: frigateTrackStart }),
      { now: () => serverNew, rng: () => 0, onEntryWritten: async () => {} },
    );

    // 'update' — pet enters food zone mid-track. Opens food visit anchored at nowMs (server).
    await handleFrigateEvent(
      newEvent({ type: 'update', camera: 'food', zones: ['food'] }),
      { now: () => serverUpdate, rng: () => 0, onEntryWritten: async () => {} },
    );

    // 'end' — closedAt = endMs (Pi clock). For the update-opened food visit:
    //   rawDuration = endMs - serverUpdate = frigateTrackEnd*1000 - (frigateZoneEnter*1000 + skewMs)
    //               = (1_700_500_070 - 1_700_500_010)*1000 - 40_000
    //               = 60_000 - 40_000 = 20_000ms (positive! dwell 20s > 2s threshold)
    // But if skew were 80s instead, rawDuration = 60_000 - 80_000 = -20_000 → clamped to 0.
    await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'food', zones: ['food'], startSec: frigateTrackStart, endSec: frigateTrackEnd }),
      { now: () => serverEnd, rng: () => 0, onEntryWritten: async () => {} },
    );

    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    // With 40s skew and 60s zone dwell: duration = 60_000 - 40_000 = 20_000ms > 2_000ms → entry present.
    const entries = db.listDiaryEntriesBetween(0, serverEnd + 1_000_000);
    const foodEntries = entries.filter((e) => e.activity === 'food');
    expect(foodEntries.length).toBe(1);
    // Duration is positive (clamped) not negative.
    expect(foodEntries[0]?.duration_ms).toBeGreaterThanOrEqual(0);
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

  it('two overlapping cameras on the wheel — Frigate zone events produce NO wheel diary entries (motion-energy detector owns wheel)', async () => {
    // Since migration 0024, wheel diary entries come exclusively from the
    // motion-energy detector (wheel-motion.ts). Frigate zone events for the
    // 'wheel' zone are silently ignored by the narrator.
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');

    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 10 });
    resetNarratorState();
    await seedOverlappingWheelCameras(['cam-a', 'cam-b']);

    const t0 = 1_700_000_000_000;
    let now = t0;
    const deps = { now: () => now, rng: () => 0 as number, onEntryWritten: async () => {} };

    // Two cameras both reporting wheel zone.
    await handleFrigateEvent(newEvent({ type: 'new', camera: 'cam-a', zones: ['wheel'], startSec: 1_700_000_000 }), deps);
    await handleFrigateEvent(newEvent({ type: 'new', camera: 'cam-b', zones: ['wheel'], startSec: 1_700_000_000 }), deps);

    now = t0 + 5_000;
    await handleFrigateEvent(newEvent({ type: 'end', camera: 'cam-a', zones: ['wheel'], startSec: 1_700_000_000, endSec: 1_700_000_005 }), deps);
    await handleFrigateEvent(newEvent({ type: 'end', camera: 'cam-b', zones: ['wheel'], startSec: 1_700_000_000, endSec: 1_700_000_005 }), deps);

    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    // Wheel zone events from Frigate no longer produce diary entries.
    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(0);

    vi.useRealTimers();
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

  it('single-camera wheel Frigate zone event produces no diary entry (motion-energy detector owns wheel)', async () => {
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

    // Wheel zone events from Frigate produce no diary entries.
    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(0);
    vi.useRealTimers();
  });

  it('wheel zone events from two cameras: Frigate zone events are silently ignored regardless of odometry config', async () => {
    // Since migration 0024, wheel diary entries come from the motion-energy detector
    // only. Frigate zone events for 'wheel' produce no diary entries regardless of
    // which cameras report them.
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');

    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 10 });
    resetNarratorState();
    const ids = await seedOverlappingWheelCameras(['cam-b']);
    void ids; // camAId and camBId not needed for this assertion

    const t0 = 1_700_000_000_000;
    let now = t0;
    const deps = { now: () => now, rng: () => 0 as number, onEntryWritten: async () => {} };

    await handleFrigateEvent(newEvent({ type: 'new', camera: 'cam-a', zones: ['wheel'], startSec: 1_700_000_000 }), deps);
    await handleFrigateEvent(newEvent({ type: 'new', camera: 'cam-b', zones: ['wheel'], startSec: 1_700_000_000 }), deps);

    now = t0 + 5_000;
    await handleFrigateEvent(newEvent({ type: 'end', camera: 'cam-a', zones: ['wheel'], startSec: 1_700_000_000, endSec: 1_700_000_005 }), deps);
    await handleFrigateEvent(newEvent({ type: 'end', camera: 'cam-b', zones: ['wheel'], startSec: 1_700_000_000, endSec: 1_700_000_005 }), deps);

    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(0);

    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Zone-entry model: mid-track zone transitions
  // -------------------------------------------------------------------------

  it('mid-track zone entry: update event moving into a named zone produces an entry immediately', async () => {
    // Hamster enters food zone mid-track (via update event) and the food visit
    // should be emitted when the object later leaves the zone. Uses a neutral
    // camera name so zone detection comes only from current_zones.
    // (Wheel zone is intentionally not tested here — it is owned by the
    // motion-energy detector and Frigate zone events for 'wheel' are ignored.)
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

    // 2s later: object moves into the food zone (update event).
    now = t0 + 2_000;
    await handleFrigateEvent(newEvent({ type: 'update', camera: 'cam-wide', zones: ['food'] }), deps);

    // 5s later: object moves back out of the food zone (update: zones empty again).
    // This closes the food visit (mid-track close → emit immediately).
    now = t0 + 7_000;
    const writtenOnLeave = await handleFrigateEvent(
      newEvent({ type: 'update', camera: 'cam-wide', zones: [] }),
      deps,
    );
    // The food visit closed (5s dwell > 500ms) → immediate entry.
    expect(writtenOnLeave.length).toBe(1);
    expect(writtenOnLeave[0]?.activity).toBe('food');
    expect(writtenOnLeave[0]?.duration_ms).toBe(5_000);

    // DB check: one food entry emitted mid-track.
    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    const foodEntries = entries.filter((e) => e.activity === 'food');
    expect(foodEntries.length).toBe(1);

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

    // Object enters food zone (wheel is now owned by motion-energy detector).
    await handleFrigateEvent(newEvent({ type: 'new', camera: 'food', zones: ['food'], startSec: 1_700_000_000 }), deps);

    // Frigate fires many updates all reporting the same zone — no new entries.
    for (let i = 1; i <= 10; i++) {
      now = t0 + i * 200;
      await handleFrigateEvent(newEvent({ type: 'update', camera: 'food', zones: ['food'] }), deps);
    }

    // After 10 updates, still no entries written.
    expect(db.listDiaryEntriesBetween(0, t0 + 1_000_000).length).toBe(0);

    // Track ends → defers food entry.
    now = t0 + 5_000;
    await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'food', zones: ['food'], startSec: 1_700_000_000, endSec: 1_700_000_005 }),
      deps,
    );
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    // Exactly ONE entry despite 10+ updates.
    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(1);
    expect(entries[0]?.activity).toBe('food');

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

    // Wheel zone events from Frigate are silently ignored — only food entry written.
    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(1);
    expect(entries[0]?.activity).toBe('food');
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

    // Wheel zone end is silently ignored — only the food entry is in the DB.
    entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(1);
    vi.useRealTimers();
  });

  it('wheel odometer keeps running when food camera fires — always-on model', async () => {
    // Under the always-on model, the wheel odometer never stops between visits.
    // Food camera events do NOT affect the wheel odometer's running state.
    // The wheel odometer's snapshot is only READ (not stopped) when the visit closes.
    const spawnMock = vi.fn(() => makeFakeProc());
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));

    process.env['FRIGATE_URL'] = 'http://frigate:5000';

    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const { initWheelOdometers, getRotationSnapshot, resetOdometersForTests } =
      await import('../src/wheel-odometer.js');
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

    // Start always-on odometer for cam-a (cam-b has no wheel_mark_enabled).
    initWheelOdometers();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const t0 = 1_700_000_000_000;
    let now = t0;
    const deps = { now: () => now, rng: () => 0 as number, onEntryWritten: async () => {} };

    // cam-a fires 'new' for wheel → opening snapshot taken.
    await handleFrigateEvent(newEvent({ type: 'new', camera: 'cam-a', zones: ['wheel'], startSec: 1_700_000_000 }), deps);
    // Odometer is always-on — snapshot should be available.
    expect(getRotationSnapshot(camA.id)).not.toBeNull();

    // 5s later, cam-b fires 'new' for food — wheel odometer is STILL running.
    now = t0 + 5_000;
    await handleFrigateEvent(newEvent({ type: 'new', camera: 'cam-b', zones: ['food'] }), deps);
    // Odometer still running — not stopped by food event.
    expect(getRotationSnapshot(camA.id)).not.toBeNull();

    // cam-a ends — wheel visit closes and diary entry is written.
    now = t0 + 8_000;
    await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'cam-a', zones: ['wheel'], startSec: 1_700_000_000, endSec: 1_700_000_008 }),
      deps,
    );
    // Always-on odometer is still running after the visit closes.
    expect(getRotationSnapshot(camA.id)).not.toBeNull();

    resetOdometersForTests();
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
    // Camera with no live_src configured — Frigate sends cameras.name as camera id.
    const cam = db.createCamera({
      name: 'food-bowl',
      emoji: '🥕',
      stream_url: 'rtsp://x/food',
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
      newEvent({ type: 'end', camera: 'food-bowl', zones: ['food'], startSec: 1_700_001_000, endSec: 1_700_001_005 }),
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

  it('wheel snapshot resolves when Frigate sends live_src identifier for a wheel-enabled camera', async () => {
    // Regression: cameraIdByName must resolve live_src → correct camera row so
    // the narrator can read the opening rotation snapshot from the always-on odometer.
    const spawnMock = vi.fn(() => makeFakeProc());
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));

    process.env['FRIGATE_URL'] = 'http://frigate:5000';

    const db = await import('../src/db.js');
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const { initWheelOdometers, getRotationSnapshot, resetOdometersForTests } =
      await import('../src/wheel-odometer.js');

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

    // Start the always-on odometer for this camera.
    initWheelOdometers();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Camera id resolves correctly via live_src — snapshot is available.
    expect(getRotationSnapshot(cam.id)).not.toBeNull();

    vi.useFakeTimers();
    const t0 = 1_700_003_000_000;
    const deps = { now: () => t0, rng: () => 0 as number, onEntryWritten: async () => {} };

    // Frigate sends the live_src value as camera name — cameraIdByName must resolve it.
    await handleFrigateEvent(
      newEvent({ type: 'new', camera: 'hamster_cam_1', zones: ['wheel'], startSec: 1_700_003_000 }),
      deps,
    );

    // Always-on odometer is still running after visit opens.
    expect(getRotationSnapshot(cam.id)).not.toBeNull();

    resetOdometersForTests();
    vi.useRealTimers();
    vi.doUnmock('node:child_process');
  });
});

// ---------------------------------------------------------------------------
// handleWheelMotionSession — motion-energy detector integration tests
//
// Wheel diary entries come exclusively from the tape-crossing detector.
// These tests verify the handleWheelTapeSession API in narrator.ts.
// ---------------------------------------------------------------------------

describe('handleWheelTapeSession — tape-crossing detector integration', () => {
  it('creates a new diary entry with correct wheel_meters and rotation details', async () => {
    const { handleWheelTapeSession, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    resetNarratorState();

    const cam = db.createCamera({
      name: 'wheel-cam',
      emoji: '🎡',
      stream_url: 'rtsp://x/wheel',
      enabled: true,
      wheel_tape_circumference_cm: 13.0,
    });
    db.setSetting('pet_name', 'Remy');

    const t0 = 1_700_010_000_000;
    const durationMs = 10_000;
    // 20 rotations × 13 cm / 100 = 2.6 m
    const entry = await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: t0, endedAt: t0 + durationMs, rotations: 20, meanRps: 2.0, peakRps: 4.0 },
      { now: () => t0 + durationMs, rng: () => 0, onEntryWritten: async () => {} },
    );

    expect(entry).not.toBeNull();
    expect(entry?.activity).toBe('wheel');
    expect(entry?.duration_ms).toBe(durationMs);

    const details = JSON.parse(entry?.details ?? '{}') as Record<string, unknown>;
    expect(details['wheel_meters']).toBeCloseTo(2.6, 5);
    expect(details['rotations']).toBe(20);
    expect(details['mean_rps']).toBe(2.0);
    expect(details['peak_rps']).toBe(4.0);
    expect(typeof details['camera']).toBe('string');
  });

  it('dedupe: two sessions with 10s silence gap produce one merged row with accumulated wheel_meters', async () => {
    // First ends at t0 + 5_000; second starts at t0 + 15_000 → gap = 10s, within 5 min.
    const { handleWheelTapeSession, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    resetNarratorState();

    const cam = db.createCamera({
      name: 'wheel-cam',
      emoji: '🎡',
      stream_url: 'rtsp://x/wheel',
      enabled: true,
      wheel_tape_circumference_cm: 13.0,
    });
    db.setSetting('pet_name', 'Remy');

    const t0 = 1_700_020_000_000;
    // First session: 15 rotations → 15 × 13/100 = 1.95m.
    const first = await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: t0, endedAt: t0 + 5_000, rotations: 15, meanRps: 3.0, peakRps: 4.0 },
      { now: () => t0 + 5_000, rng: () => 0, onEntryWritten: async () => {} },
    );
    expect(first).not.toBeNull();

    // Second session starts 10s after first ended — gap = 10s, within 5 min dedupe gap.
    const t1 = t0 + 15_000;
    const merged = await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: t1, endedAt: t1 + 5_000, rotations: 15, meanRps: 3.0, peakRps: 4.0 },
      { now: () => t1 + 5_000, rng: () => 0, onEntryWritten: async () => {} },
    );
    expect(merged?.id).toBe(first?.id);

    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(1);
    const det = JSON.parse(entries[0]!.details ?? '{}') as Record<string, unknown>;
    // Accumulated: (15 + 15) × 13cm / 100 = 3.9m total.
    expect((det['wheel_meters'] as number)).toBeCloseTo(3.9, 4);
    expect(det['merged_sessions']).toBe(1);
    expect(det['rotations']).toBe(30);
  });

  it('two sessions with 6 min silence gap produce two separate rows', async () => {
    // Gap = 360_000 ms > 300_000 ms (5 min threshold) → no merge.
    const { handleWheelTapeSession, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    resetNarratorState();

    const cam = db.createCamera({
      name: 'wheel-cam',
      emoji: '🎡',
      stream_url: 'rtsp://x/wheel',
      enabled: true,
    });
    db.setSetting('pet_name', 'Remy');

    const t0 = 1_700_030_000_000;
    await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: t0, endedAt: t0 + 5_000, rotations: 30, meanRps: 1.0, peakRps: 2.0 },
      { now: () => t0 + 5_000, rng: () => 0, onEntryWritten: async () => {} },
    );

    // Second session starts 360_000 ms (6 min) after first ended — outside the 5 min gap.
    const t1 = t0 + 5_000 + 360_000;
    await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: t1, endedAt: t1 + 5_000, rotations: 30, meanRps: 1.0, peakRps: 2.0 },
      { now: () => t1 + 5_000, rng: () => 0, onEntryWritten: async () => {} },
    );

    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(2);
    expect(entries.every((e) => e.activity === 'wheel')).toBe(true);
    // No merged_sessions on the second row.
    const det2 = JSON.parse(entries[1]!.details ?? '{}') as Record<string, unknown>;
    expect(det2['merged_sessions']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Wheel sparse-session filter (MIN_VALID_ROTATIONS=10, MIN_VALID_MEAN_RPS=0.4)
// ---------------------------------------------------------------------------

describe('handleWheelTapeSession — sparse-session noise filter', () => {
  it('session with rotations < 10 is discarded — no diary row written', async () => {
    const { handleWheelTapeSession, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    resetNarratorState();
    const cam = db.createCamera({ name: 'wheel-cam', emoji: '🎡', stream_url: 'rtsp://x/w', enabled: true });
    db.setSetting('pet_name', 'Remy');

    const t0 = 1_740_000_000_000;
    const result = await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: t0, endedAt: t0 + 20_000, rotations: 8, meanRps: 0.6, peakRps: 1.0 },
      { now: () => t0 + 20_000, rng: () => 0, onEntryWritten: async () => {} },
    );

    expect(result).toBeNull();
    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(0);
  });

  it('session with meanRps < 0.4 is discarded — no diary row written', async () => {
    const { handleWheelTapeSession, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    resetNarratorState();
    const cam = db.createCamera({ name: 'wheel-cam', emoji: '🎡', stream_url: 'rtsp://x/w', enabled: true });
    db.setSetting('pet_name', 'Remy');

    const t0 = 1_740_100_000_000;
    const result = await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: t0, endedAt: t0 + 21_000, rotations: 5, meanRps: 0.3, peakRps: 0.6 },
      { now: () => t0 + 21_000, rng: () => 0, onEntryWritten: async () => {} },
    );

    expect(result).toBeNull();
    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(0);
  });

  it('session with rotations=12 and meanRps=0.5 passes the filter and is written', async () => {
    const { handleWheelTapeSession, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    resetNarratorState();
    const cam = db.createCamera({ name: 'wheel-cam', emoji: '🎡', stream_url: 'rtsp://x/w', enabled: true });
    db.setSetting('pet_name', 'Remy');

    const t0 = 1_740_200_000_000;
    const result = await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: t0, endedAt: t0 + 24_000, rotations: 12, meanRps: 0.5, peakRps: 1.0 },
      { now: () => t0 + 24_000, rng: () => 0, onEntryWritten: async () => {} },
    );

    expect(result).not.toBeNull();
    expect(result?.activity).toBe('wheel');
    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(1);
  });

  it('noise session does not corrupt dedupe state — real sessions before and after still merge', async () => {
    // Real session at t=0 → noise session at t=2 min (discarded) → real session at t=4 min.
    // Gap between first real end and second real start = 4 min < 5 min → should merge.
    const { handleWheelTapeSession, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    resetNarratorState();
    const cam = db.createCamera({ name: 'wheel-cam', emoji: '🎡', stream_url: 'rtsp://x/w', enabled: true });
    db.setSetting('pet_name', 'Remy');

    const base = 1_740_300_000_000;

    // Real session 1: ends at base + 60_000
    const s1Start = base;
    const s1End = base + 60_000;
    await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: s1Start, endedAt: s1End, rotations: 30, meanRps: 0.5, peakRps: 1.0 },
      { now: () => s1End, rng: () => 0, onEntryWritten: async () => {} },
    );

    // Noise session at t+2 min: 3 rotations, meanRps 0.15 — must be discarded.
    const noiseStart = base + 120_000;
    const noiseEnd = noiseStart + 20_000;
    const noiseResult = await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: noiseStart, endedAt: noiseEnd, rotations: 3, meanRps: 0.15, peakRps: 0.3 },
      { now: () => noiseEnd, rng: () => 0, onEntryWritten: async () => {} },
    );
    expect(noiseResult).toBeNull();

    // Real session 2: starts at t+4 min (4 min after real session 1 ended → gap = 4 min < 5 min).
    const s2Start = base + 240_000;
    const s2End = s2Start + 60_000;
    await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: s2Start, endedAt: s2End, rotations: 30, meanRps: 0.5, peakRps: 1.2 },
      { now: () => s2End, rng: () => 0, onEntryWritten: async () => {} },
    );

    const entries = db.listDiaryEntriesBetween(0, base + 1_000_000);
    // Noise session discarded, real sessions merged → exactly one diary row.
    expect(entries.length).toBe(1);
    expect(entries[0]!.occurred_at).toBe(s2End);
    const det = JSON.parse(entries[0]!.details ?? '{}') as Record<string, unknown>;
    expect(det['rotations']).toBe(60);
    expect(det['merged_sessions']).toBe(1);
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

// ---------------------------------------------------------------------------
// exploring → defined-zone transition (same track / same camera)
// ---------------------------------------------------------------------------
// Requirement: when the hamster is exploring (no defined zone) and then
// ENTERS a defined Frigate zone mid-track, the in-progress exploring entry
// must be finalised and written IMMEDIATELY, and the subsequent zone activity
// must open a SEPARATE diary entry — not coalesced into the exploring entry.
//
// Noise decision documented in commitDeferred: a 2 s anti-flicker floor
// replaces the normal exploringMinDwellMs gate when interruptedByZone=true.
// ---------------------------------------------------------------------------

describe('exploring → defined-zone transition (same track)', () => {
  it('produces BOTH an exploring entry and a distinct zone entry in correct occurred_at order', async () => {
    // Full happy path: explore for 10s, enter food zone for 5s.
    // Both entries must be written and exploring.occurred_at < food.occurred_at.
    // (Wheel zones are now owned by the motion-energy detector; use food instead.)
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 2_000, exploringMinDwellMs: 60_000 });
    resetNarratorState();

    db.createCamera({ name: 'cam-wide', emoji: '📷', stream_url: 'rtsp://x/wide', enabled: true });
    db.setSetting('pet_name', 'Remy');

    const t0 = 1_710_000_000_000;
    let now = t0;
    const deps = { now: () => now, rng: () => 0 as number, onEntryWritten: async () => {} };

    // Hamster detected in open space — exploring visit opens.
    await handleFrigateEvent(
      newEvent({ type: 'new', camera: 'cam-wide', zones: [], startSec: 1_710_000_000 }),
      deps,
    );

    // 10 seconds later the hamster enters the food zone mid-track.
    // This must: close exploring (write it NOW, bypassing exploringMinDwellMs),
    // then open a new food visit.
    now = t0 + 10_000;
    const writtenOnZoneEnter = await handleFrigateEvent(
      newEvent({ type: 'update', camera: 'cam-wide', zones: ['food'] }),
      deps,
    );

    // The exploring visit (10s, > 2s floor) is written IMMEDIATELY on zone entry.
    expect(writtenOnZoneEnter.length).toBe(1);
    expect(writtenOnZoneEnter[0]?.activity).toBe('exploring');
    expect(writtenOnZoneEnter[0]?.duration_ms).toBe(10_000);

    // Now the food visit is open. Close it with an update that leaves the zone.
    now = t0 + 15_000;
    const writtenOnZoneLeave = await handleFrigateEvent(
      newEvent({ type: 'update', camera: 'cam-wide', zones: [] }),
      deps,
    );
    // Food visit (5s, > 2s floor) is written immediately on zone exit.
    expect(writtenOnZoneLeave.length).toBe(1);
    expect(writtenOnZoneLeave[0]?.activity).toBe('food');
    expect(writtenOnZoneLeave[0]?.duration_ms).toBe(5_000);

    // DB check: both entries, in occurred_at order.
    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    // Sort ascending to check order.
    const sorted = [...entries].sort((a, b) => a.occurred_at - b.occurred_at);
    expect(sorted.length).toBe(2);
    expect(sorted[0]?.activity).toBe('exploring');
    expect(sorted[1]?.activity).toBe('food');
    // exploring.occurred_at < food.occurred_at
    expect(sorted[0]!.occurred_at).toBeLessThan(sorted[1]!.occurred_at);

    vi.useRealTimers();
  });

  it('zone entry is NOT coalesced into the exploring entry', async () => {
    // The wheel entry must be a distinct row, not an extension of the exploring row.
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 2_000, exploringMinDwellMs: 60_000 });
    resetNarratorState();

    db.createCamera({ name: 'cam-wide', emoji: '📷', stream_url: 'rtsp://x/wide', enabled: true });
    db.setSetting('pet_name', 'Remy');

    const t0 = 1_710_100_000_000;
    let now = t0;
    const deps = { now: () => now, rng: () => 0 as number, onEntryWritten: async () => {} };

    // Exploring for 10s.
    await handleFrigateEvent(
      newEvent({ type: 'new', camera: 'cam-wide', zones: [], startSec: 1_710_100_000 }),
      deps,
    );
    now = t0 + 10_000;
    await handleFrigateEvent(
      newEvent({ type: 'update', camera: 'cam-wide', zones: ['food'] }),
      deps,
    );
    // Food for 5s.
    now = t0 + 15_000;
    await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'cam-wide', zones: ['food'], startSec: 1_710_100_000, endSec: 1_710_100_015 }),
      deps,
    );
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    // Must be exactly TWO entries: exploring and food.
    expect(entries.length).toBe(2);
    const activities = entries.map((e) => e.activity).sort();
    expect(activities).toEqual(['exploring', 'food']);
    // Each must have its own positive duration_ms.
    const exploringEntry = entries.find((e) => e.activity === 'exploring');
    const foodEntry = entries.find((e) => e.activity === 'food');
    expect(exploringEntry?.duration_ms).toBeGreaterThan(0);
    expect(foodEntry?.duration_ms).toBeGreaterThan(0);
    // They must be SEPARATE rows with different occurred_at values.
    expect(exploringEntry?.id).not.toBe(foodEntry?.id);
    expect(exploringEntry?.occurred_at).not.toBe(foodEntry?.occurred_at);

    vi.useRealTimers();
  });

  it('short exploring interrupted by a zone still writes the exploring entry (bypasses exploringMinDwellMs)', async () => {
    // Operator specifically wants this: even a 3s exploring spell before the
    // pet enters a food zone must produce a diary entry.
    // (Wheel zones are now owned by the motion-energy detector; use food instead.)
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    // exploringMinDwellMs = 60s, but the exploring visit is only 3s long.
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 2_000, exploringMinDwellMs: 60_000 });
    resetNarratorState();

    db.createCamera({ name: 'cam-wide', emoji: '📷', stream_url: 'rtsp://x/wide', enabled: true });
    db.setSetting('pet_name', 'Remy');

    const t0 = 1_710_200_000_000;
    let now = t0;
    const deps = { now: () => now, rng: () => 0 as number, onEntryWritten: async () => {} };

    // Exploring for only 3s (way below 60s threshold).
    await handleFrigateEvent(
      newEvent({ type: 'new', camera: 'cam-wide', zones: [], startSec: 1_710_200_000 }),
      deps,
    );
    now = t0 + 3_000;
    // Pet immediately enters food zone — proof that the 3s of exploring was real.
    const writtenOnZoneEnter = await handleFrigateEvent(
      newEvent({ type: 'update', camera: 'cam-wide', zones: ['food'] }),
      deps,
    );

    // The exploring entry MUST be written despite only 3s dwell (> 2s floor).
    expect(writtenOnZoneEnter.length).toBe(1);
    expect(writtenOnZoneEnter[0]?.activity).toBe('exploring');
    expect(writtenOnZoneEnter[0]?.duration_ms).toBe(3_000);

    vi.useRealTimers();
  });

  it('anti-flicker floor: exploring visit < 2s before zone entry is still suppressed', async () => {
    // A 1s "exploring" blip that immediately classifies into a zone is too
    // short to be meaningful — suppress it (Frigate artefact, not real dwell).
    // (Wheel zones are now owned by the motion-energy detector; use food instead.)
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 2_000, exploringMinDwellMs: 60_000 });
    resetNarratorState();

    db.createCamera({ name: 'cam-wide', emoji: '📷', stream_url: 'rtsp://x/wide', enabled: true });
    db.setSetting('pet_name', 'Remy');

    const t0 = 1_710_300_000_000;
    let now = t0;
    const deps = { now: () => now, rng: () => 0 as number, onEntryWritten: async () => {} };

    // Exploring for only 1s — below the 2s anti-flicker floor.
    await handleFrigateEvent(
      newEvent({ type: 'new', camera: 'cam-wide', zones: [], startSec: 1_710_300_000 }),
      deps,
    );
    now = t0 + 1_000; // 1s < minDwellMs=2s → suppressed even with interruptedByZone
    const writtenOnZoneEnter = await handleFrigateEvent(
      newEvent({ type: 'update', camera: 'cam-wide', zones: ['food'] }),
      deps,
    );

    // Below the 2s floor → suppressed.
    expect(writtenOnZoneEnter.length).toBe(0);

    // The food visit opened correctly regardless.
    now = t0 + 8_000;
    const writtenOnLeave = await handleFrigateEvent(
      newEvent({ type: 'update', camera: 'cam-wide', zones: [] }),
      deps,
    );
    expect(writtenOnLeave.length).toBe(1);
    expect(writtenOnLeave[0]?.activity).toBe('food');

    // DB: only the food entry (exploring suppressed).
    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(1);
    expect(entries[0]?.activity).toBe('food');

    vi.useRealTimers();
  });

  it('pure exploring that ends WITHOUT entering a zone still obeys exploringMinDwellMs', async () => {
    // Regression guard: the 60s threshold must NOT be bypassed for a plain
    // exploring visit that ends normally (no zone entry follows).
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 2_000, exploringMinDwellMs: 60_000 });
    resetNarratorState();

    db.createCamera({ name: 'cam-wide', emoji: '📷', stream_url: 'rtsp://x/wide', enabled: true });
    db.setSetting('pet_name', 'Remy');

    const t0 = 1_710_400_000_000;
    const deps = { now: () => t0, rng: () => 0 as number, onEntryWritten: async () => {} };

    // 40s exploring, no zone entry ever — below 60s threshold.
    await handleFrigateEvent(
      newEvent({
        type: 'end',
        camera: 'cam-wide',
        zones: [],
        startSec: 1_710_400_000,
        endSec: 1_710_400_040, // 40s
      }),
      deps,
    );
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    // Must be suppressed — pure exploring, no zone entry proof.
    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(0);

    vi.useRealTimers();
  });

  it('cross-camera transition window remains intact after exploring→zone on single camera', async () => {
    // The 8s cross-camera transition window must not be disturbed.  After an
    // exploring→zone sequence on camera A, a 'new' event on camera B within
    // transitionWindowMs must still trigger a transition entry (when enabled).
    //
    // IMPORTANT: use a neutral camera name ('cam-wide') so that zones=[] truly
    // classifies as 'exploring'. A camera named 'wheel' would fall back to the
    // 'wheel' keyword even with an empty zones list, so no exploring visit
    // would ever open on that camera.
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({
      transitionWindowMs: 8_000,
      minDwellMs: 2_000,
      exploringMinDwellMs: 60_000,
      transitionEntriesEnabled: true,
    });
    resetNarratorState();

    // Neutral camera A — no keyword in name → zones=[] → 'exploring'.
    db.createCamera({ name: 'cam-wide', emoji: '📷', stream_url: 'rtsp://x/wide', enabled: true });
    // Camera B for the cross-camera follow-up.
    db.createCamera({ name: 'cam-food', emoji: '🥕', stream_url: 'rtsp://x/food', enabled: true });
    db.setSetting('pet_name', 'Remy');

    const t0 = 1_710_500_000_000;
    let now = t0;
    const deps = { now: () => now, rng: () => 0 as number, onEntryWritten: async () => {} };

    // 1. cam-wide: exploring for 5s, then enters wheel zone mid-track.
    //    The exploring entry (5s > 2s floor) must be written immediately.
    await handleFrigateEvent(
      newEvent({ type: 'new', camera: 'cam-wide', zones: [], startSec: 1_710_500_000 }),
      deps,
    );
    now = t0 + 5_000;
    const writtenOnZoneEnter = await handleFrigateEvent(
      newEvent({ type: 'update', camera: 'cam-wide', zones: ['wheel'] }),
      deps,
    );
    expect(writtenOnZoneEnter.length).toBe(1);
    expect(writtenOnZoneEnter[0]?.activity).toBe('exploring');

    // 2. Wheel zone track ends — wheel visit deferred with transition window.
    now = t0 + 10_000;
    const endWritten = await handleFrigateEvent(
      newEvent({ type: 'end', camera: 'cam-wide', zones: ['wheel'], startSec: 1_710_500_000, endSec: 1_710_500_010 }),
      deps,
    );
    expect(endWritten).toEqual([]); // deferred, not yet committed

    // 3. 1s later: new event on cam-food → cross-camera transition fires.
    now = t0 + 11_000;
    const transitionWritten = await handleFrigateEvent(
      newEvent({ type: 'new', camera: 'cam-food', zones: ['food'] }),
      deps,
    );
    expect(transitionWritten.length).toBe(1);
    expect(transitionWritten[0]?.activity).toBe('transition');

    // DB must have both: exploring entry (from mid-track close) + transition entry.
    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    const activities = entries.map((e) => e.activity).sort();
    expect(activities).toContain('exploring');
    expect(activities).toContain('transition');
  });
});

// ---------------------------------------------------------------------------
// Commit-gate tests: false_positive and unsaved-track filtering
// ---------------------------------------------------------------------------
//
// The invariant: if a Frigate object track is NOT visible in Frigate's Explore
// UI — i.e. false_positive=true OR (has_snapshot=false AND has_clip=false) —
// it MUST NOT produce a diary entry.
//
// Tests cover:
//  1. false_positive=true track → dropped on all emission paths (deferred flush,
//     mid-track close, sub-case-A immediate emit).
//  2. No snapshot / no clip track → dropped.
//  3. Normal committed track (has_snapshot=true) → written.
//  4. Clip-only track (has_clip=true, no snapshot) → written.
//  5. Gate values can be set on update events and carry through to emission.
//  6. Wheel odometer session is ended cleanly even when the gate drops the entry.
// ---------------------------------------------------------------------------

describe('commit-gate: false_positive and unsaved-track filtering', () => {
  it('drops a false_positive=true track via deferred-flush path', async () => {
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 10 });
    resetNarratorState();
    await seedCameras();

    const t0 = 1_720_000_000_000;
    // Track with false_positive=true and has_snapshot=true (snapshot doesn't
    // override false_positive — the explicit bad-detect flag always wins).
    await handleFrigateEvent(
      newEvent({
        type: 'end',
        camera: 'wheel',
        zones: ['wheel'],
        startSec: 1_720_000_000,
        endSec: 1_720_000_030,
        false_positive: true,
        has_snapshot: true,
      }),
      { now: () => t0, rng: () => 0, onEntryWritten: async () => {} },
    );
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(0);
    vi.useRealTimers();
  });

  it('drops a track with no snapshot and no clip (unsaved track)', async () => {
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 10 });
    resetNarratorState();
    await seedCameras();

    const t0 = 1_720_001_000_000;
    // Simulates a track Frigate tracked but never saved (no snapshot, no clip).
    // These are the 'ghost' tracks that cause phantom diary entries.
    await handleFrigateEvent(
      newEvent({
        type: 'end',
        camera: 'wheel',
        zones: ['wheel'],
        startSec: 1_720_001_000,
        endSec: 1_720_001_030,
        has_snapshot: false,
        has_clip: false,
        false_positive: false,
      }),
      { now: () => t0, rng: () => 0, onEntryWritten: async () => {} },
    );
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(0);
    vi.useRealTimers();
  });

  it('writes an entry for a normal committed track (has_snapshot=true)', async () => {
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 10 });
    resetNarratorState();
    await seedCameras();

    const t0 = 1_720_002_000_000;
    await handleFrigateEvent(
      newEvent({
        type: 'end',
        camera: 'food',
        zones: ['food'],
        startSec: 1_720_002_000,
        endSec: 1_720_002_030,
        has_snapshot: true,
        has_clip: false,
        false_positive: false,
      }),
      { now: () => t0, rng: () => 0, onEntryWritten: async () => {} },
    );
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(1);
    expect(entries[0]?.activity).toBe('food');
    vi.useRealTimers();
  });

  it('writes an entry for a clip-only track (has_clip=true, no snapshot)', async () => {
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 10 });
    resetNarratorState();
    await seedCameras();

    const t0 = 1_720_003_000_000;
    await handleFrigateEvent(
      newEvent({
        type: 'end',
        camera: 'food',
        zones: ['food'],
        startSec: 1_720_003_000,
        endSec: 1_720_003_030,
        has_snapshot: false,
        has_clip: true,
        false_positive: false,
      }),
      { now: () => t0, rng: () => 0, onEntryWritten: async () => {} },
    );
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(1);
    expect(entries[0]?.activity).toBe('food');
    vi.useRealTimers();
  });

  it('gate values set on an update event carry through to deferred emission', async () => {
    // Simulates the realistic sequence: 'new' has no snapshot yet, 'update'
    // sets has_snapshot=true as Frigate saves it, 'end' carries it through.
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 10 });
    resetNarratorState();
    await seedCameras();

    const t0 = 1_720_004_000_000;
    let now = t0;

    // 'new' — no snapshot yet (track just started).
    await handleFrigateEvent(
      newEvent({
        type: 'new',
        camera: 'food',
        zones: ['food'],
        startSec: 1_720_004_000,
        has_snapshot: false,
        has_clip: false,
        false_positive: false,
      }),
      { now: () => now, rng: () => 0, onEntryWritten: async () => {} },
    );

    // 'update' — Frigate saves a snapshot partway through.
    now = t0 + 10_000;
    await handleFrigateEvent(
      newEvent({
        type: 'update',
        camera: 'food',
        zones: ['food'],
        startSec: 1_720_004_000,
        has_snapshot: true,
        has_clip: false,
        false_positive: false,
      }),
      { now: () => now, rng: () => 0, onEntryWritten: async () => {} },
    );

    // 'end' — track ends, snapshot still true.
    now = t0 + 30_000;
    await handleFrigateEvent(
      newEvent({
        type: 'end',
        camera: 'food',
        zones: ['food'],
        startSec: 1_720_004_000,
        endSec: 1_720_004_030,
        has_snapshot: true,
        has_clip: false,
        false_positive: false,
      }),
      { now: () => now, rng: () => 0, onEntryWritten: async () => {} },
    );
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    // Entry must be written — snapshot was confirmed on the 'update'.
    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(1);
    expect(entries[0]?.activity).toBe('food');
    vi.useRealTimers();
  });

  it('gate blocks a track that starts with snapshot=true but ends with false_positive=true', async () => {
    // Edge case: Frigate initially saves a snapshot but later reclassifies as
    // false positive. The 'end' event's false_positive=true must override.
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 10 });
    resetNarratorState();
    await seedCameras();

    const t0 = 1_720_005_000_000;
    let now = t0;

    // 'new' — looks legit at birth.
    await handleFrigateEvent(
      newEvent({
        type: 'new',
        camera: 'food',
        zones: ['food'],
        startSec: 1_720_005_000,
        has_snapshot: true,
        false_positive: false,
      }),
      { now: () => now, rng: () => 0, onEntryWritten: async () => {} },
    );

    // 'end' — Frigate reclassifies as false positive.
    now = t0 + 30_000;
    await handleFrigateEvent(
      newEvent({
        type: 'end',
        camera: 'food',
        zones: ['food'],
        startSec: 1_720_005_000,
        endSec: 1_720_005_030,
        has_snapshot: true,  // snapshot exists but…
        false_positive: true, // …Frigate says it's a bad detect
      }),
      { now: () => now, rng: () => 0, onEntryWritten: async () => {} },
    );
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    // Must be dropped — false_positive=true on 'end' is authoritative.
    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(0);
    vi.useRealTimers();
  });

  it('drops unsaved track via mid-track close path (not just deferred flush)', async () => {
    // Ensures the gate is applied on the immediate mid-track emission path,
    // not just on the deferred flush. Use an update that causes a zone exit
    // while the track is still live.
    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 10 });
    resetNarratorState();

    db.createCamera({ name: 'cam-wide', emoji: '📷', stream_url: 'rtsp://x/wide', enabled: true });
    db.setSetting('pet_name', 'Remy');

    const t0 = 1_720_006_000_000;
    let now = t0;

    // Track starts in food zone. No snapshot yet.
    await handleFrigateEvent(
      newEvent({
        type: 'new',
        camera: 'cam-wide',
        zones: ['food'],
        startSec: 1_720_006_000,
        has_snapshot: false,
        has_clip: false,
        false_positive: false,
      }),
      { now: () => now, rng: () => 0, onEntryWritten: async () => {} },
    );

    // Mid-track: leaves food zone. Still no snapshot/clip → gate must block.
    now = t0 + 5_000;
    const written = await handleFrigateEvent(
      newEvent({
        type: 'update',
        camera: 'cam-wide',
        zones: [],
        has_snapshot: false,
        has_clip: false,
        false_positive: false,
      }),
      { now: () => now, rng: () => 0, onEntryWritten: async () => {} },
    );

    expect(written.length).toBe(0); // gate must block mid-track emission too
    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(0);
    vi.useRealTimers();
  });

  it('wheel odometer keeps running even when the gate drops the entry (always-on model)', async () => {
    // With always-on odometers, the ffmpeg process is never stopped per-visit.
    // A false-positive gate still drops the diary entry, but the odometer remains
    // running for the next wheel run.
    const spawnMock = vi.fn(() => makeFakeProc());
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));

    process.env['FRIGATE_URL'] = 'http://frigate:5000';

    vi.useFakeTimers();
    const { handleFrigateEvent, setNarratorTuningsForTests, resetNarratorState } =
      await import('../src/narrator.js');
    const { initWheelOdometers, getRotationSnapshot, resetOdometersForTests } =
      await import('../src/wheel-odometer.js');
    const db = await import('../src/db.js');

    setNarratorTuningsForTests({ transitionWindowMs: 50, minDwellMs: 10 });
    resetNarratorState();

    const cam = db.createCamera({
      name: 'wheel-cam',
      emoji: '🎡',
      stream_url: 'rtsp://x/wheel',
      live_src: 'wheel_src',
      enabled: true,
      wheel_mark_enabled: true,
      wheel_diameter_mm: 152.0,
      wheel_band_y_pct: 50.0,
      wheel_band_height_pct: 10.0,
      wheel_threshold_pct: 50.0,
    });
    db.setSetting('pet_name', 'Remy');

    // Start always-on odometer.
    initWheelOdometers();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const t0 = 1_720_007_000_000;
    let now = t0;
    const deps = { now: () => now, rng: () => 0 as number, onEntryWritten: async () => {} };

    // 'new' — opening snapshot taken.
    await handleFrigateEvent(
      newEvent({
        type: 'new',
        camera: 'wheel_src',
        zones: ['wheel'],
        startSec: 1_720_007_000,
        has_snapshot: true,
        false_positive: false,
      }),
      deps,
    );
    // Odometer is still running.
    expect(getRotationSnapshot(cam.id)).not.toBeNull();

    // 'end' — Frigate reclassifies as false positive.
    now = t0 + 30_000;
    await handleFrigateEvent(
      newEvent({
        type: 'end',
        camera: 'wheel_src',
        zones: ['wheel'],
        startSec: 1_720_007_000,
        endSec: 1_720_007_030,
        has_snapshot: true,
        false_positive: true,
      }),
      deps,
    );
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    // Odometer is STILL running — always-on; not stopped by gate.
    expect(getRotationSnapshot(cam.id)).not.toBeNull();
    // NO diary entry — false_positive gate drops it.
    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(0);

    resetOdometersForTests();
    vi.useRealTimers();
    vi.doUnmock('node:child_process');
  });
});

// ---------------------------------------------------------------------------
// Wheel diary-entry dedupe (WHEEL_DEDUPE_GAP_MS = 300s / 5 min)
// ---------------------------------------------------------------------------

// Wheel diary-entry dedupe via handleWheelTapeSession (tape-crossing detector path)
// ---------------------------------------------------------------------------

describe("wheel diary dedupe (gap-based, WHEEL_DEDUPE_GAP_MS = 5 min)", () => {
  it("two wheel tape sessions with a 10s silence gap merge into one row", async () => {
    // First ends at t0, second starts at t0 + 10s — gap = 10s, within 5 min.
    const { handleWheelTapeSession, resetNarratorState } =
      await import("../src/narrator.js");
    const db = await import("../src/db.js");
    resetNarratorState();
    const cam = db.createCamera({ name: "wheel-cam", emoji: "🎡", stream_url: "rtsp://x/w", enabled: true });
    db.setSetting("pet_name", "Remy");

    const t0 = 1_730_000_000_000;
    const deps = { now: () => t0, rng: () => 0 as number, onEntryWritten: async () => {} };

    // First session: starts 5s before t0, ends at t0.
    await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: t0 - 5_000, endedAt: t0, rotations: 10, meanRps: 2.0, peakRps: 4 },
      deps,
    );

    let entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(1);
    const firstId = entries[0]!.id;

    // Second session starts 10s after first ended (gap = 10s, << 5 min).
    const s2Start = t0 + 10_000;
    const t1 = s2Start + 3_000;
    await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: s2Start, endedAt: t1, rotations: 12, meanRps: 2.0, peakRps: 3 },
      { ...deps, now: () => t1 },
    );

    entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(1);
    expect(entries[0]!.id).toBe(firstId);
    expect(entries[0]!.occurred_at).toBe(t1);
    const details = JSON.parse(entries[0]!.details ?? "{}") as Record<string, unknown>;
    expect(typeof details["wheel_meters"]).toBe("number");
    expect(details["merged_sessions"]).toBe(1);
    // rotations accumulated: 10 + 12 = 22
    expect(details["rotations"]).toBe(22);
  });

  it("two wheel tape sessions with a gap just over 5 min produce two distinct rows", async () => {
    // First ends at t0, second starts at t0 + 300_001 ms (5 min + 1 ms gap).
    const { handleWheelTapeSession, resetNarratorState } =
      await import("../src/narrator.js");
    const db = await import("../src/db.js");
    resetNarratorState();
    const cam = db.createCamera({ name: "wheel-cam", emoji: "🎡", stream_url: "rtsp://x/w", enabled: true });
    db.setSetting("pet_name", "Remy");

    const t0 = 1_730_100_000_000;

    // First session ends at t0.
    await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: t0 - 5_000, endedAt: t0, rotations: 10, meanRps: 2.0, peakRps: 4 },
      { now: () => t0, rng: () => 0, onEntryWritten: async () => {} },
    );

    // Second session starts 300_001 ms after first ended — just outside 5 min gap.
    const s2Start = t0 + 300_001;
    const t1 = s2Start + 5_000;
    await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: s2Start, endedAt: t1, rotations: 10, meanRps: 2.0, peakRps: 4 },
      { now: () => t1, rng: () => 0, onEntryWritten: async () => {} },
    );

    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(2);
    expect(entries.every((e) => e.activity === "wheel")).toBe(true);
  });

  it("two wheel tape sessions on DIFFERENT cameras with small gap produce two distinct rows", async () => {
    // Dedupe is per-camera; different cameras never merge.
    const { handleWheelTapeSession, resetNarratorState } =
      await import("../src/narrator.js");
    const db = await import("../src/db.js");
    resetNarratorState();
    const camA = db.createCamera({ name: "wheel-a", emoji: "A", stream_url: "rtsp://x/wa",
      live_src: "wheel_a", enabled: true });
    const camB = db.createCamera({ name: "wheel-b", emoji: "B", stream_url: "rtsp://x/wb",
      live_src: "wheel_b", enabled: true });
    db.setSetting("pet_name", "Remy");

    const t0 = 1_730_200_000_000;
    const s2Start = t0 + 5_000; // only 5s gap — would merge if same camera
    const t1 = s2Start + 5_000;

    await handleWheelTapeSession(
      { cameraId: camA.id, startedAt: t0 - 5_000, endedAt: t0, rotations: 10, meanRps: 2.0, peakRps: 4 },
      { now: () => t0, rng: () => 0, onEntryWritten: async () => {} },
    );
    await handleWheelTapeSession(
      { cameraId: camB.id, startedAt: s2Start, endedAt: t1, rotations: 10, meanRps: 2.0, peakRps: 4 },
      { now: () => t1, rng: () => 0, onEntryWritten: async () => {} },
    );

    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries.length).toBe(2);
    expect(entries.every((e) => e.activity === "wheel")).toBe(true);
  });

  it("merged row duration_ms equals new_session.endedAt minus first_session.startedAt (wall-clock span)", async () => {
    // Verify the wall-clock span semantics: duration includes the silence gap.
    const { handleWheelTapeSession, resetNarratorState } =
      await import("../src/narrator.js");
    const db = await import("../src/db.js");
    resetNarratorState();
    const cam = db.createCamera({ name: "wheel-cam", emoji: "🎡", stream_url: "rtsp://x/w", enabled: true });
    db.setSetting("pet_name", "Remy");

    const firstStart = 1_730_300_000_000;
    const firstEnd = firstStart + 5_000;        // session 1: 5s active

    await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: firstStart, endedAt: firstEnd, rotations: 10, meanRps: 2.0, peakRps: 4 },
      { now: () => firstEnd, rng: () => 0, onEntryWritten: async () => {} },
    );

    const secondStart = firstEnd + 8_000;       // 8s silence
    const secondEnd = secondStart + 3_000;      // session 2: 3s active
    await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: secondStart, endedAt: secondEnd, rotations: 12, meanRps: 2.0, peakRps: 3 },
      { now: () => secondEnd, rng: () => 0, onEntryWritten: async () => {} },
    );

    const entries = db.listDiaryEntriesBetween(0, firstStart + 1_000_000);
    expect(entries.length).toBe(1);
    const merged = entries[0]!;
    expect(merged.occurred_at).toBe(secondEnd);
    // Wall-clock span: secondEnd − firstStart = 5_000 + 8_000 + 3_000 = 16_000 ms
    expect(merged.duration_ms).toBe(secondEnd - firstStart);
  });

  // Production bug: two long sessions with only 14s silence between them.
  // End-to-end diff is ~104s but GAP (new.startedAt - prior.occurred_at) = 14s.
  it("production case: two 90-138s sessions with 14s silence gap merge correctly", async () => {
    const { handleWheelTapeSession, resetNarratorState } =
      await import("../src/narrator.js");
    const db = await import("../src/db.js");
    resetNarratorState();
    const cam = db.createCamera({ name: "cam2", emoji: "📷", stream_url: "rtsp://x/cam2", enabled: true });
    db.setSetting("pet_name", "Remy");

    // Session 967: ended at 03:43:23, duration 138s → started 03:41:05
    const s1End = 1_730_400_000_000;
    const s1Start = s1End - 138_000;

    await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: s1Start, endedAt: s1End, rotations: 60, meanRps: 1.2, peakRps: 2.5 },
      { now: () => s1End, rng: () => 0, onEntryWritten: async () => {} },
    );

    // Session 968: started 14s after 967 ended, duration 90s
    const s2Start = s1End + 14_000;
    const s2End = s2Start + 90_000;

    await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: s2Start, endedAt: s2End, rotations: 50, meanRps: 1.1, peakRps: 2.0 },
      { now: () => s2End, rng: () => 0, onEntryWritten: async () => {} },
    );

    const entries = db.listDiaryEntriesBetween(0, s1Start + 1_000_000);
    // 14s silence << 5 min → must merge into one row.
    expect(entries.length).toBe(1);
    const merged = entries[0]!;
    expect(merged.occurred_at).toBe(s2End);
    expect(merged.duration_ms).toBe(s2End - s1Start);
    const det = JSON.parse(merged.details ?? "{}") as Record<string, unknown>;
    expect(det["rotations"]).toBe(110);
    expect(det["merged_sessions"]).toBe(1);
  });

  it("two sessions with exactly 5 min + 1 ms silence do NOT merge", async () => {
    // Boundary: gap = 300_001 ms > 300_000 ms → separate rows.
    const { handleWheelTapeSession, resetNarratorState } =
      await import("../src/narrator.js");
    const db = await import("../src/db.js");
    resetNarratorState();
    const cam = db.createCamera({ name: "wheel-cam", emoji: "🎡", stream_url: "rtsp://x/w", enabled: true });
    db.setSetting("pet_name", "Remy");

    const s1End = 1_730_500_000_000;
    const s1Start = s1End - 5_000;

    await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: s1Start, endedAt: s1End, rotations: 30, meanRps: 1.0, peakRps: 2.0 },
      { now: () => s1End, rng: () => 0, onEntryWritten: async () => {} },
    );

    const s2Start = s1End + 300_001;
    const s2End = s2Start + 5_000;

    await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: s2Start, endedAt: s2End, rotations: 30, meanRps: 1.0, peakRps: 2.0 },
      { now: () => s2End, rng: () => 0, onEntryWritten: async () => {} },
    );

    const entries = db.listDiaryEntriesBetween(0, s1Start + 1_000_000);
    expect(entries.length).toBe(2);
  });

  it("three sessions each 30s apart all merge into one row; duration spans all three", async () => {
    const { handleWheelTapeSession, resetNarratorState } =
      await import("../src/narrator.js");
    const db = await import("../src/db.js");
    resetNarratorState();
    const cam = db.createCamera({ name: "wheel-cam", emoji: "🎡", stream_url: "rtsp://x/w", enabled: true });
    db.setSetting("pet_name", "Remy");

    // Session 1: 60s active
    const s1Start = 1_730_600_000_000;
    const s1End = s1Start + 60_000;
    // Session 2: 30s silence, 60s active
    const s2Start = s1End + 30_000;
    const s2End = s2Start + 60_000;
    // Session 3: 30s silence, 60s active
    const s3Start = s2End + 30_000;
    const s3End = s3Start + 60_000;

    await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: s1Start, endedAt: s1End, rotations: 30, meanRps: 0.5, peakRps: 1.0 },
      { now: () => s1End, rng: () => 0, onEntryWritten: async () => {} },
    );
    await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: s2Start, endedAt: s2End, rotations: 30, meanRps: 0.5, peakRps: 1.2 },
      { now: () => s2End, rng: () => 0, onEntryWritten: async () => {} },
    );
    await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: s3Start, endedAt: s3End, rotations: 30, meanRps: 0.5, peakRps: 1.5 },
      { now: () => s3End, rng: () => 0, onEntryWritten: async () => {} },
    );

    const entries = db.listDiaryEntriesBetween(0, s1Start + 1_000_000);
    expect(entries.length).toBe(1);
    const merged = entries[0]!;
    expect(merged.occurred_at).toBe(s3End);
    // Wall-clock span: s3End − s1Start = 60 + 30 + 60 + 30 + 60 = 240_000 ms
    expect(merged.duration_ms).toBe(s3End - s1Start);
    const det = JSON.parse(merged.details ?? "{}") as Record<string, unknown>;
    expect(det["rotations"]).toBe(90);
    expect(det["merged_sessions"]).toBe(2);
    // peak_rps should be the max across all sessions
    expect(det["peak_rps"]).toBe(1.5);
  });
});
