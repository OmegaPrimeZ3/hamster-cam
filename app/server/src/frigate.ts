// app/server/src/frigate.ts
// Typed Frigate REST client + ffmpeg-driven recording-clip extractor.
//
// Reachability is best-effort: Frigate may be down while the rest of the app
// keeps running. Every public function logs warnings and returns a degraded
// (null) value when Frigate isn't responding — the consumers (camera grid,
// share-clip job, etc.) treat that as "unknown" and display accordingly.

import { spawn } from 'node:child_process';
import { lookup as dnsLookup } from 'node:dns/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';

import { getConfig } from './config.js';
import { getCameraHeartbeat } from './mqtt.js';

const DEFAULT_FETCH_TIMEOUT_MS = 5_000;

export interface DiscoveredCamera {
  name: string;
  /** go2rtc stream name — use as `live_src` on the camera and as the `src`
   *  query parameter for the /live/ws WebSocket proxy. */
  live_src: string;
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
// /api/go2rtc/api/streams — camera discovery via go2rtc
// ---------------------------------------------------------------------------

// go2rtc returns an object whose top-level keys are stream names. We only need
// the names (values contain producer/consumer details we don't use here).
type Go2rtcStreams = Record<string, unknown>;

/**
 * Returns the list of go2rtc stream names Frigate currently knows about.
 * Each name corresponds to a stream accessible via:
 *   ws: /api/go2rtc/api/ws?src=<name>
 *   mp4: /api/go2rtc/api/stream.mp4?src=<name>
 *
 * Returns [] if Frigate is unreachable.
 */
export async function discoverCameras(): Promise<DiscoveredCamera[]> {
  const streams = await frigateFetch<Go2rtcStreams>('/api/go2rtc/api/streams');
  if (!streams || typeof streams !== 'object') return [];
  return Object.keys(streams).map((name) => ({ name, live_src: name }));
}

/**
 * Check whether a given go2rtc src name is known to Frigate/go2rtc.
 * Used by cameras.testStream to validate a proposed live_src value.
 * Returns `{ ok: true }` if the name exists, `{ ok: false }` otherwise.
 */
export async function checkLiveSrc(src: string): Promise<{ ok: boolean }> {
  const streams = await frigateFetch<Go2rtcStreams>('/api/go2rtc/api/streams');
  if (!streams || typeof streams !== 'object') return { ok: false };
  return { ok: Object.prototype.hasOwnProperty.call(streams, src) };
}

// ---------------------------------------------------------------------------
// /api/stats — per-camera last-frame timestamp, background-polled cache
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

// How often the background poller re-fetches /api/stats.
const STATS_POLL_INTERVAL_MS = 5_000;

// Module-level cache populated by the background poller.
// `cameras.list` reads this synchronously — no network round-trip per request.
const statsCache = new Map<string, CameraStats>();

let _pollerHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Parse a single FrigateStatsCameraEntry into CameraStats.
 * Extracted so the poller and the tests share the same logic.
 */
function parseStatsCameraEntry(entry: FrigateStatsCameraEntry | undefined): CameraStats {
  const lastFrameAt = typeof entry?.last_frame_time === 'number'
    ? Math.round(entry.last_frame_time * 1000)
    : typeof entry?.camera_fps === 'number' && entry.camera_fps > 0
      ? Date.now()
      : null;
  return {
    lastFrameAt,
    fps: typeof entry?.camera_fps === 'number' ? entry.camera_fps : null,
  };
}

export interface PollFrigateStatsDeps {
  /**
   * Override the Frigate base URL. When provided, the function skips
   * `getConfig()` entirely — used by unit tests that run without a full env.
   */
  frigateUrl?: string;
  /** Override global fetch — used by unit tests to inject a fake response. */
  fetchFn?: typeof fetch;
}

/**
 * Runs one poll cycle: fetch /api/stats and write each camera's parsed stats
 * into the module-level cache. Exported for direct use in tests.
 * Returns the raw parsed stats map (camera name → CameraStats) so tests can
 * inspect the result without coupling to the module cache.
 *
 * `deps.frigateUrl` + `deps.fetchFn` allow tests to inject a URL and fake
 * fetch without touching global state or needing a full env setup.
 */
export async function pollFrigateStats(deps: PollFrigateStatsDeps = {}): Promise<Map<string, CameraStats>> {
  const result = new Map<string, CameraStats>();

  // Resolve the Frigate URL: explicit dep (tests) → config (production).
  const frigateUrl = deps.frigateUrl ?? (() => {
    const cfg = getConfig();
    return cfg.FRIGATE_URL;
  })();
  if (!frigateUrl) return result;

  const doFetch = deps.fetchFn ?? fetch;
  const url = new URL('/api/stats', frigateUrl).toString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_FETCH_TIMEOUT_MS);
  let stats: FrigateStats | null = null;
  try {
    const res = await doFetch(url, { signal: ctrl.signal });
    if (res.ok) stats = (await res.json()) as FrigateStats;
  } catch {
    // Frigate unreachable — leave cache as-is, return empty map.
  } finally {
    clearTimeout(timer);
  }

