// app/server/src/wheel-motion.ts
// Whole-wheel motion-energy detector — replaces the tape-mark rotation-counter.
//
// ARCHITECTURE
// ------------
// One long-lived ffmpeg per camera where `wheel_motion_roi_x IS NOT NULL`.
// Each ffmpeg crops to the configured ROI, samples at SAMPLE_FPS=5 fps,
// and emits raw grayscale PGM frames on stdout. A per-camera state machine
// computes the mean absolute pixel difference (motion_energy, 0–255 scale)
// between consecutive frames and drives an idle ↔ armed cycle:
//
//   idle  → armed   when motion_energy > threshold for ≥ ARMED_DEBOUNCE_MS
//   armed → idle    when motion_energy < threshold for ≥ IDLE_DEBOUNCE_MS
//
// On every armed → idle transition an 'onSession' callback fires with:
//   { cameraId, startedAt, endedAt, peakEnergy, meanEnergy }
//
// The narrator subscribes to sessions, computes distance, and writes/merges
// diary entries. No Frigate zone events are used for wheel detection.
//
// RESTART POLICY
// --------------
// Exponential backoff: initial 5 s → doubles each restart up to 60 s cap.
// Resets to 5 s if the process was alive for > 5 min (healthy-exit heuristic).
//
// MOTION ENERGY FORMULA
// ---------------------
// Given two consecutive greyscale frame buffers A and B of identical size:
//   mean_abs_diff = Σ |A[i] - B[i]| / N
// This is a simple, allocation-free rolling diff that is very sensitive to
// real wheel motion while being insensitive to static scene changes.

import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';

import * as db from './db.js';
import { getConfig } from './config.js';
import { childLogger } from './logger.js';

const log = childLogger('wheel-motion');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sampling rate fed to ffmpeg (-r). 5 fps is enough to catch hamster motion. */
const SAMPLE_FPS = 5;

/**
 * Continuous seconds of energy ABOVE threshold before we declare "armed".
 * 2 s × 5 fps = 10 consecutive above-threshold frames required.
 */
const ARMED_DEBOUNCE_S = 2;
const ARMED_DEBOUNCE_FRAMES = Math.ceil(ARMED_DEBOUNCE_S * SAMPLE_FPS); // 10

/**
 * Continuous seconds of energy BELOW threshold before we declare "idle" again.
 * 5 s × 5 fps = 25 consecutive below-threshold frames required.
 */
const IDLE_DEBOUNCE_S = 5;
const IDLE_DEBOUNCE_FRAMES = Math.ceil(IDLE_DEBOUNCE_S * SAMPLE_FPS); // 25

/** Initial backoff before the first restart attempt (ms). */
const BACKOFF_INITIAL_MS = 5_000;
/** Maximum backoff between restart attempts (ms). */
const BACKOFF_MAX_MS = 60_000;
/** Process uptime floor: if alive longer than this, reset backoff on next exit. */
const BACKOFF_RESET_UPTIME_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A completed wheel-motion session emitted by the state machine. */
export interface WheelMotionSession {
  cameraId: number;
  /** Wall-clock ms when energy first exceeded threshold (start of armed state). */
  startedAt: number;
  /** Wall-clock ms when energy dropped below threshold for IDLE_DEBOUNCE_S. */
  endedAt: number;
  /** Peak motion_energy value observed during this session (0–255 scale). */
  peakEnergy: number;
  /** Mean motion_energy value across all armed-state frames. */
  meanEnergy: number;
}

/** Callback invoked when a wheel-motion session completes (armed → idle). */
export type SessionCallback = (session: WheelMotionSession) => void;

// ---------------------------------------------------------------------------
// PGM parser (reused from wheel-odometer, same PGM format)
// ---------------------------------------------------------------------------

/** Callback receives each complete frame buffer. */
type FrameCallback = (framePixels: Buffer, receivedAtMs: number) => void;

