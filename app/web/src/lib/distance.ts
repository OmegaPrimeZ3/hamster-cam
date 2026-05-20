// app/web/src/lib/distance.ts
//
// Formats a raw meter count into a human-readable distance string using
// either imperial (ft / mi) or metric (m / km) units.
//
// Imperial:
//   < 0.1 mi  → "X ft"          (whole feet, no decimals)
//   ≥ 0.1 mi  → "X.XX mi"       (2 decimal places)
//
// Metric:
//   < 100 m   → "X m"           (whole meters, no decimals)
//   ≥ 100 m   → "X.XX km"       (2 decimal places)

const METERS_PER_MILE = 1609.344;
const FEET_PER_METER = 3.28084;
const THRESHOLD_MI = 0.1;
const THRESHOLD_M = 100;

export function formatMeters(meters: number, unit: 'mi' | 'km'): string {
  if (!Number.isFinite(meters) || meters < 0) return '0 m';

  if (unit === 'mi') {
    const miles = meters / METERS_PER_MILE;
    if (miles < THRESHOLD_MI) {
      const feet = Math.round(meters * FEET_PER_METER);
      return `${feet} ft`;
    }
    return `${miles.toFixed(2)} mi`;
  }

  // km
  if (meters < THRESHOLD_M) {
    return `${Math.round(meters)} m`;
  }
  return `${(meters / 1000).toFixed(2)} km`;
}
