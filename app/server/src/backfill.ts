// app/server/src/backfill.ts
// CLI tool: re-process Frigate historical events to recover diary entries that
// were silently dropped by the clock-skew bug fixed in commit b00afb1
// (narrator.ts zoneOpenStartedAt).
//
// IDEMPOTENCY GUARANTEE
// ---------------------
// Before writing any entry the tool checks whether a diary row already exists
// that covers the same camera + activity + time window (±DEDUPE_SLOP_MS). If
// one is found the event is skipped. This makes the tool safe to run multiple
// times; it will always produce the same outcome.
//
// For wheel entries, distance backfill is also idempotent: if an entry already
// has wheel_meters in its details blob, the replay is skipped on a second run.
//
// WHEEL DISTANCE
// --------------
// For each recovered (or already-existing) wheel entry the tool replays the
// odometer state machine over the corresponding Frigate recording clip using
// replayWheelDistance() from wheel-odometer.ts. That function reuses the same
// PgmParser + RotationCounter units as the live odometer — there is no
// duplicated pixel or FSM logic (DRY). The identical crop filter (bandX/W/Y/H)
// and dark-pixel threshold from the camera's per-camera odometer config are
// applied, and rotations are converted to metres with the same formula:
//   metres = rotations × π × diameter_mm / 1000
//
// Distance backfill is skipped (log + continue) when:
//   - the camera has wheel_mark_enabled = 0 or unconfigured odometer ROI
//   - the entry's camera is missing / unresolvable
//   - FRIGATE_URL is unset (the whole backfill is a no-op in that case)
//   - the entry already has wheel_meters in its details (idempotency guard)
//
// USAGE (inside the container on the Mac Mini)
// --------------------------------------------
//   # Default: recovers the last 12 hours
//   node dist/backfill.js
//
//   # Custom window by hours:
//   node dist/backfill.js --hours 6
//
//   # Custom window by days (legacy):
//   node dist/backfill.js --days 3
//
//   # Dry-run: show what would be written without touching the DB:
//   node dist/backfill.js --dry-run
//
//   # Via tsx in dev (same machine as the server, same .env):
//   pnpm -C app/server tsx src/backfill.ts -- --hours 6 --dry-run

import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { getConfig } from './config.js';
import * as db from './db.js';
import { childLogger } from './logger.js';
import { matchKeyword } from './narrator.js';
import { pickTemplate, render } from './narratives.js';
import { generateThumbnailForEntry } from './thumbnails.js';
import { replayWheelDistance } from './wheel-odometer.js';

const logger = childLogger('backfill');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default look-back window in hours. */
export const DEFAULT_HOURS = 12;

/**
 * How much temporal slop to allow when deduplicating against existing entries.
 * If an existing entry's occurred_at is within this window of the candidate
 * entry's occurred_at AND it has the same activity + camera, we treat it as a
 * duplicate and skip. 5 minutes handles minor clock drift between runs without
 * swallowing genuinely distinct events.
 */
export const DEDUPE_SLOP_MS = 5 * 60 * 1000;

/** Frigate events REST page size. */
const EVENTS_PAGE_LIMIT = 1000;

// ---------------------------------------------------------------------------
// Frigate REST API types
// ---------------------------------------------------------------------------

/** One event as returned by GET /api/events. */
interface FrigateRestEvent {
  id: string;
  camera: string;
  label: string;
  start_time: number;    // unix seconds (float)
  end_time: number | null;
  has_snapshot: boolean;
  zones: string[];       // zones at END of track — best proxy for "where was it"
}

// ---------------------------------------------------------------------------
// Idempotency check
// ---------------------------------------------------------------------------

/**
 * Returns the first matching diary entry that is close enough in time and
 * matches the given camera + activity, or null when none found.
 *
 * Two entries are considered duplicates when:
 *   |candidate.occurredAt - existing.occurred_at| <= DEDUPE_SLOP_MS
 *   AND existing.activity === candidate.activity
 *   AND existing.camera_id === candidate.cameraId   (or both null)
 *
 * This is deliberately conservative: if the DB already has a real entry from
 * the live narrator that happened to capture the event at nearly the same time
 * but with a slightly different timestamp, we honour it and skip.
 *
 * Returns the matched row so callers can access its id for distance backfill.
 */
