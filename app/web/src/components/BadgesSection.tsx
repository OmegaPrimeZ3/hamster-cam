// app/web/src/components/BadgesSection.tsx
//
// Persistent badge grid on the main screen. Shows all badges from the
// catalog; earned ones are full-colour with a count pill when earned more than
// once; locked ones are desaturated so kids can see what's achievable.
//
// Each tile is tappable — tapping opens a modal that shows the badge name,
// what it represents (description), and earned context (count + date, or
// "Not earned yet" for locked badges).
//
// Data source: trpc.badges.earned (aggregated shape per frozen contract):
//   Array<{ badge_id, count, first_earned_at, last_earned_at }>
//
// Locked badges are simply absent from the array — we render them by iterating
// the catalog and checking membership, so the grid tile count equals
// BADGE_CATALOG.length.

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useReducedMotion } from 'framer-motion';
import { trpc } from '../trpc';
import { BADGE_CATALOG, type BadgeMeta, type BadgeEarned } from '../badges';

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

  const [selected, setSelected] = useState<{ meta: BadgeMeta; earnedEntry: BadgeEarned | undefined } | null>(null);

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
        Badges
      </h2>

      {isLoading ? (
        <BadgesSkeletonGrid />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))',
            gap: 10,
          }}
        >
          {BADGE_CATALOG.map((meta) => {
            const earnedEntry = earnedMap.get(meta.id);
            return (
              <BadgeTile
                key={meta.id}
                meta={meta}
                earnedEntry={earnedEntry}
                reduced={!!reduced}
                onTap={() => setSelected({ meta, earnedEntry })}
              />
            );
          })}
        </div>
      )}

      {/* Badge detail dialog — shared across all tiles, only one open at a time */}
      <BadgeDetailDialog
        open={selected !== null}
        onClose={() => setSelected(null)}
        meta={selected?.meta ?? null}
        earnedEntry={selected?.earnedEntry ?? undefined}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Individual tile — a button so it's keyboard-accessible and touch-friendly
// ---------------------------------------------------------------------------

interface BadgeTileProps {
  meta: BadgeMeta;
  earnedEntry: BadgeEarned | undefined;
  reduced: boolean;
  onTap: () => void;
}

