// app/web/vite.config.ts
//
// Vite config for the hamster-cam frontend.
//
// - React + JSX runtime
// - Path alias `@` → `src/`
// - Dev proxy `/trpc` and `/auth` and `/snapshots` → http://localhost:3000 so
//   `pnpm dev` works against a running backend.
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
        // App shell SPA fallback so the PWA boots offline on any deep link.
        navigateFallback: '/index.html',
        // ALWAYS bypass the SW for these — they must hit the live backend.
        navigateFallbackDenylist: [/^\/trpc/, /^\/auth/, /^\/snapshots/, /^\/stream/, /^\/api/],
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
            // Live video streams — never cache. The <video-stream> element
            // (or <video>) manages its own buffer.
            urlPattern: /\/stream\/.*/i,
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
    port: 5173,
    host: true,
    proxy: {
      '/trpc': {
        target: 'http://localhost:3000',
        changeOrigin: false,
      },
      '/auth': {
        target: 'http://localhost:3000',
        changeOrigin: false,
      },
      '/snapshots': {
        target: 'http://localhost:3000',
        changeOrigin: false,
      },
      '/stream': {
        target: 'http://localhost:3000',
        changeOrigin: false,
        ws: true,
      },
    },
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
