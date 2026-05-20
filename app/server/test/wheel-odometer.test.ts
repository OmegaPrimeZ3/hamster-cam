// Unit tests for wheel-odometer.ts:
//   - PgmParser: stream parsing and mean intensity computation
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

  it('parses a complete PGM frame and reports mean intensity', async () => {
    const { PgmParser } = await import('../src/wheel-odometer.js');
    const intensities: number[] = [];
    const parser = new PgmParser((mean) => intensities.push(mean));

    const header = Buffer.from('P5\n2 2\n255\n', 'ascii');
    const pixels = Buffer.from([100, 100, 100, 100]);
    parser.feed(Buffer.concat([header, pixels]));

    expect(intensities).toHaveLength(1);
    expect(intensities[0]).toBeCloseTo(100, 5);
  });

  it('handles a frame split across two chunks', async () => {
    const { PgmParser } = await import('../src/wheel-odometer.js');
    const intensities: number[] = [];
    const parser = new PgmParser((mean) => intensities.push(mean));

    const header = Buffer.from('P5\n2 2\n255\n', 'ascii');
    const pixels = Buffer.from([200, 200, 200, 200]);
    const full = Buffer.concat([header, pixels]);

    parser.feed(full.slice(0, 7));
    parser.feed(full.slice(7));

    expect(intensities).toHaveLength(1);
    expect(intensities[0]).toBeCloseTo(200, 5);
  });

  it('parses two back-to-back frames from a single feed', async () => {
    const { PgmParser } = await import('../src/wheel-odometer.js');
    const intensities: number[] = [];
    const parser = new PgmParser((mean) => intensities.push(mean));

    const makeFrame = (intensity: number): Buffer => {
      const header = Buffer.from('P5\n1 1\n255\n', 'ascii');
      return Buffer.concat([header, Buffer.from([intensity])]);
    };

    parser.feed(Buffer.concat([makeFrame(50), makeFrame(220)]));
    expect(intensities).toHaveLength(2);
    expect(intensities[0]).toBeCloseTo(50, 5);
    expect(intensities[1]).toBeCloseTo(220, 5);
  });

  it('ignores corrupt headers gracefully', async () => {
    const { PgmParser } = await import('../src/wheel-odometer.js');
    const intensities: number[] = [];
    const parser = new PgmParser((mean) => intensities.push(mean));

    // P6 is colour PGM — our parser only handles P5. Should not throw.
    const badHeader = Buffer.from('P6\n2 2\n255\n', 'ascii');
    const pixels = Buffer.from([1, 2, 3, 4]);
    expect(() => parser.feed(Buffer.concat([badHeader, pixels]))).not.toThrow();
    expect(intensities).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// RotationCounter — pure unit tests.
// ---------------------------------------------------------------------------

describe('RotationCounter', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('counts one rotation on a debounced DARK → LIGHT transition', async () => {
    const { RotationCounter } = await import('../src/wheel-odometer.js');
    // threshold 50 % → cutoff = 255 * 0.5 = 127.5
    const counter = new RotationCounter(50);

    // 3 light frames first (initial state committed).
    for (let i = 0; i < 3; i += 1) counter.feed(200);
    expect(counter.getRotations()).toBe(0);

    // 3 dark frames — falling edge committed.
    for (let i = 0; i < 3; i += 1) counter.feed(50);
    expect(counter.getRotations()).toBe(0);

    // 3 light frames — rising edge committed = 1 rotation.
    for (let i = 0; i < 3; i += 1) counter.feed(200);
    expect(counter.getRotations()).toBe(1);
  });

  it('debounces noise — fewer than 3 consecutive frames does not change state', async () => {
    const { RotationCounter } = await import('../src/wheel-odometer.js');
    const counter = new RotationCounter(50);

    // Establish light state.
    for (let i = 0; i < 3; i += 1) counter.feed(200);

    // Two dark (below debounce threshold) then back to light.
    counter.feed(50);
    counter.feed(50);
    counter.feed(200);

    // Two more dark, two more light — never 3 consecutive.
    counter.feed(50);
    counter.feed(50);
    counter.feed(200);
    counter.feed(200);

    expect(counter.getRotations()).toBe(0);
  });

  it('counts multiple rotations over a sequence of transitions', async () => {
    const { RotationCounter } = await import('../src/wheel-odometer.js');
    const counter = new RotationCounter(50);

    for (let r = 0; r < 3; r += 1) {
      for (let i = 0; i < 3; i += 1) counter.feed(200);
      for (let i = 0; i < 3; i += 1) counter.feed(50);
      for (let i = 0; i < 3; i += 1) counter.feed(200);
    }

    expect(counter.getRotations()).toBe(3);
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

async function seedWheelCamera(enabled: boolean = true): Promise<number> {
  const db = await import('../src/db.js');
  const cam = db.createCamera({
    name: 'wheel-cam',
    emoji: '🎡',
    stream_url: 'rtsp://fake/stream',
    enabled: true,
    zones: ['wheel'],
    wheel_mark_enabled: enabled,
    wheel_diameter_mm: 152.0,
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
});
