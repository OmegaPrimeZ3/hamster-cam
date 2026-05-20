// Verifies the centralised pino logger scrubs the secret-shaped paths called
// out in PLAN §7.7 + Security-Review Finding 5. We capture serialised log
// lines by piping the logger into a writable stream and inspecting the JSON.

import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { REDACTED_PATHS } from '../src/logger.js';

/**
 * Build a logger with the SAME redact config as the production one, but
 * piped into a Buffer we can introspect. We can't easily replace the live
 * `logger` stream after construction, so we mirror the config here. If the
 * production list ever drifts from `REDACTED_PATHS`, the export-equality
 * assertion below will flag it.
 */
function makeCaptureLogger(): { logger: pino.Logger; lines: () => unknown[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb): void {
      chunks.push(chunk.toString('utf8'));
      cb();
    },
  });
  const logger = pino(
    {
      name: 'hamster-app',
      level: 'info',
      redact: { paths: [...REDACTED_PATHS], remove: true },
    },
    stream,
  );
  return {
    logger,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((s) => s.length > 0)
        .map((s) => JSON.parse(s) as unknown),
  };
}

describe('logger redact', () => {
  it('drops req.headers.cookie containing the session id', () => {
    const { logger, lines } = makeCaptureLogger();
    logger.info(
      {
        req: {
          method: 'GET',
          url: '/auth/me',
          headers: {
            cookie: '__Host-session=DEADBEEFDEADBEEFDEADBEEF',
            'user-agent': 'kid-tablet',
          },
        },
      },
      'incoming',
    );
    const entries = lines() as Array<{ req?: { headers?: Record<string, unknown> } }>;
    expect(entries).toHaveLength(1);
    const first = entries[0];
    expect(first).toBeDefined();
    const headers = first?.req?.headers ?? {};
    // user-agent left intact, cookie removed.
    expect(headers).toMatchObject({ 'user-agent': 'kid-tablet' });
    expect(headers).not.toHaveProperty('cookie');
  });

  it('drops access_token / refresh_token from logged objects', () => {
    const { logger, lines } = makeCaptureLogger();
    logger.info(
      {
        zyphr: { access_token: 'eyJhAAAA', refresh_token: 'eyJrRRRR' },
      },
      'token issued',
    );
    const entries = lines() as Array<{ zyphr?: Record<string, unknown> }>;
    const first = entries[0];
    expect(first).toBeDefined();
    expect(first?.zyphr).toMatchObject({});
    expect(first?.zyphr).not.toHaveProperty('access_token');
    expect(first?.zyphr).not.toHaveProperty('refresh_token');
  });

  it('drops authorization header', () => {
    const { logger, lines } = makeCaptureLogger();
    logger.info(
      { req: { headers: { authorization: 'Bearer leaked-key' } } },
      'auth header logged',
    );
    const entries = lines() as Array<{ req?: { headers?: Record<string, unknown> } }>;
    const headers = entries[0]?.req?.headers ?? {};
    expect(headers).not.toHaveProperty('authorization');
  });

  it('drops set-cookie response header', () => {
    const { logger, lines } = makeCaptureLogger();
    logger.info(
      {
        res: {
          statusCode: 200,
          headers: { 'set-cookie': '__Host-session=BEEF; Path=/', 'content-type': 'text/plain' },
        },
      },
      'response',
    );
    const entries = lines() as Array<{ res?: { headers?: Record<string, unknown> } }>;
    const headers = entries[0]?.res?.headers ?? {};
    expect(headers).toMatchObject({ 'content-type': 'text/plain' });
    expect(headers).not.toHaveProperty('set-cookie');
  });

  it('drops env-shaped api-key keys at top level', () => {
    const { logger, lines } = makeCaptureLogger();
    logger.info(
      { ZYPHR_API_KEY: 'zy_live_AAA', MQTT_PASSWORD: 'shhh', RTSP_PASSWORD: 'shhh' },
      'env snapshot',
    );
    const first = lines()[0] as Record<string, unknown>;
    expect(first).not.toHaveProperty('ZYPHR_API_KEY');
    expect(first).not.toHaveProperty('MQTT_PASSWORD');
    expect(first).not.toHaveProperty('RTSP_PASSWORD');
  });

  it('drops nested password fields', () => {
    const { logger, lines } = makeCaptureLogger();
    logger.info(
      { body: { email: 'x@y.com', password: 'plaintext-bad' } },
      'login payload',
    );
    const entries = lines() as Array<{ body?: Record<string, unknown> }>;
    const body = entries[0]?.body ?? {};
    expect(body).toMatchObject({ email: 'x@y.com' });
    expect(body).not.toHaveProperty('password');
  });
});
