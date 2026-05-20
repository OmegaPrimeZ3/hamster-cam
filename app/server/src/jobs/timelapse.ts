// app/server/src/jobs/timelapse.ts
// Nightly 23:55 local: stitch the day's snapshots into a 25–35s MP4 and
// write a 'timelapse' diary entry. Idempotent per date.

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

const logger = childLogger('timelapse-job');

const MIN_FRAMES = 30;
const TARGET_OUTPUT_SECONDS = 30;
const MIN_OUTPUT_SECONDS = 25;
const MAX_OUTPUT_SECONDS = 35;
const FRAMERATE = 30;
const TARGET_W = 1280;
const TARGET_H = 720;

export interface TimelapseRunResult {
  /** ISO `YYYY-MM-DD` the job processed. */
  date: string;
  /** Whether ffmpeg actually produced a file (skipped on < ~30 frames). */
  produced: boolean;
  /** Path under STORAGE_PATH the MP4 was written to (when produced). */
  media_path: string | null;
  /** Diary entry row id (when produced). */
  diary_entry_id: number | null;
}

/**
 * Run the timelapse job for the given date. Default: yesterday's local date,
 * the value cron would supply just before midnight. Idempotent.
 */
export async function runTimelapseJob(date?: Date): Promise<TimelapseRunResult> {
  const cfg = getConfig();
  const targetDate = date ?? defaultTargetDate();
  const isoDate = toIsoDate(targetDate);

  const dayStart = startOfLocalDay(targetDate);
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  const snapshots = db.listSnapshotsBetween(dayStart, dayEnd);

  if (snapshots.length < MIN_FRAMES) {
    logger.info(
      { date: isoDate, frames: snapshots.length },
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
    const watermark = `${pet}'s Day · ${isoDate}`.replace(/'/g, "\\'");
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
    const entry = db.replaceTimelapseEntry(dayStart, dayEnd, {
      occurred_at: dayEnd - 1,
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
      { date: isoDate, frames: sampled.length, fps, path: outAbs, entry: entry.id },
      'timelapse produced',
    );
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

function startOfLocalDay(d: Date): number {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy.getTime();
}

function defaultTargetDate(): Date {
  // The cron is 23:55 — we want today's date. Callers that want yesterday's
  // can pass `new Date(Date.now() - 24*60*60*1000)`.
  return new Date();
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
