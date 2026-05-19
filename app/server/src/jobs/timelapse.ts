// app/server/src/jobs/timelapse.ts
// Nightly 23:55 local: stitch the day's snapshots into a 25-35s MP4 and
// write a 'timelapse' diary entry. Idempotent for the given date.
// PLAN §5.4 — {PetName}'s Day time-lapse.

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
 * the value cron would supply at 23:55. Idempotent.
 */
export async function runTimelapseJob(_date?: Date): Promise<TimelapseRunResult> {
  throw new Error('Stage 2a will implement jobs.timelapse.runTimelapseJob');
}
