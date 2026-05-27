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
// Safety gate: if GEMINI_API_KEY is unset the job logs and returns without
// throwing. Network errors are also swallowed — the narrator path must
// never be disrupted by an optional AI feature.

import { getConfig } from '../config.js';
import * as db from '../db.js';
import { childLogger } from '../logger.js';

const logger = childLogger('recap-job');

/**
 * Thrown by callGemini when the Gemini API returns a non-2xx status.
 * Carries the HTTP status and the raw response body so callers can log
 * actionable diagnostics (e.g. 400 = bad model name, 403 = quota/key).
 */
class GeminiApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly responseBody: string,
  ) {
    super(message);
    this.name = 'GeminiApiError';
  }
}

const SKIP_KINDS: ReadonlySet<db.DiaryKind> = new Set(['timelapse', 'recap']);
const SKIP_ACTIVITIES: ReadonlySet<db.DiaryActivity> = new Set(['snapshot', 'timelapse', 'recap']);
const MIN_SOURCE_ENTRIES = 3;
const FETCH_TIMEOUT_MS = 20_000;

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
  logger.info(
    {
      job: 'recap',
      night: isoDate,
      window_start_iso: new Date(nightStart).toISOString(),
      window_end_iso: new Date(nightEnd).toISOString(),
      all_entries_in_window: allEntries.length,
      source_entries: sourceEntries.length,
      min_required: MIN_SOURCE_ENTRIES,
      model: cfg.GEMINI_MODEL ?? 'gemini-2.0-flash',
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
  const bulletList = buildBulletList(sourceEntries);
  const prompt = buildPrompt(petName, bulletList);

  const geminiModel = cfg.GEMINI_MODEL ?? 'gemini-2.0-flash';
  let recapText: string;
  try {
    recapText = await callGemini(cfg.GEMINI_API_KEY, geminiModel, prompt, fetchFn);
  } catch (err) {
    // Log at ERROR level (not warn) so this surfaces clearly in production.
    // GeminiApiError carries HTTP status + body — critical for diagnosing
    // 400 (bad model name), 403 (quota/invalid key), 429 (rate limit), etc.
    if (err instanceof GeminiApiError) {
      logger.error(
        {
          job: 'recap',
          night: isoDate,
          model: geminiModel,
          http_status: err.httpStatus,
          response_body: err.responseBody.slice(0, 500),
        },
        'overnight recap: Gemini API call failed — check GEMINI_API_KEY and GEMINI_MODEL',
      );
    } else {
      logger.error(
        { job: 'recap', night: isoDate, model: geminiModel, err: (err as Error).message },
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
    details: JSON.stringify({ source_entry_count: sourceEntries.length }),
    ai_model: cfg.GEMINI_MODEL ?? 'gemini-2.0-flash',
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
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('Gemini returned empty or unexpected response shape');
  }
  return text.trim();
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
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

function buildPrompt(petName: string, bulletList: string): string {
  return (
    `You are writing one short, warm, child-friendly storybook paragraph (2–4 sentences) ` +
    `about what the pet hamster ${petName} got up to overnight. ` +
    `Use only the facts in the activity log below. ` +
    `Write in past tense, third person. Do not invent new facts. ` +
    `Keep it under 80 words. End on a cozy note.\n\n` +
    `Last night's activity log:\n${bulletList}`
  );
}

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
