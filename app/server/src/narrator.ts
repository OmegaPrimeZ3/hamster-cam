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
import { evaluatePushForEntry } from './push.js';
import { startWheelSession, endWheelSession } from './wheel-odometer.js';

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
  | 'tunnel' | 'exploring' | 'hiding';

/**
 * Heuristic: prefer zone name when present (e.g. `wheel`, `food`, `water`,
 * `bed`/`nest` → resting); fall back to keywords in the camera name. Unknown
 * → 'exploring' so we still emit a friendly entry.
 *
 * The keyword list here is the source of truth for the "Supported zones"
 * reference shown in Settings → Cameras (app/web/src/components/CameraSettings.tsx)
 * — keep them in sync.
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
  if (v.includes('tunnel') || v.includes('tube') || v.includes('pipe')) return 'tunnel';
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

/**
 * Tracks the pet's current activity at the activity level (not per-camera).
 * `cameras` is the set of cameras currently reporting this activity; the
 * activity only ends when this set empties. `odomCameraId` is the camera id
 * whose wheel session is running (null if odometry is not active for this
 * activity).
 */
interface ActiveActivity {
  kind: Activity;
  cameras: Set<string>;
  startedAt: number;
  /** Camera id whose wheel odometer session is running, or null. */
  odomCameraId: number | null;
}

