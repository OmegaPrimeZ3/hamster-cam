// app/server/src/diary-cleanup.ts
// One-off maintenance: collapse pre-existing back-to-back duplicate diary
// entries left by the OLD narrator (which wrote one row per tracked-object
// end and never coalesced runs). Mirrors the live coalescing rule in
// narrator.ts EXACTLY so the historical diary matches "going forward":
//
//   same non-wheel zone activity, consecutive, gap between the previous
//   entry's end (occurred_at) and the next visit's start
//   (occurred_at - duration_ms) <= COALESCE_WINDOW_MS  →  one entry.
//
// Wheel is excluded so each run keeps its own odometer distance — identical
// to narrator's `deferred.activity !== 'wheel'` guard.
//
// READ-ONLY by default (prints what it WOULD do). Deletes nothing unless
// --apply is passed, and even then it takes a timestamped .backup of the DB
// file first and does all work in a single transaction.
//
// Dev:  tsx src/diary-cleanup.ts            (analyze)
//       tsx src/diary-cleanup.ts --apply    (backup + collapse)
// Prod (no tsx): node dist/diary-cleanup.js [--apply]
// Honors DATABASE_PATH from the environment, same as the server.

import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import * as db from './db.js';

// Keep in lockstep with narrator.ts COALESCE_WINDOW_MS.
const COALESCE_WINDOW_MS = 120_000;

// Activities the narrator coalesces: every zone visit EXCEPT wheel. Snapshot,
// timelapse, recap and transition rows are written by other paths and are
// never touched here.
const COALESCIBLE: ReadonlySet<string> = new Set([
  'food',
  'water',
  'bathroom',
  'resting',
  'tunnel',
  'exploring',
  'hiding',
]);

interface Plan {
  /** Surviving entries whose span grew to absorb later duplicates. */
  updates: { id: number; occurred_at: number; duration_ms: number }[];
  /** Entry ids absorbed into a survivor and slated for deletion. */
  deleteIds: number[];
  /** How many distinct runs collapsed (a run that deleted >= 1 row). */
  runsCollapsed: number;
}

interface PassRow {
  id: number;
  activity: string | null;
  start: number;
  end: number;
}

/**
 * One chronological sweep replaying the narrator's single-step coalescing (it
 * only ever compares against the immediately preceding entry). A survivor
 * accumulates consecutive same-activity visits whose gaps each stay within the
 * window; anything else starts a fresh run. Returns, per run that collapsed,
 * the survivor's new span and the ids it absorbed.
 */
function singlePass(rows: PassRow[]): { extend: PassRow[]; deleteIds: number[] } {
  const extend: PassRow[] = [];
  const deleteIds: number[] = [];
  let survivor: PassRow | null = null;
  let absorbed = 0;

  const flush = () => {
    if (survivor && absorbed > 0) extend.push({ ...survivor });
    absorbed = 0;
  };

  for (const e of rows) {
    const coalescible =
      survivor !== null &&
      survivor.activity === e.activity &&
      e.activity != null &&
      COALESCIBLE.has(e.activity) &&
      e.start - survivor.end <= COALESCE_WINDOW_MS;

    if (coalescible && survivor) {
      // Absorb e. Use max() so a nested/earlier-ending overlap (possible with
      // concurrent multi-camera tracks) is deleted without shrinking the span.
      survivor.end = Math.max(survivor.end, e.end);
      absorbed += 1;
      deleteIds.push(e.id);
      continue;
    }
    flush();
    survivor = { ...e };
  }
  flush();
  return { extend, deleteIds };
}

/**
 * Iterate {@link singlePass} to a fixpoint. Extending a survivor's end forward
 * can bring it within the window of a run that was previously out of reach, so
 * a single sweep is not idempotent — we re-sweep the projected post-state until
 * nothing more collapses. The narrator never hits this (it coalesces visit-by-
 * visit as events arrive); only a batch backfill over historical rows does.
 */
function planCoalesce(rows: db.DiaryEntryRow[]): Plan {
  // Sort by visit START, not by occurred_at (which is the END). Overlapping
  // multi-camera tracks mean end-order != start-order, and coalescing compares
  // a visit's start against the survivor's end — so the sweep must run in start
  // order. Starts never change as survivors grow, so this sort holds across
  // every pass.
  let projection: PassRow[] = rows
    .filter((e) => e.kind === 'narrative')
    .map((e) => ({
      id: e.id,
      activity: e.activity,
      start: e.occurred_at - (e.duration_ms ?? 0),
      end: e.occurred_at,
    }))
    .sort((a, b) => a.start - b.start || a.id - b.id);

  const finalSpan = new Map<number, PassRow>(); // survivor id → its grown span
  const deleted = new Set<number>();

  for (;;) {
    const { extend, deleteIds } = singlePass(projection);
    if (deleteIds.length === 0) break;
    for (const s of extend) finalSpan.set(s.id, s);
    for (const id of deleteIds) {
      deleted.add(id);
      finalSpan.delete(id); // a former survivor can itself be absorbed later
    }
    const removed = new Set(deleteIds);
    projection = projection
      .filter((r) => !removed.has(r.id))
      .map((r) => finalSpan.get(r.id) ?? r);
  }

  const updates = [...finalSpan.values()].map((s) => ({
    id: s.id,
    occurred_at: s.end,
    duration_ms: s.end - s.start,
  }));
  return { updates, deleteIds: [...deleted], runsCollapsed: updates.length };
}

