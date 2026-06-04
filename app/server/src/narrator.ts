// app/server/src/narrator.ts
// MQTT Frigate-event → diary-entry pipeline including cross-camera transition
// coalescing (TRANSITION_WINDOW_MS, MIN_DWELL_MS).
//
// PLAN §5.4 (cross-camera tracking).
//
// ============================================================================
// ZONE-ENTRY / ZONE-EXIT MODEL (updated 2026-05-27)
// ============================================================================
//
// State is in-memory; this module owns:
//   - a per-pet `zoneVisits` map: tracks every open zone visit (key = Activity
//     name, value = ZoneVisit). Each visit records which cameras are currently
//     reporting it, when it started, and any active odometer session.
//   - a per-pet `pendingEnd` slot: holds deferred zone-exit entries briefly
//     after the Frigate object track ends, to detect cross-camera A→B
//     transitions before committing them.
//   - a per-pet event ring buffer used by `activity.recentEvents` for tuning.
//
// EMISSION STRATEGY: emit at zone EXIT so duration is always known precisely.
// Duration = zone-exit timestamp minus zone-entered timestamp.
//
// TWO KINDS OF ZONE-EXIT:
//
//   MID-TRACK zone exit (new/update event changes current_zones):
//     The zone visit closes and the entry is emitted IMMEDIATELY. These are
//     genuine within-track zone transitions (e.g. wheel → food mid-object-life)
//     and need no cross-camera disambiguation.
//
//   TRACK-END zone exit (end event, pet still on OTHER cameras):
//     The visits closed by this camera's 'end' are emitted IMMEDIATELY because
//     the pet is still visible on other cameras — no cross-camera transition is
//     possible from this specific 'end'.
//
//   TRACK-END zone exit (end event, LAST camera for this pet):
//     The zone visit closes but the entry is DEFERRED into a `PendingEnd` slot
//     with a transition-window timer. If a `new` event arrives on a DIFFERENT
//     camera within transitionWindowMs, a single TRANSITION entry is emitted
//     instead (the deferred entries are dropped). If the window expires with no
//     follow-up, the deferred entries are committed to the diary.
//
// ZONE-VISIT LIFECYCLE:
//   1. Any event (new/update/end) runs classifyZones() on after.current_zones.
//      classifyZones() returns the set of known Activities present in that list;
//      when the list is empty (or no known keywords), returns {'exploring'}.
//   2. Zones newly present (in current but not in zoneVisits) → open a visit.
//   3. Zones no longer present (in zoneVisits but not in current):
//      • mid-track (new/update): close immediately.
//      • track-end, other cameras still alive: close immediately.
//      • track-end, last camera: defer via PendingEnd.
//   4. For 'end' events the camera is removed from every visit; visits whose
//      camera set empties are closed per rule 3.
//   5. When ALL zone visits close after an 'end', queue the PendingEnd.
//
// MULTI-CAMERA DEDUP INVARIANTS:
//   1. At most ONE active wheel odometer session per pet at any time.
//   2. Simultaneous same-zone across cameras → ONE diary entry.
//   3. Sequential cross-camera A→B transitions → ONE transition entry.
//   4. Single-camera behaviour is unchanged.
//   5. Concurrent DIFFERENT zones on different cameras: each zone visit is
//      independent. Entries are only emitted when the respective visit closes.
//
// DEBOUNCE: Frigate fires many 'update' events for a stationary object all
// reporting the same current_zones. The diff in step 1 means we open a visit
// exactly once per zone-entry and emit exactly once per zone-exit. Re-entering
// a zone after leaving it opens a fresh visit.
//
// COMMIT GATE (false-positive / uncommitted-track filter):
//   Frigate publishes MQTT events for every tracked object, including objects
//   it later discards as false positives that never appear in the Explore UI
//   (no snapshot saved, no clip saved). A sustained false-positive track (e.g.
//   lighting flicker, wheel motion artifact) that outlives exploringMinDwellMs
//   would previously be written to the diary as 'exploring' — a phantom entry.
//
//   The gate invariant: a zone-visit diary entry may only be written if the
//   Frigate object was actually committed, defined as:
//     • false_positive is NOT true (Frigate has not flagged it as a bad detect)
//     • AND at least one of has_snapshot or has_clip is true (it appears in UI)
//
//   Values are carried on the ZoneVisit and updated on every incoming event so
//   we always hold the freshest assessment. The 'end' event is the authoritative
//   source — by end-time Frigate has made its final save decision.
//
//   The gate applies to ALL Frigate-event-driven emission paths:
//     - mid-track zone-exit (commitDeferred from the mid-track close loop)
//     - track-end other-cameras-alive (commitDeferred from sub-case A)
//     - track-end last-camera deferred flush (commitDeferred from flushPending)
//   It does NOT apply to: snapshot, timelapse, recap, disk-watch — those are
//   not driven by Frigate object tracks.
//
//   When a visit fails the gate the wheel odometer session is still ended
//   cleanly (prepareCloseVisit calls endWheelSession before the gate check).
//
// The narrator is fully testable: `handleFrigateEvent` does all I/O via the
// `db` module, time can be controlled by passing `now`, and template choice
// is overridable for deterministic assertions.