export function findExistingEntry(
  cameraId: number | null,
  activity: db.DiaryActivity,
  occurredAtMs: number,
  existingEntries: readonly db.DiaryEntryRow[],
): db.DiaryEntryRow | null {
  for (const e of existingEntries) {
    if (e.activity !== activity) continue;
    if (e.camera_id !== cameraId) continue;
    if (Math.abs(e.occurred_at - occurredAtMs) <= DEDUPE_SLOP_MS) return e;
  }
  return null;
}

/**
 * Returns true when a diary entry already exists that is close enough in time
 * and matches the given camera + activity to be considered a duplicate.
 * Thin wrapper around findExistingEntry for backward compat with tests.
 */
export function isDuplicate(
  cameraId: number | null,
  activity: db.DiaryActivity,
  occurredAtMs: number,
  existingEntries: readonly db.DiaryEntryRow[],
): boolean {
  return findExistingEntry(cameraId, activity, occurredAtMs, existingEntries) !== null;
}

// ---------------------------------------------------------------------------
// Event → diary entry mapping
// ---------------------------------------------------------------------------

/**
 * Classify a Frigate REST event into a diary activity.
 * Mirrors the narrator's classifyZones / matchKeyword logic but works off the
 * REST event's `zones` array (which records all zones at end-of-track).
 */
function classifyEvent(event: FrigateRestEvent): db.DiaryActivity {
  for (const z of event.zones) {
    const k = matchKeyword(z);
    if (k) return k;
  }
  const k = matchKeyword(event.camera);
  return k ?? 'exploring';
}

/**
 * Resolve the camera_id for a Frigate camera name. Matches live_src first,
 * then falls back to name — same priority order as narrator.ts.
 */
function resolveCameraId(cameraName: string): number | null {
  const needle = cameraName.trim().toLowerCase();
  const cameras = db.listCameras();
  const byLiveSrc = cameras.find(
    (c) => c.live_src !== null && c.live_src.trim().toLowerCase() === needle,
  );
  if (byLiveSrc) return byLiveSrc.id;
  const byName = cameras.find((c) => c.name.trim().toLowerCase() === needle);
  return byName?.id ?? null;
}

// ---------------------------------------------------------------------------
// Frigate REST client (minimal — only what backfill needs)
// ---------------------------------------------------------------------------

async function fetchFrigateEvents(
  frigateUrl: string,
  afterSec: number,
  beforeSec: number,
): Promise<FrigateRestEvent[]> {
  const url = new URL('/api/events', frigateUrl);
  url.searchParams.set('limit', String(EVENTS_PAGE_LIMIT));
  url.searchParams.set('after', String(Math.floor(afterSec)));
  url.searchParams.set('before', String(Math.ceil(beforeSec)));
  // Only events with an end time (fully closed tracks) are recoverable.
  url.searchParams.set('has_clip', 'true');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(url.toString(), { signal: ctrl.signal });
    if (!res.ok) {
      logger.warn({ status: res.status, url: url.toString() }, 'Frigate events API returned non-OK');
      return [];
    }
    const data = await res.json() as unknown;
    if (!Array.isArray(data)) {
      logger.warn({ url: url.toString() }, 'Frigate events API returned non-array');
      return [];
    }
    return data.filter(isValidFrigateEvent);
  } finally {
    clearTimeout(timer);
  }
}

function isValidFrigateEvent(raw: unknown): raw is FrigateRestEvent {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r['id'] === 'string' &&
    typeof r['camera'] === 'string' &&
    typeof r['label'] === 'string' &&
    typeof r['start_time'] === 'number' &&
    (r['end_time'] === null || typeof r['end_time'] === 'number') &&
    Array.isArray(r['zones'])
  );
}

