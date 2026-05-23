// app/web/test/activity-style.test.ts
//
// Unit tests for the currentStatusLine helper added to activity-style.ts.
// This is pure logic — no React, no network.

import { describe, it, expect } from 'vitest';
import { currentStatusLine } from '../src/lib/activity-style';

describe('currentStatusLine', () => {
  it('returns the live wheel line when fresh', () => {
    const line = currentStatusLine({
      petName: 'Remy',
      activity: 'wheel',
      stale: false,
      sinceMs: 5000,
    });
    expect(line.emoji).toBe('🎡');
    expect(line.text).toMatch(/Remy is running on the wheel/i);
  });

  it('returns the food snack line when fresh', () => {
    const line = currentStatusLine({
      petName: 'Peanut',
      activity: 'food',
      stale: false,
      sinceMs: 3000,
    });
    expect(line.emoji).toBe('🥕');
    expect(line.text).toMatch(/Peanut is having a snack/i);
  });

  it('returns stale fallback with activity + sinceMs', () => {
    const line = currentStatusLine({
      petName: 'Remy',
      activity: 'wheel',
      stale: true,
      sinceMs: 4 * 60_000, // 4 min
    });
    expect(line.emoji).toBe('🎡');
    expect(line.text).toMatch(/Remy was last at the wheel/);
    expect(line.text).toMatch(/4 min ago/);
  });

  it('returns quiet-time fallback when stale + no activity', () => {
    const line = currentStatusLine({
      petName: 'Remy',
      activity: null,
      stale: true,
      sinceMs: null,
    });
    expect(line.emoji).toBe('😴');
    expect(line.text).toMatch(/Remy is having quiet time/i);
  });

  it('falls back to "Your pet" when petName is empty', () => {
    const line = currentStatusLine({
      petName: '',
      activity: null,
      stale: true,
      sinceMs: null,
    });
    expect(line.text).toMatch(/Your pet is having quiet time/i);
  });

  it('returns sinceMs < 1 min as "just now"', () => {
    const line = currentStatusLine({
      petName: 'Remy',
      activity: 'hiding',
      stale: true,
      sinceMs: 20_000, // 20 seconds
    });
    expect(line.text).toMatch(/just now/i);
  });

  it('returns "1 min ago" for sinceMs around 60 seconds', () => {
    const line = currentStatusLine({
      petName: 'Remy',
      activity: 'resting',
      stale: true,
      sinceMs: 70_000, // ~1.17 min
    });
    expect(line.text).toMatch(/1 min ago/i);
  });

  it('covers all eight activity types without throwing', () => {
    const activities = [
      'wheel', 'food', 'water', 'bathroom',
      'resting', 'tunnel', 'exploring', 'hiding',
    ] as const;
    for (const activity of activities) {
      expect(() =>
        currentStatusLine({ petName: 'Remy', activity, stale: false, sinceMs: 1000 }),
      ).not.toThrow();
    }
  });
});
