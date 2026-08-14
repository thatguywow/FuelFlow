import { db } from './schema';

/**
 * Clears out cached copies of remote foods nobody uses.
 *
 * Every result from the branded snapshot and from Open Food Facts is written
 * into the local table — that is what makes the app faster and more offline
 * the more it is used. Nothing ever removed them again, so the table only grew:
 * every search that was scrolled past, every product scanned once in a shop and
 * never eaten, kept forever. That cost is paid on every local query, because
 * the candidate scan walks more rows the bigger the table gets.
 *
 * Four things are never pruned, in order of how badly it would hurt to lose
 * them:
 *
 *   - Anything the user made: their own foods, recipes and scanned labels.
 *   - The bundled USDA set, which is not a cache and is reinstalled by version.
 *   - Anything a diary entry points at, past or present. The entry keeps its
 *     own nutrition snapshot so history would survive, but editing that entry
 *     re-reads the food, and a missing one turns an edit into a dead end.
 *   - Anything used recently, or marked a favourite.
 *
 * Runs once on launch, in the background, after everything else has settled.
 */

/** How long an untouched cached food is kept. */
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** Never prune below this many cached rows — the work is not worth it. */
const FLOOR = 400;

export interface PruneResult {
  scanned: number;
  removed: number;
}

export async function pruneStaleFoods(
  { maxAgeMs = MAX_AGE_MS, at = Date.now() }: { maxAgeMs?: number; at?: number } = {},
): Promise<PruneResult> {
  // Only ever cached remote data. 'usda' is the bundled set; 'user', 'recipe'
  // and 'label' are the user's own.
  const cached = await db.foods.where('source').anyOf(['off', 'branded']).toArray();
  if (cached.length <= FLOOR) return { scanned: cached.length, removed: 0 };

  const cutoff = at - maxAgeMs;

  // A single pass over usage and entries, rather than a query per food: with a
  // few thousand cached rows the per-row version was the slow part of the very
  // startup this is meant to speed up.
  const [usageRows, metaRows, entryFoodIds] = await Promise.all([
    db.usage.toArray(),
    db.foodMeta.toArray(),
    db.entries.toArray().then((entries) => new Set(entries.map((e) => e.foodId).filter(Boolean))),
  ]);

  const usageById = new Map(usageRows.map((row) => [row.foodId, row]));
  const seenById = new Map(metaRows.map((row) => [row.foodId, row.seenAt]));

  const doomed: string[] = [];
  for (const food of cached) {
    if (entryFoodIds.has(food.id)) continue;

    const usage = usageById.get(food.id);
    if (usage?.favorite) continue;

    // `lastUsedAt` is when it was last actually eaten; `seenAt` is when a
    // lookup last returned it. `updatedAt` is the fallback for rows cached
    // before the sidecar existed. The latest of the three is how recently this
    // food mattered.
    const touched = Math.max(usage?.lastUsedAt ?? 0, seenById.get(food.id) ?? 0, food.updatedAt ?? 0);
    if (touched >= cutoff) continue;

    doomed.push(food.id);
  }

  if (doomed.length > 0) {
    await db.foods.bulkDelete(doomed);
    // Usage and cache rows for foods that no longer exist are dead weight of
    // their own.
    await db.usage.bulkDelete(doomed);
    await db.foodMeta.bulkDelete(doomed);
  }

  return { scanned: cached.length, removed: doomed.length };
}
