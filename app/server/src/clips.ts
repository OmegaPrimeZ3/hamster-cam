// app/server/src/clips.ts
// Shared clip-access layer: ensures a playable MP4 exists for a diary entry,
// caching the extracted clip on disk so repeat callers (view-clip tRPC, share
// email) don't re-extract. PLAN §diary-clips.

import { access as fsAccess, constants as fsConstants } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import { getConfig } from './config.js';
import * as db from './db.js';
import { extractClip } from './frigate.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EnsureClipResult {
  /** Relative path under STORAGE_PATH — suitable for browser URL construction. */
  relPath: string;
}

/**
 * Guarantee a playable MP4 exists for the given diary entry and return its
 * relative path under STORAGE_PATH.
 *
 * Resolution order:
 *   1. `entry.clip_path` is set AND file exists non-empty → return it (cache hit).
 *   2. `entry.media_path` is set AND ends with `.mp4` → use it directly (timelapse).
 *   3. Extract from Frigate via `extractClip`; persist the result in `clip_path`.
 *
 * Throws a descriptive Error when extraction is impossible (no camera, no media).
 * Callers that must not crash (e.g. thumbnail generation) should wrap in try/catch.
 */
export async function ensureClip(entry: db.DiaryEntryRow): Promise<EnsureClipResult> {
  const cfg = getConfig();

  // 1. Cache hit: clip already extracted and on disk.
  if (entry.clip_path) {
    const abs = toAbsolute(entry.clip_path, cfg.STORAGE_PATH);
    if (await fileExists(abs)) {
      return { relPath: entry.clip_path };
    }
    // File disappeared (pruned by retention) — fall through to re-extract.
  }

  // 2. Timelapse (or other video media_path) — return it directly; no copy needed.
  if (entry.media_path && entry.media_path.toLowerCase().endsWith('.mp4')) {
    return { relPath: entry.media_path };
  }

  // 3. Extract from Frigate.
  if (entry.camera_id == null) {
    throw new Error(
      `diary entry ${entry.id} has no camera_id and no extractable media; cannot produce a clip`,
    );
  }
  const camera = db.getCameraById(entry.camera_id);
  if (!camera) {
    throw new Error(
      `diary entry ${entry.id} references camera ${entry.camera_id} which no longer exists`,
    );
  }

  // Center the clip on the MIDDLE of the activity so the hamster is in-frame
  // rather than just leaving.  occurred_at is the END of the activity, so the
  // midpoint is occurred_at − duration/2.  For zero/null duration this
  // collapses back to occurred_at (safe; Frigate window covers a bit of lead-in
  // via the minimum durationMs below).
  const dur = entry.duration_ms ?? 0;
  const centerMs = entry.occurred_at - Math.floor(dur / 2);

  // Adaptive window: cover the full activity + 4 s of headroom, clamped to
  // [30 s, 60 s].  Frigate 0.17.x returns HTTP 400 for clip windows under
  // ~30 s (sub-segment-aligned requests).  The same threshold was empirically
  // identified when fixing extractFrame in 6f72dd6 — clips use the same
  // Frigate endpoint (/api/<cam>/start/<s>/end/<e>/clip.mp4) and are subject
  // to the same rejection floor.
  //
  // Floor raised from 8 s → 30 s.  Ceiling raised from 20 s → 60 s so that
  // the floor can always be reached (and to match extractFrame's 60 s window).
  // Wider doesn't cost much — Frigate streams and the browser seek to the
  // midpoint anyway.  A 6 s food visit → 30 s window centred on midpoint;
  // an 8-min wheel run → 60 s window centred mid-run.
  const clampedDurationMs = Math.max(30_000, Math.min(60_000, dur + 4_000));

  const extracted = await extractClip({
    cameraName: camera.live_src ?? camera.name,
    centerMs,
    durationMs: clampedDurationMs,
  });

  // Convert the absolute path returned by extractClip to a STORAGE_PATH-relative path.
  const relPath = toRelative(extracted.path, cfg.STORAGE_PATH);

  // Persist so subsequent calls hit the cache.
  db.updateDiaryEntryClipPath(entry.id, relPath);

  return { relPath };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function toAbsolute(pathStr: string, storagePath: string): string {
  return isAbsolute(pathStr) ? pathStr : join(storagePath, pathStr);
}

function toRelative(absPath: string, storagePath: string): string {
  if (isAbsolute(absPath)) {
    return relative(storagePath, absPath);
  }
  return absPath;
}

async function fileExists(abs: string): Promise<boolean> {
  try {
    await fsAccess(abs, fsConstants.F_OK);
    // Reject zero-byte placeholders (same convention as captureLatestSnapshot).
    const { stat } = await import('node:fs/promises');
    const st = await stat(abs);
    return st.size > 0;
  } catch {
    return false;
  }
}
