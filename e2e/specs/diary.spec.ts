// e2e/specs/diary.spec.ts
//
// Covers PLAN §5.4 acceptance bullet:
//   • Diary entries appear as narrative sentences, never raw event JSON.
//
// We seed one of each diary kind via the DB factory (so we don't need a live
// MQTT broker), reload the page, and assert the three card variants render
// with their expected shape per components/DiaryEntry.tsx.

import { test, expect } from '@playwright/test';
import { startStack, type StackHandle, defaultAdmin } from '../fixtures';

let stack: StackHandle;

test.beforeEach(async () => {
  // Seed an enabled camera and three diary entries: narrative / snapshot /
  // timelapse, all dated to the current "today" so activity.today returns them.
  const now = Date.now();
  stack = await startStack({
    users: [defaultAdmin],
    settings: { pet_name: 'Remy', pet_emoji: '🐹', onboarding_complete: 'true' },
    cameras: [{ name: 'wheel', stream_url: 'rtsp://x/wheel' }],
    diary: [
      {
        occurred_at: now - 10 * 60_000,
        kind: 'narrative',
        activity: 'wheel',
        narrative: 'Remy ran on the wheel for 3 minutes.',
        pet_name: 'Remy',
        duration_ms: 180_000,
      },
      {
        occurred_at: now - 8 * 60_000,
        kind: 'snapshot',
        activity: 'snapshot',
        narrative: 'A snapshot from the wheel camera.',
        pet_name: 'Remy',
        media_path: '/snapshots/wheel-snap.jpg',
      },
      {
        occurred_at: now - 5 * 60_000,
        kind: 'timelapse',
        activity: 'timelapse',
        narrative: "Remy's day in 30 seconds.",
        pet_name: 'Remy',
        media_path: '/snapshots/remy-day.mp4',
      },
    ],
  });
});

test.afterEach(async () => {
  await stack?.close();
});

test('diary renders narrative, snapshot, and timelapse entries with their card variants', async ({ page }) => {
  await page.goto(`${stack.frontUrl}/login`);
  await page.getByLabel('Email').fill(defaultAdmin.email);
  await page.getByLabel('Password', { exact: true }).fill(defaultAdmin.password);
  await page.getByRole('button', { name: /^Sign in$/i }).click();

  // The narrative sentences appear verbatim, NOT raw event JSON.
  await expect(page.getByText('Remy ran on the wheel for 3 minutes.')).toBeVisible();
  await expect(page.getByText('A snapshot from the wheel camera.')).toBeVisible();
  await expect(page.getByText("Remy's day in 30 seconds.")).toBeVisible();

  // Card variants are distinguished by `data-kind=…` on the <article>.
  await expect(page.locator('article[data-kind="narrative"]').first()).toBeVisible();
  await expect(page.locator('article[data-kind="snapshot"]').first()).toBeVisible();
  await expect(page.locator('article[data-kind="timelapse"]').first()).toBeVisible();

  // Snapshot card renders an <img> whose alt is the narrative.
  const snapImg = page.locator('article[data-kind="snapshot"] img');
  await expect(snapImg).toHaveAttribute('src', /snapshots\/wheel-snap\.jpg$/);

  // Timelapse card renders a <video controls preload="metadata"> whose src is
  // the media_path we seeded.
  const tlVideo = page.locator('article[data-kind="timelapse"] video');
  await expect(tlVideo).toHaveAttribute('src', /\/snapshots\/remy-day\.mp4$/);
  await expect(tlVideo).toHaveAttribute('preload', 'metadata');

  // Sanity: no JSON-shaped goop appears anywhere in the rendered feed.
  const body = await page.textContent('body');
  expect(body).not.toMatch(/\{"camera"|"end_time"|"start_time"/);
});
