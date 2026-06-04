// app/server/src/wheel-odometer.ts
// Optical-mark wheel odometry — Approach B.
//
// The operator sticks a piece of black tape on the wheel rim. We spawn an
// ffmpeg child process that reads the camera RTSP stream at 30 fps (matching
// the source camera's native frame rate — sampling faster would only duplicate
// frames and waste CPU), crops the frame to a configurable 2-D ROI box, and
// emits raw grayscale PGM frames on stdout. A finite-state machine counts
// rotations using edge detection with a refractory period:
//
//   LIGHT → DARK  (falling edge, confirmed by ≥1 dark frame)
//   DARK  → LIGHT (rising edge) = one rotation counted
//   then lock out the counter for REFRACTORY_MS to reject flicker /
//   contact-bounce / a marker parked in the box.
//
// At 30 fps a real tape pass lasts ~1–3 frames; the old 3-frame sustained-dark
// requirement (80 ms at 10 fps, effectively 300 ms at 10 fps) was far too
// coarse and ate almost every real pass. The refractory period replaces it:
// hamster wheels realistically top ~4-5 rps, so 150 ms ≈ 4.5 frames at 30 fps
// reliably rejects sub-100 ms noise while allowing genuinely fast spins.
//
// On session end the rotation count is converted to metres:
//   metres = rotations × π × diameter_mm / 1000
//
// REUSABLE STATE MACHINE (DRY)
// ----------------------------
// PgmParser and RotationCounter are the pure, exported units. The live path
// (startWheelSession / endWheelSession) feeds them from an RTSP ffmpeg pipe.
// The backfill path (replayWheelDistance) feeds them from a Frigate recording
// clip URL using the identical crop filter and sample rate. Neither path
// duplicates any per-pixel or FSM logic.

import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';

import * as db from './db.js';
import { getConfig } from './config.js';
import { FfmpegError } from './frigate.js';
import { childLogger } from './logger.js';

const log = childLogger('wheel-odometer');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Sampling rate passed to ffmpeg (-r). Cameras are locked at 30 fps; matching
 * that rate gives the tightest temporal resolution without duplicating frames.
 */
const SAMPLE_FPS = 30;

/**
 * Refractory period in milliseconds: minimum time between two counted
 * rotations. Hamster wheels realistically top out around 4-5 rps, so a 150 ms
 * lock-out window rejects sub-100 ms flicker / contact-bounce / a parked
 * marker while allowing genuinely fast consecutive spins at up to ~6.7 rps.
 * At 30 fps this equals ~4.5 frames.
 */
const REFRACTORY_MS = 150;

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
// Rotation counter — edge-detection FSM with refractory period
// ---------------------------------------------------------------------------

type MarkState = 'light' | 'dark';

/**
 * Stateful FSM that converts a stream of per-frame dark-pixel ratios into
 * a rotation count. "Dark" means the tape mark is in the ROI box.
 *
 * Algorithm (replaces the old 3-frame sustained-dark debounce):
 *
 *   1. Classify each incoming frame as 'dark' or 'light' using the threshold.
 *   2. On a LIGHT → DARK transition (falling edge, confirmed by ≥ 1 dark
 *      frame), record that the marker has entered the box.
 *   3. On the subsequent DARK → LIGHT transition (rising edge), count one
 *      rotation — BUT only if at least REFRACTORY_MS has elapsed since the
 *      last counted rotation.
 *   4. The refractory period (150 ms, ~4.5 frames at 30 fps) suppresses:
 *      - flicker: a lone dark frame that turns light again immediately
 *      - contact-bounce: rapid on/off within a single pass
 *      - a parked marker: the marker sitting in the box indefinitely counts
 *        exactly once on the first DARK → LIGHT exit
 *
 * Time is derived from the frame index and the caller-supplied fps, keeping
 * the class clock-free (no Date.now()) so it is deterministically testable.
 *
 * The "dark" threshold uses the same rule as the Settings test-tool:
 *   darkPixelRatio * 100 >= thresholdPct → state is 'dark'.
 */
export class RotationCounter {
  private state: MarkState = 'light';
  private rotations = 0;
  private frameIndex = 0;
  /** Frame index at which the last rotation was counted, or -Infinity initially. */
  private lastCountedFrame = -Infinity;
  private readonly msPerFrame: number;

  /**
   * @param thresholdPct  Dark-pixel threshold in percent (0–100).
   * @param fps           Sampling rate; defaults to SAMPLE_FPS (30). Callers
   *                      that run the counter at a different rate (e.g. tests
   *                      driving frame-by-frame) can pass an explicit value.
   */
  constructor(
    private readonly thresholdPct: number,
    fps: number = SAMPLE_FPS,
  ) {
    this.msPerFrame = 1000 / fps;
  }

