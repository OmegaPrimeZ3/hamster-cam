// test/live-ws.test.ts
// Tests for the authenticated WS proxy at GET /live/ws?src=<name>.
//
// Strategy:
//   - Spin up the real Fastify server (no stubs — quality bar says no stubs).
//   - Use a real in-process ws server to stand in for go2rtc/Frigate.
//   - Authenticate via the DB / session layer.
//   - Assert auth enforcement, SSRF allowlist, frame piping, and disconnect
//     cleanup.
//
// We use `ws` on both sides: the test-client side and the fake-Frigate side.

import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';

import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { resetConfigForTests } from '../src/config.js';
import { resetDbForTests } from '../src/db.js';
import { buildServer } from '../src/index.js';
import { migrate } from '../src/migrate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Open a client WS and wait for open or close. */
function connectWs(url: string, cookie: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { cookie } });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('close', (code, reason) => {
      // If we closed before open fired, reject with the code.
      reject(new Error(`WS closed before open: code=${code} reason=${reason.toString()}`));
    });
  });
}

/** Open a client WS and wait for it to close. Returns close code. */
function connectWsExpectClose(url: string, cookie = ''): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: cookie ? { cookie } : {} });
    ws.on('close', (code) => resolve(code));
    ws.on('error', () => resolve(1006));
  });
}