// ---------------------------------------------------------------------------
// Core backfill logic
// ---------------------------------------------------------------------------

export interface BackfillResult {
  eventsScanned: number;
  skippedDuplicate: number;
  skippedNoDuration: number;
  skippedBelowDwell: number;
  written: number;
  thumbnailsQueued: number;
  /** Wheel entries that had distance successfully replayed and written. */
  distanceReplayed: number;
  /** Wheel entries skipped for distance replay (disabled, no config, already set, etc.). */
  distanceSkipped: number;
}

export interface BackfillOptions {
  /**
   * Look-back window in hours. Takes precedence over `days` when both are
   * supplied. Default: DEFAULT_HOURS (12).
   */
  hours?: number;
  /**
   * Look-back window in days (legacy convenience). Ignored when `hours` is
   * also supplied. Provided for scripts that still use --days.
   */
  days?: number;
  /** When true, do not write to the DB or filesystem. */
  dryRun?: boolean;
  /**
   * Override "now" for deterministic tests. Epoch ms.
   * Defaults to Date.now().
   */
  nowMs?: number;
  /**
   * Minimum duration (ms) a recovered event must have to be written.
   * Mirrors the live narrator's minDwellMs.
   * Default: read from settings, then fall back to 2000.
   */
  minDwellMs?: number;
  /**
   * Pet name for narrative text. Defaults to the settings row.
   */
  petName?: string;
  /**
   * RNG for template selection — injectable for deterministic tests.
   */
  rng?: () => number;
  /**
   * Skip the wheel-distance replay step even for wheel entries.
   * Useful in tests that don't have a real FRIGATE_URL or ffmpeg.
   * Default: false.
   */
  skipDistanceReplay?: boolean;
}

/**
 * Run the backfill. Returns a summary of what was done.
 *
 * This function is the core of the tool: it is fully tested and import-safe
 * (no process.exit, no CLI argument parsing). The CLI wrapper below calls it.
 */
