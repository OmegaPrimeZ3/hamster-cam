// app/server/src/jobs/disk-watch.ts
// `df`-based disk monitor. Warn → in-app diary entry; critical → Zyphr-sent
// email to admin. Thresholds live in `settings`.
// PLAN §8.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pino from 'pino';

import { getConfig } from '../config.js';
import * as db from '../db.js';
import { getZyphr } from '../zyphr.js';

const execFileP = promisify(execFile);

const logger = pino({ name: 'disk-watch-job' });

export type DiskWatchSeverity = 'ok' | 'warn' | 'critical';

export interface DiskWatchRunResult {
  severity: DiskWatchSeverity;
  pct_used: number;
  free_gb: number;
  /** True if this run actually emitted an alert (diary entry or email). */
  alerted: boolean;
}

interface DfReading {
  pctUsed: number;
  freeKb: number;
  totalKb: number;
}

async function runDf(path: string): Promise<DfReading> {
  const { stdout } = await execFileP('df', ['-k', path]);
  const lines = stdout.trim().split('\n');
  if (lines.length < 2) {
    throw new Error('df output missing data line');
  }
  // df output: Filesystem 1024-blocks Used Available Capacity Mounted-on
  const cols = lines[1]?.split(/\s+/) ?? [];
  if (cols.length < 5) throw new Error('df output column count unexpected');
  const totalKb = Number.parseInt(cols[1] ?? '0', 10);
  const usedKb = Number.parseInt(cols[2] ?? '0', 10);
  const freeKb = Number.parseInt(cols[3] ?? '0', 10);
  const pctUsed = totalKb > 0 ? Math.round((usedKb / totalKb) * 100) : 0;
  return { pctUsed, freeKb, totalKb };
}

export async function runDiskWatchJob(): Promise<DiskWatchRunResult> {
  const cfg = getConfig();
  const warnPct = clampPct(Number.parseInt(db.getSetting('disk_warn_pct') ?? '85', 10), 85);
  const critPct = clampPct(Number.parseInt(db.getSetting('disk_critical_pct') ?? '95', 10), 95);

  let reading: DfReading;
  try {
    reading = await runDf(cfg.STORAGE_PATH);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'df failed; reporting degraded reading');
    return { severity: 'ok', pct_used: 0, free_gb: 0, alerted: false };
  }
  const freeGb = +(reading.freeKb / (1024 * 1024)).toFixed(2);

  let severity: DiskWatchSeverity = 'ok';
  if (reading.pctUsed >= critPct) severity = 'critical';
  else if (reading.pctUsed >= warnPct) severity = 'warn';

  let alerted = false;
  if (severity !== 'ok') {
    const now = Date.now();
    const narrative =
      severity === 'critical'
        ? `⚠️ Disk is ${reading.pctUsed}% full — only ${freeGb} GB free. Free up space soon!`
        : `📦 Disk is getting full (${reading.pctUsed}%) — ${freeGb} GB free.`;
    db.createDiaryEntry({
      occurred_at: now,
      kind: 'narrative',
      activity: null,
      narrative,
      pet_name: null,
      camera_id: null,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: null,
      snapshot_id: null,
      media_path: null,
      details: JSON.stringify({ severity, pctUsed: reading.pctUsed, freeGb }),
    });
    alerted = true;
    if (severity === 'critical') {
      await emailAdminsBestEffort(narrative, reading);
    }
  }

  logger.info(
    { severity, pctUsed: reading.pctUsed, freeGb, alerted },
    'disk-watch complete',
  );
  return { severity, pct_used: reading.pctUsed, free_gb: freeGb, alerted };
}

function clampPct(raw: number, fallback: number): number {
  if (!Number.isFinite(raw)) return fallback;
  if (raw < 0) return 0;
  if (raw > 100) return 100;
  return raw;
}

async function emailAdminsBestEffort(
  message: string,
  reading: DfReading,
): Promise<void> {
  const cfg = getConfig();
  const fromAddr = cfg.ZYPHR_FROM_EMAIL;
  if (!fromAddr) {
    logger.warn('ZYPHR_FROM_EMAIL not configured; skipping disk-critical email');
    return;
  }
  const admins = db.listUsers().filter((u) => u.role === 'admin');
  if (admins.length === 0) return;
  try {
    await getZyphr().emails.sendEmail({
      to: admins.map((a) => ({ email: a.email, name: a.display_name })),
      from: { email: fromAddr, name: 'hamster-cam' },
      subject: 'hamster-cam: disk is nearly full',
      text: `${message}\n\nFilesystem reading: ${reading.pctUsed}% used, ${reading.freeKb}KB free of ${reading.totalKb}KB total.`,
      html: `<p>${message}</p><p>Filesystem reading: ${reading.pctUsed}% used, ${reading.freeKb}KB free of ${reading.totalKb}KB total.</p>`,
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'disk-critical email send failed');
  }
}
