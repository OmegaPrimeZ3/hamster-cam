// app/server/src/logger.ts
// Centralised pino instance. PLAN §7.7 + Security-Review Finding 5:
// session ids, refresh tokens, API keys, MQTT/RTSP passwords, and similar
// secrets must never reach disk via the log layer. We configure a single
// pino instance with a paranoid redact list and let every module consume it
// via `logger.child({ name: '<module>' })`.
//
// Fastify's `loggerInstance` is wired to this same instance, so request/error
// logs inherit redaction too (`req.headers.cookie` for the `__Host-session`
// cookie is the canonical thing we MUST scrub).
//
// New redactable paths get added here, not at call sites.
//
// NOTE: pino's `redact` matches on dotted paths (with glob-style `*`). We use
// `remove: true` so the redacted key is dropped from the serialised line
// entirely — strictly safer than leaving `[Redacted]` placeholder strings on
// disk, since a placeholder still confirms "a token was here" to anyone with
// shell access to the log file.
//
// IMPORTANT: per pino docs, the `*` wildcard matches exactly one path
// segment, so `*.password` covers `body.password`, `data.password`, etc.
// Cookie headers live at `req.headers.cookie` (lowercased by Fastify).

import pino, { type Logger, type LoggerOptions } from 'pino';

/** Paths the redaction filter scrubs from every log line. */
const REDACT_PATHS: readonly string[] = [
  // Inbound request — these are the high-impact ones. Fastify lowercases
  // header names, so the lowercase variants are authoritative.
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  // Outbound response.
  'res.headers["set-cookie"]',
  // Generic per-object secret-shaped keys at any depth-one position.
  '*.password',
  '*.access_token',
  '*.refresh_token',
  '*.accessToken',
  '*.refreshToken',
  '*.zyphr_refresh_token',
  '*.zyphr_access_token',
  // Env-shaped values that occasionally end up logged alongside an error.
  'ZYPHR_API_KEY',
  'ZYPHR_APP_SECRET',
  'CLOUDFLARE_API_TOKEN',
  'MQTT_PASSWORD',
  'RTSP_PASSWORD',
  'FRIGATE_RTSP_PASSWORD',
];

const baseOptions: LoggerOptions = {
  name: 'hamster-app',
  level: process.env['LOG_LEVEL'] ?? 'info',
  redact: {
    paths: [...REDACT_PATHS],
    remove: true,
  },
};

/** The shared root logger. Use `.child({ name: 'foo' })` from consumer modules. */
export const logger: Logger = pino(baseOptions);

/**
 * Convenience helper: child logger with a `name` binding so we get the same
 * structured field every module's lines already used to carry.
 */
export function childLogger(name: string): Logger {
  return logger.child({ name });
}

/** Exposed for tests + the Fastify wiring in index.ts. */
export const REDACTED_PATHS = REDACT_PATHS;
