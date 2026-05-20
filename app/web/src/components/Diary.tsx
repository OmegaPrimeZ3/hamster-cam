// app/web/src/components/Diary.tsx
//
// Scrolling list of DiaryEntry. Loads `activity.today`, sorts newest-first
// with recap cards pinned to the top of the day, then timelapse, then all
// other entries by time descending.
//
// Optionally reads new entries aloud via Web Speech API when the user has
// turned on `read_aloud` in settings.

import { useEffect, useRef } from 'react';
import { trpc } from '../trpc';
import type { RouterOutputs } from '../trpc';
import { DiaryEntry } from './DiaryEntry';
import { useTTSEnabled } from '../hooks/useTTSEnabled';
import { getDistanceUnit } from '../lib/trpc-extensions';

export interface DiaryProps {
  readAloud: boolean;
  petName: string;
}

type Entry = RouterOutputs['activity']['today'][number];

// Sort order weight for pinning special entry types to the top of the day.
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
    // First by weight (recap → timelapse → everything else).
    if (wa !== wb) return wa - wb;
    // Then by time descending (newest first) within each group.
    return b.occurred_at - a.occurred_at;
  });
}

export function Diary({ readAloud, petName }: DiaryProps): JSX.Element {
  const { ttsEnabled } = useTTSEnabled();
  const today = trpc.activity.today.useQuery(undefined, {
    refetchInterval: 30_000,
  });
  const settings = trpc.settings.get.useQuery();
  const distanceUnit = getDistanceUnit(
    settings.data as Record<string, unknown> | undefined,
  );
  const seenIdsRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    // First render: mark everything as already-seen so we don't speak the
    // entire backlog. Subsequent fetches speak only entries with new ids.
    if (!today.data) return;
    if (seenIdsRef.current.size === 0) {
      for (const e of today.data) seenIdsRef.current.add(e.id);
      return;
    }
    if (!readAloud) {
      for (const e of today.data) seenIdsRef.current.add(e.id);
      return;
    }
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) return; // Be conservative — if the user wants quiet, stay quiet.

    for (const entry of today.data) {
      if (seenIdsRef.current.has(entry.id)) continue;
      seenIdsRef.current.add(entry.id);
      try {
        const u = new SpeechSynthesisUtterance(entry.narrative);
        u.rate = 0.95;
        u.pitch = 1.1;
        window.speechSynthesis.speak(u);
      } catch {
        /* speech unavailable — silent fallback */
      }
    }
  }, [today.data, readAloud]);

  return (
    <section aria-labelledby="diary-heading" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2 id="diary-heading" className="display" style={{ margin: 0, fontSize: 22 }}>
        📖 {petName ? `${petName}'s` : 'Pet'} Diary — Today
      </h2>

      {today.isLoading && <p style={{ color: 'var(--text-muted)' }}>Loading today's story…</p>}
      {today.error && (
        <p role="alert" style={{ color: 'var(--danger)' }}>Could not load today's diary.</p>
      )}
      {today.data && today.data.length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>Nothing happened yet today — check back soon!</p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {sortEntries(today.data ?? []).map((entry) => (
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
