// app/server/src/config.ts
// Typed, validated process.env access. Single import point so a forgotten
// env var fails loudly at boot rather than as a runtime `undefined` deep in a
// handler. Lazy-evaluated so test code can rewrite process.env before
// importing downstream modules.

import { z } from 'zod';

const envSchema = z.object({
  // Required at runtime; bootstrap CLI also relies on them.
  DATABASE_PATH: z.string().min(1, 'DATABASE_PATH is required'),
  STORAGE_PATH: z.string().min(1, 'STORAGE_PATH is required'),
  // Zyphr application credentials. Both are required — the SDK sends them as
  // two distinct headers (X-Application-Key and X-Application-Secret). The key
  // and secret must come from the SAME Zyphr environment (test vs. live); mixing
  // them produces an "invalid application credentials" rejection at Zyphr.
  ZYPHR_API_KEY: z.string().min(1, 'ZYPHR_API_KEY is required'),
  ZYPHR_APP_SECRET: z.string().min(1, 'ZYPHR_APP_SECRET is required — get it from the Zyphr dashboard alongside ZYPHR_API_KEY'),

  // Optional with sensible defaults.
  PORT: z
    .string()
    .optional()
    .transform((v) => {
      const parsed = Number.parseInt(v ?? '3000', 10);
      return Number.isFinite(parsed) ? parsed : 3000;
    }),
  SESSION_TTL_DAYS: z
    .string()
    .optional()
    .transform((v) => {
      const parsed = Number.parseInt(v ?? '30', 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
    }),

  // Fully optional — code paths degrade gracefully if absent.
  ZYPHR_BASE_URL: z.string().url().optional(),
  ZYPHR_FROM_EMAIL: z.string().email().optional(),
  MQTT_URL: z.string().optional(),
  MQTT_USERNAME: z.string().optional(),
  MQTT_PASSWORD: z.string().optional(),
  FRIGATE_URL: z.string().url().optional(),
  // Gemini recap job — both optional; job skips cleanly if key is unset.
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().optional().default('gemini-2.0-flash'),
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .optional()
    .default('development'),
  // Optional. Absolute path to the built React SPA (app/web/dist). When
  // unset the server resolves it from ../../web/dist relative to the running
  // module so it works in both the monorepo dev layout and the production
  // /opt/hamster-cam tree without any env-var ceremony. If the resolved
  // directory does not exist at boot the static handler is silently skipped
  // (local dev runs the Vite dev server on its own port anyway).
  WEB_DIST_PATH: z.string().optional(),
});

export type AppConfig = z.infer<typeof envSchema>;

let cached: AppConfig | null = null;

/**
 * Parse + validate env. Throws aggregated ZodError on first call if anything
 * required is missing. Subsequent calls return the cached value.
 */
export function getConfig(): AppConfig {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper — forces the next `getConfig()` call to re-read process.env. */
export function resetConfigForTests(): void {
  cached = null;
}
