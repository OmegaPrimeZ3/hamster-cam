// app/server/src/wheel-odometer.ts
// Optical-mark wheel odometry — Approach B, always-on per-camera model.
//
// The operator sticks a piece of black tape on the wheel rim. On app startup
// `initWheelOdometers()` spawns one long-lived ffmpeg per camera that has
// wheel_mark_enabled=1. Each ffmpeg reads the camera's RTSP feed continuously
// at 30 fps, crops to the configured 2-D ROI box, and emits raw grayscale PGM
// frames on stdout. A finite-state machine counts rotations using edge
// detection with a refractory period:
//
//   LIGHT → DARK  (falling edge, confirmed by ≥1 dark frame)
//   DARK  → LIGHT (rising edge) = one rotation counted
//   then lock out the counter for REFRACTORY_MS to reject flicker /
//   contact-bounce / a marker parked in the box.
//
// At 30 fps a real tape pass lasts ~1–3 frames; the refractory period of
// 150 ms ≈ 4.5 frames reliably rejects sub-100 ms noise while allowing up
// to ~6.7 rps.
//
// ALWAYS-ON COUNTER SEMANTICS
// ---------------------------
// Each camera has a monotonically increasing `rotations` counter that lives
// for the lifetime of the ffmpeg process. When ffmpeg exits or crashes, the
// counter resets to 0 and an internal `epoch` integer increments. Callers
// can detect a mid-visit restart via `computeWheelDelta`:
//
//   getRotationSnapshot(cameraId)  → { rotations, epoch, captureMs } | null
//   computeWheelDelta(start, end)  → { rotations, metres, epochCrossed }
//
// The narrator takes an opening snapshot when a wheel zone visit opens, and
// a closing snapshot when it closes. The delta gives the distance run during
// that visit — without spawning or tearing down any ffmpeg per-event.
//
// RESTART POLICY
// --------------
// On ffmpeg exit, the odometer restarts with exponential backoff:
//   initial 5 s → doubles each restart up to 60 s cap.
//   If the process was alive for > 5 minutes, backoff resets to 5 s.
//
// REUSABLE STATE MACHINE (DRY)
// ----------------------------
// PgmParser and RotationCounter are the pure, exported units. The always-on
// path feeds them from an RTSP ffmpeg pipe. The backfill path
// (replayWheelDistance) feeds them from a Frigate recording clip URL using
// the identical crop filter and sample rate. The live rotation test
// (liveWheelRotationTest) also uses them unchanged. Neither path duplicates
// any per-pixel or FSM logic.

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

/** Initial backoff before the first restart attempt (ms). */
const BACKOFF_INITIAL_MS = 5_000;

/** Maximum backoff between restart attempts (ms). */
const BACKOFF_MAX_MS = 60_000;

/**
 * If the ffmpeg process was alive for at least this long before exiting, the
 * backoff resets to BACKOFF_INITIAL_MS — the feed was healthy, the exit is
 * probably a transient network hiccup rather than a persistent config error.
 */
const BACKOFF_RESET_UPTIME_MS = 5 * 60 * 1000;

/** Kill-timeout safety net: how long after the expected window we force-kill ffmpeg in the live test. */
const LIVE_TEST_KILL_GRACE_MS = 5_000;

/** Hard lower/upper bound on the test window passed to `liveWheelRotationTest`. */
const LIVE_TEST_MIN_S = 5;
const LIVE_TEST_MAX_S = 30;

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
// Rotation snapshot — the currency of the always-on API
// ---------------------------------------------------------------------------

/**
 * A point-in-time snapshot of a camera's cumulative rotation counter. The
 * narrator takes one snapshot when a wheel visit opens and another when it
 * closes; `computeWheelDelta` converts the pair into rotations and metres.
 */
export interface RotationSnapshot {
  /** Cumulative rotations counted since the current ffmpeg epoch started. */
  rotations: number;
  /**
   * Monotonically increasing integer that increments every time the ffmpeg
   * process restarts. Two snapshots with different epochs cannot be directly
   * subtracted — `computeWheelDelta` handles this case by returning only the
   * post-restart partial count.
   */
  epoch: number;
  /** Wall-clock ms (Date.now()) when this snapshot was captured. */
  captureMs: number;
}

/**
 * Result of `computeWheelDelta`. When `epochCrossed` is true the odometer
 * restarted between the two snapshots and only the post-restart partial count
 * is available — the narrator logs this but still persists the partial count
 * so a real wheel run is never silently discarded.
 */
export interface WheelDelta {
  rotations: number;
  metres: number;
  epochCrossed: boolean;
}

