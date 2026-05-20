// app/web/src/components/DiaryEntry.tsx
//
// "Torn storybook page" card. Three variants per PLAN §5.4:
//   - narrative:  emoji + sentence + relative time (+ optional snapshot thumb)
//   - snapshot:   same as narrative but tap expands to fullscreen snapshot
//   - timelapse:  large 16:9 card with inline <video playsinline preload="metadata">
//
// Whimsy pass: each card gets a deterministic micro-rotation (seeded by
// entry.id so it doesn't dance on re-render), a 4px left stripe and a soft
// emoji badge keyed to entry.activity, plus a near-invisible watercolour
// tint layered over var(--surface). Hover lift via framer-motion; rotation
// and lift are both gated on prefers-reduced-motion.

import { useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Share2, Play } from 'lucide-react';
import type { RouterOutputs } from '../trpc';
import { relativeTime, formatDuration } from '../lib/time';
import { activityStyle } from '../lib/activity-style';
import { ShareDialog } from './ShareDialog';

type Entry = RouterOutputs['activity']['today'][number];

export interface DiaryEntryProps {
  entry: Entry;
  now?: number;
}

// Stable ±1deg jitter from entry.id so the list looks hand-pinned but never
// shuffles between re-renders. sin(id)·constants is a cheap deterministic
// hash — we only need "looks random", not crypto.
function rotationForId(id: number): number {
  const x = Math.sin(id * 9301 + 49297) * 10000;
  const frac = x - Math.floor(x); // [0, 1)
  return frac * 2 - 1; // [-1, 1] degrees
}

export function DiaryEntry({ entry, now }: DiaryEntryProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const reduced = useReducedMotion();

  const relative = relativeTime(entry.occurred_at, now);
  const duration = entry.duration_ms != null ? formatDuration(entry.duration_ms) : null;
  const style = activityStyle(entry.activity ?? null);
  const rotation = reduced ? 0 : rotationForId(entry.id);

  return (
    <motion.article
      className="hc-card"
      data-kind={entry.kind}
      initial={false}
      animate={{ rotate: rotation }}
      whileHover={reduced ? undefined : { y: -2 }}
      whileTap={reduced ? undefined : { scale: 0.99 }}
      transition={{ type: 'spring', stiffness: 260, damping: 22 }}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: entry.kind === 'timelapse' ? 'column' : 'row',
        gap: 12,
        alignItems: entry.kind === 'timelapse' ? 'stretch' : 'flex-start',
        // Stripe + watercolour wash layered atop var(--surface).
        // box-shadow inset draws the stripe inside the 20px radius cleanly.
        borderRadius: 20,
        // Stack: tint gradient → base surface. Keeps theme tokens flowing.
        backgroundImage: `linear-gradient(${style.bgTint}, ${style.bgTint})`,
        boxShadow: `inset 4px 0 0 0 ${style.accent}, 0 6px 16px rgba(0, 0, 0, 0.06)`,
        paddingLeft: 20, // make room for the inset stripe so content doesn't crowd it
      }}
    >
      {/* Activity badge — top-right, soft circle in the accent at low alpha. */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          top: 10,
          right: 10,
          width: 32,
          height: 32,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 18,
          lineHeight: 1,
          background: `color-mix(in srgb, ${style.accent} 18%, transparent)`,
          // Subtle ring picks the badge out without shouting.
          boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${style.accent} 35%, transparent)`,
          pointerEvents: 'none',
        }}
      >
        {style.badgeEmoji}
      </div>

      {entry.kind === 'timelapse' ? (
        <TimelapseBody entry={entry} />
      ) : entry.kind === 'snapshot' ? (
        <SnapshotBody entry={entry} expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
      ) : (
        <NarrativeBody entry={entry} />
      )}

      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          minWidth: 0,
          // Pad the right edge so long narrative text never slips under the badge.
          paddingRight: 40,
        }}
      >
        <p style={{ margin: 0, fontSize: 16, lineHeight: 1.4, wordBreak: 'break-word' }}>
          {entry.narrative}
        </p>
        {/* Dashed "notebook line" separator above the timestamp / share row. */}
        <div
          style={{
            marginTop: 4,
            paddingTop: 8,
            borderTop: '1px dashed color-mix(in srgb, var(--text-muted) 35%, transparent)',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <small
            style={{
              color: 'var(--text-muted)',
              fontVariantCaps: 'all-small-caps',
              letterSpacing: '0.04em',
            }}
          >
            {relative}
            {duration ? ` · ${duration}` : ''}
          </small>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="hc-btn"
              onClick={() => setShareOpen(true)}
              aria-label="Send a clip"
            >
              <Share2 aria-hidden size={16} />
              Send a clip
            </button>
          </div>
        </div>
      </div>

      <ShareDialog entry={entry} open={shareOpen} onOpenChange={setShareOpen} />
    </motion.article>
  );
}

function NarrativeBody({ entry }: { entry: Entry }): JSX.Element | null {
  if (!entry.media_path) return null;
  return (
    <img
      src={entry.media_path}
      alt=""
      style={{ width: 120, height: 80, objectFit: 'cover', borderRadius: 10, flexShrink: 0 }}
    />
  );
}

function SnapshotBody({
  entry,
  expanded,
  onToggle,
}: {
  entry: Entry;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  if (!entry.media_path) {
    return (
      <div
        style={{
          width: 120,
          height: 80,
          background: 'var(--surface-raised)',
          borderRadius: 10,
          flexShrink: 0,
        }}
        aria-hidden
      />
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={expanded ? 'Hide snapshot' : 'Expand snapshot'}
      style={{
        padding: 0,
        border: 'none',
        background: 'transparent',
        flexShrink: 0,
        cursor: 'pointer',
      }}
    >
      <img
        src={entry.media_path}
        alt={entry.narrative}
        style={{
          width: expanded ? 'min(100%, 360px)' : 120,
          height: expanded ? 'auto' : 80,
          objectFit: 'cover',
          borderRadius: 10,
          transition: 'all 200ms ease',
        }}
      />
    </button>
  );
}

function TimelapseBody({ entry }: { entry: Entry }): JSX.Element {
  return (
    <div style={{ position: 'relative', aspectRatio: '16 / 9', background: '#000', borderRadius: 12, overflow: 'hidden' }}>
      {entry.media_path ? (
        <video
          controls
          playsInline
          preload="metadata"
          src={entry.media_path}
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        />
      ) : (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
          }}
        >
          <Play aria-hidden size={32} />
        </div>
      )}
    </div>
  );
}
