// e2e/specs/roles.spec.ts
//
// Covers PLAN §5.4 acceptance bullets:
//   • Signing in as a child: no gear icon, Settings drawer never mounts, and
//     direct tRPC calls to mutating users.* return 403.
//   • Signing in as an admin: gear icon visible, all five Settings tabs render,
//     can list users.

import { test, expect } from '@playwright/test';
import { startStack, type StackHandle, defaultAdmin, defaultChild } from '../fixtures';

let stack: StackHandle;

test.beforeEach(async () => {
  stack = await startStack({
    users: [defaultAdmin, defaultChild],
    settings: { pet_name: 'Remy', pet_emoji: '🐹', onboarding_complete: 'true' },
  });
});

test.afterEach(async () => {
  await stack?.close();
});

test('child does not see the gear icon and the Settings drawer never mounts', async ({ page }) => {
  await page.goto(`${stack.frontUrl}/login`);
  await page.getByLabel('Email').fill(defaultChild.email);
  await page.getByLabel('Password', { exact: true }).fill(defaultChild.password);
  await page.getByRole('button', { name: /^Sign in$/i }).click();

  // Wait for the post-login redirect away from /login before asserting.
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 10_000 });
  // The empty-camera CTA is unique to the AppShell.
  await expect(page.getByText(/Let's set up your first camera!/i)).toBeVisible();
  // Gear icon (aria-label="Open settings") is absent for child.
  await expect(page.getByRole('button', { name: 'Open settings' })).toHaveCount(0);
  // The Settings dialog's accessible name "Settings" never appears.
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
});

test('child cannot call admin tRPC procedures — direct fetch returns 403', async ({ page }) => {
  // Sign in as child via the UI. Wait for the URL to leave /login as the
  // sentinel that the post-login redirect actually happened (the login page
  // shares the "Pet Cam!" header with the AppShell, so a text match alone is
  // insufficient).
  await page.goto(`${stack.frontUrl}/login`);
  await page.getByLabel('Email').fill(defaultChild.email);
  await page.getByLabel('Password', { exact: true }).fill(defaultChild.password);
  await page.getByRole('button', { name: /^Sign in$/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 10_000 });

  // The simplest reliable way to ferry the browser's cookies onto an
  // explicit request is to fetch from inside the page (same security
  // context, same origin, same cookie jar). page.evaluate() runs in the
  // browser's JS realm so the __Host-session cookie travels automatically.
  //
  // Sanity check first: a protected procedure the child IS allowed to call
  // (settings.get) must succeed; this confirms the cookie is travelling.
  // tRPC encodes "no input" as an absent input param for batched GETs.
  const sanity = await page.evaluate(async () => {
    const r = await fetch('/trpc/settings.get?batch=1&input=' + encodeURIComponent(JSON.stringify({})), {
      method: 'GET',
      credentials: 'include',
    });
    return { status: r.status, body: await r.text() };
  });
  expect(sanity.status, `sanity GET failed: ${sanity.body}`).toBe(200);

  const res = await page.evaluate(async () => {
    const r = await fetch('/trpc/users.create?batch=1', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        0: {
          email: 'sneaky@example.com',
          display_name: 'Sneaky',
          password: 'pw-123456',
          role: 'child',
        },
      }),
    });
    return { status: r.status, body: await r.text() };
  });
  const body = JSON.parse(res.body) as Array<{ error?: { data?: { code?: string; httpStatus?: number } } }>;
  const code = body[0]?.error?.data?.code;
  const httpStatus = body[0]?.error?.data?.httpStatus;
  expect(code === 'FORBIDDEN' || httpStatus === 403,
    `unexpected body=${JSON.stringify(body)}`).toBe(true);

  // settings.update — also forbidden.
  const res2 = await page.evaluate(async () => {
    const r = await fetch('/trpc/settings.update?batch=1', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 0: { pet_name: 'Hacked!' } }),
    });
    return { status: r.status, body: await r.text() };
  });
  const body2 = JSON.parse(res2.body) as Array<{ error?: { data?: { code?: string; httpStatus?: number } } }>;
  expect(body2[0]?.error?.data?.code === 'FORBIDDEN' || body2[0]?.error?.data?.httpStatus === 403,
    `unexpected body2=${JSON.stringify(body2)}`).toBe(true);

  // The settings table is unchanged.
  expect(stack.db.getSetting('pet_name')).toBe('Remy');
});

test('admin sees the gear icon and the five Settings tabs render', async ({ page }) => {
  await page.goto(`${stack.frontUrl}/login`);
  await page.getByLabel('Email').fill(defaultAdmin.email);
  await page.getByLabel('Password', { exact: true }).fill(defaultAdmin.password);
  await page.getByRole('button', { name: /^Sign in$/i }).click();

  const gear = page.getByRole('button', { name: 'Open settings' });
  await expect(gear).toBeVisible();
  await gear.click();

  const drawer = page.getByRole('dialog', { name: 'Settings' });
  await expect(drawer).toBeVisible();

  // Five tabs per PLAN §5.4: Pet, Cameras, Users, Audit, Sharing.
  for (const tab of ['Pet', 'Cameras', 'Users', 'Audit', 'Sharing']) {
    await expect(drawer.getByRole('tab', { name: tab })).toBeVisible();
  }

  // Users tab → admin can list users (returns both seeded accounts).
  await drawer.getByRole('tab', { name: 'Users' }).click();
  // Each user row prints the display_name in a div + email in a small;
  // narrow the locator to the display_name div via .filter().
  await expect(drawer.locator('div').filter({ hasText: defaultAdmin.display_name }).first()).toBeVisible();
  await expect(drawer.locator('div').filter({ hasText: defaultChild.display_name }).first()).toBeVisible();
});
