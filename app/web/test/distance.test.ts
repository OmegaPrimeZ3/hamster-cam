// app/web/test/distance.test.ts
//
// Unit tests for formatMeters — covers every boundary case the spec defines.

import { describe, expect, it } from 'vitest';
import { formatMeters } from '../src/lib/distance';

// ---------------------------------------------------------------------------
// Imperial (mi)
// ---------------------------------------------------------------------------

describe('formatMeters — imperial (mi)', () => {
  it('returns "0 ft" for 0 meters', () => {
    expect(formatMeters(0, 'mi')).toBe('0 ft');
  });

  it('returns feet for distances < 0.1 mi (~160.9 m)', () => {
    // 1 meter ≈ 3 ft
    expect(formatMeters(1, 'mi')).toBe('3 ft');
    // 100 meters ≈ 328 ft (well below 0.1 mi threshold)
    expect(formatMeters(100, 'mi')).toBe('328 ft');
  });

  it('boundary: just below 0.1 mi (160.9 m) returns feet', () => {
    const justBelow = 0.09999 * 1609.344; // ~160.92 m
    const result = formatMeters(justBelow, 'mi');
    expect(result).toMatch(/ft$/);
    expect(result).not.toMatch(/mi$/);
  });

  it('boundary: exactly 0.1 mi returns "0.10 mi"', () => {
    expect(formatMeters(0.1 * 1609.344, 'mi')).toBe('0.10 mi');
  });

  it('returns miles with 2 decimals for ≥ 0.1 mi', () => {
    expect(formatMeters(1609.344, 'mi')).toBe('1.00 mi');
    expect(formatMeters(1609.344 * 26.2, 'mi')).toBe('26.20 mi'); // marathon
    expect(formatMeters(1609.344 * 0.5, 'mi')).toBe('0.50 mi');
  });
});

// ---------------------------------------------------------------------------
// Metric (km)
// ---------------------------------------------------------------------------

describe('formatMeters — metric (km)', () => {
  it('returns "0 m" for 0 meters', () => {
    expect(formatMeters(0, 'km')).toBe('0 m');
  });

  it('returns whole meters for distances < 100 m', () => {
    expect(formatMeters(1, 'km')).toBe('1 m');
    expect(formatMeters(99, 'km')).toBe('99 m');
    expect(formatMeters(50.7, 'km')).toBe('51 m');
  });

  it('boundary: exactly 100 m returns "0.10 km"', () => {
    expect(formatMeters(100, 'km')).toBe('0.10 km');
  });

  it('returns km with 2 decimals for ≥ 100 m', () => {
    expect(formatMeters(1000, 'km')).toBe('1.00 km');
    expect(formatMeters(42195, 'km')).toBe('42.20 km'); // marathon
    expect(formatMeters(500, 'km')).toBe('0.50 km');
  });

  it('rounds correctly at the 100m threshold', () => {
    expect(formatMeters(99.4, 'km')).toBe('99 m');
    expect(formatMeters(99.6, 'km')).toBe('100 m');
  });
});

// ---------------------------------------------------------------------------
// Edge / defensive cases
// ---------------------------------------------------------------------------

describe('formatMeters — edge cases', () => {
  it('handles large values without crashing', () => {
    const result = formatMeters(1_000_000, 'km');
    expect(result).toBe('1000.00 km');
  });

  it('handles large values in miles', () => {
    const result = formatMeters(1_609_344, 'mi');
    expect(result).toBe('1000.00 mi');
  });
});