export async function runBackfill(opts: BackfillOptions = {}): Promise<BackfillResult> {
  const cfg = getConfig();

  if (!cfg.FRIGATE_URL) {
    logger.warn('FRIGATE_URL is not set — backfill requires Frigate; exiting cleanly');
    return {
      eventsScanned: 0,
      skippedDuplicate: 0,
      skippedNoDuration: 0,
      skippedBelowDwell: 0,
      written: 0,
      thumbnailsQueued: 0,
      distanceReplayed: 0,
      distanceSkipped: 0,
    };
  }

  const nowMs = opts.nowMs ?? Date.now();
  // --hours takes precedence; --days is the fallback; default is 12 hours.
  const windowMs = opts.hours !== undefined
    ? opts.hours * 60 * 60 * 1000
    : opts.days !== undefined
      ? opts.days * 24 * 60 * 60 * 1000
      : DEFAULT_HOURS * 60 * 60 * 1000;
  const dryRun = opts.dryRun ?? false;
  const skipDistanceReplay = opts.skipDistanceReplay ?? false;
  const minDwellMs = opts.minDwellMs
    ?? Math.max(0, Number.parseInt(db.getSetting('min_dwell_ms') ?? '2000', 10) || 2000);
  const petName = opts.petName ?? (db.getSetting('pet_name') ?? '');
  const rng = opts.rng ?? Math.random;

  const afterMs = nowMs - windowMs;
  const afterSec = afterMs / 1000;
  const beforeSec = nowMs / 1000;

  logger.info(
    {
      windowHours: windowMs / (60 * 60 * 1000),
      dryRun,
      after: new Date(afterMs).toISOString(),
      before: new Date(nowMs).toISOString(),
    },
    'backfill: fetching Frigate events',
  );

  const frigateEvents = await fetchFrigateEvents(cfg.FRIGATE_URL, afterSec, beforeSec);

  logger.info({ count: frigateEvents.length }, 'backfill: Frigate events fetched');

  // Load existing diary entries once for the whole window — used for dedup.
  // We load all narrative entries in the window rather than doing per-event
  // queries to keep the DB load bounded.
  const existingEntries = db.listDiaryEntriesBetween(afterMs, nowMs);

  const result: BackfillResult = {
    eventsScanned: frigateEvents.length,
    skippedDuplicate: 0,
    skippedNoDuration: 0,
    skippedBelowDwell: 0,
    written: 0,
    thumbnailsQueued: 0,
    distanceReplayed: 0,
    distanceSkipped: 0,
  };

  for (const event of frigateEvents) {
    // Only recover events that have a definite end time (closed tracks).
    if (event.end_time === null || !Number.isFinite(event.end_time)) {
      result.skippedNoDuration += 1;
      continue;
    }

    const startMs = Math.round(event.start_time * 1000);
    const endMs = Math.round(event.end_time * 1000);
    const durationMs = endMs - startMs;

    // Guard: skip events where end < start (malformed Frigate data or extreme
    // clock skew on the Pi Zero that exceeded start_time).
    if (durationMs <= 0) {
      result.skippedNoDuration += 1;
      continue;
    }

    const activity = classifyEvent(event);
    const cameraId = resolveCameraId(event.camera);

    // Activity-specific dwell threshold: exploring has a much higher bar.
    // Use the same logic as narrator.ts commitDeferred.
    const exploringMinDwellMs = Math.max(
      0,
      Number.parseInt(db.getSetting('exploring_min_dwell_ms') ?? '60000', 10) || 60_000,
    );
    const dwellThreshold = activity === 'exploring' ? exploringMinDwellMs : minDwellMs;

    if (durationMs < dwellThreshold) {
      result.skippedBelowDwell += 1;
      continue;
    }

    // The occurred_at for narrator entries is the END of the activity (endMs).
    const existingEntry = findExistingEntry(cameraId, activity, endMs, existingEntries);
    if (existingEntry !== null) {
      result.skippedDuplicate += 1;
      logger.debug(
        { eventId: event.id, camera: event.camera, activity, endMs },
        'backfill: skipping duplicate',
      );
      // For wheel entries that already exist but lack wheel_meters, attempt
      // distance replay even though we're not writing a new entry.
      if (activity === 'wheel' && !dryRun && !skipDistanceReplay) {
        await maybeReplayDistance({
          cfg,
          event,
          startMs,
          endMs,
          cameraId,
          entryId: existingEntry.id,
          existingDetails: existingEntry.details,
          result,
        });
      } else if (activity === 'wheel') {
        result.distanceSkipped += 1;
      }
      continue;
    }

    // Build narrative text identical to narrator.ts writeEntry.
    const pet = petName || 'they';
    let narrative: string;
    if (
      activity === 'wheel' || activity === 'food' || activity === 'water' ||
      activity === 'bathroom' || activity === 'resting' || activity === 'tunnel' ||
      activity === 'exploring' || activity === 'hiding'
    ) {
      const tpl = pickTemplate(activity, rng);
      const totalSec = Math.max(0, Math.round(durationMs / 1000));
      let durationStr: string;
      if (totalSec < 60) durationStr = `${totalSec}s`;
      else {
        const min = Math.floor(totalSec / 60);
        const sec = totalSec % 60;
        durationStr = sec === 0 ? `${min} min` : `${min} min ${sec}s`;
      }
      narrative = render(tpl, { pet, duration: durationStr });
    } else {
      narrative = '';
    }

    if (dryRun) {
      logger.info(
        {
          eventId: event.id,
          camera: event.camera,
          activity,
          durationMs,
          cameraId,
          narrative,
        },
        'backfill: [DRY RUN] would write entry',
      );
      result.written += 1;
      if (activity === 'wheel') result.distanceSkipped += 1;
      continue;
    }

    const entry = db.createDiaryEntry({
      occurred_at: endMs,
      kind: 'narrative',
      activity,
      narrative,
      pet_name: petName || null,
      camera_id: cameraId,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: durationMs,
      snapshot_id: null,
      media_path: null,
      details: JSON.stringify({
        camera: event.camera,
        backfill: true,
        frigate_event_id: event.id,
      }),
    });

    result.written += 1;

    // Queue thumbnail generation (fire-and-forget; same pattern as narrator.ts).
    // generateThumbnailForEntry never throws.
    void generateThumbnailForEntry(entry);
    result.thumbnailsQueued += 1;

    logger.debug(
      { entryId: entry.id, camera: event.camera, activity, durationMs },
      'backfill: wrote entry',
    );

    // Replay wheel distance for newly written wheel entries.
    if (activity === 'wheel' && !skipDistanceReplay) {
      await maybeReplayDistance({
        cfg,
        event,
        startMs,
        endMs,
        cameraId,
        entryId: entry.id,
        existingDetails: entry.details,
        result,
      });
    } else if (activity === 'wheel') {
      result.distanceSkipped += 1;
    }
  }

  logger.info(result, 'backfill: complete');
  return result;
}

