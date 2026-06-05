// Unit tests for wheel-odometer.ts:
//   - PgmParser: stream parsing and dark-pixel-ratio computation
//   - RotationCounter: edge-detection FSM with refractory period
//   - Session lifecycle: start→end returns metres; double-start idempotent;
//     end-without-start returns null; ffmpeg crash mid-session is logged and
//     returns the partial count.
//
// No real ffmpeg runs — child_process.spawn is mocked per-test via vi.doMock.

import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// PgmParser — pure unit tests, no DB or process mocking needed.
// ---------------------------------------------------------------------------

describe('PgmParser', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // threshold=50 → cutoff = 255 * 0.5 = 127.5
  // pixels below 127.5 are "dark".

  it('parses a complete PGM frame and reports dark-pixel ratio', async () => {
    const { PgmParser } = await import('../src/wheel-odometer.js');
    const ratios: number[] = [];
    // threshold=50, cutoff=127.5. Pixels [100,100,100,100] all < 127.5 → ratio=1.0.
    const parser = new PgmParser((ratio) => ratios.push(ratio), 50);

    const header = Buffer.from('P5\n2 2\n255\n', 'ascii');
    const pixels = Buffer.from([100, 100, 100, 100]);
    parser.feed(Buffer.concat([header, pixels]));

    expect(ratios).toHaveLength(1);
    expect(ratios[0]).toBeCloseTo(1.0, 5);
  });

  it('reports partial dark-pixel ratio when only some pixels are dark', async () => {
    const { PgmParser } = await import('../src/wheel-odometer.js');
    const ratios: number[] = [];
    // threshold=50, cutoff=127.5.
    // 2 dark pixels (50 < 127.5) + 2 light pixels (200 >= 127.5) → ratio=0.5.
    const parser = new PgmParser((ratio) => ratios.push(ratio), 50);

    const header = Buffer.from('P5\n2 2\n255\n', 'ascii');
    const pixels = Buffer.from([50, 50, 200, 200]);
    parser.feed(Buffer.concat([header, pixels]));

    expect(ratios).toHaveLength(1);
    expect(ratios[0]).toBeCloseTo(0.5, 5);
  });

  it('reports ratio=0 when all pixels are light', async () => {
    const { PgmParser } = await import('../src/wheel-odometer.js');
    const ratios: number[] = [];
    // threshold=50, cutoff=127.5. Pixels [200,200,200,200] all >= 127.5 → ratio=0.
    const parser = new PgmParser((ratio) => ratios.push(ratio), 50);

    const header = Buffer.from('P5\n2 2\n255\n', 'ascii');
    const pixels = Buffer.from([200, 200, 200, 200]);
    parser.feed(Buffer.concat([header, pixels]));

    expect(ratios).toHaveLength(1);
    expect(ratios[0]).toBeCloseTo(0.0, 5);
  });

  it('handles a frame split across two chunks', async () => {
    const { PgmParser } = await import('../src/wheel-odometer.js');
    const ratios: number[] = [];
    // threshold=50, cutoff=127.5. Pixels [200,200,200,200] all light → ratio=0.
    const parser = new PgmParser((ratio) => ratios.push(ratio), 50);

    const header = Buffer.from('P5\n2 2\n255\n', 'ascii');
    const pixels = Buffer.from([200, 200, 200, 200]);
    const full = Buffer.concat([header, pixels]);

    parser.feed(full.slice(0, 7));
    parser.feed(full.slice(7));

    expect(ratios).toHaveLength(1);
    expect(ratios[0]).toBeCloseTo(0.0, 5);
  });

  it('parses two back-to-back frames from a single feed', async () => {
    const { PgmParser } = await import('../src/wheel-odometer.js');
    const ratios: number[] = [];
    // threshold=50, cutoff=127.5.
    // Frame 1: pixel 50 < 127.5 → ratio=1.0 (dark).
    // Frame 2: pixel 220 >= 127.5 → ratio=0.0 (light).
    const parser = new PgmParser((ratio) => ratios.push(ratio), 50);

    const makeFrame = (pixelValue: number): Buffer => {
      const header = Buffer.from('P5\n1 1\n255\n', 'ascii');
      return Buffer.concat([header, Buffer.from([pixelValue])]);
    };

    parser.feed(Buffer.concat([makeFrame(50), makeFrame(220)]));
    expect(ratios).toHaveLength(2);
    expect(ratios[0]).toBeCloseTo(1.0, 5); // dark frame
    expect(ratios[1]).toBeCloseTo(0.0, 5); // light frame
  });

  it('ignores corrupt headers gracefully', async () => {
    const { PgmParser } = await import('../src/wheel-odometer.js');
    const ratios: number[] = [];
    const parser = new PgmParser((ratio) => ratios.push(ratio), 50);

    // P6 is colour PGM — our parser only handles P5. Should not throw.
    const badHeader = Buffer.from('P6\n2 2\n255\n', 'ascii');
    const pixels = Buffer.from([1, 2, 3, 4]);
    expect(() => parser.feed(Buffer.concat([badHeader, pixels]))).not.toThrow();
    expect(ratios).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// RotationCounter — edge-detection FSM with refractory period.
// ---------------------------------------------------------------------------
//
// Constructor accepts an explicit fps so we can control the refractory timing
// without running 30 real frames per transition. We pass fps=30 (the real
// value) and space our pulses far enough apart to clear the 150 ms / 4.5-frame
// refractory window. Each group of frames in the tests below is separated by
// enough frames to guarantee clearance.

describe('RotationCounter', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // threshold=50 → frame is 'dark' when ratio * 100 >= 50, i.e. ratio >= 0.5.
  const LIGHT_RATIO = 0.0;
  const DARK_RATIO = 1.0;

  // At 30 fps, REFRACTORY_MS=150 → refractory = 4.5 frames.
  // We use 6 light frames between rotations to guarantee clearance.
  const CLEAR = 6; // frames of light to clear the refractory window

  it('counts one rotation on a minimal DARK → LIGHT transition (1 dark frame)', async () => {
    // This is THE regression test: a single dark frame followed by light MUST
    // count, because real fast passes at 30fps are 1-3 frames wide.
    const { RotationCounter } = await import('../src/wheel-odometer.js');
    const counter = new RotationCounter(50, 30);

    // Start in light.
    counter.feed(LIGHT_RATIO);
    expect(counter.getRotations()).toBe(0);

    // One dark frame (falling edge confirmed).
    counter.feed(DARK_RATIO);
    expect(counter.getRotations()).toBe(0); // not yet — need the rising edge

    // Back to light — rising edge: 1 rotation counted.
    counter.feed(LIGHT_RATIO);
    expect(counter.getRotations()).toBe(1);
  });

  it('counts one rotation on a 2-frame dark pulse', async () => {
    const { RotationCounter } = await import('../src/wheel-odometer.js');
    const counter = new RotationCounter(50, 30);

    counter.feed(LIGHT_RATIO);
    counter.feed(DARK_RATIO);
    counter.feed(DARK_RATIO);
    counter.feed(LIGHT_RATIO);

    expect(counter.getRotations()).toBe(1);
  });

  it('counts one rotation on a longer sustained dark pulse', async () => {
    const { RotationCounter } = await import('../src/wheel-odometer.js');
    const counter = new RotationCounter(50, 30);

    counter.feed(LIGHT_RATIO);
    for (let i = 0; i < 10; i += 1) counter.feed(DARK_RATIO);
    counter.feed(LIGHT_RATIO);

    expect(counter.getRotations()).toBe(1);
  });

  it('marker parked in the box for many frames counts exactly once', async () => {
    // If the wheel stops with the marker inside the box, only one rotation
    // should count — on the first exit from dark to light.
    const { RotationCounter } = await import('../src/wheel-odometer.js');
    const counter = new RotationCounter(50, 30);

    counter.feed(LIGHT_RATIO);
    // Marker parked: 30 dark frames (1 second at 30 fps).
    for (let i = 0; i < 30; i += 1) counter.feed(DARK_RATIO);
    // Wheel starts moving — marker exits.
    counter.feed(LIGHT_RATIO);

    expect(counter.getRotations()).toBe(1);
  });

  it('refractory period: flicker inside refractory window does NOT add a spurious count', async () => {
    // After one rotation is counted, a lone dark frame within REFRACTORY_MS
    // must not increment the counter.
    const { RotationCounter } = await import('../src/wheel-odometer.js');
    const counter = new RotationCounter(50, 30);

    // First rotation.
    counter.feed(LIGHT_RATIO);
    counter.feed(DARK_RATIO);
    counter.feed(LIGHT_RATIO);
    expect(counter.getRotations()).toBe(1);

    // Immediately after (still within ~150ms / 4.5 frames): a lone dark flicker.
    // Feed 2 more light frames then 1 dark + 1 light — total elapsed < 4.5 frames.
    counter.feed(LIGHT_RATIO);
    counter.feed(DARK_RATIO); // frame index 4 — only 1 frame since last count at frame 2
    counter.feed(LIGHT_RATIO);

    // Must still be 1 — refractory block.
    expect(counter.getRotations()).toBe(1);
  });

  it('counts a second rotation after the refractory window has cleared', async () => {
    const { RotationCounter } = await import('../src/wheel-odometer.js');
    const counter = new RotationCounter(50, 30);

    // First rotation.
    counter.feed(LIGHT_RATIO);
    counter.feed(DARK_RATIO);
    counter.feed(LIGHT_RATIO);
    expect(counter.getRotations()).toBe(1);

    // Clear the refractory window with CLEAR (6) light frames.
    for (let i = 0; i < CLEAR; i += 1) counter.feed(LIGHT_RATIO);

    // Second rotation.
    counter.feed(DARK_RATIO);
    counter.feed(LIGHT_RATIO);
    expect(counter.getRotations()).toBe(2);
  });

  it('counts multiple rapid rotations with refractory clearance between each', async () => {
    // THE FAST-SPIN regression: a sequence of brief 1-2-frame dark pulses that
    // simulate 20-30 real passes per 30-second window must all be counted.
    const { RotationCounter } = await import('../src/wheel-odometer.js');
    const counter = new RotationCounter(50, 30);

    const TARGET_ROTATIONS = 10;
    // Each rotation: 1 light (start) + 1 dark + CLEAR light frames.
    // Total inter-rotation gap = 1 + CLEAR = 7 frames = 233 ms >> 150 ms refractory.
    for (let r = 0; r < TARGET_ROTATIONS; r += 1) {
      counter.feed(LIGHT_RATIO); // ensure we are in light state
      counter.feed(DARK_RATIO);  // 1-frame dark pulse
      counter.feed(LIGHT_RATIO); // rising edge — rotation counted
      for (let g = 0; g < CLEAR - 1; g += 1) counter.feed(LIGHT_RATIO); // clear refractory
    }

    expect(counter.getRotations()).toBe(TARGET_ROTATIONS);
  });

  it('threshold boundary: ratio exactly at thresholdPct/100 is dark', async () => {
    const { RotationCounter } = await import('../src/wheel-odometer.js');
    // threshold=50 → ratio >= 0.5 is dark.
    const counter = new RotationCounter(50, 30);

    counter.feed(LIGHT_RATIO);
    // ratio=0.5 → 0.5*100=50 >= 50 → dark.
    counter.feed(0.5);
    counter.feed(LIGHT_RATIO);

    expect(counter.getRotations()).toBe(1);
  });

  it('threshold boundary: ratio just below thresholdPct/100 is light', async () => {
    const { RotationCounter } = await import('../src/wheel-odometer.js');
    // threshold=50 → ratio < 0.5 is light — FSM never enters dark state.
    const counter = new RotationCounter(50, 30);

    for (let i = 0; i < 10; i += 1) counter.feed(0.49);
    expect(counter.getRotations()).toBe(0);
  });

  it('test-tool and live-counter agree: partial dark-pixel frame above threshold is dark', async () => {
    const { RotationCounter } = await import('../src/wheel-odometer.js');
    // Simulate the real scenario: tape occupies ~50% of the ROI box.
    // threshold=40 → ratio >= 0.4 is dark.
    const counter = new RotationCounter(40, 30);

    counter.feed(0.0); // light
    counter.feed(0.5); // dark (0.5*100=50 >= 40)
    counter.feed(0.0); // light again → 1 rotation

    expect(counter.getRotations()).toBe(1);
  });

  it('distanceMeters = rotations × π × diameter_mm / 1000 (maths check)', () => {
    const rotations = 10;
    const diameterMm = 152.0;
    const metres = rotations * Math.PI * diameterMm / 1000;
    expect(metres).toBeCloseTo(4.775, 2);
  });
});

// ---------------------------------------------------------------------------
// Session lifecycle — mock child_process.spawn.
// ---------------------------------------------------------------------------

// Fake proc factory — returns an EventEmitter that looks like a ChildProcess.
function makeFakeProc(): {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  on: EventEmitter['on'];
  emit: EventEmitter['emit'];
  stdin: { write: () => void; end: () => void };
} {
  const base = new EventEmitter();
  const proc = Object.assign(base, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
    stdin: { write: (): void => {}, end: (): void => {} },
  });
  return proc;
}

let workdir: string;
const baseEnv = { ...process.env };

// The spawn mock is captured here so session-lifecycle tests can reference it.
let currentSpawnMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  workdir = mkdtempSync(join(tmpdir(), 'hamster-odometer-'));
  Object.assign(process.env, baseEnv);
  process.env['DATABASE_PATH'] = join(workdir, 'hamster.db');
  process.env['STORAGE_PATH'] = workdir;
  process.env['ZYPHR_API_KEY'] = 'zy_test_dummy';
  process.env['ZYPHR_APP_SECRET'] = 'zy_test_dummy_secret';
  // The odometer derives its RTSP source from FRIGATE_URL's host + the camera's
  // go2rtc live_src (rtsp://<host>:8554/<live_src>).
  process.env['FRIGATE_URL'] = 'http://frigate:5000';

  currentSpawnMock = vi.fn(() => makeFakeProc());
  vi.doMock('node:child_process', () => ({
    spawn: currentSpawnMock,
  }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock('node:child_process');
  const dbMod = await import('../src/db.js');
  dbMod.resetDbForTests();
  const { resetConfigForTests } = await import('../src/config.js');
  resetConfigForTests();
  rmSync(workdir, { recursive: true, force: true });
});

async function seedWheelCamera(
  enabled: boolean = true,
  extra: Partial<{
    wheel_band_x_pct: number;
    wheel_band_width_pct: number;
  }> = {},
): Promise<number> {
  const db = await import('../src/db.js');
  const cam = db.createCamera({
    name: 'wheel-cam',
    emoji: '🎡',
    stream_url: 'rtsp://fake/stream',
    live_src: 'wheel_cam',
    enabled: true,
    zones: ['wheel'],
    wheel_mark_enabled: enabled,
    wheel_diameter_mm: 152.0,
    wheel_band_x_pct: extra.wheel_band_x_pct ?? 0,
    wheel_band_width_pct: extra.wheel_band_width_pct ?? 100,
    wheel_band_y_pct: 50.0,
    wheel_band_height_pct: 10.0,
    wheel_threshold_pct: 50.0,
  });
  return cam.id;
}

// ---------------------------------------------------------------------------
// Always-on odometer lifecycle — initWheelOdometers, getRotationSnapshot,
// computeWheelDelta. No start/end session API anymore.
// ---------------------------------------------------------------------------

describe('always-on odometer: initWheelOdometers', () => {
  it('spawns one ffmpeg per wheel-enabled camera on init', async () => {
    const camId = await seedWheelCamera();
    const { initWheelOdometers, _alwaysOnOdometers, resetOdometersForTests } =
      await import('../src/wheel-odometer.js');

    initWheelOdometers();
    expect(currentSpawnMock).toHaveBeenCalledTimes(1);
    expect(_alwaysOnOdometers.size).toBe(1);
    expect(_alwaysOnOdometers.has(camId)).toBe(true);

    resetOdometersForTests();
  });

  it('is a no-op for cameras with wheel_mark_enabled = false', async () => {
    await seedWheelCamera(false);
    const { initWheelOdometers, _alwaysOnOdometers, resetOdometersForTests } =
      await import('../src/wheel-odometer.js');

    initWheelOdometers();
    expect(currentSpawnMock).not.toHaveBeenCalled();
    expect(_alwaysOnOdometers.size).toBe(0);

    resetOdometersForTests();
  });

  it('is idempotent — second init call does not spawn a second ffmpeg', async () => {
    const camId = await seedWheelCamera();
    const { initWheelOdometers, _alwaysOnOdometers, resetOdometersForTests } =
      await import('../src/wheel-odometer.js');

    initWheelOdometers();
    initWheelOdometers(); // second call

    expect(currentSpawnMock).toHaveBeenCalledTimes(1);
    expect(_alwaysOnOdometers.size).toBe(1);

    void camId;
    resetOdometersForTests();
  });

  it('ffmpeg crop filter uses full rectangle: iw*W/100:ih*H/100:iw*X/100:ih*Y/100', async () => {
    // Camera with non-default x + width so the crop string is unambiguous.
    const camId = await seedWheelCamera(true, { wheel_band_x_pct: 25, wheel_band_width_pct: 50 });
    const { initWheelOdometers, resetOdometersForTests } = await import('../src/wheel-odometer.js');

    initWheelOdometers();

    expect(currentSpawnMock).toHaveBeenCalledTimes(1);
    const args: string[] = currentSpawnMock.mock.calls[0]?.[1] ?? [];
    const vfIdx = args.indexOf('-vf');
    expect(vfIdx).toBeGreaterThanOrEqual(0);
    // bandX=25, bandW=50, bandY=50, bandH=10
    expect(args[vfIdx + 1]).toBe('crop=iw*50/100:ih*10/100:iw*25/100:ih*50/100,format=gray');

    void camId;
    resetOdometersForTests();
  });

  it('ffmpeg crop defaults to full-width when x=0 width=100', async () => {
    const camId = await seedWheelCamera();
    const { initWheelOdometers, resetOdometersForTests } = await import('../src/wheel-odometer.js');

    initWheelOdometers();

    const args: string[] = currentSpawnMock.mock.calls[0]?.[1] ?? [];
    const vfIdx = args.indexOf('-vf');
    expect(args[vfIdx + 1]).toBe('crop=iw*100/100:ih*10/100:iw*0/100:ih*50/100,format=gray');

    void camId;
    resetOdometersForTests();
  });

  it('ffmpeg -r arg is 30 (native camera fps)', async () => {
    const camId = await seedWheelCamera();
    const { initWheelOdometers, resetOdometersForTests } = await import('../src/wheel-odometer.js');

    initWheelOdometers();

    const args: string[] = currentSpawnMock.mock.calls[0]?.[1] ?? [];
    const rIdx = args.indexOf('-r');
    expect(rIdx).toBeGreaterThanOrEqual(0);
    expect(args[rIdx + 1]).toBe('30');

    void camId;
    resetOdometersForTests();
  });

  it('shutdownWheelOdometers kills all processes and clears the map', async () => {
    const camId = await seedWheelCamera();
    const { initWheelOdometers, shutdownWheelOdometers, _alwaysOnOdometers } =
      await import('../src/wheel-odometer.js');

    initWheelOdometers();
    const handle = _alwaysOnOdometers.get(camId);
    expect(handle).toBeDefined();

    shutdownWheelOdometers();
    expect(handle?.proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(_alwaysOnOdometers.size).toBe(0);
  });
});

describe('getRotationSnapshot', () => {
  it('returns null for a camera with no running odometer', async () => {
    const { getRotationSnapshot } = await import('../src/wheel-odometer.js');
    expect(getRotationSnapshot(99999)).toBeNull();
  });

  it('returns a snapshot with epoch=0 and rotations=0 when odometer just started', async () => {
    const camId = await seedWheelCamera();
    const { initWheelOdometers, getRotationSnapshot, resetOdometersForTests } =
      await import('../src/wheel-odometer.js');

    initWheelOdometers();
    const snap = getRotationSnapshot(camId);
    expect(snap).not.toBeNull();
    expect(snap?.epoch).toBe(0);
    expect(snap?.rotations).toBe(0);
    expect(typeof snap?.captureMs).toBe('number');

    resetOdometersForTests();
  });

  it('rotations increase as PGM frames are fed through the handle', async () => {
    const camId = await seedWheelCamera();
    const { initWheelOdometers, getRotationSnapshot, _alwaysOnOdometers, resetOdometersForTests } =
      await import('../src/wheel-odometer.js');

    initWheelOdometers();

    const handle = _alwaysOnOdometers.get(camId);
    expect(handle).toBeDefined();

    // Feed 1 light + 1 dark + 1 light → 1 rotation (first count, no refractory block).
    const header = Buffer.from('P5\n4 4\n255\n', 'ascii');
    const light = Buffer.alloc(16, 200);
    const dark  = Buffer.alloc(16, 50);
    handle?.proc.stdout.emit('data', Buffer.concat([header, light]));
    handle?.proc.stdout.emit('data', Buffer.concat([header, dark]));
    handle?.proc.stdout.emit('data', Buffer.concat([header, light]));

    const snap = getRotationSnapshot(camId);
    expect(snap?.rotations).toBe(1);

    resetOdometersForTests();
  });
});

describe('computeWheelDelta', () => {
  it('returns correct rotation delta when epoch matches', async () => {
    const { computeWheelDelta } = await import('../src/wheel-odometer.js');
    const start = { rotations: 5, epoch: 0, captureMs: 1000 };
    const end   = { rotations: 8, epoch: 0, captureMs: 2000 };
    const result = computeWheelDelta(start, end, 152);
    expect(result.rotations).toBe(3);
    expect(result.metres).toBeCloseTo(3 * Math.PI * 152 / 1000, 5);
    expect(result.epochCrossed).toBe(false);
  });

  it('returns post-restart count when epoch differs and sets epochCrossed=true', async () => {
    const { computeWheelDelta } = await import('../src/wheel-odometer.js');
    // Odometer restarted: epoch 0→1, end.rotations is the post-restart count.
    const start = { rotations: 50, epoch: 0, captureMs: 1000 };
    const end   = { rotations: 3,  epoch: 1, captureMs: 2000 };
    const result = computeWheelDelta(start, end, 152);
    expect(result.rotations).toBe(3); // only post-restart count
    expect(result.metres).toBeCloseTo(3 * Math.PI * 152 / 1000, 5);
    expect(result.epochCrossed).toBe(true);
  });

  it('returns 0 rotations when wheel did not move', async () => {
    const { computeWheelDelta } = await import('../src/wheel-odometer.js');
    const start = { rotations: 10, epoch: 0, captureMs: 1000 };
    const end   = { rotations: 10, epoch: 0, captureMs: 2000 };
    const result = computeWheelDelta(start, end, 152);
    expect(result.rotations).toBe(0);
    expect(result.metres).toBe(0);
    expect(result.epochCrossed).toBe(false);
  });

  it('clamps negative delta to 0 (clock skew / counter race)', async () => {
    // Should not happen in practice, but if it does we clamp to 0.
    const { computeWheelDelta } = await import('../src/wheel-odometer.js');
    const start = { rotations: 10, epoch: 0, captureMs: 1000 };
    const end   = { rotations: 8,  epoch: 0, captureMs: 2000 }; // somehow went backwards
    const result = computeWheelDelta(start, end, 152);
    expect(result.rotations).toBe(0); // Math.max(0, 8-10) = 0
    expect(result.metres).toBe(0);
    expect(result.epochCrossed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ROI box — DB round-trip tests (create / update with defaults).
// ---------------------------------------------------------------------------

describe('wheel_band_x_pct / wheel_band_width_pct DB round-trip', () => {
  it('createCamera defaults x_pct=0 and width_pct=100 when not supplied', async () => {
    const db = await import('../src/db.js');
    const cam = db.createCamera({
      name: 'default-box-cam',
      emoji: '📷',
      stream_url: '',
      enabled: true,
    });
    expect(cam.wheel_band_x_pct).toBe(0);
    expect(cam.wheel_band_width_pct).toBe(100);
  });

  it('createCamera stores explicit x_pct and width_pct values', async () => {
    const db = await import('../src/db.js');
    const cam = db.createCamera({
      name: 'roi-box-cam',
      emoji: '📷',
      stream_url: '',
      enabled: true,
      wheel_band_x_pct: 30,
      wheel_band_width_pct: 40,
    });
    expect(cam.wheel_band_x_pct).toBe(30);
    expect(cam.wheel_band_width_pct).toBe(40);
  });

  it('updateCamera preserves existing x_pct / width_pct when omitted from input', async () => {
    const db = await import('../src/db.js');
    const created = db.createCamera({
      name: 'preserve-box-cam',
      emoji: '📷',
      stream_url: '',
      enabled: true,
      wheel_band_x_pct: 15,
      wheel_band_width_pct: 60,
    });
    const updated = db.updateCamera({
      id: created.id,
      name: created.name,
      emoji: created.emoji,
      stream_url: created.stream_url,
      enabled: true,
      // wheel_band_x_pct and wheel_band_width_pct intentionally omitted.
    });
    expect(updated?.wheel_band_x_pct).toBe(15);
    expect(updated?.wheel_band_width_pct).toBe(60);
  });

  it('updateCamera applies new x_pct / width_pct values', async () => {
    const db = await import('../src/db.js');
    const created = db.createCamera({
      name: 'update-box-cam',
      emoji: '📷',
      stream_url: '',
      enabled: true,
      wheel_band_x_pct: 0,
      wheel_band_width_pct: 100,
    });
    const updated = db.updateCamera({
      id: created.id,
      name: created.name,
      emoji: created.emoji,
      stream_url: created.stream_url,
      enabled: true,
      wheel_band_x_pct: 20,
      wheel_band_width_pct: 55,
    });
    expect(updated?.wheel_band_x_pct).toBe(20);
    expect(updated?.wheel_band_width_pct).toBe(55);
  });
});

// ---------------------------------------------------------------------------
// liveWheelRotationTest — synthetic frame injection, no real ffmpeg.
// ---------------------------------------------------------------------------
//
// Strategy: mock spawn so that `rawProc.stdout` is a fake EventEmitter we
// control.  We emit synthetic PGM frames (same format as other tests) and
// then fire the 'close' event with code 0.  This exercises the full
// PgmParser → RotationCounter pipeline and the output-shape contract without
// hitting a real RTSP stream.
//
// NOTE: The RotationCounter inside liveWheelRotationTest uses SAMPLE_FPS=30.
// Each rotation cycle must include enough light frames to clear the refractory
// window (REFRACTORY_MS=150ms at 30fps ≈ 4.5 frames → use 6 light frames).

describe('liveWheelRotationTest', () => {
  // Helper: build a 1×1 PGM frame buffer for a given pixel value.
  function pgmFrame(pixelValue: number): Buffer {
    const header = Buffer.from('P5\n1 1\n255\n', 'ascii');
    return Buffer.concat([header, Buffer.from([pixelValue])]);
  }

  // CLEAR = 6 light frames between rotations to guarantee refractory clearance
  // at 30fps (6 frames = 200ms > 150ms refractory).
  const CLEAR_FRAMES = 6;

  it('returns correct rotations, distanceMeters, thresholdRatio for a synthetic sequence', async () => {
    // threshold=50 → thresholdRatio = 1 - 50/100 = 0.5
    // dark pixel = value < 127.5 (PgmParser uses 255*(1-50/100)=127.5 as cutoff)
    // RotationCounter treats frame as dark when ratio*100 >= 50, i.e. ratio >= 0.5
    //
    // We produce 2 full rotations. Each rotation = 1 light + 1 dark + CLEAR_FRAMES light.
    // First rotation: no refractory concern (lastCountedFrame = -Infinity).
    const camId = await seedWheelCamera(); // diameterMm=152, thresholdPct=50

    const { liveWheelRotationTest } = await import('../src/wheel-odometer.js');

    // Override spawn for this module-scope block.
    const fakeProc = makeFakeProc();
    currentSpawnMock.mockReturnValueOnce(fakeProc);

    // Kick off the promise (it will await the 'close' event).
    const resultPromise = liveWheelRotationTest(camId, 15);

    const lightFrame = pgmFrame(200); // 200 >= 127.5 → light (ratio = 0)
    const darkFrame  = pgmFrame(50);  // 50  <  127.5 → dark  (ratio = 1)

    // 2 rotation cycles with refractory clearance between them.
    const framesPerCycle = 1 + 1 + CLEAR_FRAMES; // 1 light + 1 dark + 6 light = 8
    for (let cycle = 0; cycle < 2; cycle += 1) {
      fakeProc.stdout.emit('data', lightFrame);
      fakeProc.stdout.emit('data', darkFrame);
      for (let i = 0; i < CLEAR_FRAMES; i += 1) fakeProc.stdout.emit('data', lightFrame);
    }

    // Signal ffmpeg done (exit 0).
    fakeProc.emit('close', 0);

    const result = await resultPromise;

    expect(result.rotations).toBe(2);
    expect(result.framesSampled).toBe(framesPerCycle * 2); // 16 frames
    expect(result.sampleFps).toBe(30);
    expect(result.thresholdRatio).toBeCloseTo(0.5, 5);
    expect(result.diameterMm).toBe(152);
    // distanceMeters = 2 × π × 152 / 1000
    expect(result.distanceMeters).toBeCloseTo(2 * Math.PI * 152 / 1000, 5);
    // ratioTrace should contain the per-frame ratios.
    expect(result.ratioTrace).toHaveLength(framesPerCycle * 2);
    // First frame is light → ratio 0.
    expect(result.ratioTrace[0]).toBeCloseTo(0, 5);
    // Second frame is dark → ratio 1.
    expect(result.ratioTrace[1]).toBeCloseTo(1, 5);
  });

  it('rejects with FfmpegError when ffmpeg exits non-zero', async () => {
    const { FfmpegError: FErr } = await import('../src/frigate.js');
    const camId = await seedWheelCamera();
    const { liveWheelRotationTest } = await import('../src/wheel-odometer.js');

    const fakeProc = makeFakeProc();
    currentSpawnMock.mockReturnValueOnce(fakeProc);

    const resultPromise = liveWheelRotationTest(camId, 5);

    // Emit some stderr then a non-zero exit.
    fakeProc.stderr.emit('data', Buffer.from('Connection refused'));
    fakeProc.emit('close', 1);

    await expect(resultPromise).rejects.toBeInstanceOf(FErr);
  });

  it('rejects with FfmpegError when spawn emits an error event', async () => {
    const { FfmpegError: FErr } = await import('../src/frigate.js');
    const camId = await seedWheelCamera();
    const { liveWheelRotationTest } = await import('../src/wheel-odometer.js');

    const fakeProc = makeFakeProc();
    currentSpawnMock.mockReturnValueOnce(fakeProc);

    const resultPromise = liveWheelRotationTest(camId, 5);

    fakeProc.emit('error', new Error('ENOENT'));

    await expect(resultPromise).rejects.toBeInstanceOf(FErr);
  });

  it('throws a plain Error when camera is not found', async () => {
    const { liveWheelRotationTest } = await import('../src/wheel-odometer.js');
    await expect(liveWheelRotationTest(99999, 5)).rejects.toThrow('not found');
  });

  it('throws a plain Error when wheel odometer is disabled', async () => {
    const camId = await seedWheelCamera(false); // wheel_mark_enabled = false
    const { liveWheelRotationTest } = await import('../src/wheel-odometer.js');
    await expect(liveWheelRotationTest(camId, 5)).rejects.toThrow('not enabled');
  });

  it('clamps durationS to [5, 30] — passes -t 30 for oversized input', async () => {
    const camId = await seedWheelCamera();
    const { liveWheelRotationTest } = await import('../src/wheel-odometer.js');

    const fakeProc = makeFakeProc();
    currentSpawnMock.mockReturnValueOnce(fakeProc);

    const resultPromise = liveWheelRotationTest(camId, 999);

    // Immediately close with 0 (no frames is fine for this test — we only care
    // about the ffmpeg args).
    fakeProc.emit('close', 0);
    await resultPromise;

    const args: string[] = currentSpawnMock.mock.calls[0]?.[1] ?? [];
    const tIdx = args.indexOf('-t');
    expect(tIdx).toBeGreaterThanOrEqual(0);
    expect(args[tIdx + 1]).toBe('30');
  });

  it('clamps durationS to minimum 5 for undersized input', async () => {
    const camId = await seedWheelCamera();
    const { liveWheelRotationTest } = await import('../src/wheel-odometer.js');

    const fakeProc = makeFakeProc();
    currentSpawnMock.mockReturnValueOnce(fakeProc);

    const resultPromise = liveWheelRotationTest(camId, 1);
    fakeProc.emit('close', 0);
    await resultPromise;

    const args: string[] = currentSpawnMock.mock.calls[0]?.[1] ?? [];
    const tIdx = args.indexOf('-t');
    expect(tIdx).toBeGreaterThanOrEqual(0);
    expect(args[tIdx + 1]).toBe('5');
  });

  it('returns zero rotations and zero distanceMeters when no rotation occurs', async () => {
    const camId = await seedWheelCamera();
    const { liveWheelRotationTest } = await import('../src/wheel-odometer.js');

    const fakeProc = makeFakeProc();
    currentSpawnMock.mockReturnValueOnce(fakeProc);

    const resultPromise = liveWheelRotationTest(camId, 5);

    // Only light frames — FSM never transitions to dark.
    const lightFrame = pgmFrame(200);
    for (let i = 0; i < 10; i += 1) fakeProc.stdout.emit('data', lightFrame);
    fakeProc.emit('close', 0);

    const result = await resultPromise;

    expect(result.rotations).toBe(0);
    expect(result.distanceMeters).toBe(0);
    expect(result.framesSampled).toBe(10);
  });

  it('succeeds with zero frames when ffmpeg exits 0 immediately', async () => {
    const camId = await seedWheelCamera();
    const { liveWheelRotationTest } = await import('../src/wheel-odometer.js');

    const fakeProc = makeFakeProc();
    currentSpawnMock.mockReturnValueOnce(fakeProc);

    const resultPromise = liveWheelRotationTest(camId, 5);
    fakeProc.emit('close', 0);

    const result = await resultPromise;
    expect(result.framesSampled).toBe(0);
    expect(result.rotations).toBe(0);
  });

  it('sampleFps in result equals 30 (native camera fps)', async () => {
    const camId = await seedWheelCamera();
    const { liveWheelRotationTest } = await import('../src/wheel-odometer.js');

    const fakeProc = makeFakeProc();
    currentSpawnMock.mockReturnValueOnce(fakeProc);

    const resultPromise = liveWheelRotationTest(camId, 5);
    fakeProc.emit('close', 0);

    const result = await resultPromise;
    expect(result.sampleFps).toBe(30);
  });
});