import * as db from './db.js';
import { evaluateBadges, type BadgeId } from './badges.js';
import { childLogger } from './logger.js';
import { pickTemplate, render } from './narratives.js';
import { evaluatePushForEntry } from './push.js';
import { startWheelSession, endWheelSession } from './wheel-odometer.js';

const log = childLogger('narrator');

// ---------------------------------------------------------------------------
// Tunables — read once at startup, refresh on demand (e.g. after a settings
// update). Defaults track PLAN §5.4.
// ---------------------------------------------------------------------------

export interface NarratorTuning {
  transitionWindowMs: number;
  minDwellMs: number;
  /**
   * Minimum dwell before an 'exploring' visit is written to the diary.
   * Defaults to 60 000 ms (1 minute) — much higher than minDwellMs so casual
   * cage wandering is suppressed and only sustained exploration gets logged.
   */
  exploringMinDwellMs: number;
  /**
   * When false (the default), cross-camera transition entries are dropped
   * entirely — they are connective filler that buries meaningful events.
   * Set to true in settings to restore them.
   */
  transitionEntriesEnabled: boolean;
}

let tuning: NarratorTuning = {
  transitionWindowMs: 8_000,
  minDwellMs: 2_000,
  exploringMinDwellMs: 60_000,
  transitionEntriesEnabled: false,
};

/**
 * Back-to-back same-activity coalescing window. When a non-wheel zone visit
 * closes and the most recent diary entry is the SAME activity and ended within
 * this gap, we extend that entry instead of writing a new one — this is what
 * stops "Exploring → Exploring" runs of near-identical entries. Wheel is
 * excluded so every run keeps its own odometer distance. A larger gap is
 * treated as a genuinely separate episode and gets its own entry.
 */
const COALESCE_WINDOW_MS = 120_000;

/** Re-read tunables from `settings` (called from index.ts on startup & after settings.update). */
export function refreshNarratorTunings(): void {
  try {
    const transition = Number.parseInt(db.getSetting('transition_window_ms') ?? '8000', 10);
    const dwell = Number.parseInt(db.getSetting('min_dwell_ms') ?? '2000', 10);
    const exploringDwell = Number.parseInt(db.getSetting('exploring_min_dwell_ms') ?? '60000', 10);
    const transitionEnabled = db.getSetting('transition_entries_enabled');
    tuning = {
      transitionWindowMs: Number.isFinite(transition) ? transition : 8_000,
      minDwellMs: Number.isFinite(dwell) ? dwell : 2_000,
      exploringMinDwellMs: Number.isFinite(exploringDwell) ? exploringDwell : 60_000,
      transitionEntriesEnabled: transitionEnabled === 'true' || transitionEnabled === '1',
    };
  } catch {
    // DB not yet initialised — keep defaults.
  }
}

/** Test helper — returns the current in-memory tuning snapshot. */
export function getNarratorTuningsForTests(): NarratorTuning {
  return { ...tuning };
}

/**
 * Test helper to force tunables without touching the DB.
 * Accepts a partial — unspecified fields keep the current default.
 */
