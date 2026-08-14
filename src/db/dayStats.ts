import { db, type DayGoals, type DayStats, type DiaryEntry } from './schema';
import { addDays, daysBetween, type DayKey } from '../core/dates';
import type { Nutrients } from '../core/nutrients';

/**
 * Per-day aggregates.
 *
 * Trends, streaks and the adaptive estimator all want the same thing: "what did
 * each day total". That was computed by reading every entry in the window and
 * adding it up, which is why a week of history cost nearly as much as a year —
 * the expense is deserialising the rows, not the arithmetic.
 *
 * So the totals are kept as they are made. Every diary write reports the
 * difference it caused and the affected day's row moves by exactly that much.
 * Nothing is ever recomputed on the read path.
 *
 * A cache that can drift from its source is a bug waiting to be believed, so
 * every row also carries `rowCount`: every entry filed under that day,
 * tombstones included. A reader compares the sum of those against a native
 * IndexedDB index count — which does not deserialise anything — and if the two
 * disagree it ignores the cache, answers from the entries themselves, and
 * schedules a rebuild. Wrong numbers are never shown; the worst case is that a
 * read is as slow as it used to be.
 */

/** Bumped when the shape changes, to force one rebuild after an upgrade. */
const STATS_VERSION = 1;
const STATS_KEY = 'dayStats.version';

/** Stored nutrient precision. Enough for micrograms, short of float dust. */
const PRECISION = 1e4;

// ---------------------------------------------------------------------------
// Deltas
// ---------------------------------------------------------------------------

interface Delta {
  nutrients: Nutrients;
  entries: number;
  rows: number;
}

export interface EntryChange {
  before?: DiaryEntry;
  after?: DiaryEntry;
}

function blankDelta(): Delta {
  return { nutrients: {}, entries: 0, rows: 0 };
}

/** Fold one side of a change into the running per-day deltas. */
function fold(into: Map<DayKey, Delta>, entry: DiaryEntry | undefined, sign: 1 | -1): void {
  if (!entry) return;
  let delta = into.get(entry.day);
  if (!delta) {
    delta = blankDelta();
    into.set(entry.day, delta);
  }
  // A tombstone still occupies a row — that is exactly what makes `rowCount`
  // comparable to a raw index count — but it contributes no food.
  delta.rows += sign;
  if (entry.deleted) return;
  delta.entries += sign;
  for (const key in entry.nutrients) {
    const value = entry.nutrients[key];
    if (value === undefined) continue;
    delta.nutrients[key] = (delta.nutrients[key] ?? 0) + value * sign;
  }
}

/**
 * Apply a batch of diary changes to the aggregates.
 *
 * Must be called inside the same transaction as the entry writes themselves,
 * or a failure halfway through leaves the totals describing a diary that was
 * never committed.
 */
export async function applyEntryChanges(changes: EntryChange[]): Promise<void> {
  const deltas = new Map<DayKey, Delta>();
  for (const change of changes) {
    fold(deltas, change.before, -1);
    fold(deltas, change.after, 1);
  }
  if (deltas.size === 0) return;

  const ts = Date.now();
  for (const [day, delta] of deltas) {
    const current = (await db.dayStats.get(day)) ?? emptyStats(day);
    const entryCount = Math.max(0, current.entryCount + delta.entries);
    const rowCount = Math.max(0, current.rowCount + delta.rows);

    // Emptying a day resets the vector outright rather than subtracting its way
    // to zero: repeated add-then-subtract on floats leaves a residue, and a day
    // with nothing in it reading "0.0000000001 kcal" is worse than useless.
    const nutrients = entryCount === 0 ? {} : merge(current.nutrients, delta.nutrients);

    await db.dayStats.put({ ...current, nutrients, entryCount, rowCount, updatedAt: ts });
  }
}

export function applyEntryChange(before: DiaryEntry | undefined, after: DiaryEntry | undefined) {
  return applyEntryChanges([{ before, after }]);
}

function merge(base: Nutrients, delta: Nutrients): Nutrients {
  const out: Nutrients = { ...base };
  for (const key in delta) {
    const value = (out[key] ?? 0) + (delta[key] ?? 0);
    const rounded = Math.round(value * PRECISION) / PRECISION;
    if (rounded === 0) delete out[key];
    else out[key] = rounded;
  }
  return out;
}

