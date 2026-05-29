// app/server/src/thumbnails.ts
// Eager thumbnail generation for diary entries. Produces a ~480px JPEG under
// STORAGE_PATH/thumbnails/ and persists the relative path in diary_entries.
//
// Hard rule: generateThumbnailForEntry NEVER throws to its caller. All errors
// are logged at warn level and the function returns. Fire-and-forget safe.

import { access, constants as fsConstants, mkdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { getConfig } from './config.js';
import * as db from './db.js';
import { extractFrame, runFfmpeg } from './frigate.js';
import { childLogger } from './logger.js';

const logger = childLogger('thumbnails');

const THUMB_WIDTH = 480;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate (if needed) a ~480px JPEG thumbnail for the given diary entry and
 * persist its relative path via `updateDiaryEntryThumbnailPath`.
 *
 * Idempotent: exits immediately when a non-empty thumbnail already exists.
 * Swallows all errors — never throws.
 */
export async function generateThumbnailForEntry(entry: db.DiaryEntryRow): Promise<void> {
  try {
    await _generate(entry);
  } catch (err) {
    logger.warn(
      { entryId: entry.id, err: (err as Error).message },
      'thumbnail generation failed',
    );
  }
}

/**
 * Same as `generateThumbnailForEntry` but DOES throw on failure.
 *
 * Used by the thumbnail-backfill job so it can classify the error (permanent
 * vs. transient) and update attempt-tracking columns accordingly.
 * All other callers should continue using the non-throwing variant above.
 */
export async function generateThumbnailForEntryUnguarded(entry: db.DiaryEntryRow): Promise<void> {
  await _generate(entry);
}

// ---------------------------------------------------------------------------
// Internal implementation
// ---------------------------------------------------------------------------

async function _generate(entry: db.DiaryEntryRow): Promise<void> {
  const cfg = getConfig();

  // Idempotency: if thumbnail_path is set and the file is non-empty, we're done.
  if (entry.thumbnail_path) {
    const abs = toAbsolute(entry.thumbnail_path, cfg.STORAGE_PATH);
    if (await fileExistsNonEmpty(abs)) return;
  }

  // 'recap' — skip entirely; no representative frame.
  if (entry.kind === 'recap') return;

  const thumbsDir = join(cfg.STORAGE_PATH, 'thumbnails');
  await mkdir(thumbsDir, { recursive: true });

  let relPath: string | null = null;

  if (entry.kind === 'snapshot' || isImagePath(entry.media_path)) {
    // Snapshot or image media → downscale the existing JPEG.
    relPath = await thumbnailFromImage(entry, thumbsDir, cfg.STORAGE_PATH);
  } else if (entry.kind === 'timelapse' || isVideoPath(entry.media_path)) {
    // Timelapse or video media → grab first frame via ffmpeg.
    relPath = await thumbnailFromVideo(entry, thumbsDir, cfg.STORAGE_PATH);
  } else {
    // Narrative / transition → grab a moment frame from Frigate.
    relPath = await thumbnailFromFrigateFrame(entry, cfg.STORAGE_PATH);
  }

  if (relPath) {
    db.updateDiaryEntryThumbnailPath(entry.id, relPath);
  }
}

/** Downscale an existing image to ~THUMB_WIDTH px wide. */
async function thumbnailFromImage(
  entry: db.DiaryEntryRow,
  thumbsDir: string,
  storagePath: string,
): Promise<string | null> {
  const mediaPath = entry.media_path;
  if (!mediaPath) return null;

  const srcAbs = toAbsolute(mediaPath, storagePath);
  if (!(await fileExistsNonEmpty(srcAbs))) {
    logger.warn({ entryId: entry.id, srcAbs }, 'source image missing for thumbnail');
    return null;
  }

  const outName = `entry-${entry.id}-thumb.jpg`;
  const outAbs = join(thumbsDir, outName);
  const outRel = join('thumbnails', outName);

  await runFfmpeg([
    '-y',
    '-i', srcAbs,
    '-vf', `scale=${THUMB_WIDTH}:-1`,
    '-frames:v', '1',
    '-q:v', '4',
    outAbs,
  ]);

  if (await fileExistsNonEmpty(outAbs)) {
    return outRel;
  }
  return null;
}

/** Extract first frame from a video file as a downscaled JPEG. */
async function thumbnailFromVideo(
  entry: db.DiaryEntryRow,
  thumbsDir: string,
  storagePath: string,
): Promise<string | null> {
  const mediaPath = entry.media_path;
  if (!mediaPath) return null;

  const srcAbs = toAbsolute(mediaPath, storagePath);
  if (!(await fileExistsNonEmpty(srcAbs))) {
    logger.warn({ entryId: entry.id, srcAbs }, 'source video missing for thumbnail');
    return null;
  }

  const outName = `entry-${entry.id}-thumb.jpg`;
  const outAbs = join(thumbsDir, outName);
  const outRel = join('thumbnails', outName);

  await runFfmpeg([
    '-y',
    '-i', srcAbs,
    '-frames:v', '1',
    '-vf', `scale=${THUMB_WIDTH}:-1`,
    '-q:v', '4',
    outAbs,
  ]);

  if (await fileExistsNonEmpty(outAbs)) {
    return outRel;
  }
  return null;
}

/**
 * Grab a frame from Frigate's recordings API at the entry's occurred_at time.
 * Returns null (silently) when no camera is resolvable.
 */
async function thumbnailFromFrigateFrame(
  entry: db.DiaryEntryRow,
  storagePath: string,
): Promise<string | null> {
  // Prefer the primary camera; fall back to transition cameras.
  const cameraId = entry.camera_id ?? entry.to_camera_id ?? entry.from_camera_id;
  if (cameraId == null) return null;

  const camera = db.getCameraById(cameraId);
  if (!camera) return null;

  // Sample mid-activity: occurred_at is the END of the narrative; bias the
  // frame back by half the duration so the hamster is reliably visible.
  const dur = entry.duration_ms ?? 0;
  const atMs = entry.occurred_at - Math.floor(dur / 2);

  const result = await extractFrame({
    cameraName: camera.live_src ?? camera.name,
    atMs,
    widthPx: THUMB_WIDTH,
  });

  // extractFrame writes a zero-byte placeholder on failure; captured:false means skip.
  if (!result.captured) return null;

  // Rename to the canonical entry-based filename so we don't accumulate
  // duplicates when the same frame is re-extracted (e.g. after a crash).
  const cfg = getConfig();
  const thumbsDir = join(storagePath, 'thumbnails');
  const canonName = `entry-${entry.id}-thumb.jpg`;
  const canonAbs = join(thumbsDir, canonName);
  const canonRel = join('thumbnails', canonName);

  const srcAbs = toAbsolute(result.path, cfg.STORAGE_PATH);

  // Rename is fine when source and dest are on the same FS (always true here).
  const { rename } = await import('node:fs/promises');
  await rename(srcAbs, canonAbs).catch(async () => {
    // Cross-device or concurrent rename — copy + delete.
    const { copyFile, unlink } = await import('node:fs/promises');
    await copyFile(srcAbs, canonAbs);
    await unlink(srcAbs).catch(() => {});
  });

  return canonRel;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function toAbsolute(pathStr: string, storagePath: string): string {
  return isAbsolute(pathStr) ? pathStr : join(storagePath, pathStr);
}

async function fileExistsNonEmpty(abs: string): Promise<boolean> {
  try {
    await access(abs, fsConstants.F_OK);
    const st = await stat(abs);
    return st.size > 0;
  } catch {
    return false;
  }
}

function isImagePath(p: string | null): p is string {
  if (!p) return false;
  const lower = p.toLowerCase();
  return lower.endsWith('.jpg') || lower.endsWith('.jpeg') ||
    lower.endsWith('.png') || lower.endsWith('.webp');
}

function isVideoPath(p: string | null): p is string {
  if (!p) return false;
  return p.toLowerCase().endsWith('.mp4');
}

