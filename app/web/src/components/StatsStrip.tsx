// app/web/src/components/StatsStrip.tsx
//
// The Today stats strip per PLAN §5.4. Three pills: wheel time, snack visits,
// restful ratio. Real data from `stats.today`.

import { TRPCClientError } from '@trpc/client';
import type { AppRouter } from '@hamster-cam/server/trpc';
import { trpc } from '../trpc';

export function StatsStrip(): JSX.Element {
  const stats = trpc.stats.today.useQuery(undefined, {
    refetchInterval: 60_000,
  });

  if (stats.isLoading) {
    return <Strip>{[
      { id: 'wheel', text: '🏆 Wheel: …' },
      { id: 'food', text: '🥕 Snacks: …' },
      { id: 'sleep', text: '💤 Sleep: …' },
    ]}</Strip>;
  }

  if (stats.error) {
    const e = stats.error as TRPCClientError<AppRouter>;
    // Stats aren't ready (Stage 2a hasn't shipped the aggregator yet) —
    // surface a friendly, transparent placeholder rather than an alarming
    // toast. This is also the empty-day state.
    if (e.data?.code === 'NOT_IMPLEMENTED' || e.data?.code === 'INTERNAL_SERVER_ERROR') {
      return (
        <Strip>
          {[
            { id: 'wheel', text: '🏆 Today\'s stats arriving soon!' },
          ]}
        </Strip>
      );
    }
  }

  const data = stats.data;
  if (!data) return <Strip>{[{ id: 'empty', text: '🐾 No activity yet today.' }]}</Strip>;

  const wheelMinutes = Math.round(data.wheel_ms / 60_000);
  const restfulPct = Math.round(data.restful_ratio * 100);

  return (
    <Strip>
      {[
        { id: 'wheel', text: `🏆 ${wheelMinutes} min wheel` },
        { id: 'food', text: `🥕 ${data.snack_visits} snacks` },
        { id: 'sleep', text: `💤 ${restfulPct}% restful` },
      ]}
    </Strip>
  );
}

interface StripItem {
  id: string;
  text: string;
}

function Strip({ children }: { children: StripItem[] }): JSX.Element {
  return (
    <section
      aria-label="Today's stats"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        padding: 8,
        background: 'var(--surface-raised)',
        border: '1px solid var(--border)',
        borderRadius: 14,
      }}
    >
      {children.map((item) => (
        <span key={item.id} className="hc-chip" style={{ fontSize: 15, padding: '8px 14px' }}>
          {item.text}
        </span>
      ))}
    </section>
  );
}
