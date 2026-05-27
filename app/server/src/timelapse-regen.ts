// app/server/src/timelapse-regen.ts
// CLI tool: manually regenerate (or generate for the first time) the nightly
// recap video for a given date. Idempotent — replaces any existing timelapse
// entry and overwrites the MP4 file.
//
// Usage (inside the container / on the Mac Mini):
//   node dist/timelapse-regen.js --date 2026-05-26
//
// Dev:
//   pnpm -C app/server tsx src/timelapse-regen.ts -- --date 2026-05-26
//
// The --date argument is the LOCAL date of the EVENING the night BEGAN
// (same convention as the job itself): night of May 26→27 is --date 2026-05-26.
//
// Exit codes:
//   0  — produced successfully (or skipped due to insufficient material)
//   1  — error (bad date, fatal failure)
//   2  — bad arguments

import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { getDb } from './db.js';
import { FfmpegError } from './frigate.js';
import { logger } from './logger.js';
import { runTimelapseForDate } from './jobs/timelapse.js';

function usage(): string {
  return [
    'Usage: timelapse-regen --date YYYY-MM-DD',
    '  (dev: `pnpm -C app/server tsx src/timelapse-regen.ts -- --date YYYY-MM-DD`)',
    '  (prod: `node dist/timelapse-regen.js --date YYYY-MM-DD`)',
    '',
    'Regenerate (or generate for the first time) the nightly recap video for',
    'the given date. The date is the LOCAL calendar date of the evening the',
    "night began: the night of May 26→27 is --date 2026-05-26.",
    '',
    'The job is idempotent: any existing timelapse diary entry for that night',
    'is replaced and the MP4 file is overwritten.',
    '',
    'Options:',
    '  --date YYYY-MM-DD   Night start date (local time)',
    '  -h, --help          Show this help',
  ].join('\n');
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function main(): Promise<number> {
  let values: { date?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        date: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n\n${usage()}\n`);
    return 2;
  }

  if (values.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const dateArg = values.date;
  if (!dateArg || !ISO_DATE_RE.test(dateArg)) {
    process.stderr.write(`error: --date must be provided as YYYY-MM-DD\n\n${usage()}\n`);
    return 2;
  }

  // Force DB / migrations to come up.
  getDb();

  logger.info({ date: dateArg }, 'timelapse-regen: starting');

  const result = await runTimelapseForDate(dateArg);

  if (result.produced) {
    logger.info(
      { date: result.date, media_path: result.media_path, entry_id: result.diary_entry_id },
      'timelapse-regen: produced successfully',
    );
    process.stdout.write(
      `produced: ${result.media_path ?? 'unknown'} (entry id=${result.diary_entry_id ?? '?'})\n`,
    );
  } else {
    logger.info(
      { date: result.date },
      'timelapse-regen: skipped (insufficient material for this night)',
    );
    process.stdout.write(`skipped: insufficient material for night of ${result.date}\n`);
  }

  return 0;
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      const stderrTail = err instanceof FfmpegError
        ? err.stderr.trim().split('\n').slice(-20).join('\n')
        : undefined;
      logger.error({ err: msg, ffmpeg_stderr: stderrTail }, 'timelapse-regen: fatal error');
      process.stderr.write(`fatal: ${msg}\n`);
      if (stderrTail) {
        process.stderr.write(`ffmpeg stderr (last 20 lines):\n${stderrTail}\n`);
      }
      process.exit(1);
    },
  );
}
