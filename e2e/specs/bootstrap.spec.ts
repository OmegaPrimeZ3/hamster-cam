// e2e/specs/bootstrap.spec.ts
//
// Covers PLAN §5.4 acceptance bullets:
//   • Brand-new install: the bootstrap CLI calls POST /auth/register at Zyphr
//     and inserts the local admin row in one transaction.
//   • Bootstrap CLI refuses when `users` is non-empty (§7.7 hardening checklist).
//   • After bootstrap, the new admin can sign in via the rendered Login form
//     and lands on the camera grid (or the onboarding wizard, which is a
//     prerequisite for the next acceptance bullet — see `login.spec.ts`).

import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startStack, type StackHandle, defaultAdmin } from '../fixtures';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_SCRIPT = join(__dirname, '..', '..', 'app', 'server', 'src', 'bootstrap.ts');
const TSX_BIN = join(__dirname, '..', 'node_modules', '.bin', 'tsx');

let stack: StackHandle;

test.beforeEach(async () => {
  stack = await startStack({ noUsers: true });
});

test.afterEach(async () => {
  await stack?.close();
});

test('bootstrap CLI provisions the first admin at Zyphr and writes the local row', async () => {
  // Empty DB precondition.
  expect(countUsers(stack.dbPath)).toBe(0);

  // Run the bootstrap CLI as documented in PLAN §7.6.6.
  const result = spawnSync(
    TSX_BIN,
    [
      BOOTSTRAP_SCRIPT,
      '--email', defaultAdmin.email,
      '--display-name', defaultAdmin.display_name,
      '--password', defaultAdmin.password,
    ],
    {
      env: {
        ...process.env,
        DATABASE_PATH: stack.dbPath,
        STORAGE_PATH: stack.dbPath.replace(/\/[^/]+$/, ''),
        ZYPHR_API_KEY: 'test-api-key',
        ZYPHR_BASE_URL: stack.zyphr.baseUrl,
        NODE_ENV: 'test',
      },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );

  expect(result.status, `bootstrap stderr=\n${result.stderr}`).toBe(0);
  expect(result.stdout).toContain('bootstrapped admin user id=');

  // Local admin row landed.
  const rows = listUsers(stack.dbPath);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    email: defaultAdmin.email,
    display_name: defaultAdmin.display_name,
    role: 'admin',
  });
  expect(rows[0]!.zyphr_user_id).toContain('zyphr_');

  // msw observed the Zyphr /auth/users/register call.
  const registerCalls = stack.zyphr.callsTo('/auth/users/register');
  expect(registerCalls.length).toBeGreaterThanOrEqual(1);
  const body = registerCalls[0]!.body as { email: string; password: string; name: string };
  expect(body.email).toBe(defaultAdmin.email);
  expect(body.name).toBe(defaultAdmin.display_name);
  // Password ships to Zyphr but never to logs — we check the call body for
  // completeness. The audit-log row is asserted in audit.spec.ts.
  expect(body.password).toBe(defaultAdmin.password);

  // Audit row of action `bootstrap.admin` exists.
  const audit = listAudit(stack.dbPath);
  expect(audit.some((a) => a.action === 'bootstrap.admin')).toBe(true);
});

test('bootstrap CLI refuses to run when users table is non-empty', async () => {
  // Pre-seed a user so the CLI must bail.
  stack.db.seedUser({
    email: 'existing@example.com',
    display_name: 'Existing',
    role: 'admin',
  });
  stack.db.close();

  const result = spawnSync(
    TSX_BIN,
    [
      BOOTSTRAP_SCRIPT,
      '--email', 'second@example.com',
      '--display-name', 'Second',
      '--password', 'something-long-enough',
    ],
    {
      env: {
        ...process.env,
        DATABASE_PATH: stack.dbPath,
        STORAGE_PATH: stack.dbPath.replace(/\/[^/]+$/, ''),
        ZYPHR_API_KEY: 'test-api-key',
        ZYPHR_BASE_URL: stack.zyphr.baseUrl,
        NODE_ENV: 'test',
      },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );

  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/refusing to bootstrap/i);
  // Still only the one pre-seeded user.
  expect(countUsers(stack.dbPath)).toBe(1);
  // Zyphr never got a register call.
  expect(stack.zyphr.callsTo('/auth/users/register')).toHaveLength(0);
});

test('after bootstrap, the new admin can sign in via the browser-rendered login form', async ({ page }) => {
  // Bootstrap a real admin via the CLI.
  const result = spawnSync(
    TSX_BIN,
    [
      BOOTSTRAP_SCRIPT,
      '--email', defaultAdmin.email,
      '--display-name', defaultAdmin.display_name,
      '--password', defaultAdmin.password,
    ],
    {
      env: {
        ...process.env,
        DATABASE_PATH: stack.dbPath,
        STORAGE_PATH: stack.dbPath.replace(/\/[^/]+$/, ''),
        ZYPHR_API_KEY: 'test-api-key',
        ZYPHR_BASE_URL: stack.zyphr.baseUrl,
        NODE_ENV: 'test',
      },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  expect(result.status, `bootstrap stderr=\n${result.stderr}`).toBe(0);

  // Visit the SPA — AuthGate redirects unauthed visitors to /login.
  await page.goto(`${stack.frontUrl}/`);
  await expect(page.getByRole('heading', { name: /Pet Cam!|Cam!/ })).toBeVisible();

  await page.getByLabel('Email').fill(defaultAdmin.email);
  await page.getByLabel('Password').fill(defaultAdmin.password);
  await page.getByRole('button', { name: /Sign in/i }).click();

  // Onboarding wizard renders (admin + onboarding_complete=false). The
  // bullet "first run shows the pet onboarding wizard" is asserted here.
  await expect(page.getByText(/What's your pet's name\?/i)).toBeVisible();
});

// ----- helpers --------------------------------------------------------------

function countUsers(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

function listUsers(dbPath: string): Array<{
  id: number;
  email: string;
  display_name: string;
  role: string;
  zyphr_user_id: string;
}> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare('SELECT id, email, display_name, role, zyphr_user_id FROM users')
      .all() as Array<{
        id: number;
        email: string;
        display_name: string;
        role: string;
        zyphr_user_id: string;
      }>;
  } finally {
    db.close();
  }
}

function listAudit(dbPath: string): Array<{ action: string; target_id: string | null; details: string | null }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare('SELECT action, target_id, details FROM audit_log ORDER BY id')
      .all() as Array<{ action: string; target_id: string | null; details: string | null }>;
  } finally {
    db.close();
  }
}
