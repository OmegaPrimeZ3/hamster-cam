// app/server/src/jobs/timelapse.ts
// Nightly 06:05 local: stitch the previous night's snapshots (22:00–06:00)
// into a 25–35s MP4 and write a 'timelapse' diary entry. Idempotent per night.

import { mkdir, symlink, unlink, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getConfig } from '../config.js';
import * as db from '../db.js';
import { runFfmpeg } from '../frigate.js';
import { childLogger } from '../logger.js';
import { pickTemplate, render } from '../narratives.js';
import { generateThumbnailForEntry } from '../thumbnails.js';

const logger = childLogger('timelapse-job');

const MIN_FRAMES = 30;
const TARGET_OUTPUT_SECONDS = 30;
const MIN_OUTPUT_SECONDS = 25;
const MAX_OUTPUT_SECONDS = 35;
const FRAMERATE = 30;
const TARGET_W = 1280;
const TARGET_H = 720;

/** Duration of the capture window: 22:00–06:00 = 8 hours. */
const NIGHT_WINDOW_MS = 8 * 60 * 60 * 1000;

export interface TimelapseRunResult {
  /** ISO `YYYY-MM-DD` of the night's START date (the evening the night began). */
  date: string;
  /** Whether ffmpeg actually produced a file (skipped on < ~30 frames). */
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

  const snapshots = db.listSnapshotsBetween(nightStart, nightEnd);

  if (snapshots.length < MIN_FRAMES) {
    logger.info(
      { night: isoDate, frames: snapshots.length },
      'skipping timelapse — not enough snapshots',
    );
    return { date: isoDate, produced: false, media_path: null, diary_entry_id: null };
  }

  // Sample down to TARGET_OUTPUT_SECONDS × FRAMERATE if we have too many.
  const targetFrames = Math.min(snapshots.length, TARGET_OUTPUT_SECONDS * FRAMERATE);
  const stride = snapshots.length / targetFrames;
  const sampled: typeof snapshots = [];
  for (let i = 0; i < targetFrames; i += 1) {
    const idx = Math.min(snapshots.length - 1, Math.floor(i * stride));
    const item = snapshots[idx];
    if (item) sampled.push(item);
  }

  // Stage the frames in a temp dir with `frames-NNNN.jpg` naming so ffmpeg's
  // image2 demuxer is happy. We use symlinks to avoid copying gigs of jpegs.
  const stagingDir = await mkdtemp(join(tmpdir(), 'hamster-tl-'));
  try {
    for (let i = 0; i < sampled.length; i += 1) {
      const src = sampled[i];
      if (!src) continue;
      const dest = join(stagingDir, `frames-${String(i).padStart(4, '0')}.jpg`);
      // Resolve to absolute paths.
      const srcAbs = src.path.startsWith('/') ? src.path : join(cfg.STORAGE_PATH, src.path);
      if (!existsSync(srcAbs)) continue;
      await symlink(srcAbs, dest);
    }

    // Compute a framerate that keeps the output ≤ MAX_OUTPUT_SECONDS.
    const computedFps = Math.max(
      Math.ceil(sampled.length / MAX_OUTPUT_SECONDS),
      Math.ceil(sampled.length / MIN_OUTPUT_SECONDS),
    );
    const fps = Math.min(FRAMERATE, computedFps || FRAMERATE);

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
      `fps=${FRAMERATE}`,
      `drawtext=text='${watermark}':fontcolor=white:fontsize=24:box=1:boxcolor=black@0.4:boxborderw=8:x=w-tw-20:y=h-th-20`,
    ].join(',');

    await runFfmpeg([
      '-y',
      '-framerate', String(fps),
      '-i', join(stagingDir, 'frames-%04d.jpg'),
      '-vf', vfChain,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-crf', '23',
      '-movflags', '+faststart',
      outAbs,
    ]);

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
      duration_ms: Math.round((sampled.length / fps) * 1000),
      snapshot_id: null,
      media_path: outRel,
      details: JSON.stringify({ frames: sampled.length, fps }),
    });

    logger.info(
      { night: isoDate, frames: sampled.length, fps, path: outAbs, entry: entry.id },
      'timelapse produced',
    );
    // Fire-and-forget: generate thumbnail from the timelapse's first frame.
    void generateThumbnailForEntry(entry);
    return {
      date: isoDate,
      produced: true,
      media_path: outRel,
      diary_entry_id: entry.id,
    };
  } finally {
    // Cleanup symlinks + staging dir.
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    void unlink;
  }
}

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
