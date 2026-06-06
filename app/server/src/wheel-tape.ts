// app/server/src/wheel-tape.ts
// Tape-crossing detector with adaptive brightness thresholding.
//
// ARCHITECTURE
// ------------
// One long-lived ffmpeg per camera where `wheel_motion_roi_x IS NOT NULL`.
// Each ffmpeg crops to a wide horizontal STRIP ROI at 30 fps and emits raw
// grayscale PGM frames on stdout. Per frame, the module computes the mean
// brightness of the strip to produce a continuous brightness time-series.
//
// DIP DETECTION (adaptive threshold)
// -----------------------------------
// A Welford rolling window over the last 150 samples (5 s at 30 fps) tracks
// the mean μ and standard deviation σ of the brightness signal. A "dip event"
// fires when:
//
//   brightness[t] < μ - sensitivity × σ
//   AND it has been ≥ 150 ms since the previous dip (refractory period)
//
// Each dip = one wheel rotation.
//
// SESSION STATE MACHINE
// ---------------------
//   idle  → active  on first dip (after idle_timeout since last dip)
//   active → idle   when no dip has been seen for 15 s (IDLE_TIMEOUT_MS)
//
// On idle transition an 'onSession' callback fires with:
//   { cameraId, startedAt, endedAt, rotations, meanRps, peakRps }
//
// LIVE SIGNAL BUFFER
// ------------------
// Each camera maintains a 10 s ring buffer of brightness samples (300 at
// 30 fps) and a 60 s ring buffer of dip timestamps. getLiveSignal() returns
// the current buffer state so the UI can render an oscilloscope.
//
// RESTART POLICY
// --------------
// Exponential backoff: initial 5 s → doubles each restart up to 60 s cap.
// Resets to 5 s if the process was alive for > 5 min (healthy-exit heuristic).

import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';

import * as db from './db.js';
import { getConfig } from './config.js';
import { childLogger } from './logger.js';

const log = childLogger('wheel-tape');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Frames per second fed to ffmpeg. 30 fps is the native camera rate. */
const SAMPLE_FPS = 30;

/**
 * Welford rolling window size (samples). 150 samples = 5 s at 30 fps.
 * Governs how quickly the adaptive threshold tracks slow brightness drift.
 */
const WELFORD_WINDOW = 150;

/**
 * Minimum effective std used when computing the dip threshold. Prevents the
 * detector from being hair-trigger when the brightness signal is very stable
 * (std ≈ 0). At sensitivity=2.0 this means the dip must be at least
 * 2×MIN_STD_FLOOR = 6 brightness units below the rolling mean — a floor
 * that corresponds to ~2% of the 0–255 scale, safely above typical camera noise.
 */
const MIN_STD_FLOOR = 5.0;

/**
 * Minimum milliseconds between two dip events (refractory period).
 * 150 ms at 30 fps ≈ 4.5 frames — prevents double-counting a single tape pass.
 */
const REFRACTORY_MS = 150;

/**
 * Seconds of no-dip activity before an active session is declared ended.
 * 15 s is longer than any realistic inter-rotation gap at normal running speed.
 */
const IDLE_TIMEOUT_MS = 15_000;

/** Initial backoff before the first restart attempt (ms). */
const BACKOFF_INITIAL_MS = 5_000;
/** Maximum backoff between restart attempts (ms). */
const BACKOFF_MAX_MS = 60_000;
/** Process uptime floor: if alive longer than this, reset backoff on next exit. */
const BACKOFF_RESET_UPTIME_MS = 5 * 60 * 1000;

/** Live brightness ring buffer: 10 s × 30 fps = 300 samples. */
const LIVE_BUFFER_SAMPLES = 300;
/** Recent dip timestamp ring buffer: last 60 s. */
const DIP_RING_SECONDS = 60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A completed wheel tape session emitted by the state machine. */
export interface WheelTapeSession {
  cameraId: number;
  /** Wall-clock ms when the first dip was detected (session start). */
  startedAt: number;
  /** Wall-clock ms when the session was declared idle (last dip + IDLE_TIMEOUT_MS). */
  endedAt: number;
  /** Total rotation count for this session. */
  rotations: number;
  /** Mean rotations per second over the session duration. */
  meanRps: number;
  /** Peak rotations-per-second observed (max in any 1-second window). */
  peakRps: number;
}

/** Callback invoked when a wheel tape session completes. */
export type SessionCallback = (session: WheelTapeSession) => void;

