import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { N, type Nutrients } from '../core/nutrients';
import { upsertFood } from '../db/repo';
import type { Food, Portion } from '../db/schema';
import type { SearchHit } from './local';

/**
 * Open Food Facts client — the last tier of the food lookup chain.
 *
 * Only reached for products missing from the bundled core data, from the user's
 * own history and from the monthly branded snapshot: in practice, genuinely new
 * items. Everything it returns is written into the local database, so each
 * lookup happens at most once per product per device and the app gets faster
 * the longer you use it.
 *
 * Two upstream constraints shape this file:
 *
 *  - Rate limits are 100 requests/min for product reads and 10/min for search,
 *    with published guidance as low as 15/min for reads. A token bucket keeps
 *    us well under the stricter figure; nothing here is latency-critical.
 *  - The API asks every client to identify itself with a custom User-Agent.
 *    Browsers forbid setting that header, so on native we go through
 *    CapacitorHttp (a real native request, header included) and on the web we
 *    fall back to the documented `app_name`/`app_version`/`app_uuid` query
 *    parameters, which is the closest a browser can get to complying.
 */

const APP_NAME = 'FuelFlow';
const APP_VERSION = '0.1.0';
const CONTACT = 'https://github.com/fuelflow';
const USER_AGENT = `${APP_NAME}/${APP_VERSION} (${CONTACT})`;

const BASE = 'https://world.openfoodfacts.org';
const SEARCH_BASE = 'https://search.openfoodfacts.org';

/**
 * Fields requested explicitly — the full product document is enormous.
 *
 * Two projections, because a search and an open are different questions.
 *
 * A search needs enough to rank a hundred candidates and draw twenty rows:
 * names, brand, energy and macros, and the two ranking signals. It does not
 * need serving sizes or the micronutrient tail, and Search-a-licious does not
 * index those anyway — asking for them costs payload and returns nothing.
 *
 * Opening one product is where the full record is worth fetching, once.
 */
const SEARCH_FIELDS = [
  'code',
  'product_name',
  'product_name_en',
  'generic_name',
  'brands',
  'categories',
  'quantity',
  'nutriments',
  'completeness',
  // How often this product is actually looked up. The single best available
  // signal for "is this the thing people mean", and far more useful than
  // `completeness`, which only says how filled-in the record is.
  'popularity_key',
  'countries_tags',
].join(',');

const PRODUCT_FIELDS = [
  'code',
  'product_name',
  'product_name_en',
  'generic_name',
  'brands',
  'categories',
  'quantity',
  'serving_size',
  'serving_quantity',
  'nutriments',
  'nutriscore_grade',
  'nova_group',
  'completeness',
  'image_front_small_url',
  'countries_tags',
].join(',');

/**
 * Candidates pulled before ranking, against rows actually shown.
 *
 * A single page of relevance-ordered hits buries popular, well-maintained
 * products under near-duplicates and half-filled entries. Fetching a wider
 * pool and re-ranking it locally is what makes the ordering better than the
 * API's own — and with the thin projection above, a hundred rows is a smaller
 * response than fifteen used to be.
 */
const CANDIDATE_POOL = 100;

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

class TokenBucket {
  private tokens: number;
  private last = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerMinute: number,
  ) {
    this.tokens = capacity;
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((now - this.last) / 60_000) * this.refillPerMinute,
    );
    this.last = now;
  }

  /** Take a token if one is free, without waiting. */
  tryTake(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Wait for a token. Only for lookups the user explicitly asked for. */
  async take(): Promise<void> {
    for (;;) {
      if (this.tryTake()) return;
      const waitMs = ((1 - this.tokens) / this.refillPerMinute) * 60_000;
      await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, Math.max(200, waitMs))));
    }
  }
}

// At the published ceilings rather than under them. The previous figures were
// half of what Open Food Facts allows, and search in particular was throttled
// to one request every ten seconds — so the fourth search of a session sat and
// waited before a single byte moved. Being a good citizen means not exceeding
// the limit, not making the app feel broken.
//
// A barcode scan waits for its token: the user pointed a camera at a specific
// product and nothing else will do. A search does not — see `searchOnline`.
const productBucket = new TokenBucket(10, 60);
const searchBucket = new TokenBucket(5, 10);

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * Every request carries a deadline.
 *
 * The browser path had none at all, so a stalled Open Food Facts response left
 * the search sitting on "searching…" until the socket eventually gave up —
 * which on a phone changing cells can be a minute or more.
 */
