// e2e/specs/cameras.spec.ts
//
// Covers PLAN §5.4 acceptance bullets:
//   • Settings → Cameras lets you add, edit, reorder, and delete cameras; the
//     grid reflects changes immediately.
//   • Discover button returns Frigate's known cameras as one-tap suggestions.

import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { startStack, type StackHandle, defaultAdmin } from '../fixtures';

let stack: StackHandle;

test.beforeEach(async () => {
  stack = await startStack({
    users: [defaultAdmin],
    settings: { pet_name: 'Remy', pet_emoji: '🐹', onboarding_complete: 'true' },
    // Frigate mock with two cameras to "discover".
    frigate: [
      { name: 'wheel_cam', stream_url: 'rtsp://192.168.1.50:8554/wheel' },
      { name: 'food_cam', stream_url: 'rtsp://192.168.1.51:8554/food' },
    ],
  });
});

test.afterEach(async () => {
  await stack?.close();
});

async function signInAndOpenCameras(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`${stack.frontUrl}/login`);
  await page.getByLabel('Email').fill(defaultAdmin.email);
  await page.getByLabel('Password', { exact: true }).fill(defaultAdmin.password);
  await page.getByRole('button', { name: /^Sign in$/i }).click();
  await page.getByRole('button', { name: 'Open settings' }).click();
  const drawer = page.getByRole('dialog', { name: 'Settings' });
  await drawer.getByRole('tab', { name: 'Cameras' }).click();
}

test('admin adds a camera via Settings; it appears in the grid', async ({ page }) => {
  await signInAndOpenCameras(page);
  const drawer = page.getByRole('dialog', { name: 'Settings' });
  await drawer.getByRole('button', { name: /Add camera/i }).click();
  await drawer.getByLabel('Name').fill('Wheel');
  await drawer.getByLabel('Stream URL').fill('rtsp://192.168.1.50:8554/wheel');
  await drawer.getByRole('button', { name: /^Add camera$/i }).click();

  // The row appears inside the drawer. The display_name is rendered in a
  // bold div; both div and a sibling small (stream_url) contain the substring,
  // so match by exact text on the div.
  await expect(drawer.getByText('Wheel', { exact: true })).toBeVisible();
  // Close the drawer and verify the camera grid shows the new tile chip.
  await drawer.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByRole('button', { name: /Maximize Wheel/i })).toBeVisible();
});

test('admin edits a camera; the name updates in the grid chip', async ({ page }) => {
  // Pre-seed a camera so we can edit it. We do this through the API rather
  // than the UI for speed.
  stack.db.seedCamera({ name: 'OldName', stream_url: 'rtsp://192.168.1.99/old', emoji: '📷' });

  await signInAndOpenCameras(page);
  const drawer = page.getByRole('dialog', { name: 'Settings' });
  await drawer.getByRole('button', { name: /Edit OldName/i }).click();
  const nameInput = drawer.getByLabel('Name');
  await nameInput.fill('NewName');
  await drawer.getByRole('button', { name: /Save changes/i }).click();
  await expect(drawer.getByText('NewName')).toBeVisible();
  // Grid chip updates too (close drawer first).
  await drawer.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByRole('button', { name: /Maximize NewName/i })).toBeVisible();
});

test('admin reorders cameras; position updates persist', async ({ page }) => {
  stack.db.seedCamera({ name: 'First', stream_url: 'rtsp://x/1' });
  stack.db.seedCamera({ name: 'Second', stream_url: 'rtsp://x/2' });

  await signInAndOpenCameras(page);
  const drawer = page.getByRole('dialog', { name: 'Settings' });

  // Initial order: First, Second.
  const items = drawer.locator('li.hc-card');
  await expect(items.first()).toContainText('First');
  await expect(items.nth(1)).toContainText('Second');

  // Move "First" down (or equivalently, "Second" up).
  await drawer.getByRole('button', { name: /Move up/i }).nth(1).click();
  // Wait for the reordered call to land. We don't have a public progress
  // marker so we re-fetch list ordering instead.
  await expect(items.first()).toContainText('Second');
  await expect(items.nth(1)).toContainText('First');

  // Confirm in the DB so we know the reorder mutation actually wrote.
  const db = new Database(stack.dbPath, { readonly: true });
  try {
    const rows = db.prepare('SELECT name, position FROM cameras ORDER BY position').all() as Array<{ name: string; position: number }>;
    expect(rows.map((r) => r.name)).toEqual(['Second', 'First']);
  } finally {
    db.close();
  }
});

test('admin deletes a camera; the tile is removed', async ({ page }) => {
  stack.db.seedCamera({ name: 'Doomed', stream_url: 'rtsp://x/doomed' });
  await signInAndOpenCameras(page);
  const drawer = page.getByRole('dialog', { name: 'Settings' });
  await expect(drawer.getByText('Doomed', { exact: true })).toBeVisible();
  const deleteBtn = drawer.getByRole('button', { name: /Delete Doomed/i });
  await deleteBtn.click(); // first click arms the confirm
  await deleteBtn.click(); // second click commits
  await expect(drawer.getByText('Doomed', { exact: true })).toHaveCount(0);
});

test('discover button returns Frigate cameras as one-tap suggestions', async ({ page }) => {
  await signInAndOpenCameras(page);
  const drawer = page.getByRole('dialog', { name: 'Settings' });
  await drawer.getByRole('button', { name: /Add camera/i }).click();
  await drawer.getByRole('button', { name: /Discover/i }).click();

  // The two cameras we configured in the Frigate mock show up as buttons.
  await expect(drawer.getByRole('button', { name: 'wheel_cam' })).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'food_cam' })).toBeVisible();

  // Tap one — the form auto-fills.
  await drawer.getByRole('button', { name: 'wheel_cam' }).click();
  await expect(drawer.getByLabel('Stream URL')).toHaveValue('rtsp://192.168.1.50:8554/wheel');
});
