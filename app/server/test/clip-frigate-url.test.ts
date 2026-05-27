// Tests that extractClip and extractFrame build the correct Frigate 0.17.x
// recording-clip URL: /api/<cam>/start/<s>/end/<e>/clip.mp4
//
// We intercept `spawn` from node:child_process to capture the ffmpeg args
// without ever launching a real process.  The mock emits close(0) so the
// functions believe ffmpeg succeeded; we then assert the -i argument matches
// the expected URL shape.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock node:child_process so ffmpeg never actually runs.
// ---------------------------------------------------------------------------

// We keep a reference to the captured args so tests can inspect them.
let capturedFfmpegArgs: string[] = [];

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    spawn: vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'ffmpeg') {
        capturedFfmpegArgs = [...args];
      }
      // Build a fake child-process that immediately emits close(0).
      const proc = new EventEmitter() as EventEmitter & {
        stderr: EventEmitter;
        stdin: null;
        stdout: null;
      };
      proc.stderr = new EventEmitter();
      proc.stdin = null;
      proc.stdout = null;

      // Emit close on the next tick so the promise chain is set up first.
      setImmediate(() => proc.emit('close', 0));
      return proc;
    }),
  };
});

// ---------------------------------------------------------------------------
// Environment wiring
// ---------------------------------------------------------------------------

let workdir: string;
const baseEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  capturedFfmpegArgs = [];

  workdir = mkdtempSync(join(tmpdir(), 'hamster-url-test-'));
  mkdirSync(join(workdir, 'clips'), { recursive: true });
  mkdirSync(join(workdir, 'thumbnails'), { recursive: true });

  Object.assign(process.env, baseEnv);
  process.env['DATABASE_PATH'] = join(workdir, 'hamster.db');
  process.env['STORAGE_PATH'] = workdir;
  process.env['FRIGATE_URL'] = 'http://frigate.local:5000';
  process.env['ZYPHR_API_KEY'] = 'zy_test_dummy';
  process.env['ZYPHR_APP_SECRET'] = 'zy_test_dummy_secret';
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// extractClip URL shape
// ---------------------------------------------------------------------------

describe('extractClip — Frigate 0.17.x URL', () => {
  it('passes /api/<cam>/start/<s>/end/<e>/clip.mp4 to ffmpeg (NOT the old /recordings/ form)', async () => {
    const { extractClip } = await import('../src/frigate.js');

    const cameraName = 'hamster-cam-1';
    // centerMs = 1_000_000 ms, durationMs = 10_000 ms
    // startSec = floor((1_000_000 - 5_000) / 1000) = 995
    // endSec   = floor((1_000_000 + 5_000) / 1000) = 1005
    await extractClip({ cameraName, centerMs: 1_000_000, durationMs: 10_000 });

    // Find the -i argument value.
    const iIdx = capturedFfmpegArgs.indexOf('-i');
    expect(iIdx).toBeGreaterThan(-1);
    const inputUrl = capturedFfmpegArgs[iIdx + 1];

    expect(inputUrl).toBeDefined();
    expect(inputUrl).toBe('http://frigate.local:5000/api/hamster-cam-1/start/995/end/1005/clip.mp4');

    // Explicitly assert the old (broken) form is absent.
    expect(inputUrl).not.toContain('/recordings/');
  });

  it('URL-encodes camera names that contain spaces or special chars', async () => {
    const { extractClip } = await import('../src/frigate.js');

    await extractClip({ cameraName: 'cam two', centerMs: 2_000_000, durationMs: 10_000 });

    const iIdx = capturedFfmpegArgs.indexOf('-i');
    const inputUrl = capturedFfmpegArgs[iIdx + 1];
    expect(inputUrl).toContain('/api/cam%20two/start/');
  });
});

// ---------------------------------------------------------------------------
// extractFrame URL shape
// ---------------------------------------------------------------------------

describe('extractFrame — Frigate 0.17.x URL', () => {
  it('passes a 4-second window centered on atMs to ffmpeg (start=center-2, end=center+2)', async () => {
    const { extractFrame } = await import('../src/frigate.js');

    // atMs = 5_000_500 → centerSec = floor(5_000_500 / 1000) = 5000
    // startSec = max(0, 5000 - 2) = 4998; endSec = 5000 + 2 = 5002
    const result = await extractFrame({ cameraName: 'remy-cam', atMs: 5_000_500 });

    const iIdx = capturedFfmpegArgs.indexOf('-i');
    expect(iIdx).toBeGreaterThan(-1);
    const inputUrl = capturedFfmpegArgs[iIdx + 1];

    expect(inputUrl).toBe('http://frigate.local:5000/api/remy-cam/start/4998/end/5002/clip.mp4');
    expect(inputUrl).not.toContain('/recordings/');
    expect(inputUrl).not.toContain('/start/5000/end/5001/'); // old 1-second form must be gone

    // Either outcome is acceptable here — we only care about the URL.
    expect(result.path).toContain('thumbnails');
  });

  it('clamps startSec to 0 when atMs is within the first 2 seconds', async () => {
    const { extractFrame } = await import('../src/frigate.js');

    // atMs = 1500 → centerSec = 1; startSec = max(0, 1-2) = 0; endSec = 3
    await extractFrame({ cameraName: 'remy-cam', atMs: 1_500 });

    const iIdx = capturedFfmpegArgs.indexOf('-i');
    const inputUrl = capturedFfmpegArgs[iIdx + 1];
    expect(inputUrl).toBe('http://frigate.local:5000/api/remy-cam/start/0/end/3/clip.mp4');
  });

  it('includes a -ss seek offset so the extracted frame lands near atMs', async () => {
    const { extractFrame } = await import('../src/frigate.js');

    // atMs = 5_000_500 → centerSec=5000, startSec=4998, seekOffset = min(5000-4998, 3) = 2
    await extractFrame({ cameraName: 'remy-cam', atMs: 5_000_500 });

    const ssIdx = capturedFfmpegArgs.indexOf('-ss');
    expect(ssIdx).toBeGreaterThan(-1);
    expect(capturedFfmpegArgs[ssIdx + 1]).toBe('2');
  });

  it('does not throw when FRIGATE_URL is absent — returns captured:false', async () => {
    delete process.env['FRIGATE_URL'];
    const { extractFrame } = await import('../src/frigate.js');

    const result = await extractFrame({ cameraName: 'remy-cam', atMs: 1_000 });
    expect(result.captured).toBe(false);
    // No ffmpeg call should have been made.
    expect(capturedFfmpegArgs).toHaveLength(0);
  });
});
