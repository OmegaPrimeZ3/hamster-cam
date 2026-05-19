// app/web/src/components/DiaryEntry.tsx
//
// Three card variants per PLAN §5.4:
//   - narrative:  emoji + sentence + relative time (+ optional snapshot thumb)
//   - snapshot:   same as narrative but tap expands to fullscreen snapshot
//   - timelapse:  large 16:9 card with inline <video playsinline preload="metadata">
//
// Each entry has a Share button (opens ShareDialog).

import { useState } from 'react';
import { Share2, Play } from 'lucide-react';
import type { RouterOutputs } from '../trpc';
import { relativeTime, formatDuration } from '../lib/time';
import { ShareDialog } from './ShareDialog';

type Entry = RouterOutputs['activity']['today'][number];

export interface DiaryEntryProps {
  entry: Entry;
  now?: number;
}

export function DiaryEntry({ entry, now }: DiaryEntryProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  const relative = relativeTime(entry.occurred_at, now);
  const duration = entry.duration_ms != null ? formatDuration(entry.duration_ms) : null;

  return (
    <article
      className="hc-card"
      data-kind={entry.kind}
      style={{
        display: 'flex',
        flexDirection: entry.kind === 'timelapse' ? 'column' : 'row',
        gap: 12,
        alignItems: entry.kind === 'timelapse' ? 'stretch' : 'flex-start',
      }}
    >
      {entry.kind === 'timelapse' ? (
        <TimelapseBody entry={entry} />
      ) : entry.kind === 'snapshot' ? (
        <SnapshotBody entry={entry} expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
      ) : (
        <NarrativeBody entry={entry} />
      )}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: 16, lineHeight: 1.4, wordBreak: 'break-word' }}>
          {entry.narrative}
        </p>
        <small style={{ color: 'var(--text-muted)' }}>
          {relative}
          {duration ? ` · ${duration}` : ''}
        </small>
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
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

      <ShareDialog entry={entry} open={shareOpen} onOpenChange={setShareOpen} />
    </article>
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
