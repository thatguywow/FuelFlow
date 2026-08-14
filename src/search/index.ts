import { getFoodByBarcode } from '../db/repo';
import type { Food, FoodSource } from '../db/schema';
import { recentFoods, searchLocal, type SearchHit } from './local';
import { lookupBarcode as lookupRemote, searchRemote } from './remote';
import { fetchByBarcode, isOnline, searchOnline } from './off';

export type { SearchHit } from './local';
export { recentFoods, suggestionsForMeal } from './local';
export { parseQuickLog, type ParsedItem } from './parse';
export { remoteDbInfo, warmRemoteDb } from './remote';

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

  const local = await searchLocal(trimmed, { limit, sources: options.sources });
  if (options.signal?.aborted) return;

  const localOnly = options.localOnly || options.sources !== undefined;
  const wantsMore = local.length < 12 || (local[0]?.score ?? 0) < 45;

  if (localOnly || !wantsMore) {
    onResults({ hits: local, pending: false, skipped: [] });
    return;
  }

  onResults({ hits: local, pending: true, skipped: [] });

  const skipped: ('remote' | 'online')[] = [];
  const [remote, online] = await Promise.all([
    searchRemote(trimmed, 25).catch(() => {
      skipped.push('remote');
      return [] as SearchHit[];
    }),
    isOnline()
      ? searchOnline(trimmed, { limit: 15, country: options.country }).catch(() => {
          skipped.push('online');
          return [] as SearchHit[];
        })
      : Promise.resolve<SearchHit[]>((skipped.push('online'), [])),
  ]);

  if (options.signal?.aborted) return;
  onResults({ hits: merge(local, remote, online).slice(0, limit), pending: false, skipped });
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
 * Deduplicate across tiers. The same product routinely appears in the local
 * cache, the branded snapshot and the live API; the highest-scoring copy wins
 * and, because local copies score higher, your own portion sizes survive.
 */
function merge(...lists: SearchHit[][]): SearchHit[] {
  const byKey = new Map<string, SearchHit>();
  for (const list of lists) {
    for (const hit of list) {
      const key = identityKey(hit.food);
      const existing = byKey.get(key);
      if (!existing || hit.score > existing.score) byKey.set(key, hit);
    }
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score);
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
