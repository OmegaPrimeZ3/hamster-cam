// Unit tests for wheel-odometer.ts:
//   - PgmParser: stream parsing and dark-pixel-ratio computation
//   - RotationCounter: debounced FSM edge detection + rotation-to-metres math
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
// RotationCounter — pure unit tests.
// ---------------------------------------------------------------------------

describe('RotationCounter', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // RotationCounter.feed() now takes a dark-pixel ratio (0–1).
  // threshold=50 → frame is 'dark' when ratio * 100 >= 50, i.e. ratio >= 0.5.
  // LIGHT_RATIO=0.0 (no dark pixels), DARK_RATIO=1.0 (all pixels dark).
  const LIGHT_RATIO = 0.0;
  const DARK_RATIO = 1.0;

  it('counts one rotation on a debounced DARK → LIGHT transition', async () => {
    const { RotationCounter } = await import('../src/wheel-odometer.js');
    const counter = new RotationCounter(50);

    // 3 light frames first (initial state committed).
    for (let i = 0; i < 3; i += 1) counter.feed(LIGHT_RATIO);
    expect(counter.getRotations()).toBe(0);

    // 3 dark frames — falling edge committed.
    for (let i = 0; i < 3; i += 1) counter.feed(DARK_RATIO);
    expect(counter.getRotations()).toBe(0);

    // 3 light frames — rising edge committed = 1 rotation.
    for (let i = 0; i < 3; i += 1) counter.feed(LIGHT_RATIO);
    expect(counter.getRotations()).toBe(1);
  });

  it('threshold boundary: ratio exactly at thresholdPct/100 is dark', async () => {
    const { RotationCounter } = await import('../src/wheel-odometer.js');
    // threshold=50 → ratio >= 0.5 is dark.
    const counter = new RotationCounter(50);

    for (let i = 0; i < 3; i += 1) counter.feed(LIGHT_RATIO);

    // ratio=0.5 → 0.5*100=50 >= 50 → dark.
    for (let i = 0; i < 3; i += 1) counter.feed(0.5);
    expect(counter.getRotations()).toBe(0); // still in dark state, no rising edge yet.

    for (let i = 0; i < 3; i += 1) counter.feed(LIGHT_RATIO);
    expect(counter.getRotations()).toBe(1);
  });

  it('threshold boundary: ratio just below thresholdPct/100 is light', async () => {
    const { RotationCounter } = await import('../src/wheel-odometer.js');
    // threshold=50 → ratio < 0.5 is light.
    const counter = new RotationCounter(50);

    for (let i = 0; i < 3; i += 1) counter.feed(LIGHT_RATIO);

    // ratio=0.49 → 0.49*100=49 < 50 → light (never goes dark).
    for (let i = 0; i < 6; i += 1) counter.feed(0.49);
    expect(counter.getRotations()).toBe(0);
  });

  it('debounces noise — fewer than 3 consecutive frames does not change state', async () => {
    const { RotationCounter } = await import('../src/wheel-odometer.js');
    const counter = new RotationCounter(50);

    // Establish light state.
    for (let i = 0; i < 3; i += 1) counter.feed(LIGHT_RATIO);

    // Two dark (below debounce threshold) then back to light.
    counter.feed(DARK_RATIO);
    counter.feed(DARK_RATIO);
    counter.feed(LIGHT_RATIO);

    // Two more dark, two more light — never 3 consecutive.
    counter.feed(DARK_RATIO);
    counter.feed(DARK_RATIO);
    counter.feed(LIGHT_RATIO);
    counter.feed(LIGHT_RATIO);

    expect(counter.getRotations()).toBe(0);
  });

  it('counts multiple rotations over a sequence of transitions', async () => {
    const { RotationCounter } = await import('../src/wheel-odometer.js');
    const counter = new RotationCounter(50);

    for (let r = 0; r < 3; r += 1) {
      for (let i = 0; i < 3; i += 1) counter.feed(LIGHT_RATIO);
      for (let i = 0; i < 3; i += 1) counter.feed(DARK_RATIO);
      for (let i = 0; i < 3; i += 1) counter.feed(LIGHT_RATIO);
    }

    expect(counter.getRotations()).toBe(3);
  });

  it('test-tool and live-counter agree: partial dark-pixel frame above threshold is dark', async () => {
    const { RotationCounter } = await import('../src/wheel-odometer.js');
    // Simulate the real bug scenario: tape occupies ~50% of the ROI box.
    // threshold=40 → ratio >= 0.4 is dark.
    const counter = new RotationCounter(40);

    for (let i = 0; i < 3; i += 1) counter.feed(0.0); // light

    // ratio=0.5 → 0.5*100=50 >= 40 → dark (this is what the test-tool would show as "visible")
    for (let i = 0; i < 3; i += 1) counter.feed(0.5);

    for (let i = 0; i < 3; i += 1) counter.feed(0.0); // light again

    expect(counter.getRotations()).toBe(1);
  });

  it('converts rotations to correct metres (maths check)', () => {
    // metres = rotations × π × diameter_mm / 1000
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

describe('wheel session lifecycle', () => {
  it('end-without-start returns null', async () => {
    const { endWheelSession } = await import('../src/wheel-odometer.js');
    expect(endWheelSession(999)).toBeNull();
  });

  it('double-start is idempotent — only one ffmpeg process spawned', async () => {
    const camId = await seedWheelCamera();
    const { startWheelSession, endWheelSession, _activeSessions } = await import('../src/wheel-odometer.js');

    startWheelSession(camId, Date.now());
    startWheelSession(camId, Date.now());

    expect(currentSpawnMock).toHaveBeenCalledTimes(1);
    expect(_activeSessions.size).toBe(1);

    endWheelSession(camId);
  });

  it('start is a no-op when wheel_mark_enabled = false', async () => {
    const camId = await seedWheelCamera(false);
    const { startWheelSession, _activeSessions } = await import('../src/wheel-odometer.js');

    startWheelSession(camId, Date.now());
    expect(currentSpawnMock).not.toHaveBeenCalled();
    expect(_activeSessions.size).toBe(0);
  });

  it('start→end returns computed metres from rotation count', async () => {
    const camId = await seedWheelCamera();
    const { startWheelSession, endWheelSession, _activeSessions } = await import('../src/wheel-odometer.js');

    startWheelSession(camId, Date.now());
    expect(_activeSessions.size).toBe(1);

    const session = _activeSessions.get(camId);
    expect(session).toBeDefined();

    // Feed the parser 9 frames simulating one full rotation:
    // 3 light, 3 dark, 3 light.
    const header = Buffer.from('P5\n4 4\n255\n', 'ascii');
    const lightPixels = Buffer.alloc(16, 200);
    const darkPixels = Buffer.alloc(16, 50);

    for (let i = 0; i < 3; i += 1) {
      session?.proc.stdout.emit('data', Buffer.concat([header, lightPixels]));
    }
    for (let i = 0; i < 3; i += 1) {
      session?.proc.stdout.emit('data', Buffer.concat([header, darkPixels]));
    }
    for (let i = 0; i < 3; i += 1) {
      session?.proc.stdout.emit('data', Buffer.concat([header, lightPixels]));
    }

    const metres = endWheelSession(camId);
    // 1 rotation × π × 152 / 1000
    expect(metres).not.toBeNull();
    expect(metres as number).toBeCloseTo(Math.PI * 152 / 1000, 4);
  });

  it('ffmpeg crash mid-session — session removed, subsequent end returns null', async () => {
    const camId = await seedWheelCamera();
    const { startWheelSession, endWheelSession, _activeSessions } = await import('../src/wheel-odometer.js');

    startWheelSession(camId, Date.now());
    const session = _activeSessions.get(camId);

    // Simulate unexpected ffmpeg process exit (non-zero).
    session?.proc.emit('close', 1);

    // After crash, session is cleaned up automatically.
    expect(_activeSessions.has(camId)).toBe(false);

    // endWheelSession returns null — the session is gone.
    expect(endWheelSession(camId)).toBeNull();
  });

  it('endWheelSession kills the ffmpeg process', async () => {
    const camId = await seedWheelCamera();
    const { startWheelSession, endWheelSession, _activeSessions } = await import('../src/wheel-odometer.js');

    startWheelSession(camId, Date.now());
    const session = _activeSessions.get(camId);

    endWheelSession(camId);
    expect(session?.proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(_activeSessions.has(camId)).toBe(false);
  });

  it('ffmpeg crop filter uses full rectangle: iw*W/100:ih*H/100:iw*X/100:ih*Y/100', async () => {
    // Camera with a non-default x + width so the crop string is unambiguous.
    const camId = await seedWheelCamera(true, { wheel_band_x_pct: 25, wheel_band_width_pct: 50 });
    const { startWheelSession } = await import('../src/wheel-odometer.js');

    startWheelSession(camId, Date.now());

    expect(currentSpawnMock).toHaveBeenCalledTimes(1);
    const args: string[] = currentSpawnMock.mock.calls[0]?.[1] ?? [];
    const vfIdx = args.indexOf('-vf');
    expect(vfIdx).toBeGreaterThanOrEqual(0);
    // bandX=25, bandW=50, bandY=50, bandH=10
    expect(args[vfIdx + 1]).toBe('crop=iw*50/100:ih*10/100:iw*25/100:ih*50/100,format=gray');
  });

  it('ffmpeg crop defaults to full-width when x=0 width=100 (backward compat)', async () => {
    // Default camera: x_pct=0, width_pct=100 — replicates old full-width strip.
    const camId = await seedWheelCamera();
    const { startWheelSession } = await import('../src/wheel-odometer.js');

    startWheelSession(camId, Date.now());

    const args: string[] = currentSpawnMock.mock.calls[0]?.[1] ?? [];
    const vfIdx = args.indexOf('-vf');
    expect(args[vfIdx + 1]).toBe('crop=iw*100/100:ih*10/100:iw*0/100:ih*50/100,format=gray');
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

describe('liveWheelRotationTest', () => {
  // Helper: build a 1×1 PGM frame buffer for a given pixel value.
  function pgmFrame(pixelValue: number): Buffer {
    const header = Buffer.from('P5\n1 1\n255\n', 'ascii');
    return Buffer.concat([header, Buffer.from([pixelValue])]);
  }

  it('returns correct rotations, distanceMeters, thresholdRatio for a synthetic sequence', async () => {
    // threshold=50 → thresholdRatio = 1 - 50/100 = 0.5
    // dark pixel = value < 127.5 (PgmParser uses 255*(1-50/100)=127.5 as cutoff)
    // RotationCounter treats frame as dark when ratio*100 >= 50, i.e. ratio >= 0.5
    //
    // We produce 2 full rotations:
    //   [3 light, 3 dark, 3 light] × 2
    const camId = await seedWheelCamera(); // diameterMm=152, thresholdPct=50

    const { liveWheelRotationTest } = await import('../src/wheel-odometer.js');

    // Override spawn for this module-scope block.
    const fakeProc = makeFakeProc();
    currentSpawnMock.mockReturnValueOnce(fakeProc);

    // Kick off the promise (it will await the 'close' event).
    const resultPromise = liveWheelRotationTest(camId, 15);

    // Emit 2 rotation cycles: 3 light → 3 dark → 3 light, twice.
    const lightFrame = pgmFrame(200); // 200 >= 127.5 → light (ratio = 0)
    const darkFrame  = pgmFrame(50);  // 50  <  127.5 → dark  (ratio = 1)

    for (let cycle = 0; cycle < 2; cycle += 1) {
      for (let i = 0; i < 3; i += 1) fakeProc.stdout.emit('data', lightFrame);
      for (let i = 0; i < 3; i += 1) fakeProc.stdout.emit('data', darkFrame);
      for (let i = 0; i < 3; i += 1) fakeProc.stdout.emit('data', lightFrame);
    }

    // Signal ffmpeg done (exit 0).
    fakeProc.emit('close', 0);

    const result = await resultPromise;

    expect(result.rotations).toBe(2);
    expect(result.framesSampled).toBe(18); // 9 frames × 2 cycles
    expect(result.sampleFps).toBe(10);
    expect(result.thresholdRatio).toBeCloseTo(0.5, 5);
    expect(result.diameterMm).toBe(152);
    // distanceMeters = 2 × π × 152 / 1000
    expect(result.distanceMeters).toBeCloseTo(2 * Math.PI * 152 / 1000, 5);
    // ratioTrace should contain the per-frame ratios: 0 for light, 1 for dark.
    expect(result.ratioTrace).toHaveLength(18);
    // First three frames are light → ratio 0.
    expect(result.ratioTrace[0]).toBeCloseTo(0, 5);
    // Frames 3–5 are dark → ratio 1.
    expect(result.ratioTrace[3]).toBeCloseTo(1, 5);
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
});
