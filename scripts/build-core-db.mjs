#!/usr/bin/env node
/**
 * Builds the bundled core food dataset.
 *
 * The core set is USDA generic foods — "chicken breast", "brown rice",
 * "banana" — with full micronutrient detail. It ships inside the app, seeds
 * IndexedDB on first launch and is what makes whole-food logging instant and
 * fully offline. Branded packaged products are not here; those live in the
 * remote snapshot built by `build-branded-db.mjs`.
 *
 * Two modes, and **bulk is the one that matters**:
 *
 *   --usda=<dir>  Parses the USDA bulk CSV export (Foundation + SR Legacy +
 *                 FNDDS) into ~15,000 foods with full micronutrient detail.
 *                 The bulk export needs **no API key** — it is a plain public
 *                 download — and `scripts/fetch-usda.mjs` fetches it. This is
 *                 what CI uses, and the same download also feeds the hosted
 *                 database, so one fetch serves both.
 *
 *   --mode=api    Pulls Foundation Foods through the FoodData Central API
 *                 instead. Only ~300 foods and the API *is* rate limited, so a
 *                 key helps here. Kept purely as a quick local option when you
 *                 do not want to download half a gigabyte; it is not needed for
 *                 a real build.
 *
 * Usage:
 *   node scripts/fetch-usda.mjs && node scripts/build-core-db.mjs --usda=data-build/usda
 *   node scripts/build-core-db.mjs --mode=api            # small, no download
 */

import { createReadStream } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';

// Nutrient ids kept in the bundle. Mirrors `src/core/nutrients.ts`; anything
// outside this list is dropped to keep the download small.
const KEEP = [
  208, 203, 204, 205, 291, 269, 539, 209, 221, 255,
  606, 645, 646, 605, 601, 851, 629, 621,
  301, 303, 304, 305, 306, 307, 309, 312, 315, 317,
  320, 401, 328, 323, 430, 404, 405, 406, 410, 415, 435, 418, 421,
  262,
  501, 502, 503, 504, 505, 506, 507, 508, 509, 510, 512,
];
const KEEP_SET = new Set(KEEP);

/**
 * Several nutrients are published under more than one number and FuelFlow wants
 * exactly one of them. Each alias maps an upstream number to the canonical id
 * plus a preference rank — lower wins, so a food carrying both forms keeps the
 * better one regardless of the order the API happens to return them in.
 *
 *  - Energy: newer Foundation records report "Energy (Atwater General Factors)"
 *    as 957 and "(Atwater Specific Factors)" as 958 rather than the classic 208.
 *    Missing this silently discards most of the Foundation dataset.
 *  - Folate: DFE (435) is what the DRI is written against; total folate (417) is
 *    the fallback.
 */
const ALIASES = new Map([
  [208, { id: 208, rank: 0 }],
  [958, { id: 208, rank: 1 }], // Atwater specific factors — food-specific, better
  [957, { id: 208, rank: 2 }], // Atwater general factors
  [268, { id: 208, rank: 3, kjToKcal: true }],
  [435, { id: 435, rank: 0 }],
  [417, { id: 435, rank: 1 }],
]);

/**
 * USDA's derivation codes, collapsed to the vocabulary the OpenNutriTracker
 * backend uses. The first letter carries the meaning: A = analytical, M and L
 * = taken from a label, everything else is calculated or imputed.
 */
function originFromDerivation(code) {
  if (!code) return undefined;
  const initial = code.trim().charAt(0).toUpperCase();
  if (initial === 'A') return 'analysis';
  if (initial === 'M' || initial === 'L') return 'label';
  return 'calculated';
}

/** Resolve one upstream nutrient reading into the canonical vector. */
function assign(nutrients, ranks, rawNumber, amount) {
  const alias = ALIASES.get(rawNumber);
  const id = alias?.id ?? rawNumber;
  if (!KEEP_SET.has(id)) return;

  const rank = alias?.rank ?? 0;
  if (ranks[id] !== undefined && ranks[id] <= rank) return;

  nutrients[id] = alias?.kjToKcal ? amount / 4.184 : amount;
  ranks[id] = rank;
}

const argv = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    return [key, value];
  }),
);

