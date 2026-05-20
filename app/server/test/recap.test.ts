// Tests for jobs/recap.ts
// Verifies: skip when no API key, skip when too few entries, write on success,
// idempotent replace on re-run, handle API failure without throwing.

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

async function seedDiaryEntries(count: number): Promise<void> {
  const db = await import('../src/db.js');
  db.setSetting('pet_name', 'Peanut');
  const base = new Date('2026-05-20T10:00:00').getTime();
  const activities: DiaryActivity[] = ['wheel', 'food', 'water', 'resting', 'exploring'];
  for (let i = 0; i < count; i += 1) {
    db.createDiaryEntry({
      occurred_at: base + i * 60_000,
      kind: 'narrative',
      activity: activities[i % activities.length] ?? 'exploring',
      narrative: `Entry ${i}`,
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

function makeErrorFetch(status: number): typeof globalThis.fetch {
  return async () => {
    return { ok: false, status, json: async () => ({}) } as Response;
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

// Fixed target date for all tests.
const TARGET_DATE = new Date('2026-05-20T23:58:00');

/** Mirrors the startOfLocalDay helper in jobs/recap.ts. */
function startOfLocalDay(d: Date): number {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy.getTime();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runRecapJob', () => {
  it('skips cleanly when GEMINI_API_KEY is not set', async () => {
    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedDiaryEntries(5);

    const result = await runRecapJob(TARGET_DATE, { fetch: makeSuccessFetch('Should not be called') });
    expect(result.skipped).toBe('no_api_key');
    expect(result.diary_entry_id).toBeNull();

    const db = await import('../src/db.js');
    const start = startOfLocalDay(TARGET_DATE);
    const entries = db.listDiaryEntriesBetween(start, start + 86_400_000);
    expect(entries.filter((e) => e.kind === 'recap')).toHaveLength(0);
  });

  it('skips when there are fewer than 3 source entries', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedDiaryEntries(2);

    const result = await runRecapJob(TARGET_DATE, { fetch: makeSuccessFetch('Should not be called') });
    expect(result.skipped).toBe('too_few_entries');
    expect(result.diary_entry_id).toBeNull();
  });

  it('writes a recap diary entry when the API returns text', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedDiaryEntries(5);

    const mockText = 'Peanut had a wonderful day exploring and running on the wheel.';
    const result = await runRecapJob(TARGET_DATE, { fetch: makeSuccessFetch(mockText) });

    expect(result.skipped).toBe(false);
    expect(result.diary_entry_id).not.toBeNull();

    const db = await import('../src/db.js');
    const entry = db.getDiaryEntryById(result.diary_entry_id!);
    expect(entry).not.toBeNull();
    expect(entry!.kind).toBe('recap');
    expect(entry!.activity).toBe('recap');
    expect(entry!.narrative).toBe(mockText);
    expect(entry!.ai_model).toBe('gemini-2.0-flash');
  });

  it('replaces the existing recap row on re-run (idempotent)', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedDiaryEntries(5);

    const first = await runRecapJob(TARGET_DATE, { fetch: makeSuccessFetch('First recap text.') });
    expect(first.skipped).toBe(false);

    const second = await runRecapJob(TARGET_DATE, { fetch: makeSuccessFetch('Updated recap text.') });
    expect(second.skipped).toBe(false);

    const db = await import('../src/db.js');
    const start = startOfLocalDay(TARGET_DATE);
    const recaps = db.listDiaryEntriesBetween(start, start + 86_400_000).filter(
      (e) => e.kind === 'recap',
    );
    expect(recaps).toHaveLength(1);
    expect(recaps[0]!.narrative).toBe('Updated recap text.');
  });

  it('handles API 500 error without throwing', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedDiaryEntries(5);

    const result = await runRecapJob(TARGET_DATE, { fetch: makeErrorFetch(500) });
    expect(result.skipped).toBe('api_error');
    expect(result.diary_entry_id).toBeNull();
  });

  it('handles network timeout without throwing', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    await seedDiaryEntries(5);

    const result = await runRecapJob(TARGET_DATE, { fetch: makeAbortingFetch() });
    expect(result.skipped).toBe('api_error');
    expect(result.diary_entry_id).toBeNull();
  }, 30_000);

  it('recap entry sorts above timelapse (occurred_at = dayEnd - 2)', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const { runRecapJob } = await import('../src/jobs/recap.js');
    const db = await import('../src/db.js');
    await seedDiaryEntries(5);

    const dayStart = startOfLocalDay(TARGET_DATE);
    const dayEnd = dayStart + 86_400_000;
    db.createDiaryEntry({
      occurred_at: dayEnd - 1,
      kind: 'timelapse',
      activity: 'timelapse',
      narrative: 'Timelapse',
      pet_name: 'Peanut',
      camera_id: null,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: null,
      snapshot_id: null,
      media_path: null,
      details: null,
    });

    const result = await runRecapJob(TARGET_DATE, { fetch: makeSuccessFetch('Recap text.') });
    expect(result.skipped).toBe(false);

    const entry = db.getDiaryEntryById(result.diary_entry_id!);
    expect(entry!.occurred_at).toBe(dayEnd - 2);
  });
});
