// app/server/src/index.ts
// Fastify boot entrypoint. Real route registration: tRPC adapter, /auth/*
// REST handlers, /health, cookie plugin. MQTT + cron startup are guarded so
// the process starts even when those services aren't reachable (logged at
// warn level), keeping `pnpm dev` useful in laptop scenarios.
//
// PLAN §5.4 / §7.6.

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import pino from 'pino';

import {
  forgotPassword,
  login,
  logout,
  me,
  mfaVerify,
  resetPassword,
} from './auth.js';
import { getDb, purgeExpiredSessions } from './db.js';
import { runDiskWatchJob } from './jobs/disk-watch.js';
import { runRetentionJob } from './jobs/retention.js';
import { runTimelapseJob } from './jobs/timelapse.js';
import { startMqttSubscriber } from './mqtt.js';
import { appRouter, createContext } from './trpc.js';

const STAGE_TWO_A_MARKER = 'Stage 2a will implement';

const logger = pino({ name: 'hamster-app' });

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`required env var ${name} is not set`);
  }
  return v;
}

export async function buildServer(): Promise<ReturnType<typeof Fastify>> {
  // Migrations run first so a startup-time schema problem surfaces before
  // Fastify binds to a port.
  getDb(requireEnv('DATABASE_PATH'));
  purgeExpiredSessions();

  const app = Fastify({ loggerInstance: logger });

  await app.register(cookie);

  // tRPC
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext,
      onError({ error, path }: { error: Error; path: string | undefined }) {
        // Distinguish "Stage 2a will implement" throws from real bugs so the
        // logs stay actionable during the parallel-stage window.
        const level = error.message.includes(STAGE_TWO_A_MARKER) ? 'debug' : 'error';
        app.log[level]({ err: error, path }, 'trpc error');
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

  // REST: /health  (no auth — local-only; Caddy rate-limits the path anyway)
  app.get('/health', async () => ({
    ok: true,
    ts: Date.now(),
  }));

  return app;
}

async function main(): Promise<void> {
  const app = await buildServer();

  // MQTT + cron startup. These intentionally do not fail server boot — if the
  // broker or Frigate isn't up yet we want the HTTP surface available for
  // health checks. The thrown Stage-2a errors are caught, logged, and ignored.
  try {
    startMqttSubscriber();
  } catch (err) {
    app.log.warn({ err }, 'mqtt subscriber not yet implemented');
  }

  scheduleCronJobs(app);

  const port = Number.parseInt(process.env['PORT'] ?? '3000', 10);
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info({ port }, 'hamster-cam server listening');

  const shutdown = async (sig: string): Promise<void> => {
    app.log.info({ sig }, 'shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

function scheduleCronJobs(app: ReturnType<typeof Fastify>): void {
  // Wiring cron at Stage 1 would require importing node-cron and pinning the
  // schedule — but the jobs themselves throw. We defer the schedule wire-up
  // to Stage 2a (which also unit-tests fast-forwarded ticks). Importing the
  // job modules here ensures Stage 2a's autocomplete already knows them.
  void runTimelapseJob;
  void runRetentionJob;
  void runDiskWatchJob;
  app.log.debug('cron jobs will be scheduled by Stage 2a');
}

const invokedDirectly = process.argv[1]?.endsWith('index.ts')
  || process.argv[1]?.endsWith('index.js');
if (invokedDirectly) {
  main().catch((err) => {
    logger.error({ err }, 'fatal startup error');
    process.exit(1);
  });
}
