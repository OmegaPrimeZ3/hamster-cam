// app/web/src/components/StatsStrip.tsx
//
// The Today stats scoreboard per PLAN §5.4. Three rounded tiles — wheel time,
// snack visits, restful ratio — rendered side by side (wrapping on narrow
// viewports). Wheel emoji spins faster the more the hamster ran; reduced-
// motion users see a static wheel.

import { TRPCClientError } from '@trpc/client';
import { useReducedMotion } from 'framer-motion';
import type { AppRouter } from '@hamster-cam/server/trpc';
import { trpc } from '../trpc';

export function StatsStrip(): JSX.Element {
  const reduced = useReducedMotion();
  const stats = trpc.stats.today.useQuery(undefined, {
    refetchInterval: 60_000,
  });

  if (stats.isLoading) {
    return (
      <Scoreboard>
        <Tile label="MIN ON WHEEL" emoji="🎡" number="…" />
        <Tile label="SNACKS" emoji="🥕" number="…" />
        <Tile label="RESTFUL" emoji="💤" number="…" />
      </Scoreboard>
    );
  }

  if (stats.error) {
    const e = stats.error as TRPCClientError<AppRouter>;
    // Stats aren't ready (Stage 2a hasn't shipped the aggregator yet) —
    // surface a friendly, transparent placeholder rather than an alarming
    // toast.
    if (e.data?.code === 'NOT_IMPLEMENTED' || e.data?.code === 'INTERNAL_SERVER_ERROR') {
      return (
        <Scoreboard>
          <FallbackTile text="🏆 Today's stats arriving soon!" />
        </Scoreboard>
      );
    }
  }

  const data = stats.data;
  if (!data) {
    return (
      <Scoreboard>
        <FallbackTile text="🐾 No activity yet today" />
      </Scoreboard>
    );
  }

  const wheelMinutes = Math.round(data.wheel_ms / 60_000);
  const restfulPct = Math.round(data.restful_ratio * 100);
  const spinSeconds = reduced ? null : wheelSpinSeconds(data.wheel_ms);

  return (
    <Scoreboard>
      <Tile
        label="MIN ON WHEEL"
        emoji="🎡"
        number={wheelMinutes}
        emojiSpinSeconds={spinSeconds}
      />
      <Tile label="SNACKS" emoji="🥕" number={data.snack_visits} />
      <Tile label="RESTFUL" emoji="💤" number={`${restfulPct}%`} />
    </Scoreboard>
  );
}

/**
 * Map total wheel time today → emoji spin period (seconds). Faster spin when
 * the hamster ran more. Clamped to a sane range (0.6s – 6s) so the animation
 * never looks frozen or seizure-inducing.
 *
 *   0 ms wheel       → 6 s (slowest)
 *   60 min (3.6e6)   → ~0.6 s (fastest)
 */
function wheelSpinSeconds(wheelMs: number): number {
  const MIN = 0.6;
  const MAX = 6;
  if (wheelMs <= 0) return MAX;
  const minutes = wheelMs / 60_000;
  // Linear interp from 0 → 60+ minutes onto MAX → MIN.
  const t = Math.min(1, minutes / 60);
  const speed = MAX - t * (MAX - MIN);
  return Math.max(MIN, Math.min(MAX, speed));
}

function Scoreboard({ children }: { children: React.ReactNode }): JSX.Element {
  // Inline the @keyframes once per render — scoped to this component via a
  // unique class so we don't pollute index.css (another track owns it).
  return (
    <section
      aria-label="Today's stats"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 10,
      }}
    >
      <style>{`
        @keyframes hc-stats-wheel-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
      {children}
    </section>
  );
}

interface TileProps {
  label: string;
  emoji: string;
  number: number | string;
  /** When set, the emoji spins with this period (seconds). */
  emojiSpinSeconds?: number | null;
}

function Tile({ label, emoji, number, emojiSpinSeconds }: TileProps): JSX.Element {
  const emojiStyle: React.CSSProperties = {
    fontSize: 24,
    lineHeight: 1,
    display: 'inline-block',
  };
  if (emojiSpinSeconds != null) {
    emojiStyle.animation = `hc-stats-wheel-spin ${emojiSpinSeconds}s linear infinite`;
    // Spinning emojis can blur in dark mode; nudge the rendering hint.
    emojiStyle.willChange = 'transform';
  }

  return (
    <div
      style={{
        flex: '1 1 140px',
        minHeight: 104,
        padding: 14,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 16,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span
          className="display"
          style={{ fontFamily: "'Fredoka', sans-serif", fontSize: 36, lineHeight: 1 }}
        >
          {number}
        </span>
        <span aria-hidden style={emojiStyle}>{emoji}</span>
      </div>
      <span
        style={{
          fontSize: 12,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--text-muted)',
          fontWeight: 600,
        }}
      >
        {label}
      </span>
    </div>
  );
}

function FallbackTile({ text }: { text: string }): JSX.Element {
  return (
    <div
      style={{
        flex: '1 1 100%',
        minHeight: 104,
        padding: 14,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 16,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        fontWeight: 500,
        color: 'var(--text-muted)',
      }}
    >
      {text}
    </div>
  );
}
