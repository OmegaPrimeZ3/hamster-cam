// Verifies that settings.update immediately refreshes narrator in-memory
// tunings so changes to min_dwell_ms, exploring_min_dwell_ms, and
// transition_window_ms take effect without a process restart.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let workdir: string;
const baseEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  workdir = mkdtempSync(join(tmpdir(), 'hamster-settings-tunings-'));
  Object.assign(process.env, baseEnv);
  process.env['DATABASE_PATH'] = join(workdir, 'hamster.db');
  process.env['STORAGE_PATH'] = workdir;
  process.env['ZYPHR_API_KEY'] = 'zy_test_dummy';
  process.env['ZYPHR_APP_SECRET'] = 'zy_test_dummy_secret';
  delete process.env['FRIGATE_URL'];
  delete process.env['MQTT_URL'];
});

afterEach(async () => {
  const db = await import('../src/db.js');
  const narrator = await import('../src/narrator.js');
  const { resetConfigForTests } = await import('../src/config.js');
  narrator.resetNarratorState();
  db.resetDbForTests();
  resetConfigForTests();
  rmSync(workdir, { recursive: true, force: true });
});

function makeAdminCtx(user: import('../src/db.js').UserRow) {
  return {
    user,
    sessionId: 'fake-session',
    req: {} as never,
    res: {} as never,
    audit: {} as Record<string, unknown>,
  };
}

describe('settings.update → narrator tunings refresh', () => {
  it('updating min_dwell_ms takes effect in the narrator without a restart', async () => {
    const db = await import('../src/db.js');
    const narrator = await import('../src/narrator.js');
    const { appRouter } = await import('../src/trpc.js');

    db.getDb(); // ensure migrations run

    // Read the default tuning before any change.
    const defaultTuning = narrator.getNarratorTuningsForTests();
    expect(defaultTuning.minDwellMs).toBe(2000);

    const admin = db.createUser({
      zyphr_user_id: 'zy_admin_tuning',
      email: 'admin@example.com',
      display_name: 'Admin',
      role: 'admin',
      created_by: null,
    });
    const caller = appRouter.createCaller(makeAdminCtx(admin));

    await caller.settings.update({ min_dwell_ms: 5000 });

    // Narrator should have picked up the new value immediately.
    const updatedTuning = narrator.getNarratorTuningsForTests();
    expect(updatedTuning.minDwellMs).toBe(5000);
  });

  it('updating exploring_min_dwell_ms takes effect in the narrator without a restart', async () => {
    const db = await import('../src/db.js');
    const narrator = await import('../src/narrator.js');
    const { appRouter } = await import('../src/trpc.js');

    db.getDb();

    const defaultTuning = narrator.getNarratorTuningsForTests();
    expect(defaultTuning.exploringMinDwellMs).toBe(60000);

    const admin = db.createUser({
      zyphr_user_id: 'zy_admin_exploring',
      email: 'admin2@example.com',
      display_name: 'Admin2',
      role: 'admin',
      created_by: null,
    });
    const caller = appRouter.createCaller(makeAdminCtx(admin));

    await caller.settings.update({ exploring_min_dwell_ms: 30000 });

    const updatedTuning = narrator.getNarratorTuningsForTests();
    expect(updatedTuning.exploringMinDwellMs).toBe(30000);
  });

  it('updating transition_window_ms takes effect in the narrator without a restart', async () => {
    const db = await import('../src/db.js');
    const narrator = await import('../src/narrator.js');
    const { appRouter } = await import('../src/trpc.js');

    db.getDb();

    const defaultTuning = narrator.getNarratorTuningsForTests();
    expect(defaultTuning.transitionWindowMs).toBe(8000);

    const admin = db.createUser({
      zyphr_user_id: 'zy_admin_window',
      email: 'admin3@example.com',
      display_name: 'Admin3',
      role: 'admin',
      created_by: null,
    });
    const caller = appRouter.createCaller(makeAdminCtx(admin));

    await caller.settings.update({ transition_window_ms: 12000 });

    const updatedTuning = narrator.getNarratorTuningsForTests();
    expect(updatedTuning.transitionWindowMs).toBe(12000);
  });
});
