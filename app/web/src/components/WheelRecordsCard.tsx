// app/web/src/components/WheelRecordsCard.tsx
//
// Wheel personal-records card placed near the StatsStrip.
//
// Queries `stats.wheelRecords` (refetch every 60 s). Shows:
//   - Today / this week / all-time distances in the user's preferred unit
//   - Best day + best session highlights
//   - A 14-day SVG sparkline (sparse series filled with 0 for missing days)
//   - A "New record!" flourish (confetti via the existing BadgePopover pattern)
//     when todayMeters >= bestDayMeters (and today > 0)
//
// Zero charting dependency — the sparkline is a hand-rolled inline SVG polyline.
// Respects prefers-reduced-motion (no confetti when reduced).

import { useEffect, useRef, useState } from 'react';
import confetti from 'canvas-confetti';
import { useReducedMotion } from 'framer-motion';
import { trpc } from '../trpc';
import { formatMeters } from '../lib/distance';
import { getDistanceUnit } from '../lib/trpc-extensions';

// ---------------------------------------------------------------------------
// Pure presentation — exported so tests can render without tRPC
// ---------------------------------------------------------------------------

export interface WheelRecordsData {
  todayMeters: number;
  weekMeters: number;
  allTimeMeters: number;
  bestDayMeters: number;
  bestDayDate: string | null;
  bestSessionMeters: number;
  dailySeries: Array<{ date: string; meters: number }>;
}

export interface WheelRecordsContentProps {
  data: WheelRecordsData;
  distanceUnit: 'mi' | 'km';
  showRecord: boolean;
}