/**
 * Snapshot of the live signal state for a running detector.
 * Returned by getLiveSignal(); consumed by the tRPC getWheelTape query.
 */
export interface LiveSignal {
  /** Last ~300 brightness values (0–255). Oldest first. */
  samples: number[];
  /** Approximate ms between samples at the current frame rate. */
  sampleMs: number;
  /** Current rolling mean brightness. */
  mean: number;
  /** Current rolling standard deviation. */
  std: number;
  /** Adaptive dip threshold = mean - sensitivity × std. */
  threshold: number;
  /** Wall-clock ms of dip events in the last 30 s. */
  recentDips: number[];
  /** Number of dips in the last 30 s. */
  rotationsLast30s: number;
  /** Mean rotation rate (rps) over the last 5 s of detected dips. */
  rotationRateRps: number;
}

// ---------------------------------------------------------------------------
// PGM stream parser — reused from wheel-motion.ts (same wire format)
// ---------------------------------------------------------------------------

type FrameCallback = (framePixels: Buffer, receivedAtMs: number) => void;

/**
 * Stateful PGM stream parser. Feeds raw bytes from ffmpeg stdout; invokes
 * `onFrame` with the raw pixel buffer (width×height bytes, greyscale 0–255)
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
// Brightness signal — Welford rolling stats + dip detection
// ---------------------------------------------------------------------------

/**
 * Per-camera brightness signal processor.
 *
 * Responsibilities:
 *   1. Compute mean brightness of each frame buffer.
 *   2. Maintain an exact rolling mean/std over the last WELFORD_WINDOW samples
 *      using a circular buffer with two-pass recalculation. The buffer is only
 *      150 entries (5 s at 30 fps) so O(N) per frame is negligible (~150 adds).
 *   3. Detect dip events (brightness < mean - sensitivity × std) with refractory.
 *   4. Maintain a 10 s live ring buffer for the UI oscilloscope.
 *   5. Maintain a 60 s dip ring buffer for recent-dip queries.
 *   6. Maintain per-second rotation counts for peakRps calculation.
 *
 * This class is pure (no I/O). Time is injected via `nowMs` arguments so tests
 * can control the clock precisely.
 */
export class BrightnessSignal {
  // Circular sample buffer for exact rolling stats.
  private readonly windowBuffer: number[] = [];

  // Live ring buffer (300 samples → 10 s at 30 fps).
  private readonly liveBuffer: number[] = [];

  // Dip ring buffer: timestamps of dips in the last 60 s.
  private readonly dipBuffer: number[] = [];

  // Refractory: wall-clock ms of the last accepted dip.
  private lastDipMs = -Infinity;

  // Per-second rotation windows for peakRps.
  // Each entry: { windowStart: ms, count: number }
  private readonly secondWindows: Array<{ windowStart: number; count: number }> = [];

  // Cached rolling stats — recomputed from windowBuffer after every update.
  private _mean = 0;
  private _std = 0;

  constructor(private readonly sensitivity: number) {}

  /**
   * Process one frame buffer. `nowMs` is the wall-clock time at frame receipt.
   * Returns true when a dip event fires (one rotation counted).
   */
  feed(pixels: Buffer, nowMs: number): boolean {
    const brightness = meanBrightness(pixels);

    // Update live ring buffer.
    this.liveBuffer.push(brightness);
    while (this.liveBuffer.length > LIVE_BUFFER_SAMPLES) this.liveBuffer.shift();

    // Update circular window buffer for rolling stats.
    this.windowBuffer.push(brightness);
    if (this.windowBuffer.length > WELFORD_WINDOW) {
      this.windowBuffer.shift();
    }

    // Recompute exact mean and std from the window buffer.
    this.recomputeStats();

    // Dip detection: brightness below adaptive threshold?
    // Apply a minimum std floor so the detector isn't hair-trigger when the
    // signal is constant (std ≈ 0). The floor requires a dip to be at least
    // sensitivity × MIN_STD_FLOOR brightness units below the rolling mean.
    const effectiveStd = Math.max(this._std, MIN_STD_FLOOR);
    const threshold = this._mean - this.sensitivity * effectiveStd;
    const inRefractory = nowMs - this.lastDipMs < REFRACTORY_MS;
    const isDip = brightness < threshold && !inRefractory && this.windowBuffer.length >= 5;

    if (isDip) {
      this.lastDipMs = nowMs;
      // Add to 60 s dip ring buffer.
      this.dipBuffer.push(nowMs);
      const cutoff60 = nowMs - DIP_RING_SECONDS * 1000;
      while (this.dipBuffer.length > 0 && (this.dipBuffer[0] ?? 0) < cutoff60) {
        this.dipBuffer.shift();
      }
      // Track per-second window for peakRps.
      const secWindowStart = Math.floor(nowMs / 1000) * 1000;
      const lastWindow = this.secondWindows[this.secondWindows.length - 1];
      if (lastWindow && lastWindow.windowStart === secWindowStart) {
        lastWindow.count += 1;
      } else {
        this.secondWindows.push({ windowStart: secWindowStart, count: 1 });
        // Keep only last 70 s of windows.
        const cutoff70 = nowMs - 70_000;
        while (this.secondWindows.length > 0 && (this.secondWindows[0]?.windowStart ?? 0) < cutoff70) {
          this.secondWindows.shift();
        }
      }
    }

    return isDip;
  }

