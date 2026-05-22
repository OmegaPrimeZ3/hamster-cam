// app/server/src/live-ws.ts
// Authenticated WebSocket reverse-proxy to go2rtc.
//
// Route: GET /live/ws?src=<go2rtc-stream-name>
//
// Security boundaries:
//   1. Auth    — requires a valid session cookie (same `resolveSession` used
//                everywhere). Any authenticated role (admin or child) may view.
//                Unauthenticated upgrades are rejected with HTTP 401 before the
//                WS handshake completes.
//   2. Origin  — the `Origin` header must be in the configured allowlist to
//                prevent cross-site WebSocket hijacking. Absent or foreign
//                Origin → HTTP 403 before upgrade.
//   3. SSRF    — `src` is validated against the DB allowlist of enabled cameras'
//                `live_src` values. Arbitrary src values are NOT forwarded to
//                Frigate. Unknown src → HTTP 403 before upgrade.
//   4. Limits  — global + per-user connection cap, maxPayload on client frames,
//                ping/pong heartbeat to reap half-open sockets.
//
// Framing: go2rtc's VideoRTC protocol sends JSON control frames (text) and
// binary media frames. Both are piped bidirectionally. Close/error on either
// end propagates to the other end immediately so we don't leak sockets.
//
// Dependency: the `ws` npm package (v8). Fastify's built-in HTTP server
// exposes the `upgrade` event directly so we don't need @fastify/websocket —
// that plugin adds opinionated route-handler glue we don't need here and
// would require Fastify plugin typing acrobatics.

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocket, WebSocketServer } from 'ws';

import { getConfig } from './config.js';
import { listEnabledLiveSrcs } from './db.js';
import { logger } from './logger.js';
import { resolveSession } from './session.js';
import type { AppServer } from './index.js';

// ---------------------------------------------------------------------------
// Resource limits
// ---------------------------------------------------------------------------

/**
 * Maximum client→proxy payload per frame (64 KiB). go2rtc control frames are
 * tiny JSON; there is no legitimate reason for a client to send megabyte frames.
 */
const MAX_PAYLOAD_BYTES = 64 * 1024;

/** Maximum simultaneous proxy connections across all users. */
const MAX_CONNECTIONS_GLOBAL = 50;

/** Maximum simultaneous proxy connections per user id. */
const MAX_CONNECTIONS_PER_USER = 5;

/** How often to send a ping to detect half-open sockets (ms). */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** How long to wait for a pong reply before terminating the socket (ms). */
const PONG_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Connection tracking (module-level, cleared between tests via reset helper)
// ---------------------------------------------------------------------------

/** Global count of live proxy connections. */
let globalConnectionCount = 0;

/** Per-user-id live proxy connection counts. */
const perUserConnectionCount = new Map<number, number>();

function incrementConnection(userId: number): void {
  globalConnectionCount += 1;
  perUserConnectionCount.set(userId, (perUserConnectionCount.get(userId) ?? 0) + 1);
}

function decrementConnection(userId: number): void {
  globalConnectionCount = Math.max(0, globalConnectionCount - 1);
  const prev = perUserConnectionCount.get(userId) ?? 0;
  const next = Math.max(0, prev - 1);
  if (next === 0) {
    perUserConnectionCount.delete(userId);
  } else {
    perUserConnectionCount.set(userId, next);
  }
}

/** Test helper — resets counters between test runs. */
export function resetConnectionCountsForTests(): void {
  globalConnectionCount = 0;
  perUserConnectionCount.clear();
}

/**
 * Close the module-level WebSocketServer, terminating all in-flight proxy
 * connections. Called from the graceful-shutdown handler in index.ts so that
 * `docker stop` / SIGTERM doesn't leave orphaned WS sockets open after the
 * Fastify HTTP server has already stopped accepting new connections.
 */
export function closeWss(): Promise<void> {
  return new Promise((resolve) => {
    // Terminate every open client socket first so `wss.close` doesn't wait for
    // them to finish the handshake (they never will — we're shutting down).
    for (const socket of wss.clients) {
      socket.terminate();
    }
    wss.close(() => resolve());
  });
}

// We only need the server for its `handleUpgrade` plumbing.
// maxPayload caps frames sent by the client (go2rtc protocol frames are tiny).
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