function fmt(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function dur(ms: number | null): string {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      'short-ms': { type: 'string' }, // optional: also report/drop sub-threshold entries
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    console.log(
      'Usage: diary-cleanup [--apply] [--short-ms=N]\n' +
        '  (no flags)   analyze only — prints what would change, deletes nothing\n' +
        '  --apply      backup the DB, then collapse duplicate runs in a transaction\n' +
        '  --short-ms=N also DELETE narrative zone entries shorter than N ms (suspected\n' +
        '               reflection fly-throughs). Off by default. Requires --apply to act.',
    );
    return;
  }

  const shortMs = values['short-ms'] ? Number.parseInt(values['short-ms'], 10) : null;
  if (values['short-ms'] && (!Number.isFinite(shortMs) || (shortMs as number) < 0)) {
    throw new Error(`--short-ms must be a non-negative integer, got ${values['short-ms']}`);
  }

  const conn = db.getDb();
  const dbPath = process.env['DATABASE_PATH'] ?? '(unknown — DATABASE_PATH unset)';

  // Pull the whole diary in chronological order.
  const rows = conn
    .prepare('SELECT * FROM diary_entries ORDER BY occurred_at ASC, id ASC')
    .all() as db.DiaryEntryRow[];

  const narrative = rows.filter((r) => r.kind === 'narrative');
  const byActivity = new Map<string, number>();
  for (const r of narrative) {
    const k = r.activity ?? '(none)';
    byActivity.set(k, (byActivity.get(k) ?? 0) + 1);
  }

  const plan = planCoalesce(rows);

  const shortEntries =
    shortMs != null
      ? narrative.filter(
          (r) =>
            r.activity != null &&
            COALESCIBLE.has(r.activity) &&
            (r.duration_ms ?? 0) < shortMs &&
            !plan.deleteIds.includes(r.id),
        )
      : [];

  // ---- Report -------------------------------------------------------------
  console.log(`\nDatabase: ${dbPath}`);
  console.log(`Total entries: ${rows.length}  (narrative: ${narrative.length})`);
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (first && last) {
    console.log(`Date range:   ${fmt(first.occurred_at)}  →  ${fmt(last.occurred_at)}`);
  }
  console.log('\nNarrative entries by activity:');
  for (const [k, n] of [...byActivity.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(12)} ${n}`);
  }

  console.log('\nDuplicate-run coalescing (mirrors narrator, 120s window, wheel excluded):');
  console.log(`  Runs collapsed:      ${plan.runsCollapsed}`);
  console.log(`  Entries to delete:   ${plan.deleteIds.length}`);
  console.log(`  Entries to extend:   ${plan.updates.length}`);

  // Show a few sample survivors so the operator can eyeball it.
  const sample = plan.updates.slice(0, 8);
  if (sample.length > 0) {
    console.log('\n  Sample collapsed runs (survivor id → new span):');
    for (const u of sample) {
      const before = rows.find((r) => r.id === u.id);
      console.log(
        `    #${u.id} ${before?.activity?.padEnd(10) ?? ''} ` +
          `${fmt(u.occurred_at - u.duration_ms)} → ${fmt(u.occurred_at)}  (${dur(u.duration_ms)})`,
      );
    }
  }

  if (shortMs != null) {
    console.log(`\nShort-entry sweep (< ${shortMs}ms, suspected reflection fly-throughs):`);
    console.log(`  Entries matching:    ${shortEntries.length}`);
    for (const r of shortEntries.slice(0, 8)) {
      console.log(`    #${r.id} ${r.activity?.padEnd(10) ?? ''} ${fmt(r.occurred_at)}  (${dur(r.duration_ms)})`);
    }
  }

  if (!values.apply) {
    console.log('\nDRY RUN — nothing was changed. Re-run with --apply to execute.\n');
    return;
  }

  if (plan.deleteIds.length === 0 && shortEntries.length === 0) {
    console.log('\nNothing to do — diary is already clean.\n');
    return;
  }

  // ---- Apply --------------------------------------------------------------
  if (!process.env['DATABASE_PATH']) {
    throw new Error('refusing to --apply without DATABASE_PATH set (cannot locate or back up the DB)');
  }
  const backupPath = `${process.env['DATABASE_PATH']}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  console.log(`\nBacking up DB → ${backupPath}`);
  await conn.backup(backupPath);

  const allDeletes = [...plan.deleteIds, ...shortEntries.map((r) => r.id)];
  const apply = conn.transaction(() => {
    const upd = conn.prepare(
      'UPDATE diary_entries SET occurred_at = @occurred_at, duration_ms = @duration_ms WHERE id = @id',
    );
    for (const u of plan.updates) upd.run(u);
    const del = conn.prepare('DELETE FROM diary_entries WHERE id = ?');
    for (const id of allDeletes) del.run(id);
  });
  apply();

  console.log(
    `Applied: extended ${plan.updates.length}, deleted ${allDeletes.length} ` +
      `(${plan.deleteIds.length} duplicates${shortMs != null ? ` + ${shortEntries.length} short` : ''}).`,
  );
  console.log(`Backup retained at ${backupPath}\n`);
}

// Run only when invoked directly (not when imported by a test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export { planCoalesce, COALESCE_WINDOW_MS };
