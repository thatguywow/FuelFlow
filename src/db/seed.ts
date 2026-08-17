import { db, tokenize, type Food, type Portion } from './schema';
import type { Nutrients } from '../core/nutrients';
import { isImperialUnitPortion, portionStatesItsMass } from '../core/foodName';
import { foodGrade } from '../core/grading';

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
/** Set once an install has been through the duplicate-collapsing pass. */
const DEDUPED_KEY = 'coreData.deduped';

/**
 * `[name, category, values[], portions[][], fdcId, origin?]`
 *
 * `origin` was added later, so it is optional: a dataset built before it
 * existed simply leaves provenance unset rather than failing to load.
 */
type PackedFood = [string, string, (number | null)[], [string, number][], number, string?];

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
/**
 * Shared in-flight install.
 *
 * Two overlapping calls — the mount effect and the Settings button, or a reload
 * part-way through the first run — each saw an empty table, each minted its own
 * random ids for the same USDA records, and each wrote them. The result was
 * every affected food stored twice and listed twice in search, permanently. The
 * version stamp cannot prevent it: neither run has written it yet.
 */
let inFlight: Promise<number> | null = null;

export function ensureCoreData(
  onProgress?: (progress: SeedProgress) => void,
  options: { force?: boolean } = {},
): Promise<number> {
  if (inFlight) return inFlight;
  inFlight = installCoreData(onProgress, options).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function installCoreData(
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

  const [current, deduped] = await Promise.all([db.kv.get(VERSION_KEY), db.kv.get(DEDUPED_KEY)]);
  // An install already on this version is still re-run once if it predates the
  // duplicate-collapsing pass — otherwise a device seeded twice keeps showing
  // every affected food twice and nothing would ever clear it.
  const needsRepair = deduped?.value !== true;
  if (!options.force && !needsRepair && current?.value === dataset.version) {
    report({ phase: 'done', loaded: dataset.foods.length, total: dataset.foods.length });
    return 0;
  }

  // Existing USDA rows are replaced wholesale, but their ids are reused so that
  // diary entries, favourites and frecency history stay attached to the food
  // they were logged against.
  //
  // Any USDA record already stored more than once is collapsed here: one id is
  // kept (the lowest, so the choice is stable across devices) and the rest are
  // deleted after the write. Installs seeded before the id scheme became
  // deterministic carry these duplicates and would otherwise keep showing every
  // affected food twice in search forever.
  const existing = await db.foods.where('source').equals('usda').toArray();
  const idByFdc = new Map<string, string>();
  const staleIds: string[] = [];
  for (const food of existing) {
    if (!food.sourceId) continue;
    const kept = idByFdc.get(food.sourceId);
    if (kept === undefined) {
      idByFdc.set(food.sourceId, food.id);
      continue;
    }
    const keep = kept < food.id ? kept : food.id;
    staleIds.push(kept < food.id ? food.id : kept);
    idByFdc.set(food.sourceId, keep);
  }

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

  // Drop the redundant copies only once their survivor has been rewritten, so
  // an interrupted install never leaves the food missing altogether.
  if (staleIds.length > 0) await db.foods.bulkDelete(staleIds);

  await db.kv.bulkPut([
    { key: VERSION_KEY, value: dataset.version, updatedAt: now },
    { key: COUNT_KEY, value: written, updatedAt: now },
    { key: 'coreData.source', value: dataset.source, updatedAt: now },
    { key: DEDUPED_KEY, value: true, updatedAt: now },
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
  const [name, category, values, portionPairs, fdcId, origin] = packed;
  if (!name) return null;

  const per100g: Nutrients = {};
  for (let i = 0; i < columns.length; i++) {
    const value = values[i];
    if (value === null || value === undefined) continue;
    const id = columns[i];
    // Clamped for the same reason the builder clamps: USDA's carbohydrate is
    // derived by difference and rounds slightly negative on low-carb foods.
    // Doing it here as well means the datasets already built are corrected on
    // the device rather than waiting for the pipeline to rerun.
    if (id !== undefined) per100g[id] = value < 0 ? 0 : value;
  }

  const portions: Portion[] = portionPairs
    .filter(([, grams]) => grams > 0)
    .map(([label, grams]) => ({ label, grams }));
  portions.push({ label: '100 g', grams: 100 });

  /*
   * Which portion opens by default: 100 g, unless 100 g makes no sense.
   *
   * Generic reference foods are weighed, not counted, and the whole dataset is
   * expressed per 100 g — so 100 g is both the honest default and the number a
   * metric user is already thinking in. USDA's own ordering is no help here: it
   * lists a bare unit conversion first on 3,080 of the 7,793 bundled foods, so
   * a beer opened on "1 fl oz" and chicken tenders on "oz".
   *
   * The exception is a food that cannot sensibly be weighed out at 100 g,
   * which in practice means one whose every portion is far smaller — a single
   * egg, a slice, a teaspoon of a spice. Weighing 100 g of nutmeg is not a
   * thing anybody does, so those open on the household measure instead.
   */
  const hundred = portions.find(
    (portion) => portion.grams === 100 && !isImperialUnitPortion(portion.label),
  );
  const household = portions.find(
    (portion) => !isImperialUnitPortion(portion.label) && !portionStatesItsMass(portion.label),
  );
  // "Far smaller" means every real serving the source lists is under a third of
  // 100 g. One of those and 100 g is a laboratory quantity, not a helping.
  const servings = portions.filter((portion) => !portionStatesItsMass(portion.label));
  const hundredIsAbsurd =
    servings.length > 0 && servings.every((portion) => portion.grams > 0 && portion.grams < 33);

  // 100 g stays in the chain after the household measure: sake lists only
  // "fl oz", so treating it as absurd-at-100 g and finding no household measure
  // used to fall all the way through to that bare unit.
  const preferred = (hundredIsAbsurd ? household : hundred) ?? hundred ?? household ?? portions[0];
  if (preferred) preferred.preferred = true;

  const sourceId = String(fdcId);
  return {
    // Derived from the USDA id rather than random, so a second run overwrites
    // the same row instead of inserting a rival copy of it. An existing id
    // still wins, so upgrading an install keeps its favourites and history.
    id: idByFdc.get(sourceId) ?? `usda-${sourceId}`,
    source: 'usda',
    sourceId,
    name,
    category: category || undefined,
    per100g,
    portions,
    tokens: tokenize(name, category),
    quality: 0.95,
    verified: true,
    grade: foodGrade(category || undefined),
    origin: origin === 'analysis' || origin === 'label' || origin === 'calculated' ? origin : undefined,
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
