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
// WHEEL DISTANCE
// --------------
// The real-time odometer works by sampling a live ffmpeg video stream, running
// the dark-pixel state machine at high frequency, and counting LIGHT→DARK→LIGHT
// rotations. For historical footage this is technically possible — extract frames
// from the recording via ffmpeg at the same sample rate and feed them through the
// same pixel classifier — BUT it is deliberately NOT implemented here for the
// following reasons:
//
//  1. The ROI box (wheel_band_*_pct) and threshold were tuned for the current
//     camera position. The historical footage was recorded before the ~45° angle
//     correction was finalised; running the same box over old footage would produce
//     unreliable rotation counts.
//  2. Frigate recordings are in sharded .ts segments. Extracting several hours of
//     frames via sequential ffmpeg calls is extremely CPU-intensive for the Mac Mini
//     (a typical 20-min wheel run at 5 fps sample rate = 6000 JPEG frames via 600
//     individual ffmpeg invocations or one long pipe). Given that the entries
//     themselves were ALREADY lost and the distance can never be authoritative,
//     the cost/benefit is poor.
//  3. The live wheel-odometer.ts already has its own ffmpeg pipeline; running a
//     second one against recordings in parallel with a live session would require
//     careful resource budgeting that is out of scope for a one-time recovery.
//
// RECOMMENDATION: recovered wheel entries will have duration_ms populated from
// the Frigate event timestamps and an explanatory note in `details.backfill`.
// The wheel_meters field is omitted (null). If precise historical distances are
// needed in the future, a dedicated "replay odometer" pass over the recordings
// can be implemented as a separate tool.
//
// USAGE (inside the container on the Mac Mini)
// --------------------------------------------
//   # Default: recovers the last 10 days (Frigate recording retention window)
//   node dist/backfill.js
//
//   # Custom window (e.g. last 7 days only):
//   node dist/backfill.js --days 7
//
//   # Dry-run: show what would be written without touching the DB:
//   node dist/backfill.js --dry-run
//
//   # Via tsx in dev (same machine as the server, same .env):
//   pnpm -C app/server tsx src/backfill.ts -- --days 7 --dry-run

import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { getConfig } from './config.js';
import * as db from './db.js';
import { childLogger } from './logger.js';
import { matchKeyword } from './narrator.js';
import { pickTemplate, render } from './narratives.js';
import { generateThumbnailForEntry } from './thumbnails.js';

const logger = childLogger('backfill');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default look-back window matches Frigate's continuous-recording retention. */
const DEFAULT_DAYS = 10;

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
 * Returns true when a diary entry already exists that is close enough in time
 * and matches the given camera + activity to be considered a duplicate of the
 * candidate we are about to write.
 *
 * Two entries are considered duplicates when:
 *   |candidate.occurredAt - existing.occurred_at| <= DEDUPE_SLOP_MS
 *   AND existing.activity === candidate.activity
 *   AND existing.camera_id === candidate.cameraId   (or both null)
 *
 * This is deliberately conservative: if the DB already has a real entry from
 * the live narrator that happened to capture the event at nearly the same time
 * but with a slightly different timestamp, we honour it and skip.
 */
export function isDuplicate(
  cameraId: number | null,
  activity: db.DiaryActivity,
  occurredAtMs: number,
  existingEntries: readonly db.DiaryEntryRow[],
): boolean {
  for (const e of existingEntries) {
    if (e.activity !== activity) continue;
    if (e.camera_id !== cameraId) continue;
    if (Math.abs(e.occurred_at - occurredAtMs) <= DEDUPE_SLOP_MS) return true;
  }
  return false;
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
}

export interface BackfillOptions {
  /** Look-back window in days. Default: DEFAULT_DAYS (10). */
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
    };
  }

  const nowMs = opts.nowMs ?? Date.now();
  const days = opts.days ?? DEFAULT_DAYS;
  const dryRun = opts.dryRun ?? false;
  const minDwellMs = opts.minDwellMs
    ?? Math.max(0, Number.parseInt(db.getSetting('min_dwell_ms') ?? '2000', 10) || 2000);
  const petName = opts.petName ?? (db.getSetting('pet_name') ?? '');
  const rng = opts.rng ?? Math.random;

  const afterMs = nowMs - days * 24 * 60 * 60 * 1000;
  const afterSec = afterMs / 1000;
  const beforeSec = nowMs / 1000;

  logger.info(
    {
      days,
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
    if (isDuplicate(cameraId, activity, endMs, existingEntries)) {
      result.skippedDuplicate += 1;
      logger.debug(
        { eventId: event.id, camera: event.camera, activity, endMs },
        'backfill: skipping duplicate',
      );
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
        // wheel_meters intentionally omitted — see module-level doc comment.
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
  }

  logger.info(result, 'backfill: complete');
  return result;
}

// ---------------------------------------------------------------------------
// CLI entrypoint (mirrors bootstrap.ts pattern exactly)
// ---------------------------------------------------------------------------

interface CliArgs {
  days: number;
  dryRun: boolean;
  help: boolean;
}

function parseCli(argv: readonly string[]): CliArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      days: { type: 'string', default: String(DEFAULT_DAYS) },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const daysRaw = Number.parseInt(values.days ?? String(DEFAULT_DAYS), 10);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : DEFAULT_DAYS;
  return {
    days,
    dryRun: Boolean(values['dry-run']),
    help: Boolean(values.help),
  };
}

function usage(): string {
  return [
    'Usage: backfill [--days <n>] [--dry-run]',
    '  (prod: `node dist/backfill.js`; dev: `pnpm -C app/server tsx src/backfill.ts -- …`)',
    '',
    'Recovers diary entries dropped during the clock-skew window by re-processing',
    'Frigate historical events within the recording retention period.',
    '',
    'FRIGATE_URL must be configured or the tool exits cleanly without writing anything.',
    '',
    'Options:',
    `  --days <n>   Look-back window in days (default: ${DEFAULT_DAYS})`,
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
    const result = await runBackfill({ days: args.days, dryRun: args.dryRun });
    const tag = args.dryRun ? '[DRY RUN] ' : '';
    process.stdout.write(
      `${tag}backfill complete:\n` +
      `  events scanned:       ${result.eventsScanned}\n` +
      `  skipped (duplicate):  ${result.skippedDuplicate}\n` +
      `  skipped (no dur):     ${result.skippedNoDuration}\n` +
      `  skipped (dwell):      ${result.skippedBelowDwell}\n` +
      `  entries written:      ${result.written}\n` +
      `  thumbnails queued:    ${result.thumbnailsQueued}\n`,
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
