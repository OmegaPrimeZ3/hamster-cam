// app/web/src/components/DiaryEntry.tsx
//
// "Torn storybook page" card. Three variants per PLAN §5.4:
//   - narrative:  emoji + sentence + relative time (+ optional snapshot thumb)
//   - snapshot:   same as narrative but tap expands to fullscreen snapshot
//   - timelapse:  large 16:9 card with inline <video playsinline preload="metadata">
//
// Additional variant: activity === 'recap' — text-only, larger type (18px),
// distinct warm-gold accent. Sorted to top of the day in Diary.tsx.
//
// Whimsy pass: each card gets a deterministic micro-rotation (seeded by
// entry.id so it doesn't dance on re-render), a 4px left stripe and a soft
// emoji badge keyed to entry.activity, plus a near-invisible watercolour
// tint layered over var(--surface). Hover lift via framer-motion; rotation
// and lift are both gated on prefers-reduced-motion.
//
// TTS button: when isTTSAvailable() and ttsEnabled prop is true, shows a
// Volume2 / Square icon button that speaks the narrative aloud.

import { useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Share2, Play, Volume2, Square } from 'lucide-react';
import type { RouterOutputs } from '../trpc';
import { relativeTime, formatDuration } from '../lib/time';
import { activityStyle } from '../lib/activity-style';
import { ShareDialog } from './ShareDialog';
import { isTTSAvailable, speak } from '../lib/tts';
import { parseWheelMeters } from '../lib/trpc-extensions';
import { formatMeters } from '../lib/distance';

type Entry = RouterOutputs['activity']['today'][number];

export interface DiaryEntryProps {
  entry: Entry;
  now?: number;
  ttsEnabled?: boolean;
  /** From settings.distance_unit — defaults to 'mi' until the backend ships. */
  distanceUnit?: 'mi' | 'km';
}

// Stable ±1deg jitter from entry.id so the list looks hand-pinned but never
// shuffles between re-renders. sin(id)·constants is a cheap deterministic
// hash — we only need "looks random", not crypto.
function rotationForId(id: number): number {
  const x = Math.sin(id * 9301 + 49297) * 10000;
  const frac = x - Math.floor(x); // [0, 1)
  return frac * 2 - 1; // [-1, 1] degrees
}

// Narrative templates start with an emoji (e.g. "🥕 {pet} had a snack!"); the
// circle badge already shows that glyph, so strip it from the visible header
// to avoid the double-icon. Handles VS16 (U+FE0F) / ZWJ (U+200D) joiners
// used by composed emoji like 🕳️ and 🗺️.
const LEADING_EMOJI = /^\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*\s*/u;
function stripLeadingEmoji(text: string): string {
  return text.replace(LEADING_EMOJI, '');
}

export function DiaryEntry({ entry, now, ttsEnabled = true, distanceUnit = 'mi' }: DiaryEntryProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const reduced = useReducedMotion();

  const relative = relativeTime(entry.occurred_at, now);
  const duration = entry.duration_ms != null ? formatDuration(entry.duration_ms) : null;
  const style = activityStyle(entry.activity ?? null);
  const rotation = reduced ? 0 : rotationForId(entry.id);
  const isRecap = entry.activity === 'recap';

  // Wheel distance suffix — parsed defensively from entry.details (JSON string).
  // Only shown for wheel entries where wheel_meters is a positive number.
  const wheelMeters =
    entry.activity === 'wheel'
      ? parseWheelMeters(entry as Entry & { details?: string | null })
      : null;
  const distanceSuffix =
    wheelMeters !== null ? ` · ${formatMeters(wheelMeters, distanceUnit)}` : null;

  const showTTS = ttsEnabled && isTTSAvailable();

  function handleTTS(): void {
    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    setSpeaking(true);
    speak(entry.narrative, {
      onEnd: () => setSpeaking(false),
    });
  }

  return (
    <motion.article
      className="hc-card"
      data-kind={entry.kind}
      data-activity={entry.activity ?? undefined}
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
        alignItems:
          entry.kind === 'timelapse'
            ? 'stretch'
            : entry.kind === 'snapshot'
              ? 'center'
              : 'flex-start',
        borderRadius: 20,
        backgroundImage: `linear-gradient(${style.bgTint}, ${style.bgTint})`,
        boxShadow: `inset 4px 0 0 0 ${style.accent}, 0 6px 16px rgba(0, 0, 0, 0.06)`,
        paddingLeft: 20,
      }}
    >
      {/* Activity badge — perched on the top-left corner, overhanging the
          card slightly so it reads as a pinned sticker. The Diary list
          adds vertical gap to clear the overhang. */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          top: -10,
          left: -18,
          width: 36,
          height: 36,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 18,
          lineHeight: 1,
          background: `color-mix(in srgb, ${style.accent} 22%, var(--surface))`,
          boxShadow:
            `inset 0 0 0 1.5px color-mix(in srgb, ${style.accent} 45%, transparent),` +
            ` 0 2px 6px rgba(0, 0, 0, 0.12)`,
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
        }}
      >
        <p
          style={{
            margin: 0,
            fontSize: isRecap ? 18 : 16,
            lineHeight: 1.4,
            wordBreak: 'break-word',
            fontWeight: isRecap ? 600 : 400,
          }}
        >
          {stripLeadingEmoji(entry.narrative)}
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
            {distanceSuffix}
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
            {showTTS && (
              <button
                type="button"
                className="hc-btn"
                onClick={handleTTS}
                aria-label={speaking ? 'Stop reading' : 'Read aloud'}
                style={{
                  background: speaking
                    ? `color-mix(in srgb, ${style.accent} 20%, var(--surface))`
                    : undefined,
                  borderColor: speaking ? style.accent : undefined,
                }}
              >
                {speaking ? (
                  <>
                    <Square aria-hidden size={16} />
                    Stop
                  </>
                ) : (
                  <>
                    <Volume2 aria-hidden size={16} />
                    Read aloud
                  </>
                )}
              </button>
            )}
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
  // The diary entry always carries a media_path (the snapshot mutation writes
  // a placeholder file even when Frigate is unreachable), so the 404 /
  // empty-body case only surfaces at <img> load time. Swap to the colored
  // placeholder on error so the user never sees the broken-image glyph.
  const [failed, setFailed] = useState(false);
  const src = entry.media_path;
  if (!src || failed) {
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
        src={src}
        alt={entry.narrative}
        onError={() => setFailed(true)}
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
