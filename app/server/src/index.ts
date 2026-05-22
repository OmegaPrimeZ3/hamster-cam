// app/server/src/index.ts
// Fastify boot entrypoint. PLAN §5.4 / §7.6.
//
// Boot order:
//   1. Validate env (fail fast if anything required is missing)
//   2. Run migrations on the configured DATABASE_PATH
//   3. Build Fastify, mount tRPC + /auth/* + /health
//   4. Start MQTT subscriber (best-effort; degrades to "no events" if broker absent)
//   5. Schedule cron jobs: timelapse 23:55, retention 02:00, disk-watch 03:00
//   6. Listen on PORT, host 0.0.0.0
//
// Shutdown order on SIGTERM/SIGINT:
//   1. Stop cron
//   2. Flush narrator pending state
//   3. Stop MQTT subscriber
//   4. Fastify close (drains in-flight)
//   5. Close DB

import { fileURLToPath } from 'node:url';
import { access, stat } from 'node:fs/promises';
import { constants as fsConstants, createReadStream } from 'node:fs';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, extname, resolve as pathResolve, sep as pathSep } from 'node:path';

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import cron, { type ScheduledTask } from 'node-cron';

import {
  forgotPassword,
  login,
  logout,
  me,
  mfaVerify,
  resetPassword,
} from './auth.js';
import { getConfig } from './config.js';
import { getDb, purgeExpiredSessions } from './db.js';
import { runDiskWatchJob } from './jobs/disk-watch.js';
import { runRecapJob } from './jobs/recap.js';
import { runRetentionJob } from './jobs/retention.js';
import { runTimelapseJob } from './jobs/timelapse.js';
import { logger } from './logger.js';
import { startMqttSubscriber, type MqttSubscriber } from './mqtt.js';
import { flushPendingEntries, refreshNarratorTunings } from './narrator.js';
import { initVapidKeys } from './push.js';
import { closeWss, registerLiveWsProxy } from './live-ws.js';
import { resolveSession } from './session.js';
import { appRouter, createContext } from './trpc.js';

const execFile = promisify(execFileCb);

export type AppServer = Awaited<ReturnType<typeof buildFastify>>;

function buildFastify() {
  // trustProxy covers loopback + the docker bridge subnet so Fastify treats
  // the X-Real-IP / X-Forwarded-For headers Caddy sets as authoritative
  // (paired with Security-Review Finding 1's `trusted_proxies cloudflare`
  // Caddy block). 172.16.0.0/12 is broad enough to cover every default
  // docker bridge network the compose stack will see.
  return Fastify({
    loggerInstance: logger,
    trustProxy: ['127.0.0.1', '::1', '172.16.0.0/12'],
  });
}

export async function buildServer(): Promise<AppServer> {
  // Force env validation NOW so we don't discover a missing var deep in a
  // handler much later.
  const cfg = getConfig();

  // Migrations run before Fastify binds to a port; a startup-time schema
  // problem surfaces immediately.
  getDb(cfg.DATABASE_PATH);
  purgeExpiredSessions();
  refreshNarratorTunings();
  initVapidKeys();

  const app = buildFastify();

  await app.register(cookie);

  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext,
      onError({ error, path }: { error: Error; path: string | undefined }) {
        app.log.error({ err: error, path }, 'trpc error');
      },
    },
  });

  // REST: /auth/*
  app.post('/auth/login', login);
  app.post('/auth/mfa/verify', mfaVerify);
  app.post('/auth/logout', logout);
  app.get('/auth/me', me);
  app.post('/auth/password/forgot', forgotPassword);
  app.post('/auth/password/reset', resetPassword);

  // Live-view WebSocket proxy: /live/ws?src=<go2rtc-stream-name>
  // Auth + SSRF guard are inside registerLiveWsProxy; no additional middleware needed here.
  registerLiveWsProxy(app);

  // Private media: snapshot thumbnails written by `activity.snapshot` land at
  // `STORAGE_PATH/snapshots/<cam>-<ts>.jpg`. The diary entry stores a relative
  // path (`snapshots/...`) and the Vite proxy + Caddyfile both forward
  // `/snapshots/*` here — without this route, every "📸 You saved a memory"
  // card renders a broken-image placeholder. Gated on `requireAuth` because
  // these are household-private pet photos.
  registerPrivateMedia(app, 'snapshots', new Set(['.jpg', '.jpeg', '.png', '.webp']));

  // SPA static handler: serves the built React app for all GET requests that
  // don't match an existing API route. Registered via setNotFoundHandler so it
  // only fires after every explicit route (tRPC /trpc/*, /auth/*, /health,
  // /snapshots/*) has already declined to match. Registration is skipped with
  // a warning if the dist directory doesn't exist at boot (local dev).
  await registerSpaStatic(app, cfg.WEB_DIST_PATH);

  // REST: /health is reachable on the LAN for docker healthchecks; Caddy
  // returns 404 to external requests via an internal-IP allowlist (see the
  // infra-engineer Stage 5 fix for Security-Review Finding 3). Kept
  // unauthenticated here because docker healthchecks can't carry session
  // cookies — the Caddy ACL is what keeps the path off the public internet.
  app.get('/health', async () => {
    const result = {
      ok: true,
      ts: Date.now(),
      db: 'ok' as 'ok' | 'fail',
      storage: 'ok' as 'ok' | 'fail',
      disk_free_pct: null as number | null,
    };
    try {
      getDb().prepare('SELECT 1').get();
    } catch {
      result.db = 'fail';
      result.ok = false;
    }
    try {
      await access(cfg.STORAGE_PATH, fsConstants.W_OK);
    } catch {
      result.storage = 'fail';
      result.ok = false;
    }
    try {
      const { stdout } = await execFile('df', ['-k', cfg.STORAGE_PATH]);
      const cols = stdout.trim().split('\n')[1]?.split(/\s+/) ?? [];
      const total = Number.parseInt(cols[1] ?? '0', 10);
      const free = Number.parseInt(cols[3] ?? '0', 10);
      if (total > 0) {
        result.disk_free_pct = Math.round((free / total) * 100);
      }
    } catch {
      // disk_free_pct stays null
    }
    return result;
  });

  return app;
}

