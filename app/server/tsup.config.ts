import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    migrate: 'src/migrate.ts',
    bootstrap: 'src/bootstrap.ts',
    'diary-cleanup': 'src/diary-cleanup.ts',
    backfill: 'src/backfill.ts',
    'timelapse-regen': 'src/timelapse-regen.ts',
    // Exposed to the frontend workspace for end-to-end-typed tRPC client.
    // `import type { AppRouter } from '@hamster-cam/server/trpc'`.
    trpc: 'src/trpc.ts',
  },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: true,
  outDir: 'dist',
  external: ['better-sqlite3'],
});
