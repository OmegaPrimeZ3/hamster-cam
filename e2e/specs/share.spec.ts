// e2e/specs/share.spec.ts
//
// Covers PLAN §5.4 acceptance bullets:
//   • Admin adds a recipient in ShareSettings → it appears in the
//     ShareDialog pill list.
//   • Tap a pill on a diary entry → backend issues a /emails/send call at
//     Zyphr with the MP4 attachment.

import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { startStack, type StackHandle, defaultAdmin } from '../fixtures';

let stack: StackHandle;

test.beforeEach(async () => {
  // Seed one camera + one timelapse diary entry with a real .mp4 on disk so
  // the share job has something to attach.
  const now = Date.now();
  stack = await startStack({
    users: [defaultAdmin],
    settings: { pet_name: 'Remy', pet_emoji: '🐹', onboarding_complete: 'true' },
    cameras: [{ name: 'wheel', stream_url: 'rtsp://x/wheel' }],
    diary: [
      {
        occurred_at: now - 60_000,
        kind: 'timelapse',
        activity: 'timelapse',
        narrative: "Remy's day, 30 seconds.",
        pet_name: 'Remy',
        media_path: 'clips/remy-day.mp4',
      },
    ],
  });
  // Write a tiny fake MP4 to STORAGE_PATH/clips/remy-day.mp4 so the share
  // job's stat() + readFile() succeeds. Real Frigate would have generated
  // this; in tests we just need a non-empty file.
  const storage = dirname(stack.dbPath);
  const clipPath = join(storage, 'clips', 'remy-day.mp4');
  await mkdir(dirname(clipPath), { recursive: true });
  // Minimal MP4 header (faststart-prefixed); content size doesn't matter for
  // the share-flow assertions.
  await writeFile(clipPath, Buffer.from([
    0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
    0x61, 0x76, 0x63, 0x31, 0x6d, 0x70, 0x34, 0x31,
  ]));
});

test.afterEach(async () => {
  await stack?.close();
});

async function signInAsAdmin(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`${stack.frontUrl}/login`);
  await page.getByLabel('Email').fill(defaultAdmin.email);
  await page.getByLabel('Password', { exact: true }).fill(defaultAdmin.password);
  await page.getByRole('button', { name: /^Sign in$/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 10_000 });
}

test('admin adds a share recipient; it appears in the ShareDialog pill list', async ({ page }) => {
  await signInAsAdmin(page);

  // Add the recipient via Settings → Sharing.
  await page.getByRole('button', { name: 'Open settings' }).click();
  const drawer = page.getByRole('dialog', { name: 'Settings' });
  await drawer.getByRole('tab', { name: 'Sharing' }).click();
  await drawer.getByRole('button', { name: /Add recipient/i }).click();
  await drawer.getByPlaceholder(/Display name/i).fill('Aunt Sarah');
  await drawer.getByPlaceholder(/Email/i).fill('sarah@example.com');
  await drawer.getByRole('button', { name: /^Save$/i }).click();
  // The list shows the new row.
  await expect(drawer.getByText('Aunt Sarah', { exact: true })).toBeVisible();
  // Close the drawer.
  await drawer.getByRole('button', { name: 'Close settings' }).click();

  // Open the share dialog on the timelapse diary entry.
  const entry = page.locator('article[data-kind="timelapse"]').first();
  await entry.getByRole('button', { name: /Send a clip/i }).click();
  const dialog = page.getByRole('dialog', { name: /Send a clip/i });
  await expect(dialog).toBeVisible();
  // The recipient pill rendered with the 💌 emoji prefix.
  await expect(dialog.getByRole('button', { name: /Aunt Sarah/ })).toBeVisible();
});

test('tapping a recipient pill drives a Zyphr /emails/send with the MP4 attachment', async ({ page }) => {
  // Seed the recipient directly via the DB factory so we don't have to walk
  // the admin UI flow again (the previous test already covered that).
  stack.db.seedRecipient({ display_name: 'Aunt Sarah', email: 'sarah@example.com' });

  await signInAsAdmin(page);

  const entry = page.locator('article[data-kind="timelapse"]').first();
  await entry.getByRole('button', { name: /Send a clip/i }).click();
  const dialog = page.getByRole('dialog', { name: /Send a clip/i });
  await expect(dialog).toBeVisible();
  stack.zyphr.resetCalls();
  // Also capture network for diagnostics if anything goes sideways.
  const trpcResponses: Array<{ url: string; status: number; body: string }> = [];
  page.on('response', async (res) => {
    if (res.url().includes('/trpc/share.send')) {
      try {
        trpcResponses.push({ url: res.url(), status: res.status(), body: await res.text() });
      } catch {
        /* body may already be consumed */
      }
    }
  });
  await dialog.getByRole('button', { name: /Aunt Sarah/ }).click();

  // Status flips to 'Sent!' or 'Failed.' once the backend reports back.
  try {
    await expect(dialog.getByText(/Sent!|❌/)).toBeVisible({ timeout: 15_000 });
  } catch (err) {
    const Database = (await import('better-sqlite3')).default;
    const dbHandle = new Database(stack.dbPath, { readonly: true });
    const rows = dbHandle.prepare('SELECT id, status, error FROM share_log ORDER BY id DESC').all();
    dbHandle.close();
    throw new Error(
      `share job did not surface a status; share_log=${JSON.stringify(rows)}; trpc responses=${JSON.stringify(trpcResponses)}`,
    );
  }
  // If the visible state was the failure path, surface the share_log error
  // so the diagnostic is immediately visible.
  const failedCount = await dialog.getByText(/❌/).count();
  if (failedCount > 0) {
    const Database = (await import('better-sqlite3')).default;
    const dbHandle = new Database(stack.dbPath, { readonly: true });
    const rows = dbHandle.prepare('SELECT id, status, error FROM share_log ORDER BY id DESC').all();
    dbHandle.close();
    throw new Error(`share job failed: ${JSON.stringify(rows)}`);
  }
  await expect(dialog.getByText(/Sent!/)).toBeVisible({ timeout: 1_000 });

  // msw saw the /emails call (the Zyphr SDK's sendEmail() POSTs to /v1/emails).
  const calls = stack.zyphr.callsTo('/emails');
  expect(calls.length, `zyphr calls=${JSON.stringify(stack.zyphr.calls)}`).toBeGreaterThanOrEqual(1);
  const body = calls[0]!.body as {
    to?: Array<{ email: string }>;
    attachments?: Array<{ filename?: string; content_type?: string; contentType?: string }>;
    subject?: string;
  };
  expect(body.to?.[0]?.email).toBe('sarah@example.com');
  expect(body.subject).toMatch(/Remy/i);
  expect(body.attachments?.length).toBeGreaterThanOrEqual(1);
  const a0 = body.attachments![0]!;
  expect(a0.filename).toMatch(/\.mp4$/);
  // SDK serializes `contentType` → `content_type` over the wire.
  const ct = a0.content_type ?? a0.contentType;
  expect(ct).toBe('video/mp4');
});
