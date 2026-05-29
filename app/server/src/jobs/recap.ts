// app/server/src/jobs/recap.ts
// Overnight recap — fires at 06:10 local (after the 06:05 timelapse) and
// summarises what the hamster got up to between 21:00 the previous evening
// and 06:00 this morning, producing a warm storybook paragraph via Gemini
// stored as a 'recap' diary entry. Idempotent per night.
//
// Window: [nightStart, nightEnd) where
//   nightEnd   = 06:00:00.000 local today  (same anchor the timelapse uses)
//   nightStart = nightEnd − 9 h            = 21:00:00.000 local yesterday
//
// Date key: nightStart's local date (the evening the night began), so the
// night of May 25 21:00 → May 26 06:00 is labelled "2026-05-25".
//
// IMPORTANT — TIMEZONE: "local" means the process timezone (process.env.TZ or
// the system default). On Linux servers with no TZ set, this is UTC — meaning
// nightEnd = 06:00 UTC, nightStart = 21:00 UTC the previous evening. Make sure
// the systemd unit sets TZ= to match the operator's timezone (e.g. TZ=America/New_York)
// so the window aligns with the hamster's actual overnight activity.
//
// Safety gate: if GEMINI_API_KEY is unset the job logs and returns without
// throwing. Network errors are also swallowed — the narrator path must
// never be disrupted by an optional AI feature.
//
// MODEL NOTE: Default is gemini-2.5-flash (stable). Do NOT configure
// gemini-2.0-flash — it is deprecated and returns 400 INVALID_ARGUMENT.

import { getConfig } from '../config.js';
import * as db from '../db.js';
import { childLogger } from '../logger.js';

const logger = childLogger('recap-job');

/**
 * Thrown by callGemini when the Gemini API returns a non-2xx status.
 * Carries the HTTP status and the raw response body so callers can log
 * actionable diagnostics (e.g. 400 = bad model name, 403 = quota/key).
 * `attempts` is set by callGeminiWithRetry before re-throwing.
 */
class GeminiApiError extends Error {
  attempts = 1;
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly responseBody: string,
  ) {
    super(message);
    this.name = 'GeminiApiError';
  }
}

/**
 * Wraps a generic network/abort error after all retry attempts are exhausted.
 * Carries the total attempt count so the final log line can report it.
 */
class GeminiRetryExhaustedError extends Error {
  constructor(
    message: string,
    readonly originalCause: unknown,
    readonly attempts: number,
  ) {
    super(message);
    this.name = 'GeminiRetryExhaustedError';
  }
}

const SKIP_KINDS: ReadonlySet<db.DiaryKind> = new Set(['timelapse', 'recap']);
const SKIP_ACTIVITIES: ReadonlySet<db.DiaryActivity> = new Set(['snapshot', 'timelapse', 'recap']);
const MIN_SOURCE_ENTRIES = 3;

/**
 * Per-call timeout for the Gemini HTTP request. 30 s gives enough headroom for
 * a slow-but-healthy Gemini (manual trigger measured ~9.5 s; original 20 s
 * fired prematurely at 06:09 PDT). Bumped from 20 s.
 */
const FETCH_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Retry configuration — tunable constants near the top for easy future change.
// ---------------------------------------------------------------------------

/** Total call attempts (1 initial + N-1 retries). */
const GEMINI_MAX_ATTEMPTS = 4;

/**
 * Base delay in ms for exponential backoff.
 * Actual delay for attempt i (0-indexed, where 0 = first retry):
 *   base * 2^i + Math.random() * BACKOFF_JITTER_MS
 * → ~10 s, ~30 s (capped at 60 s + jitter), ~60 s + jitter
 */
const BACKOFF_BASE_MS = 10_000;
const BACKOFF_MAX_MS  = 60_000;
const BACKOFF_JITTER_MS = 1_000;

/**
 * HTTP status codes from Gemini that are considered transient and safe to
 * retry. 400/401/403/404 are permanent failures (bad config, bad key, bad
 * model) — we give up immediately on those.
 */
const RETRYABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Node.js error codes that indicate a transient network condition.
 */
const RETRYABLE_NODE_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'FETCH_ERROR',
]);

/**
 * Returns true if the thrown error should trigger a retry.
 * Exported so the unit-test suite can exercise the classifier directly.
 */
