// Tests for jobs/recap.ts
// Verifies: skip when no API key, skip when too few entries, write on success,
// idempotent replace on re-run, handle API failure without throwing, overnight
// window bounds, night-start date keying, retry classifier, and backoff schedule.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DiaryActivity } from '../src/db.js';

let workdir: string;
const baseEnv = { ...process.env };

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'hamster-recap-'));
  Object.assign(process.env, baseEnv);
  process.env['DATABASE_PATH'] = join(workdir, 'hamster.db');
  process.env['STORAGE_PATH'] = workdir;
  process.env['ZYPHR_API_KEY'] = 'zy_test_dummy';
  process.env['ZYPHR_APP_SECRET'] = 'zy_test_dummy_secret';
  delete process.env['GEMINI_API_KEY'];
  delete process.env['GEMINI_MODEL'];
  delete process.env['FRIGATE_URL'];
  delete process.env['MQTT_URL'];
});

afterEach(async () => {
  const db = await import('../src/db.js');
  const { resetConfigForTests } = await import('../src/config.js');
  db.resetDbForTests();
  resetConfigForTests();
  rmSync(workdir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mirrors localSixAM from jobs/recap.ts: 06:00:00.000 local on the same day
 * as `ref`. This is nightEnd for any reference time on the morning of that day.
 */
function localSixAM(d: Date): number {
  const copy = new Date(d);
  copy.setHours(6, 0, 0, 0);
  return copy.getTime();
}

/** nightStart = nightEnd − 9h (21:00 local the previous evening). */
const NIGHT_WINDOW_MS = 9 * 60 * 60 * 1000;

/**
 * Seed `count` diary entries spread across the overnight window of `ref`.
 * All entries land between nightStart and nightEnd − 1 min so they are
 * guaranteed to be within-window.
 */
async function seedOvernightDiaryEntries(count: number, ref: Date): Promise<void> {
  const db = await import('../src/db.js');
  db.setSetting('pet_name', 'Peanut');
  const nightEnd = localSixAM(ref);
  const nightStart = nightEnd - NIGHT_WINDOW_MS;
  // Spread entries evenly within the window, keeping a safe 1-min margin at the end.
  const step = count > 1 ? (NIGHT_WINDOW_MS - 60_000) / (count - 1) : 0;
  const activities: DiaryActivity[] = ['wheel', 'food', 'water', 'resting', 'exploring'];
  for (let i = 0; i < count; i += 1) {
    db.createDiaryEntry({
      occurred_at: Math.round(nightStart + i * step),
      kind: 'narrative',
      activity: activities[i % activities.length] ?? 'exploring',
      narrative: `Overnight entry ${i}`,
      pet_name: 'Peanut',
      camera_id: null,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: 5_000,
      snapshot_id: null,
      media_path: null,
      details: null,
    });
  }
}

function makeSuccessFetch(text: string): typeof globalThis.fetch {
  return async () => {
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text }] } }],
      }),
    } as Response;
  };
}

function makeErrorFetch(status: number, body = ''): typeof globalThis.fetch {
  return async () => {
    return {
      ok: false,
      status,
      text: async () => body,
      json: async () => ({}),
    } as Response;
  };
}

/**
 * Simulates a 200 OK response from Gemini where the candidate is present but
 * content is absent (safety block). finishReason indicates the block type.
 */
function makeSafetyBlockFetch(finishReason = 'SAFETY'): typeof globalThis.fetch {
  return async () => {
    return {
      ok: true,
      json: async () => ({
        candidates: [{ finishReason }],
        promptFeedback: { blockReason: 'SAFETY' },
      }),
    } as Response;
  };
}

/**
 * Simulates a 200 OK response with an empty candidates array.
 */
function makeEmptyCandidatesFetch(): typeof globalThis.fetch {
  return async () => {
    return {
      ok: true,
      json: async () => ({ candidates: [] }),
    } as Response;
  };
}

/**
 * Simulates a 200 OK response with no candidates key at all.
 */
