// app/web/src/components/StatsStrip.tsx
//
// Compact chip strip — one pill per zone the operator wired up across their
// cameras (or whatever activities the day produced when nothing is yet
// configured). Each chip's emoji has a per-activity micro-animation
// (wheel spins, food nibbles, water drips, bathroom wobbles, resting breathes,
// tunnel shimmers, exploring magnifies, hiding peeks). Tapping a chip
// expands a detail panel below the strip with count + total time + average.
//
// The wheel spin period scales inversely with today's wheel time so a
// hard-running hamster spins faster. Every animation is killed under
// prefers-reduced-motion via framer-motion's useReducedMotion().

import { useState } from 'react';
import { TRPCClientError } from '@trpc/client';
import { motion, useReducedMotion, type MotionProps } from 'framer-motion';
import type { AppRouter } from '@hamster-cam/server/trpc';
import { trpc } from '../trpc';
import {
  activityStyle,
  isZoneActivity,
  zoneMetric,
  type ZoneActivity,
} from '../lib/activity-style';
import { parseWheelMeters, getDistanceUnit } from '../lib/trpc-extensions';
import { formatMeters } from '../lib/distance';

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
  const settings = trpc.settings.get.useQuery();
  const distanceUnit = getDistanceUnit(settings.data);

  // Last 7 days: from midnight 7 days ago to now.
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const weekRange = trpc.activity.range.useQuery(
    { from: sevenDaysAgo, to: now },
    { refetchInterval: 5 * 60_000 },
  );

  const [active, setActive] = useState<ZoneActivity | null>(null);

  if (stats.isLoading) {
    return (
      <Scoreboard>
        <ChipRow>
          <PlaceholderChip />
          <PlaceholderChip />
          <PlaceholderChip />
          <PlaceholderChip />
        </ChipRow>
      </Scoreboard>
    );
  }

  if (stats.error) {
    const e = stats.error as TRPCClientError<AppRouter>;
    if (e.data?.code === 'NOT_IMPLEMENTED' || e.data?.code === 'INTERNAL_SERVER_ERROR') {
      return (
        <Scoreboard>
          <FallbackBanner text="🏆 Today's stats arriving soon!" />
        </Scoreboard>
      );
    }
  }

  const data = stats.data;
  if (!data) {
    return (
      <Scoreboard>
        <FallbackBanner text="🐾 No activity yet today" />
      </Scoreboard>
    );
  }

  const zones: ZoneTileData[] = data.zones.flatMap((z) =>
    isZoneActivity(z.activity)
      ? [{ activity: z.activity, count: z.count, total_ms: z.total_ms }]
      : [],
  );

  if (zones.length === 0) {
    return (
      <Scoreboard>
        <FallbackBanner text="🐾 Configure zones on your cameras in Settings → Cameras to see today's scoreboard." />
      </Scoreboard>
    );
  }

  const wheelZone = zones.find((z) => z.activity === 'wheel');
  const wheelSpin = reduced || !wheelZone ? null : wheelSpinSeconds(wheelZone.total_ms);
  const activeZone = active ? zones.find((z) => z.activity === active) ?? null : null;

  // Compute weekly distance from the range query — defensive: skip entries
  // where details is missing or wheel_meters is absent/zero.
  const weeklyMeters: number = (weekRange.data ?? [])
    .filter((e) => e.activity === 'wheel')
    .reduce((sum, e) => {
      const m = parseWheelMeters(e);
      return m !== null ? sum + m : sum;
    }, 0);

  return (
    <Scoreboard>
      <ChipRow>
        {zones.map((zone) => (
          <ZoneChip
            key={zone.activity}
            zone={zone}
            wheelSpinSec={zone.activity === 'wheel' ? wheelSpin : null}
            reduced={!!reduced}
            selected={active === zone.activity}
            onToggle={() => setActive((cur) => (cur === zone.activity ? null : zone.activity))}
          />
        ))}
        {/* Distance tile — always rendered when a wheel zone exists, even if
            odometry isn't yet configured (shows "—" so the layout is stable). */}
        {wheelZone && (
          <DistanceTile
            meters={weeklyMeters}
            distanceUnit={distanceUnit}
            isLoading={weekRange.isLoading}
          />
        )}
      </ChipRow>
      {activeZone && (
        <DetailPanel zone={activeZone} onClose={() => setActive(null)} />
      )}
    </Scoreboard>
  );
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

function Scoreboard({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <section
      aria-label="Today's stats"
      style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      {children}
    </section>
  );
}

