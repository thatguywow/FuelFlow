import { db, newId, tokenize, type Food, type Portion } from './schema';
import type { Nutrients } from '../core/nutrients';

/**
 * First-run seeding of the bundled core food dataset.
 *
 * The file is column-oriented — one shared nutrient-id header plus a positional
 * array per food — which removes about fifty repeated JSON keys from every
 * record. Hydration happens once, in chunks, so the UI stays responsive, and
 * the version stamp means a newer dataset shipped with an app update replaces
 * the old rows without touching anything the user created.
 */

const VERSION_KEY = 'coreData.version';
const COUNT_KEY = 'coreData.count';

/** `[name, category, values[], portions[][], fdcId]` */
type PackedFood = [string, string, (number | null)[], [string, number][], number];

interface CoreDataset {
  version: string;
  builtAt: string;
  source: string;
  license: string;
  count: number;
  columns: number[];
  foods: PackedFood[];
}

export interface SeedProgress {
  phase: 'idle' | 'downloading' | 'installing' | 'done' | 'unavailable' | 'error';
  loaded: number;
  total: number;
  message?: string;
}

export interface CoreDataStatus {
  installed: boolean;
  version?: string;
  count?: number;
}

export async function coreDataStatus(): Promise<CoreDataStatus> {
  const [version, count] = await Promise.all([db.kv.get(VERSION_KEY), db.kv.get(COUNT_KEY)]);
  return {
    installed: typeof version?.value === 'string',
    version: version?.value as string | undefined,
    count: count?.value as number | undefined,
  };
}

function datasetUrl(): string {
  return `${import.meta.env.BASE_URL}data/core-foods.json`;
}

/**
 * Install (or refresh) the core dataset.
 *
 * Returns the number of foods written. A missing dataset file is a normal
 * state, not an error: the app runs fine on the personal, remote and online
 * tiers alone, and Settings offers to install the core data later.
 */
export async function ensureCoreData(
  onProgress?: (progress: SeedProgress) => void,
  options: { force?: boolean } = {},
): Promise<number> {
  const report = (progress: SeedProgress) => onProgress?.(progress);

  let dataset: CoreDataset;
  try {
    report({ phase: 'downloading', loaded: 0, total: 0 });
    const response = await fetch(datasetUrl());

    // A single-page app served from a static host answers *every* unknown path
    // with index.html and a 200, so `response.ok` alone proves nothing. Check
    // that what came back is actually the dataset before trusting it — the
    // alternative is a confusing JSON parse error on every deployment that has
    // not built the core data yet.
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok || !contentType.includes('json')) {
      report({
        phase: 'unavailable',
        loaded: 0,
        total: 0,
        message: 'Core food data has not been built for this deployment yet.',
      });
      return 0;
    }

    dataset = (await response.json()) as CoreDataset;
    if (!Array.isArray(dataset?.foods) || !Array.isArray(dataset?.columns)) {
      report({ phase: 'error', loaded: 0, total: 0, message: 'Core food data is malformed.' });
      return 0;
    }
  } catch (error) {
    report({
      phase: 'unavailable',
      loaded: 0,
      total: 0,
      message: error instanceof Error ? error.message : 'Could not download core food data.',
    });
    return 0;
  }

  const current = await db.kv.get(VERSION_KEY);
  if (!options.force && current?.value === dataset.version) {
    report({ phase: 'done', loaded: dataset.foods.length, total: dataset.foods.length });
    return 0;
  }

  // Existing USDA rows are replaced wholesale, but their ids are reused so that
  // diary entries, favourites and frecency history stay attached to the food
  // they were logged against.
  const existing = await db.foods.where('source').equals('usda').toArray();
  const idByFdc = new Map<string, string>();
  for (const food of existing) if (food.sourceId) idByFdc.set(food.sourceId, food.id);

  const total = dataset.foods.length;
  const now = Date.now();
  const CHUNK = 500;
  let written = 0;

  for (let start = 0; start < total; start += CHUNK) {
    const batch: Food[] = [];
    for (const packed of dataset.foods.slice(start, start + CHUNK)) {
      const food = unpack(packed, dataset.columns, idByFdc, now);
      if (food) batch.push(food);
    }
    await db.foods.bulkPut(batch);
    written += batch.length;
    report({ phase: 'installing', loaded: written, total });
    // Yield to the event loop so first-run seeding does not freeze the UI.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  await db.kv.bulkPut([
    { key: VERSION_KEY, value: dataset.version, updatedAt: now },
    { key: COUNT_KEY, value: written, updatedAt: now },
    { key: 'coreData.source', value: dataset.source, updatedAt: now },
  ]);

  report({ phase: 'done', loaded: written, total });
  return written;
}

function unpack(
  packed: PackedFood,
  columns: number[],
  idByFdc: Map<string, string>,
  now: number,
): Food | null {
  const [name, category, values, portionPairs, fdcId] = packed;
  if (!name) return null;

  const per100g: Nutrients = {};
  for (let i = 0; i < columns.length; i++) {
    const value = values[i];
    if (value === null || value === undefined) continue;
    const id = columns[i];
    if (id !== undefined) per100g[id] = value;
  }

  const portions: Portion[] = portionPairs
    .filter(([, grams]) => grams > 0)
    .map(([label, grams]) => ({ label, grams }));
  // Generic foods are most often weighed, so 100 g stays the default unless the
  // source supplied a genuine household measure.
  portions.push({ label: '100 g', grams: 100, preferred: portions.length === 0 });
  if (portions.length > 1 && portions[0]) portions[0].preferred = true;

  const sourceId = String(fdcId);
  return {
    id: idByFdc.get(sourceId) ?? newId(),
    source: 'usda',
    sourceId,
    name,
    category: category || undefined,
    per100g,
    portions,
    tokens: tokenize(name, category),
    quality: 0.95,
    verified: true,
    createdAt: now,
    updatedAt: now,
  };
}

/** Remove the core dataset, e.g. to reclaim space on a small device. */
export async function removeCoreData(): Promise<number> {
  const count = await db.foods.where('source').equals('usda').delete();
  await db.kv.bulkDelete([VERSION_KEY, COUNT_KEY, 'coreData.source']);
  return count;
}
