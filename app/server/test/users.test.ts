// tRPC users.* tests — focuses on the contractually-important invariants:
//   1. users.create is atomic (Zyphr fail → no local row)
//   2. users.delete refuses to remove the last admin
//   3. users.resetPassword fires Zyphr forgot-password and audit-logs

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

const ZYPHR_BASE = 'https://zyphr-mock.test/v1';

const handlers = [
  http.post(`${ZYPHR_BASE}/auth/users/register`, async ({ request }) => {
    const body = (await request.json()) as { email: string };
    if (body.email === 'taken@example.com') {
      return HttpResponse.json({ error: { code: 'email_taken' } }, { status: 409 });
    }
    return HttpResponse.json({
      data: {
        user: { id: `zy_${body.email}`, email: body.email, name: 'New' },
        tokens: { access_token: 'a', refresh_token: 'r' },
      },
    });
  }),
  http.post(`${ZYPHR_BASE}/auth/forgot-password`, async () =>
    HttpResponse.json({ data: { ok: true } }),
  ),
];

const mswServer = setupServer(...handlers);
beforeAll(() => mswServer.listen({ onUnhandledRequest: 'warn' }));
afterAll(() => mswServer.close());

let workdir: string;
const baseEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  workdir = mkdtempSync(join(tmpdir(), 'hamster-users-'));
  Object.assign(process.env, baseEnv);
  process.env['DATABASE_PATH'] = join(workdir, 'hamster.db');
  process.env['STORAGE_PATH'] = workdir;
  process.env['ZYPHR_API_KEY'] = 'zy_test_dummy';
  process.env['ZYPHR_BASE_URL'] = ZYPHR_BASE;
});

afterEach(async () => {
  mswServer.resetHandlers();
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
  };
}

describe('users.create', () => {
  it('happy path: writes a local row with the returned zyphr_user_id', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const db = await import('../src/db.js');
    const ctx = await makeAdminCtx();
    const caller = appRouter.createCaller(ctx);
    const out = await caller.users.create({
      email: 'newkid@example.com',
      display_name: 'New Kid',
      password: 'secret123',
      role: 'child',
    });
    expect(out.email).toBe('newkid@example.com');
    expect(db.getUserByEmail('newkid@example.com')).not.toBeNull();
    const found = db.getUserByEmail('newkid@example.com');
    expect(found?.zyphr_user_id).toBe('zy_newkid@example.com');
  });

  it('Zyphr 409 → CONFLICT and no local row', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const db = await import('../src/db.js');
    const ctx = await makeAdminCtx();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.users.create({
        email: 'taken@example.com',
        display_name: 'X',
        password: 'secret123',
        role: 'child',
      }),
    ).rejects.toThrow(/already registered/);
    expect(db.getUserByEmail('taken@example.com')).toBeNull();
  });
});

describe('users.delete', () => {
  it('refuses to delete the last remaining admin', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const ctx = await makeAdminCtx();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.users.delete({ id: ctx.user.id }),
    ).rejects.toThrow(/last remaining admin|own account/);
  });

  it('permits deletion when another admin exists', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const db = await import('../src/db.js');
    const ctx = await makeAdminCtx();
    const other = db.createUser({
      zyphr_user_id: 'zy_other_admin',
      email: 'other@example.com',
      display_name: 'Other Admin',
      role: 'admin',
      created_by: ctx.user.id,
    });
    const caller = appRouter.createCaller(ctx);
    const out = await caller.users.delete({ id: other.id });
    expect(out.ok).toBe(true);
    expect(db.getUserByEmail('other@example.com')).toBeNull();
  });
});

describe('users.resetPassword', () => {
  it('triggers Zyphr forgot-password and audit-logs', async () => {
    let zyphrCalled = false;
    mswServer.use(
      http.post(`${ZYPHR_BASE}/auth/forgot-password`, async () => {
        zyphrCalled = true;
        return HttpResponse.json({ data: { ok: true } });
      }),
    );
    const { appRouter } = await import('../src/trpc.js');
    const db = await import('../src/db.js');
    const ctx = await makeAdminCtx();
    const target = db.createUser({
      zyphr_user_id: 'zy_target',
      email: 'target@example.com',
      display_name: 'Target',
      role: 'child',
      created_by: ctx.user.id,
    });
    const caller = appRouter.createCaller(ctx);
    const out = await caller.users.resetPassword({ id: target.id });
    expect(out.ok).toBe(true);
    expect(zyphrCalled).toBe(true);
    // Audit row created by adminProcedure middleware.
    const audit = db.listAudit({ limit: 5, action_prefix: 'users.resetPassword' });
    expect(audit.length).toBe(1);
  });
});