function emptyStats(day: DayKey): DayStats {
  return { day, nutrients: {}, entryCount: 0, rowCount: 0, updatedAt: 0 };
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

/**
 * Record the targets in force on a day.
 *
 * Called while that day is the one being logged, which is the only moment the
 * information exists — there is no history of past targets to reconstruct from.
 * Days logged before this shipped therefore have no snapshot, and the charts
 * fall back to the current target for them and say so.
 */
export async function recordDayGoals(day: DayKey, goals: DayGoals): Promise<boolean> {
  const current = (await db.dayStats.get(day)) ?? emptyStats(day);
  if (current.goals && sameGoals(current.goals, goals)) return false;
  await db.dayStats.put({ ...current, goals, updatedAt: Date.now() });
  return true;
}

function sameGoals(a: DayGoals, b: DayGoals): boolean {
  // Rounded, because the targets are re-derived from a Kalman filter on every
  // load and a hundredth of a kilocalorie of drift is not a changed goal.
  return (
    Math.round(a.energyKcal) === Math.round(b.energyKcal) &&
    Math.round(a.proteinG) === Math.round(b.proteinG) &&
    Math.round(a.carbsG) === Math.round(b.carbsG) &&
    Math.round(a.fatG) === Math.round(b.fatG)
  );
}

// ---------------------------------------------------------------------------
// Rebuild & integrity
// ---------------------------------------------------------------------------

/**
 * Recompute the aggregates from the diary itself.
 *
 * The slow path, by design: it is the backfill, the repair, and the definition
 * of what the fast path is supposed to produce.
 */
export async function rebuildDayStats(range?: { from: DayKey; to: DayKey }): Promise<number> {
  const [entries, existing] = await Promise.all([
    range
      ? db.entries.where('day').between(range.from, range.to, true, true).toArray()
      : db.entries.toArray(),
    range
      ? db.dayStats.where('day').between(range.from, range.to, true, true).toArray()
      : db.dayStats.toArray(),
  ]);

  const ts = Date.now();
  const rebuilt = new Map<DayKey, DayStats>();
  // Goals are not derivable from entries, so they are carried across untouched.
  const goalsByDay = new Map<DayKey, DayGoals | undefined>(existing.map((r) => [r.day, r.goals]));

  for (const entry of entries) {
    let row = rebuilt.get(entry.day);
    if (!row) {
      row = { ...emptyStats(entry.day), goals: goalsByDay.get(entry.day), updatedAt: ts };
      rebuilt.set(entry.day, row);
    }
    row.rowCount++;
    if (entry.deleted) continue;
    row.entryCount++;
    row.nutrients = merge(row.nutrients, entry.nutrients);
  }

  // A day that kept a goal snapshot but lost every entry still deserves its row;
  // one with neither is dead weight.
  const doomed: string[] = [];
  for (const row of existing) {
    if (rebuilt.has(row.day)) continue;
    if (row.goals) rebuilt.set(row.day, { ...emptyStats(row.day), goals: row.goals, updatedAt: ts });
    else doomed.push(row.day);
  }

  await db.transaction('rw', db.dayStats, async () => {
    if (doomed.length > 0) await db.dayStats.bulkDelete(doomed);
    await db.dayStats.bulkPut([...rebuilt.values()]);
  });

  return rebuilt.size;
}

/** Backfill once after install or upgrade. Cheap to call on every launch. */
export async function ensureDayStats(): Promise<void> {
  const flag = await db.kv.get(STATS_KEY);
  if (flag?.value === STATS_VERSION) return;
  await rebuildDayStats();
  await db.kv.put({ key: STATS_KEY, value: STATS_VERSION, updatedAt: Date.now() });
}

let repairing: Promise<unknown> | null = null;

/**
 * Repair the aggregates, at most one repair at a time.
 *
 * Deliberately fire-and-forget: the caller that noticed the problem is a live
 * query running inside a read-only transaction, so it cannot write, and it has
 * already produced a correct answer the slow way. This just makes sure the next
 * read is fast again.
 */
function scheduleRepair(range: { from: DayKey; to: DayKey }): void {
  if (repairing) return;
  repairing = Promise.resolve()
    .then(() => rebuildDayStats(range))
    .catch(() => undefined)
    .finally(() => {
      repairing = null;
    });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface DailySummary {
  day: DayKey;
  nutrients: Nutrients;
  entryCount: number;
  /** The targets that applied on this day, when they were recorded. */
  goals?: DayGoals;
}

/**
 * One row per day across the range, whether or not anything was logged.
 *
 * Answers from the aggregates when they check out against the diary, and from
 * the diary itself when they do not.
 */
export async function dailySummaries(from: DayKey, to: DayKey): Promise<DailySummary[]> {
  const [stats, actualRows] = await Promise.all([
    db.dayStats.where('day').between(from, to, true, true).toArray(),
    // A native index count. It walks index keys, never record values, so this
    // stays cheap on a diary with years in it.
    db.entries.where('day').between(from, to, true, true).count(),
  ]);

  const cachedRows = stats.reduce((sum, row) => sum + row.rowCount, 0);
  if (cachedRows !== actualRows) {
    scheduleRepair({ from, to });
    return summariseFromEntries(from, to, stats);
  }

  const byDay = new Map(stats.map((row) => [row.day, row]));
  return fill(from, to, (day) => {
    const row = byDay.get(day);
    return {
      day,
      nutrients: row?.nutrients ?? {},
      entryCount: row?.entryCount ?? 0,
      goals: row?.goals,
    };
  });
}

/** The original implementation, kept as the fallback and as the reference. */
async function summariseFromEntries(
  from: DayKey,
  to: DayKey,
  stats: DayStats[],
): Promise<DailySummary[]> {
  const entries = await db.entries.where('day').between(from, to, true, true).toArray();
  const goalsByDay = new Map(stats.map((row) => [row.day, row.goals]));
  const byDay = new Map<DayKey, DailySummary>();

  for (const entry of entries) {
    if (entry.deleted) continue;
    let summary = byDay.get(entry.day);
    if (!summary) {
      summary = { day: entry.day, nutrients: {}, entryCount: 0, goals: goalsByDay.get(entry.day) };
      byDay.set(entry.day, summary);
    }
    summary.nutrients = merge(summary.nutrients, entry.nutrients);
    summary.entryCount++;
  }

  return fill(from, to, (day) =>
    byDay.get(day) ?? { day, nutrients: {}, entryCount: 0, goals: goalsByDay.get(day) },
  );
}

function fill(from: DayKey, to: DayKey, at: (day: DayKey) => DailySummary): DailySummary[] {
  const span = daysBetween(from, to);
  const out: DailySummary[] = [];
  for (let i = 0; i <= span; i++) out.push(at(addDays(from, i)));
  return out;
}