/**
 * Stateful PGM stream parser. Feeds raw bytes from ffmpeg stdout; invokes
 * `onFrame` with the raw pixel buffer (width*height bytes, greyscale 0-255)
 * for each complete frame.
 *
 * PGM binary format (P5):
 *   P5\n<width> <height>\n255\n<width*height bytes>
 */
class PgmFrameParser {
  private buf = Buffer.alloc(0);
  private frameBytes: number | null = null;
  private headerDone = false;

  constructor(private readonly onFrame: FrameCallback) {}

  feed(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    this.drain();
  }

  private drain(): void {
    while (true) {
      if (!this.headerDone) {
        const headerEnd = this.findHeaderEnd();
        if (headerEnd === -1) return;
        const header = this.buf.slice(0, headerEnd).toString('ascii');
        const dims = this.parsePgmHeader(header);
        if (!dims) {
          this.buf = this.buf.slice(headerEnd);
          return;
        }
        this.frameBytes = dims.width * dims.height;
        this.buf = this.buf.slice(headerEnd);
        this.headerDone = true;
      }

      const need = this.frameBytes ?? 0;
      if (this.buf.length < need) return;

      const frameData = this.buf.slice(0, need);
      this.buf = this.buf.slice(need);
      this.headerDone = false;
      this.frameBytes = null;

      this.onFrame(frameData, Date.now());
    }
  }

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
// Motion-energy state machine
// ---------------------------------------------------------------------------

type MotionState = 'idle' | 'armed';

/**
 * Per-camera motion-energy state machine. Consumes greyscale frame buffers
 * and emits sessions on the onSession callback.
 *
 * State transitions:
 *   idle  → armed  after ARMED_DEBOUNCE_FRAMES consecutive above-threshold frames
 *   armed → idle   after IDLE_DEBOUNCE_FRAMES consecutive below-threshold frames
 *
 * This is pure: no I/O, no Date.now() (except via the caller-supplied nowMs
 * argument to feed()), fully testable with synthetic frame streams.
 */
export class MotionEnergyStateMachine {
  private state: MotionState = 'idle';
  private aboveCount = 0;   // consecutive frames above threshold (in idle)
  private belowCount = 0;   // consecutive frames below threshold (in armed)
  private sessionStartMs = 0;
  private sessionPeak = 0;
  private sessionEnergySum = 0;
  private sessionFrameCount = 0;

  /** Latest motion_energy value, updated on every frame. */
  latestEnergy = 0;

  constructor(
    private readonly threshold: number,
    private readonly onSession: SessionCallback,
    private readonly cameraId: number,
  ) {}