// ---------------------------------------------------------------------------
// Always-on per-camera odometer handles
// ---------------------------------------------------------------------------

/** Per-camera always-on state — one entry per wheel-enabled camera. */
interface OdometerHandle {
  cameraId: number;
  counter: RotationCounter;
  parser: PgmParser;
  proc: ChildProcess & { stdout: Readable; stderr: Readable };
  /** Monotonically increasing; increments each time ffmpeg restarts. */
  epoch: number;
  /** Wall-clock ms when the current process started. Used for backoff reset logic. */
  startedAtMs: number;
  /** Current exponential backoff delay in ms. */
  backoffMs: number;
  /** diameterMm from the camera row — constant for the life of the handle. */
  diameterMm: number;
  /**
   * True while a graceful shutdown is in progress. When set, the 'close'
   * handler does NOT schedule a restart.
   */
  shuttingDown: boolean;
}

/** Map of cameraId → always-on odometer handle. */
const alwaysOnOdometers = new Map<number, OdometerHandle>();

// ---------------------------------------------------------------------------
// Public always-on API
// ---------------------------------------------------------------------------

/**
 * Spawn one long-lived ffmpeg per wheel-enabled camera and start the always-on
 * odometers. Called from `index.ts` at app startup (fire-and-forget: this
 * function returns synchronously; each ffmpeg connects in the background).
 * Safe to call when no cameras have wheel_mark_enabled=1.
 *
 * Guarantees:
 *   - Does not throw. Any per-camera error is logged and skipped.
 *   - Does not block startup. ffmpeg connections happen asynchronously.
 *   - Idempotent: calling a second time is a no-op per camera.
 */
export function initWheelOdometers(): void {
  let cameras: db.CameraRow[];
  try {
    cameras = db.listCameras().filter((c) => c.wheel_mark_enabled === 1);
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'wheel-odometer: failed to query cameras at init — skipping');
    return;
  }

  for (const camera of cameras) {
    if (alwaysOnOdometers.has(camera.id)) continue; // Idempotent.
    spawnOdometerForCamera(camera, BACKOFF_INITIAL_MS, 0);
  }

  if (cameras.length > 0) {
    log.info({ count: cameras.length, cameraIds: cameras.map((c) => c.id) }, 'wheel-odometers initialised');
  }
}

/**
 * Gracefully stop all always-on odometer processes. Called from `index.ts`
 * on SIGTERM/SIGINT. Synchronous kill; the processes die asynchronously but
 * we set `shuttingDown` first so the 'close' handler does not reschedule.
 *
 * Guarantees:
 *   - Does not throw.
 *   - After this returns, no new ffmpeg processes will be spawned.
 */
export function shutdownWheelOdometers(): void {
  for (const handle of alwaysOnOdometers.values()) {
    handle.shuttingDown = true;
    try {
      handle.proc.kill('SIGTERM');
    } catch {
      // Process may already be dead.
    }
  }
  alwaysOnOdometers.clear();
  log.info('wheel-odometers shut down');
}

/**
 * Returns a point-in-time rotation snapshot for the given camera, or null if
 * no always-on odometer is running for that camera (wheel disabled, camera not
 * found, or initWheelOdometers not yet called).
 *
 * Guarantees:
 *   - Never throws.
 *   - Returns null (not zero) so callers can distinguish "disabled" from
 *     "running but nothing counted yet".
 */
export function getRotationSnapshot(cameraId: number): RotationSnapshot | null {
  const handle = alwaysOnOdometers.get(cameraId);
  if (!handle) return null;
  return {
    rotations: handle.counter.getRotations(),
    epoch: handle.epoch,
    captureMs: Date.now(),
  };
}

/**
 * Compute the wheel delta between an opening and closing snapshot.
 *
 * When `start.epoch === end.epoch`, the delta is `end.rotations - start.rotations`
 * (which may be 0 if the wheel did not move during the visit).
 *
 * When epochs differ (the ffmpeg restarted mid-visit), the counter was reset
 * to 0 at restart. We return `end.rotations` as the post-restart partial count
 * and set `epochCrossed: true`. The caller may log this to help diagnose an
 * unstable RTSP feed.
 *
 * The metres formula: rotations × π × diameterMm / 1000. diameterMm must be
 * provided by the caller (from the camera row) because this function is pure.
 *
 * Guarantees:
 *   - Never throws.
 *   - rotations result is always ≥ 0.
 */
export function computeWheelDelta(
  start: RotationSnapshot,
  end: RotationSnapshot,
  diameterMm: number,
): WheelDelta {
  const epochCrossed = start.epoch !== end.epoch;
  const rotations = epochCrossed
    ? end.rotations                          // post-restart partial count only
    : Math.max(0, end.rotations - start.rotations);
  const metres = rotations * Math.PI * diameterMm / 1000;
  return { rotations, metres, epochCrossed };
}

