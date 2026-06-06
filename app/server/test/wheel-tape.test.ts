// app/server/test/wheel-tape.test.ts
// Unit and integration tests for the tape-crossing detector.
//
// Test surface:
//   BrightnessSignal  — Welford rolling stats, dip detection, refractory period
//   TapeSessionMachine — session lifecycle FSM
//   meanBrightness    — utility
//   Narrator integration — synthetic dip sequence → diary entry with correct wheel_meters
//
// No real ffmpeg processes are spawned; the public ffmpeg-spawn paths are
// covered by integration smoke through the always-on detector helpers.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BrightnessSignal, TapeSessionMachine, meanBrightness } from '../src/wheel-tape.js';

// ---------------------------------------------------------------------------
// meanBrightness — utility
// ---------------------------------------------------------------------------

describe('meanBrightness', () => {
  it('returns 128 for an empty buffer', () => {
    expect(meanBrightness(Buffer.alloc(0))).toBe(128);
  });

  it('returns exact value for a uniform buffer', () => {
    expect(meanBrightness(Buffer.alloc(100, 200))).toBe(200);
  });

  it('averages correctly for mixed values', () => {
    const buf = Buffer.from([0, 100, 200]);
    expect(meanBrightness(buf)).toBeCloseTo(100, 5);
  });

  it('returns 0 for an all-zero buffer', () => {
    expect(meanBrightness(Buffer.alloc(10, 0))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// BrightnessSignal — Welford rolling stats + dip detection
// ---------------------------------------------------------------------------

/**
 * Synthetic time base: start at t=0, increment by 35ms per frame
 * (≈28.5 fps — close enough to 30 fps for test purposes).
 */
const FRAME_MS = 35;

/**
 * Feed N frames of constant brightness to a BrightnessSignal, starting at
 * `startMs` and incrementing by FRAME_MS per frame. Returns the final time.
 */
function feedConstant(
  signal: BrightnessSignal,
  brightness: number,
  count: number,
  startMs: number,
): number {
  const buf = Buffer.alloc(4, brightness);
  let t = startMs;
  for (let i = 0; i < count; i += 1) {
    signal.feed(buf, t);
    t += FRAME_MS;
  }
  return t;
}

describe('BrightnessSignal — Welford rolling stats', () => {
  it('rolling mean converges to constant signal value', () => {
    const s = new BrightnessSignal(2.0);
    // Feed 200 frames of brightness 100. After convergence mean ≈ 100.
    let t = 1_000_000;
    for (let i = 0; i < 200; i += 1) {
      s.feed(Buffer.alloc(4, 100), t);
      t += FRAME_MS;
    }
    expect(s.getMean()).toBeCloseTo(100, 1);
  });

  it('rolling std is near zero for a constant signal', () => {
    const s = new BrightnessSignal(2.0);
    let t = 2_000_000;
    for (let i = 0; i < 200; i += 1) {
      s.feed(Buffer.alloc(4, 150), t);
      t += FRAME_MS;
    }
    // Std should be effectively zero for a perfectly constant signal.
    expect(s.getStd()).toBeLessThan(1);
  });

  it('rolling std is non-zero for a noisy signal', () => {
    const s = new BrightnessSignal(2.0);
    let t = 3_000_000;
    for (let i = 0; i < 200; i += 1) {
      // Alternate between 100 and 200 — std should be ~50.
      s.feed(Buffer.alloc(4, i % 2 === 0 ? 100 : 200), t);
      t += FRAME_MS;
    }
    expect(s.getStd()).toBeGreaterThan(30);
  });
});

describe('BrightnessSignal — dip detection', () => {
  it('counts one dip on a clear brightness drop below the adaptive threshold', () => {
    const s = new BrightnessSignal(2.0);
    let t = 10_000_000;

    // Warm up the Welford window with 200 frames of brightness 200.
    t = feedConstant(s, 200, 200, t);

    // After warm-up: mean ≈ 200, std ≈ 0 → threshold ≈ 200.
    // We need a single very dark frame well below any plausible threshold.
    // Use brightness 50 — way below 200 - 2*std.
    const dipBuf = Buffer.alloc(4, 50);
    const dipResult = s.feed(dipBuf, t);

    expect(dipResult).toBe(true);
    expect(s.getRecentDips(t, 5_000)).toHaveLength(1);
  });

  it('single-frame brightness spike above background does NOT trigger a dip', () => {
    const s = new BrightnessSignal(2.0);
    let t = 11_000_000;

    // Warm up with darkness baseline (brightness 50).
    t = feedConstant(s, 50, 200, t);

    // Feed a bright spike — should NOT be a dip (threshold is brightness BELOW mean).
    const spikeBuf = Buffer.alloc(4, 250);
    const spikeResult = s.feed(spikeBuf, t);

    expect(spikeResult).toBe(false);
    expect(s.getRecentDips(t, 5_000)).toHaveLength(0);
  });

  it('refractory period prevents double-counting within 150ms', () => {
    const s = new BrightnessSignal(2.0);
    let t = 12_000_000;

    // Warm up with bright baseline.
    t = feedConstant(s, 200, 200, t);

    // First dip.
    const dip1 = s.feed(Buffer.alloc(4, 50), t);
    expect(dip1).toBe(true);
    t += FRAME_MS; // 35ms later (within 150ms refractory)

    // Second dark frame immediately after — must be blocked by refractory.
    const dip2 = s.feed(Buffer.alloc(4, 50), t);
    expect(dip2).toBe(false);

    // One more 35ms later — still within 150ms refractory (35+35=70ms < 150ms).
    t += FRAME_MS;
    const dip3 = s.feed(Buffer.alloc(4, 50), t);
    expect(dip3).toBe(false);

    expect(s.getRecentDips(t, 1_000)).toHaveLength(1);
  });

  it('dip is allowed after the refractory window clears (≥150ms between dips)', () => {
    const s = new BrightnessSignal(2.0);
    let t = 13_000_000;

    t = feedConstant(s, 200, 200, t);

    // First dip.
    s.feed(Buffer.alloc(4, 50), t);
    // Advance 160ms (> 150ms refractory).
    t += 160;

    // Return to bright (so mean adapts back a bit).
    s.feed(Buffer.alloc(4, 200), t);
    t += FRAME_MS;

    // Second dip — should fire.
    const dip2 = s.feed(Buffer.alloc(4, 50), t);
    expect(dip2).toBe(true);
    expect(s.getRecentDips(t, 1_000)).toHaveLength(2);
  });

  it('slow brightness drift does not trigger spurious dips (adaptive mean tracks drift)', () => {
    // The real-world camera signal has natural noise (std ≈ 5–10 brightness units).
    // When that background noise builds up std in the rolling window, the adaptive
    // threshold is set well below the signal mean — so a slow drift that keeps
    // the signal near the rolling mean never drops below the threshold.
    //
    // Strategy: warm up with realistic noise (±8 units around 200) to build std,
    // then drift linearly from 200 → 160 over 150 frames. Since std ≈ 8 and
    // sensitivity = 2.0, threshold ≈ mean - 16. The drift keeps the current
    // sample within ~8 units of the rolling mean → no dip fires.
    const s = new BrightnessSignal(2.0);
    let t = 14_000_000;

    // Warm-up: 200 frames with alternating 192/208 (realistic camera noise, std ≈ 8).
    for (let i = 0; i < 200; i += 1) {
      const brightness = i % 2 === 0 ? 192 : 208;
      s.feed(Buffer.alloc(4, brightness), t);
      t += FRAME_MS;
    }

    const dipsBefore = s.getRecentDips(t, 60_000).length;

    // Drift: 200 → 160 over 150 frames (0.27 units/frame).
    // With std ≈ 8 and sensitivity = 2.0: threshold ≈ mean - 16.
    // Drift rate ensures sample stays within ≈8 units of mean → above threshold.
    for (let i = 0; i < 150; i += 1) {
      const brightness = Math.round(200 - i * 0.27);
      s.feed(Buffer.alloc(4, brightness), t);
      t += FRAME_MS;
    }

    // No dips should have fired during this slow drift.
    const dipsAfter = s.getRecentDips(t, 60_000).length;
    expect(dipsAfter - dipsBefore).toBe(0);
  });

  it('higher sensitivity triggers dips at smaller deviations', () => {
    // sensitivity=1.0 triggers on shallower dips than sensitivity=3.5.
    const sLow = new BrightnessSignal(1.0);
    const sHigh = new BrightnessSignal(3.5);
    let t = 15_000_000;

    // Warm up both with brightness 200, std ≈ 0.
    for (let i = 0; i < 200; i += 1) {
      sLow.feed(Buffer.alloc(4, 200), t);
      sHigh.feed(Buffer.alloc(4, 200), t);
      t += FRAME_MS;
    }

    // Feed a mild dip to brightness 190 (10 below mean). With std ≈ 0 both
    // signals have threshold ≈ 200 - sensitivity*0. With sensitivity=1 and
    // sensitivity=3.5 and std=0 the threshold is 200 for both — so neither fires.
    // Instead we need to create some variance first then dip below it.
    //
    // Re-warm with noisy signal (180–220 alternating) to build std.
    for (let i = 0; i < 100; i += 1) {
      const b = i % 2 === 0 ? 180 : 220;
      sLow.feed(Buffer.alloc(4, b), t);
      sHigh.feed(Buffer.alloc(4, b), t);
      t += FRAME_MS;
    }
    // std is now ~20. threshold_low = mean - 1.0*20 ≈ 200 - 20 = 180.
    // threshold_high = mean - 3.5*20 ≈ 200 - 70 = 130.
    // A brightness of 160 is below threshold_low (160 < 180) but above threshold_high (160 > 130).

    t += 200; // clear refractory

    const dipLow = sLow.feed(Buffer.alloc(4, 160), t);
    const dipHigh = sHigh.feed(Buffer.alloc(4, 160), t);

    expect(dipLow).toBe(true);   // sensitivity=1.0 triggers
    expect(dipHigh).toBe(false); // sensitivity=3.5 does NOT trigger
  });

  it('counts multiple dips with refractory clearance between each', () => {
    const s = new BrightnessSignal(2.0);
    let t = 16_000_000;

    t = feedConstant(s, 200, 200, t);

    // 5 dips each 200ms apart (well above 150ms refractory).
    const TARGET = 5;
    for (let i = 0; i < TARGET; i += 1) {
      s.feed(Buffer.alloc(4, 50), t);  // dip frame
      t += 200;
      s.feed(Buffer.alloc(4, 200), t); // recovery frame
      t += 35;
    }

    expect(s.getRecentDips(t, 5_000)).toHaveLength(TARGET);
  });

  it('getLiveSnapshot returns non-null samples and correct structure', () => {
    const s = new BrightnessSignal(2.0);
    let t = 17_000_000;

    t = feedConstant(s, 150, 50, t);

    const snap = s.getLiveSnapshot(t);
    expect(snap.samples.length).toBeGreaterThan(0);
    expect(snap.sampleMs).toBe(33); // Math.round(1000/30)
    expect(typeof snap.mean).toBe('number');
    expect(typeof snap.std).toBe('number');
    expect(typeof snap.threshold).toBe('number');
    expect(Array.isArray(snap.recentDips)).toBe(true);
    expect(typeof snap.rotationsLast30s).toBe('number');
    expect(typeof snap.rotationRateRps).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// TapeSessionMachine — session lifecycle FSM
// ---------------------------------------------------------------------------

describe('TapeSessionMachine — session lifecycle', () => {
  it('first dip starts a session (idle → active)', () => {
    const sessions: ReturnType<typeof makeSession>[] = [];
    const machine = new TapeSessionMachine(1, (s) => sessions.push(s));

    expect(machine.getState()).toBe('idle');
    machine.onDip(1_000_000);
    expect(machine.getState()).toBe('active');
    expect(sessions).toHaveLength(0); // session not ended yet
  });

  it('session ends after 15s of no dips (idle timeout)', async () => {
    vi.useFakeTimers();
    const sessions: ReturnType<typeof makeSession>[] = [];
    const machine = new TapeSessionMachine(1, (s) => sessions.push(s));

    const t0 = 1_000_000;
    machine.onDip(t0);
    expect(machine.getState()).toBe('active');

    // Advance 15s — idle timer should fire.
    await vi.advanceTimersByTimeAsync(15_000);

    expect(machine.getState()).toBe('idle');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.rotations).toBe(1);
    expect(sessions[0]?.startedAt).toBe(t0);
    vi.useRealTimers();
  });

  it('session accumulates multiple dips before ending', async () => {
    vi.useFakeTimers();
    const sessions: ReturnType<typeof makeSession>[] = [];
    const machine = new TapeSessionMachine(2, (s) => sessions.push(s));

    const t0 = 2_000_000;
    machine.onDip(t0);
    machine.onDip(t0 + 500);
    machine.onDip(t0 + 1_000);
    machine.onDip(t0 + 1_500);
    machine.onDip(t0 + 2_000);

    await vi.advanceTimersByTimeAsync(15_000);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.rotations).toBe(5);
    vi.useRealTimers();
  });

  it('each new dip resets the idle timer so session extends', async () => {
    vi.useFakeTimers();
    const sessions: ReturnType<typeof makeSession>[] = [];
    const machine = new TapeSessionMachine(1, (s) => sessions.push(s));

    const t0 = 3_000_000;
    machine.onDip(t0);

    // Dip at 14s (one second before the 15s timeout would fire).
    await vi.advanceTimersByTimeAsync(14_000);
    machine.onDip(t0 + 14_000);
    expect(machine.getState()).toBe('active'); // timer was reset

    // Now advance another 15s — session ends.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(machine.getState()).toBe('idle');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.rotations).toBe(2);
    vi.useRealTimers();
  });

  it('forceEnd emits a session immediately', () => {
    const sessions: ReturnType<typeof makeSession>[] = [];
    const machine = new TapeSessionMachine(1, (s) => sessions.push(s));

    const t0 = 4_000_000;
    machine.onDip(t0);
    machine.onDip(t0 + 300);
    machine.onDip(t0 + 600);

    machine.forceEnd(t0 + 600);
    expect(machine.getState()).toBe('idle');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.rotations).toBe(3);
  });

  it('forceEnd on idle session is a no-op (no spurious empty session emitted)', () => {
    const sessions: ReturnType<typeof makeSession>[] = [];
    const machine = new TapeSessionMachine(1, (s) => sessions.push(s));
    machine.forceEnd(5_000_000);
    expect(sessions).toHaveLength(0);
  });

  it('session payload has correct startedAt, endedAt, meanRps, peakRps', async () => {
    vi.useFakeTimers();
    const sessions: ReturnType<typeof makeSession>[] = [];
    const machine = new TapeSessionMachine(1, (s) => sessions.push(s));

    const t0 = 6_000_000;
    // 4 dips spread over ~3s: [t0, t0+1000, t0+2000, t0+3000]
    machine.onDip(t0);
    machine.onDip(t0 + 1_000);
    machine.onDip(t0 + 2_000);
    machine.onDip(t0 + 3_000);

    await vi.advanceTimersByTimeAsync(15_000);

    const s = sessions[0];
    expect(s).toBeDefined();
    expect(s?.startedAt).toBe(t0);
    expect(s?.rotations).toBe(4);
    // meanRps: 4 rotations over (endedAt - t0) seconds.
    // endedAt ≈ t0 + 3000 + 15000 = t0 + 18000.
    expect(s?.meanRps).toBeGreaterThan(0);
    expect(s?.peakRps).toBeGreaterThan(0);
    // Peak in any 1s window: all 4 dips are in different seconds → peakRps ≥ 1.
    expect(s?.peakRps).toBeGreaterThanOrEqual(1);
    vi.useRealTimers();
  });

  it('multiple dips in the same second produce correct peakRps', async () => {
    vi.useFakeTimers();
    const sessions: ReturnType<typeof makeSession>[] = [];
    const machine = new TapeSessionMachine(1, (s) => sessions.push(s));

    const t0 = 7_000_000_000; // use a timestamp at a second boundary
    // 3 dips within the same 1-second window.
    machine.onDip(t0);
    machine.onDip(t0 + 200);
    machine.onDip(t0 + 400);

    await vi.advanceTimersByTimeAsync(15_000);

    expect(sessions[0]?.peakRps).toBe(3);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Narrator integration: synthetic dip sequence → diary entry
// ---------------------------------------------------------------------------

let workdir: string;
const baseEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  workdir = mkdtempSync(join(tmpdir(), 'hamster-tape-'));
  Object.assign(process.env, baseEnv);
  process.env['DATABASE_PATH'] = join(workdir, 'hamster.db');
  process.env['STORAGE_PATH'] = workdir;
  process.env['ZYPHR_API_KEY'] = 'zy_test_dummy';
  process.env['ZYPHR_APP_SECRET'] = 'zy_test_dummy_secret';
  process.env['FRIGATE_URL'] = 'http://frigate:5000';
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(workdir, { recursive: true, force: true });
  const resetConfig = () => import('../src/config.js').then((m) => m.resetConfigForTests());
  const resetDb = () => import('../src/db.js').then((m) => m.resetDbForTests());
  void Promise.all([resetConfig(), resetDb()]);
});

describe('narrator integration — tape session → diary entry', () => {
  it('handleWheelTapeSession writes a diary entry with correct wheel_meters', async () => {
    const { handleWheelTapeSession, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    resetNarratorState();

    // circumference_cm = 20cm → 10 rotations × 20/100 = 2.0m
    const cam = db.createCamera({
      name: 'tape-cam',
      emoji: '🎡',
      stream_url: 'rtsp://x/w',
      enabled: true,
      wheel_tape_circumference_cm: 20.0,
    });
    db.setSetting('pet_name', 'Remy');

    const t0 = 1_800_000_000_000;
    const session = {
      cameraId: cam.id,
      startedAt: t0,
      endedAt: t0 + 10_000,
      rotations: 10,
      meanRps: 1.0,
      peakRps: 2.0,
    };

    const entry = await handleWheelTapeSession(session, {
      now: () => t0 + 10_000,
      rng: () => 0,
      onEntryWritten: async () => {},
    });

    expect(entry).not.toBeNull();
    expect(entry?.activity).toBe('wheel');
    expect(entry?.duration_ms).toBe(10_000);

    const details = JSON.parse(entry?.details ?? '{}') as Record<string, unknown>;
    expect(details['wheel_meters']).toBeCloseTo(2.0, 5);
    expect(details['rotations']).toBe(10);
    expect(details['mean_rps']).toBe(1.0);
    expect(details['peak_rps']).toBe(2.0);
    expect(typeof details['camera']).toBe('string');
  });

  it('dedupe: two sessions within WHEEL_DEDUPE_WINDOW_MS merge with summed rotations', async () => {
    const { handleWheelTapeSession, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    resetNarratorState();

    const cam = db.createCamera({
      name: 'tape-cam',
      emoji: '🎡',
      stream_url: 'rtsp://x/w',
      enabled: true,
      wheel_tape_circumference_cm: 13.0,
    });
    db.setSetting('pet_name', 'Remy');

    const t0 = 1_800_100_000_000;
    const first = await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: t0, endedAt: t0 + 5_000, rotations: 8, meanRps: 1.6, peakRps: 3 },
      { now: () => t0 + 5_000, rng: () => 0, onEntryWritten: async () => {} },
    );
    expect(first).not.toBeNull();

    // 12s later — within the 20s dedupe window.
    const t1 = t0 + 12_000;
    const merged = await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: t1, endedAt: t1 + 5_000, rotations: 7, meanRps: 1.4, peakRps: 2 },
      { now: () => t1 + 5_000, rng: () => 0, onEntryWritten: async () => {} },
    );

    expect(merged?.id).toBe(first?.id);

    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries).toHaveLength(1);
    const det = JSON.parse(entries[0]!.details ?? '{}') as Record<string, unknown>;
    // (8 + 7) rotations × 13cm / 100 = 1.95m
    expect((det['wheel_meters'] as number)).toBeCloseTo(1.95, 4);
    expect(det['rotations']).toBe(15);
    expect(det['merged_sessions']).toBe(1);
    // peak_rps should be the max of 3 and 2.
    expect(det['peak_rps']).toBe(3);
  });

  it('zero-duration session is rejected (returns null)', async () => {
    const { handleWheelTapeSession, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    resetNarratorState();

    const cam = db.createCamera({
      name: 'tape-cam', emoji: '🎡', stream_url: 'rtsp://x/w', enabled: true,
    });

    const t0 = 1_800_200_000_000;
    const entry = await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: t0, endedAt: t0, rotations: 5, meanRps: 1.0, peakRps: 2 },
      { now: () => t0, rng: () => 0, onEntryWritten: async () => {} },
    );

    expect(entry).toBeNull();
  });

  it('uses default circumference (13cm) when column is absent / not set', async () => {
    const { handleWheelTapeSession, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    resetNarratorState();

    // Create camera without specifying circumference — defaults to 13.0.
    const cam = db.createCamera({
      name: 'tape-cam', emoji: '🎡', stream_url: 'rtsp://x/w', enabled: true,
    });
    db.setSetting('pet_name', 'Remy');

    const t0 = 1_800_300_000_000;
    const entry = await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: t0, endedAt: t0 + 10_000, rotations: 10, meanRps: 1.0, peakRps: 2 },
      { now: () => t0 + 10_000, rng: () => 0, onEntryWritten: async () => {} },
    );

    const details = JSON.parse(entry?.details ?? '{}') as Record<string, unknown>;
    // 10 × 13 / 100 = 1.3m
    expect((details['wheel_meters'] as number)).toBeCloseTo(1.3, 5);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SessionType = Parameters<ConstructorParameters<typeof TapeSessionMachine>[1]>[0];
function makeSession(s: SessionType): SessionType {
  return s;
}