  if (!stats?.cameras) return result;
  for (const [name, entry] of Object.entries(stats.cameras)) {
    const parsed = parseStatsCameraEntry(entry);
    statsCache.set(name, parsed);
    result.set(name, parsed);
  }
  return result;
}

/**
 * Read cached Frigate stats for a camera SYNCHRONOUSLY.
 * Preserves the old getCameraStats semantics: the REST/stats value is
 * preferred, but the MQTT heartbeat is used as a fallback whenever
 * `lastFrameAt` is null — whether from a missing cache entry (server just
 * started / Frigate never reached) OR from a present-but-null entry (Frigate
 * lists the camera but camera_fps is 0 and there is no last_frame_time).
 */
export function getCachedCameraStats(cameraName: string): CameraStats {
  const cached = statsCache.get(cameraName);
  const restLast = cached?.lastFrameAt ?? null;
  const lastFrameAt = restLast ?? getCameraHeartbeat(cameraName);
  return { lastFrameAt, fps: cached?.fps ?? null };
}

/**
 * Start the background stats poller. Must be called once at server boot.
 * Safe to call with no FRIGATE_URL — logs a warning and returns immediately
 * without scheduling any timer (mirrors the frigateFetch guard).
 */
export function startFrigateStatsPoller(): void {
  const cfg = getConfig();
  if (!cfg.FRIGATE_URL) {
    // No Frigate configured — cache stays empty, getCachedCameraStats falls
    // back to MQTT heartbeat. This is correct degraded-mode behaviour.
    return;
  }
  if (_pollerHandle !== null) return; // already running

  // Fire once immediately so the cache is warm before the first request.
  void pollFrigateStats();

  _pollerHandle = setInterval(() => {
    void pollFrigateStats();
  }, STATS_POLL_INTERVAL_MS);

  // Don't let the timer prevent a clean process exit.
  _pollerHandle.unref();
}

/**
 * Stop the background stats poller. Called during graceful shutdown or in tests.
 */
export function stopFrigateStatsPoller(): void {
  if (_pollerHandle !== null) {
    clearInterval(_pollerHandle);
    _pollerHandle = null;
  }
  statsCache.clear();
}

// ---------------------------------------------------------------------------
// testStream — quick reachability check before saving a camera URL
// ---------------------------------------------------------------------------

// Override hook so unit tests can inject a fake DNS lookup without
// monkey-patching the global dns module. Production keeps the real
// `node:dns/promises` `lookup` via the default `lookup` arg.
export interface TestStreamDeps {
  /** Resolves a hostname to an IP. Default: `dns.lookup`. */
  lookup?: (hostname: string) => Promise<{ address: string; family: 4 | 6 }>;
  /** HTTP HEAD probe. Default: global fetch. */
  fetchFn?: typeof fetch;
}

/**
 * Probe an http(s) or rtsp(/rtmp) stream URL for reachability.
 *
 * Security-Review Finding 2 (SSRF): for http(s) URLs we
 *   1. reject any literal-IP that lands in a private/loopback/link-local/CGNAT
 *      range (IPv4 and IPv6), the IPv4-mapped-IPv6 equivalents, or the AWS-
 *      style metadata endpoint at 169.254.0.0/16
 *   2. resolve the hostname through DNS and re-check the result against the
 *      same allowlist — defeats DNS-rebinding where evil.com → 127.0.0.1
 *   3. issue the HEAD with `redirect: 'manual'` so a 302 to an internal target
 *      doesn't transparently get followed.
 *
 * rtsp:// / rtmp:// short-circuit to "shape valid" since we can't probe them
 * with fetch and the UI's live preview surfaces failures fast. Anything else
 * is rejected.
 */
