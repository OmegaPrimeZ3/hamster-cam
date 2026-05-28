// app/web/src/components/DiaryEntry.tsx
//
// "Torn storybook page" card. Three variants per PLAN §5.4:
//   - narrative:  emoji + sentence + relative time (+ optional snapshot thumb)
//   - snapshot:   same as narrative but tap expands to fullscreen snapshot
//   - timelapse:  compact thumbnail button; tapping opens ClipPlayerDialog at
//                 ~2× size (Item 7). Shows a "Nightly Recap" badge + duration.
//
// Additional variant: activity === 'recap' — text-only, larger type (18px),
// distinct warm-gold accent. Sorted to top of the day in Diary.tsx.
//
// Whimsy pass: each card gets a 4px left stripe and a soft emoji badge keyed
// to entry.activity, plus a near-invisible watercolour tint layered over
// var(--surface). Hover lift via framer-motion, gated on
// prefers-reduced-motion. (Cards sit flat — no rotation: the slight "cant"
// read as a layout bug, so it was removed.)
//
// TTS button: when isTTSAvailable() and ttsEnabled prop is true, shows a
// Volume2 / Square icon button that speaks the narrative aloud.

import { useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Share2, Play, Volume2, Square, Trash2 } from 'lucide-react';
import type { RouterOutputs } from '../trpc';
import { trpc } from '../trpc';
import { absoluteTime, relativeTime, formatDuration } from '../lib/time';
import { activityStyle } from '../lib/activity-style';
import { ShareDialog } from './ShareDialog';
import { ClipPlayerDialog } from './ClipPlayerDialog';
import { isTTSAvailable, speak, stripLeadingEmoji } from '../lib/tts';
import { parseWheelMeters } from '../lib/trpc-extensions';
import { formatMeters } from '../lib/distance';
import { useAuth } from '../hooks/useAuth';

type Entry = RouterOutputs['activity']['today'][number];

export interface DiaryEntryProps {
  entry: Entry;
  now?: number;
  ttsEnabled?: boolean;
  /** From settings.distance_unit — defaults to 'mi' until the backend ships. */
  distanceUnit?: 'mi' | 'km';
}