async function request<T>(url: string, timeoutMs = 15_000, external?: AbortSignal): Promise<T> {
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.get({
      url,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      readTimeout: timeoutMs,
      connectTimeout: timeoutMs,
    });
    if (response.status >= 400) throw new Error(`Open Food Facts returned ${response.status}`);
    return (typeof response.data === 'string' ? JSON.parse(response.data) : response.data) as T;
  }

  const deadline = AbortSignal.timeout(timeoutMs);
  // `AbortSignal.any` is recent; without it the deadline alone still applies.
  const signal =
    external && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([deadline, external])
      : deadline;

  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  if (!response.ok) throw new Error(`Open Food Facts returned ${response.status}`);
  return (await response.json()) as T;
}

/** Browser identification, appended where the User-Agent header cannot be set. */
function identity(): string {
  if (Capacitor.isNativePlatform()) return '';
  return `&app_name=${encodeURIComponent(APP_NAME)}&app_version=${APP_VERSION}&app_uuid=fuelflow-web`;
}

// ---------------------------------------------------------------------------
// Nutrient mapping
// ---------------------------------------------------------------------------

/**
 * Open Food Facts stores every `_100g` value in grams, including minerals and
 * vitamins. `factor` converts that gram figure into the unit FuelFlow displays.
 */
const OFF_NUTRIENTS: { off: string; id: number; factor: number }[] = [
  { off: 'energy-kcal', id: N.ENERGY, factor: 1 },
  { off: 'proteins', id: N.PROTEIN, factor: 1 },
  { off: 'carbohydrates', id: N.CARBS, factor: 1 },
  { off: 'fat', id: N.FAT, factor: 1 },
  { off: 'fiber', id: N.FIBER, factor: 1 },
  { off: 'sugars', id: N.SUGAR, factor: 1 },
  { off: 'added-sugars', id: N.ADDED_SUGAR, factor: 1 },
  { off: 'starch', id: N.STARCH, factor: 1 },
  { off: 'alcohol', id: N.ALCOHOL, factor: 1 },
  { off: 'saturated-fat', id: N.SAT_FAT, factor: 1 },
  { off: 'monounsaturated-fat', id: N.MONO_FAT, factor: 1 },
  { off: 'polyunsaturated-fat', id: N.POLY_FAT, factor: 1 },
  { off: 'trans-fat', id: N.TRANS_FAT, factor: 1 },
  { off: 'cholesterol', id: N.CHOLESTEROL, factor: 1000 },
  { off: 'sodium', id: N.SODIUM, factor: 1000 },
  { off: 'potassium', id: N.POTASSIUM, factor: 1000 },
  { off: 'calcium', id: N.CALCIUM, factor: 1000 },
  { off: 'iron', id: N.IRON, factor: 1000 },
  { off: 'magnesium', id: N.MAGNESIUM, factor: 1000 },
  { off: 'phosphorus', id: N.PHOSPHORUS, factor: 1000 },
  { off: 'zinc', id: N.ZINC, factor: 1000 },
  { off: 'copper', id: N.COPPER, factor: 1000 },
  { off: 'manganese', id: N.MANGANESE, factor: 1000 },
  { off: 'selenium', id: N.SELENIUM, factor: 1_000_000 },
  { off: 'vitamin-a', id: N.VIT_A, factor: 1_000_000 },
  { off: 'vitamin-c', id: N.VIT_C, factor: 1000 },
  { off: 'vitamin-d', id: N.VIT_D, factor: 1_000_000 },
  { off: 'vitamin-e', id: N.VIT_E, factor: 1000 },
  { off: 'vitamin-k', id: N.VIT_K, factor: 1_000_000 },
  { off: 'vitamin-b1', id: N.THIAMIN, factor: 1000 },
  { off: 'vitamin-b2', id: N.RIBOFLAVIN, factor: 1000 },
  { off: 'vitamin-pp', id: N.NIACIN, factor: 1000 },
  { off: 'pantothenic-acid', id: N.PANTOTHENIC, factor: 1000 },
  { off: 'vitamin-b6', id: N.VIT_B6, factor: 1000 },
  { off: 'vitamin-b9', id: N.FOLATE, factor: 1_000_000 },
  { off: 'vitamin-b12', id: N.VIT_B12, factor: 1_000_000 },
  { off: 'caffeine', id: N.CAFFEINE, factor: 1000 },
];

interface OffProduct {
  code?: string;
  product_name?: string;
  product_name_en?: string;
  generic_name?: string;
  brands?: string;
  categories?: string;
  quantity?: string;
  serving_size?: string;
  serving_quantity?: number | string;
  nutriments?: Record<string, number | string | undefined>;
  completeness?: number;
  nova_group?: number;
  nutriscore_grade?: string;
  image_front_small_url?: string;
  /** How often the product is looked up. The ranking signal that matters. */
  popularity_key?: number | string;
  countries_tags?: string[];
}