export function isRetryableGeminiError(err: unknown): boolean {
  // GeminiApiError: only retry on explicitly transient HTTP statuses.
  if (err instanceof GeminiApiError) {
    return RETRYABLE_HTTP_STATUSES.has(err.httpStatus);
  }
  // GeminiSafetyError: content policy block — do NOT retry (it'll block again).
  if (err instanceof GeminiSafetyError) {
    return false;
  }
  if (err instanceof Error) {
    // AbortController fires with name='AbortError' or message contains the
    // phrase Node uses: "This operation was aborted" / "The operation was aborted."
    if (
      err.name === 'AbortError' ||
      (err as NodeJS.ErrnoException).code === 'ABORT_ERR' ||
      err.message.includes('aborted') ||
      err.message.includes('operation was aborted')
    ) {
      return true;
    }
    // Network-level errors carry a `.code` property.
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (RETRYABLE_NODE_CODES.has(code.toUpperCase())) {
      return true;
    }
    // FetchError (undici / node-fetch) carries type='system' for network faults.
    // Treat any unrecognised non-HTTP error as transient (log and retry).
    return true;
  }
  // Unknown throw type: treat as transient.
  return true;
}

/**
 * Compute exponential backoff delay (ms) for the given 0-indexed retry
 * attempt (0 = first retry, 1 = second, …).
 */
function backoffDelayMs(retryIndex: number): number {
  const base = BACKOFF_BASE_MS * Math.pow(2, retryIndex);
  const capped = Math.min(base, BACKOFF_MAX_MS);
  return capped + Math.random() * BACKOFF_JITTER_MS;
}

/** 9-hour overnight capture window: 21:00 → 06:00. */
const NIGHT_WINDOW_MS = 9 * 60 * 60 * 1000;

export interface RecapRunResult {
  /** ISO YYYY-MM-DD of the night's START date (the evening the night began). */
  date: string;
  skipped: false | 'disabled' | 'no_api_key' | 'too_few_entries' | 'api_error';
  diary_entry_id: number | null;
}

