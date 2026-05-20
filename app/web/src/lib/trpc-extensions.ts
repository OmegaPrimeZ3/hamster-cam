// app/web/src/lib/trpc-extensions.ts
//
// Helpers that sit on top of typed tRPC outputs:
//   - parseWheelMeters: pulls wheel_meters out of a diary entry's details JSON.
//   - getDistanceUnit: extracts the distance_unit field with a default fallback.
//
// All procedure calls live in the components themselves via the typed
// `trpc.*` proxy — no shimming needed since the backend router now exposes
// activity.range, cameras.testWheelDetection, and settings.distance_unit.

import type { RouterOutputs } from '../trpc';

type DiaryEntry = RouterOutputs['activity']['today'][number];

export type DistanceUnit = 'mi' | 'km';

export function parseWheelMeters(entry: DiaryEntry): number | null {
  if (!entry.details) return null;
  try {
    const parsed: unknown = JSON.parse(entry.details);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'wheel_meters' in parsed
    ) {
      const v = (parsed as Record<string, unknown>)['wheel_meters'];
      return typeof v === 'number' && v > 0 ? v : null;
    }
    return null;
  } catch {
    return null;
  }
}

export function getDistanceUnit(
  settings: { distance_unit?: DistanceUnit } | null | undefined,
): DistanceUnit {
  return settings?.distance_unit === 'km' ? 'km' : 'mi';
}
