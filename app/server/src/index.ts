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
import { extname, resolve as pathResolve, sep as pathSep } from 'node:path';

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

  // Private media: snapshot thumbnails written by `activity.snapshot` land at
  // `STORAGE_PATH/snapshots/<cam>-<ts>.jpg`. The diary entry stores a relative
  // path (`snapshots/...`) and the Vite proxy + Caddyfile both forward
  // `/snapshots/*` here — without this route, every "📸 You saved a memory"
  // card renders a broken-image placeholder. Gated on `requireAuth` because
  // these are household-private pet photos.
  registerPrivateMedia(app, 'snapshots', new Set(['.jpg', '.jpeg', '.png', '.webp']));

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

async function shutdown(handles: RuntimeHandles, sig: string): Promise<void> {
  handles.app.log.info({ sig }, 'shutting down');
  for (const t of handles.crons) {
    try { t.stop(); } catch { /* noop */ }
  }
  try {
    await flushPendingEntries();
  } catch (err) {
    handles.app.log.warn({ err: (err as Error).message }, 'narrator flush failed');
  }
  try {
    await handles.mqtt.close();
  } catch (err) {
    handles.app.log.warn({ err: (err as Error).message }, 'mqtt close failed');
  }
  try {
    await handles.app.close();
  } catch (err) {
    handles.app.log.warn({ err: (err as Error).message }, 'fastify close failed');
  }
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
