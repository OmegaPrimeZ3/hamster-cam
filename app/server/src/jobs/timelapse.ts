// app/server/src/jobs/timelapse.ts
// Nightly 06:05 local: stitch the previous night's snapshots (22:00–06:00)
// into a ~90s recap reel (hamster-only frames + Frigate clips) and write a
// 'timelapse' diary entry. Idempotent per night.
//
// ALGORITHM — HAMSTER-FILTERED MIXED TIMELINE
//
// 1. Query Frigate GET /api/events (label=hamster) for the night window.
//    Build a sorted list of [startMs, endMs] detection intervals.
//
// 2. STILL FRAMES — keep only snapshots whose taken_at falls within
//    HAMSTER_MATCH_WINDOW_MS of any detection interval. These form the
//    frame pool.
//
//    If Frigate is unreachable (events returns []) we fall back to the
//    old all-snapshots behaviour so a quiet/offline Frigate night still
//    produces something.
//
// 3. VIDEO CLIPS — for detection events >= MIN_CLIP_EVENT_S seconds, pull
//    a clip from Frigate (/api/<cam>/start/<s>/end/<e>/clip.mp4), clamped
//    to [3s, 5s]. Clips are normalised (same res/fps/codec) for concat.
//    Each clip is downloaded at most once per job run (dedup by event id).
//    Clip fetch failures are silently skipped; at most MAX_CLIPS clips are
//    collected.
//
// 4. TIMELINE COMPOSITION — target ~90s total:
//    a. Bucket the night into TIMELINE_BUCKETS equal slots.
//    b. Assign at most one clip per bucket (from the most-active detection
//       in that bucket); remainder are still-frame slots.
//    c. Still-frame slots: pick the activity-guided nearest snapshot (same
//       bucket-scoring as before, with hysteresis).
//    d. Total = sum(clip durations) + (#still_slots × SECONDS_PER_FRAME).
//    e. If total > TARGET_SECONDS: reduce still slots evenly (skip every
//       Nth bucket) to land close to TARGET_SECONDS.
//    f. If total < TARGET_SECONDS: use what exists (no padding).
//
// 5. ffmpeg concat demuxer: write one concat script with `file` + `duration`
//    for still segments and `file` entries (no duration override) for clips.
//    Clips are pre-normalised so the concat stream is homogeneous.
//
// 6. BACKGROUND MUSIC — if RECAP_MUSIC_PATH points to a real file, amix
//    the audio track under the video (-18 dB), looped and trimmed to the
//    final video length, fade out last 3s. Safety-gate: if the file is
//    missing the job continues silently without music.
//
// MANUAL REGEN CLI
//   node dist/timelapse-regen.js --date YYYY-MM-DD
//   (also exported as runTimelapseForDate for programmatic use)

import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getConfig } from '../config.js';
import * as db from '../db.js';
import type { DiaryActivity, DiaryEntryRow, SnapshotRow } from '../db.js';
import { FfmpegError, fetchHamsterEvents, type FrigateDetectionEvent, runFfmpeg } from '../frigate.js';
import { childLogger } from '../logger.js';
import { pickTemplate, render } from '../narratives.js';
import { generateThumbnailForEntry } from '../thumbnails.js';

const logger = childLogger('timelapse-job');

/**
 * Return the last N lines of ffmpeg stderr so error log entries are readable
 * without being enormous. Trims leading/trailing whitespace.
 */
