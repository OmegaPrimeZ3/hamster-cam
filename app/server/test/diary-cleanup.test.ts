// Unit tests for the diary-cleanup coalescing planner. Pure function over
// rows — no DB needed. Proves the historical backfill matches the live
// narrator rule: same non-wheel activity, consecutive, gap <= 120s.

import { describe, expect, it } from 'vitest';

import type { DiaryEntryRow } from '../src/db.js';
import { planCoalesce, COALESCE_WINDOW_MS } from '../src/diary-cleanup.js';

let nextId = 1;

/** Build a minimal narrative row. `at` is the END time; `durMs` the span. */
function entry(activity: string | null, at: number, durMs = 5_000): DiaryEntryRow {
  return {
    id: nextId++,
    occurred_at: at,
    kind: 'narrative',
    activity: activity as DiaryEntryRow['activity'],
    narrative: '',
    pet_name: null,
    camera_id: null,
    from_camera_id: null,
    to_camera_id: null,
    duration_ms: durMs,
    snapshot_id: null,
    media_path: null,
    details: null,
    ai_model: null,
    created_by: null,
  };
}

const T = 1_700_000_000_000;

describe('planCoalesce', () => {
  it('collapses a run of same-activity entries within the window into one', () => {
    // exploring at T, then again 10s later, then 10s later — all within 120s.
    const rows = [
      entry('exploring', T, 5_000),
      entry('exploring', T + 15_000, 5_000),
      entry('exploring', T + 30_000, 5_000),
    ];
    const plan = planCoalesce(rows);
    expect(plan.deleteIds).toEqual([rows[1]!.id, rows[2]!.id]);
    expect(plan.runsCollapsed).toBe(1);
    expect(plan.updates).toHaveLength(1);
    // Survivor span: start of first (T-5000) → end of last (T+30000).
    expect(plan.updates[0]).toMatchObject({
      id: rows[0]!.id,
      occurred_at: T + 30_000,
      duration_ms: T + 30_000 - (T - 5_000),
    });
  });

  it('does NOT coalesce when the gap exceeds the window', () => {
    const rows = [
      entry('exploring', T, 5_000),
      entry('exploring', T + COALESCE_WINDOW_MS + 10_000, 5_000),
    ];
    const plan = planCoalesce(rows);
    expect(plan.deleteIds).toEqual([]);
    expect(plan.updates).toEqual([]);
  });

  it('never coalesces wheel (each run keeps its odometer distance)', () => {
    const rows = [
      entry('wheel', T, 5_000),
      entry('wheel', T + 10_000, 5_000),
    ];
    const plan = planCoalesce(rows);
    expect(plan.deleteIds).toEqual([]);
  });

  it('does not coalesce across a different intervening activity', () => {
    // exploring, food (breaks the run), exploring — narrator only compares the
    // immediately-preceding entry, so the two explorings stay separate.
    const rows = [
      entry('exploring', T, 5_000),
      entry('food', T + 10_000, 5_000),
      entry('exploring', T + 20_000, 5_000),
    ];
    const plan = planCoalesce(rows);
    expect(plan.deleteIds).toEqual([]);
  });

  it('leaves non-coalescible kinds (snapshot/timelapse/transition/recap) untouched', () => {
    const rows = [
      { ...entry('snapshot', T), kind: 'narrative' as const },
      { ...entry('snapshot', T + 5_000), kind: 'narrative' as const },
      { ...entry('transition', T + 10_000), kind: 'narrative' as const },
      { ...entry('transition', T + 12_000), kind: 'narrative' as const },
    ];
    const plan = planCoalesce(rows);
    expect(plan.deleteIds).toEqual([]);
  });

  it('chains a long run measured gap-to-gap from the growing survivor', () => {
    // Four entries each 100s apart end-to-start — every gap is under 120s, so
    // the whole chain collapses even though first→last spans > window.
    const rows = [
      entry('resting', T, 1_000),
      entry('resting', T + 100_000, 1_000),
      entry('resting', T + 200_000, 1_000),
      entry('resting', T + 300_000, 1_000),
    ];
    const plan = planCoalesce(rows);
    expect(plan.deleteIds).toEqual([rows[1]!.id, rows[2]!.id, rows[3]!.id]);
    expect(plan.updates[0]!.occurred_at).toBe(T + 300_000);
  });
});