export async function testStream(
  url: string,
  deps: TestStreamDeps = {},
): Promise<{ ok: boolean; status: number | null }> {
  const lookup = deps.lookup ?? defaultLookup;
  const doFetch = deps.fetchFn ?? fetch;

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

  // URL.hostname strips brackets from IPv6 literals already.
  const host = parsed.hostname;
  if (host.length === 0) return { ok: false, status: null };

  // Step 1: reject literal-IP / hostname strings that are themselves internal.
  if (isInternalHost(host)) {
    return { ok: false, status: null };
  }

  // Step 2: when the host isn't a literal IP, resolve it and re-check. This
  // catches DNS-rebinding (`evil.com` resolving to 127.0.0.1 / 10.0.0.0/8 / ..).
  if (isIP(host) === 0) {
    try {
      const { address } = await lookup(host);
      if (isInternalHost(address)) {
        return { ok: false, status: null };
      }
    } catch {
      // Couldn't resolve — treat as unreachable rather than fall through to a
      // fetch that would also fail. Returning here matches the existing
      // "no response" semantics the frontend already handles.
      return { ok: false, status: null };
    }
  }

  // Step 3: HEAD with explicit manual-redirect so a 3xx to a now-internal
  // host doesn't get transparently followed.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3_000);
  try {
    const res = await doFetch(url, {
      method: 'HEAD',
      signal: ctrl.signal,
      redirect: 'manual',
    });
    // A manual-redirect response carries status 0 in the spec'd `Response` and
    // status 3xx in node's undici. Either way we surface the literal status
    // and let the admin see "302 redirect" without us silently chasing it.
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: null };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// isInternalHost — IPv4 + IPv6 allow-deny list of ranges no outbound probe
// should ever reach. Exported for unit-tests.
// ---------------------------------------------------------------------------

/**
 * True when the hostname/IP should be treated as inside the trust boundary
 * (loopback, link-local, RFC1918, CGNAT, IPv6 ULA / link-local / loopback,
 * or the AWS-style metadata endpoint).
 *
 * Accepts either a raw IP literal or a hostname like `localhost`.
 */
export function isInternalHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  // Hostname literals that always map to loopback.
  if (lower === 'localhost' || lower === 'ip6-localhost' || lower === 'ip6-loopback') {
    return true;
  }
  // Strip an optional zone-id (e.g. `fe80::1%en0`) before classifying.
  const noZone = lower.includes('%') ? lower.slice(0, lower.indexOf('%')) : lower;
  const family = isIP(noZone);
  if (family === 4) return isInternalIPv4(noZone);
  if (family === 6) return isInternalIPv6(noZone);
  // Non-IP hostnames that aren't 'localhost' aren't *literally* internal; the
  // caller's DNS-lookup step will catch resolutions into internal space.
  return false;
}

function isInternalIPv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number.parseInt(p, 10));
  if (octets.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false;
  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;
  // 0.0.0.0/8 — "this network", per RFC 1122; covers 0.0.0.0 as well.
  if (a === 0) return true;
  // 127.0.0.0/8 loopback
  if (a === 127) return true;
  // 10.0.0.0/8 RFC1918
  if (a === 10) return true;
  // 172.16.0.0/12 RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 RFC1918
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 link-local (covers AWS-style metadata endpoint)
  if (a === 169 && b === 254) return true;
  // 100.64.0.0/10 CGNAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isInternalIPv6(ip: string): boolean {
  // Quick-path on the well-known literals first.
  if (ip === '::' || ip === '::1') return true;

  // IPv4-mapped-IPv6 (::ffff:10.0.0.1, etc.). Detect by suffix-dot and re-use
  // the v4 classifier on the embedded dotted-quad.
  const lastColon = ip.lastIndexOf(':');
  if (ip.includes('.') && lastColon !== -1) {
    const tail = ip.slice(lastColon + 1);
    if (isIP(tail) === 4) {
      return isInternalIPv4(tail);
    }
  }

  // Expand to lowercase canonical groups. Crude expansion is enough for prefix
  // checks because the first group tells us the range.
  const groups = expandIPv6(ip);
  if (!groups) return false;
  const first = groups[0] ?? 0;
  // fc00::/7 — Unique-Local Addresses (first 7 bits are 1111110 → fc00-fdff).
  if ((first & 0xfe00) === 0xfc00) return true;
  // fe80::/10 — link-local (fe80-febf).
  if ((first & 0xffc0) === 0xfe80) return true;
  return false;
}