// ---------------------------------------------------------------------------
// Wheel distance replay helpers
// ---------------------------------------------------------------------------

interface ReplayDistanceOpts {
  cfg: ReturnType<typeof getConfig>;
  event: FrigateRestEvent;
  startMs: number;
  endMs: number;
  cameraId: number | null;
  entryId: number;
  existingDetails: string | null;
  result: BackfillResult;
}

/**
 * Attempt to compute and persist wheel_meters for a diary entry.
 * Mutates `result.distanceReplayed` / `result.distanceSkipped`.
 *
 * Idempotency: if the details blob already contains wheel_meters, skip.
 */
async function maybeReplayDistance(opts: ReplayDistanceOpts): Promise<void> {
  const { cfg, event, startMs, endMs, cameraId, entryId, existingDetails, result } = opts;

  // Guard: entry already has wheel_meters — don't clobber on re-run.
  if (existingDetails !== null) {
    try {
      const parsed = JSON.parse(existingDetails) as unknown;
      if (
        typeof parsed === 'object' && parsed !== null &&
        'wheel_meters' in parsed &&
        (parsed as Record<string, unknown>)['wheel_meters'] !== null
      ) {
        logger.debug({ entryId }, 'backfill: wheel entry already has wheel_meters — skipping replay');
        result.distanceSkipped += 1;
        return;
      }
    } catch {
      // Malformed details JSON — fall through and attempt replay.
    }
  }

  if (cameraId === null) {
    logger.debug({ entryId, camera: event.camera }, 'backfill: no camera_id — skipping distance replay');
    result.distanceSkipped += 1;
    return;
  }

  const camera = db.getCameraById(cameraId);
  if (!camera) {
    logger.debug({ entryId, cameraId }, 'backfill: camera not found — skipping distance replay');
    result.distanceSkipped += 1;
    return;
  }

  if (camera.wheel_mark_enabled !== 1) {
    logger.debug({ entryId, cameraId }, 'backfill: odometer disabled for camera — skipping distance replay');
    result.distanceSkipped += 1;
    return;
  }

  // Build the Frigate clip URL for this event's time span.
  // Use the same endpoint convention as extractClip in frigate.ts:
  //   /api/<cam>/start/<startSec>/end/<endSec>/clip.mp4
  const cameraName = camera.live_src ?? camera.name;
  const startSec = Math.floor(startMs / 1000);
  const endSec = Math.ceil(endMs / 1000);
  const clipUrl = new URL(
    `/api/${encodeURIComponent(cameraName)}/start/${startSec}/end/${endSec}/clip.mp4`,
    cfg.FRIGATE_URL,
  ).toString();

  logger.info({ entryId, cameraId, clipUrl }, 'backfill: replaying wheel distance');

  let metres: number | null = null;
  try {
    metres = await replayWheelDistance({
      clipUrl,
      diameterMm: camera.wheel_diameter_mm,
      bandX: camera.wheel_band_x_pct,
      bandW: camera.wheel_band_width_pct,
      bandY: camera.wheel_band_y_pct,
      bandH: camera.wheel_band_height_pct,
      thresholdPct: camera.wheel_threshold_pct,
    });
  } catch (err) {
    logger.warn({ entryId, err: err instanceof Error ? err.message : String(err) }, 'backfill: replayWheelDistance threw');
    result.distanceSkipped += 1;
    return;
  }

  if (metres === null) {
    logger.warn({ entryId }, 'backfill: distance replay returned null — no frames or ffmpeg error');
    result.distanceSkipped += 1;
    return;
  }

  // Merge wheel_meters into the existing details blob (preserves backfill/frigate_event_id).
  let detailsObj: Record<string, unknown> = {};
  if (existingDetails !== null) {
    try {
      const parsed = JSON.parse(existingDetails) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        detailsObj = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed — start fresh (keeps the new wheel_meters at minimum).
    }
  }
  detailsObj['wheel_meters'] = metres;
  db.updateDiaryEntryDetails(entryId, detailsObj);

  result.distanceReplayed += 1;
  logger.info({ entryId, metres }, 'backfill: wheel_meters written');
}