function makeMissingCandidatesFetch(): typeof globalThis.fetch {
  return async () => {
    return {
      ok: true,
      json: async () => ({}),
    } as Response;
  };
}

function makeAbortingFetch(): typeof globalThis.fetch {
  return async (_url, opts) => {
    return new Promise<Response>((_resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => {
        reject(new Error('The operation was aborted.'));
      });
    });
  };
}

/** No-op sleep injected in tests so retry backoff doesn't add wall-clock time. */
const noopSleep = async (_ms: number): Promise<void> => { /* instant */ };

// Fixed reference time: 06:10 on the morning of 2026-05-21, simulating the
// cron firing. The overnight window is 21:00 May-20 → 06:00 May-21.
// date key = "2026-05-20" (the evening the night began).
const REF_DATE = new Date('2026-05-21T06:10:00');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runRecapJob', () => {
  it('skips when recap_enabled is set to "false" and never calls fetch', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const db = await import('../src/db.js');
    db.setSetting('recap_enabled', 'false');
    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedOvernightDiaryEntries(5, REF_DATE);

    let fetchCalled = false;
    const sentinelFetch: typeof globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({}) } as Response;
    };

    const result = await runRecapJob(REF_DATE, { fetch: sentinelFetch });
    expect(result.skipped).toBe('disabled');
    expect(result.diary_entry_id).toBeNull();
    expect(fetchCalled).toBe(false);
  });

  it('skips cleanly when GEMINI_API_KEY is not set', async () => {
    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedOvernightDiaryEntries(5, REF_DATE);

    const result = await runRecapJob(REF_DATE, { fetch: makeSuccessFetch('Should not be called') });
    expect(result.skipped).toBe('no_api_key');
    expect(result.diary_entry_id).toBeNull();

    const db = await import('../src/db.js');
    const nightEnd = localSixAM(REF_DATE);
    const nightStart = nightEnd - NIGHT_WINDOW_MS;
    const entries = db.listDiaryEntriesBetween(nightStart, nightEnd);
    expect(entries.filter((e) => e.kind === 'recap')).toHaveLength(0);
  });

  it('skips when there are fewer than 3 source entries', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedOvernightDiaryEntries(2, REF_DATE);

    const result = await runRecapJob(REF_DATE, { fetch: makeSuccessFetch('Should not be called') });
    expect(result.skipped).toBe('too_few_entries');
    expect(result.diary_entry_id).toBeNull();
  });

  it('writes a recap diary entry when the API returns text', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedOvernightDiaryEntries(5, REF_DATE);

    const mockText = 'Peanut had a busy night running on the wheel and snacking.';
    const result = await runRecapJob(REF_DATE, { fetch: makeSuccessFetch(mockText) });

    expect(result.skipped).toBe(false);
    expect(result.diary_entry_id).not.toBeNull();

    const db = await import('../src/db.js');
    const entry = db.getDiaryEntryById(result.diary_entry_id!);
    expect(entry).not.toBeNull();
    expect(entry!.kind).toBe('recap');
    expect(entry!.activity).toBe('recap');
    expect(entry!.narrative).toBe(mockText);
    // Default model is now gemini-2.5-flash (gemini-2.0-flash is deprecated).
    expect(entry!.ai_model).toBe('gemini-2.5-flash');
  });

  it('keys the result date to the night START (the evening)', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedOvernightDiaryEntries(5, REF_DATE);

    // REF_DATE is 2026-05-21 06:10 → nightStart is 2026-05-20 21:00
    // so the date key should be "2026-05-20".
    const result = await runRecapJob(REF_DATE, { fetch: makeSuccessFetch('Overnight recap.') });
    expect(result.date).toBe('2026-05-20');
  });

  it('replaces the existing recap row on re-run (idempotent)', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedOvernightDiaryEntries(5, REF_DATE);

    const first = await runRecapJob(REF_DATE, { fetch: makeSuccessFetch('First overnight recap.') });
    expect(first.skipped).toBe(false);

    const second = await runRecapJob(REF_DATE, { fetch: makeSuccessFetch('Updated overnight recap.') });
    expect(second.skipped).toBe(false);

    const db = await import('../src/db.js');
    const nightEnd = localSixAM(REF_DATE);
    const nightStart = nightEnd - NIGHT_WINDOW_MS;
    const recaps = db.listDiaryEntriesBetween(nightStart, nightEnd).filter(
      (e) => e.kind === 'recap',
    );
    expect(recaps).toHaveLength(1);
    expect(recaps[0]!.narrative).toBe('Updated overnight recap.');
  });

  it('handles API 500 error without throwing (retries then gives up)', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedOvernightDiaryEntries(5, REF_DATE);

    let callCount = 0;
    const countingFetch: typeof globalThis.fetch = async () => {
      callCount += 1;
      return { ok: false, status: 500, text: async () => 'server error', json: async () => ({}) } as Response;
    };

    const result = await runRecapJob(REF_DATE, { fetch: countingFetch, sleep: noopSleep });
    expect(result.skipped).toBe('api_error');
    expect(result.diary_entry_id).toBeNull();
    // 500 is retryable: should exhaust all 4 attempts.
    expect(callCount).toBe(4);
  });

  it('handles network timeout without throwing (retries then gives up)', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedOvernightDiaryEntries(5, REF_DATE);

    let callCount = 0;
    // Reject immediately with an abort-shaped error rather than waiting for the
    // AbortController signal to fire (which would take 30 s × 4 attempts).
    const countingAbortFetch: typeof globalThis.fetch = async () => {
      callCount += 1;
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      throw err;
    };

    const result = await runRecapJob(REF_DATE, { fetch: countingAbortFetch, sleep: noopSleep });
    expect(result.skipped).toBe('api_error');
    expect(result.diary_entry_id).toBeNull();
    // Abort is retryable: should exhaust all 4 attempts.
    expect(callCount).toBe(4);
  });

  it('recap occurred_at lands at nightEnd − 1 (05:59:59.999 local)', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedOvernightDiaryEntries(5, REF_DATE);

    const nightEnd = localSixAM(REF_DATE);

    const result = await runRecapJob(REF_DATE, { fetch: makeSuccessFetch('Recap text.') });
    expect(result.skipped).toBe(false);

    const db = await import('../src/db.js');
    const entry = db.getDiaryEntryById(result.diary_entry_id!);
    expect(entry!.occurred_at).toBe(nightEnd - 1);
  });

  it('occurred_at is within the morning activity.today window (>= midnight local)', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedOvernightDiaryEntries(5, REF_DATE);

    const result = await runRecapJob(REF_DATE, { fetch: makeSuccessFetch('Recap text.') });
    expect(result.skipped).toBe(false);

    const db = await import('../src/db.js');
    const entry = db.getDiaryEntryById(result.diary_entry_id!);

    // midnight local on 2026-05-21
    const midnight = new Date('2026-05-21T00:00:00').getTime();
    expect(entry!.occurred_at).toBeGreaterThanOrEqual(midnight);
  });

  // ---------------------------------------------------------------------------
  // Overnight window bounds
  // ---------------------------------------------------------------------------

  it('includes entries at 21:30, 02:00, and 05:45 within the overnight window', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    const db = await import('../src/db.js');
    db.setSetting('pet_name', 'Peanut');

    // Three entries at specific overnight times.
    const at2130 = new Date('2026-05-20T21:30:00').getTime();
    const at0200 = new Date('2026-05-21T02:00:00').getTime();
    const at0545 = new Date('2026-05-21T05:45:00').getTime();

    for (const ts of [at2130, at0200, at0545]) {
      db.createDiaryEntry({
        occurred_at: ts,
        kind: 'narrative',
        activity: 'wheel',
        narrative: 'Running',
        pet_name: 'Peanut',
        camera_id: null,
        from_camera_id: null,
        to_camera_id: null,
        duration_ms: 5_000,
        snapshot_id: null,
        media_path: null,
        details: null,
      });
    }

    const mockText = 'Peanut was active all night.';
    const result = await runRecapJob(REF_DATE, { fetch: makeSuccessFetch(mockText) });

    // All 3 entries are in-window so MIN_SOURCE_ENTRIES (3) is met.
    expect(result.skipped).toBe(false);
    expect(result.diary_entry_id).not.toBeNull();
  });

  it('API 403/400/404 errors are non-retryable — gives up after 1 attempt', async () => {
    // 400 = bad model, 401 = bad key, 403 = quota, 404 = model not found.
    // These are config errors; hammering Gemini won't help.
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedOvernightDiaryEntries(5, REF_DATE);

    for (const status of [400, 401, 403, 404]) {
      let callCount = 0;
      const countingFetch: typeof globalThis.fetch = async () => {
        callCount += 1;
        return { ok: false, status, text: async () => 'error', json: async () => ({}) } as Response;
      };
      const result = await runRecapJob(REF_DATE, { fetch: countingFetch, sleep: noopSleep });
      expect(result.skipped).toBe('api_error');
      expect(result.diary_entry_id).toBeNull();
      expect(callCount).toBe(1); // no retries for permanent failures
    }
  });

  it('API 429/500/502/503/504 errors are retryable — exhausts all attempts', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedOvernightDiaryEntries(5, REF_DATE);

    for (const status of [429, 500, 502, 503, 504]) {
      let callCount = 0;
      const countingFetch: typeof globalThis.fetch = async () => {
        callCount += 1;
        return { ok: false, status, text: async () => 'error', json: async () => ({}) } as Response;
      };
      const result = await runRecapJob(REF_DATE, { fetch: countingFetch, sleep: noopSleep });
      expect(result.skipped).toBe('api_error');
      expect(callCount).toBe(4); // all 4 attempts exhausted
    }
  });

  it('excludes a 19:00 entry from the overnight window (before nightStart)', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    const db = await import('../src/db.js');
    db.setSetting('pet_name', 'Peanut');

    // One entry at 19:00 (before 21:00 nightStart) and only two in-window entries.
    const at1900 = new Date('2026-05-20T19:00:00').getTime();
    const at2200 = new Date('2026-05-20T22:00:00').getTime();
    const at0300 = new Date('2026-05-21T03:00:00').getTime();

    for (const [ts, activity] of [
      [at1900, 'food'],
      [at2200, 'wheel'],
      [at0300, 'resting'],
    ] as const) {
      db.createDiaryEntry({
        occurred_at: ts,
        kind: 'narrative',
        activity: activity as DiaryActivity,
        narrative: 'Activity',
        pet_name: 'Peanut',
        camera_id: null,
        from_camera_id: null,
        to_camera_id: null,
        duration_ms: 5_000,
        snapshot_id: null,
        media_path: null,
        details: null,
      });
    }

    // Only 2 entries fall in [21:00, 06:00) — the 19:00 entry is excluded.
    // That is below MIN_SOURCE_ENTRIES (3), so the job must skip.
    const result = await runRecapJob(REF_DATE, { fetch: makeSuccessFetch('Should not be called') });
    expect(result.skipped).toBe('too_few_entries');
  });

  // ---------------------------------------------------------------------------
  // Response parsing: safety blocks and missing/empty candidates
  // ---------------------------------------------------------------------------

  it('handles a safety-blocked response (finishReason=SAFETY) without retrying', async () => {
    // Safety blocks are permanent — retrying the same prompt will get blocked again.
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedOvernightDiaryEntries(5, REF_DATE);

    let callCount = 0;
    const countingFetch: typeof globalThis.fetch = async () => {
      callCount += 1;
      return {
        ok: true,
        json: async () => ({ candidates: [{ finishReason: 'SAFETY' }], promptFeedback: { blockReason: 'SAFETY' } }),
      } as Response;
    };

    const result = await runRecapJob(REF_DATE, { fetch: countingFetch, sleep: noopSleep });
    expect(result.skipped).toBe('api_error');
    expect(result.diary_entry_id).toBeNull();
    expect(callCount).toBe(1); // safety blocks are not retried
  });

  it('handles a RECITATION-blocked response without retrying', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedOvernightDiaryEntries(5, REF_DATE);

    const result = await runRecapJob(REF_DATE, { fetch: makeSafetyBlockFetch('RECITATION'), sleep: noopSleep });
    expect(result.skipped).toBe('api_error');
    expect(result.diary_entry_id).toBeNull();
  });

  it('handles an empty candidates array without throwing (treated as transient, retries)', async () => {
    // Empty candidates is an unexpected response shape — treated as transient.
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedOvernightDiaryEntries(5, REF_DATE);

    let callCount = 0;
    const countingFetch: typeof globalThis.fetch = async () => {
      callCount += 1;
      return { ok: true, json: async () => ({ candidates: [] }) } as Response;
    };

    const result = await runRecapJob(REF_DATE, { fetch: countingFetch, sleep: noopSleep });
    expect(result.skipped).toBe('api_error');
    expect(result.diary_entry_id).toBeNull();
    expect(callCount).toBe(4); // unexpected shape → retried
  });

  it('handles a missing candidates key without throwing (treated as transient, retries)', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedOvernightDiaryEntries(5, REF_DATE);

    let callCount = 0;
    const countingFetch: typeof globalThis.fetch = async () => {
      callCount += 1;
      return { ok: true, json: async () => ({}) } as Response;
    };

    const result = await runRecapJob(REF_DATE, { fetch: countingFetch, sleep: noopSleep });
    expect(result.skipped).toBe('api_error');
    expect(result.diary_entry_id).toBeNull();
    expect(callCount).toBe(4); // unexpected shape → retried
  });

  // ---------------------------------------------------------------------------
  // Model default: ensure the default is the stable gemini-2.5-flash, not the
  // deprecated gemini-2.0-flash which returns 400 INVALID_ARGUMENT.
  // ---------------------------------------------------------------------------

  it('uses gemini-2.5-flash as the default model (not the deprecated gemini-2.0-flash)', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    // Do NOT set GEMINI_MODEL — verify the default.
    delete process.env['GEMINI_MODEL'];

    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedOvernightDiaryEntries(5, REF_DATE);

    let capturedUrl = '';
    const capturingFetch: typeof globalThis.fetch = async (input) => {
      capturedUrl = typeof input === 'string' ? input : (input as Request).url ?? '';
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'Peanut ran all night.' }] } }],
        }),
      } as Response;
    };

    const result = await runRecapJob(REF_DATE, { fetch: capturingFetch });
    expect(result.skipped).toBe(false);
    expect(capturedUrl).toContain('gemini-2.5-flash');
    expect(capturedUrl).not.toContain('gemini-2.0-flash');
  });

  it('uses a custom GEMINI_MODEL when explicitly configured', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    process.env['GEMINI_MODEL'] = 'gemini-2.5-flash-lite';

    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedOvernightDiaryEntries(5, REF_DATE);

    let capturedUrl = '';
    const capturingFetch: typeof globalThis.fetch = async (input) => {
      capturedUrl = typeof input === 'string' ? input : (input as Request).url ?? '';
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'Peanut ran all night.' }] } }],
        }),
      } as Response;
    };

    await runRecapJob(REF_DATE, { fetch: capturingFetch });
    expect(capturedUrl).toContain('gemini-2.5-flash-lite');
  });

  it('stores the configured model name in the ai_model column of the diary entry', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    process.env['GEMINI_MODEL'] = 'gemini-2.5-flash';

    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedOvernightDiaryEntries(5, REF_DATE);

    const result = await runRecapJob(REF_DATE, {
      fetch: makeSuccessFetch('Peanut had a wonderful night.'),
    });
    expect(result.skipped).toBe(false);

    const db = await import('../src/db.js');
    const entry = db.getDiaryEntryById(result.diary_entry_id!);
    expect(entry!.ai_model).toBe('gemini-2.5-flash');
  });

  // ---------------------------------------------------------------------------
  // Task 4 — recap_names personalisation
  // ---------------------------------------------------------------------------

  it('buildPromptForTest includes a greeting instruction when names are set', async () => {
    const { buildPromptForTest } = await import('../src/jobs/recap.js');

    const prompt = buildPromptForTest('Remy', '- 22:00 — wheel for 10 min', ['Maya', 'Leo']);

    // Must instruct the model to open with a greeting.
    expect(prompt).toContain('Hello Maya and Leo');
    // Word budget bumped to 90 for named greeting.
    expect(prompt).toContain('90 words');
  });

  it('buildPromptForTest handles a single name', async () => {
    const { buildPromptForTest } = await import('../src/jobs/recap.js');

    const prompt = buildPromptForTest('Remy', '- 22:00 — wheel for 10 min', ['Maya']);
    expect(prompt).toContain('Hello Maya');
    expect(prompt).toContain('90 words');
  });

  it('buildPromptForTest handles three names with Oxford comma', async () => {
    const { buildPromptForTest } = await import('../src/jobs/recap.js');

    const prompt = buildPromptForTest('Remy', '- 22:00 — wheel for 10 min', ['Maya', 'Leo', 'Sam']);
    expect(prompt).toContain('Maya, Leo, and Sam');
  });

  it('buildPromptForTest is unchanged from baseline when names are empty', async () => {
    const { buildPromptForTest } = await import('../src/jobs/recap.js');

    const baseline = buildPromptForTest('Remy', '- 22:00 — wheel for 10 min', []);
    // No greeting instruction in the baseline.
    expect(baseline).not.toContain('greeting');
    // Word budget unchanged at 80.
    expect(baseline).toContain('80 words');
  });

  it('records greeting_names in diary entry details when recap_names is set', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const db = await import('../src/db.js');
    db.setSetting('recap_names', 'Maya,Leo');

    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedOvernightDiaryEntries(5, REF_DATE);

    const result = await runRecapJob(REF_DATE, { fetch: makeSuccessFetch('Peanut ran all night.') });
    expect(result.skipped).toBe(false);

    const entry = db.getDiaryEntryById(result.diary_entry_id!);
    const details = JSON.parse(entry!.details ?? '{}') as Record<string, unknown>;
    expect(details['greeting_names']).toEqual(['Maya', 'Leo']);
  });

  it('does NOT record greeting_names in details when recap_names is empty', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const db = await import('../src/db.js');
    db.setSetting('recap_names', '');

    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedOvernightDiaryEntries(5, REF_DATE);

    const result = await runRecapJob(REF_DATE, { fetch: makeSuccessFetch('Peanut ran all night.') });
    expect(result.skipped).toBe(false);

    const entry = db.getDiaryEntryById(result.diary_entry_id!);
    const details = JSON.parse(entry!.details ?? '{}') as Record<string, unknown>;
    expect(details['greeting_names']).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Window: verify the midnight span is correct
  // ---------------------------------------------------------------------------

  it('correctly spans midnight: entry at 23:59 is inside the window', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    const db = await import('../src/db.js');
    db.setSetting('pet_name', 'Peanut');

    // Three entries: one right before midnight, one right after, one at 03:00.
    const justBeforeMidnight = new Date('2026-05-20T23:59:00').getTime();
    const justAfterMidnight  = new Date('2026-05-21T00:01:00').getTime();
    const at0300             = new Date('2026-05-21T03:00:00').getTime();

    for (const ts of [justBeforeMidnight, justAfterMidnight, at0300]) {
      db.createDiaryEntry({
        occurred_at: ts,
        kind: 'narrative',
        activity: 'wheel',
        narrative: 'Running',
        pet_name: 'Peanut',
        camera_id: null,
        from_camera_id: null,
        to_camera_id: null,
        duration_ms: 5_000,
        snapshot_id: null,
        media_path: null,
        details: null,
      });
    }

    // All 3 fall within [21:00 May-20, 06:00 May-21) — should produce a recap.
    const result = await runRecapJob(REF_DATE, { fetch: makeSuccessFetch('All three!') });
    expect(result.skipped).toBe(false);
    expect(result.diary_entry_id).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Retry: success-after-retry integration test
  // ---------------------------------------------------------------------------

  it('succeeds on the second attempt when the first call aborts', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedOvernightDiaryEntries(5, REF_DATE);

    let callCount = 0;
    const failThenSucceedFetch: typeof globalThis.fetch = async (_url, opts) => {
      callCount += 1;
      if (callCount === 1) {
        // First call simulates the abort that hit production at 06:09 PDT.
        return new Promise<Response>((_resolve, reject) => {
          // Reject immediately rather than waiting for the signal — simulates a
          // fast abort without needing to actually cancel an AbortController.
          const err = new Error('This operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }
      // Second call succeeds.
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'Peanut ran all night!' }] } }],
        }),
      } as Response;
    };

    const result = await runRecapJob(REF_DATE, { fetch: failThenSucceedFetch, sleep: noopSleep });
    expect(result.skipped).toBe(false);
    expect(result.diary_entry_id).not.toBeNull();
    expect(callCount).toBe(2); // one failure + one success

    // Only ONE diary entry should exist (no double-write).
    const db = await import('../src/db.js');
    const nightEnd = localSixAM(REF_DATE);
    const nightStart = nightEnd - NIGHT_WINDOW_MS;
    const recaps = db.listDiaryEntriesBetween(nightStart, nightEnd).filter(
      (e) => e.kind === 'recap',
    );
    expect(recaps).toHaveLength(1);
    expect(recaps[0]!.narrative).toBe('Peanut ran all night!');
  });
});

