// app/server/src/frigate.ts
// Typed Frigate REST client + ffmpeg-driven recording-clip extractor.
//
// Reachability is best-effort: Frigate may be down while the rest of the app
// keeps running. Every public function logs warnings and returns a degraded
// (null) value when Frigate isn't responding — the consumers (camera grid,
// share-clip job, etc.) treat that as "unknown" and display accordingly.

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getConfig } from './config.js';
import { getCameraHeartbeat } from './mqtt.js';

const DEFAULT_FETCH_TIMEOUT_MS = 5_000;

export interface DiscoveredCamera {
  name: string;
  /** Suggested `cameras.stream_url` value (rtsp:// or http(s)://). */
  stream_url: string;
}

export interface CameraStats {
  /** ms since epoch of the most recent frame Frigate has processed. */
  lastFrameAt: number | null;
  /** Best-effort FPS in the last sampling window. */
  fps: number | null;
}

export interface ExtractedClip {
  /** Absolute path on the server's filesystem of the produced .mp4. */
  path: string;
  /** Duration of the clip in milliseconds. */
  duration_ms: number;
}

// ---------------------------------------------------------------------------
// HTTP helper — wraps fetch with a timeout + best-effort JSON parse.
// ---------------------------------------------------------------------------

async function frigateFetch<T>(
  pathSegment: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T | null> {
  const cfg = getConfig();
  if (!cfg.FRIGATE_URL) return null;
  const url = new URL(pathSegment, cfg.FRIGATE_URL).toString();
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(),
    init?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
  );
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// /api/config — camera discovery
// ---------------------------------------------------------------------------

// Frigate's config payload is huge; we model only the slice we read.
interface FrigateConfigCamera {
  ffmpeg?: {
    inputs?: Array<{ path?: string; roles?: readonly string[] }>;
  };
}

interface FrigateConfig {
  cameras?: Record<string, FrigateConfigCamera>;
}

export async function discoverCameras(): Promise<DiscoveredCamera[]> {
  const cfg = await frigateFetch<FrigateConfig>('/api/config');
  if (!cfg?.cameras) return [];
  const out: DiscoveredCamera[] = [];
  for (const [name, body] of Object.entries(cfg.cameras)) {
    const inputs = body.ffmpeg?.inputs ?? [];
    // Prefer the input flagged as 'detect' (Frigate's main feed), otherwise
    // the first one with a usable path.
    const detect = inputs.find((i) => i.roles?.includes('detect'));
    const fallback = inputs.find((i) => typeof i.path === 'string');
    const chosen = detect ?? fallback;
    if (chosen?.path) {
      out.push({ name, stream_url: chosen.path });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// /api/stats — per-camera last-frame timestamp
// ---------------------------------------------------------------------------

// Frigate stats includes `cameras.<name>.camera_fps` and `process_fps`,
// `detection_fps`, `pid`, etc. The most reliable per-camera freshness signal
// is the `camera_fps` reading combined with the global `service.uptime`/now,
// but recent Frigate releases also expose `cameras.<name>.last_frame` (epoch
// seconds) in the per-camera object. We read whichever we can find.
interface FrigateStatsCameraEntry {
  camera_fps?: number;
  detection_fps?: number;
  // Newer Frigate exposes a per-camera last_frame_time (s since epoch).
  last_frame_time?: number;
}

interface FrigateStats {
  cameras?: Record<string, FrigateStatsCameraEntry>;
}

export async function getCameraStats(cameraName: string): Promise<CameraStats> {
  // Prefer the per-camera REST reading when Frigate is reachable; fall back
  // to the MQTT heartbeat published by mqtt.ts. Either source missing yields
  // `null`, which the frontend renders as the napping/offline state.
  const stats = await frigateFetch<FrigateStats>('/api/stats');
  const entry = stats?.cameras?.[cameraName];
  const restLast = typeof entry?.last_frame_time === 'number'
    ? Math.round(entry.last_frame_time * 1000)
    : null;
  const heartbeatLast = getCameraHeartbeat(cameraName);
  const lastFrameAt = restLast ?? heartbeatLast;
  return {
    lastFrameAt,
    fps: typeof entry?.camera_fps === 'number' ? entry.camera_fps : null,
  };
}

// ---------------------------------------------------------------------------
// testStream — quick reachability check before saving a camera URL
// ---------------------------------------------------------------------------

export async function testStream(
  url: string,
): Promise<{ ok: boolean; status: number | null }> {
  // RTSP can't be probed with fetch — best we can do is parse the URL and
  // confirm the scheme. For http(s) we issue a short HEAD with a tight
  // timeout. Anything else (rtsp://) we accept as "shape valid" without
  // confirming, since the UI's preview will surface failures fast.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, status: null };
  }
  if (parsed.protocol === 'rtsp:' || parsed.protocol === 'rtmp:') {
    return { ok: true, status: null };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, status: null };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3_000);
  try {
    const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: null };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// extractClip — ffmpeg-driven recording window grab
// ---------------------------------------------------------------------------

export interface ExtractClipInput {
  cameraName: string;
  centerMs: number;
  /** Default 10_000. */
  durationMs?: number;
}

/**
 * Pulls a clip from Frigate's `/api/<cam>/recordings/<start>-<end>/clip.mp4`
 * endpoint, writes it under `STORAGE_PATH/clips/`, returns the absolute path.
 * Re-encoding is left to the caller (or skipped for performance — Frigate
 * already returns playable MP4 fragments).
 *
 * Why not pure ffmpeg with a local file? Frigate stores recordings in
 * sharded ts segments; their REST API hides that and serves a single MP4.
 * Calling that endpoint is much simpler than mounting the recordings volume
 * into our process.
 */
export async function extractClip(input: ExtractClipInput): Promise<ExtractedClip> {
  const cfg = getConfig();
  if (!cfg.FRIGATE_URL) {
    throw new Error('FRIGATE_URL is not configured; cannot extract clip');
  }
  const durationMs = input.durationMs ?? 10_000;
  const startSec = Math.floor((input.centerMs - durationMs / 2) / 1000);
  const endSec = Math.floor((input.centerMs + durationMs / 2) / 1000);

  const clipsDir = join(cfg.STORAGE_PATH, 'clips');
  await mkdir(clipsDir, { recursive: true });
  const outPath = join(
    clipsDir,
    `${input.cameraName}-${startSec}-${endSec}.mp4`,
  );

  const sourceUrl = new URL(
    `/api/${encodeURIComponent(input.cameraName)}/recordings/${startSec}-${endSec}/clip.mp4`,
    cfg.FRIGATE_URL,
  ).toString();

  // ffmpeg copies the stream into a faststart MP4 so the recipient's mail
  // client can begin playback before the full download finishes.
  await runFfmpeg([
    '-y',
    '-i', sourceUrl,
    '-c', 'copy',
    '-movflags', '+faststart',
    outPath,
  ]);

  return { path: outPath, duration_ms: durationMs };
}

// ---------------------------------------------------------------------------
// ffmpeg runner — exported so jobs/timelapse can share the spawn plumbing.
// ---------------------------------------------------------------------------

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

// ---------------------------------------------------------------------------
// Snapshot pull — fetches Frigate's `latest.jpg` for a camera and caches it
// under STORAGE_PATH/snapshots/. Returns the relative path written. On any
// failure (Frigate down, write error) we fall back to a small empty-placeholder
// file so the diary entry still has a real file on disk to point at.
// ---------------------------------------------------------------------------

export async function captureLatestSnapshot(
  cameraName: string,
  takenAtMs: number,
): Promise<string> {
  const cfg = getConfig();
  const snapsDir = join(cfg.STORAGE_PATH, 'snapshots');
  await mkdir(snapsDir, { recursive: true });
  const relPath = join(
    'snapshots',
    `${cameraName}-${takenAtMs}.jpg`,
  );
  const absPath = join(cfg.STORAGE_PATH, relPath);

  if (!cfg.FRIGATE_URL) {
    await writeFile(absPath, Buffer.alloc(0));
    return relPath;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_FETCH_TIMEOUT_MS);
  try {
    const url = new URL(
      `/api/${encodeURIComponent(cameraName)}/latest.jpg`,
      cfg.FRIGATE_URL,
    ).toString();
    const res = await fetch(url, { signal: ctrl.signal });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(absPath, buf);
      return relPath;
    }
  } catch {
    // fall through
  } finally {
    clearTimeout(timer);
  }
  await writeFile(absPath, Buffer.alloc(0));
  return relPath;
}

export function runFfmpeg(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => {
      reject(new FfmpegError(err.message, null, stderr));
    });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new FfmpegError(`ffmpeg exited with code ${code}`, code, stderr));
    });
  });
}
