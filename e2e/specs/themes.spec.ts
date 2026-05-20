// e2e/specs/themes.spec.ts
//
// Covers PLAN §5.4 acceptance bullet:
//   • Light/dark toggle in PetSettings persists across refresh, and the dark
//     variant actually renders dark CSS variables.

import { test, expect } from '@playwright/test';
import { startStack, type StackHandle, defaultAdmin } from '../fixtures';

let stack: StackHandle;

test.beforeEach(async () => {
  stack = await startStack({
    users: [defaultAdmin],
    settings: { pet_name: 'Remy', pet_emoji: '🐹', onboarding_complete: 'true', theme: 'bubblegum', theme_mode: 'light' },
  });
});

test.afterEach(async () => {
  await stack?.close();
});

test('toggling theme_mode to dark persists across refresh and applies dark CSS vars', async ({ page }) => {
  await page.goto(`${stack.frontUrl}/login`);
  await page.getByLabel('Email').fill(defaultAdmin.email);
  await page.getByLabel('Password', { exact: true }).fill(defaultAdmin.password);
  await page.getByRole('button', { name: /^Sign in$/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 10_000 });

  // Open Settings → Pet → choose Dark.
  await page.getByRole('button', { name: 'Open settings' }).click();
  const drawer = page.getByRole('dialog', { name: 'Settings' });
  await drawer.getByRole('tab', { name: 'Pet' }).click();
  // PetSettings exposes the Theme mode radiogroup with three buttons (Light /
  // Dark / Match system); the role for each is "radio".
  await drawer.getByRole('radio', { name: 'Dark' }).click();
  // applyTheme() mutates documentElement style + data-mode synchronously.
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');

  // The resolved `--bg` CSS var matches the bubblegum dark swatch (#15131A).
  const bg = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
  );
  // CSS color-mix or whatever may leave `#XXXXXX` or `rgb(...)`. We accept
  // either by normalising to lowercase hex.
  const norm = bg.toLowerCase();
  // The bubblegum dark `--bg` from theme.ts is `#15131A`. Some browsers
  // serialize as #15131a or rgb(21, 19, 26). Either is acceptable.
  expect(['#15131a', 'rgb(21, 19, 26)']).toContain(norm);

  // Close the drawer, then hard-reload the page. The persisted setting in the
  // DB makes settings.get return theme_mode='dark' on next /auth/me bounce,
  // so the app remounts in dark mode.
  await drawer.getByRole('button', { name: 'Close settings' }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
});
