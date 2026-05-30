// app/web/test/time.test.ts
//
// Tests for absoluteTime() locale + timezone pinning.

import { describe, expect, it } from 'vitest';
import { absoluteTime } from '../src/lib/time';

// A known UTC epoch: 2026-05-27T23:14:00Z
// In America/Los_Angeles (UTC-7 in PDT) that is:
//   2026-05-27 16:14 PDT → "Wed, May 27, 4:14 PM"
const KNOWN_EPOCH_MS = new Date('2026-05-27T23:14:00Z').getTime();

// A date in a prior year for the "year shown, weekday dropped" branch.
// 2024-05-27T23:14:00Z → 2024-05-27 16:14 PDT
const PRIOR_YEAR_EPOCH_MS = new Date('2024-05-27T23:14:00Z').getTime();

// "now" pinned to a 2026 date so the same-year heuristic works deterministically.
const NOW_IN_2026 = new Date('2026-06-01T00:00:00Z').getTime();

describe('absoluteTime — en-US + America/Los_Angeles', () => {
  it('returns an en-US formatted string for a same-year date', () => {
    const result = absoluteTime(KNOWN_EPOCH_MS, NOW_IN_2026);
    // en-US format: "Wed, May 27, 4:14 PM" (PDT = UTC-7)
    expect(result).toMatch(/May 27/);
    expect(result).toMatch(/4:14/);
    expect(result).toMatch(/PM/);
    // Should include weekday abbreviation (same year)
    expect(result).toMatch(/Wed/);
  });

  it('includes the year and omits the weekday for a prior-year date', () => {
    const result = absoluteTime(PRIOR_YEAR_EPOCH_MS, NOW_IN_2026);
    // Prior year → year shown, weekday omitted
    expect(result).toMatch(/2024/);
    expect(result).not.toMatch(/Wed/);
    expect(result).toMatch(/May 27/);
  });

  it('uses LA timezone, not UTC (hour differs by 7)', () => {
    // UTC hour is 23; LA (PDT, UTC-7) hour is 16
    const result = absoluteTime(KNOWN_EPOCH_MS, NOW_IN_2026);
    // Should show 4 PM, not 11 PM UTC
    expect(result).toMatch(/4:14 PM/);
    expect(result).not.toMatch(/11:14 PM/);
  });

  it('does not contain Japanese or non-ASCII characters', () => {
    const result = absoluteTime(KNOWN_EPOCH_MS, NOW_IN_2026);
    // Must be pure ASCII (en-US locale guarantee)
    expect(result).toMatch(/^[\x20-\x7E,:\s]*$/);
  });
});
