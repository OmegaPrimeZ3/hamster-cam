// app/server/src/diary-events.ts
//
// In-process pub/sub for diary-row mutations. The single subscriber is the
// `/diary/stream` SSE handler (see diary-stream.ts); the publishers are the
// db.ts diary-write helpers (createDiaryEntry, extendDiaryEntry) which are the
// chokepoint every code path — narrator, recap, timelapse, manual snapshot,
// share, AI backfill — funnels through.
//
// Kept in its own module (no db.ts import) so db.ts can publish without a
// circular dependency. EventEmitter is synchronous, but listeners only push
// the row onto a buffered SSE response stream — they never re-enter db.ts.
//
// Roll-back safety: better-sqlite3 transactions are synchronous, and every
// caller that wraps createDiaryEntry in a transaction makes it the LAST
// statement inside the transaction body — so by the time we emit, no further
// code can throw and trigger ROLLBACK on the same row. Non-transactional
// callers (narrator etc.) carry no rollback risk at all.

import { EventEmitter } from 'node:events';

import type { DiaryEntryRow } from './db.js';

export type DiaryEventKind = 'create' | 'update';

export interface DiaryEvent {
  kind: DiaryEventKind;
  row: DiaryEntryRow;
}

export type DiaryEventListener = (event: DiaryEvent) => void;

const emitter = new EventEmitter();
// SSE allows many simultaneous clients; raise the soft cap so Node doesn't
// log a MaxListenersExceededWarning for ~10+ logged-in browser tabs.
emitter.setMaxListeners(0);

const EVENT_NAME = 'diary';

/** Publish a diary-row mutation. Called from db.ts after a successful write. */
export function emitDiaryEvent(event: DiaryEvent): void {
  emitter.emit(EVENT_NAME, event);
}

/**
 * Subscribe to diary-row mutations. Returns an unsubscribe function — call it
 * from the SSE connection's close handler so listeners do not leak.
 */
export function subscribeDiaryEvents(listener: DiaryEventListener): () => void {
  emitter.on(EVENT_NAME, listener);
  return () => emitter.off(EVENT_NAME, listener);
}

/** Test helper — clears every listener between runs. */
export function resetDiaryEventsForTests(): void {
  emitter.removeAllListeners(EVENT_NAME);
}