// ---------------------------------------------------------------------------
// SPA static handler
// ---------------------------------------------------------------------------

// Content-type map for files the React SPA build emits.
const SPA_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html':        'text/html; charset=utf-8',
  '.js':          'application/javascript; charset=utf-8',
  '.mjs':         'application/javascript; charset=utf-8',
  '.css':         'text/css; charset=utf-8',
  '.json':        'application/json; charset=utf-8',
  '.svg':         'image/svg+xml',
  '.png':         'image/png',
  '.jpg':         'image/jpeg',
  '.jpeg':        'image/jpeg',
  '.webp':        'image/webp',
  '.woff':        'font/woff',
  '.woff2':       'font/woff2',
  '.ico':         'image/x-icon',
  '.map':         'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt':         'text/plain; charset=utf-8',
};

// Files that must never be cached (they change on every deploy).
function isNoCacheFile(rel: string): boolean {
  return rel === 'index.html' || rel === 'sw.js' || rel === 'registerSW.js';
}

/**
 * Resolve the web dist directory from the optional env override, or fall back
 * to `../../web/dist` relative to the compiled module file (index.js sits at
 * `app/server/dist/index.js`; the web dist is at `app/web/dist`). Uses
 * `import.meta.url` so the resolution is independent of the process working
 * directory.
 */
function resolveWebDistPath(envOverride: string | undefined): string {
  if (envOverride) return pathResolve(envOverride);
  // `import.meta.url` is the canonical location of this compiled module.
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return pathResolve(moduleDir, '../../web/dist');
}

/**
 * Register a Fastify `setNotFoundHandler` that serves the built React SPA for
 * any request that fell through all explicit routes. Strategy:
 *
 *   1. Real static asset file exists under distRoot → stream it with
 *      appropriate content-type + cache headers.
 *   2. GET request with `Accept: text/html` (browser navigation) → stream
 *      `index.html` (SPA fallback for client-side routes like /diary).
 *   3. Everything else → plain JSON 404 (API callers hitting unknown paths
 *      still get a machine-readable response).
 *
 * Path traversal is rejected the same way as `registerPrivateMedia`: string
 * check for `..` / NUL / leading `/` AND re-resolution confirming the
 * absolute path stays under distRoot.
 *
 * Safety gate: if distRoot does not exist at boot, log a warning and return
 * without registering — the server runs fine, just without SPA serving (local
 * dev uses the Vite dev server instead).
 */