/** Returns 8 numeric groups for a valid IPv6 literal, or null. */
function expandIPv6(ip: string): number[] | null {
  // Split on `::` (at most once) to capture leading and trailing halves.
  const dcParts = ip.split('::');
  if (dcParts.length > 2) return null;
  const head = dcParts[0] === '' ? [] : (dcParts[0]?.split(':') ?? []);
  const tail = dcParts[1] === undefined || dcParts[1] === ''
    ? []
    : dcParts[1].split(':');
  const fill = 8 - head.length - tail.length;
  if (dcParts.length === 1 && head.length !== 8) return null;
  if (dcParts.length === 2 && fill < 0) return null;
  const zeros = Array.from({ length: Math.max(0, fill) }, () => '0');
  const all = [...head, ...zeros, ...tail];
  if (all.length !== 8) return null;
  const out: number[] = [];
  for (const g of all) {
    if (g.length === 0 || g.length > 4) return null;
    const n = Number.parseInt(g, 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
    out.push(n);
  }
  return out;
}

async function defaultLookup(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  const { address, family } = await dnsLookup(hostname);
  return { address, family: family === 6 ? 6 : 4 };
}

// ---------------------------------------------------------------------------
// fetchHamsterEvents — query Frigate's REST events API for a time window
// ---------------------------------------------------------------------------

/** One event from GET /api/events (subset we need for the recap job). */
export interface FrigateDetectionEvent {
  id: string;
  camera: string;
  label: string;
  /** Unix seconds (float). */
  start_time: number;
  /** Unix seconds (float), or null when still in progress. */
  end_time: number | null;
  has_clip: boolean;
  has_snapshot: boolean;
  zones: string[];
}

/**
 * Query Frigate's `/api/events` REST endpoint for detections between
 * `afterSec` and `beforeSec` (both Unix seconds). Optionally filter by label
 * (default: 'hamster'). Returns [] when FRIGATE_URL is unset, the request
 * fails, or Frigate returns no events.
 *
 * This is the same endpoint the backfill tool uses; kept here so timelapse
 * and other jobs have a shared, tested client.
 */
export async function fetchHamsterEvents(
  afterSec: number,
  beforeSec: number,
  label = 'hamster',
): Promise<FrigateDetectionEvent[]> {
  const cfg = getConfig();
  if (!cfg.FRIGATE_URL) return [];

  const url = new URL('/api/events', cfg.FRIGATE_URL);
  url.searchParams.set('limit', '1000');
  url.searchParams.set('after', String(Math.floor(afterSec)));
  url.searchParams.set('before', String(Math.ceil(beforeSec)));
  url.searchParams.set('label', label);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url.toString(), { signal: ctrl.signal });
    if (!res.ok) return [];
    const data = await res.json() as unknown;
    if (!Array.isArray(data)) return [];
    return data.filter(isValidDetectionEvent);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function isValidDetectionEvent(raw: unknown): raw is FrigateDetectionEvent {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r['id'] === 'string' &&
    typeof r['camera'] === 'string' &&
    typeof r['label'] === 'string' &&
    typeof r['start_time'] === 'number' &&
    (r['end_time'] === null || typeof r['end_time'] === 'number') &&
    Array.isArray(r['zones'])
  );
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
 * Pulls a clip from Frigate's `/api/<cam>/start/<startSec>/end/<endSec>/clip.mp4`
 * endpoint (Frigate 0.17.x), writes it under `STORAGE_PATH/clips/`, returns
 * the absolute path. Re-encoding is left to the caller (or skipped for
 * performance — Frigate already returns playable MP4 fragments).
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

  // Frigate 0.17.x recording-clip endpoint:
  //   /api/<camera_name>/start/<startSec>/end/<endSec>/clip.mp4
  const sourceUrl = new URL(
    `/api/${encodeURIComponent(input.cameraName)}/start/${startSec}/end/${endSec}/clip.mp4`,
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
// under STORAGE_PATH/snapshots/.
//
// Returns `{ path, captured: true }` when a real JPEG was fetched and written.
// Returns `{ path, captured: false }` when Frigate was unreachable or returned
// a non-ok status — the placeholder file is still written so the path field
// always points to a real (possibly zero-byte) file, preserving the previous
// behaviour for callers that need a disk path regardless.
//
// The `captured` flag is what callers that must not record failed pulls (e.g.
// the snapshot-capture job) should gate on.
// ---------------------------------------------------------------------------

export interface CaptureSnapshotResult {
  /** Relative path under STORAGE_PATH where the file was written. */
  path: string;
  /** True iff a real, non-zero-byte JPEG was fetched from Frigate. */
  captured: boolean;
}

// ---------------------------------------------------------------------------
// Frame extraction — grabs a single JPEG at a specific moment for thumbnails.
// ---------------------------------------------------------------------------

export interface ExtractFrameResult {
  /** Relative path under STORAGE_PATH where the JPEG was written. */
  path: string;
  /** True iff ffmpeg produced a non-zero-byte JPEG. */
  captured: boolean;
}

/**
 * Pulls a 4-second clip from Frigate's recordings API centered on `atMs` and
 * extracts a frame near the midpoint as a downscaled JPEG. Writes the result
 * under `STORAGE_PATH/thumbnails/<cameraName>-<atMs>.jpg`.
 *
 * The 4-second window (atMs±2s) is wide enough to survive a single-segment
 * boundary gap that would starve a 1-second window. An input seek (`-ss`) is
 * applied so ffmpeg doesn't always grab frame 0 of the wider window — it
 * seeks ~2 seconds in so the extracted frame lands near `atMs`.
 *
 * Returns `captured: false` and still writes a zero-byte placeholder when
 * Frigate is unreachable, ffmpeg fails, or the output is empty — never throws
 * to the caller.
 */
export async function extractFrame(input: {
  cameraName: string;
  atMs: number;
  widthPx?: number;
}): Promise<ExtractFrameResult> {
  const cfg = getConfig();
  const thumbsDir = join(cfg.STORAGE_PATH, 'thumbnails');
  await mkdir(thumbsDir, { recursive: true });
  const relPath = join('thumbnails', `${input.cameraName}-${input.atMs}.jpg`);
  const absPath = join(cfg.STORAGE_PATH, relPath);

  if (!cfg.FRIGATE_URL) {
    await writeFile(absPath, Buffer.alloc(0));
    return { path: relPath, captured: false };
  }

  const width = input.widthPx ?? 480;
  const centerSec = Math.floor(input.atMs / 1000);
  // 4-second window: start 2s before the target moment; clamp to 0 so we
  // never request a negative timestamp from Frigate.
  const startSec = Math.max(0, centerSec - 2);
  const endSec = centerSec + 2;
  // Frigate 0.17.x recording-clip endpoint (same route as extractClip):
  //   /api/<camera_name>/start/<sec>/end/<endSec>/clip.mp4
  const sourceUrl = new URL(
    `/api/${encodeURIComponent(input.cameraName)}/start/${startSec}/end/${endSec}/clip.mp4`,
    cfg.FRIGATE_URL,
  ).toString();

  // Seek offset within the 4-second window so the extracted frame lands near
  // `atMs` rather than at the very start of the window. When startSec was
  // clamped to 0 the effective offset is smaller; clamp to [0, 3] to stay
  // inside the window.
  const seekOffset = Math.min(centerSec - startSec, 3);

  try {
    await runFfmpeg([
      '-y',
      '-ss', String(seekOffset),
      '-i', sourceUrl,
      '-frames:v', '1',
      '-vf', `scale=${width}:-1`,
      absPath,
    ]);

    // Verify the output is non-empty (ffmpeg may exit 0 but write nothing).
    const { stat } = await import('node:fs/promises');
    const st = await stat(absPath);
    if (st.size > 0) {
      return { path: relPath, captured: true };
    }
  } catch {
    // ffmpeg failed or file missing — fall through to placeholder.
  }

  await writeFile(absPath, Buffer.alloc(0));
  return { path: relPath, captured: false };
}

export async function captureLatestSnapshot(
  cameraName: string,
  takenAtMs: number,
): Promise<CaptureSnapshotResult> {
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
    return { path: relPath, captured: false };
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
      if (buf.byteLength > 0) {
        await writeFile(absPath, buf);
        return { path: relPath, captured: true };
      }
    }
  } catch {
    // fall through to placeholder
  } finally {
    clearTimeout(timer);
  }
  await writeFile(absPath, Buffer.alloc(0));
  return { path: relPath, captured: false };
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
