// e2e/fixtures/stack.ts
//
// Stands up the integrated stack for one e2e spec:
//   1. Zyphr mock server (records every call; specs can `forceError` it).
//   2. Backend Fastify in a CHILD PROCESS via tsx (so module-level singletons
//      reset cleanly per spec — no leakage of DB handles, narrator pending
//      state, or the cached Zyphr SDK client between tests).
//   3. A tiny in-process reverse-proxy + static server that:
//        - serves app/web/dist for everything except backend paths
//        - proxies /auth/*, /trpc/*, /snapshots/*, /stream/*, /api/*, /health
//          → the backend port
//      (this mirrors Caddy's role in production without TLS/firewall)
//
// One stack per spec keeps assertions hermetic; startup is ~1-2s per spec.

import { spawn, type ChildProcess } from 'node:child_process';
import {
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer, type Server } from 'node:https';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

import { createTestDb, type TestDbHandle, type SeedUserInput } from './db-factory.js';
import { startFrigateMock, type FrigateMock, type FrigateMockCamera } from './frigate-mock.js';
import { startMqttBroker, type MqttBroker } from './mqtt-broker.js';
import { startZyphrMock, type ZyphrMock, type ZyphrUserSeed } from './msw-zyphr.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = join(__dirname, '..', '..', 'app', 'web', 'dist');
const SERVER_SRC_INDEX = join(__dirname, '..', '..', 'app', 'server', 'src', 'index.ts');
const SERVER_BOOT_HELPER = join(__dirname, 'server-boot.ts');
const TSX_BIN = join(__dirname, '..', 'node_modules', '.bin', 'tsx');
const TLS_CERT_PATH = join(__dirname, 'cert', 'cert.pem');
const TLS_KEY_PATH = join(__dirname, 'cert', 'key.pem');

export interface StackHandle {
  frontUrl: string;
  apiUrl: string;
  dbPath: string;
  zyphr: ZyphrMock;
  /** Frigate mock — null when `frigate` not requested. */
  frigate: FrigateMock | null;
  /** MQTT broker — null when `mqtt: false` (default). */
  mqtt: MqttBroker | null;
  db: TestDbHandle;
  close: () => Promise<void>;
  /** Kill the backend mid-spec (used by the PWA offline-shell test). */
  killBackend: () => Promise<void>;
  /** Restart the backend on a fresh port (proxy re-targets automatically). */
  restartBackend: () => Promise<void>;
}

export interface StackOptions {
  users?: Array<SeedUserInput & { password: string; mfa_required?: boolean; mfa_code?: string }>;
  cameras?: Array<{ name: string; emoji?: string; stream_url: string; enabled?: boolean }>;
  recipients?: Array<{ display_name: string; email: string }>;
  settings?: Record<string, string>;
  diary?: Array<Parameters<TestDbHandle['seedDiary']>[0]>;
  /** Zyphr-only users — exist at Zyphr but have no local mirror (drives 403 not_provisioned). */
  zyphrOnlyUsers?: ZyphrUserSeed[];
  /** Don't seed any users (used by the bootstrap.spec to start from an empty DB). */
  noUsers?: boolean;
  /** LOG_LEVEL passed to the backend child process. Defaults to 'silent'. */
  logLevel?: string;
  /**
   * Start a mock Frigate server and point the backend at it.
   * Pre-seed the list of cameras it advertises via `/api/config`. Specs can
   * also adjust the list at runtime via `stack.frigate.setCameras([...])`.
   */
  frigate?: FrigateMockCamera[];
  /**
   * Start an in-process MQTT broker (aedes) and point the backend at it.
   * Required for any spec that exercises the narrator end-to-end.
   */
  mqtt?: boolean;
}

interface BackendHandle {
  port: number;
  child: ChildProcess;
  close: () => Promise<void>;
}