async function registerSpaStatic(app: AppServer, envOverride: string | undefined): Promise<void> {
  const distRoot = resolveWebDistPath(envOverride);

  let distExists = false;
  try {
    const st = await stat(distRoot);
    distExists = st.isDirectory();
  } catch {
    distExists = false;
  }

  if (!distExists) {
    app.log.warn(
      { distRoot },
      'web dist directory not found — SPA static handler skipped (run `pnpm build` in app/web or set WEB_DIST_PATH)',
    );
    return;
  }

  app.log.info({ distRoot }, 'registering SPA static handler');

  const indexPath = pathResolve(distRoot, 'index.html');

  app.setNotFoundHandler(async (req, reply) => {
    // Only GET/HEAD can serve files; all other verbs 404 as JSON.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return reply.code(404).send({ message: 'Not Found', error: 'Not Found', statusCode: 404 });
    }

    // Strip the leading `/` to get a relative path (req.url is always `/...`).
    const rawRel = (req.url ?? '/').replace(/^\//, '').split('?')[0] ?? '';

    // Path traversal guards — mirror the pattern from registerPrivateMedia.
    if (rawRel.includes('..') || rawRel.includes('\0')) {
      return reply.code(400).send({ error: 'bad path' });
    }

    // Try to serve a real file first (assets, manifest, favicon, etc.).
    if (rawRel !== '') {
      const abs = pathResolve(distRoot, rawRel);
      // Re-resolve confirms no traversal escaped the guards above.
      if (abs !== distRoot && !abs.startsWith(distRoot + pathSep)) {
        return reply.code(400).send({ error: 'bad path' });
      }

      let fileStat: Awaited<ReturnType<typeof stat>> | null = null;
      try {
        fileStat = await stat(abs);
      } catch {
        fileStat = null;
      }

      if (fileStat?.isFile()) {
        const ext = extname(rawRel).toLowerCase();
        const contentType = SPA_CONTENT_TYPES[ext] ?? 'application/octet-stream';
        reply.type(contentType);
        // Vite hashes asset filenames under assets/ — they're safe to cache
        // for a year. Root-level files (index.html, sw.js, etc.) must not be
        // cached so PWA updates land immediately.
        if (rawRel.startsWith('assets/') && !isNoCacheFile(rawRel)) {
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          reply.header('Cache-Control', 'no-cache');
        }
        return reply.send(createReadStream(abs));
      }
    }

    // No matching file. Serve index.html for browser navigations (Accept
    // includes text/html) so deep links like /diary work after a hard refresh.
    // For everything else (API clients, fetch() without Accept: text/html)
    // return JSON 404.
    const accept = (req.headers['accept'] as string | undefined) ?? '';
    if (accept.includes('text/html')) {
      reply.header('Cache-Control', 'no-cache');
      reply.type('text/html; charset=utf-8');
      return reply.send(createReadStream(indexPath));
    }

    return reply.code(404).send({ message: 'Not Found', error: 'Not Found', statusCode: 404 });
  });
}

// ---------------------------------------------------------------------------
// Private media streaming
// ---------------------------------------------------------------------------

