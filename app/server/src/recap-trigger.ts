// app/server/src/recap-trigger.ts
// CLI tool: manually trigger (or re-trigger) the overnight Gemini AI recap for
// a given night. Idempotent — any existing recap entry for that night is
// replaced with a freshly generated one.
//
// This is the "rerun the AI recap after deployment" command. Use it whenever:
//   - The recap didn't generate overnight (check logs first for root cause)
//   - You've updated GEMINI_MODEL and want to re-generate with the new model
//   - You want to test the Gemini integration end-to-end
//
// Usage (on the server / Mac Mini, inside the application directory):
//   node dist/recap-trigger.js --date 2026-05-26
//
// Dev (monorepo):
//   pnpm -C app/server tsx src/recap-trigger.ts -- --date 2026-05-26
//
// The --date argument is the LOCAL date of the EVENING the night BEGAN:
//   - Night of May 25 21:00 → May 26 06:00  →  --date 2026-05-25
//   - If omitted, defaults to LAST NIGHT (the most recently completed night).
//
// Exit codes:
//   0  — recap produced or skipped with a logged reason
//   1  — fatal error (DB failure, unexpected exception)
//   2  — bad arguments

import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { getDb } from './db.js';
import { logger } from './logger.js';
import { runRecapJob } from './jobs/recap.js';

function usage(): string {
  return [
    'Usage: recap-trigger [--date YYYY-MM-DD]',
    '  (prod: `node dist/recap-trigger.js --date YYYY-MM-DD`)',
    '  (dev:  `pnpm -C app/server tsx src/recap-trigger.ts -- --date YYYY-MM-DD`)',
    '',
    'Manually trigger (or re-trigger) the overnight Gemini AI recap for the given',
    'night. Idempotent: any existing recap entry is replaced.',
    '',
    'The --date is the LOCAL date of the EVENING the night BEGAN:',
    '  Night of May 25 21:00 → May 26 06:00  →  --date 2026-05-25',
    '',
    'If --date is omitted, the tool targets LAST NIGHT (most recently completed).',
    '',
    'GEMINI_API_KEY must be set in the environment (or .env file). If it is not',
    'set, the job skips cleanly and exits 0.',
    '',
    'Options:',
    '  --date YYYY-MM-DD   Night start date (local time). Default: last night.',
    '  -h, --help          Show this help',
  ].join('\n');
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Build a reference Date (06:10 local on the MORNING AFTER the night).
 * runRecapJob computes nightEnd = 06:00:00.000 local on the ref Date, so
 * passing 06:10 on the morning after yields the correct window.
 *
 * Input: YYYY-MM-DD string = the evening the night BEGAN.
 * Output: a Date set to 06:10 local on the NEXT calendar day.
 */
function buildRefDate(nightStartDate: string): Date {
  // Parse the night-start date as local midnight.
  const [yearStr, monthStr, dayStr] = nightStartDate.split('-');
  const year = Number.parseInt(yearStr ?? '0', 10);
  const month = Number.parseInt(monthStr ?? '0', 10) - 1; // 0-indexed
  const day = Number.parseInt(dayStr ?? '0', 10);

  // Start with midnight of the night-start date, then advance to next-day 06:10.
  const d = new Date(year, month, day, 6, 10, 0, 0);
  // Move forward one calendar day to get to the morning AFTER the night.
  d.setDate(d.getDate() + 1);
  return d;
}

/**
 * Compute the default night-start date: the most recently completed overnight
 * window relative to now. If it's before 06:00 local, the most recently
 * completed night started the PREVIOUS evening (yesterday−1 day); if it's
 * after 06:00, last night started yesterday evening.
 */
function defaultNightStartDate(): string {
  const now = new Date();
  const sixAMToday = new Date(now);
  sixAMToday.setHours(6, 0, 0, 0);

  // If it's before 06:00 local, we haven't finished tonight's window yet.
  // The last *completed* night began the evening before yesterday.
  const nightStartDate = now < sixAMToday
    ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2)
    : new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

  const y = nightStartDate.getFullYear();
  const m = String(nightStartDate.getMonth() + 1).padStart(2, '0');
  const d = String(nightStartDate.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

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

  let dateArg: string;
  if (values.date !== undefined) {
    if (!ISO_DATE_RE.test(values.date)) {
      process.stderr.write(`error: --date must be YYYY-MM-DD (got: ${values.date})\n\n${usage()}\n`);
      return 2;
    }
    dateArg = values.date;
  } else {
    dateArg = defaultNightStartDate();
    process.stdout.write(`no --date supplied; targeting last night: ${dateArg}\n`);
  }

  // Force DB + migrations to come up.
  getDb();

  const refDate = buildRefDate(dateArg);

  logger.info(
    { date: dateArg, ref_date_iso: refDate.toISOString() },
    'recap-trigger: starting',
  );
  process.stdout.write(
    `recap-trigger: generating recap for night of ${dateArg} ` +
    `(window ~${dateArg} 21:00 → ${refDate.toISOString().slice(0, 10)} 06:00 local)\n`,
  );

  const result = await runRecapJob(refDate);

  if (result.skipped === false) {
    logger.info(
      { date: result.date, entry_id: result.diary_entry_id },
      'recap-trigger: recap produced successfully',
    );
    process.stdout.write(
      `produced: recap diary entry id=${result.diary_entry_id ?? '?'} for night of ${result.date}\n`,
    );
  } else {
    const reasons: Record<typeof result.skipped, string> = {
      disabled: 'recap is disabled (recap_enabled=false in settings)',
      no_api_key: 'GEMINI_API_KEY is not set — configure it in the .env file',
      too_few_entries: 'not enough overnight diary entries (minimum 3 required)',
      api_error: 'Gemini API call failed — check the server logs for details',
    };
    const reason = reasons[result.skipped];
    logger.info(
      { date: result.date, skipped: result.skipped },
      `recap-trigger: skipped — ${reason}`,
    );
    process.stdout.write(`skipped (${result.skipped}): ${reason}\n`);
  }

  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'recap-trigger: fatal error');
      process.stderr.write(`fatal: ${msg}\n`);
      process.exit(1);
    },
  );
}