  /** Recompute mean and std from windowBuffer (two-pass, exact). */
  private recomputeStats(): void {
    const n = this.windowBuffer.length;
    if (n === 0) { this._mean = 0; this._std = 0; return; }

    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += this.windowBuffer[i] ?? 0;
    const mean = sum / n;

    let sumSq = 0;
    for (let i = 0; i < n; i += 1) {
      const d = (this.windowBuffer[i] ?? 0) - mean;
      sumSq += d * d;
    }
    this._mean = mean;
    this._std = n > 1 ? Math.sqrt(sumSq / (n - 1)) : 0;
  }

  /** Current rolling mean (0–255). */
  getMean(): number {
    return this._mean;
  }

  /** Current rolling standard deviation. */
  getStd(): number {
    return this._std;
  }

  /** Adaptive dip threshold = mean - sensitivity × max(std, MIN_STD_FLOOR). */
  getThreshold(): number {
    return this._mean - this.sensitivity * Math.max(this._std, MIN_STD_FLOOR);
  }

  /**
   * Returns dip timestamps within the last `windowMs` milliseconds.
   * Default: last 30 s.
   */
  getRecentDips(nowMs: number, windowMs = 30_000): number[] {
    const cutoff = nowMs - windowMs;
    return this.dipBuffer.filter((t) => t >= cutoff);
  }

  /**
   * Mean rotation rate (rps) measured over the last `windowMs` milliseconds.
   * Default: last 5 s.
   */
  getRotationRateRps(nowMs: number, windowMs = 5_000): number {
    const recentDips = this.getRecentDips(nowMs, windowMs);
    return recentDips.length / (windowMs / 1000);
  }

  /** Peak rotations per second across all tracked 1 s windows in the last 60 s. */
  getPeakRps(nowMs: number): number {
    const cutoff = nowMs - 60_000;
    let peak = 0;
    for (const w of this.secondWindows) {
      if (w.windowStart >= cutoff) {
        peak = Math.max(peak, w.count);
      }
    }
    return peak;
  }

  /** Snapshot of the live buffer state. */
  getLiveSnapshot(nowMs: number): {
    samples: number[];
    sampleMs: number;
    mean: number;
    std: number;
    threshold: number;
    recentDips: number[];
    rotationsLast30s: number;
    rotationRateRps: number;
  } {
    const dips30 = this.getRecentDips(nowMs, 30_000);
    return {
      samples: [...this.liveBuffer],
      sampleMs: Math.round(1000 / SAMPLE_FPS),
      mean: this.getMean(),
      std: this.getStd(),
      threshold: this.getThreshold(),
      recentDips: dips30,
      rotationsLast30s: dips30.length,
      rotationRateRps: this.getRotationRateRps(nowMs),
    };
  }
}

// ---------------------------------------------------------------------------
// Session state machine
// ---------------------------------------------------------------------------

type SessionState = 'idle' | 'active';

/**
 * Per-camera session state machine. Consumes dip events from BrightnessSignal
 * and emits completed sessions when the idle timeout fires.
 *
 * This is pure: no I/O, fully testable with synthetic dip sequences.
 */
