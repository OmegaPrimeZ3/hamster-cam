// Unit tests for narrator.ts — transition coalescing, dwell threshold,
// recent-event ring buffer, manual snapshot path.

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