  /**
   * Process one frame. `pixels` is the raw greyscale buffer; `prevPixels` is
   * the previous frame (null on first frame — no diff possible). `nowMs` is
   * the wall-clock time at frame receipt.
   */
  feed(pixels: Buffer, prevPixels: Buffer | null, nowMs: number): void {
    // Compute motion_energy: mean absolute pixel difference (0–255 scale).
    // On the first frame (no prev), energy is 0 — state stays idle.
    const energy = prevPixels !== null ? meanAbsDiff(pixels, prevPixels) : 0;
    this.latestEnergy = energy;

    if (this.state === 'idle') {
      if (energy > this.threshold) {
        this.aboveCount += 1;
        if (this.aboveCount >= ARMED_DEBOUNCE_FRAMES) {
          // Transition to armed. Session starts at the first above-threshold
          // frame, which was ARMED_DEBOUNCE_FRAMES-1 frames ago. We use nowMs
          // as a safe approximation (the debounce window is ~2 s, small vs.
          // typical session durations of 30 s+).
          this.state = 'armed';
          this.aboveCount = 0;
          this.belowCount = 0;
          this.sessionStartMs = nowMs;
          this.sessionPeak = energy;
          this.sessionEnergySum = energy;
          this.sessionFrameCount = 1;
          log.debug({ cameraId: this.cameraId, energy, threshold: this.threshold }, 'wheel-motion: idle → armed');
        }
      } else {
        this.aboveCount = 0;
      }
    } else {
      // state === 'armed'
      this.sessionPeak = Math.max(this.sessionPeak, energy);
      this.sessionEnergySum += energy;
      this.sessionFrameCount += 1;

      if (energy <= this.threshold) {
        this.belowCount += 1;
        if (this.belowCount >= IDLE_DEBOUNCE_FRAMES) {
          // Transition back to idle. Session ends at the first below-threshold
          // frame (IDLE_DEBOUNCE_FRAMES-1 frames ago), approximated by nowMs.
          const endedAt = nowMs;
          const meanEnergy = this.sessionFrameCount > 0
            ? this.sessionEnergySum / this.sessionFrameCount
            : 0;

          const session: WheelMotionSession = {
            cameraId: this.cameraId,
            startedAt: this.sessionStartMs,
            endedAt,
            peakEnergy: this.sessionPeak,
            meanEnergy,
          };

          log.debug(
            { cameraId: this.cameraId, durationMs: endedAt - this.sessionStartMs, peakEnergy: this.sessionPeak, meanEnergy },
            'wheel-motion: armed → idle (session complete)',
          );

          this.state = 'idle';
          this.belowCount = 0;
          this.aboveCount = 0;
          this.sessionStartMs = 0;
          this.sessionPeak = 0;
          this.sessionEnergySum = 0;
          this.sessionFrameCount = 0;

          this.onSession(session);
        }
      } else {
        this.belowCount = 0;
      }
    }
  }

  /** Current FSM state — useful for tests and the getWheelMotion query. */
  getState(): MotionState {
    return this.state;
  }
}

// ---------------------------------------------------------------------------
// Mean absolute pixel difference
// ---------------------------------------------------------------------------

/**
 * Compute the mean absolute pixel difference (0–255 scale) between two
 * greyscale frame buffers of equal size. Returns 0 when sizes differ or
 * either buffer is empty.
 */
export function meanAbsDiff(a: Buffer, b: Buffer): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  }
  return sum / a.length;
}

// ---------------------------------------------------------------------------
// Always-on per-camera detector handles
// ---------------------------------------------------------------------------

interface DetectorHandle {
  cameraId: number;
  fsm: MotionEnergyStateMachine;
  parser: PgmFrameParser;
  proc: ChildProcess & { stdout: Readable; stderr: Readable };
  /** Previous frame buffer for diff computation. */
  prevFrame: Buffer | null;
  startedAtMs: number;
  backoffMs: number;
  shuttingDown: boolean;
}

/** Global session callbacks — all subscribers are notified for all cameras. */
const sessionCallbacks = new Set<SessionCallback>();

/** Map of cameraId → running detector handle. */
const detectors = new Map<number, DetectorHandle>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Subscribe to wheel-motion session events. The callback fires after every
 * armed → idle transition on any camera. Callbacks registered before
 * `initWheelMotionDetectors()` will receive events from all cameras.
 */
export function onSession(cb: SessionCallback): void {
  sessionCallbacks.add(cb);
}

/**
 * Deregister a session callback. Primarily used by tests.
 */
export function offSession(cb: SessionCallback): void {
  sessionCallbacks.delete(cb);
}

/**
 * Get the latest sampled motion_energy for a camera (0 when no detector is
 * running for that camera). Used by the `getWheelMotion` tRPC query for the
 * calibration UI live display.
 */
export function getLatestMotionEnergy(cameraId: number): number {
  return detectors.get(cameraId)?.fsm.latestEnergy ?? 0;
}

/**
 * Spawn one long-lived ffmpeg per camera where `wheel_motion_roi_x IS NOT NULL`.
 * Fire-and-forget: returns synchronously; per-camera connections happen in the
 * background. Safe to call with no eligible cameras.
 *
 * Guarantees:
 *   - Does not throw. Per-camera errors are logged and skipped.
 *   - Idempotent: calling twice is a no-op per camera.
 */
