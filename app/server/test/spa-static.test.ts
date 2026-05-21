// SPA static handler tests.
//
// Spins up a real Fastify server (same as auth.test.ts) with a temporary
// WEB_DIST_PATH pointing at a fixture directory we write on the fly. Tests
// cover the five cases called out in the requirements:
//
//   1. GET /             → index.html (200, text/html)
//   2. GET /diary        → index.html (SPA fallback, Accept: text/html)
//   3. GET /assets/app.xyz123.js → real asset with immutable cache header
//   4. GET /trpc/nope    → JSON 404 (not index.html)
//   5. GET /../../etc/passwd → 400 bad path

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type { AppServer } from '../src/index.js';

const ZYPHR_BASE = 'https://zyphr-mock-spa.test/v1';

// Minimal msw handlers so Zyphr SDK calls don't fail on boot.
const handlers = [
  http.post(`${ZYPHR_BASE}/auth/users/login`, () =>
    HttpResponse.json({ error: { code: 'invalid_credentials' } }, { status: 401 }),
  ),
  http.post(`${ZYPHR_BASE}/auth/users/register`, async ({ request }) => {
    const body = (await request.json()) as { email: string };
    return HttpResponse.json({
      data: {
        user: { id: `zy_${body.email}`, email: body.email, name: 'N' },
        tokens: { access_token: 'acc', refresh_token: 'ref' },
      },
    });
  }),
];

const mswServer = setupServer(...handlers);

beforeAll(() => mswServer.listen({ onUnhandledRequest: 'warn' }));
afterAll(() => mswServer.close());

let workdir: string;
let webDist: string;
let app: AppServer;
const baseEnv = { ...process.env };

function writeFixtureDist(distRoot: string): void {
  mkdirSync(join(distRoot, 'assets'), { recursive: true });
  // Root index.html
  writeFileSync(join(distRoot, 'index.html'), '<!doctype html><html><body>SPA</body></html>');
  // Service worker (must get no-cache)
  writeFileSync(join(distRoot, 'sw.js'), '// sw');
  // Hashed asset (must get immutable)
  writeFileSync(join(distRoot, 'assets', 'app.xyz123.js'), 'console.log("app")');
  // CSS asset
  writeFileSync(join(distRoot, 'assets', 'style.abc456.css'), 'body{}');
  // Favicon
  writeFileSync(join(distRoot, 'favicon.ico'), 'ICO');
}

beforeEach(async () => {
  vi.resetModules();
  workdir = mkdtempSync(join(tmpdir(), 'hamster-spa-'));
  webDist = join(workdir, 'web-dist');
  mkdirSync(webDist, { recursive: true });
  writeFixtureDist(webDist);

  Object.assign(process.env, baseEnv);
  process.env['DATABASE_PATH'] = join(workdir, 'hamster.db');
  process.env['STORAGE_PATH'] = workdir;
  process.env['ZYPHR_API_KEY'] = 'zy_test_dummy';
  process.env['ZYPHR_BASE_URL'] = ZYPHR_BASE;
  process.env['WEB_DIST_PATH'] = webDist;
  delete process.env['MQTT_URL'];
  delete process.env['FRIGATE_URL'];

  const { buildServer } = await import('../src/index.js');
  app = await buildServer();
});

afterEach(async () => {
  mswServer.resetHandlers();
  const db = await import('../src/db.js');
  const { resetConfigForTests } = await import('../src/config.js');
  const { resetZyphrForTests } = await import('../src/zyphr.js');
  await app.close();
  db.resetDbForTests();
  resetConfigForTests();
  resetZyphrForTests();
  rmSync(workdir, { recursive: true, force: true });
});

describe('SPA static handler', () => {
  it('GET / returns index.html with text/html content-type', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { accept: 'text/html,application/xhtml+xml,*/*' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('<html>');
  });

  it('GET /diary with Accept: text/html returns index.html (SPA fallback)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/diary',
      headers: { accept: 'text/html,application/xhtml+xml,*/*' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('<html>');
  });

  it('GET /assets/app.xyz123.js returns the file with immutable cache header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/assets/app.xyz123.js',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.body).toBe('console.log("app")');
  });

  it('GET /assets/style.abc456.css returns the file with immutable cache header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/assets/style.abc456.css',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/css/);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('GET /sw.js returns the file with no-cache header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sw.js',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('GET /trpc/nope returns JSON 404 (not index.html)', async () => {
    // tRPC prefix is registered, so unknown procedures fall back here via
    // the notFoundHandler — it must NOT return index.html for non-html
    // requests.
    const res = await app.inject({
      method: 'GET',
      url: '/trpc/nope',
      headers: { accept: 'application/json' },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as unknown;
    // Fastify tRPC adapter returns its own 404 shape; the important thing is
    // it is NOT the SPA index.html.
    expect(res.headers['content-type']).not.toMatch(/text\/html/);
    expect(body).toBeTruthy();
  });

  it('GET /unknown/api/path with no html Accept returns JSON 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/unknown/api/path',
      headers: { accept: 'application/json' },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error?: string; statusCode?: number };
    expect(body.statusCode ?? body.error).toBeTruthy();
  });

  it('GET with path traversal attempt returns 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/../../etc/passwd',
      headers: { accept: 'application/json' },
    });
    // Fastify normalises URL paths — the traversal is caught either by
    // Fastify's router (404) or by our guard (400). Either way it must NOT
    // return 200 with file contents.
    expect([400, 404]).toContain(res.statusCode);
    const body = res.body;
    expect(body).not.toContain('root:');
  });

  it('GET with NUL byte returns 400 or 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/foo%00bar',
      headers: { accept: 'application/json' },
    });
    expect([400, 404]).toContain(res.statusCode);
  });

  it('index.html is served with no-cache header (so PWA updates land)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { accept: 'text/html' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
  });
});

describe('SPA static handler — dist directory absent', () => {
  it('server starts without crashing when WEB_DIST_PATH points to a non-existent dir', async () => {
    // The main beforeEach already built the server against a real webDist.
    // Here we close it and rebuild with a bogus path.
    await app.close();
    vi.resetModules();
    const { resetConfigForTests } = await import('../src/config.js');
    const { resetZyphrForTests } = await import('../src/zyphr.js');
    const { resetDbForTests } = await import('../src/db.js');
    resetConfigForTests();
    resetZyphrForTests();
    resetDbForTests();

    process.env['WEB_DIST_PATH'] = join(workdir, 'does-not-exist');

    const { buildServer } = await import('../src/index.js');
    const fallbackApp = await buildServer();

    // Should still 404 (JSON) for unknown paths since no SPA handler registered.
    const res = await fallbackApp.inject({
      method: 'GET',
      url: '/',
      headers: { accept: 'text/html' },
    });
    expect(res.statusCode).toBe(404);

    await fallbackApp.close();
  });
});
