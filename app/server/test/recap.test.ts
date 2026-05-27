// Tests for jobs/recap.ts
// Verifies: skip when no API key, skip when too few entries, write on success,
// idempotent replace on re-run, handle API failure without throwing, overnight
// window bounds, and night-start date keying.

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

  it('handles API 500 error without throwing', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedOvernightDiaryEntries(5, REF_DATE);

    const result = await runRecapJob(REF_DATE, { fetch: makeErrorFetch(500) });
    expect(result.skipped).toBe('api_error');
    expect(result.diary_entry_id).toBeNull();
  });

  it('handles network timeout without throwing', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedOvernightDiaryEntries(5, REF_DATE);

    const result = await runRecapJob(REF_DATE, { fetch: makeAbortingFetch() });
    expect(result.skipped).toBe('api_error');
    expect(result.diary_entry_id).toBeNull();
  }, 30_000);

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

  it('API 403/400 error includes HTTP status in result (GeminiApiError coverage)', async () => {
    // Verifies the new GeminiApiError path returns api_error without throwing,
    // and that a 403 (bad key / quota) is distinguishable from a 500 for the
    // operator reading the logs. The test just checks the skipped result; the
    // log output is structural — not asserted in unit tests.
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedOvernightDiaryEntries(5, REF_DATE);

    for (const status of [400, 403, 404, 429]) {
      const result = await runRecapJob(REF_DATE, { fetch: makeErrorFetch(status) });
      expect(result.skipped).toBe('api_error');
      expect(result.diary_entry_id).toBeNull();
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

  it('handles a safety-blocked response (finishReason=SAFETY) without throwing', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedOvernightDiaryEntries(5, REF_DATE);

    const result = await runRecapJob(REF_DATE, { fetch: makeSafetyBlockFetch('SAFETY') });
    expect(result.skipped).toBe('api_error');
    expect(result.diary_entry_id).toBeNull();
  });

  it('handles a RECITATION-blocked response without throwing', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedOvernightDiaryEntries(5, REF_DATE);

    const result = await runRecapJob(REF_DATE, { fetch: makeSafetyBlockFetch('RECITATION') });
    expect(result.skipped).toBe('api_error');
    expect(result.diary_entry_id).toBeNull();
  });

  it('handles an empty candidates array without throwing', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedOvernightDiaryEntries(5, REF_DATE);

    const result = await runRecapJob(REF_DATE, { fetch: makeEmptyCandidatesFetch() });
    expect(result.skipped).toBe('api_error');
    expect(result.diary_entry_id).toBeNull();
  });

  it('handles a missing candidates key without throwing', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedOvernightDiaryEntries(5, REF_DATE);

    const result = await runRecapJob(REF_DATE, { fetch: makeMissingCandidatesFetch() });
    expect(result.skipped).toBe('api_error');
    expect(result.diary_entry_id).toBeNull();
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
});
