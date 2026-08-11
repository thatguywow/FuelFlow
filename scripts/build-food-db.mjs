#!/usr/bin/env node
/**
 * Builds the hosted food database — Open Food Facts *and* USDA in one file.
 *
 * This is the piece that makes "every food database, no server" work. Both
 * sources are distilled into one compact SQLite file with an FTS5 index, then
 * split into sub-100 MB chunks that GitHub Pages serves as ordinary static
 * files. At runtime the app runs SQLite in a WebWorker and reads that file over
 * HTTP range requests, pulling only the B-tree pages a query touches.
 *
 * The consequence worth understanding: **database size barely affects the
 * user.** A lookup costs the same few kilobytes whether the file holds 200,000
 * products or 4,000,000, because range requests never download the rest. So
 * there is no reason to filter by country — the default is global, which is
 * what makes coverage outside the US genuinely good.
 *
 * Three structural choices keep it cheap:
 *
 *   - `id INTEGER PRIMARY KEY` makes the id the table's rowid, so rows are
 *     physically ordered by it and a barcode lookup is a direct B-tree descent
 *     — about three page reads. Barcoded products use the barcode as the id;
 *     USDA generic foods (which have none) use the negative of their FDC id, so
 *     one clustered table serves both without a second index.
 *   - `page_size = 1024` matches the client's request chunk size, so no read
 *     straddles a chunk boundary and pulls an extra range request.
 *   - FTS5 `optimize` merges the index into one b-tree, roughly halving the
 *     requests a text search costs.
 *
 * Uses Node's built-in `node:sqlite` (Node 22+), so there are no dependencies.
 *
 * Usage:
 *   node scripts/build-food-db.mjs                          # Open Food Facts, global
 *   node scripts/build-food-db.mjs --usda=./data-build/usda # + USDA branded & generic
 *   node scripts/build-food-db.mjs --countries=germany,france
 *   node scripts/build-food-db.mjs --skip-off --usda=./usda
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import path from 'node:path';

const argv = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    return [key, value];
  }),
);

const OFF_CSV_URL = 'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz';
const OUT_DIR = path.resolve(argv.out ?? 'public/fooddb');
const WORK_DIR = path.resolve(argv.work ?? 'data-build');
const DB_NAME = 'food.sqlite3';

/** Client page size and request chunk size. Must stay in step with remote.ts. */
const PAGE_SIZE = 1024;
/** Each published chunk. Comfortably under GitHub's 100 MB per-file ceiling. */
const SERVER_CHUNK_SIZE = 40 * 1024 * 1024;
const SUFFIX_LENGTH = 3;

/** Provenance, stored per row so the app can rank and label results. */
const SRC = { OFF: 0, USDA_BRANDED: 1, USDA_GENERIC: 2 };

const countries = argv.countries
  ? new Set(argv.countries.split(',').map((c) => c.trim().toLowerCase()))
  : null;
const MAX_PRODUCTS = argv.limit ? Number(argv.limit) : Infinity;

function number(value) {
  if (value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Grams from a free-text quantity like "500 g", "1.5 L", "12 oz". */
function parseQuantity(text) {
  if (!text) return null;
  const match = /([\d.,]+)\s*(kg|g|l|ml|cl|oz|lb)/i.exec(text);
  if (!match?.[1] || !match[2]) return null;
  const amount = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(amount)) return null;
  switch (match[2].toLowerCase()) {
    case 'kg': return amount * 1000;
    case 'g': return amount;
    case 'l': return amount * 1000;
    case 'cl': return amount * 10;
    case 'ml': return amount;
    case 'oz': return amount * 28.3495;
    case 'lb': return amount * 453.592;
    default: return null;
  }
}

/**
 * Shared plausibility gate. A product with no energy figure cannot be logged,
 * absurd values are data-entry errors (pure fat is 900 kcal/100 g and nothing
 * exceeds it), and a single macro on its own is almost always a partial entry.
 */
function usable(row) {
  if (row.kcal === null || row.kcal < 0 || row.kcal > 900) return false;
  const macros = [row.protein, row.carbs, row.fat].filter((v) => v !== null).length;
  return macros >= 2;
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

/** Minimal RFC 4180 splitter — the USDA exports quote fields containing commas. */
function splitCsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { out.push(field); field = ''; }
    else field += char;
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
      'Download and unzip the CSV exports from https://fdc.nal.usda.gov/download-datasets there first.',
  );
}

