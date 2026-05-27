// app/web/src/components/Diary.tsx
//
// Scrolling list of DiaryEntry. Loads `activity.range` with a rolling window
// controlled by the DiaryRangePicker dropdown (default: last 24 hours).
//
// Sort order: recap → timelapse → everything else, then by time descending
// within each group. This matches the previous today-only behaviour.
//
// TTS: new entries that arrive after the initial load are read aloud when
// `readAloud` is true. A range change counts as a fresh load — all entries
// loaded for the new range are marked as seen immediately so the backlog is
// not narrated.

import { useEffect, useRef, useState, useCallback } from 'react';
import { trpc } from '../trpc';
import type { RouterOutputs } from '../trpc';
import { DiaryEntry } from './DiaryEntry';
import { DiaryRangePicker } from './DiaryRangePicker';
import { useTTSEnabled } from '../hooks/useTTSEnabled';
import { speak } from '../lib/tts';
import { getDistanceUnit } from '../lib/trpc-extensions';
import {
  type DiaryRangeState,
  resolvePreset,
  loadPersistedRange,
  persistRangeState,
} from '../lib/diaryRange';

export interface DiaryProps {
  readAloud: boolean;
  petName: string;
}

type Entry = RouterOutputs['activity']['today'][number];

// Sort order weight for pinning special entry types to the top of the list.
// Lower number = closer to top.
function sortWeight(entry: Entry): number {
  if (entry.activity === 'recap' || entry.kind === 'recap') return 0;
  if (entry.kind === 'timelapse' || entry.activity === 'timelapse') return 1;
  return 2;
}

function sortEntries(entries: Entry[]): Entry[] {
  return entries.slice().sort((a, b) => {
    const wa = sortWeight(a);
    const wb = sortWeight(b);
    if (wa !== wb) return wa - wb;
    // Newest first within each group.
    return b.occurred_at - a.occurred_at;
  });
}

export function Diary({ readAloud, petName }: DiaryProps): JSX.Element {
  const { ttsEnabled } = useTTSEnabled();

  // Range state — default loaded from sessionStorage (or last-24h).
  const [rangeState, setRangeStateRaw] = useState<DiaryRangeState>(
    () => loadPersistedRange(),
  );

  // Persist every time rangeState changes.
  const handleRangeChange = useCallback((next: DiaryRangeState) => {
    setRangeStateRaw(next);
    persistRangeState(next);
  }, []);

  const settings = trpc.settings.get.useQuery();
  const distanceUnit = getDistanceUnit(
    settings.data as Record<string, unknown> | undefined,
  );

  // Recompute window on every render so rolling windows stay fresh even if the
  // component mounts and the user leaves it open for hours — the query key
  // changes each time `now` ticks forward, so React Query refetches on interval.
  // We floor to the nearest 30s to avoid creating a brand-new query key every
  // ms (which would break the cache). This means the effective window may lag
  // up to 30s at the edges, which is acceptable.
  const now = Math.floor(Date.now() / 30_000) * 30_000;
  const resolvedRange =
    rangeState.preset === 'custom' && rangeState.custom !== null
      ? rangeState.custom
      : resolvePreset(rangeState.preset, now);

  const rangeQuery = trpc.activity.range.useQuery(
    { from: resolvedRange.from, to: resolvedRange.to },
    { refetchInterval: 30_000 },
  );

  // seenIdsRef tracks which entry IDs have already been spoken. When the range
  // changes we need to mark the entire newly-loaded set as seen so we don't
  // narrate the historical backlog.
  const seenIdsRef = useRef<Set<number>>(new Set());

  // Track the previous range key so we can detect a range change.
  const prevRangeKeyRef = useRef<string>(`${resolvedRange.from}:${resolvedRange.to}`);
  const rangeKey = `${resolvedRange.from}:${resolvedRange.to}`;

  useEffect(() => {
    if (!rangeQuery.data) return;

    const rangeChanged = prevRangeKeyRef.current !== rangeKey;
    prevRangeKeyRef.current = rangeKey;

    if (rangeChanged) {
      // Range changed — treat as a fresh load. Mark everything seen, no TTS.
      seenIdsRef.current = new Set<number>(rangeQuery.data.map((e) => e.id));
      return;
    }

    // First render after data arrives: mark as seen, no TTS.
    if (seenIdsRef.current.size === 0) {
      for (const e of rangeQuery.data) seenIdsRef.current.add(e.id);
      return;
    }

    if (!readAloud) {
      for (const e of rangeQuery.data) seenIdsRef.current.add(e.id);
      return;
    }

    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    if (reducedMotion) return;

    for (const entry of rangeQuery.data) {
      if (seenIdsRef.current.has(entry.id)) continue;
      seenIdsRef.current.add(entry.id);
      speak(entry.narrative);
    }
  }, [rangeQuery.data, readAloud, rangeKey]);

  // Build a human-readable heading that reflects the current selection.
  const headingLabel = buildHeadingLabel(rangeState, petName);

  return (
    <section aria-labelledby="diary-heading" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Header row: title on the left, range picker right-aligned */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <h2
          id="diary-heading"
          className="display"
          style={{ margin: 0, fontSize: 22, flex: '1 1 auto' }}
        >
          {headingLabel}
        </h2>
        <div style={{ flex: '0 0 auto' }}>
          <DiaryRangePicker value={rangeState} onChange={handleRangeChange} />
        </div>
      </div>

      {rangeQuery.isLoading && (
        <p style={{ color: 'var(--text-muted)' }}>Loading the story…</p>
      )}
      {rangeQuery.error && (
        <p role="alert" style={{ color: 'var(--danger)' }}>
          Could not load the diary.
        </p>
      )}
      {rangeQuery.data && rangeQuery.data.length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>
          Nothing happened during this time — check back soon!
        </p>
      )}

      {/* gap accommodates the badge that overhangs each card's top-left corner */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        {sortEntries(rangeQuery.data ?? []).map((entry) => (
          <DiaryEntry
            key={entry.id}
            entry={entry}
            ttsEnabled={ttsEnabled}
            distanceUnit={distanceUnit}
          />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Heading helpers
// ---------------------------------------------------------------------------

function buildHeadingLabel(state: DiaryRangeState, petName: string): string {
  const prefix = petName ? `${petName}'s` : 'Pet';
  switch (state.preset) {
    case 'last24h':
      return `📖 ${prefix} Diary — Last 24 hours`;
    case 'today':
      return `📖 ${prefix} Diary — Today`;
    case 'last7d':
      return `📖 ${prefix} Diary — Last 7 days`;
    case 'last30d':
      return `📖 ${prefix} Diary — Last 30 days`;
    case 'custom':
      if (state.custom) {
        return `📖 ${prefix} Diary — Custom range`;
      }
      return `📖 ${prefix} Diary`;
  }
}
