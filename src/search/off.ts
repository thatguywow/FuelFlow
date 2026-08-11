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

/** Fields requested explicitly — the full product document is enormous. */
const FIELDS = [
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

  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(
        this.capacity,
        this.tokens + ((now - this.last) / 60_000) * this.refillPerMinute,
      );
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = ((1 - this.tokens) / this.refillPerMinute) * 60_000;
      await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, Math.max(200, waitMs))));
    }
  }
}

// Deliberately below the published ceilings: an IP ban would break the app for
// everyone behind that address, and no user action here needs to be instant.
const productBucket = new TokenBucket(6, 12);
const searchBucket = new TokenBucket(3, 6);

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function request<T>(url: string): Promise<T> {
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.get({
      url,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      readTimeout: 15_000,
      connectTimeout: 15_000,
    });
    if (response.status >= 400) throw new Error(`Open Food Facts returned ${response.status}`);
    return (typeof response.data === 'string' ? JSON.parse(response.data) : response.data) as T;
  }

  const response = await fetch(url, { headers: { Accept: 'application/json' } });
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

async function toFood(product: OffProduct): Promise<Food | null> {
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
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function fetchByBarcode(barcode: string): Promise<Food | null> {
  await productBucket.take();
  const url = `${BASE}/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${FIELDS}${identity()}`;
  const data = await request<{ status?: number; product?: OffProduct }>(url);
  if (!data.product || data.status === 0) return null;
  return toFood(data.product);
}

export interface OffSearchOptions {
  limit?: number;
  /** ISO country code to bias results, e.g. "us", "gb". */
  country?: string;
}

export async function searchOnline(query: string, options: OffSearchOptions = {}): Promise<SearchHit[]> {
  const trimmed = query.trim();
  if (trimmed.length < 3) return [];
  await searchBucket.take();

  const limit = options.limit ?? 20;
  const params = new URLSearchParams({
    q: trimmed,
    page_size: String(limit),
    fields: FIELDS,
  });
  if (options.country) params.set('countries_tags_en', options.country);

  let products: OffProduct[] = [];
  try {
    // search-a-licious is the purpose-built full-text service and is far better
    // at ranking than the legacy filter endpoint.
    const data = await request<{ hits?: OffProduct[] }>(
      `${SEARCH_BASE}/search?${params.toString()}${identity()}`,
    );
    products = data.hits ?? [];
  } catch {
    const fallback = new URLSearchParams({
      search_terms: trimmed,
      page_size: String(limit),
      fields: FIELDS,
      json: '1',
    });
    const data = await request<{ products?: OffProduct[] }>(
      `${BASE}/cgi/search.pl?${fallback.toString()}${identity()}`,
    );
    products = data.products ?? [];
  }

  const hits: SearchHit[] = [];
  for (const product of products) {
    const food = await toFood(product);
    if (!food) continue;
    hits.push({
      food,
      // Online results start below local ones on purpose: a food you have
      // eaten before should never be displaced by a stranger's product.
      score: 25 + (food.quality ?? 0.5) * 15,
      tier: 'online',
      suggestedGrams: food.portions.find((p) => p.preferred)?.grams ?? 100,
    });
  }
  return hits;
}

/** Whether an online lookup is worth attempting right now. */
export function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}