// ---------------------------------------------------------------------------
// Internal: spawn and restart logic
// ---------------------------------------------------------------------------

/**
 * Spawn an ffmpeg odometer process for one camera and register its handle.
 * Automatically restarts with exponential backoff on unexpected exit.
 *
 * Not exported — called by `initWheelOdometers` and by the restart scheduler.
 */
function spawnOdometerForCamera(
  camera: db.CameraRow,
  backoffMs: number,
  epoch: number,
): void {
  const {
    id: cameraId,
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
    log.warn({ cameraId, live_src }, 'wheel-odometer: no live_src / FRIGATE_URL — camera skipped');
    return;
  }

  const counter = new RotationCounter(thresholdPct);
  const parser = new PgmParser((ratio) => {
    counter.feed(ratio);
  }, thresholdPct);

  // ffmpeg crops to the band and emits grayscale PGM frames on stdout.
  // We use `ih*bandH/100` arithmetic inside the crop filter expression.
  // `-vsync vfr` avoids duplicate frames on slow streams.
  //
  // We cast the result to our handle proc type because TypeScript's
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
  const proc = rawProc as OdometerHandle['proc'];

  const startedAtMs = Date.now();

  const handle: OdometerHandle = {
    cameraId,
    counter,
    parser,
    proc,
    epoch,
    startedAtMs,
    backoffMs,
    diameterMm,
    shuttingDown: false,
  };
  alwaysOnOdometers.set(cameraId, handle);

  proc.stdout.on('data', (chunk: Buffer) => {
    parser.feed(chunk);
  });

  proc.stderr.on('data', () => {
    // Swallow ffmpeg's progress output; errors surface via 'close'.
  });

  proc.on('error', (err) => {
    log.warn({ cameraId, err: err.message }, 'wheel-odometer: ffmpeg spawn error');
    scheduleRestart(cameraId, camera, handle);
  });

  proc.on('close', (code) => {
    if (handle.shuttingDown) return; // Expected — no restart.
    log.warn({ cameraId, code }, 'wheel-odometer: ffmpeg exited unexpectedly');
    scheduleRestart(cameraId, camera, handle);
  });

  log.info({ cameraId, rtspUrl, bandX, bandW, bandY, bandH, thresholdPct, epoch }, 'wheel-odometer: started');
}

/**
 * Schedule a restart for a camera whose ffmpeg process exited unexpectedly.
 * Applies exponential backoff; resets backoff if the process had >5 min uptime.
 */
function scheduleRestart(
  cameraId: number,
  camera: db.CameraRow,
  handle: OdometerHandle,
): void {
  if (handle.shuttingDown) return;
  // Remove the dead handle so getRotationSnapshot returns null during the gap.
  alwaysOnOdometers.delete(cameraId);

  const uptimeMs = Date.now() - handle.startedAtMs;
  const nextBackoff = uptimeMs >= BACKOFF_RESET_UPTIME_MS
    ? BACKOFF_INITIAL_MS
    : Math.min(handle.backoffMs * 2, BACKOFF_MAX_MS);

  log.info({ cameraId, backoffMs: handle.backoffMs, nextBackoff }, 'wheel-odometer: scheduling restart');

  const timer = setTimeout(() => {
    // Re-read the camera row in case config changed since startup.
    const freshCamera = db.getCameraById(cameraId);
    if (!freshCamera || freshCamera.wheel_mark_enabled !== 1) {
      log.info({ cameraId }, 'wheel-odometer: camera no longer eligible — skipping restart');
      return;
    }
    spawnOdometerForCamera(freshCamera, nextBackoff, handle.epoch + 1);
  }, handle.backoffMs);
  timer.unref?.();
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
 * of the persistent `alwaysOnOdometers` map; go2rtc fans the RTSP stream out so a
 * second reader does not disturb an active odometer.
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

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Direct access to the always-on odometer map for tests that need to inspect
 * or inject fake handles. Tests should NOT mutate this map directly in
 * production paths — only via the public API.
 */
export { alwaysOnOdometers as _alwaysOnOdometers };

/**
 * Reset all always-on odometer state. Used by tests to ensure isolation.
 * Kills any running processes cleanly.
 */
export function resetOdometersForTests(): void {
  for (const handle of alwaysOnOdometers.values()) {
    handle.shuttingDown = true;
    try { handle.proc.kill('SIGTERM'); } catch { /* already dead */ }
  }
  alwaysOnOdometers.clear();
}