// Injected dependencies for testing.
export interface RecapDeps {
  now?: () => number;
  fetch?: typeof globalThis.fetch;
  /** Inject a no-op or fast sleep in tests to avoid real backoff delays. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run the overnight recap job for the night ending at 06:00 on the reference
 * time. Default: now (the cron fires at 06:10, so "now" is the morning after
 * the night). Pass a fixed Date to pin the window for tests. Idempotent per
 * night.
 */
export async function runRecapJob(
  ref?: Date,
  deps: RecapDeps = {},
): Promise<RecapRunResult> {
  const cfg = getConfig();
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const nowFn = deps.now ?? (() => Date.now());
  const sleepFn = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const refDate = ref ?? new Date(nowFn());

  // nightEnd = 06:00:00.000 local today (same anchor the timelapse uses).
  const nightEnd = localSixAM(refDate);
  // nightStart = 21:00:00.000 local yesterday.
  const nightStart = nightEnd - NIGHT_WINDOW_MS;

  // Key the recap to the START of the night (the evening), matching the
  // timelapse convention so both entries carry the same date label.
  const isoDate = toIsoDate(new Date(nightStart));

  const recapEnabledRaw = db.getSetting('recap_enabled');
  if (recapEnabledRaw === 'false' || recapEnabledRaw === '0') {
    logger.info({ job: 'recap', skipped: 'disabled' });
    return { date: isoDate, skipped: 'disabled', diary_entry_id: null };
  }

  if (!cfg.GEMINI_API_KEY) {
    logger.info({ job: 'recap', skipped: 'no_api_key' });
    return { date: isoDate, skipped: 'no_api_key', diary_entry_id: null };
  }

  const allEntries = db.listDiaryEntriesBetween(nightStart, nightEnd);
  const sourceEntries = allEntries.filter(
    (e) => !SKIP_KINDS.has(e.kind) && (e.activity == null || !SKIP_ACTIVITIES.has(e.activity)),
  );

  // Log diagnostic info at every run so operators can see exactly what the
  // job found — critical for debugging "recap not appearing" without needing
  // to manually query the DB.
  //
  // Also warn if TZ is not set — the window math uses local time, so on a
  // server with no TZ configured (defaulting to UTC) the window will be
  // wrong for operators in non-UTC timezones.
  if (!process.env['TZ']) {
    logger.warn(
      { job: 'recap' },
      'overnight recap: TZ env var is not set — window uses UTC. ' +
        'Set TZ=<your/timezone> in the systemd EnvironmentFile to align ' +
        'the overnight window with actual local midnight.',
    );
  }

  const geminiModel = cfg.GEMINI_MODEL ?? 'gemini-2.5-flash';
  logger.info(
    {
      job: 'recap',
      night: isoDate,
      window_start_iso: new Date(nightStart).toISOString(),
      window_end_iso: new Date(nightEnd).toISOString(),
      all_entries_in_window: allEntries.length,
      source_entries: sourceEntries.length,
      min_required: MIN_SOURCE_ENTRIES,
      model: geminiModel,
      tz: process.env['TZ'] ?? '(system default)',
    },
    'overnight recap: job running',
  );

  if (sourceEntries.length < MIN_SOURCE_ENTRIES) {
    logger.info(
      { job: 'recap', night: isoDate, entries: sourceEntries.length, skipped: 'too_few_entries' },
      'overnight recap skipped — not enough source entries',
    );
    return { date: isoDate, skipped: 'too_few_entries', diary_entry_id: null };
  }

  const petName = db.getSetting('pet_name') ?? 'the hamster';

  // Parse recap_names: "Maya,Leo" → ['Maya', 'Leo']. Empty string (the
  // default) means no personalised greeting — prompt is unchanged from today.
  const rawRecapNames = db.getSetting('recap_names') ?? '';
  const recapNames = rawRecapNames
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const bulletList = buildBulletList(sourceEntries);
  const prompt = buildPrompt(petName, bulletList, recapNames);

  let recapText: string;
  try {
    recapText = await callGeminiWithRetry(
      cfg.GEMINI_API_KEY,
      geminiModel,
      prompt,
      fetchFn,
      sleepFn,
      isoDate,
    );
  } catch (err) {
    if (err instanceof GeminiApiError) {
      logger.error(
        {
          job: 'recap',
          night: isoDate,
          model: geminiModel,
          http_status: err.httpStatus,
          response_body: err.responseBody.slice(0, 500),
          attempts: err.attempts,
          hint: err.httpStatus === 400
            ? 'Check GEMINI_MODEL — gemini-2.0-flash is deprecated; use gemini-2.5-flash'
            : err.httpStatus === 403
              ? 'Check GEMINI_API_KEY validity and quota'
              : undefined,
        },
        'overnight recap: Gemini API HTTP error — check GEMINI_API_KEY and GEMINI_MODEL',
      );
    } else if (err instanceof GeminiSafetyError) {
      logger.error(
        {
          job: 'recap',
          night: isoDate,
          model: geminiModel,
          finish_reason: err.finishReason,
          block_reason: err.blockReason,
          attempts: err.attempts,
        },
        'overnight recap: Gemini blocked response (safety/policy filter)',
      );
    } else {
      logger.error(
        {
          job: 'recap',
          night: isoDate,
          model: geminiModel,
          err: (err as Error).message,
          attempts: (err as GeminiRetryExhaustedError).attempts ?? 1,
        },
        'overnight recap: Gemini API call failed (network/timeout)',
      );
    }
    return { date: isoDate, skipped: 'api_error', diary_entry_id: null };
  }

  // occurred_at = nightEnd − 1 so the recap entry lands at 05:59:59.999 —
  // inside the morning's activity.today window (after 00:00 local) and just
  // after the timelapse entry (nightEnd − 1 shared with timelapse; recap is
  // written at nightEnd − 1 as well, relying on the frontend's kind-based
  // sort tiebreak to place recap above timelapse when timestamps are equal).
  const entry = db.replaceRecapEntry(nightStart, nightEnd, {
    occurred_at: nightEnd - 1,
    kind: 'recap',
    activity: 'recap',
    narrative: recapText,
    pet_name: petName,
    camera_id: null,
    from_camera_id: null,
    to_camera_id: null,
    duration_ms: null,
    snapshot_id: null,
    media_path: null,
    details: JSON.stringify({
      source_entry_count: sourceEntries.length,
      // Record which names were used for the greeting so the entry is
      // self-describing; omitted when the feature is not configured.
      ...(recapNames.length > 0 && { greeting_names: recapNames }),
    }),
    ai_model: geminiModel,
  });

  logger.info(
    { job: 'recap', night: isoDate, entry_id: entry.id, model: entry.ai_model },
    'overnight recap produced',
  );
  return { date: isoDate, skipped: false, diary_entry_id: entry.id };
}

async function callGemini(
  apiKey: string,
  model: string,
  prompt: string,
  fetchFn: typeof globalThis.fetch,
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Capture the response body so the caller can log actionable detail
    // (e.g. 400 INVALID_ARGUMENT = bad model name, 403 = quota/key issue).
    let body = '';
    try {
      body = await res.text();
    } catch {
      // ignore
    }
    throw new GeminiApiError(`Gemini returned HTTP ${res.status}`, res.status, body);
  }

