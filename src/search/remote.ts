import type { WorkerHttpvfs } from 'sql.js-httpvfs';
import { N, type Nutrients } from '../core/nutrients';
import { upsertFood } from '../db/repo';
import type { Food, Portion } from '../db/schema';
import type { SearchHit } from './local';

/**
 * Remote branded food database — the workaround for "the database is too big to
 * ship and I have no server".
 *
 * A monthly GitHub Action distils Open Food Facts and USDA Branded Foods into
 * one SQLite file with an FTS5 index, splits it into sub-100 MB chunks, and
 * publishes it to GitHub Pages as ordinary static files. At runtime SQLite runs
 * in a WebWorker and reads that file over HTTP Range requests, pulling only the
 * B-tree pages a query actually touches.
 *
 * The practical effect: a barcode lookup against a database of millions of
 * products costs a few kilobytes and a couple of round trips. There is no
 * backend, no API key, no rate limit and no per-request cost — the "server" is
 * a CDN serving byte ranges of a static file.
 *
 * `barcode` is an INTEGER PRIMARY KEY, so it *is* the table's rowid and the
 * rows are physically ordered by it. That turns a lookup into a direct B-tree
 * descent — about three page reads — instead of an index probe followed by a
 * row fetch somewhere else in the file.
 */

export interface RemoteDbManifest {
  /** Snapshot version, e.g. "2026-08". Changing it busts the caches. */
  version: string;
  /** Path to the sql.js-httpvfs config JSON, relative to the manifest. */
  config: string;
  productCount: number;
  /** Per-source row counts, shown on the Food databases screen. */
  breakdown?: { off: number; usdaBranded: number; usdaGeneric: number };
  /** "global", or the comma-separated country list the build was limited to. */
  scope?: string;
  builtAt: string;
  sources: string[];
}

const DEFAULT_DB_URL =
  import.meta.env.VITE_FOOD_DB_URL ?? `${import.meta.env.BASE_URL}fooddb/`;

/**
 * Resolve a path against the database location, handling both forms it takes.
 *
 * On the web this is a site-relative path like `/FuelFlow/fooddb/`; in the
 * native app it is an absolute `https://…` URL, because the database is far too
 * large to ship inside the APK and has to be read from the Pages deployment.
 * Blindly prefixing `location.origin` produces `capacitor://localhosthttps://…`
 * for the absolute case — an invalid URL that throws inside worker startup,
 * where the failure was being swallowed. `new URL(…, base)` already ignores the
 * base when the input is absolute, so the only care needed is not to build a
 * nonsense base in the first place.
 */
function absoluteDbUrl(pathOrUrl: string): string {
  const base = /^https?:\/\//i.test(DEFAULT_DB_URL)
    ? DEFAULT_DB_URL
    : new URL(DEFAULT_DB_URL, location.origin).toString();
  return new URL(pathOrUrl, base).toString();
}

let workerPromise: Promise<WorkerHttpvfs | null> | null = null;
let manifest: RemoteDbManifest | null = null;
let unavailableUntil = 0;

/**
 * The remote tier is strictly optional. If the data host is unreachable, the
 * snapshot has not been built yet, or the browser lacks WebAssembly, we mark it
 * unavailable for a while and the search chain simply skips it.
 */
function markUnavailable(minutes = 10): null {
  unavailableUntil = Date.now() + minutes * 60_000;
  return null;
}

/**
 * A query failure used to be swallowed entirely, which turned a broken SQL
 * statement into "the branded tier just never returns anything" — invisible in
 * the UI and invisible in the console. Degrading quietly is right; degrading
 * silently is not.
 */
function reportQueryFailure(what: string, error: unknown): void {
  console.warn(`[fuelflow] hosted database ${what} failed:`, error);
}

async function getWorker(): Promise<WorkerHttpvfs | null> {
  if (Date.now() < unavailableUntil) return null;
  if (workerPromise) return workerPromise;

  workerPromise = (async () => {
    try {
      // The manifest is checked before anything heavy loads, so a deployment
      // with no branded snapshot never pays for the SQLite runtime at all.
      const manifestResponse = await fetch(absoluteDbUrl('manifest.json'), { cache: 'no-cache' });
      if (!manifestResponse.ok) return markUnavailable();
      manifest = (await manifestResponse.json()) as RemoteDbManifest;

      // sql.js-httpvfs drags in a 1.2 MB WebAssembly build. Importing it here
      // rather than at module scope keeps it out of the initial download and
      // out of the service worker's precache — it is fetched the first time a
      // lookup actually needs the branded database, and cached from then on.
      const { createDbWorker } = await import('sql.js-httpvfs');

      const worker = await createDbWorker(
        [{ from: 'jsonconfig', configUrl: absoluteDbUrl(manifest.config) }],
        new URL('sql.js-httpvfs/dist/sqlite.worker.js', import.meta.url).toString(),
        new URL('sql.js-httpvfs/dist/sql-wasm.wasm', import.meta.url).toString(),
      );
      return worker;
    } catch (error) {
      reportQueryFailure('worker startup', error);
      return markUnavailable();
    }
  })();

  const resolved = await workerPromise;
  if (!resolved) workerPromise = null;
  return resolved;
}

export function remoteDbInfo(): RemoteDbManifest | null {
  return manifest;
}

/**
 * Free the page cache. sql.js-httpvfs caches every page it reads and never
 * evicts, so a long session that runs many different queries grows its worker
 * memory without bound. The library exposes no handle on the underlying Worker,
 * so the thread itself cannot be terminated from here — closing the database is
 * what actually releases the cached pages. Called when the app is backgrounded.
 */