export class TapeSessionMachine {
  private sessionState: SessionState = 'idle';
  private sessionStartMs = 0;
  private sessionRotations = 0;
  private lastDipMs = 0;
  /** Timestamps of all dips in the current active session (for rps calc). */
  private sessionDipTimes: number[] = [];
  /** Scheduled idle timer handle. */
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly cameraId: number,
    private readonly onSession: SessionCallback,
  ) {}

  /**
   * Notify the state machine that a dip event occurred at `nowMs`.
   * Returns true when a new session was started.
   */
  onDip(nowMs: number): boolean {
    const wasIdle = this.sessionState === 'idle';

    if (wasIdle) {
      this.sessionState = 'active';
      this.sessionStartMs = nowMs;
      this.sessionRotations = 0;
      this.sessionDipTimes = [];
      log.debug({ cameraId: this.cameraId }, 'wheel-tape: idle → active (session started)');
    }

    // Cancel the current idle timer — we just got a dip.
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    this.sessionRotations += 1;
    this.sessionDipTimes.push(nowMs);
    this.lastDipMs = nowMs;

    // Arm a new idle timer.
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.endSession(this.lastDipMs + IDLE_TIMEOUT_MS);
    }, IDLE_TIMEOUT_MS);
    this.idleTimer.unref?.();

    return wasIdle;
  }

  private endSession(endedAt: number): void {
    if (this.sessionState !== 'active') return;

    const rotations = this.sessionRotations;
    const durationS = (endedAt - this.sessionStartMs) / 1000;
    const meanRps = durationS > 0 ? rotations / durationS : 0;

    // PeakRps: max rotations in any 1 s window within the session.
    const peakRps = this.computePeakRps();

    const session: WheelTapeSession = {
      cameraId: this.cameraId,
      startedAt: this.sessionStartMs,
      endedAt,
      rotations,
      meanRps,
      peakRps,
    };

    log.debug(
      { cameraId: this.cameraId, rotations, durationS, meanRps, peakRps },
      'wheel-tape: active → idle (session complete)',
    );

    this.sessionState = 'idle';
    this.sessionRotations = 0;
    this.sessionStartMs = 0;
    this.sessionDipTimes = [];

    this.onSession(session);
  }

  private computePeakRps(): number {
    if (this.sessionDipTimes.length === 0) return 0;
    const windows = new Map<number, number>();
    for (const t of this.sessionDipTimes) {
      const sec = Math.floor(t / 1000);
      windows.set(sec, (windows.get(sec) ?? 0) + 1);
    }
    let peak = 0;
    for (const count of windows.values()) {
      peak = Math.max(peak, count);
    }
    return peak;
  }

  /** Force-end the current session immediately (used on detector shutdown). */
  forceEnd(nowMs: number): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.sessionState === 'active') {
      this.endSession(nowMs);
    }
  }

  getState(): SessionState {
    return this.sessionState;
  }
}

// ---------------------------------------------------------------------------
// Mean brightness (average of all pixel values in a grayscale frame buffer)
// ---------------------------------------------------------------------------

/**
 * Compute the mean brightness (0–255) of a greyscale frame buffer.
 * Returns 128 (mid-grey) for empty buffers.
 */
export function meanBrightness(pixels: Buffer): number {
  if (pixels.length === 0) return 128;
  let sum = 0;
  for (let i = 0; i < pixels.length; i += 1) {
    sum += pixels[i] ?? 0;
  }
  return sum / pixels.length;
}

// ---------------------------------------------------------------------------
// Always-on per-camera detector handles
// ---------------------------------------------------------------------------

