// app/server/src/narrator.ts
// MQTT Frigate-event → diary-entry pipeline including cross-camera transition
// coalescing (TRANSITION_WINDOW_MS, MIN_DWELL_MS).
//
// PLAN §5.4 (cross-camera tracking).
//
// State is in-memory; this module owns:
//   - a per-pet `lastSeen` map (rolling)
//   - a per-pet `pendingEnd` map (an end-event held briefly to see if a
//     follow-up event on a different camera arrives — that's a transition)
//   - a per-pet event ring buffer used by `activity.recentEvents` for tuning
//
// The narrator is fully testable: `handleFrigateEvent` does all I/O via the
// `db` module, time can be controlled by passing `now`, and template choice
// is overridable for deterministic assertions.

import * as db from './db.js';
import { evaluateBadges, type BadgeId } from './badges.js';
import { pickTemplate, render } from './narratives.js';

// ---------------------------------------------------------------------------
// Tunables — read once at startup, refresh on demand (e.g. after a settings
// update). Defaults track PLAN §5.4.
// ---------------------------------------------------------------------------

interface NarratorTuning {
  transitionWindowMs: number;
  minDwellMs: number;
}

let tuning: NarratorTuning = { transitionWindowMs: 8_000, minDwellMs: 2_000 };

/** Re-read tunables from `settings` (called from index.ts on startup & after settings.update). */
export function refreshNarratorTunings(): void {
  try {
    const transition = Number.parseInt(db.getSetting('transition_window_ms') ?? '8000', 10);
    const dwell = Number.parseInt(db.getSetting('min_dwell_ms') ?? '2000', 10);
    tuning = {
      transitionWindowMs: Number.isFinite(transition) ? transition : 8_000,
      minDwellMs: Number.isFinite(dwell) ? dwell : 2_000,
    };
  } catch {
    // DB not yet initialised — keep defaults.
  }
}

/** Test helper to force tunables without touching the DB. */
export function setNarratorTuningsForTests(t: NarratorTuning): void {
  tuning = { ...t };
}

// ---------------------------------------------------------------------------
// Event shape — only the fields we care about. The full Frigate payload
// includes many more, but they're all optional from our perspective.
// ---------------------------------------------------------------------------

export interface FrigateEventPayloadSide {
  camera: string;
  label: string;
  current_zones?: readonly string[];
  start_time?: number; // seconds since epoch
  end_time?: number | null;
  has_snapshot?: boolean;
  snapshot?: { frame_time?: number } | null;
}

export interface FrigateEvent {
  type: 'new' | 'update' | 'end';
  before: FrigateEventPayloadSide;
  after: FrigateEventPayloadSide;
}

// ---------------------------------------------------------------------------
// Activity classification — maps a camera (and its zones) to a narrative key.
// ---------------------------------------------------------------------------

type Activity =
  | 'wheel' | 'food' | 'water' | 'bathroom' | 'resting'
  | 'exploring' | 'hiding';

/**
 * Heuristic: prefer zone name when present (e.g. `wheel`, `food`, `water`,
 * `bed`/`nest` → resting); fall back to keywords in the camera name. Unknown
 * → 'exploring' so we still emit a friendly entry.
 */
function classifyActivity(side: FrigateEventPayloadSide): Activity {
  const zones = side.current_zones ?? [];
  for (const z of zones) {
    const k = matchKeyword(z);
    if (k) return k;
  }
  const k = matchKeyword(side.camera);
  return k ?? 'exploring';
}