// Pointing at an extracted export is an unambiguous request for a bulk build,
// so the mode does not have to be spelled out as well.
const MODE = argv.mode ?? (argv.usda || argv.input ? 'bulk' : 'api');
const OUT_DIR = path.resolve('public/data');
const OUT_FILE = path.join(OUT_DIR, 'core-foods.json');

/**
 * Three significant figures is well past the precision of the source data.
 *
 * Negatives are clamped to zero. USDA derives carbohydrate by difference —
 * 100 minus water, protein, fat and ash — so a very low-carb food can round to
 * a small negative: the shipping dataset carries ten of them, chicken breast
 * at -0.428 g among others. Harmless in magnitude, nonsense on screen, and
 * they quietly subtract from a day's carbohydrate total.
 */
function round(value) {
  if (!Number.isFinite(value) || value === 0) return 0;
  if (value < 0) return 0;
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const factor = Math.pow(10, 2 - magnitude);
  return Math.round(value * factor) / factor;
}

/**
 * USDA descriptions read like database keys: "Chicken, broiler or fryers,
 * breast, skinless, boneless, meat only, cooked, braised". The leading term is
 * the food; the rest is qualifiers. Reordering the first clause to the front in
 * natural word order makes search and the results list dramatically more
 * readable without losing the detail.
 */
function tidyName(description) {
  const parts = description.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return description.trim();
  const head = parts[0];
  const tail = parts.slice(1).join(', ');
  return `${head}, ${tail}`.replace(/\s+/g, ' ').trim();
}

function assemble(foods, meta) {
  // Column-oriented: one shared nutrient-id header, then a positional array per
  // food. Removes ~50 repeated keys per record, which is most of the file size.
  const columns = KEEP.filter((id) => foods.some((f) => f.nutrients[id] !== undefined));
  return {
    version: new Date().toISOString().slice(0, 10),
    builtAt: new Date().toISOString(),
    source: meta.source,
    license: 'USDA FoodData Central — public domain (17 USC 105)',
    count: foods.length,
    columns,
    foods: foods.map((food) => [
      food.name,
      food.category ?? '',
      columns.map((id) => {
        const value = food.nutrients[id];
        return value === undefined ? null : round(value);
      }),
      food.portions.map((p) => [p.label, round(p.grams)]),
      food.fdcId,
      // How the energy figure was arrived at. USDA records this per value and
      // we were discarding it: a number measured in a laboratory deserves more
      // trust than one calculated from a recipe, and saying which is which is
      // more honest than presenting both as equally solid.
      food.origin ?? '',
    ]),
  };
}

// ---------------------------------------------------------------------------
// API mode
// ---------------------------------------------------------------------------

async function buildFromApi() {
  const key = argv.key ?? process.env.FDC_API_KEY ?? 'DEMO_KEY';
  if (key === 'DEMO_KEY') {
    console.warn(
      'API mode on the shared DEMO_KEY: 30 requests/hour, so expect the Foundation\n' +
        'subset only. For the full ~15,000-food set with no key and no rate limit:\n' +
        '  node scripts/fetch-usda.mjs\n' +
        '  node scripts/build-core-db.mjs --usda=data-build/usda\n',
    );
  }

  const dataTypes = (argv.types ?? 'Foundation').split(',');
  const pageSize = 200;
  const foods = [];

  for (const dataType of dataTypes) {
    for (let page = 1; ; page++) {
      const url = new URL('https://api.nal.usda.gov/fdc/v1/foods/search');
      url.searchParams.set('api_key', key);
      url.searchParams.set('dataType', dataType);
      url.searchParams.set('pageSize', String(pageSize));
      url.searchParams.set('pageNumber', String(page));
      url.searchParams.set('query', '*');

      process.stdout.write(`  ${dataType} page ${page}… `);
      const response = await fetch(url);
      if (response.status === 429) {
        console.error('\nRate limited by FoodData Central. Wait an hour or supply --key=…');
        process.exit(1);
      }
      if (!response.ok) throw new Error(`FDC returned ${response.status} ${response.statusText}`);

      const data = await response.json();
      const batch = data.foods ?? [];
      console.log(`${batch.length} foods`);
      if (batch.length === 0) break;

      for (const item of batch) {
        const nutrients = {};
        const ranks = {};
        for (const entry of item.foodNutrients ?? []) {
          const raw = Number(entry.nutrientNumber ?? entry.nutrientId);
          const amount = Number(entry.value ?? entry.amount);
          if (!Number.isFinite(raw) || !Number.isFinite(amount)) continue;
          assign(nutrients, ranks, raw, amount);
        }
        if (nutrients[208] === undefined) continue;

        foods.push({
          fdcId: item.fdcId,
          name: tidyName(item.description ?? ''),
          category: item.foodCategory ?? '',
          nutrients,
          portions: (item.foodMeasures ?? [])
            .filter((m) => Number(m.gramWeight) > 0)
            .slice(0, 6)
            .map((m) => ({
              label: `${m.disseminationText ?? m.measureUnitName ?? 'serving'}`.trim(),
              grams: Number(m.gramWeight),
            })),
        });
      }
      if (batch.length < pageSize) break;
      if (data.totalPages && page >= data.totalPages) break;
    }
  }
  return assemble(foods, { source: `FoodData Central API (${dataTypes.join(', ')})` });
}