export async function startStack(opts: StackOptions = {}): Promise<StackHandle> {
  // 1) Database with migrations + seed rows.
  const db = await createTestDb();

  if (opts.settings) {
    for (const [k, v] of Object.entries(opts.settings)) {
      db.setSetting(k, v);
    }
  }
  const seededUsers: Array<{ row: ReturnType<TestDbHandle['seedUser']>; password: string }> = [];
  if (!opts.noUsers) {
    for (const u of opts.users ?? []) {
      const row = db.seedUser({
        email: u.email,
        display_name: u.display_name,
        role: u.role,
        zyphr_user_id: u.zyphr_user_id,
      });
      seededUsers.push({ row, password: u.password });
    }
  }
  if (opts.cameras) {
    for (const cam of opts.cameras) {
      db.seedCamera({
        name: cam.name,
        emoji: cam.emoji,
        stream_url: cam.stream_url,
        enabled: cam.enabled,
      });
    }
  }
  if (opts.recipients) {
    for (const r of opts.recipients) {
      db.seedRecipient(r);
    }
  }
  if (opts.diary) {
    for (const d of opts.diary) {
      db.seedDiary(d);
    }
  }
  db.close();

  // 2) Zyphr mock — must be running before the child process starts so the
  // backend's first call lands somewhere real.
  const zyphrUsers: ZyphrUserSeed[] = [];
  for (const { row, password } of seededUsers) {
    const u = (opts.users ?? []).find((x) => x.email === row.email);
    zyphrUsers.push({
      email: row.email,
      password,
      zyphr_user_id: row.zyphr_user_id,
      name: row.display_name,
      ...(u?.mfa_required !== undefined ? { mfa_required: u.mfa_required } : {}),
      ...(u?.mfa_code !== undefined ? { mfa_code: u.mfa_code } : {}),
    });
  }
  for (const u of opts.zyphrOnlyUsers ?? []) {
    zyphrUsers.push(u);
  }
  const zyphr = await startZyphrMock({ users: zyphrUsers });

  // 2b) Optional Frigate mock — only started when the spec asks for it, since
  // most flows degrade gracefully when FRIGATE_URL is unset.
  let frigate: FrigateMock | null = null;
  let frigateBaseUrl: string | undefined;
  if (opts.frigate !== undefined) {
    frigate = await startFrigateMock(opts.frigate);
    frigateBaseUrl = frigate.baseUrl;
  }

  // 2c) Optional MQTT broker for narrator-driven flows.
  let mqttBroker: MqttBroker | null = null;
  let mqttUrl: string | undefined;
  if (opts.mqtt) {
    mqttBroker = await startMqttBroker();
    mqttUrl = mqttBroker.url;
  }

  // 3) Backend child process.
  const backend = await startBackendChild({
    dbPath: db.path,
    storagePath: dirname(db.path),
    zyphrBaseUrl: zyphr.baseUrl,
    frigateBaseUrl,
    mqttUrl,
    logLevel: opts.logLevel ?? 'silent',
  });

  // 4) Static + reverse-proxy frontend server. HTTPS is required because the
  // backend sets the session cookie with the `__Host-` prefix + Secure flag;
  // Chromium refuses to store such a cookie on plain `http://127.0.0.1`. Vite
  // preview / Caddy would also serve HTTPS in production, so this matches
  // reality. The cert is a self-signed CA we ship in fixtures/cert/.
  const front = await startFrontend({ getBackendPort: () => backend.port });

  return {
    frontUrl: `https://127.0.0.1:${front.port}`,
    apiUrl: `http://127.0.0.1:${backend.port}`,
    dbPath: db.path,
    zyphr,
    frigate,
    mqtt: mqttBroker,
    db,
    close: async () => {
      await front.close();
      await backend.close();
      await zyphr.close();
      if (frigate) await frigate.close();
      if (mqttBroker) await mqttBroker.close();
      await db.cleanup();
    },
    killBackend: async () => {
      await backend.close();
    },
    restartBackend: async () => {
      const restarted = await startBackendChild({
        dbPath: db.path,
        storagePath: dirname(db.path),
        zyphrBaseUrl: zyphr.baseUrl,
        frigateBaseUrl,
        mqttUrl,
        logLevel: opts.logLevel ?? 'silent',
      });
      backend.port = restarted.port;
      backend.child = restarted.child;
      backend.close = restarted.close;
    },
  };
}

interface BackendChildOpts {
  dbPath: string;
  storagePath: string;
  zyphrBaseUrl: string;
  frigateBaseUrl: string | undefined;
  mqttUrl: string | undefined;
  logLevel: string;
}

