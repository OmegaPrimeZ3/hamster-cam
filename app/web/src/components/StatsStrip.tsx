// app/web/src/components/StatsStrip.tsx
//
// The Today stats scoreboard. The server returns one entry per zone the
// operator has wired up across their cameras (or, on a brand-new install,
// whatever activities have shown up today). We render one tile per returned
// zone, sharing colour + emoji vocabulary with DiaryEntry so the scoreboard
// and the diary read as the same world.
//
// The wheel tile still spins — faster when the hamster ran more, frozen
// under reduced-motion. Other activities sit still; we can add per-activity
// micro-animations later if there's a reason.

import { TRPCClientError } from '@trpc/client';
import { useReducedMotion } from 'framer-motion';
import type { AppRouter } from '@hamster-cam/server/trpc';
import { trpc } from '../trpc';
import {
  activityStyle,
  isZoneActivity,
  zoneMetric,
  type ZoneActivity,
} from '../lib/activity-style';

interface ZoneTileData {
  activity: ZoneActivity;
  count: number;
  total_ms: number;
}

export function StatsStrip(): JSX.Element {
  const reduced = useReducedMotion();
  const stats = trpc.stats.today.useQuery(undefined, {
    refetchInterval: 60_000,
  });

  if (stats.isLoading) {
    // We don't know N before the query lands, so render three generic
    // placeholders using common activities — enough to fill the strip
    // without flashing a different layout the moment data arrives.
    return (
      <Scoreboard>
        <PlaceholderTile activity="wheel" />
        <PlaceholderTile activity="food" />
        <PlaceholderTile activity="resting" />
      </Scoreboard>
    );
  }

  if (stats.error) {
    const e = stats.error as TRPCClientError<AppRouter>;
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

  // Narrow server's broader DiaryActivity union down to ZoneActivity. The
  // statsRouter only ever returns zone-eligible activities, but the d.ts type
  // is the wider DiaryActivity — narrow at the boundary, don't cast.
  const zones: ZoneTileData[] = data.zones.flatMap((z) =>
    isZoneActivity(z.activity)
      ? [{ activity: z.activity, count: z.count, total_ms: z.total_ms }]
      : [],
  );

  if (zones.length === 0) {
    return (
      <Scoreboard>
        <FallbackTile text="🐾 Configure zones on your cameras in Settings → Cameras to see today's scoreboard." />
      </Scoreboard>
    );
  }

  // Find the wheel tile (if present) so we can scale its spin to today's
  // wheel time. Brief calls out wheel as the only activity with motion.
  const wheelZone = zones.find((z) => z.activity === 'wheel');
  const wheelSpin = reduced || !wheelZone ? null : wheelSpinSeconds(wheelZone.total_ms);

  return (
    <Scoreboard>
      {zones.map((zone) => (
        <ZoneTile
          key={zone.activity}
          zone={zone}
          spinSeconds={zone.activity === 'wheel' ? wheelSpin : null}
        />
      ))}
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
  const t = Math.min(1, minutes / 60);
  const speed = MAX - t * (MAX - MIN);
  return Math.max(MIN, Math.min(MAX, speed));
}

function Scoreboard({ children }: { children: React.ReactNode }): JSX.Element {
  // Inline the @keyframes so we don't have to touch index.css. Scoped name
  // (hc-stats-wheel-spin) so it can't collide with anything else.
  return (
    <section
      aria-label="Today's stats"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
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

interface ZoneTileProps {
  zone: ZoneTileData;
  /** When set, the emoji spins with this period (seconds). Wheel-only. */
  spinSeconds: number | null;
}

function ZoneTile({ zone, spinSeconds }: ZoneTileProps): JSX.Element {
  const style = activityStyle(zone.activity);
  const metric = zoneMetric(zone.activity);
  const isDuration = metric.primaryMetric === 'duration';
  const value = isDuration ? Math.round(zone.total_ms / 60_000) : zone.count;

  const emojiStyle: React.CSSProperties = {
    fontSize: 24,
    lineHeight: 1,
    display: 'inline-block',
  };
  if (spinSeconds != null) {
    emojiStyle.animation = `hc-stats-wheel-spin ${spinSeconds}s linear infinite`;
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
        // 4px inset left stripe in the activity accent — same technique
        // DiaryEntry uses so the two surfaces visibly belong together.
        boxShadow: `inset 4px 0 0 0 ${style.accent}`,
        paddingLeft: 18, // make room for the stripe
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        gap: 8,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <span
          className="display"
          style={{ fontFamily: "'Fredoka', sans-serif", fontSize: 36, lineHeight: 1 }}
        >
          {value}
          {isDuration && (
            <span
              style={{
                fontSize: 14,
                marginLeft: 4,
                color: 'var(--text-muted)',
                fontWeight: 500,
              }}
            >
              min
            </span>
          )}
        </span>
        <span aria-hidden style={emojiStyle}>
          {style.badgeEmoji}
        </span>
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
        {metric.unitLabel}
      </span>
    </div>
  );
}

function PlaceholderTile({ activity }: { activity: ZoneActivity }): JSX.Element {
  const style = activityStyle(activity);
  const metric = zoneMetric(activity);
  return (
    <div
      style={{
        flex: '1 1 140px',
        minHeight: 104,
        padding: 14,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 16,
        boxShadow: `inset 4px 0 0 0 ${style.accent}`,
        paddingLeft: 18,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        gap: 8,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <span
          className="display"
          style={{ fontFamily: "'Fredoka', sans-serif", fontSize: 36, lineHeight: 1 }}
        >
          …
        </span>
        <span aria-hidden style={{ fontSize: 24, lineHeight: 1, display: 'inline-block' }}>
          {style.badgeEmoji}
        </span>
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
        {metric.unitLabel}
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
