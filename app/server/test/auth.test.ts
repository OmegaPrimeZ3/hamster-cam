// Auth REST tests with msw shimming Zyphr's /v1/auth/* endpoints.

import { mkdtempSync, rmSync } from 'node:fs';
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

const ZYPHR_BASE = 'https://zyphr-mock.test/v1';

let workdir: string;
let app: AppServer;
const baseEnv = { ...process.env };

const handlers = [
  http.post(`${ZYPHR_BASE}/auth/users/login`, async ({ request }) => {
    const body = (await request.json()) as { email: string; password: string };
    if (body.email === 'rate@example.com') {
      return HttpResponse.json(
        { error: { code: 'rate_limited' } },
        { status: 429, headers: { 'Retry-After': '7' } },
      );
    }
    if (body.password === 'mfa-required') {
      // SDK parses snake_case → camelCase; respond in wire format.
      return HttpResponse.json({
        data: { mfa_required: true, mfa_challenge: { token: 'challenge-abc' } },
      });
    }
    if (body.password !== 'good-pass') {
      return HttpResponse.json({ error: { code: 'invalid_credentials' } }, { status: 401 });
    }
    return HttpResponse.json({
      data: {
        user: { id: `zy_${body.email}`, email: body.email, name: 'X' },
        tokens: { access_token: 'acc', refresh_token: 'ref' },
      },
    });
  }),

  http.post(`${ZYPHR_BASE}/auth/mfa/verify`, async ({ request }) => {
    // SDK serialises as snake_case on the wire.
    const body = (await request.json()) as { challenge_token: string; totp_code: string };
    if (body.totp_code !== '123456') {
      return HttpResponse.json({ error: { code: 'invalid_code' } }, { status: 401 });
    }
    return HttpResponse.json({
      data: {
        user: { id: 'zy_mfa_user', email: 'mfa@example.com', name: 'MFA' },
        tokens: { access_token: 'acc', refresh_token: 'ref' },
      },
    });
  }),

  http.post(`${ZYPHR_BASE}/auth/forgot-password`, async () =>
    HttpResponse.json({ data: { ok: true } }),
  ),
  http.post(`${ZYPHR_BASE}/auth/reset-password`, async () =>
    HttpResponse.json({ data: { ok: true } }),
  ),
  http.post(`${ZYPHR_BASE}/auth/sessions/revoke`, async () =>
    HttpResponse.json({ data: { ok: true } }),
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

beforeEach(async () => {
  vi.resetModules();
  workdir = mkdtempSync(join(tmpdir(), 'hamster-auth-'));
  Object.assign(process.env, baseEnv);
  process.env['DATABASE_PATH'] = join(workdir, 'hamster.db');
  process.env['STORAGE_PATH'] = workdir;
  process.env['ZYPHR_API_KEY'] = 'zy_test_dummy';
  process.env['ZYPHR_APP_SECRET'] = 'zy_test_dummy_secret';
  process.env['ZYPHR_BASE_URL'] = ZYPHR_BASE;
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

async function seedUser(email: string, role: 'admin' | 'child' = 'admin'): Promise<number> {
  const db = await import('../src/db.js');
  const row = db.createUser({
    zyphr_user_id: `zy_${email}`,
    email,
    display_name: 'Tester',
    role,
    created_by: null,
  });
  return row.id;
}

describe('POST /auth/login', () => {
  it('returns 200 + user + session cookie on a valid Zyphr login with a local mirror row', async () => {
    await seedUser('ok@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'ok@example.com', password: 'good-pass' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { user: { email: string } };
    expect(body.user.email).toBe('ok@example.com');
    expect(res.headers['set-cookie']).toMatch(/__Host-session=/);
  });

  it('returns 401 for invalid credentials with no information leak', async () => {
    await seedUser('ok@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'ok@example.com', password: 'WRONG' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
  });

  it('returns 429 with Retry-After on Zyphr rate-limit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'rate@example.com', password: 'good-pass' },
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('returns 403 not_provisioned when Zyphr accepts but local mirror is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'orphan@example.com', password: 'good-pass' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'not_provisioned' });
  });

  it('returns mfa_required without setting a cookie on the MFA branch', async () => {
    await seedUser('mfa@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'mfa@example.com', password: 'mfa-required' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { mfa_required: boolean; mfa_challenge?: { token: string } };
    expect(body.mfa_required).toBe(true);
    expect(body.mfa_challenge?.token).toBe('challenge-abc');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('rejects malformed bodies with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /auth/mfa/verify', () => {
  it('issues a session on valid TOTP', async () => {
    await seedUser('mfa@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      payload: { challenge_token: 'challenge-abc', code: '123456' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toMatch(/__Host-session=/);
  });

  it('returns 401 on bad code', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      payload: { challenge_token: 'challenge-abc', code: '000000' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /auth/password/forgot', () => {
  it('always returns 204 even when email is unknown locally', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/password/forgot',
      payload: { email: 'nobody@example.com' },
    });
    expect(res.statusCode).toBe(204);
  });

  // Security-Review Finding 7: previously the handler skipped the Zyphr call
  // when the email had no local mirror, creating a measurable timing oracle.
  // The fix makes that call unconditional, so an unknown email STILL hits
  // Zyphr — verified here by counting msw handler invocations.
  it('hits Zyphr forgot-password upstream even when the email is unknown locally', async () => {
    let zyphrCalls = 0;
    mswServer.use(
      http.post(`${ZYPHR_BASE}/auth/forgot-password`, async () => {
        zyphrCalls += 1;
        return HttpResponse.json({ data: { ok: true } });
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/auth/password/forgot',
      payload: { email: 'never-seen@example.com' },
    });
    expect(res.statusCode).toBe(204);
    expect(zyphrCalls).toBe(1);
  });

  it('hits Zyphr forgot-password upstream when the email IS known locally', async () => {
    await seedUser('known@example.com');
    let zyphrCalls = 0;
    mswServer.use(
      http.post(`${ZYPHR_BASE}/auth/forgot-password`, async () => {
        zyphrCalls += 1;
        return HttpResponse.json({ data: { ok: true } });
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/auth/password/forgot',
      payload: { email: 'known@example.com' },
    });
    expect(res.statusCode).toBe(204);
    expect(zyphrCalls).toBe(1);
  });
});

describe('GET /auth/me', () => {
  it('401s without a session cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('returns the user when a session cookie is set', async () => {
    await seedUser('ok@example.com');
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'ok@example.com', password: 'good-pass' },
    });
    const cookie = login.headers['set-cookie'] as string;
    const cookieHeader = Array.isArray(cookie) ? cookie.join('; ') : cookie;
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: cookieHeader },
    });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { user: { email: string } }).user.email).toBe('ok@example.com');
  });
});

describe('POST /auth/logout', () => {
  it('clears the cookie and returns 204 even without a session', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/logout' });
    expect(res.statusCode).toBe(204);
    const setCookie = res.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join('|') : (setCookie ?? '');
    expect(cookieStr).toMatch(/__Host-session=;/);
  });
});
