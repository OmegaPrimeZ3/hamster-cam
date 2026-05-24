// settings.publicBrand — verifies the unauthenticated branding procedure:
//   1. Returns the four branding fields for a null (unauthenticated) caller.
//   2. Returns null for pet_name / pet_emoji when nothing is configured.
//   3. Returns the configured values when settings are populated.
//   4. settings.get still requires auth (regression guard).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

let workdir: string;
const baseEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  workdir = mkdtempSync(join(tmpdir(), 'hamster-brand-'));
  Object.assign(process.env, baseEnv);
  process.env['DATABASE_PATH'] = join(workdir, 'hamster.db');
  process.env['STORAGE_PATH'] = workdir;
  // Zyphr is not called by publicBrand — minimal env is enough.
  process.env['ZYPHR_API_KEY'] = 'zy_test_dummy';
  process.env['ZYPHR_APP_SECRET'] = 'zy_test_dummy_secret';
  process.env['ZYPHR_BASE_URL'] = 'https://zyphr-mock.test/v1';
});

afterEach(async () => {
  const db = await import('../src/db.js');
  const { resetConfigForTests } = await import('../src/config.js');
  db.resetDbForTests();
  resetConfigForTests();
  rmSync(workdir, { recursive: true, force: true });
});

/** Unauthenticated context — user is null, no session. */
function makePublicCtx() {
  return {
    user: null,
    sessionId: null,
    req: {} as never,
    res: {} as never,
    audit: {} as Record<string, unknown>,
  };
}

describe('settings.publicBrand', () => {
  it('is callable without a session (null user)', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const caller = appRouter.createCaller(makePublicCtx());
    // Must not throw UNAUTHORIZED.
    const out = await caller.settings.publicBrand();
    expect(out).toBeDefined();
  });

  it('returns null pet_name when nothing is configured, and fallback emoji', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const caller = appRouter.createCaller(makePublicCtx());
    const out = await caller.settings.publicBrand();
    // pet_name defaults to '' in parseSettingsKV, so publicBrand maps it to null.
    expect(out.pet_name).toBeNull();
    // pet_emoji defaults to '🐾' — a real non-empty fallback, so it is NOT null.
    expect(out.pet_emoji).toBe('🐾');
    expect(typeof out.theme).toBe('string');
    expect(['light', 'dark', 'auto']).toContain(out.theme_mode);
  });

  it('returns the configured pet_name and pet_emoji', async () => {
    const db = await import('../src/db.js');
    db.setSettings({ pet_name: 'Remy', pet_emoji: '🐹', theme: 'bubblegum', theme_mode: 'dark' });

    const { appRouter } = await import('../src/trpc.js');
    const caller = appRouter.createCaller(makePublicCtx());
    const out = await caller.settings.publicBrand();
    expect(out.pet_name).toBe('Remy');
    expect(out.pet_emoji).toBe('🐹');
    expect(out.theme).toBe('bubblegum');
    expect(out.theme_mode).toBe('dark');
  });

  it('output contains ONLY the four branding fields — nothing else', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const caller = appRouter.createCaller(makePublicCtx());
    const out = await caller.settings.publicBrand();
    const keys = Object.keys(out).sort();
    expect(keys).toEqual(['pet_emoji', 'pet_name', 'theme', 'theme_mode']);
  });
});

describe('settings.get auth guard (regression)', () => {
  it('throws UNAUTHORIZED when called without a session', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const caller = appRouter.createCaller(makePublicCtx());
    await expect(caller.settings.get()).rejects.toThrow(/unauthenticated/i);
  });
});
