// app/server/src/backfill-errors.ts
// Shared error-classification helpers for any code path that needs to decide
// whether a Frigate/ffmpeg failure is permanent (give up immediately) or
// transient (worth retrying later).
//
// Used by:
//   - jobs/thumbnail-backfill.ts  — cron-driven backfill job
//   - trpc.ts  clip.get           — on-demand clip extraction

import { FfmpegError } from './frigate.js';

export type BackfillErrorClass = 'permanent' | 'transient';

/**
 * Classify a thumbnail-generation / clip-extraction error as permanent (give
 * up immediately) or transient (retry is worth attempting).
 *
 * Permanent errors:
 *   - HTTP 400 Bad Request  — footage outside Frigate's retention / event not found
 *   - HTTP 401 Unauthorized — auth problem (won't self-heal)
 *   - HTTP 404 Not Found    — event or recording genuinely gone
 *   - HTTP 410 Gone         — explicitly deleted
 *
 * Transient errors (everything else):
 *   - Network errors: ECONNRESET, ECONNREFUSED, ETIMEDOUT, EAI_AGAIN, ENOTFOUND
 *   - HTTP 408, 429, 500, 502, 503, 504
 *   - Any unknown error (conservative: assume it might resolve)
 */
export function classifyBackfillError(err: unknown): BackfillErrorClass {
  const msg = getErrorText(err);

  // Permanent HTTP statuses: 400, 401, 404, 410.
  if (/\b(400|401|404|410)\b/.test(msg)) return 'permanent';

  // Transient network error codes.
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/.test(msg)) return 'transient';

  // Transient HTTP statuses: 408, 429, 500, 502, 503, 504.
  if (/\b(408|429|500|502|503|504)\b/.test(msg)) return 'transient';

  // Connection-level text from ffmpeg stderr (when TCP fails before HTTP).
  if (/connection (refused|reset|timed out)|broken pipe/i.test(msg)) return 'transient';

  // Conservative default: unknown errors are treated as transient.
  return 'transient';
}

/** Human-readable reason string for a classified error — stored in the DB. */
export function describeBackfillError(err: unknown): string {
  const msg = getErrorText(err);
  const httpMatch = msg.match(/\b(400|401|404|408|410|429|500|502|503|504)\b/);
  if (httpMatch) return `http_${httpMatch[1]}`;
  const errCodeMatch = msg.match(/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/);
  if (errCodeMatch) return errCodeMatch[0].toLowerCase();
  return err instanceof Error ? err.message.slice(0, 120) : 'unknown_error';
}

/** Returns a combined error text string covering message + stderr (for FfmpegError). */
export function getErrorText(err: unknown): string {
  if (err instanceof FfmpegError) {
    return `${err.message} ${err.stderr}`;
  }
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    return `${err.message} ${code}`;
  }
  return String(err);
}