export function setNarratorTuningsForTests(t: Partial<NarratorTuning>): void {
  tuning = {
    transitionWindowMs: 8_000,
    minDwellMs: 2_000,
    exploringMinDwellMs: 60_000,
    transitionEntriesEnabled: false,
    ...t,
  };
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
  has_clip?: boolean;
  /**
   * Whether Frigate has classified this track as a false positive. When true
   * the object was detected but discarded — it will NOT appear in the Explore
   * UI and must not produce a diary entry.
   */
  false_positive?: boolean;
  /**
   * Best confidence score achieved across the track's lifetime. Set on update/
   * end events by Frigate. `score` is the current-frame confidence; `top_score`
   * is the peak achieved so far. We record both for diagnostic details but the
   * commit gate only uses `false_positive` and the saved-media flags.
   */
  top_score?: number;
  score?: number;
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

/**
 * Classify ALL known-zone Activities present in `current_zones`. Returns the
 * full set so callers can diff against currently-open visits.
 *
 * If no known zones are present, returns a set containing just 'exploring'
 * (the fallback for genuine open-space wandering).
 */
function classifyZones(side: FrigateEventPayloadSide): Set<Activity> {
  const known = new Set<Activity>();
  for (const z of side.current_zones ?? []) {
    const k = matchKeyword(z);
    if (k) known.add(k);
  }
  // Camera name as a fallback keyword source (same heuristic as before).
  if (known.size === 0) {
    const k = matchKeyword(side.camera);
    if (k) known.add(k);
  }
  if (known.size === 0) known.add('exploring');
  return known;
}

export function matchKeyword(value: string): Activity | null {
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
 * Represents one open zone visit. Multiple cameras can contribute to the same
 * visit (multi-camera dedup invariant 2). The visit closes when the cameras
 * set empties after a zone departure.
 */
interface ZoneVisit {
  /** When this zone was first entered (ms since epoch). */
  startedAt: number;
  /** All cameras currently reporting this zone for this pet. */
  cameras: Set<string>;
  /** Camera id whose wheel odometer session is running (null if none). */
  odomCameraId: number | null;
  /**
   * Commit-gate fields — carried from the most recent Frigate event for this
   * track. `undefined` means the field has not yet been reported (treat as
   * "not false positive" / "not saved" conservatively). On track 'end' events
   * Frigate has made its final save decision, so these values are authoritative.
   *
   * false_positive: true → discard entry (Frigate flagged as bad detect).
   * hasSnapshot / hasClip: at least one must be true to allow emission.
   */
  falsePositive: boolean | undefined;
  hasSnapshot: boolean | undefined;
  hasClip: boolean | undefined;
}

/**
 * A closed zone visit whose entry has been computed but not yet committed.
 * Stored in PendingEnd so we can suppress the entry if a cross-camera
 * transition fires before the window expires.
 */
interface DeferredEntry {
  activity: Activity;
  durationMs: number;
  occurredAt: number;
  cameraId: number | null;
  details: Record<string, unknown>;
  /**
   * Commit-gate values snapshotted from the ZoneVisit at close time. The
   * authoritative values come from the 'end' event; for mid-track closes the
   * values are whatever Frigate last reported (could be undefined for a very
   * short track). See the COMMIT GATE comment block at the top of this file.
   *
   * `undefined` is treated conservatively at emission time:
   *   falsePositive=undefined → treat as NOT false positive (allow emission).
   *   hasSnapshot/hasClip=undefined → treat as NOT saved (block emission).
   */
  falsePositive: boolean | undefined;
  hasSnapshot: boolean | undefined;
  hasClip: boolean | undefined;
}

/**
 * Holds deferred zone-exit entries after the LAST camera for a pet ends.
 * If a 'new' event on a different camera arrives within transitionWindowMs,
 * a TRANSITION entry replaces the deferred entries. Otherwise the timer fires
 * and the deferred entries are committed.
 */
interface PendingEnd {
  /** Dominant activity at end time — used to classify the transition fromZone. */
  activity: Activity;
  /** Camera name where the track ended. */
  camera: string;
  /** ms since epoch when the end fired. */
  at: number;
  /** ms since epoch of the original track start (for transition dwell calc). */
  startedAt: number;
  /** Deferred zone-exit entries — committed if no transition follows. */
  deferred: DeferredEntry[];
  /** Timer that commits deferred entries when transition window expires. */
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
  /**
   * Zone-visit tracking: key = Activity name, value = open ZoneVisit.
   * Source of truth for dedup invariants 1 (one odometer session) and
   * 2 (same zone → one entry).
   */
  zoneVisits: Map<Activity, ZoneVisit>;
}

const state = new Map<string, PetState>();
const recentByPet = new Map<string, RecentEventEntry[]>();

function getOrInitPetState(pet: string): PetState {
  let s = state.get(pet);
  if (!s) {
    s = { lastSeen: null, pending: null, zoneVisits: new Map() };
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
    // Fire-and-forget: generate thumbnail eagerly; never blocks the narrator.
    void import('./thumbnails.js').then(({ generateThumbnailForEntry }) =>
      generateThumbnailForEntry(entry),
    );
  },
};

function petName(): string {
  return db.getSetting('pet_name') ?? '';
}

/**
 * Resolve a Frigate camera identifier to a local camera row id.
 *
 * Frigate (and go2rtc) uses the `live_src` value as the camera identifier in
 * MQTT event payloads (e.g. "hamster_cam_1"), NOT the human-readable `name`
 * column (e.g. "Camera 1"). We therefore match against `live_src` first.
 * Comparison is case-insensitive and whitespace-trimmed on both sides so
 * minor config typos do not silently break resolution.
 *
 * Falls back to matching against `name` so single-camera setups that never
 * set `live_src` (or that use the camera name as the Frigate source name)
 * continue to work without migration.
 */
function cameraIdByName(name: string): number | null {
  const needle = name.trim().toLowerCase();
  const cameras = db.listCameras();
  // Primary: match on live_src (the value Frigate sends).
  const byLiveSrc = cameras.find(
    (c) => c.live_src !== null && c.live_src.trim().toLowerCase() === needle,
  );
  if (byLiveSrc) return byLiveSrc.id;
  // Fallback: match on name (covers setups where live_src was never configured).
  const byName = cameras.find((c) => c.name.trim().toLowerCase() === needle);
  return byName?.id ?? null;
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
// Zone-visit helpers
// ---------------------------------------------------------------------------

interface ScheduledFlushDeps {
  now: () => number;
  rng: () => number;
  onEntryWritten: (entry: db.DiaryEntryRow) => Promise<void> | void;
}

/**
 * Open a new zone visit. Starts a wheel odometer session if applicable.
 * Must only be called when the zone is NOT already in petState.zoneVisits.
 *
 * `side` is the `after` payload from the opening event — used to seed the
 * commit-gate fields (false_positive, has_snapshot, has_clip). These will be
 * updated on every subsequent event via `updateZoneVisitGateFields`.
 */
function openZoneVisit(
  petState: PetState,
  activity: Activity,
  cameraName: string,
  startedAt: number,
  side: FrigateEventPayloadSide,
): void {
  let odomCameraId: number | null = null;
  if (activity === 'wheel') {
    // Only start an odometer if no other wheel visit is running (invariant 1).
    const existingWheel = petState.zoneVisits.get('wheel');
    const alreadyRunning = existingWheel !== undefined && existingWheel.odomCameraId !== null;
    if (!alreadyRunning) {
      const camId = cameraIdByName(cameraName);
      if (camId !== null) {
        try {
          // startWheelSession returns true only when an ffmpeg session is
          // actually running (wheel enabled, live_src configured, not a
          // duplicate). Only set odomCameraId when there is a live session to
          // end — otherwise prepareCloseVisit would call endWheelSession on a
          // camera that never had one (returning null and losing any distance).
          const sessionStarted = startWheelSession(camId, startedAt);
          if (sessionStarted) {
            odomCameraId = camId;
          }
        } catch (err) {
          // Never block the narrator path for odometry errors.
          void err;
        }
      }
    }
  }
  petState.zoneVisits.set(activity, {
    startedAt,
    cameras: new Set([cameraName]),
    odomCameraId,
    falsePositive: side.false_positive,
    hasSnapshot: side.has_snapshot,
    hasClip: side.has_clip,
  });
}

/**
 * Update commit-gate fields on an open zone visit from the latest event
 * payload. Called on every 'new', 'update', and 'end' event so the visit
 * always holds the freshest Frigate assessment. When a field is undefined on
 * the incoming side we leave the existing value in place — Frigate only
 * populates these fields once they become relevant (e.g. has_clip only goes
 * true when a clip is actually saved, not on the initial 'new').
 */
function updateZoneVisitGateFields(
  visit: ZoneVisit,
  side: FrigateEventPayloadSide,
): void {
  if (side.false_positive !== undefined) visit.falsePositive = side.false_positive;
  if (side.has_snapshot !== undefined) visit.hasSnapshot = side.has_snapshot;
  if (side.has_clip !== undefined) visit.hasClip = side.has_clip;
}

/**
 * Close a zone visit and prepare a DeferredEntry. Always ends the wheel
 * odometer session — never leaves an ffmpeg session open regardless of dwell.
 *
 * The commit-gate fields (falsePositive, hasSnapshot, hasClip) are snapshotted
 * from the visit at close time. The gate itself is applied later in
 * commitDeferred — after dwell-threshold checks but before any DB write.
 * Separating the two concerns keeps this function clean and ensures the
 * odometer is always ended even when the entry is ultimately gated out.
 */
function prepareCloseVisit(
  visit: ZoneVisit,
  activity: Activity,
  cameraName: string,
  closedAt: number,
): DeferredEntry {
  const details: Record<string, unknown> = {
    camera: [...visit.cameras][0] ?? cameraName,
  };

  // Always end the odometer session — never leave ffmpeg running.
  // This MUST happen before any gate check so sessions are always cleaned up.
  if (activity === 'wheel' && visit.odomCameraId !== null) {
    try {
      const metres = endWheelSession(visit.odomCameraId);
      if (metres !== null) {
        details['wheel_meters'] = metres;
      }
    } catch (err) {
      void err;
    }
  }

  // Guard against negative durations: a visit opened with a server-clock
  // `nowMs` anchor (i.e. opened via an 'update' event) but closed with a
  // Frigate/Pi-clock `endMs` anchor will produce a negative durationMs when the
  // server clock ran ahead of the Pi clock by more than the actual dwell. Clamping
  // to 0 ensures the dwell-threshold check in commitDeferred correctly drops the
  // event (0 < minDwellMs) rather than leaving a large unsigned integer due to
  // integer underflow that could slip through.
  return {
    activity,
    durationMs: Math.max(0, closedAt - visit.startedAt),
    occurredAt: closedAt,
    cameraId: cameraIdByName([...visit.cameras][0] ?? cameraName),
    details,
    falsePositive: visit.falsePositive,
    hasSnapshot: visit.hasSnapshot,
    hasClip: visit.hasClip,
  };
}

/**
 * Commit a DeferredEntry to the diary (if dwell >= the applicable threshold).
 *
 * `interruptedByZone` — pass `true` when an exploring visit was closed
 * mid-track because the pet ENTERED a defined Frigate zone on the same
 * camera/track.  In this case we bypass the normal `exploringMinDwellMs`
 * gate (which exists only to suppress long open-space wandering noise) and
 * apply a minimal 2-second anti-flicker floor instead.  The zone entry that
 * follows constitutes proof that the preceding exploring activity was genuine
 * — dropping it would silently hide real behaviour.
 *
 * NOISE DECISION: 2 s floor (same as the general `minDwellMs` default).
 * Rationale: Frigate can fire a spurious single-frame detection that
 * immediately re-classifies into a zone within < 1 s, which would produce a
 * 0 ms "exploring" entry that adds no information. 2 s is long enough to
 * filter that artefact while still capturing the instant-turn-around that the
 * operator asked for.  The operator can lower `minDwellMs` in settings if
 * even shorter interrupted explorations are desired.
 *
 * Pure exploring visits that end WITHOUT entering a zone still obey the
 * full `exploringMinDwellMs` threshold — normal noise suppression is intact.
 */
async function commitDeferred(
  deferred: DeferredEntry,
  deps: ScheduledFlushDeps,
  options: { interruptedByZone?: boolean } = {},
): Promise<db.DiaryEntryRow | null> {
  // Activity-specific dwell threshold: exploring requires a much longer dwell
  // than other activities so casual cage wandering is suppressed.
  // Exception: when exploring was interrupted by a zone entry on the same
  // track, use only the minimal anti-flicker floor (minDwellMs) instead.
  const dwellThreshold =
    deferred.activity === 'exploring' && !options.interruptedByZone
      ? tuning.exploringMinDwellMs
      : tuning.minDwellMs;
  if (deferred.durationMs < dwellThreshold) return null;

  // -------------------------------------------------------------------------
  // COMMIT GATE: drop Frigate-event-driven entries that were not committed.
  //
  // Drop entries for tracks that Frigate marked as a false positive, or for
  // tracks that were never saved (no snapshot AND no clip). These tracks never
  // appear in Frigate's Explore UI, so they must not appear in the diary.
  //
  // All DeferredEntry instances come from Frigate zone visits (the Activity
  // type only covers zone-based activities — 'snapshot', 'timelapse', 'recap'
  // are written via separate code paths that never create DeferredEntries).
  // The gate therefore applies unconditionally here.
  //
  // Conservatism rules:
  //   • falsePositive=true  → ALWAYS drop (Frigate explicitly flagged it).
  //   • falsePositive=undefined → allow (absence of flag = not flagged yet).
  //   • hasSnapshot=undefined AND hasClip=undefined → DROP (no save evidence).
  //   • hasSnapshot=true OR hasClip=true → allow.
  // -------------------------------------------------------------------------
  if (deferred.falsePositive === true) {
    log.debug(
      { activity: deferred.activity, camera: deferred.details['camera'] },
      'commit-gate: dropping false_positive track — not in Frigate UI',
    );
    return null;
  }
  const saved = deferred.hasSnapshot === true || deferred.hasClip === true;
  if (!saved) {
    log.debug(
      {
        activity: deferred.activity,
        camera: deferred.details['camera'],
        hasSnapshot: deferred.hasSnapshot,
        hasClip: deferred.hasClip,
      },
      'commit-gate: dropping unsaved track (no snapshot, no clip) — not in Frigate UI',
    );
    return null;
  }

  // Back-to-back same-activity coalescing: if the most recent diary entry is
  // the SAME non-wheel activity and the pet returned to it within
  // COALESCE_WINDOW_MS, extend that entry instead of writing a near-duplicate
  // (this is what collapses "Exploring → Exploring" runs into one). Wheel is
  // excluded so each run keeps its own odometer distance. We do NOT re-fire
  // onEntryWritten here — the original entry already ran badges/push, and
  // re-firing would double-notify for a single continuing activity.
  if (deferred.activity !== 'wheel') {
    const latest = db.getLatestDiaryEntry();
    if (
      latest &&
      latest.kind === 'narrative' &&
      latest.activity === deferred.activity &&
      deferred.occurredAt > latest.occurred_at &&
      deferred.occurredAt - deferred.durationMs - latest.occurred_at <= COALESCE_WINDOW_MS
    ) {
      const startedAt = latest.occurred_at - (latest.duration_ms ?? 0);
      return db.extendDiaryEntry(latest.id, deferred.occurredAt, deferred.occurredAt - startedAt);
    }
  }

  const entry = writeEntry({
    activity: deferred.activity,
    occurredAt: deferred.occurredAt,
    cameraId: deferred.cameraId,
    durationMs: deferred.durationMs,
    fromCameraId: null,
    toCameraId: null,
    fromZone: null,
    toZone: null,
    details: Object.keys(deferred.details).length > 0 ? deferred.details : null,
    rng: deps.rng,
    pet: petName(),
  });
  await deps.onEntryWritten(entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Pending-end / transition-window flush
// ---------------------------------------------------------------------------

/**
 * Commit all deferred entries in a PendingEnd (called when transition window
 * expires with no cross-camera follow-up).
 */
async function flushPending(
  petKey: string,
  pending: PendingEnd,
  deps: ScheduledFlushDeps,
): Promise<db.DiaryEntryRow[]> {
  clearTimeout(pending.timer);
  const s = getOrInitPetState(petKey);
  if (s.pending === pending) s.pending = null;

  const out: db.DiaryEntryRow[] = [];
  for (const deferred of pending.deferred) {
    const entry = await commitDeferred(deferred, deps);
    if (entry) out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Core handler
// ---------------------------------------------------------------------------

/**
 * Process one MQTT-delivered Frigate event. May emit zero, one, or more diary
 * entries.
 *
 * Multi-camera dedup invariants:
 *  1. At most ONE active wheel odometer session per pet at any time.
 *  2. Simultaneous same-zone across cameras → ONE diary entry.
 *  3. Sequential cross-camera A→B transitions → ONE transition entry.
 *  4. Single-camera behaviour is unchanged.
 *  5. Concurrent DIFFERENT zones on different cameras: each zone visit is
 *     independent; entries are emitted only when the respective visit closes.
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

  // -------------------------------------------------------------------------
  // Cross-camera transition detection: a 'new' or 'update' event on a DIFFERENT
  // camera while a pending-end is in flight means the pet moved cameras.
  // Emit a transition entry and discard the deferred entries (they'd be
  // redundant noise alongside the transition).
  // -------------------------------------------------------------------------
  if (event.type !== 'end') {
    const pending = petState.pending;
    if (
      pending &&
      pending.camera !== cameraName &&
      nowMs - pending.at <= tuning.transitionWindowMs
    ) {
      clearTimeout(pending.timer);
      petState.pending = null;
      const dwellMs = pending.at - pending.startedAt;
      // Only write a transition diary entry when enabled in settings (default: off)
      // AND the dwell is long enough to be meaningful. Even when suppressed we
      // still discard the deferred entries — the transition already happened.
      if (tuning.transitionEntriesEnabled && dwellMs >= tuning.minDwellMs) {
        const fromZone = pending.activity;
        const toZone = classifyActivity(event.after);
        const entry = writeEntry({
          activity: 'transition',
          occurredAt: nowMs,
          cameraId: null,
          durationMs: nowMs - pending.startedAt,
          fromCameraId: cameraIdByName(pending.camera),
          toCameraId: cameraIdByName(cameraName),
          fromZone,
          toZone,
          details: {
            from: pending.camera,
            to: cameraName,
            dwell_ms: dwellMs,
          },
          rng: deps.rng,
          pet: petName(),
        });
        await deps.onEntryWritten(entry);
        written.push(entry);
      }
      // Deferred entries discarded — transition entry covers this movement.
    }
  }

  // -------------------------------------------------------------------------
  // Compute the set of zones this camera currently reports.
  // For 'end' events, the object is gone — treat as no zones.
  // -------------------------------------------------------------------------
  const currentZones: Set<Activity> =
    event.type === 'end' ? new Set() : classifyZones(event.after);

  // -------------------------------------------------------------------------
  // Open visits for newly-entered zones (debounce: camera already in visit →
  // no-op).
  //
  // startedAt anchor strategy — keeps both endpoints of `durationMs` on the
  // same clock so that server↔Pi clock skew cannot produce a negative duration:
  //
  //   'new' event: the zone was present from object birth. Use `startMs`
  //   (Frigate's before.start_time in ms) as the anchor. The close timestamp
  //   for a track-end close is `endMs` (also Frigate-clocked), so both
  //   endpoints share the same clock and skew cancels out.
  //
  //   'update' event: the zone was entered mid-track. `startMs` points to the
  //   OBJECT birth, not the zone-entry moment. For mid-track closes the close
  //   timestamp is `nowMs` (server clock, the update event's receive time).
  //   Using `nowMs` here means both endpoints are server-clocked. Clock skew
  //   cannot affect a duration where both sides come from `Date.now()`.
  //
  // In both cases the resulting `durationMs` is correct and robust to skew.
  // -------------------------------------------------------------------------
  const zoneOpenStartedAt = event.type === 'new' ? startMs : nowMs;
  for (const activity of currentZones) {
    const existing = petState.zoneVisits.get(activity);
    if (!existing) {
      openZoneVisit(petState, activity, cameraName, zoneOpenStartedAt, event.after);
    } else if (!existing.cameras.has(cameraName)) {
      // Additional camera joins the existing visit (dedup invariant 2).
      existing.cameras.add(cameraName);
      // Refresh gate fields from this camera's perspective.
      updateZoneVisitGateFields(existing, event.after);

      // Edge case: existing visit has no odometer but this camera can provide one.
      if (activity === 'wheel' && existing.odomCameraId === null) {
        const camId = cameraIdByName(cameraName);
        if (camId !== null) {
          try {
            const sessionStarted = startWheelSession(camId, existing.startedAt);
            if (sessionStarted) {
              existing.odomCameraId = camId;
            }
          } catch (err) {
            void err;
          }
        }
      }
    } else {
      // Camera already in this visit: update gate fields from the latest event.
      // This is the critical path for 'update' and 'end' events — Frigate may
      // flip has_snapshot, has_clip, or false_positive at any point in the
      // track's lifetime. The 'end' event carries the authoritative final values.
      updateZoneVisitGateFields(existing, event.after);
    }
  }

  // -------------------------------------------------------------------------
  // Close visits for zones that this camera has departed (mid-track: the
  // camera's current_zones no longer includes this zone).
  //
  // MID-TRACK closes ONLY — skip for 'end' events (those go through the
  // track-end path below so the transition-window can fire for the last camera).
  // -------------------------------------------------------------------------
  if (event.type !== 'end') {
    const midTrackToClose: Activity[] = [];
    for (const [activity, visit] of petState.zoneVisits) {
      if (!currentZones.has(activity) && visit.cameras.has(cameraName)) {
        // Update gate fields before closing so prepareCloseVisit snapshots the
        // latest Frigate assessment. Mid-track closes use the current 'update'
        // or 'new' event's after-side — the same track is still live.
        updateZoneVisitGateFields(visit, event.after);
        visit.cameras.delete(cameraName);
        if (visit.cameras.size === 0) {
          midTrackToClose.push(activity);
        }
      }
    }

    // Determine whether the current event is opening at least one DEFINED zone
    // (i.e. anything other than 'exploring'). This is used below to decide
    // whether a closing 'exploring' visit qualifies for the reduced dwell gate.
    const currentHasDefinedZone = [...currentZones].some((z) => z !== 'exploring');

    for (const activity of midTrackToClose) {
      const visit = petState.zoneVisits.get(activity);
      if (!visit) continue;
      petState.zoneVisits.delete(activity);
      // Mid-track close: emit immediately (no transition-window needed).
      //
      // When an 'exploring' visit is displaced by the pet entering a defined
      // Frigate zone on the same camera/track, pass interruptedByZone=true so
      // commitDeferred bypasses the exploringMinDwellMs gate and uses only the
      // minimal anti-flicker floor.  This ensures the exploring entry is ALWAYS
      // written when a zone entry follows it — the zone entry proves the activity
      // was real.  Pure exploring visits that end without a following zone entry
      // (i.e. via track-end) still obey the full exploringMinDwellMs threshold.
      const interruptedByZone = activity === 'exploring' && currentHasDefinedZone;
      const deferred = prepareCloseVisit(visit, activity, cameraName, occurredAtMs);
      const entry = await commitDeferred(deferred, deps, { interruptedByZone });
      if (entry) written.push(entry);
    }
  }

  // -------------------------------------------------------------------------
  // 'end' event: remove this camera from ALL visits. Collect visits that empty.
  //
  // TWO SUB-CASES based on whether other zone visits remain after this camera
  // departs:
  //
  //   A. zoneVisits still has other entries after this camera is removed:
  //      The pet is still visible on other cameras. Emit the closed visits
  //      IMMEDIATELY — no cross-camera transition possible from this 'end'.
  //
  //   B. zoneVisits becomes empty (this was the last camera):
  //      Queue a PendingEnd for transition-window deferral. A follow-up 'new'
  //      on a different camera within transitionWindowMs → TRANSITION entry.
  //      Otherwise the timer fires and deferred entries are committed.
  //
  // This is the ONLY close path for 'end' events (mid-track path above is
  // skipped for 'end').
  // -------------------------------------------------------------------------
  if (event.type === 'end') {
    // Collect (activity, visit) pairs before mutating the map.
    // Also update commit-gate fields from this 'end' event — the 'end' payload
    // carries Frigate's final authoritative values for false_positive,
    // has_snapshot, and has_clip. We update BEFORE removing the camera from
    // the visit so that prepareCloseVisit snapshots the authoritative values.
    const toClose: Array<{ activity: Activity; visit: ZoneVisit }> = [];
    for (const [activity, visit] of petState.zoneVisits) {
      if (visit.cameras.has(cameraName)) {
        updateZoneVisitGateFields(visit, event.after);
        visit.cameras.delete(cameraName);
        if (visit.cameras.size === 0) {
          toClose.push({ activity, visit });
        }
      }
    }
    for (const { activity } of toClose) {
      petState.zoneVisits.delete(activity);
    }

    if (petState.zoneVisits.size > 0) {
      // Sub-case A: other visits still alive — emit immediately.
      for (const { activity, visit } of toClose) {
        const deferred = prepareCloseVisit(visit, activity, cameraName, occurredAtMs);
        const entry = await commitDeferred(deferred, deps);
        if (entry) written.push(entry);
      }
    } else {
      // Sub-case B: all visits closed — queue PendingEnd.

      // Flush any existing pending first (defensive against rapid-fire ends on
      // concurrent same-pet tracks that would otherwise overwrite each other).
      if (petState.pending) {
        clearTimeout(petState.pending.timer);
        const prevPending = petState.pending;
        petState.pending = null;
        const flushed = await flushPending(petKey, prevPending, deps);
        for (const e of flushed) written.push(e);
      }

      const endActivity = classifyActivity(event.after);
      const trackEndDeferred = toClose.map(({ activity, visit }) =>
        prepareCloseVisit(visit, activity, cameraName, occurredAtMs),
      );

      // If there were no zone visits to close (e.g. Frigate missed the 'new'
      // and we only see the 'end'), synthesise a deferred entry from the event
      // so the detection isn't silently dropped.
      const deferred: DeferredEntry[] =
        trackEndDeferred.length > 0
          ? trackEndDeferred
          : [
              {
                activity: endActivity,
                durationMs: occurredAtMs - startMs,
                occurredAt: occurredAtMs,
                cameraId: cameraIdByName(cameraName),
                details: { camera: cameraName },
                // Synthesised entry: take gate fields directly from the 'end'
                // event — no ZoneVisit to snapshot them from.
                falsePositive: event.after.false_positive,
                hasSnapshot: event.after.has_snapshot,
                hasClip: event.after.has_clip,
              },
            ];

      const pending: PendingEnd = {
        activity: endActivity,
        camera: cameraName,
        at: occurredAtMs,
        startedAt: startMs,
        deferred,
        timer: undefined as unknown as NodeJS.Timeout,
      };
      pending.timer = setTimeout(() => {
        // commitDeferred inside flushPending calls deps.onEntryWritten for each
        // written entry — no further wiring needed here.
        flushPending(petKey, pending, deps).catch((err: unknown) => {
          log.error({ err }, 'flushPending timer failed — diary entry may be lost');
        });
      }, tuning.transitionWindowMs);
      pending.timer.unref?.();
      petState.pending = pending;
    }
  }

  // Update lastSeen.
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
  const nowMs = deps.now();
  for (const [petKey, s] of state.entries()) {
    // Flush any open zone visits that were never closed (e.g. process killed
    // mid-track).
    for (const [activity, visit] of s.zoneVisits) {
      const representativeCamera = [...visit.cameras][0];
      if (!representativeCamera) continue;
      const deferred = prepareCloseVisit(visit, activity, representativeCamera, nowMs);
      const entry = await commitDeferred(deferred, deps);
      if (entry) out.push(entry);
    }
    s.zoneVisits.clear();
    // Flush any pending transition-window entries.
    if (s.pending) {
      const entries = await flushPending(petKey, s.pending, deps);
      out.push(...entries);
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
  /** User who triggered the snapshot. Omit or null for system-generated entries. */
  userId?: number | null;
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
    created_by: input.userId ?? null,
  });
  await evaluateBadges();
  // Fire-and-forget: generate thumbnail eagerly for the snapshot entry.
  void import('./thumbnails.js').then(({ generateThumbnailForEntry }) =>
    generateThumbnailForEntry(entry),
  );
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