function ChipRow({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        // Centred when the row fits; scrolls from the left edge when it
        // overflows (browsers respect justify-content: center alongside
        // overflow-x: auto, so this is the cleanest "fit-or-scroll" pattern).
        justifyContent: 'center',
        flexWrap: 'nowrap',
        overflowX: 'auto',
        scrollSnapType: 'x mandatory',
        // Negative margin + padding lets chips bleed to the screen edge while
        // keeping focus rings from being clipped.
        margin: '0 -4px',
        padding: '2px 4px 4px',
        WebkitOverflowScrolling: 'touch',
        scrollbarWidth: 'thin',
      }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Zone chip
// ---------------------------------------------------------------------------

interface ZoneChipProps {
  zone: ZoneTileData;
  wheelSpinSec: number | null;
  reduced: boolean;
  selected: boolean;
  onToggle: () => void;
}

function ZoneChip({ zone, wheelSpinSec, reduced, selected, onToggle }: ZoneChipProps): JSX.Element {
  const style = activityStyle(zone.activity);
  const metric = zoneMetric(zone.activity);
  const isDuration = metric.primaryMetric === 'duration';
  const value = isDuration ? Math.round(zone.total_ms / 60_000) : zone.count;
  const valueText = isDuration ? `${value}m` : `${value}`;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      aria-label={`${metric.label}: ${value} ${metric.unitLabel.toLowerCase()}`}
      style={{
        flex: '0 0 auto',
        scrollSnapAlign: 'start',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        minHeight: 44,
        padding: '6px 14px',
        borderRadius: 999,
        background: selected
          ? style.accent
          : `color-mix(in srgb, ${style.accent} 14%, var(--surface))`,
        color: selected ? '#fff' : 'var(--text)',
        border: `1.5px solid ${selected ? style.accent : `color-mix(in srgb, ${style.accent} 40%, transparent)`}`,
        boxShadow: selected ? `0 4px 12px color-mix(in srgb, ${style.accent} 35%, transparent)` : 'none',
        fontFamily: "'Fredoka', sans-serif",
        fontWeight: 600,
        fontSize: 16,
        cursor: 'pointer',
        transition: reduced ? undefined : 'background 140ms ease, box-shadow 140ms ease, color 140ms ease',
      }}
    >
      <motion.span aria-hidden style={{ fontSize: 20, lineHeight: 1, display: 'inline-block' }} {...emojiAnimation(zone.activity, wheelSpinSec, reduced)}>
        {style.badgeEmoji}
      </motion.span>
      <span style={{ fontSize: 13, fontWeight: 500, opacity: 0.8, letterSpacing: '0.01em' }}>
        {metric.label}
      </span>
      <span>{valueText}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Detail panel — appears under the strip when a chip is tapped.
// ---------------------------------------------------------------------------

function DetailPanel({ zone, onClose }: { zone: ZoneTileData; onClose: () => void }): JSX.Element {
  const style = activityStyle(zone.activity);
  const metric = zoneMetric(zone.activity);
  const minutes = Math.round(zone.total_ms / 60_000);
  const avgMs = zone.count > 0 ? Math.round(zone.total_ms / zone.count) : 0;
  const avgMin = Math.round(avgMs / 60_000);
  const hasDuration = zone.total_ms > 0;

  const primary =
    metric.primaryMetric === 'duration'
      ? `${minutes} min today`
      : `${zone.count} ${plural(zone.count, metric.label.toLowerCase())} today`;

  const subStats: string[] = [];
  if (metric.primaryMetric === 'duration') {
    subStats.push(`${zone.count} ${plural(zone.count, 'visit')}`);
    if (zone.count > 1 && hasDuration) subStats.push(`avg ${avgMin} min per visit`);
  } else if (hasDuration) {
    subStats.push(`${minutes} min total`);
    if (zone.count > 1) {
      const avgSec = Math.round(avgMs / 1000);
      subStats.push(`avg ${avgSec}s per visit`);
    }
  }

  return (
    <div
      role="region"
      aria-label={`${metric.label} details`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 14,
        boxShadow: `inset 4px 0 0 0 ${style.accent}`,
        paddingLeft: 18,
      }}
    >
      <span aria-hidden style={{ fontSize: 28, lineHeight: 1 }}>{style.badgeEmoji}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: "'Fredoka', sans-serif", fontWeight: 600, fontSize: 16 }}>
          {metric.label} — {primary}
        </div>
        {subStats.length > 0 && (
          <small style={{ color: 'var(--text-muted)' }}>{subStats.join(' · ')}</small>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close details"
        className="hc-btn hc-btn-ghost"
        style={{ minHeight: 36, padding: '0 10px' }}
      >
        ✕
      </button>
    </div>
  );
}

function plural(n: number, word: string): string {
  if (n === 1) return word;
  if (word.endsWith('y')) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

// ---------------------------------------------------------------------------
// Loading / empty fallbacks
// ---------------------------------------------------------------------------

function PlaceholderChip(): JSX.Element {
  return (
    <div
      aria-hidden
      style={{
        flex: '0 0 auto',
        minHeight: 44,
        padding: '6px 14px',
        borderRadius: 999,
        background: 'var(--surface-raised)',
        border: '1.5px solid var(--border)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        color: 'var(--text-muted)',
        fontFamily: "'Fredoka', sans-serif",
        fontWeight: 600,
        fontSize: 16,
      }}
    >
      <span style={{ fontSize: 20, lineHeight: 1, opacity: 0.6 }}>🐾</span>
      <span>…</span>
    </div>
  );
}

function FallbackBanner({ text }: { text: string }): JSX.Element {
  return (
    <div
      style={{
        padding: '10px 14px',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 14,
        textAlign: 'center',
        color: 'var(--text-muted)',
        fontWeight: 500,
      }}
    >
      {text}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Distance tile — a static chip showing weekly wheel distance.
// ---------------------------------------------------------------------------

interface DistanceTileProps {
  meters: number;
  distanceUnit: 'mi' | 'km';
  isLoading: boolean;
}

function DistanceTile({ meters, distanceUnit, isLoading }: DistanceTileProps): JSX.Element {
  const value = meters > 0 ? formatMeters(meters, distanceUnit) : '—';
  return (
    <div
      aria-label={`Distance this week: ${value}`}
      style={{
        flex: '0 0 auto',
        scrollSnapAlign: 'start',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        minHeight: 44,
        padding: '6px 14px',
        borderRadius: 999,
        background: 'color-mix(in srgb, #4FB3E0 14%, var(--surface))',
        color: 'var(--text)',
        border: '1.5px solid color-mix(in srgb, #4FB3E0 40%, transparent)',
        fontFamily: "'Fredoka', sans-serif",
        fontWeight: 600,
        fontSize: 16,
      }}
    >
      <span aria-hidden style={{ fontSize: 20, lineHeight: 1 }}>🏃</span>
      <span style={{ fontSize: 13, fontWeight: 500, opacity: 0.8, letterSpacing: '0.01em' }}>
        This week
      </span>
      <span style={{ opacity: isLoading ? 0.5 : 1 }}>{isLoading ? '…' : value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-activity emoji animations — each one is a small character moment that
// makes the strip feel alive. All loop forever, all freeze under reduced
// motion. Wheel takes a dynamic duration so it spins faster when the hamster
// ran more (matches the previous behaviour, now via framer-motion instead of
// CSS keyframes — one animation system across the board).
// ---------------------------------------------------------------------------

function emojiAnimation(
  activity: ZoneActivity,
  wheelSpinSec: number | null,
  reduced: boolean,
): MotionProps {
  if (reduced) return {};
  switch (activity) {
    case 'wheel':
      // Variable spin period — capped at 6s when idle, down to 0.6s when busy.
      return {
        animate: { rotate: 360 },
        transition: { duration: wheelSpinSec ?? 6, repeat: Infinity, ease: 'linear' },
      };
    case 'food':
      // Carrot nibble — quick bob with a tiny rotational sway.
      return {
        animate: { y: [0, -3, 0, 2, 0], rotate: [0, -6, 0, 6, 0] },
        transition: { duration: 1.6, repeat: Infinity, ease: 'easeInOut' },
      };
    case 'water':
      // Drop falling — squish on impact, recover.
      return {
        animate: { y: [0, 3, 0], scale: [1, 1.12, 1] },
        transition: { duration: 1.8, repeat: Infinity, ease: 'easeInOut' },
      };
    case 'bathroom':
      // Gentle wobble — toilet seat humour without being undignified.
      return {
        animate: { rotate: [0, 6, -6, 0] },
        transition: { duration: 2.2, repeat: Infinity, ease: 'easeInOut' },
      };
    case 'resting':
      // Sleepy breathing — slow scale + opacity sway.
      return {
        animate: { scale: [1, 1.08, 1], opacity: [0.75, 1, 0.75] },
        transition: { duration: 2.6, repeat: Infinity, ease: 'easeInOut' },
      };
    case 'tunnel':
      // Tunnel shimmer — sideways nudge with a slight pulse.
      return {
        animate: { x: [0, 3, -3, 0], scale: [1, 0.95, 1.05, 1] },
        transition: { duration: 2.4, repeat: Infinity, ease: 'easeInOut' },
      };
    case 'exploring':
      // Magnifying glass scan — rotate sweep.
      return {
        animate: { rotate: [0, -14, 14, 0] },
        transition: { duration: 1.8, repeat: Infinity, ease: 'easeInOut' },
      };
    case 'hiding':
      // Peek-and-duck — a longer pause then a quick scale-down dip.
      return {
        animate: { scale: [1, 1, 0.7, 1, 1], y: [0, 0, 2, 0, 0] },
        transition: { duration: 3.2, repeat: Infinity, ease: 'easeInOut' },
      };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map total wheel time today → emoji spin period (seconds). Faster spin when
 * the hamster ran more. Clamped 0.6s – 6s so the animation never freezes nor
 * becomes seizure-inducing.
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
