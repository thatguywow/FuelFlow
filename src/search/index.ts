import { getFoodByBarcode } from '../db/repo';
import type { Food, FoodSource } from '../db/schema';
import { recentFoods, searchLocal, type SearchHit } from './local';
import { lookupBarcode as lookupRemote, searchRemote } from './remote';
import { fetchByBarcode, isOnline, searchOnline } from './off';

export type { SearchHit } from './local';
export { recentFoods, suggestionsForMeal } from './local';
export { parseQuickLog, type ParsedItem } from './parse';
export { remoteDbInfo, warmRemoteDb } from './remote';
import { nearDuplicateKey, relevance } from './relevance';

/**
 * The tiered lookup chain.
 *
 *   1. Personal   — foods you have logged, your recipes, your custom entries.
 *   2. Core       — the USDA generic-food set bundled with the app.
 *   3. Remote     — the branded snapshot, read over HTTP Range requests.
 *   4. Online     — Open Food Facts live, for products newer than the snapshot.
 *
 * Tiers 1 and 2 are the same IndexedDB query and answer instantly offline. They
 * also cover the overwhelming majority of real logging after the first couple
 * of weeks, because people eat the same forty things. Tiers 3 and 4 exist for
 * the long tail, and everything they return is written into tier 1, so the app
 * gets faster and more offline-capable the more it is used.
 */

/** Shortest query worth running against any tier. */
export const MIN_QUERY_LENGTH = 2;

export interface SearchOptions {
  limit?: number;
  sources?: FoodSource[];
  /** Skip the network tiers entirely. */
  localOnly?: boolean;
  /** ISO country code to bias branded results. */
  country?: string;
  signal?: AbortSignal;
}

export interface TieredResults {
  hits: SearchHit[];
  /** True while network tiers are still being queried. */
  pending: boolean;
  /** Tiers that failed or were skipped, for the "searching online…" footer. */
  skipped: ('remote' | 'online')[];
}

/**
 * Progressive search. Local results are delivered on the first callback within
 * a few milliseconds; network tiers arrive later and are merged in. The UI
 * renders whatever it has, so typing never waits on a request.
 */
export async function searchTiered(
  query: string,
  onResults: (results: TieredResults) => void,
  options: SearchOptions = {},
): Promise<void> {
  const limit = options.limit ?? 40;
  const trimmed = query.trim();

  if (trimmed.length === 0) {
    onResults({ hits: await recentFoods(limit), pending: false, skipped: [] });
    return;
  }

  /*
   * One character is not a search.
   *
   * A single letter matches thousands of rows, fills the candidate cap with
   * whatever the index happened to reach first, and cannot rank them
   * meaningfully — so the work is wasted twice over: once locally, and again
   * on a network request nobody can use the answer to. Every keystroke of a
   * real query used to pay that cost on its way past.
   *
   * Recents stay on screen until there is enough to search for, which is more
   * useful than a list assembled from one letter.
   */
  if (trimmed.length < MIN_QUERY_LENGTH) {
    onResults({ hits: await recentFoods(limit), pending: false, skipped: [] });
    return;
  }

  const local = await searchLocal(trimmed, { limit, sources: options.sources });
  if (options.signal?.aborted) return;

  const localOnly = options.localOnly || options.sources !== undefined;
  const wantsMore = local.length < 12 || (local[0]?.score ?? 0) < 45;

  if (localOnly || !wantsMore) {
    onResults({ hits: local, pending: false, skipped: [] });
    return;
  }

  onResults({ hits: local, pending: true, skipped: [] });

  /*
   * Each network tier publishes the moment it lands.
   *
   * These used to be joined with `Promise.all`, so nothing appeared until both
   * had finished — which meant the branded snapshot, answering in a couple of
   * hundred milliseconds from a handful of range requests, sat waiting on an
   * Open Food Facts request that might take seconds. The whole point of a
   * tiered search is that the fast tiers do not queue behind the slow ones,
   * and that was being thrown away at the last step.
   */
  const skipped: ('remote' | 'online')[] = [];
  let remote: SearchHit[] = [];
  let online: SearchHit[] = [];
  let outstanding = 2;

  const publish = () => {
    if (options.signal?.aborted) return;
    onResults({
      hits: merge(trimmed, local, remote, online).slice(0, limit),
      pending: outstanding > 0,
      skipped: [...skipped],
    });
  };

  const settle = (tier: 'remote' | 'online', results: SearchHit[] | null) => {
    if (results) {
      if (tier === 'remote') remote = results;
      else online = results;
    } else {
      skipped.push(tier);
    }
    outstanding--;
    publish();
  };

  await Promise.all([
    searchRemote(trimmed, 25).then(
      (r) => settle('remote', r),
      () => settle('remote', null),
    ),
    (isOnline()
      ? searchOnline(trimmed, { limit: 15, country: options.country, signal: options.signal })
      : Promise.reject(new Error('offline'))
    ).then(
      (r) => settle('online', r),
      () => settle('online', null),
    ),
  ]);
}

