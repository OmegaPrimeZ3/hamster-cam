// e2e/specs/audit.spec.ts
//
// Covers PLAN §5.4 acceptance bullet:
//   • Admin makes a mutation (users.create) → the resulting audit row appears
//     in Settings → Audit with the right actor, action, target_id, and
//     details JSON.

import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { startStack, type StackHandle, defaultAdmin } from '../fixtures';

let stack: StackHandle;

test.beforeEach(async () => {
  stack = await startStack({
    users: [defaultAdmin],
    settings: { pet_name: 'Remy', pet_emoji: '🐹', onboarding_complete: 'true' },
  });
});

test.afterEach(async () => {
  await stack?.close();
});

test('admin creating a user produces an audit row visible in Settings → Audit', async ({ page }) => {
  await page.goto(`${stack.frontUrl}/login`);
  await page.getByLabel('Email').fill(defaultAdmin.email);
  await page.getByLabel('Password', { exact: true }).fill(defaultAdmin.password);
  await page.getByRole('button', { name: /^Sign in$/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 10_000 });

  // Open Settings → Users → Add account → submit a new child.
  await page.getByRole('button', { name: 'Open settings' }).click();
  const drawer = page.getByRole('dialog', { name: 'Settings' });
  await drawer.getByRole('tab', { name: 'Users' }).click();
  await drawer.getByRole('button', { name: /Add account/i }).click();

  // AddUserForm fields: Email / Display name / Password (+ "Show password"
  // toggle, hence the {exact:true}) / Role radiogroup.
  await drawer.getByLabel('Email').fill('newbie@example.com');
  await drawer.getByLabel('Display name').fill('Newbie');
  await drawer.getByLabel('Password', { exact: true }).fill('newbie-pass-12345');
  // Role defaults to 'child'; explicit re-tap so the assertion is intent-clear.
  await drawer.getByRole('radio', { name: /Child/ }).click();
  await drawer.getByRole('button', { name: /Create account/i }).click();
  // Wait for the row to appear in the Users list.
  await expect(drawer.locator('div').filter({ hasText: 'Newbie' }).first()).toBeVisible();

  // Switch to the Audit tab; collected rows render lazily as audit.list
  // resolves with the new row.
  await drawer.getByRole('tab', { name: 'Audit' }).click();
  // Action filter pre-selects "All actions"; narrow to users.* to make the
  // assertion stable even if some other audit row landed between then and now.
  await drawer.getByLabel('Action prefix').selectOption('users.');
  await expect(drawer.getByText('users.create', { exact: true })).toBeVisible({ timeout: 10_000 });

  // Cross-check the underlying DB row so we know target_id + details JSON were
  // populated (Finding 4 remediation contract).
  const db = new Database(stack.dbPath, { readonly: true });
  try {
    const row = db
      .prepare('SELECT actor_user_id, action, target_type, target_id, details FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1')
      .get('users.create') as {
        actor_user_id: number | null;
        action: string;
        target_type: string | null;
        target_id: string | null;
        details: string | null;
      };
    expect(row).toBeTruthy();
    expect(row.actor_user_id).not.toBeNull();
    expect(row.target_type).toBe('user');
    expect(row.target_id, 'target_id must be the new user row id').toMatch(/^\d+$/);
    expect(row.details, 'details must be JSON-shaped').toBeTruthy();
    const details = JSON.parse(row.details!) as { email?: string; display_name?: string; role?: string };
    expect(details.email).toBe('newbie@example.com');
    expect(details.display_name).toBe('Newbie');
    expect(details.role).toBe('child');
  } finally {
    db.close();
  }
});
