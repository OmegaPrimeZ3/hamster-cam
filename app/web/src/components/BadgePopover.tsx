// app/web/src/components/BadgePopover.tsx
//
// Polls `badges.earned` and fires confetti on any newly-earned badge.
// Confetti respects prefers-reduced-motion (no animation, just a toast).
//
// The toast auto-dismisses after 4s. If two badges land at once, the toast
// queues them.

import { useEffect, useRef, useState } from 'react';
import confetti from 'canvas-confetti';
import { trpc } from '../trpc';

const BADGE_META: Record<string, { emoji: string; label: string }> = {
  marathon_runner: { emoji: '🥇', label: 'Marathon Runner' },
  foodie: { emoji: '🍽️', label: 'Foodie' },
  night_owl: { emoji: '🌙', label: 'Night Owl' },
  early_bird: { emoji: '🌅', label: 'Early Bird' },
  first_day: { emoji: '🎉', label: 'First Day' },
  memory_keeper: { emoji: '📸', label: 'Memory Keeper' },
  hat_trick: { emoji: '🏆', label: 'Hat Trick' },
};

function metaFor(id: string): { emoji: string; label: string } {
  return BADGE_META[id] ?? { emoji: '🏅', label: id };
}

export function BadgePopover(): JSX.Element | null {
  const badges = trpc.badges.earned.useQuery(undefined, {
    refetchInterval: 20_000,
  });
  const seenRef = useRef<Set<string> | null>(null);
  const [queue, setQueue] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    if (!badges.data) return;
    if (seenRef.current === null) {
      seenRef.current = new Set(badges.data.map((b) => b.badge_id));
      return;
    }
    const fresh: string[] = [];
    for (const b of badges.data) {
      if (!seenRef.current.has(b.badge_id)) {
        fresh.push(b.badge_id);
        seenRef.current.add(b.badge_id);
      }
    }
    if (fresh.length) setQueue((q) => [...q, ...fresh]);
  }, [badges.data]);

  useEffect(() => {
    if (active || queue.length === 0) return undefined;
    const next = queue[0]!;
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
        /* canvas-confetti can throw if a renderer isn't available; harmless */
      }
    }
    const t = window.setTimeout(() => setActive(null), 4000);
    return () => window.clearTimeout(t);
  }, [active, queue]);

  if (!active) return null;
  const meta = metaFor(active);

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
      <span aria-hidden style={{ fontSize: 22 }}>{meta.emoji}</span>
      <span>New badge — {meta.label}!</span>
    </div>
  );
}
