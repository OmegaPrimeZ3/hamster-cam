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
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import cron, { type ScheduledTask } from 'node-cron';
import pino from 'pino';

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
import { runRetentionJob } from './jobs/retention.js';
import { runTimelapseJob } from './jobs/timelapse.js';
import { startMqttSubscriber, type MqttSubscriber } from './mqtt.js';
import { flushPendingEntries, refreshNarratorTunings } from './narrator.js';
import { appRouter, createContext } from './trpc.js';

const execFile = promisify(execFileCb);
const logger = pino({ name: 'hamster-app', level: process.env['LOG_LEVEL'] ?? 'info' });

export type AppServer = Awaited<ReturnType<typeof buildFastify>>;

function buildFastify() {
  return Fastify({ loggerInstance: logger });
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

  // REST: /health  (no auth — local-only; Caddy rate-limits the path)
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
