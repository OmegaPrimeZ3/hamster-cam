// app/server/src/wheel-odometer.ts
// Optical-mark wheel odometry — Approach B.
//
// The operator sticks a piece of black tape on the wheel rim. We spawn an
// ffmpeg child process that reads the camera RTSP stream at 10 fps, crops the
// frame to a configurable horizontal band, and emits raw grayscale PGM frames
// on stdout. A finite-state machine (LIGHT → DARK → LIGHT = one rotation)
// counts rotations with an 80 ms debounce (3 frames at 10 fps). On session
// end the rotation count is converted to metres:
//   metres = rotations × π × diameter_mm / 1000

import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';

import * as db from './db.js';
import { getConfig } from './config.js';
import { childLogger } from './logger.js';

const log = childLogger('wheel-odometer');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sampling rate passed to ffmpeg (-r). */
const SAMPLE_FPS = 10;
/** Minimum consecutive frames a state must hold before it's counted (debounce). */
const DEBOUNCE_FRAMES = 3;
/** Safety cut-off — auto-kill a session after 2 hours. */
const MAX_SESSION_MS = 2 * 60 * 60 * 1000;

/**
 * Build the RTSP URL the odometer reads frames from. Cameras are identified by
 * their go2rtc stream name (`live_src`); Frigate's embedded go2rtc relays each
 * camera's H264 over RTSP on :8554, reachable on the compose network at the
 * same host as FRIGATE_URL (e.g. rtsp://frigate:8554/hamster_cam_1). Returns
 * null if the camera has no live_src or FRIGATE_URL is unset. (Replaces the
 * old per-camera stream_url, which the live_src migration emptied.)
 */
function wheelRtspUrl(liveSrc: string | null): string | null {
  if (!liveSrc) return null;
  const cfg = getConfig();
  if (!cfg.FRIGATE_URL) return null;
  return `rtsp://${new URL(cfg.FRIGATE_URL).hostname}:8554/${liveSrc}`;
}

// ---------------------------------------------------------------------------
// Shared pixel-counting helper
// ---------------------------------------------------------------------------

/**
 * Count the number of pixels in `pixels` that are strictly below `cutoff`.
 * Shared by PgmParser (live path) and computeDarkPixelRatio (test-tool path)
 * so both use identical per-pixel logic.
 */
function countDarkPixels(pixels: Buffer, cutoff: number): { dark: number; total: number } {
  let dark = 0;
  for (let i = 0; i < pixels.length; i += 1) {
    if ((pixels[i] ?? 255) < cutoff) dark += 1;
  }
  return { dark, total: pixels.length };
}

// ---------------------------------------------------------------------------
// PGM streaming parser
// ---------------------------------------------------------------------------

/** Callback receives the dark-pixel ratio (0–1) for each complete frame. */
type PgmCallback = (darkPixelRatio: number, frameMs: number) => void;

/**
 * Stateful PGM stream parser. Feeds raw bytes from ffmpeg stdout; invokes
 * `onFrame` with the dark-pixel ratio (0–1) of each complete frame and
 * the wall-clock ms at which the frame was received.
 *
 * "Dark" pixels are those whose intensity is strictly below
 * `255 * (1 − thresholdPct / 100)` — the same cutoff used by
 * `computeDarkPixelRatio` and the Settings test-tool.
 *
 * PGM binary format (P5):
 *   P5\n<width> <height>\n255\n<width*height bytes>
 */
export class PgmParser {
  private buf = Buffer.alloc(0);
  private frameBytes: number | null = null;
  private headerDone = false;
  private readonly cutoff: number;

  constructor(
    private readonly onFrame: PgmCallback,
    thresholdPct: number,
  ) {
    this.cutoff = 255 * (1 - thresholdPct / 100);
  }

  feed(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    this.drain();
  }

  private drain(): void {
    while (true) {
      if (!this.headerDone) {
        // Look for the end of the PGM header — three newline-terminated fields.
        const headerEnd = this.findHeaderEnd();
        if (headerEnd === -1) return; // Need more data.
        const header = this.buf.slice(0, headerEnd).toString('ascii');
        const dims = this.parsePgmHeader(header);
        if (!dims) {
          // Corrupt header — drop buffer up to and including this position and try again.
          this.buf = this.buf.slice(headerEnd);
          return;
        }
        this.frameBytes = dims.width * dims.height;
        this.buf = this.buf.slice(headerEnd);
        this.headerDone = true;
      }

      // headerDone = true, frameBytes is set.
      const need = this.frameBytes ?? 0;
      if (this.buf.length < need) return;

      const frameData = this.buf.slice(0, need);
      this.buf = this.buf.slice(need);
      this.headerDone = false;
      this.frameBytes = null;

      // Compute dark-pixel ratio using the shared helper.
      const { dark, total } = countDarkPixels(frameData, this.cutoff);
      const ratio = total > 0 ? dark / total : 0;
      this.onFrame(ratio, Date.now());
    }
  }

