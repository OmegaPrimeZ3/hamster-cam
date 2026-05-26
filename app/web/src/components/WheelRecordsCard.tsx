// app/web/src/components/WheelRecordsCard.tsx
//
// Wheel personal-records card placed near the StatsStrip.
//
// Queries `stats.wheelRecords` (refetch every 60 s). Shows:
//   - Today / this week / all-time distance AND time in the user's preferred unit
//   - Best day + best session highlights
//   - A 14-day SVG sparkline (sparse series filled with 0 for missing days)
//   - A "New record!" flourish (confetti) when todayMeters >= bestDayMeters
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
// Time formatting helper — produces kid-friendly strings like "12 min", "1 h 5 min"
// ---------------------------------------------------------------------------

export function formatSeconds(totalSeconds: number): string {
  if (totalSeconds <= 0) return '0 min';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h === 0) return m <= 1 ? '1 min' : `${m} min`;
  if (m === 0) return h === 1 ? '1 hr' : `${h} hr`;
  return `${h} h ${m} min`;
}

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
  todaySeconds: number;
  weekSeconds: number;
  allTimeSeconds: number;
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
        borderRadius: 20,
        padding: '18px 20px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        position: 'relative',
        overflow: 'hidden',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.06)',
      }}
    >
      {/* Decorative background wheel — purely visual, aria-hidden */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          top: -20,
          right: -20,
          fontSize: 110,
          lineHeight: 1,
          opacity: 0.05,
          pointerEvents: 'none',
          userSelect: 'none',
        }}
      >
        🎡
      </div>

      {/* New-record badge */}
      {showRecord && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'absolute',
            top: 14,
            right: 16,
            background: 'linear-gradient(135deg, #FF7AAF, #FF5A8A)',
            color: '#fff',
            borderRadius: 999,
            padding: '5px 14px',
            fontFamily: "'Fredoka', sans-serif",
            fontWeight: 700,
            fontSize: 13,
            boxShadow: '0 2px 8px rgba(255, 90, 138, 0.4)',
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
          fontSize: 20,
          color: 'var(--text)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          lineHeight: 1,
        }}
      >
        <span aria-hidden>🎡</span>
        <span>Wheel Records</span>
      </div>

      {/* Period stats — 3-column grid: Today / This week / All time */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 10,
        }}
      >
        <PeriodCell
          label="Today"
          distance={fmt(data.todayMeters)}
          time={formatSeconds(data.todaySeconds)}
          accent="#FF7AAF"
          hasData={data.todayMeters > 0 || data.todaySeconds > 0}
        />
        <PeriodCell
          label="This week"
          distance={fmt(data.weekMeters)}
          time={formatSeconds(data.weekSeconds)}
          accent="#FFA94D"
          hasData={data.weekMeters > 0 || data.weekSeconds > 0}
        />
        <PeriodCell
          label="All time"
          distance={fmt(data.allTimeMeters)}
          time={formatSeconds(data.allTimeSeconds)}
          accent="#4FB3E0"
          hasData={data.allTimeMeters > 0 || data.allTimeSeconds > 0}
        />
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
// Empty state — rendered when there is no wheel data at all
// ---------------------------------------------------------------------------

function WheelEmptyState(): JSX.Element {
  return (
    <section
      aria-label="Wheel records"
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 20,
        padding: '22px 20px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
        textAlign: 'center',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.06)',
      }}
    >
      <span aria-hidden style={{ fontSize: 40, lineHeight: 1 }}>🎡</span>
      <div>
        <p
          style={{
            fontFamily: "'Fredoka', sans-serif",
            fontWeight: 700,
            fontSize: 18,
            color: 'var(--text)',
            margin: 0,
          }}
        >
          Wheel Records
        </p>
        <p style={{ color: 'var(--text-muted)', margin: '4px 0 0', fontSize: 14 }}>
          No wheel runs yet
        </p>
      </div>
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

  // If the query errored, skip the card quietly.
  if (!data) return null;

  // Determine whether there is ANY wheel data to show.
  const hasAnyData =
    data.allTimeMeters > 0 ||
    data.allTimeSeconds > 0 ||
    data.dailySeries.length > 0;

  if (!hasAnyData) {
    return <WheelEmptyState />;
  }

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

interface PeriodCellProps {
  label: string;
  distance: string;
  time: string;
  accent: string;
  hasData: boolean;
}

function PeriodCell({ label, distance, time, accent, hasData }: PeriodCellProps): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        padding: '12px 8px',
        borderRadius: 14,
        background: `color-mix(in srgb, ${accent} 10%, var(--surface))`,
        border: `1.5px solid color-mix(in srgb, ${accent} 28%, transparent)`,
        textAlign: 'center',
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.07em',
          color: accent,
          lineHeight: 1,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: "'Fredoka', sans-serif",
          fontWeight: 700,
          fontSize: hasData ? 17 : 15,
          color: hasData ? 'var(--text)' : 'var(--text-muted)',
          lineHeight: 1,
        }}
      >
        {hasData ? distance : '—'}
      </span>
      {hasData && (
        <span
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: 'var(--text-muted)',
            lineHeight: 1,
          }}
        >
          {time}
        </span>
      )}
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
        padding: '7px 12px',
        borderRadius: 12,
        background: 'var(--surface-raised, color-mix(in srgb, var(--surface) 85%, var(--bg)))',
        border: '1px solid var(--border)',
        fontSize: 13,
        fontWeight: 500,
        color: 'var(--text)',
      }}
    >
      <span aria-hidden style={{ fontSize: 16, lineHeight: 1 }}>{emoji}</span>
      <span>
        <span style={{ fontWeight: 600, fontFamily: "'Fredoka', sans-serif" }}>{label}</span>
        {': '}
        {value}
        {date !== null && (
          <span style={{ color: 'var(--text-muted)', marginLeft: 4, fontSize: 12 }}>
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
  const H = 52;
  const PAD_X = 4;
  const PAD_Y = 6;

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
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 10,
          fontWeight: 500,
          color: 'var(--text-muted)',
          marginBottom: 4,
          letterSpacing: '0.03em',
        }}
      >
        <span>14 days</span>
        <span style={{ color: '#FF7AAF', fontWeight: 600 }}>today</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        style={{ overflow: 'visible', display: 'block', borderRadius: 8 }}
        role="img"
        aria-label="14-day wheel distance sparkline"
      >
        <defs>
          <linearGradient id="spark-grad-wrc" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#FF7AAF" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#FF7AAF" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {/* Area fill */}
        <polygon
          points={`${PAD_X},${H - PAD_Y} ${points.join(' ')} ${W - PAD_X},${H - PAD_Y}`}
          fill="url(#spark-grad-wrc)"
        />
        {/* Line */}
        <polyline
          points={points.join(' ')}
          fill="none"
          stroke="#FF7AAF"
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {/* Today dot */}
        {dotX !== undefined && dotY !== undefined && (
          <circle
            cx={dotX}
            cy={dotY}
            r={4.5}
            fill="#FF7AAF"
            stroke="var(--surface)"
            strokeWidth="2"
          />
        )}
      </svg>
    </div>
  );
}