function matchKeyword(value: string): Activity | null {
  const v = value.toLowerCase();
  if (v.includes('wheel')) return 'wheel';
  if (v.includes('food') || v.includes('bowl') || v.includes('feed')) return 'food';
  if (v.includes('water') || v.includes('drink')) return 'water';
  if (v.includes('bathroom') || v.includes('potty') || v.includes('litter') || v.includes('toilet')) return 'bathroom';
  if (v.includes('bed') || v.includes('nest') || v.includes('sleep') || v.includes('rest')) return 'resting';
  if (v.includes('hide') || v.includes('cave') || v.includes('burrow')) return 'hiding';
  return null;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface LastSeen {
  camera: string;
  zone: string | null;
  at: number;
}

interface PendingEnd {
  event: FrigateEvent;
  activity: Activity;
  /** ms since epoch when the end fired. */
  at: number;
  /** ms since epoch the object first appeared. */
  startedAt: number;
  /** Timer that, if it fires, flushes the pending end as a standalone entry. */
  timer: NodeJS.Timeout;
}

interface RecentEventEntry {
  camera: string;
  label: string;
  zone: string | null;
  type: 'new' | 'update' | 'end';
  at: number;
}

const RECENT_RING_SIZE = 20;

const state = new Map<string, {
  lastSeen: LastSeen | null;
  pending: PendingEnd | null;
}>();
const recentByPet = new Map<string, RecentEventEntry[]>();

function getOrInitPetState(pet: string): { lastSeen: LastSeen | null; pending: PendingEnd | null } {
  let s = state.get(pet);
  if (!s) {
    s = { lastSeen: null, pending: null };
    state.set(pet, s);
  }
  return s;
}

function recordRecent(pet: string, entry: RecentEventEntry): void {
  let buf = recentByPet.get(pet);
  if (!buf) {
    buf = [];
    recentByPet.set(pet, buf);
  }
  buf.push(entry);
  while (buf.length > RECENT_RING_SIZE) buf.shift();
}

/** Read the in-memory ring buffer — backs `activity.recentEvents` for tuning. */
export function getRecentEvents(): RecentEventEntry[] {
  const all: RecentEventEntry[] = [];
  for (const buf of recentByPet.values()) all.push(...buf);
  return all.sort((a, b) => b.at - a.at).slice(0, RECENT_RING_SIZE);
}

// ---------------------------------------------------------------------------
// Diary writer
// ---------------------------------------------------------------------------

interface NarratorDeps {
  /** Inject a clock for tests. */
  now?: () => number;
  /** Inject the RNG for deterministic template selection in tests. */
  rng?: () => number;
  /** Invoked AFTER a diary row is written. Defaults to the badge engine. */
  onEntryWritten?: (entry: db.DiaryEntryRow) => Promise<void> | void;
}

const defaultDeps: Required<NarratorDeps> = {
  now: () => Date.now(),
  rng: () => Math.random(),
  onEntryWritten: async (_entry) => {
    await evaluateBadges();
  },
};

function petName(): string {
  return db.getSetting('pet_name') ?? '';
}

function cameraIdByName(name: string): number | null {
  const found = db.listCameras().find((c) => c.name === name);
  return found?.id ?? null;
}

function formatDuration(durationMs: number): string {
  const totalSec = Math.max(0, Math.round(durationMs / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (sec === 0) return `${min} min`;
  return `${min} min ${sec}s`;
}

interface WriteParams {
  activity: db.DiaryActivity;
  occurredAt: number;
  cameraId: number | null;
  durationMs: number | null;
  fromCameraId: number | null;
  toCameraId: number | null;
  fromZone: string | null;
  toZone: string | null;
  details: Record<string, unknown> | null;
  rng: () => number;
  pet: string;
}

function writeEntry(params: WriteParams): db.DiaryEntryRow {
  const pet = params.pet || 'they';
  let narrative: string;
  if (params.activity === 'transition') {
    const tpl = pickTemplate('transition', params.rng);
    narrative = render(tpl, {
      pet,
      from: params.fromZone ?? 'somewhere',
      to: params.toZone ?? 'somewhere',
    });
  } else if (params.activity === 'snapshot') {
    narrative = render(pickTemplate('snapshot', params.rng), { pet });
  } else if (params.activity === 'timelapse') {
    narrative = render(pickTemplate('timelapse', params.rng), { pet, date: '' });
  } else {
    const tpl = pickTemplate(params.activity, params.rng);
    narrative = render(tpl, {
      pet,
      duration: params.durationMs != null ? formatDuration(params.durationMs) : '',
    });
  }

  return db.createDiaryEntry({
    occurred_at: params.occurredAt,
    kind: 'narrative',
    activity: params.activity,
    narrative,
    pet_name: pet || null,
    camera_id: params.cameraId,
    from_camera_id: params.fromCameraId,
    to_camera_id: params.toCameraId,
    duration_ms: params.durationMs,
    snapshot_id: null,
    media_path: null,
    details: params.details ? JSON.stringify(params.details) : null,
  });
}

// ---------------------------------------------------------------------------
// Core handler
// ---------------------------------------------------------------------------

interface ScheduledFlushDeps {
  now: () => number;
  rng: () => number;
  onEntryWritten: (entry: db.DiaryEntryRow) => Promise<void> | void;
}

async function flushPending(
  petKey: string,
  pending: PendingEnd,
  deps: ScheduledFlushDeps,
): Promise<db.DiaryEntryRow | null> {
  clearTimeout(pending.timer);
  const s = getOrInitPetState(petKey);
  if (s.pending === pending) s.pending = null;
  const dwellMs = pending.at - pending.startedAt;
  if (dwellMs < tuning.minDwellMs) {
    // Fly-through — discard.
    return null;
  }
  const entry = writeEntry({
    activity: pending.activity,
    occurredAt: pending.at,
    cameraId: cameraIdByName(pending.event.before.camera),
    durationMs: dwellMs,
    fromCameraId: null,
    toCameraId: null,
    fromZone: null,
    toZone: null,
    details: { type: pending.event.type, camera: pending.event.before.camera },
    rng: deps.rng,
    pet: petName(),
  });
  await deps.onEntryWritten(entry);
  return entry;
}

/**
 * Process one MQTT-delivered Frigate event. May emit zero, one, or two diary
 * entries: e.g. flushing a pending end the moment a transition gets resolved.
 */
export async function handleFrigateEvent(
  event: FrigateEvent,
  rawDeps: NarratorDeps = {},
): Promise<db.DiaryEntryRow[]> {
  const deps: Required<NarratorDeps> = {
    now: rawDeps.now ?? defaultDeps.now,
    rng: rawDeps.rng ?? defaultDeps.rng,
    onEntryWritten: rawDeps.onEntryWritten ?? defaultDeps.onEntryWritten,
  };
  const petKey = (event.after.label || event.before.label || 'pet').toLowerCase();
  const cameraName = event.after.camera || event.before.camera;
  const zones = event.after.current_zones ?? event.before.current_zones ?? [];
  const zone = zones[0] ?? null;
  const nowMs = deps.now();
  const startMs = secsToMs(event.before.start_time) ?? nowMs;
  const endMs = secsToMs(event.after.end_time) ?? nowMs;
  const occurredAtMs = event.type === 'end' ? endMs : nowMs;

  recordRecent(petKey, {
    camera: cameraName,
    label: event.after.label || event.before.label || 'unknown',
    zone,
    type: event.type,
    at: nowMs,
  });

  const petState = getOrInitPetState(petKey);
  const written: db.DiaryEntryRow[] = [];

  if (event.type === 'new') {
    // A new appearance — possibly the second leg of a transition.
    const pending = petState.pending;
    if (
      pending &&
      pending.event.before.camera !== cameraName &&
      nowMs - pending.at <= tuning.transitionWindowMs
    ) {
      clearTimeout(pending.timer);
      petState.pending = null;
      // Cancel the standalone-flush; emit a transition instead.
      const dwellMs = pending.at - pending.startedAt;
      if (dwellMs >= tuning.minDwellMs) {
        const fromZone = classifyActivity(pending.event.before);
        const toZone = classifyActivity(event.after);
        const entry = writeEntry({
          activity: 'transition',
          occurredAt: nowMs,
          cameraId: null,
          durationMs: nowMs - pending.startedAt,
          fromCameraId: cameraIdByName(pending.event.before.camera),
          toCameraId: cameraIdByName(cameraName),
          fromZone,
          toZone,
          details: {
            from: pending.event.before.camera,
            to: cameraName,
            dwell_ms: dwellMs,
          },
          rng: deps.rng,
          pet: petName(),
        });
        await deps.onEntryWritten(entry);
        written.push(entry);
      }
    }
    petState.lastSeen = { camera: cameraName, zone, at: nowMs };
    return written;
  }

  if (event.type === 'update') {
    petState.lastSeen = { camera: cameraName, zone, at: nowMs };
    return written;
  }

  // event.type === 'end' — buffer briefly to see if a different-camera 'new'
  // arrives. If yes, that branch above emits a transition; otherwise the
  // timer below flushes a standalone entry.
  if (petState.pending) {
    // Flush whatever was pending first — defensive against rapid-fire ends.
    const flushed = await flushPending(petKey, petState.pending, deps);
    if (flushed) written.push(flushed);
  }
  const activity = classifyActivity(event.after);
  const pending: PendingEnd = {
    event,
    activity,
    at: occurredAtMs,
    startedAt: startMs,
    // Placeholder; assigned below.
    timer: undefined as unknown as NodeJS.Timeout,
  };
  pending.timer = setTimeout(() => {
    void flushPending(petKey, pending, deps);
  }, tuning.transitionWindowMs);
  // Don't keep the event loop alive for these timers.
  pending.timer.unref?.();
  petState.pending = pending;
  petState.lastSeen = { camera: cameraName, zone, at: nowMs };
  return written;
}

/** Flush any pending entries — called from index.ts on SIGTERM. */
export async function flushPendingEntries(): Promise<db.DiaryEntryRow[]> {
  const deps: ScheduledFlushDeps = {
    now: defaultDeps.now,
    rng: defaultDeps.rng,
    onEntryWritten: defaultDeps.onEntryWritten,
  };
  const out: db.DiaryEntryRow[] = [];
  for (const [petKey, s] of state.entries()) {
    if (s.pending) {
      const written = await flushPending(petKey, s.pending, deps);
      if (written) out.push(written);
    }
  }
  return out;
}

/** Reset all in-memory state (used by tests). */
export function resetNarratorState(): void {
  for (const [, s] of state) {
    if (s.pending) clearTimeout(s.pending.timer);
  }
  state.clear();
  recentByPet.clear();
}

/**
 * Save a manual "Take a photo!" snapshot — used by tRPC `activity.snapshot`.
 * Writes both a `snapshots` row and a diary entry of kind 'snapshot'. The
 * `media_path` is a relative path under STORAGE_PATH.
 */
export async function saveManualSnapshot(input: {
  cameraId: number;
  takenAt: number;
  mediaPath: string;
  rng?: () => number;
}): Promise<db.DiaryEntryRow> {
  const snapshot = db.createSnapshot({
    camera_id: input.cameraId,
    taken_at: input.takenAt,
    path: input.mediaPath,
  });
  const pet = petName();
  const narrative = render(pickTemplate('snapshot', input.rng ?? Math.random), { pet: pet || 'they' });
  const entry = db.createDiaryEntry({
    occurred_at: input.takenAt,
    kind: 'snapshot',
    activity: 'snapshot',
    narrative,
    pet_name: pet || null,
    camera_id: input.cameraId,
    from_camera_id: null,
    to_camera_id: null,
    duration_ms: null,
    snapshot_id: snapshot.id,
    media_path: input.mediaPath,
    details: null,
  });
  await evaluateBadges();
  return entry;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function secsToMs(secs: number | null | undefined): number | null {
  if (typeof secs !== 'number' || !Number.isFinite(secs)) return null;
  return Math.round(secs * 1000);
}

// Exposed for tests / future subscription wiring.
export type BadgeEarnedHook = (badges: BadgeId[]) => void;