function stderrSummary(stderr: string, lines = 20): string {
  return stderr
    .trim()
    .split('\n')
    .slice(-lines)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Target output duration in seconds. */
const TARGET_SECONDS = 90;

/** Seconds each still frame is displayed. */
const SECONDS_PER_FRAME = 1.5;

/** Output framerate for browser compatibility. */
const OUTPUT_FPS = 30;

/** Minimum distinct frames (stills + clips) required to produce a recap. */
const MIN_FRAMES = 8;

/** Target width/height for the output video. */
const TARGET_W = 1280;
const TARGET_H = 720;

/**
 * How close (in ms) a snapshot's taken_at must be to a detection interval
 * to be considered "hamster present". 90 s is generous: snapshots are taken
 * every 2 min so this covers half a snapshot interval on each side.
 */
const HAMSTER_MATCH_WINDOW_MS = 90_000;

/**
 * Frigate detection events shorter than this many seconds are too brief to
 * extract a useful clip from (likely spurious / sub-second pass-throughs).
 */
const MIN_CLIP_EVENT_S = 3;

/** Clips are clamped to at most this many seconds. */
const MAX_CLIP_DURATION_S = 5;

/** Minimum clip duration to request from Frigate. */
const MIN_CLIP_DURATION_S = 3;

/**
 * Maximum number of video clips to mix in. Keeps the job from hammering
 * Frigate and keeps the reel from becoming clip-heavy.
 */
const MAX_CLIPS = 5;

/**
 * How many timeline buckets to divide the night into. More buckets → finer
 * temporal spread. With MAX_CLIPS=5 we want ~3x buckets to give each clip
 * its own region while still having still-frame buckets to fill gaps.
 */
const TIMELINE_BUCKETS = 30;

/**
 * Hysteresis: a camera must beat the incumbent by at least this fraction
 * of the incumbent's score before we switch. Kills flicker from near-ties.
 */
const SWITCH_MARGIN = 0.25;

/**
 * Activity weights for camera scoring. Identical to the previous version.
 */
const ACTIVITY_WEIGHT: Record<DiaryActivity, number> = {
  wheel: 10,
  food: 10,
  water: 10,
  bathroom: 10,
  resting: 4,
  tunnel: 4,
  exploring: 4,
  hiding: 4,
  transition: 0,
  snapshot: 1,
  timelapse: 0,
  recap: 0,
};

/** Duration of the capture window: 22:00–06:00 = 8 hours. */
const NIGHT_WINDOW_MS = 8 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface TimelapseRunResult {
  /** ISO `YYYY-MM-DD` of the night's START date (the evening the night began). */
  date: string;
  /** Whether ffmpeg actually produced a file (skipped on < MIN_FRAMES frames). */
  produced: boolean;
  /** Path under STORAGE_PATH the MP4 was written to (when produced). */
  media_path: string | null;
  /** Diary entry row id (when produced). */
  diary_entry_id: number | null;
}

/**
 * Run the timelapse job for the night ending at 06:00 on the given reference
 * time. Default: now (the cron fires at 06:05, so "now" naturally falls on the
 * morning after the night). Pass a fixed Date to pin the window for tests.
 *
 * Window: [nightStart, nightEnd) where nightEnd = today 06:00 local and
 * nightStart = nightEnd − 8h (= previous day 22:00 local).
 *
 * The output file and diary entry are keyed to nightStart's LOCAL DATE
 * (the evening the night began), so the night of May 24→25 produces
 * `timelapse/2026-05-24.mp4` labelled "May 24's Night".
 *
 * Idempotent: re-running for the same night replaces any existing timelapse
 * entry and overwrites the MP4 file.
 */
export async function runTimelapseJob(now?: Date): Promise<TimelapseRunResult> {
  const ref = now ?? new Date();
  const nightEnd = localSixAM(ref);
  const nightStart = nightEnd - NIGHT_WINDOW_MS;
  const isoDate = toIsoDate(new Date(nightStart));
  return runTimelapseForDate(isoDate, nightStart, nightEnd);
}

/**
 * Run the timelapse for a specific night, identified by its start date.
 * Used by the manual regen CLI and by `runTimelapseJob`.
 * `nightStart` and `nightEnd` are epoch-ms; both default to the natural window
 * for `isoDate` (22:00–06:00 local) when omitted.
 */
export async function runTimelapseForDate(
  isoDate: string,
  nightStart?: number,
  nightEnd?: number,
): Promise<TimelapseRunResult> {
  const cfg = getConfig();

  const computedNightEnd = nightEnd ?? computeNightEnd(isoDate);
  const computedNightStart = nightStart ?? (computedNightEnd - NIGHT_WINDOW_MS);

  // Fetch all snapshots in the window.
  const allSnapshots = db.listSnapshotsBetween(computedNightStart, computedNightEnd);

  // Query Frigate for hamster detections in the window.
  const detectionEvents = await fetchHamsterEvents(
    computedNightStart / 1000,
    computedNightEnd / 1000,
  );

  logger.info(
    { night: isoDate, snapshots: allSnapshots.length, detections: detectionEvents.length },
    'timelapse: raw material loaded',
  );

  // Filter snapshots to only those where a hamster was detected nearby.
  // If Frigate is unavailable (0 events returned) we fall back to all snapshots
  // so a temporarily-offline Frigate doesn't silently kill the recap.
  const hamsterSnapshots = detectionEvents.length > 0
    ? filterHamsterSnapshots(allSnapshots, detectionEvents)
    : allSnapshots;

  logger.info(
    {
      night: isoDate,
      hamster_snapshots: hamsterSnapshots.length,
      frigate_fallback: detectionEvents.length === 0,
    },
    'timelapse: hamster-filtered snapshot pool',
  );

  if (hamsterSnapshots.length < MIN_FRAMES && detectionEvents.length > 0) {
    logger.info(
      { night: isoDate, frames: hamsterSnapshots.length },
      'skipping timelapse — not enough hamster-detected frames',
    );
    return { date: isoDate, produced: false, media_path: null, diary_entry_id: null };
  }
  if (hamsterSnapshots.length < MIN_FRAMES) {
    logger.info(
      { night: isoDate, frames: hamsterSnapshots.length },
      'skipping timelapse — not enough snapshots',
    );
    return { date: isoDate, produced: false, media_path: null, diary_entry_id: null };
  }

  // Load narrative entries for camera-priority scoring.
  const narrativeEntries = db.listDiaryEntriesByKindBetween('narrative', computedNightStart, computedNightEnd);

  const stagingDir = await mkdtemp(join(tmpdir(), 'hamster-tl-'));

  try {
    // Fetch and normalise video clips from Frigate.
    const clipSegments = await fetchAndNormaliseClips(
      detectionEvents,
      computedNightStart,
      computedNightEnd,
      stagingDir,
    );

    logger.info(
      { night: isoDate, clips: clipSegments.length },
      'timelapse: clips fetched',
    );

    // Build the mixed timeline.
    const timeline = buildTimeline(
      hamsterSnapshots,
      narrativeEntries,
      clipSegments,
      computedNightStart,
      computedNightEnd,
    );

    if (timeline.segments.length < MIN_FRAMES) {
      logger.info(
        { night: isoDate, segments: timeline.segments.length },
        'skipping timelapse — too few timeline segments',
      );
      return { date: isoDate, produced: false, media_path: null, diary_entry_id: null };
    }

    // Stage still-frame symlinks and write the concat script.
    const concatResult = await stageAndWriteConcat(timeline, stagingDir, cfg.STORAGE_PATH);

    if (!concatResult) {
      logger.info({ night: isoDate }, 'skipping timelapse — not enough on-disk frames after staging');
      return { date: isoDate, produced: false, media_path: null, diary_entry_id: null };
    }

    const outDir = join(cfg.STORAGE_PATH, 'timelapse');
    await mkdir(outDir, { recursive: true });
    const outAbs = join(outDir, `${isoDate}.mp4`);
    const outRel = join('timelapse', `${isoDate}.mp4`);

    const pet = (db.getSetting('pet_name') ?? '').trim() || 'Pet';
    const watermark = `${pet}'s Night · ${isoDate}`.replace(/'/g, "\\'");

    // Check for background music file.
    const musicPath = await resolveMusicPath(cfg.RECAP_MUSIC_PATH);

    await renderVideo({
      concatPath: concatResult.concatPath,
      outAbs,
      watermark,
      musicPath,
      totalDurationS: concatResult.totalDurationS,
    });

    const realDurationMs = Math.round(concatResult.totalDurationS * 1000);

    const tpl = pickTemplate('timelapse');
    const narrative = render(tpl, { pet, date: isoDate });

    const entry = db.replaceTimelapseEntry(computedNightStart, computedNightEnd, {
      occurred_at: computedNightEnd - 1,
      kind: 'timelapse',
      activity: 'timelapse',
      narrative,
      pet_name: pet,
      camera_id: null,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: realDurationMs,
      snapshot_id: null,
      media_path: outRel,
      details: JSON.stringify({
        frames: timeline.stillCount,
        clips: timeline.clipCount,
        seconds_per_frame: SECONDS_PER_FRAME,
        output_fps: OUTPUT_FPS,
        total_duration_s: concatResult.totalDurationS,
        activity_guided: narrativeEntries.length > 0,
        hamster_filtered: detectionEvents.length > 0,
        music: musicPath !== null,
      }),
    });

    logger.info(
      {
        night: isoDate,
        frames: timeline.stillCount,
        clips: timeline.clipCount,
        duration_s: concatResult.totalDurationS,
        music: musicPath !== null,
        path: outAbs,
        entry: entry.id,
      },
      'timelapse produced',
    );

    void generateThumbnailForEntry(entry);
    return {
      date: isoDate,
      produced: true,
      media_path: outRel,
      diary_entry_id: entry.id,
    };
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Hamster detection filter
// ---------------------------------------------------------------------------

/**
 * Return snapshots whose `taken_at` falls within HAMSTER_MATCH_WINDOW_MS of
 * any detection event's time range [startMs, endMs]. A snapshot within the
 * window is included even if it slightly precedes the event start (camera
 * detected the hamster just before our interval starts).
 */
function filterHamsterSnapshots(
  snapshots: SnapshotRow[],
  events: FrigateDetectionEvent[],
): SnapshotRow[] {
  // Build intervals in ms.
  const intervals = events.map((e) => ({
    start: e.start_time * 1000 - HAMSTER_MATCH_WINDOW_MS,
    end: (e.end_time ?? e.start_time + 60) * 1000 + HAMSTER_MATCH_WINDOW_MS,
  }));

  return snapshots.filter((snap) =>
    intervals.some((iv) => snap.taken_at >= iv.start && snap.taken_at <= iv.end),
  );
}

// ---------------------------------------------------------------------------
// Clip fetching + normalisation
// ---------------------------------------------------------------------------

interface ClipSegment {
  /** Absolute path to the normalised MP4 clip. */
  absPath: string;
  /** Duration in seconds (clamped to [MIN_CLIP_DURATION_S, MAX_CLIP_DURATION_S]). */
  durationS: number;
  /** Midpoint of the clip (epoch-ms) — used for timeline placement. */
  midMs: number;
  /** Camera name from the detection event. */
  camera: string;
}

/**
 * For each detection event long enough to yield a useful clip, fetch the clip
 * from Frigate, normalise it to TARGET_W×TARGET_H at OUTPUT_FPS H.264, and
 * return the list. Failures are silently skipped. At most MAX_CLIPS clips.
 * Clips are spread temporally (at most one per TIMELINE_BUCKET).
 */
async function fetchAndNormaliseClips(
  events: FrigateDetectionEvent[],
  nightStartMs: number,
  nightEndMs: number,
  stagingDir: string,
): Promise<ClipSegment[]> {
  const cfg = getConfig();
  if (!cfg.FRIGATE_URL) return [];

  // Filter to events with sufficient duration.
  const candidates = events
    .filter((e) => {
      const dur = (e.end_time ?? 0) - e.start_time;
      return e.end_time !== null && dur >= MIN_CLIP_EVENT_S && e.has_clip;
    })
    .sort((a, b) => a.start_time - b.start_time);

  if (candidates.length === 0) return [];

  // Spread selection: divide the night into MAX_CLIPS buckets and pick the
  // longest event in each bucket. This ensures clips represent the whole night.
  const bucketMs = (nightEndMs - nightStartMs) / MAX_CLIPS;
  const selectedEvents: FrigateDetectionEvent[] = [];
  for (let b = 0; b < MAX_CLIPS; b += 1) {
    const bucketStart = nightStartMs + b * bucketMs;
    const bucketEnd = bucketStart + bucketMs;
    const inBucket = candidates.filter(
      (e) => e.start_time * 1000 >= bucketStart && e.start_time * 1000 < bucketEnd,
    );
    if (inBucket.length === 0) continue;
    // Pick the longest event in the bucket.
    const best = inBucket.reduce((a, b) =>
      (b.end_time ?? b.start_time) - b.start_time >
      (a.end_time ?? a.start_time) - a.start_time ? b : a,
    );
    selectedEvents.push(best);
    if (selectedEvents.length >= MAX_CLIPS) break;
  }

  const segments: ClipSegment[] = [];

  for (const event of selectedEvents) {
    if (segments.length >= MAX_CLIPS) break;

    const dur = Math.min((event.end_time ?? event.start_time + MIN_CLIP_EVENT_S) - event.start_time, MAX_CLIP_DURATION_S);
    const clampedDur = Math.max(MIN_CLIP_DURATION_S, Math.min(MAX_CLIP_DURATION_S, dur));
    const centerSec = event.start_time + clampedDur / 2;
    const startSec = Math.floor(centerSec - clampedDur / 2);
    const endSec = Math.ceil(centerSec + clampedDur / 2);

    const rawPath = join(stagingDir, `clip-raw-${event.id}.mp4`);
    const normPath = join(stagingDir, `clip-norm-${event.id}.mp4`);

    const sourceUrl = new URL(
      `/api/${encodeURIComponent(event.camera)}/start/${startSec}/end/${endSec}/clip.mp4`,
      cfg.FRIGATE_URL,
    ).toString();

    try {
      // Step 1: download clip from Frigate.
      await runFfmpeg([
        '-y',
        '-i', sourceUrl,
        '-c', 'copy',
        '-movflags', '+faststart',
        rawPath,
      ]);

      // Step 2: verify the raw clip has real content.
      const rawSt = await stat(rawPath).catch(() => null);
      if (!rawSt || rawSt.size < 1024) {
        logger.debug({ event: event.id }, 'timelapse: raw clip too small, skipping');
        continue;
      }

      // Step 3: normalise to TARGET_W×TARGET_H, OUTPUT_FPS, H.264 — this makes
      // the clip bitstream-compatible with the still-frame concat stream.
      const vfNorm = [
        `scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=decrease`,
        `pad=${TARGET_W}:${TARGET_H}:(ow-iw)/2:(oh-ih)/2`,
        `fps=${OUTPUT_FPS}`,
      ].join(',');
      await runFfmpeg([
        '-y',
        '-i', rawPath,
        '-vf', vfNorm,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-pix_fmt', 'yuv420p',
        '-an',                    // strip audio from clips — will be replaced by music
        '-movflags', '+faststart',
        normPath,
      ]);

      const normSt = await stat(normPath).catch(() => null);
      if (!normSt || normSt.size < 1024) {
        logger.debug({ event: event.id }, 'timelapse: normalised clip too small, skipping');
        continue;
      }

      segments.push({
        absPath: normPath,
        durationS: clampedDur,
        midMs: Math.round(centerSec * 1000),
        camera: event.camera,
      });

      logger.debug(
        { event: event.id, camera: event.camera, durationS: clampedDur },
        'timelapse: clip normalised',
      );
    } catch (err) {
      const stderrTail = err instanceof FfmpegError ? stderrSummary(err.stderr) : undefined;
      logger.warn(
        { event: event.id, err: (err as Error).message, ffmpeg_stderr: stderrTail },
        'timelapse: clip fetch/normalise failed — skipping',
      );
    }
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Timeline composition
// ---------------------------------------------------------------------------

interface TimelineSegment {
  type: 'still' | 'clip';
  /** Absolute path to the file. */
  absPath: string;
  /** Duration in seconds (SECONDS_PER_FRAME for stills, clip duration for clips). */
  durationS: number;
  /** Temporal midpoint (epoch-ms) — used for ordering. */
  midMs: number;
}

interface Timeline {
  segments: TimelineSegment[];
  stillCount: number;
  clipCount: number;
}

/**
 * Build a chronologically ordered list of TimelineSegments combining stills
 * and clips, targeting TARGET_SECONDS total duration.
 *
 * Strategy:
 *   1. Assign clip segments to their natural temporal positions.
 *   2. Fill remaining time budget with still-frame buckets (activity-guided
 *      camera selection + hysteresis, same as before).
 *   3. If the combined duration exceeds TARGET_SECONDS, evenly thin out still
 *      slots (remove every Nth) until we land at or below the target.
 *   4. Final segments are sorted chronologically.
 */
function buildTimeline(
  snapshots: SnapshotRow[],
  narrativeEntries: DiaryEntryRow[],
  clips: ClipSegment[],
  nightStartMs: number,
  nightEndMs: number,
): Timeline {
  const clipDurationS = clips.reduce((s, c) => s + c.durationS, 0);
  const remainingS = Math.max(0, TARGET_SECONDS - clipDurationS);
  // How many still-frame slots fit in the remaining budget?
  const maxStillSlots = Math.floor(remainingS / SECONDS_PER_FRAME);

  // Run activity-guided bucket selection to get the still frames.
  const selectedStills = selectFrames(
    snapshots,
    narrativeEntries,
    nightStartMs,
    nightEndMs,
    Math.max(maxStillSlots, MIN_FRAMES),
  );

  // De-duplicate consecutive stills.
  const dedupedStills = dedupConsecutive(selectedStills);

  // Now check if still + clip total exceeds TARGET_SECONDS.
  const totalBeforeTrim = dedupedStills.length * SECONDS_PER_FRAME + clipDurationS;
  let finalStills: SnapshotRow[];
  if (totalBeforeTrim > TARGET_SECONDS + SECONDS_PER_FRAME) {
    // Thin stills: keep only Math.floor(remaining budget / SECONDS_PER_FRAME) stills.
    const targetStillCount = Math.floor((TARGET_SECONDS - clipDurationS) / SECONDS_PER_FRAME);
    finalStills = thinEvenly(dedupedStills, Math.max(0, targetStillCount));
  } else {
    finalStills = dedupedStills;
  }

  // Build clip-time lookup for mid-point filtering (avoid stills that duplicate clip moments).
  const clipMidSet = new Set(clips.map((c) => c.midMs));

  // Convert stills to TimelineSegments with estimated midMs.
  const stillSegments: TimelineSegment[] = finalStills.map((s) => ({
    type: 'still' as const,
    absPath: s.path, // will be symlinked later in stageAndWriteConcat
    durationS: SECONDS_PER_FRAME,
    midMs: s.taken_at,
  }));

  // Exclude stills whose timestamp falls within a clip's window to avoid
  // showing the same moment as both a still and a clip.
  const clipIntervals = clips.map((c) => ({
    start: c.midMs - c.durationS * 500,
    end: c.midMs + c.durationS * 500,
  }));
  const filteredStillSegments = stillSegments.filter(
    (seg) => !clipIntervals.some((iv) => seg.midMs >= iv.start && seg.midMs <= iv.end),
  );

  // Convert clips to TimelineSegments.
  const clipSegments: TimelineSegment[] = clips.map((c) => ({
    type: 'clip' as const,
    absPath: c.absPath,
    durationS: c.durationS,
    midMs: c.midMs,
  }));

  // Merge and sort chronologically.
  const all = [...filteredStillSegments, ...clipSegments].sort((a, b) => a.midMs - b.midMs);

  void clipMidSet; // suppress unused warning — used conceptually above

  return {
    segments: all,
    stillCount: filteredStillSegments.length,
    clipCount: clipSegments.length,
  };
}

// ---------------------------------------------------------------------------
// Staging + concat script
// ---------------------------------------------------------------------------

interface StagingResult {
  concatPath: string;
  totalDurationS: number;
}

/**
 * Normalise every still-frame JPEG into a short H.264 MP4 segment, then write
 * a concat demuxer script that references only uniform H.264 MP4 files (both
 * still segments and pre-normalised clip segments).
 *
 * WHY: ffmpeg's -f concat demuxer requires stream-uniform inputs. A concat
 * list that mixes mjpeg-stills with h264-clips produces "Conversion failed!"
 * (exit 69) as soon as the demuxer crosses a stream boundary. Normalising
 * every still to H.264 first makes the whole list homogeneous, so the final
 * concat can use -c:v copy (no re-encode) and succeeds cleanly.
 *
 * Each still gets its own ffmpeg call:
 *   -loop 1 -t <SECONDS_PER_FRAME> -i <jpeg>
 *   -vf scale/pad/fps  (same normalisation as clips)
 *   -c:v libx264 -pix_fmt yuv420p
 *
 * Still-normalisation failures are silently skipped (non-fatal, same policy
 * as clip-normalisation failures).
 *
 * Returns null when fewer than MIN_FRAMES on-disk segments are available
 * after normalisation.
 */
async function stageAndWriteConcat(
  timeline: Timeline,
  stagingDir: string,
  storagePath: string,
): Promise<StagingResult | null> {
  // vf applied to every still segment — keeps res/fps/SAR identical to clips.
  const stillVf = [
    `scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=decrease`,
    `pad=${TARGET_W}:${TARGET_H}:(ow-iw)/2:(oh-ih)/2`,
    `fps=${OUTPUT_FPS}`,
  ].join(',');

  const concatEntries: string[] = [];
  let totalDurationS = 0;
  let validCount = 0;
  let stillIndex = 0;

  for (const seg of timeline.segments) {
    if (seg.type === 'still') {
      const srcAbs = seg.absPath.startsWith('/')
        ? seg.absPath
        : join(storagePath, seg.absPath);
      if (!existsSync(srcAbs)) continue;

      const normMp4 = join(stagingDir, `still-${String(stillIndex).padStart(4, '0')}.mp4`);
      stillIndex += 1;

      try {
        await runFfmpeg([
          '-y',
          '-loop', '1',
          '-t', String(SECONDS_PER_FRAME),
          '-i', srcAbs,
          '-vf', stillVf,
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-pix_fmt', 'yuv420p',
          '-an',
          '-movflags', '+faststart',
          normMp4,
        ]);
      } catch (err) {
        const stderrTail = err instanceof FfmpegError ? stderrSummary(err.stderr) : undefined;
        logger.warn(
          { path: srcAbs, err: (err as Error).message, ffmpeg_stderr: stderrTail },
          'timelapse: still normalisation failed — skipping frame',
        );
        continue;
      }

      if (!existsSync(normMp4)) continue;

      concatEntries.push(`file '${normMp4}'`);
      totalDurationS += SECONDS_PER_FRAME;
      validCount += 1;
    } else {
      // Clip segment — already a normalised H.264 MP4.
      if (!existsSync(seg.absPath)) continue;
      concatEntries.push(`file '${seg.absPath}'`);
      totalDurationS += seg.durationS;
      validCount += 1;
    }
  }

  if (validCount < MIN_FRAMES) return null;

  const concatScript = `ffconcat version 1.0\n${concatEntries.join('\n')}\n`;
  const concatPath = join(stagingDir, 'concat.txt');
  await writeFile(concatPath, concatScript, 'utf8');

  return { concatPath, totalDurationS };
}

// ---------------------------------------------------------------------------
// ffmpeg rendering
// ---------------------------------------------------------------------------

interface RenderVideoInput {
  concatPath: string;
  outAbs: string;
  watermark: string;
  musicPath: string | null;
  totalDurationS: number;
}

/**
 * Render the final output video from the concat script.
 *
 * All inputs in the concat list are uniform H.264 MP4 segments (stills were
 * pre-normalised in stageAndWriteConcat), so pass 1 can use -c:v copy —
 * fast, lossless, and no stream-uniformity issues.
 *
 * The watermark vf chain is applied ONCE in the final output step:
 *   - No music → single pass: concat stream-copy → watermark re-encode.
 *   - With music → two passes:
 *       1. concat → stream-copy → intermediate silent MP4 (no watermark yet).
 *       2. silent MP4 + music → watermark encode + audio mix → final output.
 *     The watermark encode and the music mix happen together in pass 2 so we
 *     only re-encode the video pixels once.
 */
async function renderVideo(input: RenderVideoInput): Promise<void> {
  // Watermark filter applied on the final encode (exactly once, regardless of
  // whether music is present). NOT applied per-segment.
  const watermarkVf = `drawtext=text='${input.watermark}':fontcolor=white:fontsize=24:box=1:boxcolor=black@0.4:boxborderw=8:x=w-tw-20:y=h-th-20`;

  if (input.musicPath === null) {
    // No music: single pass — concat (stream-copy) → watermark re-encode.
    await runFfmpeg([
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', input.concatPath,
      '-vf', watermarkVf,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-crf', '23',
      '-movflags', '+faststart',
      input.outAbs,
    ]);
    return;
  }

  // With music: two passes.
  //
  // Pass 1: concat all uniform H.264 segments via stream-copy into a silent
  // intermediate. No re-encode here — keep it fast and avoid quality loss.
  const silentPath = input.outAbs.replace(/\.mp4$/, '-silent.mp4');
  await runFfmpeg([
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', input.concatPath,
    '-c:v', 'copy',
    '-an',
    '-movflags', '+faststart',
    silentPath,
  ]);

  // Pass 2: watermark encode + music mix in one step.
  // afade=t=out fades the music out over the last 3 seconds.
  // aloop=-1 loops the audio track infinitely; atrim cuts it to video length.
  const fadeStart = Math.max(0, input.totalDurationS - 3);
  const audioFilter = [
    `aloop=loop=-1:size=2147483647`,
    `atrim=duration=${input.totalDurationS.toFixed(3)}`,
    `volume=-18dB`,
    `afade=t=out:st=${fadeStart.toFixed(3)}:d=3`,
  ].join(',');

  try {
    await runFfmpeg([
      '-y',
      '-i', silentPath,
      '-stream_loop', '-1',
      '-i', input.musicPath,
      '-filter_complex', `[1:a]${audioFilter}[music]`,
      '-map', '0:v',
      '-map', '[music]',
      '-vf', watermarkVf,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-shortest',
      '-movflags', '+faststart',
      input.outAbs,
    ]);
  } catch (err) {
    // If the music pass fails, fall back to the silent video rather than killing the job.
    // The silent video has no watermark in this path but is better than nothing.
    const stderrTail = err instanceof FfmpegError ? stderrSummary(err.stderr) : undefined;
    logger.warn(
      { err: (err as Error).message, ffmpeg_stderr: stderrTail },
      'timelapse: music mixing failed — falling back to silent video',
    );
    const { rename } = await import('node:fs/promises');
    await rename(silentPath, input.outAbs);
    return;
  }

  // Clean up the silent intermediate.
  await rm(silentPath, { force: true }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Frame selection (activity-guided camera scoring + hysteresis)
// ---------------------------------------------------------------------------

/**
 * Divide the night window into `targetSlots` equal buckets, score cameras per
 * bucket using weighted activity overlap, apply hysteresis, then pick the
 * nearest snapshot per bucket from the winning camera.
 */
function selectFrames(
  allSnapshots: SnapshotRow[],
  narrativeEntries: DiaryEntryRow[],
  nightStart: number,
  nightEnd: number,
  targetSlots: number,
): SnapshotRow[] {
  const windowMs = nightEnd - nightStart;
  const slots = Math.max(1, targetSlots);
  const bucketMs = windowMs / slots;

  const cameraIds = [...new Set(allSnapshots.map((s) => s.camera_id))];
  const snapshotsByCamera = new Map<number, SnapshotRow[]>();
  for (const camId of cameraIds) {
    snapshotsByCamera.set(
      camId,
      allSnapshots.filter((s) => s.camera_id === camId),
    );
  }

  const countByCamera = new Map<number, number>();
  for (const [camId, snaps] of snapshotsByCamera) {
    countByCamera.set(camId, snaps.length);
  }

  const scorableEntries = narrativeEntries.filter(
    (e): e is DiaryEntryRow & { camera_id: number } =>
      e.camera_id !== null &&
      e.activity !== null &&
      ACTIVITY_WEIGHT[e.activity] > 0,
  );

  const fallbackCamera = pickFallbackCamera(cameraIds, countByCamera);
  const hasActivity = scorableEntries.length > 0;

  const selected: SnapshotRow[] = [];
  let prevCamera: number | null = null;
  let prevScore = 0;

  for (let b = 0; b < slots; b += 1) {
    const bucketStart = nightStart + b * bucketMs;
    const bucketEnd = bucketStart + bucketMs;
    const bucketCenter = (bucketStart + bucketEnd) / 2;

    let chosenCamera: number;

    if (!hasActivity) {
      chosenCamera = fallbackCamera;
    } else {
      const scores = new Map<number, number>();
      for (const camId of cameraIds) scores.set(camId, 0);

      for (const entry of scorableEntries) {
        if (entry.camera_id === null) continue;
        const entryStart = entry.occurred_at;
        const entryEnd = entry.occurred_at + (entry.duration_ms ?? 0);
        const overlap = Math.max(0, Math.min(entryEnd, bucketEnd) - Math.max(entryStart, bucketStart));
        if (overlap <= 0) continue;
        const weight = ACTIVITY_WEIGHT[entry.activity ?? 'exploring'] ?? 0;
        scores.set(entry.camera_id, (scores.get(entry.camera_id) ?? 0) + overlap * weight);
      }

      let bestCam = fallbackCamera;
      let bestScore = 0;
      for (const [camId, score] of scores) {
        if (score > bestScore) {
          bestScore = score;
          bestCam = camId;
        }
      }

      if (prevCamera !== null && bestCam !== prevCamera) {
        const threshold = prevScore * (1 + SWITCH_MARGIN);
        if (bestScore < threshold) {
          bestCam = prevCamera;
          bestScore = prevScore;
        }
      }

      chosenCamera = bestCam;
      prevCamera = bestCam;
      prevScore = bestScore;
    }

    const snap = nearestSnapshot(chosenCamera, bucketCenter, snapshotsByCamera, allSnapshots);
    if (snap) selected.push(snap);
  }

  return selected;
}

function nearestSnapshot(
  cameraId: number,
  targetMs: number,
  snapshotsByCamera: Map<number, SnapshotRow[]>,
  allSnapshots: SnapshotRow[],
): SnapshotRow | null {
  const pool = snapshotsByCamera.get(cameraId);
  const snap = pool && pool.length > 0
    ? closest(pool, targetMs)
    : closest(allSnapshots, targetMs);
  return snap ?? null;
}

function closest(snaps: SnapshotRow[], targetMs: number): SnapshotRow | undefined {
  if (snaps.length === 0) return undefined;
  let best = snaps[0];
  let bestDiff = Math.abs((snaps[0]?.taken_at ?? 0) - targetMs);
  for (let i = 1; i < snaps.length; i += 1) {
    const s = snaps[i];
    if (!s) continue;
    const diff = Math.abs(s.taken_at - targetMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = s;
    }
  }
  return best;
}

function pickFallbackCamera(cameraIds: number[], countByCamera: Map<number, number>): number {
  let bestCam = cameraIds[0] ?? 0;
  let bestCount = countByCamera.get(bestCam) ?? 0;
  for (const camId of cameraIds) {
    const count = countByCamera.get(camId) ?? 0;
    if (count > bestCount || (count === bestCount && camId < bestCam)) {
      bestCam = camId;
      bestCount = count;
    }
  }
  return bestCam;
}

function dedupConsecutive(snaps: SnapshotRow[]): SnapshotRow[] {
  const out: SnapshotRow[] = [];
  let lastId = -1;
  for (const s of snaps) {
    if (s.id !== lastId) {
      out.push(s);
      lastId = s.id;
    }
  }
  return out;
}

/**
 * Reduce `arr` to `targetCount` elements by evenly spacing selection indices.
 * When targetCount >= arr.length, returns the full array.
 */
function thinEvenly<T>(arr: T[], targetCount: number): T[] {
  if (targetCount <= 0) return [];
  if (targetCount >= arr.length) return arr;
  if (targetCount === 1) {
    // Edge case: pick the first element to preserve the earliest moment.
    const first = arr[0];
    return first !== undefined ? [first] : [];
  }
  const out: T[] = [];
  for (let i = 0; i < targetCount; i += 1) {
    const idx = Math.round((i * (arr.length - 1)) / (targetCount - 1));
    const item = arr[idx];
    if (item !== undefined) out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Music path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the background music file path. Returns the path if the file
 * exists and is non-empty, null otherwise (logs a warning when configured
 * but missing). Never throws.
 */
async function resolveMusicPath(configuredPath: string | undefined): Promise<string | null> {
  if (!configuredPath) return null;
  try {
    const st = await stat(configuredPath);
    if (st.size > 0) return configuredPath;
    logger.warn({ path: configuredPath }, 'timelapse: music file is empty — proceeding without music');
    return null;
  } catch {
    logger.warn({ path: configuredPath }, 'timelapse: music file not found — proceeding without music');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function localSixAM(ref: Date): number {
  const copy = new Date(ref);
  copy.setHours(6, 0, 0, 0);
  return copy.getTime();
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Compute nightEnd (06:00 local) for an isoDate string representing the
 * evening the night began (e.g. "2026-05-24" → 2026-05-25 06:00:00 local).
 */
function computeNightEnd(isoDate: string): number {
  // Parse the isoDate as local midnight, then add 1 day + 6 hours.
  const [y, m, d] = isoDate.split('-').map(Number);
  if (!y || !m || !d) throw new Error(`Invalid isoDate: ${isoDate}`);
  const nightEndDate = new Date(y, m - 1, d + 1, 6, 0, 0, 0);
  return nightEndDate.getTime();
}

// ---------------------------------------------------------------------------
// Test-only exports (white-box)
// ---------------------------------------------------------------------------

/** Exported purely for unit tests. */
export const selectFramesForTest = selectFrames;

/** Exported purely for unit tests. */
export const filterHamsterSnapshotsForTest = filterHamsterSnapshots;

/** Exported purely for unit tests. */
export const thinEvenlyForTest = thinEvenly;

/** Exported purely for unit tests. */
export const stageAndWriteConcatForTest = stageAndWriteConcat;

/** Exported purely for unit tests. */
export const stderrSummaryForTest = stderrSummary;
