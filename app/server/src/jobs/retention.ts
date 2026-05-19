// app/server/src/jobs/retention.ts
// Nightly retention sweep:
//   - delete snapshots older than settings.snapshot_retention_days
//   - clear `media_path` on timelapses older than settings.timelapse_retention_days
//   - prune audit_log rows older than settings.audit_retention_days
// PLAN §8 Disk-space planning + alerts.

export interface RetentionRunResult {
  snapshots_deleted: number;
  timelapse_media_cleared: number;
  audit_rows_deleted: number;
}

export async function runRetentionJob(): Promise<RetentionRunResult> {
  throw new Error('Stage 2a will implement jobs.retention.runRetentionJob');
}