interface DetectorHandle {
  cameraId: number;
  signal: BrightnessSignal;
  session: TapeSessionMachine;
  parser: PgmFrameParser;
  proc: ChildProcess & { stdout: Readable; stderr: Readable };
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
 * Subscribe to wheel tape session events. The callback fires after every
 * session on any camera.
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
 * Get the current live signal state for a camera. Returns null when no
 * detector is running for that camera.
 *
 * This is what powers the frontend oscilloscope — poll at 100–200 ms.
 */
export function getLiveSignal(cameraId: number): LiveSignal | null {
  const handle = detectors.get(cameraId);
  if (!handle) return null;
  return handle.signal.getLiveSnapshot(Date.now());
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
export function initWheelTapeDetectors(): void {
  let cameras: db.CameraRow[];
  try {
    cameras = db.listCameras().filter(
      (c) => c.wheel_motion_roi_x !== null && c.wheel_motion_roi_x !== undefined,
    );
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'wheel-tape: failed to query cameras at init — skipping');
    return;
  }

  for (const camera of cameras) {
    if (detectors.has(camera.id)) continue;
    spawnDetectorForCamera(camera, BACKOFF_INITIAL_MS);
  }

  if (cameras.length > 0) {
    log.info({ count: cameras.length, cameraIds: cameras.map((c) => c.id) }, 'wheel-tape detectors initialised');
  }
}

/**
 * Gracefully stop all wheel tape detector processes. Called at shutdown.
 * Force-ends any active sessions so the narrator can write a final diary entry.
 *
 * Guarantees:
 *   - Does not throw.
 *   - After this returns, no new ffmpeg processes will be spawned.
 */
export function shutdownWheelTapeDetectors(): void {
  const nowMs = Date.now();
  for (const handle of detectors.values()) {
    handle.shuttingDown = true;
    handle.session.forceEnd(nowMs);
    try {
      handle.proc.kill('SIGTERM');
    } catch {
      // Process may already be dead.
    }
  }
  detectors.clear();
  log.info('wheel-tape detectors shut down');
}

/**
 * Restart the detector for a specific camera (e.g. after a `setWheelTape`
 * config change). Kills the existing process, then re-reads the camera row
 * and spawns a fresh process. No-op if the camera has no ROI configured.
 */
export function restartDetectorForCamera(cameraId: number): void {
  const existing = detectors.get(cameraId);
  if (existing) {
    existing.shuttingDown = true;
    existing.session.forceEnd(Date.now());
    try {
      existing.proc.kill('SIGTERM');
    } catch {
      // Already dead.
    }
    detectors.delete(cameraId);
  }

  const camera = db.getCameraById(cameraId);
  if (!camera || camera.wheel_motion_roi_x === null || camera.wheel_motion_roi_x === undefined) {
    log.info({ cameraId }, 'wheel-tape: restartDetectorForCamera — no ROI configured, skipping');
    return;
  }

  spawnDetectorForCamera(camera, BACKOFF_INITIAL_MS);
  log.info({ cameraId }, 'wheel-tape: detector restarted after config change');
}

// ---------------------------------------------------------------------------
// Internal: RTSP URL construction
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
    wheel_tape_sensitivity: sensitivity,
  } = camera;

  if (
    roiX === null || roiX === undefined ||
    roiY === null || roiY === undefined ||
    roiW === null || roiW === undefined ||
    roiH === null || roiH === undefined
  ) {
    log.warn({ cameraId }, 'wheel-tape: ROI incomplete — skipping camera');
    return;
  }

  const rtspUrl = wheelRtspUrl(live_src);
  if (!rtspUrl) {
    log.warn({ cameraId, live_src }, 'wheel-tape: no live_src / FRIGATE_URL — camera skipped');
    return;
  }

  // Wide horizontal strip crop at 30 fps, grayscale output.
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
  const signal = new BrightnessSignal(sensitivity);
  const session = new TapeSessionMachine(
    cameraId,
    (completedSession) => {
      for (const cb of sessionCallbacks) {
        try {
          cb(completedSession);
        } catch (err) {
          log.error({ err: (err as Error).message, cameraId }, 'wheel-tape: session callback threw');
        }
      }
    },
  );

  const handle: DetectorHandle = {
    cameraId,
    signal,
    session,
    parser: new PgmFrameParser((framePixels, receivedAtMs) => {
      const isDip = signal.feed(framePixels, receivedAtMs);
      if (isDip) {
        session.onDip(receivedAtMs);
      }
    }),
    proc,
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
    log.warn({ cameraId, err: err.message }, 'wheel-tape: ffmpeg spawn error');
    scheduleRestart(cameraId, camera, handle);
  });

  proc.on('close', (code) => {
    if (handle.shuttingDown) return;
    log.warn({ cameraId, code }, 'wheel-tape: ffmpeg exited unexpectedly');
    scheduleRestart(cameraId, camera, handle);
  });

  log.info(
    { cameraId, rtspUrl, roiX, roiY, roiW, roiH, sensitivity, sampleFps: SAMPLE_FPS },
    'wheel-tape: detector started',
  );
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

  log.info({ cameraId, backoffMs: handle.backoffMs, nextBackoff }, 'wheel-tape: scheduling restart');

  const timer = setTimeout(() => {
    const freshCamera = db.getCameraById(cameraId);
    if (
      !freshCamera ||
      freshCamera.wheel_motion_roi_x === null ||
      freshCamera.wheel_motion_roi_x === undefined
    ) {
      log.info({ cameraId }, 'wheel-tape: camera no longer eligible — skipping restart');
      return;
    }
    spawnDetectorForCamera(freshCamera, nextBackoff);
  }, handle.backoffMs);
  timer.unref?.();
}

// ---------------------------------------------------------------------------
// Test helpers
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