  /**
   * Feed one frame's dark-pixel ratio (0–1). Returns the updated total
   * rotation count.
   *
   * The frame is considered 'dark' when `ratio * 100 >= thresholdPct`,
   * matching the test-tool's `darkPixelRatio * 100 >= thresholdPct` check.
   */
  feed(darkPixelRatio: number): number {
    const newState: MarkState = darkPixelRatio * 100 >= this.thresholdPct ? 'dark' : 'light';
    const prev = this.state;
    this.state = newState;
    this.frameIndex += 1;

    // Count one rotation on the DARK → LIGHT rising edge, subject to the
    // refractory period.
    if (prev === 'dark' && newState === 'light') {
      const elapsedSinceLastMs = (this.frameIndex - this.lastCountedFrame) * this.msPerFrame;
      if (elapsedSinceLastMs >= REFRACTORY_MS) {
        this.rotations += 1;
        this.lastCountedFrame = this.frameIndex;
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

// ---------------------------------------------------------------------------
// Recorded-footage replay — backfill distance from a Frigate clip URL
// ---------------------------------------------------------------------------

export interface ReplayWheelDistanceInput {
  /** Frigate recording clip URL — the /api/<cam>/start/<s>/end/<e>/clip.mp4 form. */
  clipUrl: string;
  diameterMm: number;
  bandX: number;
  bandW: number;
  bandY: number;
  bandH: number;
  thresholdPct: number;
}

/**
 * Run the identical crop→PGM→rotation FSM pipeline over a recorded clip URL.
 * Returns metres (rotations × π × diameter_mm / 1000), or null if ffmpeg fails
 * or produces no frames.
 *
 * This is the ONLY place in the codebase where the odometer state machine runs
 * over recordings. It reuses PgmParser and RotationCounter unchanged — no
 * copy-paste of pixel logic.
 */
export async function replayWheelDistance(input: ReplayWheelDistanceInput): Promise<number | null> {
  return new Promise((resolve) => {
    const counter = new RotationCounter(input.thresholdPct);
    const parser = new PgmParser((ratio) => {
      counter.feed(ratio);
    }, input.thresholdPct);

    // Identical crop filter and sample rate as the live session.
    const rawProc = spawn('ffmpeg', [
      '-y',
      '-i', input.clipUrl,
      '-vf', `crop=iw*${input.bandW}/100:ih*${input.bandH}/100:iw*${input.bandX}/100:ih*${input.bandY}/100,format=gray`,
      '-vsync', 'vfr',
      '-r', String(SAMPLE_FPS),
      '-f', 'image2pipe',
      '-vcodec', 'pgm',
      '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let framesReceived = false;

    rawProc.stdout.on('data', (chunk: Buffer) => {
      framesReceived = true;
      parser.feed(chunk);
    });

    rawProc.stderr.on('data', () => {
      // Swallow ffmpeg progress — errors surface via 'close'.
    });

    rawProc.on('error', (err) => {
      log.warn({ clipUrl: input.clipUrl, err: err.message }, 'wheel-replay: ffmpeg spawn error');
      resolve(null);
    });

    rawProc.on('close', (code) => {
      if (code !== 0) {
        log.warn({ clipUrl: input.clipUrl, code }, 'wheel-replay: ffmpeg exited non-zero');
        resolve(null);
        return;
      }
      if (!framesReceived) {
        log.warn({ clipUrl: input.clipUrl }, 'wheel-replay: ffmpeg produced no frames');
        resolve(null);
        return;
      }
      const rotations = counter.getRotations();
      const metres = rotations * Math.PI * input.diameterMm / 1000;
      log.info({ clipUrl: input.clipUrl, rotations, metres }, 'wheel-replay: complete');
      resolve(metres);
    });
  });
}

// ---------------------------------------------------------------------------
// Live rotation test — bounded RTSP window
// ---------------------------------------------------------------------------

/** Hard lower/upper bound on the test window passed to `liveWheelRotationTest`. */
const LIVE_TEST_MIN_S = 5;
const LIVE_TEST_MAX_S = 30;
/** Kill-timeout safety net: how long after the expected window we force-kill ffmpeg. */
const LIVE_TEST_KILL_GRACE_MS = 5_000;

export interface LiveWheelRotationTestResult {
  rotations: number;
  sampledDurationS: number;
  sampleFps: number;
  framesSampled: number;
  /** Dark-pixel ratio (0–1) per sampled frame, in arrival order. */
  ratioTrace: number[];
  /** The dark-ratio cutoff (0–1): frame is 'dark' when ratio >= thresholdRatio. */
  thresholdRatio: number;
  distanceMeters: number;
  diameterMm: number;
}

/**
 * Sample the live go2rtc RTSP feed for a bounded window and return rotation /
 * distance metrics.
 *
 * Reuses `PgmParser` and `RotationCounter` unchanged (DRY). Runs independently
 * of the persistent `activeSessions` map; go2rtc fans the RTSP stream out so a
 * second reader does not disturb an active odometer session.
 *
 * Throws `FfmpegError` when ffmpeg fails to spawn or exits non-zero.
 * Throws `Error` when the camera is ineligible (not found / no live_src /
 * odometer not enabled).
 */
export async function liveWheelRotationTest(
  cameraId: number,
  durationS: number = 15,
): Promise<LiveWheelRotationTestResult> {
  const clampedS = Math.min(LIVE_TEST_MAX_S, Math.max(LIVE_TEST_MIN_S, durationS));

  const camera = db.getCameraById(cameraId);
  if (!camera) {
    throw new Error(`camera ${cameraId} not found`);
  }
  if (camera.wheel_mark_enabled !== 1) {
    throw new Error('wheel odometer is not enabled for this camera');
  }

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
    throw new Error('camera has no go2rtc live_src / FRIGATE_URL is not configured');
  }

  // thresholdRatio is the dark-ratio cutoff (0..1) exposed to the UI.
  // RotationCounter treats a frame as dark when ratio*100 >= thresholdPct,
  // which is equivalent to ratio >= 1 - thresholdPct/100.
  const thresholdRatio = 1 - thresholdPct / 100;

  return new Promise((resolve, reject) => {
    const counter = new RotationCounter(thresholdPct);
    const ratioTrace: number[] = [];

    // Collect each frame's ratio into the trace AND drive the FSM.
    const parser = new PgmParser((ratio) => {
      ratioTrace.push(ratio);
      counter.feed(ratio);
    }, thresholdPct);

    const startMs = Date.now();

    // `-t clampedS` tells ffmpeg to stop reading after the window.
    // A kill-timeout fires LIVE_TEST_KILL_GRACE_MS later as a safety net.
    const rawProc = spawn('ffmpeg', [
      '-rtsp_transport', 'tcp',
      '-i', rtspUrl,
      '-t', String(clampedS),
      '-vf', `crop=iw*${bandW}/100:ih*${bandH}/100:iw*${bandX}/100:ih*${bandY}/100,format=gray`,
      '-vsync', 'vfr',
      '-r', String(SAMPLE_FPS),
      '-f', 'image2pipe',
      '-vcodec', 'pgm',
      '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const stderrChunks: string[] = [];

    rawProc.stdout.on('data', (chunk: Buffer) => {
      parser.feed(chunk);
    });

    rawProc.stderr.on('data', (chunk: Buffer) => {
      // Collect stderr for error reporting; keep only the last ~2 KB.
      stderrChunks.push(chunk.toString('utf8'));
      if (stderrChunks.length > 40) stderrChunks.shift();
    });

    const killTimer = setTimeout(() => {
      try { rawProc.kill('SIGKILL'); } catch { /* already dead */ }
    }, clampedS * 1000 + LIVE_TEST_KILL_GRACE_MS);

    rawProc.on('error', (err) => {
      clearTimeout(killTimer);
      reject(new FfmpegError(err.message, null, stderrChunks.join('')));
    });

    rawProc.on('close', (code) => {
      clearTimeout(killTimer);

      const sampledDurationS = (Date.now() - startMs) / 1000;

      // ffmpeg exits 0 after -t expires. A signal kill (code=null) can also
      // happen from our safety net; if we got frames it is still a valid result.
      // Reject only on a non-zero integer exit code.
      if (typeof code === 'number' && code !== 0) {
        reject(new FfmpegError(`ffmpeg exited with code ${code}`, code, stderrChunks.join('')));
        return;
      }

      const rotations = counter.getRotations();
      const distanceMeters = rotations * Math.PI * diameterMm / 1000;

      log.info(
        { cameraId, clampedS, rotations, distanceMeters, frames: ratioTrace.length },
        'live-wheel-test: complete',
      );

      resolve({
        rotations,
        sampledDurationS,
        sampleFps: SAMPLE_FPS,
        framesSampled: ratioTrace.length,
        ratioTrace,
        thresholdRatio,
        distanceMeters,
        diameterMm,
      });
    });
  });
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