// ---------------------------------------------------------------------------
// CLI entrypoint (mirrors bootstrap.ts pattern exactly)
// ---------------------------------------------------------------------------

interface CliArgs {
  hours: number | undefined;
  days: number | undefined;
  dryRun: boolean;
  help: boolean;
}

function parseCli(argv: readonly string[]): CliArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      hours: { type: 'string' },
      days: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  let hours: number | undefined;
  if (values.hours !== undefined) {
    const raw = Number.parseInt(values.hours, 10);
    hours = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HOURS;
  }

  let days: number | undefined;
  if (values.days !== undefined) {
    const raw = Number.parseInt(values.days, 10);
    days = Number.isFinite(raw) && raw > 0 ? raw : undefined;
  }

  return {
    hours,
    days,
    dryRun: Boolean(values['dry-run']),
    help: Boolean(values.help),
  };
}

function usage(): string {
  return [
    'Usage: backfill [--hours <n>] [--days <n>] [--dry-run]',
    '  (prod: `node dist/backfill.js`; dev: `pnpm -C app/server tsx src/backfill.ts -- …`)',
    '',
    'Recovers diary entries dropped during the clock-skew window by re-processing',
    'Frigate historical events. Also replays the wheel odometer state machine over',
    'recorded footage to compute and store distance (wheel_meters) for wheel entries.',
    '',
    'FRIGATE_URL must be configured or the tool exits cleanly without writing anything.',
    '',
    'Options:',
    `  --hours <n>  Look-back window in hours (default: ${DEFAULT_HOURS}); takes precedence over --days`,
    '  --days <n>   Look-back window in days (legacy; ignored when --hours is supplied)',
    '  --dry-run    Print what would be written without modifying the DB',
    '  -h, --help   Show this help',
  ].join('\n');
}

export async function runCli(argv: readonly string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCli(argv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n\n${usage()}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  // Boot the DB (runs migrations).
  db.getDb();

  try {
    const backfillOpts: BackfillOptions = { dryRun: args.dryRun };
    if (args.hours !== undefined) backfillOpts.hours = args.hours;
    if (args.days !== undefined) backfillOpts.days = args.days;
    const result = await runBackfill(backfillOpts);
    const tag = args.dryRun ? '[DRY RUN] ' : '';
    process.stdout.write(
      `${tag}backfill complete:\n` +
      `  events scanned:       ${result.eventsScanned}\n` +
      `  skipped (duplicate):  ${result.skippedDuplicate}\n` +
      `  skipped (no dur):     ${result.skippedNoDuration}\n` +
      `  skipped (dwell):      ${result.skippedBelowDwell}\n` +
      `  entries written:      ${result.written}\n` +
      `  thumbnails queued:    ${result.thumbnailsQueued}\n` +
      `  distance replayed:    ${result.distanceReplayed}\n` +
      `  distance skipped:     ${result.distanceSkipped}\n`,
    );
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`fatal: ${msg}\n`);
      process.exit(1);
    },
  );
}