// ---------------------------------------------------------------------------
// Source: Open Food Facts
// ---------------------------------------------------------------------------

/** Open Food Facts CSV column → our column, with the unit conversion applied. */
const OFF_FIELDS = {
  kcal: { column: 'energy-kcal_100g', scale: 1 },
  protein: { column: 'proteins_100g', scale: 1 },
  carbs: { column: 'carbohydrates_100g', scale: 1 },
  fat: { column: 'fat_100g', scale: 1 },
  fiber: { column: 'fiber_100g', scale: 1 },
  sugar: { column: 'sugars_100g', scale: 1 },
  satfat: { column: 'saturated-fat_100g', scale: 1 },
  // Open Food Facts stores every `_100g` figure in grams, including minerals.
  sodium: { column: 'sodium_100g', scale: 1000 },
  cholesterol: { column: 'cholesterol_100g', scale: 1000 },
  potassium: { column: 'potassium_100g', scale: 1000 },
  calcium: { column: 'calcium_100g', scale: 1000 },
  iron: { column: 'iron_100g', scale: 1000 },
};

async function offStream() {
  if (argv.off && argv.off !== 'true') {
    console.log(`Reading ${argv.off}`);
    const stream = createReadStream(path.resolve(argv.off));
    return argv.off.endsWith('.gz') ? stream.pipe(createGunzip()) : stream;
  }

  const cached = path.join(WORK_DIR, 'off-products.csv.gz');
  const exists = await stat(cached).then(() => true).catch(() => false);

  if (!exists) {
    await mkdir(WORK_DIR, { recursive: true });
    console.log(`Downloading ${OFF_CSV_URL}`);
    console.log('  Roughly a gigabyte; cached in data-build/ for reruns.');
    const response = await fetch(OFF_CSV_URL);
    if (!response.ok || !response.body) {
      throw new Error(`Open Food Facts returned ${response.status} ${response.statusText}`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(cached));
  } else {
    console.log(`Using cached ${cached}`);
  }
  return createReadStream(cached).pipe(createGunzip());
}

async function* ingestOff() {
  const stream = await offStream();
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  let index = null;
  let read = 0;

  for await (const line of lines) {
    if (!index) {
      // The export is tab-separated despite the .csv name.
      const header = line.split('\t');
      index = Object.fromEntries(header.map((name, i) => [name, i]));
      const required = ['code', 'product_name', 'energy-kcal_100g'];
      const missing = required.filter((name) => index[name] === undefined);
      if (missing.length > 0) {
        throw new Error(`Open Food Facts export is missing expected columns: ${missing.join(', ')}`);
      }
      continue;
    }

    if (++read % 500_000 === 0) console.log(`  Open Food Facts: read ${(read / 1000).toFixed(0)}k rows`);

    const cells = line.split('\t');
    const get = (name) => {
      const at = index[name];
      return at === undefined ? undefined : cells[at];
    };

    const digits = (get('code') ?? '').replace(/\D/g, '');
    if (digits.length < 6 || digits.length > 14) continue;
    // Leading zeros are dropped so the barcode fits the integer rowid; the
    // client normalises the same way before querying.
    const id = Number(digits);
    if (!Number.isSafeInteger(id) || id <= 0) continue;

    const name = (get('product_name') ?? '').trim();
    if (name.length < 2 || name.length > 150) continue;

    if (countries) {
      const tags = (get('countries_en') ?? '').toLowerCase();
      if (!tags) continue;
      let match = false;
      for (const country of countries) if (tags.includes(country)) { match = true; break; }
      if (!match) continue;
    }

    const row = { id, name, src: SRC.OFF };
    for (const [key, spec] of Object.entries(OFF_FIELDS)) {
      const raw = number(get(spec.column));
      row[key] = raw === null ? null : raw * spec.scale;
    }
    // Salt is the European convention; 1 g of salt is about 400 mg of sodium.
    if (row.sodium === null) {
      const salt = number(get('salt_100g'));
      if (salt !== null) row.sodium = salt * 400;
    }
    if (!usable(row)) continue;

    row.brand = (get('brands') ?? '').split(',')[0]?.trim() || null;
    row.category = (get('categories_en') ?? '').split(',')[0]?.trim() || null;
    const servingG = number(get('serving_quantity')) ?? parseQuantity(get('serving_size'));
    const packageG = parseQuantity(get('quantity'));
    row.serving_g = servingG && servingG > 0 && servingG < 5000 ? servingG : null;
    row.package_g = packageG && packageG > 0 && packageG < 50_000 ? packageG : null;
    row.quality = number(get('completeness')) ?? 0.5;

    yield row;
  }
}

// ---------------------------------------------------------------------------
// Source: USDA FoodData Central
// ---------------------------------------------------------------------------

/** USDA nutrient numbers → our columns, with the conversion to our units. */
const USDA_NUTRIENTS = {
  208: ['kcal', 1], 957: ['kcal', 1], 958: ['kcal', 1],
  203: ['protein', 1],
  205: ['carbs', 1],
  204: ['fat', 1],
  291: ['fiber', 1],
  269: ['sugar', 1],
  606: ['satfat', 1],
  307: ['sodium', 1],
  601: ['cholesterol', 1],
  306: ['potassium', 1],
  301: ['calcium', 1],
  303: ['iron', 1],
};
/** Energy preference: 208 beats Atwater-specific beats Atwater-general. */
const ENERGY_RANK = { 208: 0, 958: 1, 957: 2 };

async function* ingestUsda(dir) {
  const input = path.resolve(dir);
  console.log(`\nUSDA: reading from ${input}`);

  // food_nutrient.csv references nutrients by FDC's internal surrogate id
  // (energy is 1008), not by the 208-style number this script speaks.
  const numberByInternalId = new Map();
  for await (const row of readCsv(await findCsv(input, 'nutrient.csv'))) {
    const nbr = Number(row.nutrient_nbr);
    if (Number.isFinite(nbr)) numberByInternalId.set(row.id, nbr);
  }
  console.log(`  ${numberByInternalId.size} nutrient definitions`);

  const wantedTypes = new Set(
    (argv.usdatypes ?? 'branded_food,foundation_food,sr_legacy_food,survey_fndds_food').split(','),
  );

  const foods = new Map();
  for await (const row of readCsv(await findCsv(input, 'food.csv'))) {
    if (!wantedTypes.has(row.data_type)) continue;
    const name = (row.description ?? '').trim();
    if (name.length < 2) continue;
    foods.set(row.fdc_id, {
      fdcId: Number(row.fdc_id),
      name: name.slice(0, 150),
      dataType: row.data_type,
      nutrients: {},
      ranks: {},
    });
  }
  console.log(`  ${foods.size.toLocaleString()} foods selected`);

  // Branded metadata: barcode, brand owner, serving size.
  let brandedCount = 0;
  try {
    for await (const row of readCsv(await findCsv(input, 'branded_food.csv'))) {
      const food = foods.get(row.fdc_id);
      if (!food) continue;
      const digits = (row.gtin_upc ?? '').replace(/\D/g, '');
      if (digits.length >= 6 && digits.length <= 14) {
        const id = Number(digits);
        if (Number.isSafeInteger(id) && id > 0) { food.gtin = id; brandedCount++; }
      }
      food.brand = (row.brand_owner || row.brand_name || '').trim() || null;
      food.category = (row.branded_food_category || '').trim() || null;
      const serving = number(row.serving_size);
      const unit = (row.serving_size_unit ?? '').toLowerCase();
      if (serving && (unit === 'g' || unit === 'ml')) food.serving_g = serving;
      const pkg = parseQuantity(row.package_weight);
      if (pkg) food.package_g = pkg;
    }
    console.log(`  ${brandedCount.toLocaleString()} branded foods carry a barcode`);
  } catch {
    console.warn('  branded_food.csv missing — generic foods only.');
  }

  console.log('  Reading food_nutrient.csv (this is the big one)…');
  let rows = 0;
  for await (const row of readCsv(await findCsv(input, 'food_nutrient.csv'))) {
    if (++rows % 5_000_000 === 0) console.log(`    ${(rows / 1e6).toFixed(0)}M rows…`);
    const food = foods.get(row.fdc_id);
    if (!food) continue;
    const nbr = numberByInternalId.get(row.nutrient_id) ?? Number(row.nutrient_id);
    const mapping = USDA_NUTRIENTS[nbr];
    if (!mapping) continue;
    const amount = Number(row.amount);
    if (!Number.isFinite(amount)) continue;

    const [key, scale] = mapping;
    // Only energy has competing sources; everything else is first-write-wins.
    const rank = ENERGY_RANK[nbr] ?? 0;
    if (food.ranks[key] !== undefined && food.ranks[key] <= rank) continue;
    food.nutrients[key] = amount * scale;
    food.ranks[key] = rank;
  }

  for (const food of foods.values()) {
    const row = { ...food.nutrients, name: food.name };
    for (const key of ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'satfat', 'sodium', 'cholesterol', 'potassium', 'calcium', 'iron']) {
      if (row[key] === undefined) row[key] = null;
    }
    if (!usable(row)) continue;

    const branded = food.gtin !== undefined;
    yield {
      ...row,
      // Barcoded rows key on the barcode; generic foods key on the negative of
      // their FDC id, so one clustered table serves both with no extra index.
      id: branded ? food.gtin : -food.fdcId,
      brand: food.brand ?? null,
      category: food.category ?? null,
      serving_g: food.serving_g ?? null,
      package_g: food.package_g ?? null,
      src: branded ? SRC.USDA_BRANDED : SRC.USDA_GENERIC,
      // USDA data is laboratory-measured, so it outranks crowd-sourced entries
      // when the same barcode appears in both.
      quality: food.dataType === 'branded_food' ? 0.8 : 0.98,
    };
  }
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

async function build() {
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(WORK_DIR, { recursive: true });
  const dbPath = path.join(WORK_DIR, DB_NAME);
  await rm(dbPath, { force: true });

  const db = new DatabaseSync(dbPath);
  // page_size only takes effect on an empty database, so it is set first.
  db.exec(`PRAGMA page_size = ${PAGE_SIZE}`);
  db.exec('PRAGMA journal_mode = OFF');
  db.exec('PRAGMA synchronous = OFF');
  db.exec(`
    CREATE TABLE products (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      brand       TEXT,
      category    TEXT,
      serving_g   REAL,
      package_g   REAL,
      kcal        REAL,
      protein     REAL,
      carbs       REAL,
      fat         REAL,
      fiber       REAL,
      sugar       REAL,
      satfat      REAL,
      sodium      REAL,
      cholesterol REAL,
      potassium   REAL,
      calcium     REAL,
      iron        REAL,
      quality     REAL,
      src         INTEGER
    );
  `);

  const insert = db.prepare(`
    INSERT INTO products
      (id, name, brand, category, serving_g, package_g, kcal, protein, carbs, fat,
       fiber, sugar, satfat, sodium, cholesterol, potassium, calcium, iron, quality, src)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // When the same barcode arrives from two sources, the better-quality record
  // wins rather than whichever happened to be ingested last.
  const existing = db.prepare('SELECT quality FROM products WHERE id = ?');
  const replace = db.prepare('DELETE FROM products WHERE id = ?');

  const counts = { off: 0, usdaBranded: 0, usdaGeneric: 0, replaced: 0, skipped: 0 };
  let total = 0;

  const write = (row) => {
    if (total >= MAX_PRODUCTS) return false;
    const prior = existing.get(row.id);
    if (prior) {
      if ((prior.quality ?? 0) >= (row.quality ?? 0)) { counts.skipped++; return true; }
      replace.run(row.id);
      counts.replaced++;
      total--;
    }
    insert.run(
      row.id, row.name, row.brand ?? null, row.category ?? null,
      row.serving_g ?? null, row.package_g ?? null,
      row.kcal, row.protein, row.carbs, row.fat, row.fiber, row.sugar, row.satfat,
      row.sodium, row.cholesterol, row.potassium, row.calcium, row.iron,
      row.quality ?? 0.5, row.src,
    );
    total++;
    if (row.src === SRC.OFF) counts.off++;
    else if (row.src === SRC.USDA_BRANDED) counts.usdaBranded++;
    else counts.usdaGeneric++;
    return true;
  };

  db.exec('BEGIN');

  // USDA runs first so its laboratory-measured records are already in place;
  // an Open Food Facts row for the same barcode then loses on quality.
  if (argv.usda && argv.usda !== 'true') {
    for await (const row of ingestUsda(argv.usda)) if (!write(row)) break;
    console.log(`  USDA: ${counts.usdaBranded.toLocaleString()} branded, ${counts.usdaGeneric.toLocaleString()} generic`);
  }

  if (!argv['skip-off']) {
    console.log(`\nOpen Food Facts${countries ? ` (${[...countries].join(', ')})` : ' (global)'}`);
    for await (const row of ingestOff()) if (!write(row)) break;
    console.log(`  Open Food Facts: ${counts.off.toLocaleString()} products`);
  }

  db.exec('COMMIT');

  if (total === 0) throw new Error('No products survived filtering — refusing to publish an empty database.');
  console.log(`\n${total.toLocaleString()} products total (${counts.replaced.toLocaleString()} upgraded, ${counts.skipped.toLocaleString()} duplicates skipped)`);

  console.log('Building the full-text index…');
  db.exec(`
    CREATE VIRTUAL TABLE products_fts USING fts5(
      name, brand, content='products', content_rowid='id', tokenize='unicode61'
    );
  `);
  db.exec('INSERT INTO products_fts(rowid, name, brand) SELECT id, name, brand FROM products');
  db.exec("INSERT INTO products_fts(products_fts) VALUES('optimize')");

  console.log('Vacuuming…');
  db.exec('VACUUM');
  db.close();

  return { dbPath, total, counts };
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

async function publish(dbPath, total, counts) {
  const { size } = await stat(dbPath);
  const chunks = Math.ceil(size / SERVER_CHUNK_SIZE);
  console.log(`\nDatabase is ${(size / 1024 / 1024).toFixed(1)} MB — splitting into ${chunks} chunk(s)`);

  const urlPrefix = `${DB_NAME}.`;
  const source = await readFile(dbPath);

  for (let i = 0; i < chunks; i++) {
    const suffix = String(i).padStart(SUFFIX_LENGTH, '0');
    await writeFile(
      path.join(OUT_DIR, `${urlPrefix}${suffix}`),
      source.subarray(i * SERVER_CHUNK_SIZE, (i + 1) * SERVER_CHUNK_SIZE),
    );
  }

  // Consumed by sql.js-httpvfs to map a byte range onto the right chunk file.
  await writeFile(
    path.join(OUT_DIR, 'config.json'),
    JSON.stringify(
      {
        serverMode: 'chunked',
        requestChunkSize: PAGE_SIZE,
        serverChunkSize: SERVER_CHUNK_SIZE,
        databaseLengthBytes: size,
        urlPrefix,
        suffixLength: SUFFIX_LENGTH,
      },
      null,
      2,
    ),
  );

  const sources = [];
  if (counts.off > 0) sources.push('Open Food Facts (Open Database License)');
  if (counts.usdaBranded + counts.usdaGeneric > 0) sources.push('USDA FoodData Central (public domain)');

  // Read by the app before it loads anything heavy, so a deployment without a
  // snapshot costs nothing.
  await writeFile(
    path.join(OUT_DIR, 'manifest.json'),
    JSON.stringify(
      {
        version: new Date().toISOString().slice(0, 7),
        config: 'config.json',
        productCount: total,
        breakdown: counts,
        scope: countries ? [...countries].join(', ') : 'global',
        builtAt: new Date().toISOString(),
        sources,
      },
      null,
      2,
    ),
  );

  console.log(`\nPublished to ${OUT_DIR}`);
  console.log(`  ${total.toLocaleString()} products across ${chunks} chunk(s)`);
  console.log('  A barcode lookup against this reads about 3 KB over the wire,');
  console.log('  regardless of how large the database is.');
}

async function main() {
  const { dbPath, total, counts } = await build();
  await publish(dbPath, total, counts);
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