/** Wait for the next message on a WS. */
function nextMessage(ws: WebSocket): Promise<string | Buffer> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => resolve(data as string | Buffer));
    ws.once('close', () => reject(new Error('closed before message')));
    ws.once('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Fake Frigate / go2rtc server
// ---------------------------------------------------------------------------

let fakeServer: ReturnType<typeof createServer>;
let fakeWss: WebSocketServer;
let fakePort: number;

/**
 * Starts the fake Frigate HTTP+WS server on an ephemeral port.
 * - GET /api/go2rtc/api/streams → JSON with known stream names
 * - WS /api/go2rtc/api/ws?src=<name> → echos every frame back
 */
async function startFakeFrigate(): Promise<void> {
  fakeServer = createServer((req, res) => {
    if (req.url === '/api/go2rtc/api/streams') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hamster_cam_1: {}, hamster_cam_2: {} }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  fakeWss = new WebSocketServer({ noServer: true });
  fakeWss.on('connection', (ws) => {
    // Echo all frames back to the sender (simulates go2rtc protocol exchange).
    ws.on('message', (data, isBinary) => {
      ws.send(data, { binary: isBinary });
    });
  });

  fakeServer.on('upgrade', (req, socket, head) => {
    fakeWss.handleUpgrade(req, socket as import('node:stream').Duplex, head, (ws) => {
      fakeWss.emit('connection', ws, req);
    });
  });

  await new Promise<void>((resolve) => fakeServer.listen(0, '127.0.0.1', resolve));
  fakePort = (fakeServer.address() as AddressInfo).port;
}

async function stopFakeFrigate(): Promise<void> {
  await new Promise<void>((resolve) => fakeWss.close(() => resolve()));
  await new Promise<void>((resolve) => fakeServer.close(() => resolve()));
}

// ---------------------------------------------------------------------------
// App server + DB setup
// ---------------------------------------------------------------------------

import type { AppServer } from '../src/index.js';
import type { AddressInfo as AddrInfo } from 'node:net';

let app: AppServer;
let appPort: number;
let sessionCookie: string;
let childSessionCookie: string;

const TEST_DB = ':memory:';

async function seedDb(): Promise<void> {
  const { getDb, createUser, createSession, createCamera } = await import('../src/db.js');
  const db = getDb();

  // Admin user
  const admin = createUser({
    zyphr_user_id: 'zyphr-admin-live-ws',
    email: 'admin@live-ws.test',
    display_name: 'Admin',
    role: 'admin',
    created_by: null,
  });
  const adminSession = createSession({
    id: 'sess-admin-live-ws',
    user_id: admin.id,
    zyphr_refresh_token: null,
    user_agent: null,
    ttl_ms: 86_400_000,
  });
  sessionCookie = `__Host-session=${adminSession.id}`;

  // Child user (viewer role)
  const child = createUser({
    zyphr_user_id: 'zyphr-child-live-ws',
    email: 'child@live-ws.test',
    display_name: 'Child',
    role: 'child',
    created_by: admin.id,
  });
  const childSession = createSession({
    id: 'sess-child-live-ws',
    user_id: child.id,
    zyphr_refresh_token: null,
    user_agent: null,
    ttl_ms: 86_400_000,
  });
  childSessionCookie = `__Host-session=${childSession.id}`;

  // Camera with live_src set
  createCamera({
    name: 'hamster_cam_1',
    emoji: '🐹',
    stream_url: '',
    live_src: 'hamster_cam_1',
    enabled: true,
  });

  // Camera with no live_src (disabled for live proxy)
  createCamera({
    name: 'no_src_cam',
    emoji: '📷',
    stream_url: '',
    live_src: null,
    enabled: true,
  });
}

beforeAll(async () => {
  await startFakeFrigate();

  process.env['DATABASE_PATH'] = TEST_DB;
  process.env['STORAGE_PATH'] = '/tmp/hamster-test-live-ws';
  process.env['ZYPHR_API_KEY'] = 'test-key';
  process.env['ZYPHR_APP_SECRET'] = 'test-secret';
  process.env['FRIGATE_URL'] = `http://127.0.0.1:${fakePort}`;
  process.env['NODE_ENV'] = 'test';
  resetConfigForTests();
  resetDbForTests();

  // Run migrations against the in-memory DB before building the server.
  migrate(TEST_DB);

  await seedDb();

  app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  appPort = (app.server.address() as AddrInfo).port;
});

afterAll(async () => {
  await app.close();
  await stopFakeFrigate();
  resetDbForTests();
  resetConfigForTests();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/live/ws auth enforcement', () => {
  it('rejects upgrade with no session cookie (closes before open)', async () => {
    const code = await connectWsExpectClose(`ws://127.0.0.1:${appPort}/live/ws?src=hamster_cam_1`);
    // 1006 = abnormal close (server dropped TCP before WS handshake); other
    // codes like 1011 are also acceptable. The key thing is it did NOT open.
    expect(code).not.toBe(1000);
  });

  it('rejects upgrade with an invalid/expired session cookie', async () => {
    const code = await connectWsExpectClose(
      `ws://127.0.0.1:${appPort}/live/ws?src=hamster_cam_1`,
      '__Host-session=bogus-session-id',
    );
    expect(code).not.toBe(1000);
  });

  it('allows an admin to connect', async () => {
    const ws = await connectWs(
      `ws://127.0.0.1:${appPort}/live/ws?src=hamster_cam_1`,
      sessionCookie,
    );
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('allows a child (viewer) role to connect', async () => {
    const ws = await connectWs(
      `ws://127.0.0.1:${appPort}/live/ws?src=hamster_cam_1`,
      childSessionCookie,
    );
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});

describe('/live/ws SSRF allowlist', () => {
  it('rejects an unknown src not in the DB', async () => {
    const code = await connectWsExpectClose(
      `ws://127.0.0.1:${appPort}/live/ws?src=evil_injection`,
      sessionCookie,
    );
    expect(code).not.toBe(1000);
  });

  it('rejects a camera with null live_src (src not in allowlist)', async () => {
    // 'no_src_cam' exists in the DB but has live_src=null, so it is not in the allowlist.
    const code = await connectWsExpectClose(
      `ws://127.0.0.1:${appPort}/live/ws?src=no_src_cam`,
      sessionCookie,
    );
    expect(code).not.toBe(1000);
  });

  it('rejects missing src param', async () => {
    const code = await connectWsExpectClose(
      `ws://127.0.0.1:${appPort}/live/ws`,
      sessionCookie,
    );
    expect(code).not.toBe(1000);
  });

  it('rejects path traversal attempts in src', async () => {
    const encoded = encodeURIComponent('../../../etc/passwd');
    const code = await connectWsExpectClose(
      `ws://127.0.0.1:${appPort}/live/ws?src=${encoded}`,
      sessionCookie,
    );
    expect(code).not.toBe(1000);
  });
});

describe('/live/ws frame proxy', () => {
  it('proxies a text frame from client to upstream and back (echo)', async () => {
    const ws = await connectWs(
      `ws://127.0.0.1:${appPort}/live/ws?src=hamster_cam_1`,
      sessionCookie,
    );

    const msg = JSON.stringify({ type: 'webrtc/offer', value: 'sdp-offer-payload' });
    ws.send(msg);

    const echoed = await nextMessage(ws);
    expect(echoed.toString()).toBe(msg);

    ws.close();
  }, 15_000);

  it('proxies a binary frame from client to upstream and back (echo)', async () => {
    const ws = await connectWs(
      `ws://127.0.0.1:${appPort}/live/ws?src=hamster_cam_1`,
      sessionCookie,
    );

    const payload = Buffer.from([0x00, 0x01, 0xfe, 0xff]);
    ws.send(payload);

    const echoed = await nextMessage(ws);
    const echoedBuf = Buffer.isBuffer(echoed)
      ? echoed
      : Buffer.from(echoed as unknown as ArrayBuffer);
    expect(echoedBuf).toEqual(payload);

    ws.close();
  }, 15_000);
});

describe('/live/ws disconnect cleanup', () => {
  it('closes upstream when client disconnects', async () => {
    // Track the specific upstream WS opened for this test via the connection event.
    let upstreamSocket: WebSocket | null = null;
    const connHandler = (ws: WebSocket) => { upstreamSocket = ws; };
    fakeWss.on('connection', connHandler);

    const clientWs = await connectWs(
      `ws://127.0.0.1:${appPort}/live/ws?src=hamster_cam_1`,
      sessionCookie,
    );

    // Send one message to ensure the upstream pipeline is fully established
    // (the proxy buffers until upstream is open, then flushes).
    clientWs.send('{"type":"hello"}');
    // Wait for the echo to confirm upstream is live.
    await nextMessage(clientWs);

    // Unregister listener before closing to avoid counting future connections.
    fakeWss.off('connection', connHandler);

    expect(upstreamSocket).not.toBeNull();
    const upstream = upstreamSocket as unknown as WebSocket;
    expect(upstream.readyState).toBe(WebSocket.OPEN);

    // Now close the client side.
    clientWs.close(1000);

    // Wait for the proxy to propagate the close to upstream.
    await new Promise<void>((resolve) => {
      if (upstream.readyState === WebSocket.CLOSED) {
        resolve();
      } else {
        upstream.once('close', () => resolve());
      }
    });

    expect(upstream.readyState).toBe(WebSocket.CLOSED);
  }, 15_000);
});