export function WheelRecordsContent({
  data,
  distanceUnit,
  showRecord,
}: WheelRecordsContentProps): JSX.Element {
  const fmt = (m: number): string => formatMeters(m, distanceUnit);

  return (
    <section
      aria-label="Wheel records"
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 18,
        padding: '16px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* New-record flourish */}
      {showRecord && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'absolute',
            top: 12,
            right: 14,
            background: '#FF7AAF',
            color: '#fff',
            borderRadius: 999,
            padding: '4px 12px',
            fontFamily: "'Fredoka', sans-serif",
            fontWeight: 700,
            fontSize: 14,
            zIndex: 2,
          }}
        >
          🏆 New record!
        </div>
      )}

      {/* Header */}
      <div
        style={{
          fontFamily: "'Fredoka', sans-serif",
          fontWeight: 700,
          fontSize: 18,
          color: 'var(--text)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span aria-hidden>🎡</span>
        <span>Wheel Records</span>
      </div>

      {/* Distance chips row */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <DistanceChip label="Today" value={fmt(data.todayMeters)} accent="#FF7AAF" />
        <DistanceChip label="This week" value={fmt(data.weekMeters)} accent="#FFA94D" />
        <DistanceChip label="All time" value={fmt(data.allTimeMeters)} accent="#4FB3E0" />
      </div>

      {/* Best-day + best-session highlights */}
      {(data.bestDayMeters > 0 || data.bestSessionMeters > 0) && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {data.bestDayMeters > 0 && (
            <HighlightChip
              emoji="📅"
              label="Best day"
              value={fmt(data.bestDayMeters)}
              date={data.bestDayDate}
            />
          )}
          {data.bestSessionMeters > 0 && (
            <HighlightChip
              emoji="⚡"
              label="Best session"
              value={fmt(data.bestSessionMeters)}
              date={null}
            />
          )}
        </div>
      )}

      {/* 14-day sparkline */}
      {data.dailySeries.length > 0 && (
        <Sparkline series={data.dailySeries} />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Connected container — fetches data and delegates to WheelRecordsContent
// ---------------------------------------------------------------------------

export function WheelRecordsCard(): JSX.Element | null {
  const reduced = useReducedMotion();

  const records = trpc.stats.wheelRecords.useQuery(undefined, {
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const settings = trpc.settings.get.useQuery(undefined, { staleTime: 60_000 });
  const distanceUnit = getDistanceUnit(settings.data);

  // Track whether we have already fired confetti for the current record so we
  // fire at most once per component-mount lifetime, not on every refetch.
  const recordFiredRef = useRef(false);
  const [showRecord, setShowRecord] = useState(false);

  useEffect(() => {
    if (!records.data) return;
    const { todayMeters, bestDayMeters } = records.data;

    // New day record: today >= all-time best (and there's distance today so we
    // don't celebrate 0 == 0 on a quiet day).
    const isNewDayRecord = todayMeters > 0 && todayMeters >= bestDayMeters;

    if (isNewDayRecord && !recordFiredRef.current) {
      recordFiredRef.current = true;
      setShowRecord(true);
      if (!reduced) {
        try {
          confetti({
            particleCount: 90,
            spread: 80,
            origin: { y: 0.5 },
            scalar: 0.85,
            colors: ['#FF7AAF', '#FFA94D', '#4FB3E0', '#7E70B8'],
          });
        } catch {
          /* canvas-confetti unavailable in some test environments — harmless */
        }
      }
      const t = window.setTimeout(() => setShowRecord(false), 4500);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [records.data, reduced]);

  // During first load, render nothing so the layout doesn't flash a card.
  if (records.isLoading) return null;

  const data = records.data;

  // No data (error or empty) — hide the card.
  if (!data) return null;

  // Only show the card when there is some recorded wheel activity.
  if (data.allTimeMeters === 0 && data.dailySeries.length === 0) return null;

  return (
    <WheelRecordsContent
      data={data}
      distanceUnit={distanceUnit}
      showRecord={showRecord}
    />
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface DistanceChipProps {
  label: string;
  value: string;
  accent: string;
}

function DistanceChip({ label, value, accent }: DistanceChipProps): JSX.Element {
  return (
    <div
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 2,
        padding: '8px 14px',
        borderRadius: 12,
        background: `color-mix(in srgb, ${accent} 12%, var(--surface))`,
        border: `1.5px solid color-mix(in srgb, ${accent} 35%, transparent)`,
        minWidth: 72,
      }}
    >
      <span
        style={{
          fontFamily: "'Fredoka', sans-serif",
          fontWeight: 700,
          fontSize: 20,
          color: 'var(--text)',
          lineHeight: 1,
        }}
      >
        {value}
      </span>
      <span
        style={{
          fontSize: 11,
          fontWeight: 500,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--text-muted)',
        }}
      >
        {label}
      </span>
    </div>
  );
}

interface HighlightChipProps {
  emoji: string;
  label: string;
  value: string;
  date: string | null;
}

function HighlightChip({ emoji, label, value, date }: HighlightChipProps): JSX.Element {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        borderRadius: 10,
        background: 'var(--surface-raised, var(--surface))',
        border: '1px solid var(--border)',
        fontSize: 14,
        fontWeight: 500,
        color: 'var(--text)',
      }}
    >
      <span aria-hidden>{emoji}</span>
      <span>
        <span style={{ fontWeight: 600 }}>{label}:</span>{' '}
        {value}
        {date && (
          <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>
            ({date})
          </span>
        )}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline SVG sparkline
//
// Receives the sparse dailySeries from the server. Fills missing days with 0
// to produce a contiguous 14-day window ending today.
// ---------------------------------------------------------------------------

interface SparklineProps {
  series: Array<{ date: string; meters: number }>;
}

function Sparkline({ series }: SparklineProps): JSX.Element {
  const DAYS = 14;
  const W = 260;
  const H = 48;
  const PAD_X = 4;
  const PAD_Y = 4;

  // Build a 14-day window ending today (UTC dates).
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const window14: { date: string; meters: number }[] = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    window14.push({ date: key, meters: 0 });
  }

  // Merge sparse server data into the window.
  const lookup = new Map(series.map((s) => [s.date, s.meters]));
  const filled = window14.map((day) => ({
    date: day.date,
    meters: lookup.get(day.date) ?? 0,
  }));

  const maxMeters = Math.max(...filled.map((d) => d.meters), 1);
  const plotW = W - PAD_X * 2;
  const plotH = H - PAD_Y * 2;

  const points = filled.map((day, i) => {
    const x = PAD_X + (i / (DAYS - 1)) * plotW;
    const y = PAD_Y + plotH - (day.meters / maxMeters) * plotH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  // Today's highlight dot — last item.
  const lastPoint = points[points.length - 1];
  const [dotX, dotY] = lastPoint?.split(',').map(Number) ?? [0, 0];

  return (
    <div style={{ marginTop: 2 }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        style={{ overflow: 'visible', display: 'block' }}
        role="img"
        aria-label="14-day wheel distance sparkline"
      >
        <defs>
          <linearGradient id="spark-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#FF7AAF" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#FF7AAF" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {/* Area fill */}
        <polygon
          points={`${PAD_X},${H - PAD_Y} ${points.join(' ')} ${W - PAD_X},${H - PAD_Y}`}
          fill="url(#spark-grad)"
        />
        {/* Line */}
        <polyline
          points={points.join(' ')}
          fill="none"
          stroke="#FF7AAF"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {/* Today dot */}
        {dotX !== undefined && dotY !== undefined && (
          <circle
            cx={dotX}
            cy={dotY}
            r={4}
            fill="#FF7AAF"
            stroke="var(--surface)"
            strokeWidth="2"
          />
        )}
      </svg>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 10,
          color: 'var(--text-muted)',
          marginTop: 2,
          paddingInline: PAD_X,
        }}
      >
        <span>{filled[0]?.date?.slice(5) ?? ''}</span>
        <span>today</span>
      </div>
    </div>
  );
}