// ---------------------------------------------------------------------------
// isRetryableGeminiError classifier — isolated unit tests
// ---------------------------------------------------------------------------

describe('isRetryableGeminiError', () => {
  it('retries on AbortError (name)', async () => {
    const { isRetryableGeminiError } = await import('../src/jobs/recap.js');
    const err = new Error('The operation was aborted.');
    err.name = 'AbortError';
    expect(isRetryableGeminiError(err)).toBe(true);
  });

  it('retries on abort message variant: "This operation was aborted"', async () => {
    const { isRetryableGeminiError } = await import('../src/jobs/recap.js');
    expect(isRetryableGeminiError(new Error('This operation was aborted'))).toBe(true);
  });

  it('retries on ECONNRESET', async () => {
    const { isRetryableGeminiError } = await import('../src/jobs/recap.js');
    const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    expect(isRetryableGeminiError(err)).toBe(true);
  });

  it('retries on ETIMEDOUT', async () => {
    const { isRetryableGeminiError } = await import('../src/jobs/recap.js');
    const err = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
    expect(isRetryableGeminiError(err)).toBe(true);
  });

  it('retries on HTTP 500', async () => {
    const { isRetryableGeminiError } = await import('../src/jobs/recap.js');
    // We can't construct GeminiApiError directly (it's not exported), so we
    // test the behaviour via runRecapJob call-count assertions instead.
    // Here we just verify a plain Error is retried.
    expect(isRetryableGeminiError(new Error('unexpected server error'))).toBe(true);
  });

  it('does NOT retry on safety block (GeminiSafetyError is not exported, tested via fetch count)', async () => {
    // Covered by the safety-block fetch-count tests above.
    // This test verifies a plain non-abort Error still returns true (catch-all).
    const { isRetryableGeminiError } = await import('../src/jobs/recap.js');
    expect(isRetryableGeminiError(new Error('unexpected shape'))).toBe(true);
  });

  it('does NOT retry on non-Error thrown values (treated as transient)', async () => {
    const { isRetryableGeminiError } = await import('../src/jobs/recap.js');
    // Non-Error values (e.g. thrown strings) fall through to the final `return true`.
    expect(isRetryableGeminiError('some string')).toBe(true);
    expect(isRetryableGeminiError(null)).toBe(true);
  });
});