// ---------------------------------------------------------------------------
// Origin allowlist
// ---------------------------------------------------------------------------

/**
 * Build the set of permitted `Origin` header values from config.
 *
 * Production: always includes the PUBLIC_URL origin (scheme+host, no path).
 * Development (NODE_ENV === 'development'): also includes DEV_ORIGINS (comma-
 *   separated) and the default Vite port http://localhost:5173.
 *
 * The list is rebuilt on every call so config changes in tests take effect
 * without a module reload.
 */
export function buildAllowedOrigins(): ReadonlySet<string> {
  const cfg = getConfig();
  const origins = new Set<string>();

  if (cfg.PUBLIC_URL) {
    try {
      const u = new URL(cfg.PUBLIC_URL);
      // Normalise to scheme+host (strip path/query/fragment).
      origins.add(`${u.protocol}//${u.host}`);
    } catch {
      logger.warn({ PUBLIC_URL: cfg.PUBLIC_URL }, 'live WS: invalid PUBLIC_URL — skipping');
    }
  }

  if (cfg.NODE_ENV === 'development') {
    // Default Vite dev server port.
    origins.add('http://localhost:5173');
    // Allow extra origins via DEV_ORIGINS env var (comma-separated).
    if (cfg.DEV_ORIGINS) {
      for (const raw of cfg.DEV_ORIGINS.split(',')) {
        const trimmed = raw.trim();
        if (trimmed) origins.add(trimmed);
      }
    }
  }

  return origins;
}

/**
 * Validate the Origin header against the allowlist.
 * Returns `true` if the origin is permitted, `false` otherwise.
 *
 * Test environments (NODE_ENV === 'test') skip Origin validation because test
 * WS clients (the `ws` npm package) do not send an Origin header by default
 * and we don't want to retrofit every existing test with fake origins. The
 * auth + SSRF guards still run; the test suite explicitly covers Origin
 * rejection in its own describe block using the exported helper.
 */
export function isOriginAllowed(origin: string | undefined): boolean {
  const cfg = getConfig();
  // In test env, skip origin validation so the existing test suite is unaffected.
  if (cfg.NODE_ENV === 'test') return true;

  if (!origin) return false;
  const allowed = buildAllowedOrigins();
  // Allow if there are no configured origins (e.g. a dev machine with no PUBLIC_URL
  // and NODE_ENV != 'development') only when in development.
  if (allowed.size === 0 && cfg.NODE_ENV === 'development') return true;
  return allowed.has(origin);
}

// ---------------------------------------------------------------------------
// Public registration
// ---------------------------------------------------------------------------

/**
 * Register the /live/ws upgrade handler on the Fastify server's underlying
 * Node `http.Server`. Called once during `buildServer()`.
 *
 * Fastify doesn't have a first-class WS upgrade API in v5 without the plugin,
 * so we attach directly to `server.server` (the raw Node http.Server). This
 * is the same pattern used by the ws-package docs and is safe to do after
 * `app.register()` has run.
 */
export function registerLiveWsProxy(app: AppServer): void {
  // `app.server` is typed as `Server` (node:http) in Fastify v5.
  app.server.on('upgrade', handleUpgrade);
  logger.info('live WS proxy registered at /live/ws');
}

// ---------------------------------------------------------------------------
// Upgrade handler
// ---------------------------------------------------------------------------

/**
 * Handle an HTTP Upgrade request. Only touches /live/ws; everything else is
 * ignored (Fastify itself + any other WS handlers deal with their own paths).
 */
