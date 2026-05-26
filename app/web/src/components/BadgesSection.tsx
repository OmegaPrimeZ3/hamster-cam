// app/web/src/components/BadgesSection.tsx
//
// Persistent badge grid on the main screen. Shows all badges from the
// catalog; earned ones are full-colour with a count pill when earned more than
// once; locked ones are desaturated so kids can see what's achievable.
//
// Data source: trpc.badges.earned (aggregated shape per frozen contract):
//   Array<{ badge_id, count, first_earned_at, last_earned_at }>
//
// Locked badges are simply absent from the array — we render them by iterating
// the catalog and checking membership, so the grid tile count equals
// BADGE_CATALOG.length.

import { useReducedMotion } from 'framer-motion';
import { trpc } from '../trpc';
import { BADGE_CATALOG, type BadgeEarned } from '../badges';

/** Format epoch-ms as a short date like "May 24". */
function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function BadgesSection(): JSX.Element {
  const reduced = useReducedMotion();
  const { data, isLoading } = trpc.badges.earned.useQuery(undefined, {
    refetchInterval: 30_000,
  });
  const earned: BadgeEarned[] = data ?? [];
  const earnedMap = new Map<string, BadgeEarned>(earned.map((b) => [b.badge_id, b]));

  return (
    <section aria-label="Badges" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h2
        className="display"
        style={{
          margin: 0,
          fontSize: 18,
          fontWeight: 600,
          color: 'var(--text)',
        }}
      >
        🏅 Badges
      </h2>

      {isLoading ? (
        <BadgesSkeletonGrid />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
            gap: 10,
          }}
        >
          {BADGE_CATALOG.map((meta) => {
            const earnedEntry = earnedMap.get(meta.id);
            return (
              <BadgeTile
                key={meta.id}
                emoji={meta.emoji}
                label={meta.label}
                description={meta.description}
                earnedEntry={earnedEntry}
                reduced={!!reduced}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Individual tile
// ---------------------------------------------------------------------------

interface BadgeTileProps {
  emoji: string;
  label: string;
  description: string;
  earnedEntry: BadgeEarned | undefined;
  reduced: boolean;
}

function BadgeTile({ emoji, label, description, earnedEntry, reduced }: BadgeTileProps): JSX.Element {
  const earned = earnedEntry !== undefined;
  const count = earnedEntry?.count ?? 0;

  const ariaLabel = earned
    ? count > 1
      ? `${label} — earned ${count} times, last on ${shortDate(earnedEntry.last_earned_at)}`
      : `${label} — earned on ${shortDate(earnedEntry.last_earned_at)}`
    : `${label} — locked. ${description}`;

  return (
    <div
      aria-label={ariaLabel}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        padding: '14px 10px 12px',
        borderRadius: 16,
        background: earned
          ? 'var(--surface)'
          : 'color-mix(in srgb, var(--surface) 70%, var(--bg))',
        border: '1px solid var(--border)',
        boxShadow: earned ? '0 2px 8px rgba(0,0,0,0.07)' : 'none',
        textAlign: 'center',
        minHeight: 100,
        position: 'relative',
        transition: reduced ? undefined : 'box-shadow 140ms ease, opacity 140ms ease',
        opacity: earned ? 1 : 0.6,
      }}
    >
      {/* Count pill — only shown when earned more than once */}
      {count > 1 && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            background: 'var(--accent, #e879a0)',
            color: '#fff',
            borderRadius: 999,
            fontSize: 11,
            fontWeight: 700,
            lineHeight: 1,
            padding: '2px 6px',
            fontFamily: "'Fredoka', sans-serif",
          }}
        >
          ×{count}
        </div>
      )}

      {/* Emoji — greyscale + dim when locked */}
      <span
        aria-hidden
        style={{
          fontSize: 32,
          lineHeight: 1,
          filter: earned ? undefined : 'grayscale(1)',
          display: 'block',
        }}
      >
        {emoji}
      </span>

      {/* Label */}
      <span
        style={{
          fontFamily: "'Fredoka', sans-serif",
          fontWeight: 600,
          fontSize: 13,
          lineHeight: 1.3,
          color: earned ? 'var(--text)' : 'var(--text-muted)',
        }}
      >
        {label}
      </span>

      {/* Last earned date — only for earned badges */}
      {earned && earnedEntry && (
        <small
          style={{
            color: 'var(--text-muted)',
            fontSize: 11,
            lineHeight: 1.2,
            fontVariantCaps: 'all-small-caps',
            letterSpacing: '0.04em',
          }}
        >
          {shortDate(earnedEntry.last_earned_at)}
        </small>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function BadgesSkeletonGrid(): JSX.Element {
  return (
    <div
      aria-busy="true"
      aria-label="Loading badges"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
        gap: 10,
      }}
    >
      {Array.from({ length: BADGE_CATALOG.length }, (_, i) => (
        <div
          key={i}
          aria-hidden
          style={{
            height: 100,
            borderRadius: 16,
            background: 'var(--surface-raised)',
            border: '1px solid var(--border)',
            opacity: 0.5,
          }}
        />
      ))}
    </div>
  );
}