  /**
   * Finds the index of the first byte after the PGM header (past the third
   * newline of "P5\n<w> <h>\n255\n"). Returns -1 when not enough data yet.
   */
  private findHeaderEnd(): number {
    let newlines = 0;
    for (let i = 0; i < this.buf.length; i += 1) {
      if (this.buf[i] === 0x0a) {
        newlines += 1;
        if (newlines === 3) return i + 1;
      }
    }
    return -1;
  }

  private parsePgmHeader(header: string): { width: number; height: number } | null {
    // Expected: "P5\n<width> <height>\n255"
    const lines = header.split('\n').filter((l) => l.length > 0 && !l.startsWith('#'));
    if (lines[0] !== 'P5') return null;
    const dims = lines[1]?.split(/\s+/);
    if (!dims || dims.length < 2) return null;
    const width = Number.parseInt(dims[0] ?? '', 10);
    const height = Number.parseInt(dims[1] ?? '', 10);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null;
    }
    return { width, height };
  }
}

// ---------------------------------------------------------------------------
// Rotation counter — finite-state machine with debounce
// ---------------------------------------------------------------------------

type MarkState = 'light' | 'dark';

/**
 * Stateful FSM that converts a stream of per-frame dark-pixel ratios into
 * a rotation count. "Dark" means the tape mark is in the ROI box.
 *
 * State transitions:
 *   LIGHT → DARK: falling edge — tape entered the box.
 *   DARK  → LIGHT: rising edge — tape left the box. One rotation counted.
 *
 * Debounce: a state change is only committed after DEBOUNCE_FRAMES consecutive
 * frames agree on the new state.
 *
 * The "dark" threshold uses the same rule as the Settings test-tool:
 *   darkPixelRatio * 100 >= thresholdPct → state is 'dark'.
 */
export class RotationCounter {
  private state: MarkState = 'light';
  private candidateState: MarkState = 'light';
  private candidateCount = 0;
  private rotations = 0;

  constructor(private readonly thresholdPct: number) {}

  /**
   * Feed one frame's dark-pixel ratio (0–1). Returns the updated total
   * rotation count.
   *
   * The frame is considered 'dark' when `ratio * 100 >= thresholdPct`,
   * matching the test-tool's `darkPixelRatio * 100 >= thresholdPct` check.
   */
  feed(darkPixelRatio: number): number {
    const newState: MarkState = darkPixelRatio * 100 >= this.thresholdPct ? 'dark' : 'light';

    if (newState === this.candidateState) {
      this.candidateCount += 1;
    } else {
      this.candidateState = newState;
      this.candidateCount = 1;
    }

    if (this.candidateCount >= DEBOUNCE_FRAMES && newState !== this.state) {
      const prev = this.state;
      this.state = newState;
      // Count one rotation on the DARK → LIGHT transition (rising edge).
      if (prev === 'dark' && newState === 'light') {
        this.rotations += 1;
      }
    }

    return this.rotations;
  }

  getRotations(): number {
    return this.rotations;
  }
}

// ---------------------------------------------------------------------------
// Session handle
// ---------------------------------------------------------------------------

interface SessionHandle {
  cameraId: number;
  startedAt: number;
  counter: RotationCounter;
  parser: PgmParser;
  proc: ChildProcess & { stdout: Readable; stderr: Readable };
  safetyTimer: NodeJS.Timeout;
  diameterMm: number;
}

const activeSessions = new Map<number, SessionHandle>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start watching a wheel session for the given camera. Idempotent — if a
 * session is already running for that camera id, this is a no-op. Auto-stops
 * after 2 hours as a safety net. If wheel_mark_enabled = 0 for the camera,
 * this is a no-op.
 *
 * Returns true if a session is active after this call (either newly started or
 * already running), false if the camera is ineligible (disabled, missing
 * live_src, not found). The narrator uses this return value to decide whether
 * to set odomCameraId — it must only be set when a real ffmpeg session is live.
 */
