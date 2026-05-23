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
    setNarratorTuningsForTests({ transitionWindowMs: 8000, minDwellMs: 2000 });
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
    setNarratorTuningsForTests({ transitionWindowMs: 8000, minDwellMs: 2000 });
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
});
