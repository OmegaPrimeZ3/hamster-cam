// app/web/src/components/BadgePopover.tsx
//
// Polls `badges.earned` and fires confetti on any newly-earned or re-earned
// badge. "Re-earn" is detected when a badge's count increases OR its
// last_earned_at advances — so earning the same daily badge on a new day
// re-toasts correctly.
//
// On the very first data load we seed the baseline without toasting (we don't
// want to toast for badges already earned before the page opened).
//
// The toast auto-dismisses after 4s. Multiple badges arriving at once are
// queued and shown one at a time. Confetti is suppressed under
// prefers-reduced-motion; the toast still appears.

import { useEffect, useRef, useState } from 'react';
import confetti from 'canvas-confetti';
import { trpc } from '../trpc';
import { badgeMeta, type BadgeEarned } from '../badges';

/** Snapshot of what we've seen for a badge, used to detect re-earns. */
interface SeenEntry {
  count: number;
  last_earned_at: number;
}

export function BadgePopover(): JSX.Element | null {
  const { data } = trpc.badges.earned.useQuery(undefined, {
    refetchInterval: 20_000,
  });
  const badges: BadgeEarned[] = data ?? [];

  // Map badge_id → last seen { count, last_earned_at }. Null means "not yet
  // seeded" (first load). Once seeded, future increases trigger a toast.
  const seenRef = useRef<Map<string, SeenEntry> | null>(null);
  const [queue, setQueue] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;

    if (seenRef.current === null) {
      // First load — seed the baseline, no toasting.
      const baseline = new Map<string, SeenEntry>();
      for (const b of badges) {
        baseline.set(b.badge_id, {
          count: b.count,
          last_earned_at: b.last_earned_at,
        });
      }
      seenRef.current = baseline;
      return;
    }

    const fresh: string[] = [];
    for (const b of badges) {
      const prev = seenRef.current.get(b.badge_id);
      if (
        prev === undefined ||
        b.count > prev.count ||
        b.last_earned_at > prev.last_earned_at
      ) {
        fresh.push(b.badge_id);
      }
      // Always update seen state so the next poll compares correctly.
      seenRef.current.set(b.badge_id, {
        count: b.count,
        last_earned_at: b.last_earned_at,
      });
    }
    if (fresh.length > 0) {
      setQueue((q) => [...q, ...fresh]);
    }
  // badges is a derived cast — `data` is the stable React Query reference.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(() => {
    if (active || queue.length === 0) return undefined;
    const next = queue[0];
    if (!next) return undefined;
    setActive(next);
    setQueue((q) => q.slice(1));

    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (!reduced) {
      try {
        confetti({
          particleCount: 80,
          spread: 70,
          origin: { y: 0.4 },
          scalar: 0.9,
        });
      } catch {
        /* canvas-confetti can throw if a renderer is unavailable; harmless */
      }
    }

    const t = window.setTimeout(() => setActive(null), 4000);
    return () => window.clearTimeout(t);
  }, [active, queue]);

  if (!active) return null;

  const meta = badgeMeta(active);
  const emoji = meta?.emoji ?? '🏅';
  const label = meta?.label ?? active;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        top: 18,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 70,
        padding: '12px 18px',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 999,
        boxShadow: '0 18px 36px rgba(0,0,0,0.18)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        fontWeight: 600,
      }}
    >
      <span aria-hidden style={{ fontSize: 22 }}>{emoji}</span>
      <span>New badge — {label}!</span>
    </div>
  );
}
