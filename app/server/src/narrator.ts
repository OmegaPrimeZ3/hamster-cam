// app/server/src/narrator.ts
// MQTT Frigate-event → diary-entry pipeline including cross-camera transition
// coalescing (TRANSITION_WINDOW_MS, MIN_DWELL_MS). Stage 1 ships the signatures
// the narrator orchestration calls; Stage 2a implements the bodies and the
// associated narrator.test.ts fixtures.
//
// PLAN §5.4 (cross-camera tracking).

import type { DiaryEntryRow } from './db.js';

/** Raw Frigate event payload — shape we care about; Stage 2a will tighten. */
export interface FrigateEvent {
  type: 'new' | 'update' | 'end';
  before: {
    camera: string;
    label: string;
    current_zones?: readonly string[];
    start_time: number;
  };
  after: {
    camera: string;
    label: string;
    current_zones?: readonly string[];
    end_time?: number | null;
    snapshot?: { frame_time?: number } | null;
  };
}

/**
 * Process one MQTT-delivered Frigate event. May emit zero, one, or (rarely)
 * multiple diary entries depending on coalescing state.
 */
export async function handleFrigateEvent(_event: FrigateEvent): Promise<DiaryEntryRow[]> {
  throw new Error('Stage 2a will implement narrator.handleFrigateEvent');
}

/**
 * Flush any pending transition-window state so partial journeys don't get
 * lost on server shutdown. Called from index.ts on SIGTERM.
 */
export async function flushPendingEntries(): Promise<DiaryEntryRow[]> {
  throw new Error('Stage 2a will implement narrator.flushPendingEntries');
}

/** Reset all in-memory state (used by tests). */
export function resetNarratorState(): void {
  throw new Error('Stage 2a will implement narrator.resetNarratorState');
}
