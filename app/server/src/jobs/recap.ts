// app/server/src/jobs/recap.ts
// Nightly 23:58 local: summarise the day's diary into a warm storybook
// paragraph via Gemini and store it as a 'recap' diary entry. Idempotent.
//
// Safety gate: if GEMINI_API_KEY is unset the job logs and returns without
// throwing. Network errors are also swallowed — the narrator path must
// never be disrupted by an optional AI feature.

import { getConfig } from '../config.js';
import * as db from '../db.js';
import { childLogger } from '../logger.js';

const logger = childLogger('recap-job');

const SKIP_KINDS: ReadonlySet<db.DiaryKind> = new Set(['timelapse', 'recap']);
const SKIP_ACTIVITIES: ReadonlySet<db.DiaryActivity> = new Set(['snapshot', 'timelapse', 'recap']);
const MIN_SOURCE_ENTRIES = 3;
const FETCH_TIMEOUT_MS = 20_000;

export interface RecapRunResult {
  date: string;
  skipped: false | 'no_api_key' | 'too_few_entries' | 'api_error';
  diary_entry_id: number | null;
}

// Injected dependencies for testing.
export interface RecapDeps {
  now?: () => number;
  fetch?: typeof globalThis.fetch;
}

/**
 * Run the recap job for the given date. Default: today (the cron fires at
 * 23:58, so "today" is correct). Idempotent per date.
 */
export async function runRecapJob(
  date?: Date,
  deps: RecapDeps = {},
): Promise<RecapRunResult> {
  const cfg = getConfig();
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const nowFn = deps.now ?? (() => Date.now());

  const targetDate = date ?? new Date(nowFn());
  const isoDate = toIsoDate(targetDate);

  if (!cfg.GEMINI_API_KEY) {
    logger.info({ job: 'recap', skipped: 'no_api_key' });
    return { date: isoDate, skipped: 'no_api_key', diary_entry_id: null };
  }

  const dayStart = startOfLocalDay(targetDate);
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;

  const allEntries = db.listDiaryEntriesBetween(dayStart, dayEnd);
  const sourceEntries = allEntries.filter(
    (e) => !SKIP_KINDS.has(e.kind) && (e.activity == null || !SKIP_ACTIVITIES.has(e.activity)),
  );

  if (sourceEntries.length < MIN_SOURCE_ENTRIES) {
    logger.info(
      { job: 'recap', date: isoDate, entries: sourceEntries.length, skipped: 'too_few_entries' },
      'recap skipped — not enough source entries',
    );
    return { date: isoDate, skipped: 'too_few_entries', diary_entry_id: null };
  }

  const petName = db.getSetting('pet_name') ?? 'the hamster';
  const bulletList = buildBulletList(sourceEntries);
  const prompt = buildPrompt(petName, bulletList);

  let recapText: string;
  try {
    recapText = await callGemini(cfg.GEMINI_API_KEY, cfg.GEMINI_MODEL ?? 'gemini-2.0-flash', prompt, fetchFn);
  } catch (err) {
    logger.warn({ job: 'recap', date: isoDate, err: (err as Error).message }, 'recap API call failed');
    return { date: isoDate, skipped: 'api_error', diary_entry_id: null };
  }

  const entry = db.replaceRecapEntry(dayStart, dayEnd, {
    occurred_at: dayEnd - 2,
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
    { job: 'recap', date: isoDate, entry_id: entry.id, model: entry.ai_model },
    'recap produced',
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
    throw new Error(`Gemini returned HTTP ${res.status}`);
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
    `about a day in the life of a pet hamster named ${petName}. ` +
    `Use only the facts in the day's activity log below. ` +
    `Write in past tense, third person. Do not invent new facts. ` +
    `Keep it under 80 words. End on a cozy note.\n\n` +
    `Today's activity log:\n${bulletList}`
  );
}

function startOfLocalDay(d: Date): number {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy.getTime();
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
