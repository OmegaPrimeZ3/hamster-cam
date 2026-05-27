// tRPC cameras.setEnabled tests.
// Verifies:
//   1. Happy path: enabled flag is flipped and the updated DTO is returned.
//   2. NOT_FOUND when the id does not exist.
//   3. Admin-gate: non-admin callers receive FORBIDDEN.
//   4. Audit log row is written with the correct action, target_id, and details.

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
  workdir = mkdtempSync(join(tmpdir(), 'hamster-cam-enabled-'));
  Object.assign(process.env, baseEnv);
  process.env['DATABASE_PATH'] = join(workdir, 'hamster.db');
  process.env['STORAGE_PATH'] = workdir;
  // Zyphr env vars must be present even if unused by these tests — config
  // validation runs at module load time.
  process.env['ZYPHR_API_KEY'] = 'zy_test_dummy';
  process.env['ZYPHR_APP_SECRET'] = 'zy_test_dummy_secret';
  process.env['ZYPHR_BASE_URL'] = 'https://zyphr-mock.test/v1';
});

afterEach(async () => {
  const db = await import('../src/db.js');
  const { resetConfigForTests } = await import('../src/config.js');
  const { resetZyphrForTests } = await import('../src/zyphr.js');
  db.resetDbForTests();
  resetConfigForTests();
  resetZyphrForTests();
  rmSync(workdir, { recursive: true, force: true });
});

async function makeAdminCtx() {
  const db = await import('../src/db.js');
  const admin = db.createUser({
    zyphr_user_id: 'zy_seed_admin',
    email: 'seed@example.com',
    display_name: 'Seed Admin',
    role: 'admin',
    created_by: null,
  });
  return {
    user: admin,
    sessionId: 'fake',
    req: {} as never,
    res: {} as never,
    audit: {} as Record<string, unknown>,
  };
}

async function makeChildCtx() {
  const db = await import('../src/db.js');
  // Ensure at least one admin exists first so we don't violate FK constraints.
  db.createUser({
    zyphr_user_id: 'zy_background_admin',
    email: 'bg_admin@example.com',
    display_name: 'BG Admin',
    role: 'admin',
    created_by: null,
  });
  const child = db.createUser({
    zyphr_user_id: 'zy_child_user',
    email: 'child@example.com',
    display_name: 'Child User',
    role: 'child',
    created_by: null,
  });
  return {
    user: child,
    sessionId: 'fake-child',
    req: {} as never,
    res: {} as never,
    audit: {} as Record<string, unknown>,
  };
}

describe('cameras.setEnabled', () => {
  it('disables an enabled camera and returns the updated DTO', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const db = await import('../src/db.js');
    const ctx = await makeAdminCtx();

    // Create a camera that starts enabled.
    const cam = db.createCamera({
      name: 'Cage Cam',
      emoji: '🐹',
      stream_url: '',
      enabled: true,
    });
    expect(cam.enabled).toBe(1);

    const caller = appRouter.createCaller(ctx);
    const result = await caller.cameras.setEnabled({ id: cam.id, enabled: false });

    expect(result.id).toBe(cam.id);
    expect(result.enabled).toBe(false);
    // Verify the DB row was actually updated.
    expect(db.getCameraById(cam.id)?.enabled).toBe(0);
  });

  it('enables a disabled camera and returns the updated DTO', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const db = await import('../src/db.js');
    const ctx = await makeAdminCtx();

    const cam = db.createCamera({
      name: 'Wheel Cam',
      emoji: '🎡',
      stream_url: '',
      enabled: false,
    });
    expect(cam.enabled).toBe(0);

    const caller = appRouter.createCaller(ctx);
    const result = await caller.cameras.setEnabled({ id: cam.id, enabled: true });

    expect(result.enabled).toBe(true);
    expect(db.getCameraById(cam.id)?.enabled).toBe(1);
  });

  it('does not mutate any column other than enabled', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const db = await import('../src/db.js');
    const ctx = await makeAdminCtx();

    const cam = db.createCamera({
      name: 'Untouched Cam',
      emoji: '📷',
      stream_url: 'rtsp://original',
      live_src: 'original-src',
      enabled: true,
      zones: ['wheel', 'food'],
    });

    const caller = appRouter.createCaller(ctx);
    await caller.cameras.setEnabled({ id: cam.id, enabled: false });

    const updated = db.getCameraById(cam.id);
    expect(updated?.name).toBe('Untouched Cam');
    expect(updated?.stream_url).toBe('rtsp://original');
    expect(updated?.live_src).toBe('original-src');
    expect(updated?.zones).toEqual(['wheel', 'food']);
  });

  it('throws NOT_FOUND when the camera id does not exist', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const ctx = await makeAdminCtx();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.cameras.setEnabled({ id: 99999, enabled: false }),
    ).rejects.toThrow(/not found/i);
  });

  it('is admin-gated — non-admin callers receive FORBIDDEN', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const db = await import('../src/db.js');
    const ctx = await makeChildCtx();

    const adminCtx = await makeAdminCtx();
    // We need a camera in the DB; create it via db helper since the child
    // can't call cameras.create.
    const cam = db.createCamera({
      name: 'Child Cam',
      emoji: '📷',
      stream_url: '',
      enabled: true,
    });
    // Silence linter — adminCtx is used only for camera creation.
    void adminCtx;

    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.cameras.setEnabled({ id: cam.id, enabled: false }),
    ).rejects.toThrow(/forbidden/i);
  });

  it('writes an audit row with action cameras.setEnabled, target_id, and details', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const db = await import('../src/db.js');
    const ctx = await makeAdminCtx();

    const cam = db.createCamera({
      name: 'Audit Cam',
      emoji: '🔍',
      stream_url: '',
      enabled: true,
    });

    const caller = appRouter.createCaller(ctx);
    await caller.cameras.setEnabled({ id: cam.id, enabled: false });

    const rows = db.listAudit({ limit: 10, action_prefix: 'cameras.setEnabled' });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.actor_user_id).toBe(ctx.user.id);
    expect(row?.target_type).toBe('camera');
    expect(row?.target_id).toBe(String(cam.id));
    const details = row?.details
      ? (JSON.parse(row.details) as { id: number; enabled: boolean })
      : null;
    expect(details).toMatchObject({ id: cam.id, enabled: false });
  });
});