export function startWheelSession(cameraId: number, startedAt: number): boolean {
  if (activeSessions.has(cameraId)) return true;

  const camera = db.getCameraById(cameraId);
  if (!camera) {
    log.warn({ cameraId }, 'wheel-odometer: camera not found, skipping session start');
    return false;
  }
  if (camera.wheel_mark_enabled !== 1) return false;

  const {
    live_src,
    wheel_diameter_mm: diameterMm,
    wheel_band_x_pct: bandX,
    wheel_band_width_pct: bandW,
    wheel_band_y_pct: bandY,
    wheel_band_height_pct: bandH,
    wheel_threshold_pct: thresholdPct,
  } = camera;

  const rtspUrl = wheelRtspUrl(live_src);
  if (!rtspUrl) {
    log.warn({ cameraId, live_src }, 'wheel-odometer: no live_src / FRIGATE_URL — cannot start session');
    return false;
  }

  const counter = new RotationCounter(thresholdPct);
  const parser = new PgmParser((ratio) => {
    counter.feed(ratio);
  }, thresholdPct);

  // ffmpeg crops to the band and emits grayscale PGM frames on stdout.
  // We use `ih*bandH/100` arithmetic inside the crop filter expression.
  // `-vsync vfr` avoids duplicate frames on slow streams.
  //
  // We cast the result to our SessionHandle proc type because TypeScript's
  // overload resolution for spawn() with stdio-tuple literals produces
  // ChildProcessByStdio<null, Readable, Readable>; the cast is safe since
  // stdout and stderr are Readable instances in all cases.
  const rawProc = spawn('ffmpeg', [
    '-rtsp_transport', 'tcp',
    '-i', rtspUrl,
    '-vf', `crop=iw*${bandW}/100:ih*${bandH}/100:iw*${bandX}/100:ih*${bandY}/100,format=gray`,
    '-vsync', 'vfr',
    '-r', String(SAMPLE_FPS),
    '-f', 'image2pipe',
    '-vcodec', 'pgm',
    '-',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const proc = rawProc as SessionHandle['proc'];

  proc.stdout.on('data', (chunk: Buffer) => {
    parser.feed(chunk);
  });

  proc.stderr.on('data', () => {
    // Swallow ffmpeg's progress output; errors surface via 'close'.
  });

  proc.on('error', (err) => {
    log.warn({ cameraId, err: err.message }, 'wheel-odometer: ffmpeg spawn error');
    cleanupSession(cameraId);
  });

  proc.on('close', (code) => {
    if (activeSessions.has(cameraId)) {
      // Unexpected exit — log and clean up, but do NOT throw. The partial
      // count is preserved in the counter and endWheelSession will read it.
      log.warn({ cameraId, code }, 'wheel-odometer: ffmpeg exited unexpectedly');
      cleanupSession(cameraId);
    }
  });

  const safetyTimer = setTimeout(() => {
    log.warn({ cameraId }, 'wheel-odometer: safety cut-off after 2 hours');
    cleanupSession(cameraId);
  }, MAX_SESSION_MS);
  safetyTimer.unref?.();

  activeSessions.set(cameraId, {
    cameraId,
    startedAt,
    counter,
    parser,
    proc,
    safetyTimer,
    diameterMm,
  });

  log.info({ cameraId, rtspUrl, bandX, bandW, bandY, bandH, thresholdPct }, 'wheel session started');
  return true;
}

/**
 * Stop the wheel session for this camera and return the computed metres.
 * Returns null if no session was active or if odometry is disabled.
 * metres = rotations × π × diameter_mm / 1000
 */
export function endWheelSession(cameraId: number): number | null {
  const session = activeSessions.get(cameraId);
  if (!session) return null;

  const rotations = session.counter.getRotations();
  cleanupSession(cameraId);

  const metres = rotations * Math.PI * session.diameterMm / 1000;
  log.info({ cameraId, rotations, metres }, 'wheel session ended');
  return metres;
}

/**
 * One-off helper used by `cameras.testWheelDetection`: grab a single frame
 * from the camera, crop it to the configured band, compute the dark-pixel
 * ratio, and return a base64 PNG of the cropped band plus the ratio.
 */
export async function testWheelDetection(cameraId: number): Promise<
  | { croppedPngBase64: string; darkPixelRatio: number; thresholdPct: number }
  | { error: string }
> {
  const camera = db.getCameraById(cameraId);
  if (!camera) return { error: `camera ${cameraId} not found` };

  const {
    live_src,
    wheel_band_x_pct: bandX,
    wheel_band_width_pct: bandW,
    wheel_band_y_pct: bandY,
    wheel_band_height_pct: bandH,
    wheel_threshold_pct: thresholdPct,
  } = camera;
  const rtspUrl = wheelRtspUrl(live_src);
  if (!rtspUrl) return { error: 'camera has no go2rtc live_src configured' };

  return new Promise((resolve) => {
    // Capture exactly one frame as grayscale PGM, then convert to PNG via a
    // second ffmpeg pass. We chain them with pipe to avoid writing temp files.
    //
    // Step 1: grab one PGM frame from the stream.
    const grabProc = spawn('ffmpeg', [
      '-rtsp_transport', 'tcp',
      '-i', rtspUrl,
      '-vf', `crop=iw*${bandW}/100:ih*${bandH}/100:iw*${bandX}/100:ih*${bandY}/100,format=gray`,
      '-vframes', '1',
      '-f', 'image2pipe',
      '-vcodec', 'pgm',
      '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const pgmChunks: Buffer[] = [];
    grabProc.stdout.on('data', (c: Buffer) => pgmChunks.push(c));

    grabProc.on('error', (err) => resolve({ error: `ffmpeg error: ${err.message}` }));

    grabProc.on('close', (code) => {
      if (code !== 0) {
        resolve({ error: `ffmpeg exited with code ${code}` });
        return;
      }
      const pgmBuf = Buffer.concat(pgmChunks);
      if (pgmBuf.length === 0) {
        resolve({ error: 'ffmpeg produced no output' });
        return;
      }

      // Step 2: convert the PGM to PNG via ffmpeg piped stdin → stdout.
      const convProc = spawn('ffmpeg', [
        '-f', 'pgm_pipe',
        '-i', 'pipe:0',
        '-f', 'apng',
        'pipe:1',
      ], { stdio: ['pipe', 'pipe', 'pipe'] });

      const pngChunks: Buffer[] = [];
      convProc.stdout.on('data', (c: Buffer) => pngChunks.push(c));
      convProc.on('error', (err) => resolve({ error: `png-convert error: ${err.message}` }));
      convProc.on('close', (convCode) => {
        if (convCode !== 0) {
          resolve({ error: `png convert exited with code ${convCode}` });
          return;
        }
        const pngBuf = Buffer.concat(pngChunks);

        // Also compute the dark-pixel ratio from the raw PGM bytes.
        const darkRatio = computeDarkPixelRatio(pgmBuf, thresholdPct);

        resolve({
          croppedPngBase64: pngBuf.toString('base64'),
          darkPixelRatio: darkRatio,
          thresholdPct,
        });
      });

      convProc.stdin.write(pgmBuf);
      convProc.stdin.end();
    });
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function cleanupSession(cameraId: number): void {
  const session = activeSessions.get(cameraId);
  if (!session) return;
  clearTimeout(session.safetyTimer);
  try {
    session.proc.kill('SIGTERM');
  } catch {
    // Process may already be dead.
  }
  activeSessions.delete(cameraId);
}

/**
 * Parse the PGM header from a full buffer and compute the ratio of dark pixels.
 * "Dark" = pixel intensity strictly below `255 * (1 − thresholdPct/100)`.
 * Returns 0 on parse failure.
 *
 * Used by `testWheelDetection` (Settings test-tool). The per-pixel cutoff is
 * identical to what `PgmParser` applies to live frames — both delegate to
 * `countDarkPixels`.
 */
function computeDarkPixelRatio(pgmBuf: Buffer, thresholdPct: number): number {
  // Find the end of the three-line header.
  let newlines = 0;
  let headerEnd = -1;
  for (let i = 0; i < pgmBuf.length; i += 1) {
    if (pgmBuf[i] === 0x0a) {
      newlines += 1;
      if (newlines === 3) {
        headerEnd = i + 1;
        break;
      }
    }
  }
  if (headerEnd === -1) return 0;
  const pixels = pgmBuf.slice(headerEnd);
  if (pixels.length === 0) return 0;

  const cutoff = 255 * (1 - thresholdPct / 100);
  const { dark, total } = countDarkPixels(pixels, cutoff);
  return dark / total;
}

// Exported for tests.
export { activeSessions as _activeSessions };