async function startBackendChild(opts: BackendChildOpts): Promise<BackendHandle> {
  // Spawn `tsx <boot-helper>` so each backend gets its own clean module state.
  // The helper imports `buildServer()`, listens on a random port, then prints
  // `READY <port>` on stdout — we wait for that line.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_PATH: opts.dbPath,
    STORAGE_PATH: opts.storagePath,
    ZYPHR_API_KEY: 'test-api-key',
    ZYPHR_BASE_URL: opts.zyphrBaseUrl,
    ZYPHR_FROM_EMAIL: 'cam@hamster.test',
    SESSION_TTL_DAYS: '30',
    NODE_ENV: 'test',
    LOG_LEVEL: opts.logLevel,
    PORT: '0',
    ...(opts.frigateBaseUrl ? { FRIGATE_URL: opts.frigateBaseUrl } : {}),
    ...(opts.mqttUrl ? { MQTT_URL: opts.mqttUrl } : {}),
  };

  const child = spawn(TSX_BIN, [SERVER_BOOT_HELPER], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrBuf = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    if (opts.logLevel !== 'silent') {
      process.stderr.write(`[backend ${child.pid}] ${chunk}`);
    }
  });

  const port = await new Promise<number>((resolve, reject) => {
    let stdoutBuf = '';
    const onData = (chunk: Buffer): void => {
      stdoutBuf += chunk.toString();
      if (opts.logLevel !== 'silent') {
        process.stdout.write(`[backend ${child.pid}] ${chunk}`);
      }
      const m = /^READY (\d+)/m.exec(stdoutBuf);
      if (m) {
        child.stdout?.off('data', onData);
        if (opts.logLevel !== 'silent') {
          // Keep tailing for visibility after READY.
          child.stdout?.on('data', (b: Buffer) => {
            process.stdout.write(`[backend ${child.pid}] ${b}`);
          });
        }
        resolve(Number(m[1]));
      }
    };
    child.stdout?.on('data', onData);
    child.once('exit', (code) => {
      if (stdoutBuf.includes('READY')) return; // resolved already
      reject(
        new Error(
          `backend child exited with code ${code} before READY. stderr=\n${stderrBuf}`,
        ),
      );
    });
    setTimeout(() => {
      if (!stdoutBuf.includes('READY')) {
        reject(new Error(`backend child did not become READY in 30s. stderr=\n${stderrBuf}`));
      }
    }, 30_000);
  });

  // Quick smoke check: /health responds. This catches DB-not-migrated failures
  // before the first spec request, which would otherwise present as a flaky
  // browser-side timeout.
  await waitForHealth(`http://127.0.0.1:${port}/health`, 8_000);

  return {
    port,
    child,
    close: async () => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 3_000);
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    },
  };
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  // Short retry loop — no real sleep needed; we yield via fetch().
  // The first request may race the listener; we accept any 2xx body.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`backend /health did not respond within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

interface FrontendHandle {
  port: number;
  close: () => Promise<void>;
}

async function startFrontend(opts: { getBackendPort: () => number }): Promise<FrontendHandle> {
  const [cert, key] = await Promise.all([
    readFile(TLS_CERT_PATH),
    readFile(TLS_KEY_PATH),
  ]);
  const server: Server = createHttpsServer({ cert, key }, (req, res) => {
    void handleRequest(req, res, opts.getBackendPort).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'text/plain');
        res.end(`stack proxy error: ${msg}`);
      } else {
        res.end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  return {
    port,
    close: async () => {
      // Force-close any in-flight upstream connections; otherwise the SW's
      // long-running fetch listeners can keep the server alive past Playwright's
      // afterEach timeout.
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const PROXY_PREFIXES = ['/auth/', '/trpc/', '/snapshots/', '/stream/', '/api/'];
const PROXY_EXACT = new Set(['/health']);

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  getBackendPort: () => number,
): Promise<void> {
  const url = req.url ?? '/';
  const path = url.split('?')[0] ?? '/';
  if (PROXY_EXACT.has(path) || PROXY_PREFIXES.some((p) => path.startsWith(p))) {
    await proxy(req, res, getBackendPort());
    return;
  }
  await serveStatic(req, res, url);
}

async function proxy(req: IncomingMessage, res: ServerResponse, backendPort: number): Promise<void> {
  const headers = { ...req.headers };
  delete headers['host'];
  const upstream = httpRequest(
    {
      host: '127.0.0.1',
      port: backendPort,
      method: req.method,
      path: req.url,
      headers,
    },
    (upRes) => {
      res.statusCode = upRes.statusCode ?? 502;
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (v !== undefined) res.setHeader(k, v as string | string[]);
      }
      upRes.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader('content-type', 'text/plain');
      res.end(`upstream error: ${err.message}`);
    } else {
      res.end();
    }
  });
  req.pipe(upstream);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
};

async function serveStatic(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
  const cleanPath = (url.split('?')[0] ?? '/').replace(/^\/+/, '');
  const target = normalize(join(WEB_DIST, cleanPath));
  if (!target.startsWith(WEB_DIST)) {
    res.statusCode = 403;
    res.end('forbidden');
    return;
  }
  let filePath = target;
  let isHtmlFallback = false;
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) {
      filePath = join(filePath, 'index.html');
      isHtmlFallback = true;
    }
  } catch {
    filePath = join(WEB_DIST, 'index.html');
    isHtmlFallback = true;
  }
  let buf: Buffer;
  try {
    buf = await readFile(filePath);
  } catch {
    res.statusCode = 500;
    res.setHeader('content-type', 'text/plain');
    res.end(
      'Frontend bundle not found at app/web/dist. Run `pnpm -C app/web build` before `pnpm e2e`.',
    );
    return;
  }
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  res.statusCode = 200;
  res.setHeader('content-type', isHtmlFallback ? MIME['.html'] : (MIME[ext] ?? 'application/octet-stream'));
  res.setHeader('cache-control', 'no-store');
  res.end(buf);
}

// Re-export pieces a spec needs.
export { SERVER_SRC_INDEX };
