// app/server/src/share.ts
// Send-a-Clip — extracts a 10s clip (or uses an existing media file), emails
// it through Zyphr's emails API, and tracks the result in `share_log`.
//
// `startShareJob` returns the queued row synchronously and resolves the
// promise once the background work completes (so the tRPC caller can await
// it, or fire-and-forget and poll `share.status`). PLAN §5.4 Send-a-Clip.

import { readFile, stat } from 'node:fs/promises';
import { join, isAbsolute, basename } from 'node:path';
import pino from 'pino';
import { TRPCError } from '@trpc/server';

import { getConfig } from './config.js';
import * as db from './db.js';
import { extractClip } from './frigate.js';
import { getZyphr } from './zyphr.js';

const logger = pino({ name: 'share' });

const HOUR_MS = 60 * 60 * 1000;
const ATTACH_LIMIT_BYTES = 20 * 1024 * 1024; // 20MB — typical mail-provider cap

export interface StartShareJobInput {
  userId: number;
  recipientId: number;
  diaryEntryId: number;
}

/**
 * Synchronously enqueues a share-log row (so the frontend has an id to poll)
 * and kicks off the background extract+email work. The function awaits the
 * job to completion — callers that want fire-and-forget can wrap the call in
 * `void`.
 */
export async function startShareJob(
  input: StartShareJobInput,
): Promise<db.ShareLogRow> {
  // Rate-limit per user per hour.
  const rateLimit = readShareRateLimit();
  const sentLastHour = db.countShareLogSinceForUser(input.userId, Date.now() - HOUR_MS);
  if (sentLastHour >= rateLimit) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: 'rate limit reached — try again later',
    });
  }
  const recipient = db.getShareRecipientById(input.recipientId);
  if (!recipient) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'recipient not found' });
  }
  const entry = db.getDiaryEntryById(input.diaryEntryId);
  if (!entry) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'diary entry not found' });
  }

  const row = db.createShareLog({
    user_id: input.userId,
    recipient_id: input.recipientId,
    diary_entry_id: input.diaryEntryId,
    status: 'queued',
  });

  try {
    await sendClip(row, recipient, entry);
    const finished = db.updateShareLogStatus({
      id: row.id,
      status: 'sent',
      sent_at: Date.now(),
      error: null,
    });
    return finished ?? row;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message, shareId: row.id }, 'share job failed');
    const failed = db.updateShareLogStatus({
      id: row.id,
      status: 'failed',
      sent_at: null,
      error: message.slice(0, 500),
    });
    return failed ?? row;
  }
}

function readShareRateLimit(): number {
  const raw = db.getSetting('share_rate_limit_per_hour') ?? '10';
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

async function sendClip(
  shareRow: db.ShareLogRow,
  recipient: db.ShareRecipientRow,
  entry: db.DiaryEntryRow,
): Promise<void> {
  const cfg = getConfig();
  if (!cfg.ZYPHR_FROM_EMAIL) {
    throw new Error('ZYPHR_FROM_EMAIL is not configured');
  }
  let clipPath: string;
  let clipName: string;
  let cleanupPath: string | null = null;

  if (entry.media_path) {
    clipPath = isAbsolute(entry.media_path)
      ? entry.media_path
      : join(cfg.STORAGE_PATH, entry.media_path);
    clipName = basename(clipPath);
  } else {
    // Pull a 10-second clip from Frigate recordings centred on the event.
    if (entry.camera_id == null) {
      throw new Error('diary entry has no camera_id; cannot extract clip');
    }
    const camera = db.getCameraById(entry.camera_id);
    if (!camera) throw new Error('diary entry references a deleted camera');
    const extracted = await extractClip({
      cameraName: camera.name,
      centerMs: entry.occurred_at,
    });
    clipPath = extracted.path;
    clipName = basename(extracted.path);
    cleanupPath = extracted.path;
  }

  const fileStat = await stat(clipPath);
  if (fileStat.size > ATTACH_LIMIT_BYTES) {
    throw new Error(`clip too large for email: ${fileStat.size} bytes`);
  }
  const buf = await readFile(clipPath);

  const pet = (db.getSetting('pet_name') ?? '').trim() || 'Pet';
  const subject = `${pet} just did something cute!`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif;">
      <h2>${escapeHtml(pet)} says hi!</h2>
      <p>${escapeHtml(entry.narrative)}</p>
      <p>The clip is attached. Tap to play.</p>
    </div>
  `;
  const text = `${pet} says hi!\n\n${entry.narrative}\n\n(Clip attached.)`;

  await getZyphr().emails.sendEmail({
    to: [{ email: recipient.email, name: recipient.display_name }],
    from: { email: cfg.ZYPHR_FROM_EMAIL, name: `${pet} Cam` },
    subject,
    html,
    text,
    attachments: [
      {
        filename: clipName,
        content: buf.toString('base64'),
        contentType: clipName.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream',
      },
    ],
  });

  // Best-effort cleanup of temporary extracted clip.
  if (cleanupPath) {
    void readFile(cleanupPath).catch(() => undefined);
  }
  logger.info(
    { shareId: shareRow.id, recipient: recipient.email, bytes: buf.length },
    'share clip sent',
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