export function DiaryEntry({ entry, now, ttsEnabled = true, distanceUnit = 'mi' }: DiaryEntryProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [clipOpen, setClipOpen] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const reduced = useReducedMotion();

  const { user, isAdmin } = useAuth();
  const utils = trpc.useUtils();
  const del = trpc.activity.delete.useMutation({
    onSuccess: async () => {
      setConfirmDelete(false);
      await utils.activity.today.invalidate();
      await utils.activity.range.invalidate();
    },
    onError: (err) => {
      setConfirmDelete(false);
      setDeleteError(err.message ?? 'Could not delete this memory. Try again.');
    },
  });

  const canDelete =
    isAdmin || (entry.kind === 'snapshot' && entry.created_by === user?.id);

  const relative = relativeTime(entry.occurred_at, now);
  const absolute = absoluteTime(entry.occurred_at, now);
  const duration = entry.duration_ms != null ? formatDuration(entry.duration_ms) : null;
  const style = activityStyle(entry.activity ?? null);
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

  // Show "View clip" only when the backend confirms a clip can be produced
  // (clip_available === true). This guards against transition/orphaned entries
  // that have no camera_id or extractable media (backend would 412 otherwise).
  // We still restrict to kinds that make sense — timelapse and narrative only.
  const showViewClip =
    entry.clip_available === true &&
    (entry.kind === 'narrative' || entry.kind === 'timelapse');

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
      whileHover={reduced ? undefined : { y: -2 }}
      whileTap={reduced ? undefined : { scale: 0.99 }}
      transition={{ type: 'spring', stiffness: 260, damping: 22 }}
      style={{
        position: 'relative',
        display: 'flex',
        // Snapshots sit beside the text while collapsed, but an expanded
        // snapshot stacks on top (like timelapse) so the enlarged image gets
        // the full card width instead of fighting the text for the row.
        flexDirection: entry.kind === 'snapshot' && expanded ? 'column' : 'row',
        gap: 12,
        alignItems:
          entry.kind === 'snapshot' && expanded
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
        <TimelapseBody entry={entry} onOpen={() => setClipOpen(true)} />
      ) : entry.kind === 'snapshot' ? (
        <SnapshotBody entry={entry} expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
      ) : (
        <NarrativeBody
          entry={entry}
          clipAvailable={showViewClip}
          onOpenClip={() => setClipOpen(true)}
        />
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
          <small
            style={{
              color: 'var(--text-muted)',
              opacity: 0.75,
              fontSize: 12,
              marginTop: -2,
            }}
          >
            <time dateTime={new Date(entry.occurred_at).toISOString()}>
              {absolute}
            </time>
          </small>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {showViewClip && (
              <button
                type="button"
                className="hc-btn"
                onClick={() => setClipOpen(true)}
              >
                <Play aria-hidden size={16} />
                {entry.kind === 'timelapse' ? 'Watch recap' : 'View clip'}
              </button>
            )}
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
            {canDelete && (
              <button
                type="button"
                className={confirmDelete ? 'hc-btn hc-btn-danger' : 'hc-btn'}
                aria-label={confirmDelete ? 'Are you sure? This memory will be gone forever' : 'Delete memory'}
                disabled={del.isLoading}
                onClick={() => {
                  if (confirmDelete) {
                    setDeleteError(null);
                    del.mutate({ id: entry.id });
                  } else {
                    setConfirmDelete(true);
                    window.setTimeout(
                      () => setConfirmDelete((c) => (c ? false : c)),
                      3500,
                    );
                  }
                }}
              >
                <Trash2 aria-hidden size={16} />
                {confirmDelete ? 'Delete this memory?' : 'Delete'}
              </button>
            )}
          </div>
          {deleteError !== null && (
            <small style={{ color: 'var(--color-danger, #d32f2f)', marginTop: 4 }}>
              {deleteError}
            </small>
          )}
        </div>
      </div>

      <ShareDialog entry={entry} open={shareOpen} onOpenChange={setShareOpen} />
      <ClipPlayerDialog
        entry={entry}
        open={clipOpen}
        onOpenChange={setClipOpen}
        title={entry.kind === 'timelapse' ? 'Nightly Recap' : 'Watch clip'}
      />
    </motion.article>
  );
}

function NarrativeBody({
  entry,
  clipAvailable,
  onOpenClip,
}: {
  entry: Entry;
  clipAvailable: boolean;
  onOpenClip: () => void;
}): JSX.Element | null {
  if (!entry.thumbnail_url) return null;
  // If clip is not available, render the thumbnail as a non-interactive image
  // so the user can see the frame but can't trigger a failing clip request.
  if (!clipAvailable) {
    return (
      <img
        src={entry.thumbnail_url}
        alt=""
        aria-hidden
        loading="lazy"
        style={{ width: 120, height: 80, objectFit: 'cover', borderRadius: 10, display: 'block', flexShrink: 0 }}
      />
    );
  }
  return (
    <button
      type="button"
      onClick={onOpenClip}
      aria-label="View clip"
      style={{
        padding: 0,
        border: 'none',
        background: 'transparent',
        flexShrink: 0,
        cursor: 'pointer',
        borderRadius: 10,
        overflow: 'hidden',
      }}
    >
      <img
        src={entry.thumbnail_url}
        alt=""
        loading="lazy"
        style={{ width: 120, height: 80, objectFit: 'cover', borderRadius: 10, display: 'block' }}
      />
    </button>
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
        // When expanded the card stacks (column), so take the full width and
        // center the enlarged image within it.
        width: expanded ? '100%' : undefined,
        textAlign: expanded ? 'center' : undefined,
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

// Compact 120×80 thumbnail button for a timelapse (nightly recap video) entry.
// Tapping it fires onOpen which opens the shared ClipPlayerDialog at full size.
// The "Nightly Recap" badge and duration are rendered by the parent's meta row.
function TimelapseBody({
  entry,
  onOpen,
}: {
  entry: Entry;
  onOpen: () => void;
}): JSX.Element {
  const hasPoster = Boolean(entry.thumbnail_url);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Watch nightly recap video"
      style={{
        position: 'relative',
        width: 120,
        height: 80,
        flexShrink: 0,
        padding: 0,
        border: 'none',
        background: '#000',
        borderRadius: 10,
        overflow: 'hidden',
        cursor: 'pointer',
        display: 'block',
      }}
    >
      {hasPoster && (
        <img
          src={entry.thumbnail_url ?? undefined}
          alt=""
          aria-hidden
          loading="lazy"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
        />
      )}
      {/* Semi-transparent scrim so the play icon is readable over any poster. */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.38)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Play
          aria-hidden
          size={24}
          style={{ color: '#fff', filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.6))' }}
        />
      </div>
      {/* "Recap" badge pinned to bottom-left of the thumbnail. */}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          bottom: 4,
          left: 4,
          background: 'rgba(0,0,0,0.65)',
          color: '#fff',
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          padding: '2px 5px',
          borderRadius: 4,
          lineHeight: 1.4,
          fontFamily: 'Inter, system-ui, sans-serif',
        }}
      >
        Recap
      </span>
    </button>
  );
}
