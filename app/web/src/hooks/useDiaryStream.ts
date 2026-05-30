// app/web/src/hooks/useDiaryStream.ts
//
// Subscribes to the server's `/diary/stream` SSE feed and merges incoming
// entries into the active `activity.range` React Query cache so the diary
// updates in real time without waiting for the 30-second poll.
//
// Reconnect strategy: EventSource natively reconnects at ~3 s. We layer a
// custom exponential-backoff manager on top so that 503s (server connection-
// cap) don't hammer the server. After each error event we close the current
// connection and reopen after a delay that doubles up to MAX_BACKOFF_MS.
// On a successful first message the backoff counter resets to the base delay.
//
// Same-origin XHR-style auth: EventSource sends the session cookie
// automatically because the SSE URL is same-origin (Caddy in prod, Vite proxy
// in dev — see vite.config.ts → `/diary` proxy entry).

import { useEffect, useRef } from 'react';

import { trpc } from '../trpc';
import type { RouterOutputs } from '../trpc';

type Entry = RouterOutputs['activity']['range'][number];

const BASE_BACKOFF_MS = 3_000;
const MAX_BACKOFF_MS = 60_000;

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
  // backoff delay accumulates across reconnect attempts; resets on any
  // successful message so a stable connection gets the fast path again.
  const backoffRef = useRef<number>(BASE_BACKOFF_MS);

  useEffect(() => {
    // SSR / Node test env guard — jsdom provides EventSource via polyfill in
    // some setups but not all. If absent we silently fall back to polling.
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;

    let es: EventSource | null = null;
    let retryTimeoutId: number | null = null;
    let unmounted = false;

    function connect(): void {
      if (unmounted) return;
      es = new EventSource('/diary/stream');

      const applyEntry = (raw: string, mode: 'create' | 'update'): void => {
        let parsed: Entry;
        try {
          parsed = JSON.parse(raw) as Entry;
        } catch {
          return;
        }
        // Reset backoff on any successful message — connection is healthy.
        backoffRef.current = BASE_BACKOFF_MS;

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

      const onEntry = (e: MessageEvent): void => applyEntry(e.data as string, 'create');
      const onEntryUpdate = (e: MessageEvent): void => applyEntry(e.data as string, 'update');

      es.addEventListener('entry', onEntry);
      es.addEventListener('entry-update', onEntryUpdate);

      // On error (network blip, 503 connection-cap, deploy): close the native
      // EventSource and schedule a manual reconnect with exponential backoff so
      // we don't hammer a capped server at 3-second intervals.
      es.onerror = (): void => {
        es?.removeEventListener('entry', onEntry);
        es?.removeEventListener('entry-update', onEntryUpdate);
        es?.close();
        es = null;

        if (unmounted) return;
        const delay = backoffRef.current;
        backoffRef.current = Math.min(delay * 2, MAX_BACKOFF_MS);
        retryTimeoutId = window.setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      unmounted = true;
      if (retryTimeoutId !== null) window.clearTimeout(retryTimeoutId);
      es?.close();
    };
  }, [from, to, utils]);
}
