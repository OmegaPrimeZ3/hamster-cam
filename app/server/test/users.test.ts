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

  it('Zyphr 409 (true orphan) → CONFLICT with instructive message and no local row', async () => {
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
    ).rejects.toThrow(/auth provider but has no local account/);
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

  it('soft-deletes the user (row invisible to getUserByEmail, but still resolvable by id)', async () => {
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
    // Soft-delete: row invisible to the login/listing path.
    expect(db.getUserByEmail('other@example.com')).toBeNull();
    // But still resolvable by id for audit/history.
    const raw = db.getUserById(other.id);
    expect(raw).not.toBeNull();
    expect(raw?.deleted_at).not.toBeNull();
  });

  it('re-add after delete reactivates the SAME row without calling Zyphr register', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const db = await import('../src/db.js');
    const ctx = await makeAdminCtx();
    // Provision a second admin so we can delete `other` without hitting last-admin guard.
    const other = db.createUser({
      zyphr_user_id: 'zy_readd_admin',
      email: 'readd@example.com',
      display_name: 'Re-Add Admin',
      role: 'admin',
      created_by: ctx.user.id,
    });
    const originalId = other.id;
    const originalZyphrId = other.zyphr_user_id;

    let registerCalled = false;
    mswServer.use(
      http.post(`${ZYPHR_BASE}/auth/users/register`, async () => {
        registerCalled = true;
        return HttpResponse.json({ error: 'should not be called' }, { status: 500 });
      }),
    );

    const caller = appRouter.createCaller(ctx);
    await caller.users.delete({ id: other.id });

    // Re-add with the same email.
    const reAdded = await caller.users.create({
      email: 'readd@example.com',
      display_name: 'Re-Added',
      password: 'doesnotmatter',
      role: 'child',
    });

    // Same database row id and Zyphr account — no new Zyphr registration.
    expect(reAdded.id).toBe(originalId);
    expect(registerCalled).toBe(false);
    expect(db.getUserById(originalId)?.zyphr_user_id).toBe(originalZyphrId);
    expect(reAdded.display_name).toBe('Re-Added');
    expect(reAdded.role).toBe('child');
    // Active again: visible through normal email lookup.
    expect(db.getUserByEmail('readd@example.com')).not.toBeNull();
  });

  it('deleted user session is immediately invalidated', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const db = await import('../src/db.js');
    const { resolveSession } = await import('../src/session.js');
    const ctx = await makeAdminCtx();
    const other = db.createUser({
      zyphr_user_id: 'zy_session_del',
      email: 'sessioned@example.com',
      display_name: 'Sessioned',
      role: 'admin',
      created_by: ctx.user.id,
    });
    // Give them an active session.
    db.createSession({
      id: 'sess_del_test_0001',
      user_id: other.id,
      zyphr_refresh_token: null,
      user_agent: 'test',
      ttl_ms: 30 * 24 * 60 * 60 * 1000,
    });

    // Soft-delete the user.
    const caller = appRouter.createCaller(ctx);
    await caller.users.delete({ id: other.id });

    // resolveSession must not return the deleted user.
    const fakeReq = {
      cookies: { '__Host-session': 'sess_del_test_0001' },
    } as unknown as import('fastify').FastifyRequest;
    expect(resolveSession(fakeReq)).toBeNull();
  });

  it('update on a soft-deleted user returns NOT_FOUND', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const db = await import('../src/db.js');
    const ctx = await makeAdminCtx();
    const other = db.createUser({
      zyphr_user_id: 'zy_upd_deleted',
      email: 'upd_del@example.com',
      display_name: 'To Delete',
      role: 'admin',
      created_by: ctx.user.id,
    });
    const caller = appRouter.createCaller(ctx);
    await caller.users.delete({ id: other.id });
    await expect(
      caller.users.update({ id: other.id, display_name: 'New', role: 'child' }),
    ).rejects.toThrow(/not found/i);
  });

  it('delete on an already soft-deleted user returns NOT_FOUND', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const db = await import('../src/db.js');
    const ctx = await makeAdminCtx();
    const other = db.createUser({
      zyphr_user_id: 'zy_del_twice',
      email: 'del_twice@example.com',
      display_name: 'To Delete Twice',
      role: 'admin',
      created_by: ctx.user.id,
    });
    const caller = appRouter.createCaller(ctx);
    await caller.users.delete({ id: other.id });
    await expect(
      caller.users.delete({ id: other.id }),
    ).rejects.toThrow(/not found/i);
  });

  it('last-admin guard still holds after soft-delete removes one admin', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const db = await import('../src/db.js');
    const ctx = await makeAdminCtx();
    // Second admin.
    const second = db.createUser({
      zyphr_user_id: 'zy_last_guard2',
      email: 'second_guard@example.com',
      display_name: 'Second',
      role: 'admin',
      created_by: ctx.user.id,
    });
    const caller = appRouter.createCaller(ctx);
    // Delete second — now only ctx.user (seed admin) remains.
    await caller.users.delete({ id: second.id });
    // Attempting to delete the last admin (self) must be refused.
    await expect(
      caller.users.delete({ id: ctx.user.id }),
    ).rejects.toThrow(/last remaining admin|own account/);
  });
});

describe('users.update session rotation', () => {
  it('invalidates the affected user sessions when role changes', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const db = await import('../src/db.js');
    const ctx = await makeAdminCtx();
    // Provision a second admin so the demote check doesn't fire when we
    // promote a child below — well, this test promotes child->admin, but
    // the second admin is harmless either way.
    db.createUser({
      zyphr_user_id: 'zy_second_admin',
      email: 'second@example.com',
      display_name: 'Second',
      role: 'admin',
      created_by: ctx.user.id,
    });
    const child = db.createUser({
      zyphr_user_id: 'zy_child_rotate',
      email: 'rotate@example.com',
      display_name: 'Rotate Me',
      role: 'child',
      created_by: ctx.user.id,
    });
    db.createSession({
      id: 'sess_to_rotate_0123',
      user_id: child.id,
      zyphr_refresh_token: null,
      user_agent: 'tablet',
      ttl_ms: 30 * 24 * 60 * 60 * 1000,
    });
    expect(db.getValidSession('sess_to_rotate_0123')).not.toBeNull();

    const caller = appRouter.createCaller(ctx);
    await caller.users.update({
      id: child.id,
      display_name: 'Rotate Me',
      role: 'admin',
    });
    expect(db.getValidSession('sess_to_rotate_0123')).toBeNull();
  });

  it('retains sessions when role is unchanged (only display_name edited)', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const db = await import('../src/db.js');
    const ctx = await makeAdminCtx();
    const child = db.createUser({
      zyphr_user_id: 'zy_child_keep',
      email: 'keep@example.com',
      display_name: 'Old',
      role: 'child',
      created_by: ctx.user.id,
    });
    db.createSession({
      id: 'sess_to_keep_4567',
      user_id: child.id,
      zyphr_refresh_token: null,
      user_agent: 'tablet',
      ttl_ms: 30 * 24 * 60 * 60 * 1000,
    });
    const caller = appRouter.createCaller(ctx);
    await caller.users.update({
      id: child.id,
      display_name: 'New',
      role: 'child',
    });
    expect(db.getValidSession('sess_to_keep_4567')).not.toBeNull();
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