/** Promise-shaped wrapper for callers that do not want progressive updates. */
export async function search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
  let final: SearchHit[] = [];
  await searchTiered(query, (r) => {
    if (!r.pending) final = r.hits;
  }, options);
  return final;
}

/**
 * Merge the tiers into one ordering.
 *
 * Three things happen here, in order.
 *
 * Exact duplicates collapse first — the same product routinely appears in the
 * local cache, the branded snapshot and the live API under the same barcode.
 * The highest-scoring copy wins, and because local copies score higher your
 * own portion sizes survive.
 *
 * Then near-duplicates: the same real food often exists as *separate* records
 * in different sources with different codes, so the exact key never catches
 * them. Matching is on normalised name and brand and nothing looser, because
 * merging two foods that merely read alike would hide one of them.
 *
 * Finally the order: by each tier's own score, with the user's own foods held
 * above the rest — something you saved yourself is nearly always what you
 * meant.
 *
 * Ordering by pure text relevance was tried here and measured worse. It looks
 * like the principled choice, since the tiers do not score on a common scale,
 * but the local score is not just a text match: it carries the penalties that
 * push prepared products below the plain food, the trust ordering between
 * sources, and how often you actually eat something. Discarding all of that
 * put "Bread, egg" above "Egg, whole, raw" and deli rolls back above chicken
 * breast. Relevance is kept for the one job it does better — choosing which
 * copy of a duplicate to show.
 */
function merge(query: string, ...lists: SearchHit[][]): SearchHit[] {
  const byKey = new Map<string, SearchHit>();
  for (const list of lists) {
    for (const hit of list) {
      const key = identityKey(hit.food);
      const existing = byKey.get(key);
      if (!existing || hit.score > existing.score) byKey.set(key, hit);
    }
  }

  const scored = [...byKey.values()].map((hit) => ({
    hit,
    relevance: relevance(hit.food.name, hit.food.brand, query),
  }));

  // Own content is never merged away, even if a remote record shares its name.
  const isOwn = (hit: SearchHit) =>
    hit.food.source === 'user' || hit.food.source === 'recipe' || hit.food.source === 'label';

  const own = scored.filter((entry) => isOwn(entry.hit));
  const rest = collapseNearDuplicates(scored.filter((entry) => !isOwn(entry.hit)));

  const byScore = (a: { hit: SearchHit }, b: { hit: SearchHit }) => b.hit.score - a.hit.score;
  return [...own.sort(byScore), ...rest.sort(byScore)].map((entry) => entry.hit);
}

/** Keeps the best-matching copy of each distinct food, in first-seen order. */
function collapseNearDuplicates<T extends { hit: SearchHit; relevance: number }>(entries: T[]): T[] {
  const groups = new Map<string, T>();
  const ungrouped: T[] = [];
  const order: string[] = [];

  for (const entry of entries) {
    const key = nearDuplicateKey(entry.hit.food.name, entry.hit.food.brand);
    if (key === null) {
      ungrouped.push(entry);
      continue;
    }
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, entry);
      order.push(key);
      continue;
    }
    // Same food from two sources: keep whichever matches the query better,
    // and on a tie the one that arrived first — tiers are already ordered by
    // how much they can be trusted.
    if (entry.relevance > existing.relevance) groups.set(key, entry);
  }

  return [...order.map((key) => groups.get(key)!), ...ungrouped];
}

function identityKey(food: Food): string {
  if (food.barcode) return `barcode:${food.barcode.replace(/^0+/, '')}`;
  return `name:${food.name.toLowerCase().trim()}|${(food.brand ?? '').toLowerCase().trim()}`;
}

export interface BarcodeResult {
  food: Food | null;
  /** Which tier answered — shown as a small provenance label on the result. */
  tier: 'personal' | 'remote' | 'online' | 'none';
}

/**
 * Barcode lookup, cheapest tier first. The local hit is free, the snapshot
 * costs a few kilobytes of range requests, and only a genuinely new product
 * reaches the live API.
 */
export async function lookupBarcode(barcode: string): Promise<BarcodeResult> {
  const local = await getFoodByBarcode(barcode);
  if (local) return { food: local, tier: 'personal' };

  const remote = await lookupRemote(barcode).catch(() => null);
  if (remote) return { food: remote, tier: 'remote' };

  if (isOnline()) {
    const online = await fetchByBarcode(barcode).catch(() => null);
    if (online) return { food: online, tier: 'online' };
  }
  return { food: null, tier: 'none' };
}