export async function releaseRemoteDb(): Promise<void> {
  const worker = await workerPromise?.catch(() => null);
  workerPromise = null;
  manifest = null;
  try {
    await (worker?.db as unknown as { close?: () => Promise<void> } | undefined)?.close?.();
  } catch {
    /* Worker already gone. */
  }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface ProductRow {
  /** Positive for barcoded products; negative for USDA generic foods. */
  id: number;
  name: string;
  brand: string | null;
  category: string | null;
  serving_g: number | null;
  package_g: number | null;
  kcal: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  fiber: number | null;
  sugar: number | null;
  satfat: number | null;
  sodium: number | null;
  cholesterol: number | null;
  potassium: number | null;
  calcium: number | null;
  iron: number | null;
  quality: number | null;
  /** 0 = Open Food Facts, 1 = USDA branded, 2 = USDA generic. */
  src: number | null;
}

const COLUMNS = `id, name, brand, category, serving_g, package_g, kcal, protein, carbs, fat,
  fiber, sugar, satfat, sodium, cholesterol, potassium, calcium, iron, quality, src`;

const SRC_OFF = 0;
const SRC_USDA_GENERIC = 2;

function rowToNutrients(row: ProductRow): Nutrients {
  const out: Nutrients = {};
  const set = (id: number, value: number | null) => {
    if (value !== null && value !== undefined && Number.isFinite(value)) out[id] = value;
  };
  set(N.ENERGY, row.kcal);
  set(N.PROTEIN, row.protein);
  set(N.CARBS, row.carbs);
  set(N.FAT, row.fat);
  set(N.FIBER, row.fiber);
  set(N.SUGAR, row.sugar);
  set(N.SAT_FAT, row.satfat);
  set(N.SODIUM, row.sodium);
  set(N.CHOLESTEROL, row.cholesterol);
  set(N.POTASSIUM, row.potassium);
  set(N.CALCIUM, row.calcium);
  set(N.IRON, row.iron);
  return out;
}

/** Barcodes are stored without leading zeros so they fit the integer rowid. */
export function barcodeToKey(barcode: string): number | null {
  const digits = barcode.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 14) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}

export function keyToBarcode(key: number, width = 13): string {
  return String(key).padStart(width, '0');
}

function buildPortions(row: ProductRow): Portion[] {
  const portions: Portion[] = [];
  if (row.serving_g && row.serving_g > 0) {
    portions.push({ label: `1 serving (${Math.round(row.serving_g)} g)`, grams: row.serving_g, preferred: true });
  }
  portions.push({ label: '100 g', grams: 100, preferred: !row.serving_g });
  if (row.package_g && row.package_g > 0 && row.package_g !== row.serving_g) {
    portions.push({ label: `Whole package (${Math.round(row.package_g)} g)`, grams: row.package_g });
  }
  return portions;
}

async function rowToFood(row: ProductRow): Promise<Food | null> {
  if (row.kcal === null || row.kcal === undefined) return null;
  // Negative ids are USDA generic foods, which have no barcode at all.
  const barcoded = row.id > 0;
  return upsertFood({
    source: row.src === SRC_OFF ? 'off' : row.src === SRC_USDA_GENERIC ? 'usda' : 'branded',
    sourceId: String(row.id),
    barcode: barcoded ? keyToBarcode(row.id) : undefined,
    name: row.name,
    brand: row.brand ?? undefined,
    category: row.category ?? undefined,
    per100g: rowToNutrients(row),
    portions: buildPortions(row),
    quality: row.quality ?? 0.6,
    verified: row.src !== SRC_OFF,
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function lookupBarcode(barcode: string): Promise<Food | null> {
  const key = barcodeToKey(barcode);
  if (key === null) return null;
  const worker = await getWorker();
  if (!worker) return null;

  try {
    const rows = (await worker.db.query(
      `SELECT ${COLUMNS} FROM products WHERE id = ? LIMIT 1`,
      [key],
    )) as unknown as ProductRow[];
    const row = rows[0];
    return row ? rowToFood(row) : null;
  } catch (error) {
    reportQueryFailure('barcode lookup', error);
    return markUnavailable(5);
  }
}

export async function searchRemote(query: string, limit = 25): Promise<SearchHit[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];
  const worker = await getWorker();
  if (!worker) return [];

  // Every term becomes a prefix term so results appear while still typing.
  const matchExpression = trimmed
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '')}"*`)
    .join(' ');
  if (!matchExpression) return [];

  try {
    const rows = (await worker.db.query(
      `SELECT ${COLUMNS.split(',')
        .map((c) => `p.${c.trim()}`)
        .join(', ')}
       FROM products_fts f
       JOIN products p ON p.rowid = f.rowid
       WHERE products_fts MATCH ?
       ORDER BY f.rank
       LIMIT ?`,
      [matchExpression, limit],
    )) as unknown as ProductRow[];

    const hits: SearchHit[] = [];
    for (const row of rows) {
      const food = await rowToFood(row);
      if (!food) continue;
      hits.push({
        food,
        // Sits above raw online results but below anything the user has eaten.
        // USDA rows are laboratory-measured, so they outrank crowd-sourced ones
        // when both describe the same thing.
        score: 30 + (food.quality ?? 0.6) * 20 + (row.src === SRC_OFF ? 0 : 6),
        tier: row.src === SRC_USDA_GENERIC ? 'core' : 'remote',
        suggestedGrams: food.portions.find((p) => p.preferred)?.grams ?? 100,
      });
    }
    return hits;
  } catch (error) {
    reportQueryFailure('search', error);
    markUnavailable(5);
    return [];
  }
}