export function initWheelMotionDetectors(): void {
  let cameras: db.CameraRow[];
  try {
    cameras = db.listCameras().filter(
      (c) => c.wheel_motion_roi_x !== null && c.wheel_motion_roi_x !== undefined,
    );
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'wheel-motion: failed to query cameras at init — skipping');
    return;
  }

  for (const camera of cameras) {
    if (detectors.has(camera.id)) continue; // Idempotent.
    spawnDetectorForCamera(camera, BACKOFF_INITIAL_MS);
  }

  if (cameras.length > 0) {
    log.info({ count: cameras.length, cameraIds: cameras.map((c) => c.id) }, 'wheel-motion detectors initialised');
  }
}

/**
 * Gracefully stop all wheel-motion detector processes. Called at shutdown.
 * Guarantees:
 *   - Does not throw.
 *   - After this returns, no new ffmpeg processes will be spawned.
 */
export function shutdownWheelMotionDetectors(): void {
  for (const handle of detectors.values()) {
    handle.shuttingDown = true;
    try {
      handle.proc.kill('SIGTERM');
    } catch {
      // Process may already be dead.
    }
  }
  detectors.clear();
  log.info('wheel-motion detectors shut down');
}

/**
 * Restart the detector for a specific camera (e.g. after a `setWheelMotion`
 * config change). Kills the existing process, then re-reads the camera row
 * and spawns a fresh process. No-op if the camera has no ROI configured.
 */
export function restartDetectorForCamera(cameraId: number): void {
  const existing = detectors.get(cameraId);
  if (existing) {
    existing.shuttingDown = true;
    try {
      existing.proc.kill('SIGTERM');
    } catch {
      // Already dead.
    }
    detectors.delete(cameraId);
  }

  const camera = db.getCameraById(cameraId);
  if (!camera || camera.wheel_motion_roi_x === null || camera.wheel_motion_roi_x === undefined) {
    log.info({ cameraId }, 'wheel-motion: restartDetectorForCamera — no ROI configured, skipping');
    return;
  }

  spawnDetectorForCamera(camera, BACKOFF_INITIAL_MS);
  log.info({ cameraId }, 'wheel-motion: detector restarted after config change');
}

// ---------------------------------------------------------------------------
// Internal: RTSP URL construction (same as wheel-odometer)
// ---------------------------------------------------------------------------

function wheelRtspUrl(liveSrc: string | null): string | null {
  if (!liveSrc) return null;
  const cfg = getConfig();
  if (!cfg.FRIGATE_URL) return null;
  return `rtsp://${new URL(cfg.FRIGATE_URL).hostname}:8554/${liveSrc}`;
}

// ---------------------------------------------------------------------------
// Internal: spawn and restart logic
// ---------------------------------------------------------------------------

