// e2e/specs/login.spec.ts
//
// Covers PLAN §5.4 acceptance bullets:
//   • Unauthenticated visit → Login screen rendered by OUR app (not Zyphr).
//   • Wrong-password → inline friendly message, no enumeration leak (same
//     message regardless of which side is wrong).
//   • not_provisioned → 403 with a friendly message.
//   • Rate-limit → friendly message.
//   • MFA challenge flow.

import { test, expect } from '@playwright/test';
import { startStack, type StackHandle, defaultAdmin } from '../fixtures';

let stack: StackHandle;

test.beforeEach(async () => {
  stack = await startStack({
    users: [defaultAdmin],
    settings: { pet_name: 'Remy', pet_emoji: '🐹', onboarding_complete: 'true' },
    zyphrOnlyUsers: [
      {
        email: 'orphan@example.com',
        password: 'orphan-pass-123',
        // No matching local users row.
      },
    ],
  });
});

test.afterEach(async () => {
  await stack?.close();
});

test('unauthenticated visit lands on the app-rendered Login screen, not a Zyphr page', async ({ page }) => {
  await page.goto(`${stack.frontUrl}/`);
  // The app sets <title>Hamster Cam</title> in index.html — the Zyphr-hosted
  // page would have a different title. The visible H1 is also our own.
  await expect(page.getByRole('heading', { name: /Cam!/ })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  // No outbound to Zyphr happens before submit.
  expect(stack.zyphr.calls).toHaveLength(0);
});

test('wrong password shows the friendly inline error with no enumeration leak', async ({ page }) => {
  await page.goto(`${stack.frontUrl}/login`);
  await page.getByLabel('Email').fill(defaultAdmin.email);
  await page.getByLabel('Password', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: /Sign in/i }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("didn't match");
  // The same message regardless of which side is wrong — check by also
  // trying a completely unknown email.
  await page.getByLabel('Email').fill('nobody@example.com');
  await page.getByLabel('Password', { exact: true }).fill('also-wrong');
  await page.getByRole('button', { name: /Sign in/i }).click();
  await expect(alert).toContainText("didn't match");
});

test('Zyphr-known but locally-unprovisioned email is rejected with not_provisioned', async ({ page }) => {
  await page.goto(`${stack.frontUrl}/login`);
  await page.getByLabel('Email').fill('orphan@example.com');
  await page.getByLabel('Password', { exact: true }).fill('orphan-pass-123');
  await page.getByRole('button', { name: /Sign in/i }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("isn't set up");
});

test('rate-limit response from Zyphr surfaces as the friendly throttle message', async ({ page }) => {
  // Make the NEXT login call return 429.
  stack.zyphr.forceError('/auth/users/login', {
    status: 429,
    code: 'rate_limited',
    message: 'Too many attempts',
    retry_after: 30,
  });

  await page.goto(`${stack.frontUrl}/login`);
  await page.getByLabel('Email').fill(defaultAdmin.email);
  await page.getByLabel('Password', { exact: true }).fill(defaultAdmin.password);
  await page.getByRole('button', { name: /Sign in/i }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(/Too many tries|wait a minute/i);
});

test('right creds with MFA enabled drives the challenge screen, then signs in on correct OTP', async ({ page }) => {
  // Re-register the admin as MFA-enabled at Zyphr.
  stack.zyphr.registerUser({
    email: defaultAdmin.email,
    password: defaultAdmin.password,
    name: defaultAdmin.display_name,
    zyphr_user_id: defaultAdmin.zyphr_user_id,
    mfa_required: true,
    mfa_code: '123456',
  });

  await page.goto(`${stack.frontUrl}/login`);
  await page.getByLabel('Email').fill(defaultAdmin.email);
  await page.getByLabel('Password', { exact: true }).fill(defaultAdmin.password);
  await page.getByRole('button', { name: /Sign in/i }).click();

  // MFA challenge UI mounts in place of the login form.
  const codeField = page.getByLabel(/Two-factor code/i);
  await expect(codeField).toBeVisible();
  await codeField.fill('123456');
  await page.getByRole('button', { name: /Verify/i }).click();

  // After MFA the AppShell renders — for our seeded admin the onboarding is
  // already complete (we pre-set onboarding_complete=true), so the camera
  // grid (or its empty-state) is what we land on.
  await expect(page.getByText(/Let's set up your first camera!|Settings/i)).toBeVisible();
  // msw saw an /auth/mfa/verify call after the initial login.
  expect(stack.zyphr.callsTo('/auth/mfa/verify').length).toBeGreaterThanOrEqual(1);
});

test('right creds land an admin on the AppShell (camera grid empty-state)', async ({ page }) => {
  await page.goto(`${stack.frontUrl}/login`);
  await page.getByLabel('Email').fill(defaultAdmin.email);
  await page.getByLabel('Password', { exact: true }).fill(defaultAdmin.password);
  await page.getByRole('button', { name: /Sign in/i }).click();

  // No cameras seeded; the grid shows its "first camera" CTA. The presence of
  // a button labelled "Open camera setup" or "Add camera" is the marker that
  // the SPA's AppShell mounted under the AuthGate (i.e. login succeeded).
  await expect(page.getByText(/Let's set up your first camera!/i)).toBeVisible();
});
