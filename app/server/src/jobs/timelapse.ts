// app/server/src/jobs/timelapse.ts
// Nightly 06:05 local: stitch the previous night's snapshots (22:00–06:00)
// into a ~60s gentle slideshow MP4 and write a 'timelapse' diary entry.
// Idempotent per night.
//
// ALGORITHM (bucket-based, camera-stable):
//   1. Divide the 8h night window into RECAP_FRAMES equal-duration buckets.
//   2. Load narrator diary entries (kind='narrative') for the window; score
//      each camera per bucket by its weighted activity overlap.
//   3. Pick the best camera per bucket with hysteresis (requires a clear-margin
//      win to switch cameras, preventing rapid flickering).
//   4. No-activity fallback: single camera for the whole recap (most snapshots,
//      tie-break lowest id).
//   5. For each bucket, pick the snapshot from the chosen camera nearest to
//      the bucket centre. Widen to the full night if necessary; fall back to
//      any camera if the chosen camera has no snapshot at all.
//   6. Render via ffmpeg concat demuxer: each frame held SECONDS_PER_FRAME,
//      upsampled to OUTPUT_FPS for browser-compatible playback.

import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getConfig } from '../config.js';
import * as db from '../db.js';
import type { DiaryActivity, DiaryEntryRow, SnapshotRow } from '../db.js';
import { runFfmpeg } from '../frigate.js';
import { childLogger } from '../logger.js';
import { pickTemplate, render } from '../narratives.js';
import { generateThumbnailForEntry } from '../thumbnails.js';

const logger = childLogger('timelapse-job');

// ---------------------------------------------------------------------------
// Recap constants — change here only, never touch settings plumbing (YAGNI).
// ---------------------------------------------------------------------------

/** Target output duration in seconds. */
const RECAP_TARGET_SECONDS = 60;

/** Seconds each frame is displayed. Determines bucket count + hold duration. */
const SECONDS_PER_FRAME = 2.5;

/** Output framerate for browser compatibility. */
const OUTPUT_FPS = 30;

/** Minimum distinct frames required to produce a recap (quiet night guard). */
const MIN_FRAMES = 12;

/** Target width/height for the output video. */
const TARGET_W = 1280;
const TARGET_H = 720;

/** Total number of frame slots in the slideshow. */
const RECAP_FRAMES = Math.round(RECAP_TARGET_SECONDS / SECONDS_PER_FRAME); // 24

/**
 * Hysteresis: a camera must beat the incumbent by at least this fraction of
 * the incumbent's score before we switch. Kills the flicker from near-ties.
 */
const SWITCH_MARGIN = 0.25;

/**
 * Activity weights for camera scoring.
 * High-value: wheel, food, water, bathroom (direct pet interaction signals).
 * Medium: resting, tunnel, exploring, hiding (presence, but less notable).
 * Lowest/ignored: transition (camera change artefact, not a location signal).
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
 */