interface PendingEnd {
  event: FrigateEvent;
  activity: Activity;
  /** ms since epoch when the end fired. */
  at: number;
  /** ms since epoch the object first appeared. */
  startedAt: number;
  /** Camera id whose odometer was running, so flushPending can end the right session. */
  odomCameraId: number | null;
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

interface PetState {
  lastSeen: LastSeen | null;
  pending: PendingEnd | null;
  /** Activity-level dedup: the single ongoing activity across all cameras. */
  activeActivity: ActiveActivity | null;
}

const state = new Map<string, PetState>();
const recentByPet = new Map<string, RecentEventEntry[]>();

function getOrInitPetState(pet: string): PetState {
  let s = state.get(pet);
  if (!s) {
    s = { lastSeen: null, pending: null, activeActivity: null };
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

/**
 * How long (ms) before a last-seen reading is considered stale. If Remy
 * hasn't triggered any Frigate events in this window, she's probably napping
 * somewhere off-camera.
 */
const STALE_THRESHOLD_MS = 60_000;

export interface PetStatus {
  /** Classified activity from the zone/camera name. Null when no state. */
  activity: Activity | null;
  /** Zone name from the most recent Frigate event. Null when no state. */
  zone: string | null;
  /** Camera row id of the most recent sighting. Null when no state. */
  cameraId: number | null;
  /** Milliseconds elapsed since the last sighting. Null when no state. */
  sinceMs: number | null;
  /**
   * True when there is no recorded state, or the last sighting is older than
   * STALE_THRESHOLD_MS (pet is probably napping off-camera).
   */
  stale: boolean;
}

/**
 * Returns the live status of the first (and typically only) pet being tracked.
 * When multiple pet labels are in play, we use whichever had the most recent
 * sighting — practical enough for a single-hamster setup.
 */
export function getPetStatus(now: number = Date.now()): PetStatus {
  let newest: { petKey: string; lastSeen: LastSeen } | null = null;
  for (const [petKey, s] of state.entries()) {
    if (s.lastSeen && (!newest || s.lastSeen.at > newest.lastSeen.at)) {
      newest = { petKey, lastSeen: s.lastSeen };
    }
  }
  if (!newest) {
    return { activity: null, zone: null, cameraId: null, sinceMs: null, stale: true };
  }
  const { lastSeen } = newest;
  const sinceMs = now - lastSeen.at;
  const stale = sinceMs > STALE_THRESHOLD_MS;

  // Re-construct a minimal side object so we can reuse classifyActivity.
  const side: FrigateEventPayloadSide = {
    camera: lastSeen.camera,
    label: newest.petKey,
    current_zones: lastSeen.zone ? [lastSeen.zone] : [],
  };
  const activity = classifyActivity(side);
  const cameraId = cameraIdByName(lastSeen.camera);

  return { activity, zone: lastSeen.zone, cameraId, sinceMs, stale };
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
  onEntryWritten: async (entry) => {
    await evaluateBadges();
    await evaluatePushForEntry(entry);
  },
};

function petName(): string {
  return db.getSetting('pet_name') ?? '';
}

function cameraIdByName(name: string): number | null {
  const found = db.listCameras().find((c) => c.name === name);
  return found?.id ?? null;
}

function isCameraWheelEnabled(cameraId: number): boolean {
  const cam = db.getCameraById(cameraId);
  return cam?.wheel_mark_enabled === 1;
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
  } else if (
    params.activity === 'wheel' ||
    params.activity === 'food' ||
    params.activity === 'water' ||
    params.activity === 'bathroom' ||
    params.activity === 'resting' ||
    params.activity === 'tunnel' ||
    params.activity === 'exploring' ||
    params.activity === 'hiding'
  ) {
    const tpl = pickTemplate(params.activity, params.rng);
    narrative = render(tpl, {
      pet,
      duration: params.durationMs != null ? formatDuration(params.durationMs) : '',
    });
  } else {
    // 'recap' and any future activity variants not handled above — the
    // narrator does not write these; they come from dedicated jobs that
    // call db.createDiaryEntry directly with a pre-formed narrative.
    narrative = '';
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

  // Collect wheel odometry before writing the entry so metres land in details.
  const details: Record<string, unknown> = {
    type: pending.event.type,
    camera: pending.event.before.camera,
  };
  if (pending.activity === 'wheel') {
    // Use the stored odomCameraId — it is the camera whose session is actually
    // running (may differ from event.before.camera in multi-camera scenarios).
    const camId = pending.odomCameraId;
    if (camId !== null) {
      try {
        const metres = endWheelSession(camId);
        if (metres !== null) {
          details['wheel_meters'] = metres;
        }
      } catch (err) {
        // Never block diary writes for odometry failures.
        void err;
      }
    }
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
    details,
    rng: deps.rng,
    pet: petName(),
  });
  await deps.onEntryWritten(entry);
  return entry;
}

/**
 * Process one MQTT-delivered Frigate event. May emit zero, one, or two diary
 * entries: e.g. flushing a pending end the moment a transition gets resolved.
 *
 * Multi-camera dedup invariants:
 *  1. At most ONE active wheel odometer session per pet at any time.
 *  2. Simultaneous same-activity across cameras → ONE diary entry.
 *  3. Sequential cross-camera A→B transitions still produce one transition entry.
 *  4. Single-camera behavior is unchanged.
 *  5. Concurrent DIFFERENT activities on different cameras (overlapping detections):
 *     the displaced activity is written as a STANDALONE entry (if its dwell meets
 *     minDwellMs), its odometer session is always ended, and the new activity
 *     starts cleanly. No transition entry is emitted because the displaced
 *     activity never signalled it left — detections simply overlapped.
 *
 * The per-pet `activeActivity` field is the source of truth for invariants 1&2.
 * A `new` event joins the existing activity when the activity kind matches;
 * it only starts a fresh activity (and possibly a new odometer session) when
 * the activity is different or there is no current activity. An `end` event
 * removes the camera from the activity set; only when the set empties does the
 * pending-end / transition-window logic run.
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
    const activity = classifyActivity(event.after);
    petState.lastSeen = { camera: cameraName, zone, at: nowMs };

    // -----------------------------------------------------------------------
    // Check if the pet is already doing this same activity on another camera.
    // If so, just add this camera to the set — no new session, no new entry.
    // -----------------------------------------------------------------------
    if (petState.activeActivity && petState.activeActivity.kind === activity) {
      petState.activeActivity.cameras.add(cameraName);

      // Edge case: if the existing activity has no odometer running yet (the
      // first camera that claimed it had wheel_mark_enabled=0) but this camera
      // has it enabled, start the session now on this camera.
      if (activity === 'wheel' && petState.activeActivity.odomCameraId === null) {
        const camId = cameraIdByName(cameraName);
        if (camId !== null) {
          try {
            startWheelSession(camId, petState.activeActivity.startedAt);
            if (isCameraWheelEnabled(camId)) {
              petState.activeActivity.odomCameraId = camId;
            }
          } catch (err) {
            void err;
          }
        }
      }
      return written;
    }

    // -----------------------------------------------------------------------
    // Concurrent different-activity displacement (Invariant 5).
    //
    // If there is an active activity of a DIFFERENT kind, two camera fields of
    // view are overlapping at the same moment — e.g. cam1 still classifies
    // 'wheel' while cam2 fires 'food'. We cannot wait for a 'end' that may
    // never arrive (the detection sets simply overlapped). Instead:
    //   a) Always end the displaced odometer session so no ffmpeg leak occurs.
    //   b) If the displaced dwell meets minDwellMs, write a STANDALONE entry
    //      for it (no transition — the activity never signalled departure).
    //      If dwell is below the threshold, discard silently (fly-through).
    //   c) Null out activeActivity so the new-activity start below is clean.
    // -----------------------------------------------------------------------
    const displaced = petState.activeActivity;
    if (displaced !== null && displaced.kind !== activity) {
      const displacedDwellMs = nowMs - displaced.startedAt;

      // (a) Always end the odometer session for the displaced activity.
      let displacedMetres: number | null = null;
      if (displaced.odomCameraId !== null) {
        try {
          displacedMetres = endWheelSession(displaced.odomCameraId);
        } catch (err) {
          // Never let odometry errors block the narrator path.
          void err;
        }
      }

      // (b) Write a standalone entry when dwell is long enough.
      if (displacedDwellMs >= tuning.minDwellMs) {
        // Pick a representative camera from the displaced activity's set.
        const representativeCamera = [...displaced.cameras][0] ?? cameraName;
        const displacedDetails: Record<string, unknown> = { camera: representativeCamera };
        if (displacedMetres !== null) {
          displacedDetails['wheel_meters'] = displacedMetres;
        }
        const displacedEntry = writeEntry({
          activity: displaced.kind,
          occurredAt: nowMs,
          cameraId: cameraIdByName(representativeCamera),
          durationMs: displacedDwellMs,
          fromCameraId: null,
          toCameraId: null,
          fromZone: null,
          toZone: null,
          details: displacedDetails,
          rng: deps.rng,
          pet: petName(),
        });
        await deps.onEntryWritten(displacedEntry);
        written.push(displacedEntry);
      }
      // Fly-through (dwell below threshold): discard the displaced entry.
      // The odometer was already ended above regardless of dwell.

      // (c) Clear so the new-activity start block begins cleanly.
      petState.activeActivity = null;
    }

    // -----------------------------------------------------------------------
    // Different activity (or no current activity): this is a genuine start.
    // First check if this 'new' resolves a pending transition.
    // -----------------------------------------------------------------------
    const pending = petState.pending;
    if (
      pending &&
      pending.event.before.camera !== cameraName &&
      nowMs - pending.at <= tuning.transitionWindowMs
    ) {
      clearTimeout(pending.timer);
      petState.pending = null;
      petState.activeActivity = null;
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

    // Start a new activity tracker for this pet.
    let odomCameraId: number | null = null;
    if (activity === 'wheel') {
      const camId = cameraIdByName(cameraName);
      if (camId !== null) {
        try {
          startWheelSession(camId, nowMs);
          if (isCameraWheelEnabled(camId)) {
            odomCameraId = camId;
          }
        } catch (err) {
          // Never block the narrator path for odometry errors.
          void err;
        }
      }
    }

    petState.activeActivity = {
      kind: activity,
      cameras: new Set([cameraName]),
      startedAt: nowMs,
      odomCameraId,
    };

    return written;
  }

  if (event.type === 'update') {
    petState.lastSeen = { camera: cameraName, zone, at: nowMs };
    return written;
  }

  // -------------------------------------------------------------------------
  // event.type === 'end'
  // Remove this camera from the active-activity set. Only proceed to the
  // pending-end / flush logic when all cameras have ended this activity.
  // -------------------------------------------------------------------------
  if (petState.activeActivity) {
    petState.activeActivity.cameras.delete(cameraName);
    if (petState.activeActivity.cameras.size > 0) {
      // Other cameras are still reporting the same activity — not done yet.
      petState.lastSeen = { camera: cameraName, zone, at: nowMs };
      return written;
    }
    // All cameras ended; fall through to the pending-end logic below.
    // The odomCameraId from the active activity is what we need for flush.
  }

  // Buffer the end briefly to see if a different-camera 'new' arrives (that
  // would be a A→B transition rather than a genuine stop).
  if (petState.pending) {
    // Flush whatever was pending first — defensive against rapid-fire ends.
    const flushed = await flushPending(petKey, petState.pending, deps);
    if (flushed) written.push(flushed);
  }
  const activity = classifyActivity(event.after);
  // Carry the odomCameraId from the activity tracker into the pending object
  // so flushPending ends the right session.
  const odomCameraId = petState.activeActivity?.odomCameraId ?? null;
  petState.activeActivity = null;

  const pending: PendingEnd = {
    event,
    activity,
    at: occurredAtMs,
    startedAt: startMs,
    odomCameraId,
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
  for (const s of state.values()) {
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