function spawnDetectorForCamera(camera: db.CameraRow, backoffMs: number): void {
  const {
    id: cameraId,
    live_src,
    wheel_motion_roi_x: roiX,
    wheel_motion_roi_y: roiY,
    wheel_motion_roi_w: roiW,
    wheel_motion_roi_h: roiH,
    wheel_motion_threshold: threshold,
  } = camera;

  // Type-narrow: all four ROI fields must be non-null (already filtered at
  // call sites, but guard here so TypeScript is happy and we never spawn with
  // a malformed crop filter).
  if (roiX === null || roiX === undefined ||
      roiY === null || roiY === undefined ||
      roiW === null || roiW === undefined ||
      roiH === null || roiH === undefined) {
    log.warn({ cameraId }, 'wheel-motion: ROI incomplete — skipping camera');
    return;
  }

  const rtspUrl = wheelRtspUrl(live_src);
  if (!rtspUrl) {
    log.warn({ cameraId, live_src }, 'wheel-motion: no live_src / FRIGATE_URL — camera skipped');
    return;
  }

  // The crop filter uses percentage expressions so the actual pixel dimensions
  // are resolved by ffmpeg from the input stream. Format: W:H:X:Y.
  const cropFilter = `crop=iw*${roiW}/100:ih*${roiH}/100:iw*${roiX}/100:ih*${roiY}/100,fps=${SAMPLE_FPS},format=gray`;

  const rawProc = spawn('ffmpeg', [
    '-rtsp_transport', 'tcp',
    '-i', rtspUrl,
    '-vf', cropFilter,
    '-vsync', 'vfr',
    '-f', 'image2pipe',
    '-vcodec', 'pgm',
    '-',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const proc = rawProc as DetectorHandle['proc'];

  const startedAtMs = Date.now();

  const fsm = new MotionEnergyStateMachine(
    threshold,
    (session) => {
      for (const cb of sessionCallbacks) {
        try {
          cb(session);
        } catch (err) {
          log.error({ err: (err as Error).message, cameraId }, 'wheel-motion: session callback threw');
        }
      }
    },
    cameraId,
  );

  const handle: DetectorHandle = {
    cameraId,
    fsm,
    parser: new PgmFrameParser((framePixels, receivedAtMs) => {
      const prev = handle.prevFrame;
      handle.prevFrame = framePixels;
      handle.fsm.feed(framePixels, prev, receivedAtMs);
    }),
    proc,
    prevFrame: null,
    startedAtMs,
    backoffMs,
    shuttingDown: false,
  };
  detectors.set(cameraId, handle);

  proc.stdout.on('data', (chunk: Buffer) => {
    handle.parser.feed(chunk);
  });

  proc.stderr.on('data', () => {
    // Swallow ffmpeg's progress output; errors surface via 'close'.
  });

  proc.on('error', (err) => {
    log.warn({ cameraId, err: err.message }, 'wheel-motion: ffmpeg spawn error');
    scheduleRestart(cameraId, camera, handle);
  });

  proc.on('close', (code) => {
    if (handle.shuttingDown) return;
    log.warn({ cameraId, code }, 'wheel-motion: ffmpeg exited unexpectedly');
    scheduleRestart(cameraId, camera, handle);
  });

  log.info({ cameraId, rtspUrl, roiX, roiY, roiW, roiH, threshold, sampleFps: SAMPLE_FPS }, 'wheel-motion: detector started');
}

function scheduleRestart(
  cameraId: number,
  camera: db.CameraRow,
  handle: DetectorHandle,
): void {
  if (handle.shuttingDown) return;
  detectors.delete(cameraId);

  const uptimeMs = Date.now() - handle.startedAtMs;
  const nextBackoff = uptimeMs >= BACKOFF_RESET_UPTIME_MS
    ? BACKOFF_INITIAL_MS
    : Math.min(handle.backoffMs * 2, BACKOFF_MAX_MS);

  log.info({ cameraId, backoffMs: handle.backoffMs, nextBackoff }, 'wheel-motion: scheduling restart');

  const timer = setTimeout(() => {
    const freshCamera = db.getCameraById(cameraId);
    if (
      !freshCamera ||
      freshCamera.wheel_motion_roi_x === null ||
      freshCamera.wheel_motion_roi_x === undefined
    ) {
      log.info({ cameraId }, 'wheel-motion: camera no longer eligible — skipping restart');
      return;
    }
    spawnDetectorForCamera(freshCamera, nextBackoff);
  }, handle.backoffMs);
  timer.unref?.();
}

// ---------------------------------------------------------------------------
// Test helpers — not exported in production surface; used by tests only.
// ---------------------------------------------------------------------------

/** Direct access to the detector map (for tests). */
export { detectors as _detectors };

/** Clear all detector state. Used by tests to ensure isolation. */
export function resetDetectorsForTests(): void {
  for (const handle of detectors.values()) {
    handle.shuttingDown = true;
    try { handle.proc.kill('SIGTERM'); } catch { /* already dead */ }
  }
  detectors.clear();
  sessionCallbacks.clear();
}