export async function runTimelapseJob(now?: Date): Promise<TimelapseRunResult> {
  const cfg = getConfig();
  const ref = now ?? new Date();

  const nightEnd = localSixAM(ref);
  const nightStart = nightEnd - NIGHT_WINDOW_MS;

  // isoDate keys to the START of the night (the evening) so "2026-05-24" is
  // the correct label for the 22:00 May 24 → 06:00 May 25 session.
  const isoDate = toIsoDate(new Date(nightStart));

  const allSnapshots = db.listSnapshotsBetween(nightStart, nightEnd);

  if (allSnapshots.length < MIN_FRAMES) {
    logger.info(
      { night: isoDate, frames: allSnapshots.length },
      'skipping timelapse — not enough snapshots',
    );
    return { date: isoDate, produced: false, media_path: null, diary_entry_id: null };
  }

  // Load narrator diary entries for the night to drive camera prioritisation.
  const narrativeEntries = db.listDiaryEntriesByKindBetween('narrative', nightStart, nightEnd);

  // Select one snapshot per bucket using the activity-weighted camera chooser.
  const selected = selectFrames(allSnapshots, narrativeEntries, nightStart, nightEnd);

  // Deduplicate consecutive identical snapshot ids (same file won't cause
  // a visible flash, but it wastes frames; remove consecutive dupes).
  const deduped = dedupConsecutive(selected);

  if (deduped.length < MIN_FRAMES) {
    logger.info(
      { night: isoDate, frames: deduped.length },
      'skipping timelapse — too few distinct frames after dedup',
    );
    return { date: isoDate, produced: false, media_path: null, diary_entry_id: null };
  }

  // Stage frames and write the concat script in a temp dir.
  const stagingDir = await mkdtemp(join(tmpdir(), 'hamster-tl-'));
  try {
    // Symlink each chosen snapshot into the staging dir with a stable name.
    const frameNames: string[] = [];
    for (let i = 0; i < deduped.length; i += 1) {
      const snap = deduped[i];
      if (!snap) continue;
      const srcAbs = snap.path.startsWith('/')
        ? snap.path
        : join(cfg.STORAGE_PATH, snap.path);
      if (!existsSync(srcAbs)) continue;
      const dest = join(stagingDir, `frame-${String(i).padStart(4, '0')}.jpg`);
      await symlink(srcAbs, dest);
      frameNames.push(dest);
    }

    if (frameNames.length < MIN_FRAMES) {
      logger.info(
        { night: isoDate, frames: frameNames.length },
        'skipping timelapse — not enough on-disk frames',
      );
      return { date: isoDate, produced: false, media_path: null, diary_entry_id: null };
    }

    // Write ffmpeg concat script. Each `duration` line tells the concat
    // demuxer how long to display that image before advancing. We hold each
    // frame for SECONDS_PER_FRAME seconds. This approach is immune to the
    // complexity of chaining 24+ xfade filters and produces a correct total
    // duration without transcoding trickery.
    //
    // Format (concat demuxer):
    //   ffconcat version 1.0
    //   file '/abs/path/frame-0000.jpg'
    //   duration 2.5
    //   ...
    //   file '/abs/path/frame-NNNN.jpg'
    //   duration 2.5
    //   # Final entry: repeat last frame so the last `duration` is honoured.
    //   file '/abs/path/frame-NNNN.jpg'
    //   duration 0
    const lastFrame = frameNames[frameNames.length - 1];
    let concatScript = 'ffconcat version 1.0\n';
    for (const f of frameNames) {
      concatScript += `file '${f}'\nduration ${SECONDS_PER_FRAME}\n`;
    }
    // Duplicate the last frame with duration 0 — required by the concat
    // demuxer to correctly display the duration of the penultimate frame.
    concatScript += `file '${lastFrame}'\nduration 0\n`;

    const concatPath = join(stagingDir, 'concat.txt');
    await writeFile(concatPath, concatScript, 'utf8');

    const outDir = join(cfg.STORAGE_PATH, 'timelapse');
    await mkdir(outDir, { recursive: true });
    const outAbs = join(outDir, `${isoDate}.mp4`);
    const outRel = join('timelapse', `${isoDate}.mp4`);

    // Watermark text.
    const pet = (db.getSetting('pet_name') ?? '').trim() || 'Pet';
    const watermark = `${pet}'s Night · ${isoDate}`.replace(/'/g, "\\'");
    const vfChain = [
      `scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=decrease`,
      `pad=${TARGET_W}:${TARGET_H}:(ow-iw)/2:(oh-ih)/2`,
      `fps=${OUTPUT_FPS}`,
      `drawtext=text='${watermark}':fontcolor=white:fontsize=24:box=1:boxcolor=black@0.4:boxborderw=8:x=w-tw-20:y=h-th-20`,
    ].join(',');

    // ffmpeg concat demuxer approach:
    //   -f concat -safe 0 -i concat.txt   → reads the script; each frame held per `duration`
    //   -vf scale+pad+fps+drawtext        → normalise resolution, upsample to OUTPUT_FPS,
    //                                        watermark
    //   -c:v libx264 -pix_fmt yuv420p     → H.264 for universal browser playback
    //   -crf 23                           → quality
    //   -movflags +faststart              → web-seekable (required: served from /timelapse/*)
    //   -vsync vfr                        → honour variable timestamps from concat demuxer
    await runFfmpeg([
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatPath,
      '-vf', vfChain,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-crf', '23',
      '-movflags', '+faststart',
      '-vsync', 'vfr',
      outAbs,
    ]);

    // Compute real duration from the actual frame count × hold time.
    const realDurationMs = Math.round(frameNames.length * SECONDS_PER_FRAME * 1000);

    const tpl = pickTemplate('timelapse');
    const narrative = render(tpl, { pet, date: isoDate });
    // occurred_at = nightEnd - 1 so the diary card lands at the top of the
    // morning feed ("last night's adventures"), just before the recap entry.
    const entry = db.replaceTimelapseEntry(nightStart, nightEnd, {
      occurred_at: nightEnd - 1,
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
        frames: frameNames.length,
        seconds_per_frame: SECONDS_PER_FRAME,
        output_fps: OUTPUT_FPS,
        activity_guided: narrativeEntries.length > 0,
      }),
    });

    logger.info(
      {
        night: isoDate,
        frames: frameNames.length,
        seconds_per_frame: SECONDS_PER_FRAME,
        duration_s: realDurationMs / 1000,
        activity_guided: narrativeEntries.length > 0,
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
// Frame selection
// ---------------------------------------------------------------------------

/**
 * Divide the night window into RECAP_FRAMES equal buckets, score cameras per
 * bucket using weighted activity overlap, apply hysteresis, then pick the
 * nearest snapshot per bucket from the winning camera.
 */
function selectFrames(
  allSnapshots: SnapshotRow[],
  narrativeEntries: DiaryEntryRow[],
  nightStart: number,
  nightEnd: number,
): SnapshotRow[] {
  const bucketMs = NIGHT_WINDOW_MS / RECAP_FRAMES;

  // Determine which camera ids have snapshots.
  const cameraIds = [...new Set(allSnapshots.map((s) => s.camera_id))];

  // Index snapshots per camera for quick nearest-lookup.
  const snapshotsByCamera = new Map<number, SnapshotRow[]>();
  for (const camId of cameraIds) {
    snapshotsByCamera.set(
      camId,
      allSnapshots.filter((s) => s.camera_id === camId),
    );
  }

  // Snapshot-count per camera — used for the no-activity fallback.
  const countByCamera = new Map<number, number>();
  for (const [camId, snaps] of snapshotsByCamera) {
    countByCamera.set(camId, snaps.length);
  }

  // Filter narrative entries to only those with a valid camera_id and weight.
  const scorableEntries = narrativeEntries.filter(
    (e): e is DiaryEntryRow & { camera_id: number } =>
      e.camera_id !== null &&
      e.activity !== null &&
      ACTIVITY_WEIGHT[e.activity] > 0,
  );

  // If there are no scorable entries, fall back: single camera for all buckets.
  const fallbackCamera = pickFallbackCamera(cameraIds, countByCamera);
  const hasActivity = scorableEntries.length > 0;

  const selected: SnapshotRow[] = [];
  let prevCamera: number | null = null;
  let prevScore = 0;

  for (let b = 0; b < RECAP_FRAMES; b += 1) {
    const bucketStart = nightStart + b * bucketMs;
    const bucketEnd = bucketStart + bucketMs;
    const bucketCenter = (bucketStart + bucketEnd) / 2;

    let chosenCamera: number;

    if (!hasActivity) {
      chosenCamera = fallbackCamera;
    } else {
      // Score each camera by weighted overlap with narrative entries in this bucket.
      const scores = new Map<number, number>();
      for (const camId of cameraIds) {
        scores.set(camId, 0);
      }

      for (const entry of scorableEntries) {
        if (entry.camera_id === null) continue;
        const entryStart = entry.occurred_at;
        const entryEnd = entry.occurred_at + (entry.duration_ms ?? 0);
        const overlap = Math.max(0, Math.min(entryEnd, bucketEnd) - Math.max(entryStart, bucketStart));
        if (overlap <= 0) continue;
        const weight = ACTIVITY_WEIGHT[entry.activity ?? 'exploring'] ?? 0;
        scores.set(entry.camera_id, (scores.get(entry.camera_id) ?? 0) + overlap * weight);
      }

      // Find best-scoring camera.
      let bestCam = fallbackCamera;
      let bestScore = 0;
      for (const [camId, score] of scores) {
        if (score > bestScore) {
          bestScore = score;
          bestCam = camId;
        }
      }

      // Hysteresis: only switch if the new camera beats the previous by SWITCH_MARGIN.
      if (prevCamera !== null && bestCam !== prevCamera) {
        const threshold = prevScore * (1 + SWITCH_MARGIN);
        if (bestScore < threshold) {
          // Not a clear enough win — keep the previous camera.
          bestCam = prevCamera;
          bestScore = prevScore;
        }
      }

      chosenCamera = bestCam;
      prevCamera = bestCam;
      prevScore = bestScore;
    }

    // Pick the snapshot from chosenCamera nearest to bucket center.
    const snap = nearestSnapshot(chosenCamera, bucketCenter, snapshotsByCamera, allSnapshots);
    if (snap) selected.push(snap);
  }

  return selected;
}

/**
 * Return the snapshot from `cameraId`'s pool nearest to `targetMs`.
 * If the camera has no snapshots at all, fall back to any-camera nearest.
 */
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

/** Return the element of `snaps` whose `taken_at` is closest to `targetMs`. */
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

/**
 * Pick the single fallback camera for a no-activity night:
 * most snapshots, tie-break by lowest camera id.
 */
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

/**
 * Remove consecutive duplicate snapshot ids from the selected list.
 * Adjacent duplicates happen when two buckets both land on the same (nearest)
 * snapshot — displaying the same frame twice in a row is invisible and wastes time.
 */
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

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Return a timestamp for 06:00:00.000 local time on the same calendar day as
 * `ref`. This is the nominal end of the nightly capture window.
 */
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

// ---------------------------------------------------------------------------
// Test-only exports (white-box)
// ---------------------------------------------------------------------------

/**
 * Exported purely for unit tests. Production code never calls this directly —
 * `runTimelapseJob` calls `selectFrames` internally.
 */
export const selectFramesForTest = selectFrames;
