// app/web/vite.config.ts
//
// Vite config for the hamster-cam frontend.
//
// - React + JSX runtime
// - Path alias `@` → `src/`
// - Dev proxy `/trpc` / `/auth` / `/snapshots` / `/stream` → the local
//   backend so `pnpm dev` works against a running server. The backend port
//   defaults to 5181 (deliberately off the crowded 3000 range so multiple
//   projects can run in parallel) and is overridable via HC_BACKEND_PORT.
//   The dev launcher in app/server/src/dev.ts reads the same env var.
// - vite-plugin-pwa configured per PLAN §5.4 Workbox strategies:
//     * app shell (JS / CSS / fonts / icons): cache-first, precached
//     * /auth/* and /trpc/*: NetworkOnly (auth + live state never cached)
//     * snapshot images /snapshots/*.jpg: CacheFirst with 7-day expiry
//     * live video streams (go2rtc): NetworkOnly (never cached)
// - Vitest config (jsdom + setup file) lives here too so we don't need a
//   second config file.

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      strategies: 'generateSW',
      manifest: false, // Static public/manifest.json is served (and backend overrides in prod)
      devOptions: {
        // Disabled in dev because we proxy backend; SW caching during dev is noise.
        enabled: false,
      },
      workbox: {
        globPatterns: [
          '**/*.{js,css,html,ico,png,svg,webp,woff,woff2}',
        ],
        // Don't try to precache the dynamically-served manifest — backend owns it.
        globIgnores: ['**/manifest.json', '**/manifest.webmanifest'],
        // Inject push + notificationclick handlers via a hand-rolled companion
        // script. importScripts executes in the SW scope at install time.
        importScripts: ['/sw-push.js'],
        // App shell SPA fallback so the PWA boots offline on any deep link.
        navigateFallback: '/index.html',
        // ALWAYS bypass the SW for these — they must hit the live backend.
        navigateFallbackDenylist: [/^\/trpc/, /^\/auth/, /^\/snapshots/, /^\/stream/, /^\/live/, /^\/diary\/stream/, /^\/api/],
        runtimeCaching: [
          {
            // Auth endpoints — never cache.
            urlPattern: /^.*\/auth\/.*/i,
            handler: 'NetworkOnly',
            method: 'GET',
          },
          {
            urlPattern: /^.*\/auth\/.*/i,
            handler: 'NetworkOnly',
            method: 'POST',
          },
          {
            // tRPC endpoints — never cache.
            urlPattern: /^.*\/trpc\/.*/i,
            handler: 'NetworkOnly',
            method: 'GET',
          },
          {
            urlPattern: /^.*\/trpc\/.*/i,
            handler: 'NetworkOnly',
            method: 'POST',
          },
          {
            // Camera snapshots: cache-first with 7-day expiry so the diary's
            // thumbs still render after the Mac Mini goes offline.
            urlPattern: /\/snapshots\/.*\.(?:jpg|jpeg|png|webp)/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'hc-snapshots-v1',
              expiration: {
                maxEntries: 500,
                maxAgeSeconds: 7 * 24 * 60 * 60,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Legacy live stream path — never cache.
            urlPattern: /\/stream\/.*/i,
            handler: 'NetworkOnly',
          },
          {
            // go2rtc WebSocket live-view proxy — never cache.
            // The VideoRTC element manages its own WS buffer.
            urlPattern: /\/live\/.*/i,
            handler: 'NetworkOnly',
          },
          {
            // Diary SSE feed — long-lived streaming response, never cache.
            urlPattern: /\/diary\/stream/i,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: Number.parseInt(process.env['HC_WEB_PORT'] ?? '5181', 10),
    host: true,
    proxy: (() => {
      const backend = `http://localhost:${process.env['HC_BACKEND_PORT'] ?? '5180'}`;
      return {
        '/trpc':      { target: backend, changeOrigin: false },
        '/auth':      { target: backend, changeOrigin: false },
        '/snapshots': { target: backend, changeOrigin: false },
        '/stream':    { target: backend, changeOrigin: false, ws: true },
        '/live':      { target: backend, changeOrigin: false, ws: true },
        '/diary':     { target: backend, changeOrigin: false },
      };
    })(),
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    css: false,
    coverage: {
      reporter: ['text', 'json'],
    },
  },
});
