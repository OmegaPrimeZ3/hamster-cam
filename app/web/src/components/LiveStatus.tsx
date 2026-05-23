// app/web/src/components/LiveStatus.tsx
//
// "Where's Remy right now?" banner.
//
// Polls pet.currentStatus every 12 seconds. Renders a warm, kid-friendly
// one-liner above the camera grid. Respects prefers-reduced-motion (no
// pulse animation on the pip when reduced). Both roles see this — no gate.
//
// Stale handling:
//   stale: false + activity known  → live line, e.g. "Remy is running on the wheel! 🎡"
//   stale: true  + last activity   → fallback, e.g. "Remy was last at the wheel · 4 min ago"
//   stale: true  + nothing known   → "Remy is having quiet time 😴"
//   loading / error                → graceful skeleton / silent fail (no visible error to kids)

import { useReducedMotion } from 'framer-motion';
import { trpc } from '../trpc';
import { currentStatusLine, type LiveActivity } from '../lib/activity-style';

interface LiveStatusProps {
  petName: string;
}

export function LiveStatus({ petName }: LiveStatusProps): JSX.Element {
  const reduced = useReducedMotion();

  const status = trpc.pet.currentStatus.useQuery(undefined, {
    refetchInterval: 12_000,
    // Stale time slightly below the refetch interval so we always show fresh data.
    staleTime: 10_000,
  });

  // Loading skeleton — a subtle shimmer line so layout doesn't jump.
  if (status.isLoading) {
    return <StatusBar emoji="🐹" text="Checking on your pet…" pip={false} reduced={!!reduced} />;
  }

  // On error: silent degradation — show the quiet-time fallback rather than an
  // alarming error message in a kid-facing UI.
  const data = status.data;
  if (!data) {
    return <StatusBar emoji="😴" text={`${petName || 'Your pet'} is having quiet time`} pip={false} reduced={!!reduced} />;
  }

  // The server's activity type is the subset that matches LiveActivity exactly —
  // both use the same set of eight zone activities. The cast is safe because the
  // server's Zod schema for pet.currentStatus restricts activity to those eight
  // values (or null).
  const line = currentStatusLine({
    petName,
    activity: data.activity as LiveActivity | null,
    stale: data.stale,
    sinceMs: data.sinceMs,
  });

  // Show a live pip only when the sighting is fresh (not stale).
  const showPip = !data.stale && data.activity !== null;

  return <StatusBar emoji={line.emoji} text={line.text} pip={showPip} reduced={!!reduced} />;
}

// ---------------------------------------------------------------------------
// Presentational primitive — exported so tests can render it without tRPC
// ---------------------------------------------------------------------------

export interface StatusBarProps {
  emoji: string;
  text: string;
  /** Whether to show the pulsing live pip */
  pip: boolean;
  reduced: boolean;
}

export function StatusBar({ emoji, text, pip, reduced }: StatusBarProps): JSX.Element {
  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 16px',
        background: 'color-mix(in srgb, var(--accent) 8%, var(--surface))',
        border: '1px solid color-mix(in srgb, var(--accent) 25%, var(--border))',
        borderRadius: 16,
        fontFamily: "'Fredoka', sans-serif",
        fontWeight: 600,
        fontSize: 18,
        color: 'var(--text)',
        lineHeight: 1.3,
      }}
    >
      {pip && (
        <span
          aria-hidden
          style={{
            display: 'inline-block',
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: 'var(--success, #4ade80)',
            flexShrink: 0,
            // Pulsing ring animation — suppressed under reduced-motion.
            boxShadow: reduced
              ? undefined
              : '0 0 0 0 rgba(74, 222, 128, 0.5)',
            animation: reduced ? undefined : 'hc-pulse 1.8s ease-out infinite',
          }}
        />
      )}
      <span aria-hidden style={{ fontSize: 22, lineHeight: 1, flexShrink: 0 }}>
        {emoji}
      </span>
      <span>{text}</span>
    </div>
  );
}
