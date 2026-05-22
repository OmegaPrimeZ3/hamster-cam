// app/server/src/live-ws.ts
// Authenticated WebSocket reverse-proxy to go2rtc.
//
// Route: GET /live/ws?src=<go2rtc-stream-name>
//
// Security boundaries:
//   1. Auth  — requires a valid session cookie (same `resolveSession` used
//              everywhere). Any authenticated role (admin or child) may view.
//              Unauthenticated upgrades are rejected with HTTP 401 before the
//              WS handshake completes.
//   2. SSRF  — `src` is validated against the DB allowlist of enabled cameras'
//              `live_src` values. Arbitrary src values are NOT forwarded to
//              Frigate. Unknown src → HTTP 403 before upgrade.
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

// We only need the server for its `handleUpgrade` plumbing.
const wss = new WebSocketServer({ noServer: true });

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
    socket.write(
      'HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nUnauthorized',
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
    connectProxy(clientWs, src, user.id);
  });
}

/**
 * Open an upstream WebSocket to Frigate's go2rtc endpoint and bidirectionally
 * pipe all frames. Cleans up both sockets on any close/error.
 *
 * Frames sent by the client before the upstream handshake completes are
 * buffered and flushed once upstream is OPEN. This avoids a race where the
 * client (or the go2rtc VideoRTC protocol) sends a handshake frame immediately
 * after the client-side open event.
 */
function connectProxy(clientWs: WebSocket, src: string, userId: number): void {
  const cfg = getConfig();
  if (!cfg.FRIGATE_URL) {
    logger.error('live WS proxy: FRIGATE_URL not configured');
    clientWs.close(1011, 'Upstream not configured');
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
    if (upstreamWs.readyState !== WebSocket.CLOSED) {
      upstreamWs.close();
    }
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
