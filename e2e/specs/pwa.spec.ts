// e2e/specs/pwa.spec.ts
//
// Covers PLAN §5.4 acceptance bullet:
//   • Page still functions with the Mac Mini offline (cached shell, "looking
//     for {Pet}…" mascot).
// Plus the §7.7 + agent-file PWA hardening bullets:
//   • Manifest validates structurally.
//   • Service worker registers without console errors.
//
// Implementation notes:
//   - The /manifest.json file is shipped by the proxy from app/web/dist.
//   - The Workbox-generated /sw.js registers on first load.
//   - For the offline test, we kill the backend so any /trpc or /auth request
//     fails, then navigate to / and assert the cached app shell still paints.

import { test, expect } from '@playwright/test';
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

test('PWA manifest is structurally valid', async ({ page, request }) => {
  // We don't navigate; just fetch the static file directly via the proxy.
  // The frontend dist serves a JSON manifest with start_url=/ and PNG icons.
  const res = await request.get(`${stack.frontUrl}/manifest.json`);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    name?: string;
    short_name?: string;
    start_url?: string;
    display?: string;
    icons?: Array<{ src?: string; sizes?: string; type?: string }>;
  };
  expect(typeof body.name).toBe('string');
  expect(typeof body.short_name).toBe('string');
  expect(body.start_url).toBe('/');
  expect(['standalone', 'minimal-ui', 'fullscreen']).toContain(body.display);
  expect((body.icons ?? []).length).toBeGreaterThanOrEqual(1);
  for (const icon of body.icons ?? []) {
    expect(typeof icon.src).toBe('string');
    expect(typeof icon.sizes).toBe('string');
    expect(icon.type).toMatch(/image\//);
  }
});

test('service worker registers without console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // 401 Unauthorized on /auth/me before login is the expected pre-auth
    // splash; it's not a SW registration error.
    if (/Failed to load resource: the server responded with a status of 401/.test(text)) return;
    errors.push(`console.error: ${text}`);
  });

  await page.goto(`${stack.frontUrl}/login`);
  // vite-plugin-pwa's `injectRegister: 'auto'` posts the registration to
  // navigator.serviceWorker; wait for the controller to settle.
  await page.waitForFunction(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.getRegistration();
    return reg !== undefined && reg.active !== null;
  }, null, { timeout: 15_000 });

  // No console.error logged while registering.
  expect(errors, `errors during SW registration:\n${errors.join('\n')}`).toEqual([]);
});

test('app shell stays functional when the backend (Mac Mini) is unreachable', async ({ page }) => {
  // First, load the app online so the service worker precache populates and
  // the SPA JS bundle is cached in the browser HTTP cache.
  await page.goto(`${stack.frontUrl}/login`);
  await page.waitForFunction(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.getRegistration();
    return reg !== undefined && reg.active !== null;
  }, null, { timeout: 15_000 });
  // Confirm the login form actually rendered before we kill anything.
  await expect(page.getByLabel('Email')).toBeVisible();

  // Simulate the "Mac Mini offline" scenario: kill the backend. The proxy
  // still serves the static SPA bundle (which is exactly what Caddy + the
  // SW precache would do in production when the backend goes away). The
  // /trpc and /auth proxies start returning 502; AuthGate falls back to
  // the splash ("Looking for your pet…") instead of white-screening.
  await stack.killBackend();

  await page.reload({ waitUntil: 'domcontentloaded' });

  // The cached app shell paints — the user sees the splash mascot text
  // (auth/me is pending forever because the proxy returns 502).
  await expect(
    page.getByText(/Looking for your pet|Pet Cam!|Remy Cam!/i).first(),
  ).toBeVisible({ timeout: 10_000 });
});
