// Verifies that the Zyphr SDK is wired with distinct applicationKey and
// applicationSecret fields so X-Application-Key and X-Application-Secret
// each get their correct value. This is the root-cause guard for the
// "invalid application credentials" bootstrap failure: the SDK's `apiKey`
// string alone copies the same value into BOTH auth headers.

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

import { resetConfigForTests } from '../src/config.js';
import { resetZyphrForTests } from '../src/zyphr.js';

const ZYPHR_BASE = 'https://zyphr-wiring-mock.test/v1';

const baseEnv = { ...process.env };

// Capture the headers sent by the SDK on a register call so we can assert
// the two application credential headers carry different values.
let capturedHeaders: Record<string, string> = {};

const mswServer = setupServer(
  http.post(`${ZYPHR_BASE}/auth/users/register`, ({ request }) => {
    capturedHeaders = Object.fromEntries(request.headers.entries());
    return HttpResponse.json({
      data: {
        user: { id: 'zy_wiring_user', email: 'wiring@test.com', name: 'Wire' },
        tokens: { access_token: 'acc', refresh_token: 'ref' },
      },
    });
  }),
);

beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }));
afterAll(() => mswServer.close());

beforeEach(() => {
  vi.resetModules();
  capturedHeaders = {};
  Object.assign(process.env, baseEnv);
  process.env['DATABASE_PATH'] = '/tmp/hamster-wiring-dummy.db';
  process.env['STORAGE_PATH'] = '/tmp/hamster-wiring-dummy';
  process.env['ZYPHR_API_KEY'] = 'zy_test_THE_KEY';
  process.env['ZYPHR_APP_SECRET'] = 'zy_test_THE_SECRET';
  process.env['ZYPHR_BASE_URL'] = ZYPHR_BASE;
});

afterEach(() => {
  mswServer.resetHandlers();
  resetConfigForTests();
  resetZyphrForTests();
});

describe('Zyphr SDK credential wiring', () => {
  it('sends X-Application-Key = ZYPHR_API_KEY on a register call', async () => {
    const { registerAccount } = await import('../src/zyphr.js');
    await registerAccount('wiring@test.com', 'pass123', 'Wire');
    expect(capturedHeaders['x-application-key']).toBe('zy_test_THE_KEY');
  });

  it('sends X-Application-Secret = ZYPHR_APP_SECRET on a register call', async () => {
    const { registerAccount } = await import('../src/zyphr.js');
    await registerAccount('wiring@test.com', 'pass123', 'Wire');
    expect(capturedHeaders['x-application-secret']).toBe('zy_test_THE_SECRET');
  });

  it('the two credential headers are distinct — header collision cannot re-occur', async () => {
    const { registerAccount } = await import('../src/zyphr.js');
    await registerAccount('wiring@test.com', 'pass123', 'Wire');
    const key = capturedHeaders['x-application-key'];
    const secret = capturedHeaders['x-application-secret'];
    expect(key).toBeDefined();
    expect(secret).toBeDefined();
    expect(key).not.toBe(secret);
  });

  it('boot fails fast when ZYPHR_APP_SECRET is absent', async () => {
    delete process.env['ZYPHR_APP_SECRET'];
    const { getConfig } = await import('../src/config.js');
    expect(() => getConfig()).toThrow(/ZYPHR_APP_SECRET/);
  });

  it('boot fails fast when ZYPHR_API_KEY is absent', async () => {
    delete process.env['ZYPHR_API_KEY'];
    const { getConfig } = await import('../src/config.js');
    expect(() => getConfig()).toThrow(/ZYPHR_API_KEY/);
  });
});
