// app/server/src/diary-stream.ts
//
// Authenticated Server-Sent Events feed for diary-row mutations.
//
// Route: GET /diary/stream
//
// Wire format:
//   event: ready
//   data: {"ts":1234567890123}
//
//   event: entry                         ← kind: 'create'
//   data: <DiaryEntryDTO JSON>
//
//   event: entry-update                  ← kind: 'update' (extendDiaryEntry)
//   data: <DiaryEntryDTO JSON>
//
//   event: ping                          ← every HEARTBEAT_INTERVAL_MS
//   data: {"ts":1234567890123}
//
// Security boundaries:
//   1. Auth — same `resolveSession` cookie check as every other private route.
//             Unauthenticated requests get HTTP 401 before the stream opens.
//   2. Limits — global + per-user connection cap so a misbehaving client cannot
//               exhaust file descriptors.
//
// Resilience:
//   - 15 s heartbeat lets reverse proxies (Caddy, Cloudflare) know the
//     connection is still alive and prevents idle timeouts.
//   - On client disconnect (`close` event), the listener is detached so the
//     EventEmitter doesn't leak.
//   - Polling in the React Query hook continues at 30 s as a fallback for any
//     event lost between disconnect and EventSource's auto-reconnect.

import type { FastifyReply, FastifyRequest } from 'fastify';

import { subscribeDiaryEvents } from './diary-events.js';
import { logger } from './logger.js';
import { resolveSession } from './session.js';
import { diaryToDTO } from './trpc.js';
import type { AppServer } from './index.js';

const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_CONNECTIONS_GLOBAL = 100;
const MAX_CONNECTIONS_PER_USER = 5;

let globalConnections = 0;
const perUserConnections = new Map<number, number>();

function incrementConnection(userId: number): void {
  globalConnections += 1;
  perUserConnections.set(userId, (perUserConnections.get(userId) ?? 0) + 1);
}

function decrementConnection(userId: number): void {
  globalConnections = Math.max(0, globalConnections - 1);
  const prev = perUserConnections.get(userId) ?? 0;
  const next = Math.max(0, prev - 1);
  if (next === 0) {
    perUserConnections.delete(userId);
  } else {
    perUserConnections.set(userId, next);
  }
}

/** Test helper — resets counters between test runs. */
export function resetDiaryStreamCountsForTests(): void {
  globalConnections = 0;
  perUserConnections.clear();
}

/** Register the GET /diary/stream SSE route. Called once from buildServer(). */
export function registerDiaryStream(app: AppServer): void {
  app.get('/diary/stream', async (req, reply) => handleStream(req, reply));
  app.log.info('diary SSE registered at /diary/stream');
}

async function handleStream(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = resolveSession(req);
  if (!user) {
    await reply.code(401).send({ error: 'unauthenticated' });
    return;
  }

  // Per-user / global caps protect file-descriptor exhaustion.
  const userConnections = perUserConnections.get(user.id) ?? 0;
  if (globalConnections >= MAX_CONNECTIONS_GLOBAL || userConnections >= MAX_CONNECTIONS_PER_USER) {
    logger.warn(
      { userId: user.id, globalConnections, userConnections },
      'diary SSE: connection cap reached — rejecting 503',
    );
    await reply.code(503).send({ error: 'too many connections' });
    return;
  }

  // SSE headers.
  // - text/event-stream is the protocol's required content type.
  // - no-cache + Connection: keep-alive keeps Caddy/Cloudflare from buffering.
  // - X-Accel-Buffering: no disables nginx-style proxy buffering (Caddy honors
  //   the same hint).
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  reply.hijack();

  incrementConnection(user.id);

  // Hello frame — also flushes any reverse-proxy buffers so the browser's
  // EventSource fires `onopen` immediately.
  writeFrame(reply, 'ready', JSON.stringify({ ts: Date.now() }));

  const unsubscribe = subscribeDiaryEvents((evt) => {
    try {
      const dto = diaryToDTO(evt.row);
      const event = evt.kind === 'create' ? 'entry' : 'entry-update';
      writeFrame(reply, event, JSON.stringify(dto));
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, userId: user.id },
        'diary SSE: failed to serialise event — dropping',
      );
    }
  });

  const heartbeat = setInterval(() => {
    writeFrame(reply, 'ping', JSON.stringify({ ts: Date.now() }));
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  const cleanup = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
    decrementConnection(user.id);
  };

  reply.raw.on('close', cleanup);
  reply.raw.on('error', cleanup);
}

/**
 * Write one SSE frame. Each frame is a `event:` name plus one or more `data:`
 * lines, terminated by a blank line. We split `data` on `\n` because SSE
 * requires every line in the payload to be prefixed.
 */
function writeFrame(reply: FastifyReply, event: string, data: string): void {
  // If the socket has already been closed (client disconnected between events),
  // writes will throw EPIPE / ERR_STREAM_DESTROYED. Swallow them — the close
  // handler will run the cleanup.
  if (reply.raw.destroyed || reply.raw.writableEnded) return;
  try {
    let frame = `event: ${event}\n`;
    for (const line of data.split('\n')) {
      frame += `data: ${line}\n`;
    }
    frame += '\n';
    reply.raw.write(frame);
  } catch {
    /* socket closed mid-write — close handler will clean up */
  }
}
