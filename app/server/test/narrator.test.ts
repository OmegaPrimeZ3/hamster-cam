// Unit tests for narrator.ts — transition coalescing, dwell threshold,
// recent-event ring buffer, manual snapshot path, and multi-camera dedup.

import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
