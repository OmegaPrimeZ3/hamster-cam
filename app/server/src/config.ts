// app/server/src/config.ts
// Typed, validated process.env access. Single import point so a forgotten
// env var fails loudly at boot rather than as a runtime `undefined` deep in a
// handler. Lazy-evaluated so test code can stub process.env before importing
// downstream modules.

import { z } from 'zod';

const envSchema = z.object({
  // Required at runtime; bootstrap CLI also relies on them.
  DATABASE_PATH: z.string().min(1, 'DATABASE_PATH is required'),
  STORAGE_PATH: z.string().min(1, 'STORAGE_PATH is required'),
  ZYPHR_API_KEY: z.string().min(1, 'ZYPHR_API_KEY is required'),

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
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .optional()
    .default('development'),
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