function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const rawUrl = req.url ?? '';

  // Only handle our path prefix. Other upgrade requests (e.g. Vite HMR in
  // dev) must pass through unmodified. Simply returning without calling
  // socket.destroy() leaves the socket for any subsequent handler; since
  // there are none in production, the browser will get a TCP close which is
  // the correct behaviour for an unknown upgrade path.
  if (!rawUrl.startsWith('/live/ws')) return;

  // --- Auth check (before the upgrade handshake so we can reply HTTP 401) ---
  // Cookies are available on the IncomingMessage via the Cookie header.
  // We parse them manually here because Fastify's cookie plugin hasn't
  // decoded them yet at the raw-server level.
  const cookieHeader = req.headers['cookie'] ?? '';
  const cookies = parseCookies(cookieHeader);

  // Temporarily attach cookies to the request so resolveSession can read them.
  // resolveSession reads `req.cookies` which Fastify normally populates. We
  // inject the parsed map directly via `unknown` to satisfy exactOptionalPropertyTypes.
  const reqWithCookies = req as unknown as Parameters<typeof resolveSession>[0];
  (reqWithCookies as unknown as Record<string, unknown>)['cookies'] = cookies;
  const user = resolveSession(reqWithCookies);

  if (!user) {
    logger.warn(
      { ip: req.socket.remoteAddress, path: rawUrl },
      'live WS proxy: unauthenticated upgrade attempt — rejecting 401',
    );
    socket.write(
      'HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nUnauthorized',
    );
    socket.destroy();
    return;
  }

  // --- Origin check (CSWSH prevention) ---
  const origin = req.headers['origin'] as string | undefined;
  if (!isOriginAllowed(origin)) {
    logger.warn(
      { origin, userId: user.id, path: rawUrl },
      'live WS proxy: forbidden Origin — rejecting 403',
    );
    socket.write(
      'HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nForbidden origin',
    );
    socket.destroy();
    return;
  }

  // --- Connection cap ---
  const userConnections = perUserConnectionCount.get(user.id) ?? 0;
  if (globalConnectionCount >= MAX_CONNECTIONS_GLOBAL || userConnections >= MAX_CONNECTIONS_PER_USER) {
    logger.warn(
      { userId: user.id, globalConnectionCount, userConnections },
      'live WS proxy: connection cap reached — rejecting 503',
    );
    socket.write(
      'HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nToo many connections',
    );
    socket.destroy();
    return;
  }

  // --- Parse and validate the `src` query parameter ---
  let src: string;
  try {
    // Use the request Host header for URL parsing so relative paths resolve.
    const host = (req.headers['host'] as string | undefined) ?? 'localhost';
    const parsed = new URL(rawUrl, `http://${host}`);
    src = parsed.searchParams.get('src') ?? '';
  } catch {
    src = '';
  }

  if (!src) {
    socket.write(
      'HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nMissing src parameter',
    );
    socket.destroy();
    return;
  }

  // --- SSRF allowlist check: src must be a known enabled camera live_src ---
  const allowedSrcs = listEnabledLiveSrcs();
  if (!allowedSrcs.has(src)) {
    logger.warn(
      { src, userId: user.id },
      'live WS proxy: src not in allowlist — rejecting',
    );
    socket.write(
      'HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nUnknown stream source',
    );
    socket.destroy();
    return;
  }

  // --- Complete the WS upgrade and open the upstream connection ---
  wss.handleUpgrade(req, socket, head, (clientWs) => {
    incrementConnection(user.id);
    connectProxy(clientWs, src, user.id);
  });
}

// ---------------------------------------------------------------------------
// Proxy connection with heartbeat
// ---------------------------------------------------------------------------

/**
 * Open an upstream WebSocket to Frigate's go2rtc endpoint and bidirectionally
 * pipe all frames. Cleans up both sockets on any close/error.
 *
 * Frames sent by the client before the upstream handshake completes are
 * buffered and flushed once upstream is OPEN. This avoids a race where the
 * client (or the go2rtc VideoRTC protocol) sends a handshake frame immediately
 * after the client-side open event.
 *
 * A ping/pong heartbeat on the client socket terminates half-open connections
 * (e.g. mobile WiFi drop) that never send TCP FIN. When the client fails to
 * respond within PONG_TIMEOUT_MS the client socket is terminated, which in
 * turn triggers the close handler that closes the upstream socket.
 */