// Stream `STORAGE_PATH/<subdir>/<file>` for any `GET /<subdir>/*` after a
// session check. Rejects path traversal both by string-matching `..` and by
// re-resolving the joined path and confirming it still lives under the base
// directory. Extension allowlist keeps the route from doubling as an arbitrary
// file server.
function registerPrivateMedia(
  app: AppServer,
  subdir: 'snapshots',
  allowedExts: ReadonlySet<string>,
): void {
  const cfg = getConfig();
  const baseDir = pathResolve(cfg.STORAGE_PATH, subdir);

  const CONTENT_TYPES: Record<string, string> = {
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png':  'image/png',
    '.webp': 'image/webp',
  };

  app.get(`/${subdir}/*`, async (req, reply) => {
    // Inline auth check (matches the pattern in auth.ts) — keeps the route
    // off the `preHandler` typing path that Fastify 5 / strict TS rejects.
    if (!resolveSession(req)) {
      return reply.code(401).send({ error: 'unauthenticated' });
    }
    const params = req.params as { '*'?: string };
    const rel = params['*'] ?? '';
    if (!rel || rel.includes('..') || rel.includes('\0') || rel.startsWith('/')) {
      return reply.code(400).send({ error: 'bad path' });
    }
    const ext = extname(rel).toLowerCase();
    if (!allowedExts.has(ext)) {
      return reply.code(404).send({ error: 'not found' });
    }
    const abs = pathResolve(baseDir, rel);
    if (abs !== baseDir && !abs.startsWith(baseDir + pathSep)) {
      return reply.code(400).send({ error: 'bad path' });
    }
    let st;
    try {
      st = await stat(abs);
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
    if (!st.isFile() || st.size === 0) {
      // Zero-byte placeholders are written when Frigate was unreachable at
      // capture time; treat them as missing so the client renders the empty
      // tile instead of a broken-image glyph.
      return reply.code(404).send({ error: 'not found' });
    }
    reply.header('Cache-Control', 'private, max-age=604800, immutable');
    reply.type(CONTENT_TYPES[ext] ?? 'application/octet-stream');
    return reply.send(createReadStream(abs));
  });
}

interface RuntimeHandles {
  app: AppServer;
  mqtt: MqttSubscriber;
  crons: ScheduledTask[];
}

export async function startRuntime(): Promise<RuntimeHandles> {
  const app = await buildServer();
  const cfg = getConfig();

  let mqtt: MqttSubscriber;
  try {
    mqtt = startMqttSubscriber();
  } catch (err) {
    app.log.warn({ err: (err as Error).message }, 'mqtt failed to initialise; continuing');
    mqtt = { ready: async () => {}, close: async () => {} };
  }

  const crons = scheduleCronJobs(app);

  await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
  app.log.info({ port: cfg.PORT }, 'hamster-cam server listening');

  return { app, mqtt, crons };
}

function scheduleCronJobs(app: AppServer): ScheduledTask[] {
  const jobs: Array<{ name: string; spec: string; run: () => Promise<unknown> }> = [
    { name: 'timelapse',  spec: '55 23 * * *', run: () => runTimelapseJob() },
    { name: 'recap',      spec: '58 23 * * *', run: () => runRecapJob() },
    { name: 'retention',  spec: '0 2 * * *',  run: () => runRetentionJob() },
    { name: 'disk-watch', spec: '0 3 * * *',  run: () => runDiskWatchJob() },
  ];

  const tasks: ScheduledTask[] = [];
  for (const job of jobs) {
    const task = cron.schedule(job.spec, () => {
      app.log.info({ job: job.name }, 'cron tick');
      job.run().catch((err: unknown) => {
        app.log.error({ err, job: job.name }, 'cron job failed');
      });
    });
    tasks.push(task);
  }
  app.log.info({ jobs: jobs.map((j) => j.name) }, 'cron jobs scheduled');
  return tasks;
}

// Hard deadline: if the graceful sequence hasn't finished in 8 s we force-exit
// so `docker stop`'s 10 s SIGKILL window doesn't land mid-write. The DB close
// step is last — once SQLite's WAL checkpoint completes the exit is safe.
const SHUTDOWN_TIMEOUT_MS = 8_000;

async function shutdown(handles: RuntimeHandles, sig: string): Promise<void> {
  handles.app.log.info({ sig }, 'shutting down');

  // Arm the hard-exit timer FIRST so it covers every step below.
  const forceExit = setTimeout(() => {
    handles.app.log.error('shutdown timeout — forcing exit(1)');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  // Don't let this timer keep the event-loop alive if everything finishes early.
  forceExit.unref();

  // 1. Stop cron schedulers (synchronous; no more ticks will fire).
  for (const t of handles.crons) {
    try { t.stop(); } catch { /* noop */ }
  }

  // 2. Flush the narrator's in-memory coalescing window to the DB.
  try {
    await flushPendingEntries();
  } catch (err) {
    handles.app.log.warn({ err: (err as Error).message }, 'narrator flush failed');
  }

  // 3. Close in-flight live-view WS proxy connections (terminates all clients,
  //    closes the module-level WebSocketServer). Must happen before Fastify
  //    closes so the underlying http.Server upgrade listener is cleared.
  try {
    await closeWss();
  } catch (err) {
    handles.app.log.warn({ err: (err as Error).message }, 'wss close failed');
  }

  // 4. Disconnect the MQTT client.
  try {
    await handles.mqtt.close();
  } catch (err) {
    handles.app.log.warn({ err: (err as Error).message }, 'mqtt close failed');
  }

  // 5. Stop accepting new HTTP connections + drain in-flight requests.
  try {
    await handles.app.close();
  } catch (err) {
    handles.app.log.warn({ err: (err as Error).message }, 'fastify close failed');
  }

  // 6. Close the SQLite connection last — ensures the WAL checkpoint runs
  //    after all writes have landed, preventing truncated DB writes.
  try {
    getDb().close();
  } catch (err) {
    handles.app.log.warn({ err: (err as Error).message }, 'db close failed');
  }

  clearTimeout(forceExit);
}

async function main(): Promise<void> {
  const handles = await startRuntime();
  const onSig = (sig: string): void => {
    void shutdown(handles, sig).then(() => process.exit(0));
  };
  process.on('SIGTERM', () => onSig('SIGTERM'));
  process.on('SIGINT', () => onSig('SIGINT'));
}

const invokedDirectly = process.argv[1]
  && (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js')
    || fileURLToPath(import.meta.url) === process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    logger.error({ err }, 'fatal startup error');
    process.exit(1);
  });
}