function num(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function mapNutrients(product: OffProduct): Nutrients {
  const source = product.nutriments ?? {};
  const out: Nutrients = {};

  for (const { off, id, factor } of OFF_NUTRIENTS) {
    const value = num(source[`${off}_100g`]);
    if (value !== undefined) out[id] = value * factor;
  }

  // Many European products list salt but not sodium; 1 g salt ≈ 400 mg sodium.
  if (out[N.SODIUM] === undefined) {
    const salt = num(source['salt_100g']);
    if (salt !== undefined) out[N.SODIUM] = salt * 400;
  }

  // Some products carry only kilojoules.
  if (out[N.ENERGY] === undefined) {
    const kj = num(source['energy-kj_100g']) ?? num(source['energy_100g']);
    if (kj !== undefined) out[N.ENERGY] = kj / 4.184;
  }
  return out;
}

function buildPortions(product: OffProduct): Portion[] {
  const portions: Portion[] = [{ label: '100 g', grams: 100 }];

  const servingGrams = num(product.serving_quantity);
  if (servingGrams !== undefined && servingGrams > 0) {
    portions.unshift({
      label: product.serving_size?.trim() || '1 serving',
      grams: servingGrams,
      preferred: true,
    });
  } else if (product.serving_size) {
    // "30 g (2 biscuits)" — take the leading gram figure when present.
    const match = /([\d.]+)\s*(g|ml)/i.exec(product.serving_size);
    const grams = match?.[1] ? Number(match[1]) : undefined;
    if (grams && grams > 0) {
      portions.unshift({ label: product.serving_size.trim(), grams, preferred: true });
    }
  }

  const packageMatch = product.quantity ? /([\d.]+)\s*(g|ml)/i.exec(product.quantity) : null;
  const packageGrams = packageMatch?.[1] ? Number(packageMatch[1]) : undefined;
  if (packageGrams && packageGrams > 0 && packageGrams !== servingGrams) {
    portions.push({ label: `Whole package (${product.quantity})`, grams: packageGrams });
  }
  return portions;
}

function bestName(product: OffProduct): string {
  return (
    product.product_name_en?.trim() ||
    product.product_name?.trim() ||
    product.generic_name?.trim() ||
    (product.code ? `Product ${product.code}` : 'Unknown product')
  );
}

/**
 * `detailed` marks a record that came from the full product endpoint. Search
 * results are a thin projection and must never overwrite one.
 */
async function toFood(product: OffProduct, detailed = false): Promise<Food | null> {
  const nutrients = mapNutrients(product);
  // A product with no energy figure is unusable as a diary entry.
  if (nutrients[N.ENERGY] === undefined) return null;

  return upsertFood({
    source: 'off',
    sourceId: product.code,
    barcode: product.code,
    name: bestName(product),
    brand: product.brands?.split(',')[0]?.trim(),
    category: product.categories?.split(',')[0]?.trim(),
    per100g: nutrients,
    portions: buildPortions(product),
    quality: typeof product.completeness === 'number' ? product.completeness : 0.5,
    detailed,
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function fetchByBarcode(barcode: string): Promise<Food | null> {
  await productBucket.take();
  const url = `${BASE}/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${PRODUCT_FIELDS}${identity()}`;
  const data = await request<{ status?: number; product?: OffProduct }>(url);
  if (!data.product || data.status === 0) return null;
  return toFood(data.product, true);
}

export interface OffSearchOptions {
  limit?: number;
  /** ISO country code to bias results, e.g. "us", "gb". */
  country?: string;
  signal?: AbortSignal;
}

/**
 * Recent online searches, so retyping does not re-request.
 *
 * Backspacing one character and typing it again is an ordinary thing to do and
 * used to cost a full network round trip — and a rate-limit token with it.
 */
const RECENT_TTL_MS = 5 * 60_000;
const RECENT_MAX = 24;
const recentSearches = new Map<string, { at: number; hits: SearchHit[] }>();

function cached(key: string): SearchHit[] | undefined {
  const entry = recentSearches.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > RECENT_TTL_MS) {
    recentSearches.delete(key);
    return undefined;
  }
  return entry.hits;
}

function remember(key: string, hits: SearchHit[]): void {
  recentSearches.set(key, { at: Date.now(), hits });
  if (recentSearches.size > RECENT_MAX) {
    const oldest = recentSearches.keys().next().value;
    if (oldest !== undefined) recentSearches.delete(oldest);
  }
}

/** Thrown when the rate limiter has nothing left, so the caller can say so. */
export class OffThrottledError extends Error {
  constructor() {
    super('Open Food Facts rate limit reached');
    this.name = 'OffThrottledError';
  }
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * The device's language, with English appended.
 *
 * Search-a-licious takes a relevance context. Without one, every query is
 * judged against the English slice of the catalogue, which is why a Greek
 * product searched in Greek came back with nothing useful. English stays in
 * the list because most of the catalogue only has English names.
 */
function searchLanguages(): string {
  const locale = typeof navigator !== 'undefined' ? navigator.language : 'en';
  const language = (locale ?? 'en').split('-')[0]!.toLowerCase();
  return language === 'en' ? 'en' : `${language},en`;
}

/** The country tag matching the device locale, e.g. "en-GB" -> "en:united-kingdom". */
const COUNTRY_TAGS: Record<string, string> = {
  gb: 'en:united-kingdom',
  us: 'en:united-states',
  gr: 'en:greece',
  de: 'en:germany',
  fr: 'en:france',
  it: 'en:italy',
  es: 'en:spain',
  nl: 'en:netherlands',
  be: 'en:belgium',
  pt: 'en:portugal',
  pl: 'en:poland',
  se: 'en:sweden',
  no: 'en:norway',
  dk: 'en:denmark',
  fi: 'en:finland',
  ie: 'en:ireland',
  at: 'en:austria',
  ch: 'en:switzerland',
  ca: 'en:canada',
  au: 'en:australia',
  nz: 'en:new-zealand',
};

function localCountryTag(): string | null {
  if (typeof navigator === 'undefined') return null;
  const region = new Intl.Locale(navigator.language || 'en').region?.toLowerCase();
  return region ? (COUNTRY_TAGS[region] ?? null) : null;
}

/**
 * How far a product's stated energy can sit from the energy its own macros
 * imply before the entry is treated as data noise.
 *
 * Deliberately loose. Rounding, food-specific Atwater factors and the European
 * convention of counting fibre inside carbohydrate all produce legitimate error
 * up to roughly 15%. Genuine mistakes in crowd-sourced data are not close calls
 * — they are wrong by multiples. 25% sits in the empty space between the two.
 */
const ATWATER_TOLERANCE = 0.25;

/**
 * Whether a product's declared energy agrees with its macros.
 *
 * Returns true when there is nothing to judge: a product with sparse data is
 * not a product with wrong data, and should be ranked on other signals rather
 * than punished for being incomplete.
 */
export function isEnergyPlausible(nutrients: Nutrients): boolean {
  const energy = nutrients[N.ENERGY];
  if (energy === undefined || energy <= 0) return true;
  const carbs = nutrients[N.CARBS];
  const fat = nutrients[N.FAT];
  const protein = nutrients[N.PROTEIN];
  if (carbs === undefined && fat === undefined && protein === undefined) return true;

  // Fibre is not added separately: both OFF and USDA already count it inside
  // the carbohydrate figure, so including it would double-count.
  const implied = 4 * (carbs ?? 0) + 4 * (protein ?? 0) + 9 * (fat ?? 0);
  return Math.abs(energy - implied) / energy <= ATWATER_TOLERANCE;
}

/** Lower lets relevance dominate, higher lets popularity dominate. */
const RANK_FUSION_K = 10;

/** Products sold where the user lives get a nudge, not a guarantee. */
const LOCAL_COUNTRY_BOOST = 1.3;

interface Candidate {
  food: Food;
  popularity: number;
  relevanceRank: number;
  local: boolean;
  plausible: boolean;
}

/**
 * Reciprocal rank fusion of relevance position and popularity.
 *
 * The API returns hits in relevance order, which is sharp for a specific query
 * and poor for a vague one — "yogurt" gives you a thousand equally relevant
 * products and no reason to prefer any of them. `popularity_key` counts how
 * often a product is actually looked up, so fusing the two ranks floats the
 * products people really eat without letting a popular but off-topic item
 * outrank an exact match, the way a straight popularity sort would.
 *
 * Implausible entries are demoted rather than dropped: on a narrow query they
 * may be all there is, and a wrong-looking result the user can inspect beats an
 * empty list. On a full page they fall off the bottom.
 */
function fuseRanks(candidates: Candidate[]): Candidate[] {
  const byPopularity = [...candidates].sort((a, b) => b.popularity - a.popularity);
  const popularityRank = new Map<Candidate, number>();
  byPopularity.forEach((candidate, index) => popularityRank.set(candidate, index));

  const score = (candidate: Candidate) => {
    const fused =
      1 / (RANK_FUSION_K + candidate.relevanceRank) +
      1 / (RANK_FUSION_K + (popularityRank.get(candidate) ?? candidates.length));
    return candidate.local ? fused * LOCAL_COUNTRY_BOOST : fused;
  };

  return [...candidates].sort((a, b) => {
    if (a.plausible !== b.plausible) return a.plausible ? -1 : 1;
    return score(b) - score(a);
  });
}

export async function searchOnline(query: string, options: OffSearchOptions = {}): Promise<SearchHit[]> {
  const trimmed = query.trim();
  if (trimmed.length < 3) return [];

  const limit = options.limit ?? 20;
  const key = `${trimmed.toLowerCase()}|${limit}|${options.country ?? ''}`;
  const hit = cached(key);
  if (hit) return hit;

  /*
   * A search never waits for a rate-limit token.
   *
   * It used to: the bucket refilled at six per minute, so from the fourth
   * search onwards every one of them slept — up to ten seconds — before the
   * request was even sent. That is the "insane time to load" on online
   * results, and it was self-inflicted rather than upstream. There are always
   * local and snapshot results on screen already, so the honest behaviour when
   * the budget is spent is to skip this tier and stop claiming to be loading.
   */
  if (!searchBucket.tryTake()) throw new OffThrottledError();

  const params = new URLSearchParams({
    q: trimmed,
    // A wide pool to rank from, not the handful actually shown.
    page_size: String(CANDIDATE_POOL),
    fields: SEARCH_FIELDS,
    langs: searchLanguages(),
  });
  if (options.country) params.set('countries_tags_en', options.country);

  // Short deadline. This tier is an extra, not the answer — nothing here is
  // worth making the user watch a spinner for.
  const BUDGET_MS = 6_000;

  const products = await fetchCandidates(params, trimmed, BUDGET_MS, options.signal);

  // Converted together rather than one after another. Each conversion touches
  // IndexedDB to resolve and cache the product, and serialising them added the
  // whole round trip again after the network had already finished.
  const converted = await Promise.all(products.map((product) => toFood(product)));

  const country = localCountryTag();
  const candidates: Candidate[] = [];
  converted.forEach((food, index) => {
    if (!food) return;
    const product = products[index]!;
    candidates.push({
      food,
      popularity: num(product.popularity_key) ?? 0,
      // Position in the API's own relevance ordering.
      relevanceRank: index,
      local: country !== null && (product.countries_tags ?? []).includes(country),
      plausible: isEnergyPlausible(food.per100g),
    });
  });

  const hits: SearchHit[] = fuseRanks(candidates)
    .slice(0, limit)
    .map((candidate, rank) => ({
      food: candidate.food,
      // Online results start below local ones on purpose: a food you have
      // eaten before should never be displaced by a stranger's product. Within
      // the tier, the fused ordering is preserved as a descending score.
      score: 25 + Math.max(0, limit - rank) * 0.4,
      tier: 'online' as const,
      suggestedGrams: candidate.food.portions.find((p) => p.preferred)?.grams ?? 100,
    }));

  remember(key, hits);
  return hits;
}

/**
 * How long to stop probing Search-a-licious after it fails.
 *
 * It runs on separate infrastructure from the main site and its outages last
 * hours, not seconds. Trying it first on every single search during an outage
 * means paying the full timeout before falling back, every time — so once it
 * has failed, searches go straight to the classic endpoint for a while.
 */
const SAL_COOLDOWN_MS = 5 * 60_000;
let skipSalUntil = 0;

async function fetchCandidates(
  params: URLSearchParams,
  query: string,
  budgetMs: number,
  signal?: AbortSignal,
): Promise<OffProduct[]> {
  if (Date.now() >= skipSalUntil) {
    try {
      const data = await request<{ hits?: OffProduct[] }>(
        `${SEARCH_BASE}/search?${params.toString()}${identity()}`,
        budgetMs,
        signal,
      );
      skipSalUntil = 0;
      return data.hits ?? [];
    } catch (error) {
      // An abort is the user moving on, not the service being down.
      if (signal?.aborted) throw error;
      skipSalUntil = Date.now() + SAL_COOLDOWN_MS;
    }
  }

  const fallback = new URLSearchParams({
    search_terms: query,
    search_simple: '1',
    action: 'process',
    page_size: String(CANDIDATE_POOL),
    fields: SEARCH_FIELDS,
    json: '1',
  });
  const data = await request<{ products?: OffProduct[] }>(
    `${BASE}/cgi/search.pl?${fallback.toString()}${identity()}`,
    budgetMs,
    signal,
  );
  return data.products ?? [];
}

/** Whether an online lookup is worth attempting right now. */
export function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}
