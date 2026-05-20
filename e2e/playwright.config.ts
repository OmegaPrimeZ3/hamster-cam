// e2e/playwright.config.ts
//
// Playwright config for the hamster-cam acceptance suite.
//
// Project matrix per Stage-6 brief:
//   - chromium-desktop : default viewport, simulates the parent's laptop
//   - webkit-tablet    : iPad viewport (1024x768), simulates the kid's iPad
//
// Both projects share the same spec set so we exercise every flow on both
// surfaces.  The Playwright `webServer` machinery is intentionally NOT used:
// each spec stands up its own stack via `stackFixture` so the seeded SQLite
// DB + msw recordings can be inspected from inside the test (e.g. "did the
// backend write the audit row we expect?", "did msw observe the Zyphr
// /emails/send call?").  Spinning up the stack per worker is the simplest
// way to keep the suite hermetic — no shared state to clean between tests.
//
// We deliberately run with `workers: 1` and `fullyParallel: false`: the stack
// fixture binds well-known ports and the better-sqlite3 file is single-writer
// inside one process, so concurrent specs would race.

import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env['CI'];

export default defineConfig({
  testDir: './specs',
  fullyParallel: false,
  workers: 1,
  forbidOnly: isCI,
  retries: 0,
  // Per-test timeout — most specs finish well inside 30s, but the bootstrap
  // CLI spec spawns a Node sub-process which can be slow on first cold-start.
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  reporter: isCI
    ? [['list'], ['json', { outputFile: 'test-results/results.json' }], ['html', { open: 'never' }]]
    : [['list'], ['json', { outputFile: 'test-results/results.json' }], ['html', { open: 'never' }]],
  // `baseURL` is set per-spec via stackFixture.url — we don't bake it in here
  // because the port is allocated dynamically.
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // We hit the dev preview which listens on http (no real cert), so disable
    // strict HTTPS — the in-browser flow doesn't care.
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1366, height: 900 },
        launchOptions: {
          // The stack fixture serves https with a self-signed cert; Chromium's
          // ServiceWorker registration path fetches /sw.js outside of the
          // context's ignoreHTTPSErrors gate, so we need a launch-level flag
          // too. --allow-insecure-localhost would also work but is broader.
          args: ['--ignore-certificate-errors'],
        },
      },
    },
    {
      name: 'webkit-tablet',
      use: {
        ...devices['Desktop Safari'],
        // iPad-class viewport for the kid's tablet.  Real iPad UA differs but
        // we exercise the same layout breakpoints.
        viewport: { width: 1024, height: 768 },
      },
    },
  ],
  outputDir: 'test-results',
});