// ---------------------------------------------------------------------------
// Bulk CSV mode
// ---------------------------------------------------------------------------

/** Minimal RFC 4180 splitter — the FDC exports quote fields containing commas. */
function splitCsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      out.push(field);
      field = '';
    } else field += char;
  }
  out.push(field);
  return out;
}

async function* readCsv(file) {
  const stream = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let header = null;
  for await (const line of stream) {
    if (!line) continue;
    const cells = splitCsvLine(line);
    if (!header) {
      header = cells.map((c) => c.trim().replace(/^"|"$/g, ''));
      continue;
    }
    const row = {};
    header.forEach((name, i) => (row[name] = cells[i]));
    yield row;
  }
}

async function findCsv(dir, name) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name === name) {
      return path.join(entry.parentPath ?? entry.path ?? dir, entry.name);
    }
  }
  throw new Error(
    `Could not find ${name} under ${dir}.\n` +
      'Fetch the USDA export first — no API key needed:\n' +
      '  node scripts/fetch-usda.mjs',
  );
}

async function buildFromBulk() {
  const input = path.resolve(argv.usda ?? argv.input ?? 'data-build/usda');
  const allowed = new Set(
    (argv.datatypes ?? 'foundation_food,sr_legacy_food,survey_fndds_food').split(','),
  );

  // Pass 1: which foods do we want, and what are they called.
  console.log('Reading food.csv…');
  const foods = new Map();
  for await (const row of readCsv(await findCsv(input, 'food.csv'))) {
    if (!allowed.has(row.data_type)) continue;
    foods.set(row.fdc_id, {
      fdcId: Number(row.fdc_id),
      name: tidyName(row.description ?? ''),
      category: row.food_category_id ?? '',
      nutrients: {},
      ranks: {},
      portions: [],
      dataType: row.data_type,
    });
  }
  console.log(`  ${foods.size.toLocaleString()} foods selected`);

  // food_nutrient.csv references nutrients by FDC's internal surrogate id
  // (energy is 1008), not by the 208-style nutrient number this script speaks.
  // nutrient.csv carries both, so build the translation first.
  console.log('Reading nutrient.csv…');
  const numberByInternalId = new Map();
  for await (const row of readCsv(await findCsv(input, 'nutrient.csv'))) {
    const number = Number(row.nutrient_nbr);
    if (Number.isFinite(number)) numberByInternalId.set(row.id, number);
  }
  console.log(`  ${numberByInternalId.size} nutrient definitions`);

  // How each value was arrived at. USDA keys this per nutrient row; we keep it
  // for the energy figure, which is the number the whole app is built on.
  const derivationCode = new Map();
  try {
    for await (const row of readCsv(await findCsv(input, 'food_nutrient_derivation.csv'))) {
      if (row.id && row.code) derivationCode.set(row.id, row.code);
    }
    console.log(`  ${derivationCode.size} derivation codes`);
  } catch {
    console.warn('  food_nutrient_derivation.csv missing — provenance will be unset.');
  }

  // Pass 2: nutrient values. This is the large file — stream it.
  console.log('Reading food_nutrient.csv (this is the big one)…');
  let rows = 0;
  for await (const row of readCsv(await findCsv(input, 'food_nutrient.csv'))) {
    if (++rows % 2_000_000 === 0) process.stdout.write(`  ${rows / 1e6}M rows…\n`);
    const food = foods.get(row.fdc_id);
    if (!food) continue;
    const raw = numberByInternalId.get(row.nutrient_id) ?? Number(row.nutrient_id);
    const amount = Number(row.amount);
    if (!Number.isFinite(raw) || !Number.isFinite(amount)) continue;
    const before = food.ranks[208];
    assign(food.nutrients, food.ranks, raw, amount);
    // Only when this row actually became the food's energy value, so a
    // rejected lower-priority reading cannot relabel a better one.
    if (food.ranks[208] !== before) {
      food.origin = originFromDerivation(derivationCode.get(row.derivation_id));
    }
  }

  // Pass 3: household portions.
  console.log('Reading food_portion.csv…');
  const units = new Map();
  try {
    for await (const row of readCsv(await findCsv(input, 'measure_unit.csv'))) {
      units.set(row.id, row.name);
    }
  } catch {
    console.warn('  measure_unit.csv missing — portion labels will be less descriptive.');
  }

  /**
   * A portion whose whole name is a unit of measure.
   *
   * USDA lists one of these first on about 40% of foods — "oz", "fl oz" — and
   * they are not servings, they are the same weight expressed differently.
   * Taking the file order as given meant a beer defaulting to one fluid ounce
   * with "can or bottle (12 fl oz)" sitting behind it, and chicken tenders to
   * an ounce ahead of "piece". Kept in the list, ranked last.
   */
  const isBareUnit = (label) => /^[\d.,]*\s*(oz|fl\.?\s*oz|lb|g|ml|kg|l|cup|tbsp|tsp)$/i.test(label.trim());

  for await (const row of readCsv(await findCsv(input, 'food_portion.csv'))) {
    const food = foods.get(row.fdc_id);
    if (!food) continue;
    const grams = Number(row.gram_weight);
    if (!Number.isFinite(grams) || grams <= 0) continue;
    const amount = Number(row.amount) || 1;
    const unit = units.get(row.measure_unit_id);
    const description = row.portion_description || row.modifier || '';
    const label =
      unit && unit !== 'undetermined'
        ? `${amount} ${unit}${description ? ` (${description})` : ''}`
        : description || `${amount} serving`;
    // `seq_num` is USDA's own display order. It was being ignored, so the cap
    // below could also throw away the good measures and keep the dull ones.
    food.portions.push({
      label: label.trim().slice(0, 60),
      grams,
      seq: Number(row.seq_num) || Number.MAX_SAFE_INTEGER,
    });
  }

  // Named household measures first, then USDA's order within each group, and
  // only then trim. The first entry becomes the app's default portion.
  for (const food of foods.values()) {
    food.portions.sort((a, b) => {
      const bare = Number(isBareUnit(a.label)) - Number(isBareUnit(b.label));
      return bare !== 0 ? bare : a.seq - b.seq;
    });
    food.portions = food.portions.slice(0, 6).map(({ label, grams }) => ({ label, grams }));
  }

  const usable = [...foods.values()].filter((f) => f.nutrients[208] !== undefined);
  console.log(`  ${usable.length.toLocaleString()} foods have energy data`);

  // Foundation data is analytically measured and beats SR Legacy where both
  // describe the same food, so it sorts first and wins search ties.
  const rank = { foundation_food: 0, sr_legacy_food: 1, survey_fndds_food: 2 };
  usable.sort((a, b) => (rank[a.dataType] ?? 9) - (rank[b.dataType] ?? 9) || a.name.localeCompare(b.name));

  return assemble(usable, { source: `FoodData Central bulk export (${[...allowed].join(', ')})` });
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`Building core food dataset (mode: ${MODE})\n`);
  const dataset = MODE === 'bulk' ? await buildFromBulk() : await buildFromApi();

  if (dataset.foods.length === 0) {
    console.error('No foods produced — refusing to write an empty dataset.');
    process.exit(1);
  }

  await mkdir(OUT_DIR, { recursive: true });
  const json = JSON.stringify(dataset);
  await writeFile(OUT_FILE, json);

  const mb = (Buffer.byteLength(json) / 1024 / 1024).toFixed(2);
  console.log(`\nWrote ${OUT_FILE}`);
  console.log(`  ${dataset.foods.length.toLocaleString()} foods, ${dataset.columns.length} nutrient columns, ${mb} MB raw`);
  console.log('  Static hosts gzip this automatically; expect roughly a fifth of that over the wire.');
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