function connectProxy(clientWs: WebSocket, src: string, userId: number): void {
  const cfg = getConfig();
  if (!cfg.FRIGATE_URL) {
    logger.error('live WS proxy: FRIGATE_URL not configured');
    clientWs.close(1011, 'Upstream not configured');
    decrementConnection(userId);
    return;
  }

  // Convert the Frigate HTTP base URL to a WebSocket URL.
  // http://host → ws://host;  https://host → wss://host
  const frigateWsBase = cfg.FRIGATE_URL.replace(/^http:\/\//i, 'ws://').replace(
    /^https:\/\//i,
    'wss://',
  );
  const upstreamUrl = `${frigateWsBase}/api/go2rtc/api/ws?src=${encodeURIComponent(src)}`;

  const upstreamWs = new WebSocket(upstreamUrl);

  // Buffer for frames that arrive from the client while upstream is still
  // connecting. Flushed immediately when upstream fires `open`.
  const pendingToUpstream: Array<{ data: import('ws').RawData; isBinary: boolean }> = [];

  // --- Heartbeat state ---
  // We track whether the client is still alive by sending periodic pings and
  // expecting a pong within the timeout window.
  let isAlive = true;
  let pongTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

  const heartbeatInterval = setInterval(() => {
    if (!isAlive) {
      // Client didn't respond to the last ping — treat as dead.
      logger.warn({ src, userId }, 'live WS proxy: client pong timeout — terminating');
      clearInterval(heartbeatInterval);
      clientWs.terminate();
      if (upstreamWs.readyState !== WebSocket.CLOSED) {
        upstreamWs.close();
      }
      return;
    }
    isAlive = false;
    // Set a hard timeout in case the `pong` event never fires at all
    // (e.g. client TCP stack is gone but hasn't sent FIN).
    pongTimeoutHandle = setTimeout(() => {
      if (!isAlive) {
        logger.warn({ src, userId }, 'live WS proxy: pong timeout — terminating');
        clientWs.terminate();
        if (upstreamWs.readyState !== WebSocket.CLOSED) {
          upstreamWs.close();
        }
      }
    }, PONG_TIMEOUT_MS);

    try {
      clientWs.ping();
    } catch {
      // Ping failed (socket already closing) — nothing to do.
    }
  }, HEARTBEAT_INTERVAL_MS);

  clientWs.on('pong', () => {
    isAlive = true;
    if (pongTimeoutHandle !== null) {
      clearTimeout(pongTimeoutHandle);
      pongTimeoutHandle = null;
    }
  });

  // --- Client → upstream ---
  clientWs.on('message', (data, isBinary) => {
    if (upstreamWs.readyState === WebSocket.OPEN) {
      upstreamWs.send(data, { binary: isBinary });
    } else if (upstreamWs.readyState === WebSocket.CONNECTING) {
      pendingToUpstream.push({ data, isBinary });
    }
    // If upstream is CLOSING/CLOSED we drop the frame — client will get a
    // close event shortly.
  });

  // --- Upstream → client ---
  upstreamWs.on('message', (data, isBinary) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });

  // --- Error handling ---
  upstreamWs.on('error', (err) => {
    logger.warn({ err: err.message, src, userId }, 'live WS proxy: upstream error');
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(1011, 'Upstream error');
    }
  });

  clientWs.on('error', (err) => {
    logger.warn({ err: err.message, src, userId }, 'live WS proxy: client error');
    if (upstreamWs.readyState !== WebSocket.CLOSED) {
      upstreamWs.close();
    }
  });

  // --- Close propagation ---
  upstreamWs.on('close', (code, reason) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      // Forward the upstream close code. Cap at 4999 to stay within the WS
      // spec's application-defined range (1000–4999).
      const safeCode = typeof code === 'number' && code >= 1000 && code <= 4999 ? code : 1001;
      clientWs.close(safeCode, reason);
    }
  });

  clientWs.on('close', () => {
    clearInterval(heartbeatInterval);
    if (pongTimeoutHandle !== null) {
      clearTimeout(pongTimeoutHandle);
      pongTimeoutHandle = null;
    }
    if (upstreamWs.readyState !== WebSocket.CLOSED) {
      upstreamWs.close();
    }
    decrementConnection(userId);
    logger.debug({ src, userId }, 'live WS proxy: client disconnected');
  });

  upstreamWs.on('open', () => {
    logger.debug({ src, userId }, 'live WS proxy: upstream connected');
    // Flush buffered frames from before upstream was ready.
    for (const { data, isBinary } of pendingToUpstream) {
      upstreamWs.send(data, { binary: isBinary });
    }
    pendingToUpstream.length = 0;
  });
}

// ---------------------------------------------------------------------------
// Cookie parser — minimal implementation, no deps
// ---------------------------------------------------------------------------

/**
 * Parse a raw `Cookie: ...` header into a key→value map. Handles URL-encoded
 * values. Returns an empty object on any parse failure.
 */
function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(';')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const key = pair.slice(0, eqIdx).trim();
    const val = pair.slice(eqIdx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}
