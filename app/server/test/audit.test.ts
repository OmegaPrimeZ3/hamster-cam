// Verifies the audit-log writer in adminProcedure carries the real target_id
// and a meaningful `details` JSON payload (Security-Review Finding 4
// remediation). Each test exercises a tRPC procedure end-to-end and inspects
// the row the middleware wrote to audit_log.

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
    return HttpResponse.json({
      data: {
        user: { id: `zy_${body.email}`, email: body.email, name: 'N' },
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
  workdir = mkdtempSync(join(tmpdir(), 'hamster-audit-'));
  Object.assign(process.env, baseEnv);
  process.env['DATABASE_PATH'] = join(workdir, 'hamster.db');
  process.env['STORAGE_PATH'] = workdir;
  process.env['ZYPHR_API_KEY'] = 'zy_test_dummy';
  process.env['ZYPHR_APP_SECRET'] = 'zy_test_dummy_secret';
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
    audit: {} as Record<string, unknown>,
  };
}

describe('audit row contents', () => {
  it('users.delete records the deleted user id as target_id and email in details', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const db = await import('../src/db.js');
    const ctx = await makeAdminCtx();
    const victim = db.createUser({
      zyphr_user_id: 'zy_victim',
      email: 'victim@example.com',
      display_name: 'Victim',
      role: 'child',
      created_by: ctx.user.id,
    });
    const caller = appRouter.createCaller(ctx);
    await caller.users.delete({ id: victim.id });

    const rows = db.listAudit({ limit: 10, action_prefix: 'users.delete' });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toBeDefined();
    expect(row?.actor_user_id).toBe(ctx.user.id);
    expect(row?.target_type).toBe('user');
    expect(row?.target_id).toBe(String(victim.id));
    const details = row?.details ? (JSON.parse(row.details) as Record<string, unknown>) : null;
    expect(details).toMatchObject({
      email: 'victim@example.com',
      display_name: 'Victim',
      role: 'child',
    });
  });

  it('users.create records the new user id as target_id and email + role in details', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const db = await import('../src/db.js');
    const ctx = await makeAdminCtx();
    const caller = appRouter.createCaller(ctx);
    const created = await caller.users.create({
      email: 'newuser@example.com',
      display_name: 'New User',
      password: 'secret123',
      role: 'child',
    });

    const rows = db.listAudit({ limit: 10, action_prefix: 'users.create' });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.target_type).toBe('user');
    expect(row?.target_id).toBe(String(created.id));
    const details = row?.details ? (JSON.parse(row.details) as Record<string, unknown>) : null;
    expect(details).toMatchObject({
      email: 'newuser@example.com',
      display_name: 'New User',
      role: 'child',
    });
    // CRITICAL: password MUST NOT appear in audit details.
    expect(details).not.toHaveProperty('password');
  });

  it('users.update records a diff in details when role changes', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const db = await import('../src/db.js');
    const ctx = await makeAdminCtx();
    // We need a non-last-admin victim so the demote check doesn't fire — make
    // a second admin, then promote/demote a child user.
    db.createUser({
      zyphr_user_id: 'zy_second_admin',
      email: 'second@example.com',
      display_name: 'Second',
      role: 'admin',
      created_by: ctx.user.id,
    });
    const child = db.createUser({
      zyphr_user_id: 'zy_child',
      email: 'child@example.com',
      display_name: 'Old Name',
      role: 'child',
      created_by: ctx.user.id,
    });
    const caller = appRouter.createCaller(ctx);
    await caller.users.update({
      id: child.id,
      display_name: 'New Name',
      role: 'admin',
    });

    const rows = db.listAudit({ limit: 10, action_prefix: 'users.update' });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.target_id).toBe(String(child.id));
    const details = row?.details
      ? (JSON.parse(row.details) as { changed: Record<string, { before: unknown; after: unknown }> })
      : null;
    expect(details?.changed['display_name']).toEqual({
      before: 'Old Name',
      after: 'New Name',
    });
    expect(details?.changed['role']).toEqual({ before: 'child', after: 'admin' });
  });

  it('settings.update records a diff of changed keys', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const db = await import('../src/db.js');
    const ctx = await makeAdminCtx();
    const caller = appRouter.createCaller(ctx);

    // First baseline read to anchor the "before" state.
    const before = await caller.settings.get();
    expect(before.pet_name).toBe('');

    await caller.settings.update({ pet_name: 'Remy', theme: 'sunset' });

    const rows = db.listAudit({ limit: 10, action_prefix: 'settings.update' });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.target_type).toBe('settings');
    expect(row?.target_id).toBe('settings');
    const details = row?.details
      ? (JSON.parse(row.details) as { changed: Record<string, { before: unknown; after: unknown }> })
      : null;
    expect(details?.changed['pet_name']).toEqual({ before: '', after: 'Remy' });
    expect(details?.changed['theme']).toEqual({ before: 'bubblegum', after: 'sunset' });
    // Unchanged keys must NOT appear in the diff.
    expect(details?.changed).not.toHaveProperty('pet_emoji');
  });

});