function BadgeTile({ meta, earnedEntry, reduced, onTap }: BadgeTileProps): JSX.Element {
  const earned = earnedEntry !== undefined;
  const count = earnedEntry?.count ?? 0;

  const ariaLabel = earned
    ? count > 1
      ? `${meta.label} — earned ${count} times. Tap for details.`
      : `${meta.label} — earned on ${shortDate(earnedEntry.last_earned_at)}. Tap for details.`
    : `${meta.label} — locked. Tap to find out how to earn it.`;

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onTap}
      style={{
        all: 'unset',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        padding: '14px 10px 12px',
        borderRadius: 16,
        background: earned
          ? 'var(--surface)'
          : 'color-mix(in srgb, var(--surface) 70%, var(--bg))',
        border: earned
          ? '1.5px solid color-mix(in srgb, var(--accent, #e879a0) 30%, var(--border))'
          : '1px solid var(--border)',
        boxShadow: earned ? '0 2px 8px rgba(0,0,0,0.07)' : 'none',
        textAlign: 'center',
        minHeight: 100,
        minWidth: 0,
        width: '100%',
        boxSizing: 'border-box',
        position: 'relative',
        cursor: 'pointer',
        transition: reduced ? undefined : 'box-shadow 140ms ease, opacity 140ms ease, transform 120ms ease',
        opacity: earned ? 1 : 0.6,
      }}
      onMouseEnter={(e) => {
        if (!reduced) {
          (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)';
          (e.currentTarget as HTMLElement).style.boxShadow = earned
            ? '0 6px 16px rgba(0,0,0,0.12)'
            : '0 3px 10px rgba(0,0,0,0.08)';
        }
      }}
      onMouseLeave={(e) => {
        if (!reduced) {
          (e.currentTarget as HTMLElement).style.transform = '';
          (e.currentTarget as HTMLElement).style.boxShadow = earned ? '0 2px 8px rgba(0,0,0,0.07)' : 'none';
        }
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
          {`×${count}`}
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
        {meta.emoji}
      </span>

      {/* Label */}
      <span
        style={{
          fontFamily: "'Fredoka', sans-serif",
          fontWeight: 600,
          fontSize: 12,
          lineHeight: 1.3,
          color: earned ? 'var(--text)' : 'var(--text-muted)',
          wordBreak: 'break-word',
        }}
      >
        {meta.label}
      </span>

      {/* Earned indicator — date for earned, lock for locked */}
      {earned && earnedEntry ? (
        <small
          style={{
            color: 'var(--text-muted)',
            fontSize: 10,
            lineHeight: 1.2,
            fontVariantCaps: 'all-small-caps',
            letterSpacing: '0.04em',
          }}
        >
          {shortDate(earnedEntry.last_earned_at)}
        </small>
      ) : (
        <small
          aria-hidden
          style={{
            fontSize: 12,
            opacity: 0.4,
            lineHeight: 1,
          }}
        >
          🔒
        </small>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Badge detail dialog — Radix Dialog, same overlay/content pattern as
// ClipPlayerDialog and ShareDialog.
// ---------------------------------------------------------------------------

interface BadgeDetailDialogProps {
  open: boolean;
  onClose: () => void;
  meta: BadgeMeta | null;
  earnedEntry: BadgeEarned | undefined;
}

function BadgeDetailDialog({ open, onClose, meta, earnedEntry }: BadgeDetailDialogProps): JSX.Element {
  if (meta === null) {
    // Dialog still mounts when closed (Radix manages unmounting internally).
    return (
      <Dialog.Root open={false} onOpenChange={(v) => !v && onClose()}>
        <Dialog.Portal />
      </Dialog.Root>
    );
  }

  const earned = earnedEntry !== undefined;
  const count = earnedEntry?.count ?? 0;

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay style={overlayStyle} />
        <Dialog.Content
          style={contentStyle}
          aria-describedby="badge-detail-desc"
        >
          {/* Big emoji */}
          <div
            aria-hidden
            style={{
              textAlign: 'center',
              fontSize: 64,
              lineHeight: 1,
              marginBottom: 12,
              filter: earned ? undefined : 'grayscale(1) opacity(0.5)',
            }}
          >
            {meta.emoji}
          </div>

          <Dialog.Title
            className="display"
            style={{
              margin: '0 0 6px',
              textAlign: 'center',
              fontSize: 22,
              fontWeight: 700,
            }}
          >
            {meta.label}
          </Dialog.Title>

          {/* What this badge represents */}
          <p
            id="badge-detail-desc"
            style={{
              color: 'var(--text-muted)',
              textAlign: 'center',
              margin: '0 0 16px',
              fontSize: 15,
              lineHeight: 1.5,
            }}
          >
            {meta.description}
          </p>

          {/* Earned context chip */}
          <div
            role="status"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              padding: '10px 16px',
              borderRadius: 12,
              background: earned
                ? 'color-mix(in srgb, var(--accent, #e879a0) 12%, var(--surface))'
                : 'var(--surface-raised, color-mix(in srgb, var(--surface) 80%, var(--bg)))',
              border: earned
                ? '1.5px solid color-mix(in srgb, var(--accent, #e879a0) 30%, transparent)'
                : '1px solid var(--border)',
              fontSize: 14,
              fontWeight: 500,
              color: earned ? 'var(--text)' : 'var(--text-muted)',
            }}
          >
            {earned && earnedEntry ? (
              <>
                <span aria-hidden>🏅</span>
                <span>
                  {count > 1
                    ? `Earned ${count}× — last on ${shortDate(earnedEntry.last_earned_at)}`
                    : `Earned on ${shortDate(earnedEntry.last_earned_at)}`}
                </span>
              </>
            ) : (
              <>
                <span aria-hidden>🔒</span>
                <span>Not earned yet</span>
              </>
            )}
          </div>

          {/* Close button */}
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 20 }}>
            <Dialog.Close asChild>
              <button type="button" className="hc-btn" style={{ minWidth: 100 }}>
                Got it
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
        gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))',
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

// ---------------------------------------------------------------------------
// Shared dialog styles — matches ClipPlayerDialog / ShareDialog convention
// ---------------------------------------------------------------------------

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.45)',
  zIndex: 60,
};

const contentStyle: React.CSSProperties = {
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  width: 'min(360px, calc(100vw - 32px))',
  padding: '28px 24px 22px',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 20,
  color: 'var(--text)',
  zIndex: 61,
  boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
};