  const json = await res.json() as GeminiResponse;

  // Detect safety-blocked responses: candidates present but content is absent,
  // or finishReason is 'SAFETY'. This happens when the prompt triggers Gemini's
  // safety filters — the response is 200 OK but useless.
  const firstCandidate = json?.candidates?.[0];
  if (firstCandidate !== undefined) {
    const finishReason = firstCandidate.finishReason;
    if (finishReason === 'SAFETY' || finishReason === 'RECITATION' || finishReason === 'OTHER') {
      const blocked = json.promptFeedback?.blockReason;
      throw new GeminiSafetyError(
        `Gemini response blocked (finishReason=${finishReason}${blocked ? `, blockReason=${blocked}` : ''})`,
        finishReason,
        blocked ?? null,
      );
    }
  }

  // Check for empty or missing candidates array.
  if (!Array.isArray(json?.candidates) || json.candidates.length === 0) {
    throw new Error('Gemini returned no candidates in response');
  }

  const text = firstCandidate?.content?.parts?.[0]?.text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('Gemini candidate has no usable text in parts');
  }
  return text.trim();
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
    /** Why the candidate generation stopped. 'STOP' is normal. */
    finishReason?: string;
  }>;
  /** Present when the entire request is blocked before generation. */
  promptFeedback?: {
    blockReason?: string;
  };
}

/**
 * Thrown by callGemini when Gemini blocks the response for safety / policy
 * reasons (finishReason SAFETY/RECITATION/OTHER). Distinct from GeminiApiError
 * (HTTP error) so callers can log more useful diagnostics.
 * `attempts` is set by callGeminiWithRetry before re-throwing.
 */
class GeminiSafetyError extends Error {
  attempts = 1;
  constructor(
    message: string,
    readonly finishReason: string,
    readonly blockReason: string | null,
  ) {
    super(message);
    this.name = 'GeminiSafetyError';
  }
}

/**
 * Calls callGemini with exponential-backoff retries for transient failures.
 *
 * - Up to GEMINI_MAX_ATTEMPTS total (1 initial + retries).
 * - On permanent failure (non-retryable error) gives up immediately.
 * - Logs a warning before each retry; logs success-after-retry at info level.
 * - Throws the final error (with `attempts` field set) so the caller can log it.
 * - The diary insert happens AFTER this function returns; there is no risk of a
 *   double-write from retries.
 */
