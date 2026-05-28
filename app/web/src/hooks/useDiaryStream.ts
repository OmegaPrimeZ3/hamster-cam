// app/web/src/hooks/useDiaryStream.ts
//
// Subscribes to the server's `/diary/stream` SSE feed and merges incoming
// entries into the active `activity.range` React Query cache so the diary
// updates in real time without waiting for the 30-second poll.
//
// EventSource handles auto-reconnect (default: 3 s) natively, so we only need
// to wire setup/teardown. Polling on the consumer query stays in place as a
// belt-and-braces fallback for anything missed between disconnect and
// reconnect.
//
// Same-origin XHR-style auth: EventSource sends the session cookie
// automatically because the SSE URL is same-origin (Caddy in prod, Vite proxy
// in dev — see vite.config.ts → `/diary` proxy entry).

import { useEffect } from 'react';

import { trpc } from '../trpc';
import type { RouterOutputs } from '../trpc';

type Entry = RouterOutputs['activity']['range'][number];

export interface UseDiaryStreamArgs {
  /** Active range — must match the key used by `trpc.activity.range.useQuery`. */
  from: number;
  to: number;
}

/**
 * Merge an incoming SSE entry into the React Query cache for the active range.
 *
 * - `entry` (create): prepend when the entry falls inside [from, to). The
 *   final sort order is owned by the consumer component (Diary.tsx) — we just
 *   ensure the row is present so the consumer's useEffect can pick it up.
 * - `entry-update` (extend): replace the existing row in place if present;
 *   if not present (range mismatch), no-op.
 *
 * The consumer's `setQueryData` returns a new array reference so React Query
 * notifies subscribers. We never mutate the existing array in place.
 */
export function useDiaryStream({ from, to }: UseDiaryStreamArgs): void {
  const utils = trpc.useUtils();

  useEffect(() => {
    // SSR / Node test env guard — jsdom provides EventSource via polyfill in
    // some setups but not all. If absent we silently fall back to polling.
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;

    const es = new EventSource('/diary/stream');

    const applyEntry = (raw: string, mode: 'create' | 'update'): void => {
      let parsed: Entry;
      try {
        parsed = JSON.parse(raw) as Entry;
      } catch {
        return;
      }

      // Range filter: only touch the cache for entries that belong here.
      // Updates to out-of-range entries are ignored — the next refetch will
      // catch any cross-boundary edge case.
      if (parsed.occurred_at < from || parsed.occurred_at >= to) {
        if (mode === 'create') return;
      }

      utils.activity.range.setData({ from, to }, (prev) => {
        const current = prev ?? [];
        const existingIdx = current.findIndex((e) => e.id === parsed.id);
        if (existingIdx >= 0) {
          // In-place replace so Diary.tsx's sort step re-renders with the new
          // occurred_at / duration.
          const next = current.slice();
          next[existingIdx] = parsed;
          return next;
        }
        if (mode === 'update') return current;
        // Prepend; Diary.tsx applies its own sort weight afterwards.
        return [parsed, ...current];
      });
    };

    const onEntry = (e: MessageEvent): void => applyEntry(e.data, 'create');
    const onEntryUpdate = (e: MessageEvent): void => applyEntry(e.data, 'update');

    es.addEventListener('entry', onEntry);
    es.addEventListener('entry-update', onEntryUpdate);

    // EventSource handles its own reconnection backoff. We only log here so a
    // total failure (e.g. backend down) is visible while developing.
    es.onerror = (): void => {
      // EventSource.readyState === 2 (CLOSED) means it gave up; the polling
      // fallback in the consumer query keeps the UI fresh in that case.
    };

    return () => {
      es.removeEventListener('entry', onEntry);
      es.removeEventListener('entry-update', onEntryUpdate);
      es.close();
    };
  }, [from, to, utils]);
}
