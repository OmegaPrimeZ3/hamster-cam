// app/web/src/lib/time.ts
//
// Tiny relative-time formatter that reads like a kid's book.
// "just now", "5 minutes ago", "this morning", "last night", "2 days ago".

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function relativeTime(at: number, now: number = Date.now()): string {
  const diff = now - at;
  if (diff < 30_000) return 'just now';
  if (diff < HOUR) {
    const m = Math.max(1, Math.round(diff / MIN));
    return m === 1 ? '1 minute ago' : `${m} minutes ago`;
  }

  const atDate = new Date(at);
  const nowDate = new Date(now);
  const sameDay = atDate.toDateString() === nowDate.toDateString();
  if (sameDay) {
    const h = atDate.getHours();
    if (h < 5) return 'last night';
    if (h < 12) return 'this morning';
    if (h < 17) return 'this afternoon';
    return 'this evening';
  }

  const yesterday = new Date(nowDate);
  yesterday.setDate(yesterday.getDate() - 1);
  if (atDate.toDateString() === yesterday.toDateString()) return 'yesterday';

  const days = Math.floor(diff / DAY);
  if (days < 7) return `${days} days ago`;
  return atDate.toLocaleDateString();
}

/**
 * Absolute timestamp for a diary entry — paired with relativeTime so the
 * reader gets the friendly read AND the precise wall-clock time. Examples:
 *   "Tue, May 27, 3:14 PM"     (within the current year)
 *   "May 27, 2024, 3:14 PM"    (a prior year — weekday dropped, year added)
 *
 * `now` is injectable for tests; defaults to wall-clock so the year-drop
 * heuristic uses the real current year.
 */
export function absoluteTime(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleString(undefined, {
    ...(sameYear ? { weekday: 'short' } : { year: 'numeric' }),
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatDuration(ms: number): string {
  if (ms < MIN) {
    const s = Math.max(1, Math.round(ms / 1000));
    return `${s}s`;
  }
  const m = Math.round(ms / MIN);
  return m === 1 ? '1 min' : `${m} min`;
}