async function callGeminiWithRetry(
  apiKey: string,
  model: string,
  prompt: string,
  fetchFn: typeof globalThis.fetch,
  sleepFn: (ms: number) => Promise<void>,
  nightLabel: string,
): Promise<string> {
  const callStart = Date.now();
  let attempt = 0;
  let lastErr: unknown;

  while (attempt < GEMINI_MAX_ATTEMPTS) {
    attempt += 1;
    try {
      const text = await callGemini(apiKey, model, prompt, fetchFn);
      if (attempt > 1) {
        logger.info(
          {
            job: 'recap',
            night: nightLabel,
            model,
            attempt,
            of: GEMINI_MAX_ATTEMPTS,
            totalElapsedMs: Date.now() - callStart,
          },
          'overnight recap: Gemini call succeeded after retry',
        );
      }
      return text;
    } catch (err) {
      lastErr = err;

      // Permanent errors: give up now, don't consume remaining attempts.
      if (!isRetryableGeminiError(err)) {
        break;
      }

      if (attempt < GEMINI_MAX_ATTEMPTS) {
        const delayMs = backoffDelayMs(attempt - 1); // 0-indexed retry index
        const errMsg = err instanceof Error ? err.message : String(err);
        const errCode =
          err instanceof GeminiApiError
            ? `HTTP_${err.httpStatus}`
            : (err instanceof Error
                ? ((err as NodeJS.ErrnoException).code ?? err.name)
                : 'UNKNOWN');

        logger.warn(
          {
            job: 'recap',
            night: nightLabel,
            model,
            attempt,
            of: GEMINI_MAX_ATTEMPTS,
            delayMs: Math.round(delayMs),
            errCode,
            err: errMsg,
          },
          'overnight recap: Gemini call failed, will retry',
        );
        await sleepFn(delayMs);
      }
    }
  }

  // Attach the attempt count to the thrown error so the caller's log includes it.
  if (lastErr instanceof GeminiApiError || lastErr instanceof GeminiSafetyError) {
    lastErr.attempts = attempt;
    throw lastErr;
  }
  // Wrap generic network/abort errors so the caller gets a typed object.
  throw new GeminiRetryExhaustedError(
    lastErr instanceof Error ? lastErr.message : String(lastErr),
    lastErr,
    attempt,
  );
}

function buildBulletList(entries: db.DiaryEntryRow[]): string {
  return entries
    .slice()
    .sort((a, b) => a.occurred_at - b.occurred_at)
    .map((e) => {
      const ts = new Date(e.occurred_at);
      const hh = String(ts.getHours()).padStart(2, '0');
      const mm = String(ts.getMinutes()).padStart(2, '0');
      const label = e.activity ?? 'activity';
      const dur = e.duration_ms != null ? ` for ${Math.round(e.duration_ms / 60_000)} min` : '';
      return `- ${hh}:${mm} — ${label}${dur}`;
    })
    .join('\n');
}

/**
 * Build the Gemini prompt for the overnight recap.
 *
 * When `names` is non-empty the model is asked to OPEN with a short,
 * child-friendly greeting addressed to those names before the recap paragraph.
 * Natural grammar: one name → "Hello Maya,"; two → "Hello Maya and Leo,";
 * three or more → Oxford-style "Hello Maya, Leo, and Sam,".
 *
 * The word-budget guidance is bumped to ~90 words (from 80) to accommodate
 * the greeting without crowding out the recap paragraph itself.
 *
 * When `names` is empty the prompt is exactly the same as before — no new
 * instructions, no word-budget change.
 */
function buildPrompt(petName: string, bulletList: string, names: string[]): string {
  const hasNames = names.length > 0;

  // Build a natural Oxford-style join for 1, 2, or 3+ names.
  const greetingNames = (() => {
    if (names.length === 0) return '';
    if (names.length === 1) return names[0] ?? '';
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    // Three or more: "Maya, Leo, and Sam"
    const allButLast = names.slice(0, -1).join(', ');
    return `${allButLast}, and ${names[names.length - 1]}`;
  })();

  const greetingInstruction = hasNames
    ? `Start with a short, warm greeting addressed to ${greetingNames} ` +
      `(e.g. "Hello ${greetingNames},") on its own line before the recap paragraph. ` +
      `Keep the greeting to one short sentence. ` +
      `The greeting does not count toward the word budget for the recap paragraph. `
    : '';

  const wordBudget = hasNames ? 90 : 80;

  return (
    `You are writing one short, warm, child-friendly storybook paragraph (2–4 sentences) ` +
    `about what the pet hamster ${petName} got up to overnight. ` +
    `Use only the facts in the activity log below. ` +
    `Write in past tense, third person. Do not invent new facts. ` +
    `${greetingInstruction}` +
    `Keep it under ${wordBudget} words. End on a cozy note.\n\n` +
    `Last night's activity log:\n${bulletList}`
  );
}

/**
 * Exported purely for unit tests — allows verifying prompt shape without
 * running the full job lifecycle.
 */
export const buildPromptForTest = buildPrompt;

/**
 * Return a timestamp for 06:00:00.000 local time on the same calendar day as
 * `ref`. Mirrors the identical helper in jobs/timelapse.ts — kept here so
 * recap.ts has no import dependency on that module.
 */
function localSixAM(ref: Date): number {
  const copy = new Date(ref);
  copy.setHours(6, 0, 0, 0);
  return copy.getTime();
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
