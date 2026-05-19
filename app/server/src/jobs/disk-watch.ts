// app/server/src/jobs/disk-watch.ts
// Nightly `df`-based disk monitor. Warn → in-app diary entry; critical →
// Zyphr-sent email to admin. Thresholds live in `settings`.
// PLAN §8 Disk-space planning + alerts.

export type DiskWatchSeverity = 'ok' | 'warn' | 'critical';

export interface DiskWatchRunResult {
  severity: DiskWatchSeverity;
  pct_used: number;
  free_gb: number;
  /** True if this run actually emitted an alert (diary entry or email). */
  alerted: boolean;
}

export async function runDiskWatchJob(): Promise<DiskWatchRunResult> {
  throw new Error('Stage 2a will implement jobs.disk-watch.runDiskWatchJob');
}
