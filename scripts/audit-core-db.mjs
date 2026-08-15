#!/usr/bin/env node
/**
 * Audits the bundled core food dataset.
 *
 * Every other test in this repo checks that the *app* behaves. None of them
 * check that the 7,793 foods it ships carry the right numbers — so a unit
 * factor applied to the wrong nutrient, or a column read one position out,
 * would sail through the entire suite and quietly make every calorie in the
 * app wrong. OpenNutriTracker's backend has `test_against_source.py` for
 * exactly this reason; this is the same idea for our pipeline.
 *
 * Two modes:
 *
 *   node scripts/audit-core-db.mjs
 *       Invariants only. Needs nothing but the built dataset, so it runs on
 *       any checkout and in CI on every build.
 *
 *   node scripts/audit-core-db.mjs --source=data-build/usda --samples=200
 *       Also samples foods and re-derives their values straight from the raw
 *       USDA CSVs, independently of the builder, and compares. This is the
 *       check that catches a converter bug, because it does not share any code
 *       with the converter.
 *
 * Exit 1 on any failure.
 */

import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';

const argv = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    return [key, value];
  }),
);

const DATASET = path.resolve(argv.dataset ?? 'public/data/core-foods.json');
const SAMPLES = Number(argv.samples ?? 150);
/** Import rounds to three significant figures, so allow a little more than that. */
const TOLERANCE = 0.02;

const failures = [];
let checks = 0;

function check(condition, message) {
  checks++;
  if (!condition) failures.push(message);
}

// ---------------------------------------------------------------------------
// Invariants — true of any correct dataset, whatever the source
// ---------------------------------------------------------------------------

/** Nutrient id -> a range no real food per 100 g can fall outside. */
const PLAUSIBLE = {
  208: [0, 950],    // kcal; pure fat is 900
  203: [0, 100],    // protein g
  204: [0, 100],    // fat g
  205: [0, 100],    // carbohydrate g
  291: [0, 100],    // fibre g
  269: [0, 100],    // sugars g
  606: [0, 100],    // saturated fat g
  307: [0, 40_000], // sodium mg; salt itself is ~38,750
  301: [0, 8000],   // calcium mg
  303: [0, 200],    // iron mg
};

const NAME_HAS_LETTER = /\p{L}/u;

function auditInvariants(dataset) {
  const index = new Map(dataset.columns.map((id, i) => [id, i]));
  const at = (values, id) => {
    const position = index.get(id);
    return position === undefined ? undefined : (values[position] ?? undefined);
  };

  const seenIds = new Set();
  let withEnergy = 0;
  let implausibleEnergy = 0;

  for (const [name, , values, portions, fdcId] of dataset.foods) {
    const where = `${String(name).slice(0, 40)} (${fdcId})`;

    // A name that is only digits or punctuation is not a food name. The
    // OpenNutriTracker app rejects these on input for the same reason.
    check(typeof name === 'string' && NAME_HAS_LETTER.test(name), `${where}: name has no letters`);

    check(!seenIds.has(fdcId), `${where}: duplicate FDC id`);
    seenIds.add(fdcId);

    // Zero is a real answer here: water, salt and baking soda all carry a
    // legitimate 0 kcal, and requiring a positive figure flagged 27 correct
    // records as broken on the first run of this audit.
    const energy = at(values, 208);
    check(energy !== undefined, `${where}: no energy value`);
    if (energy !== undefined) withEnergy++;

    for (const [id, [low, high]] of Object.entries(PLAUSIBLE)) {
      const value = at(values, Number(id));
      if (value === undefined) continue;
      check(value >= low && value <= high, `${where}: nutrient ${id} = ${value}, outside ${low}..${high}`);
    }

    const fat = at(values, 204);
    const satFat = at(values, 606);
    if (fat !== undefined && satFat !== undefined) {
      check(satFat <= fat + 0.5, `${where}: saturated fat ${satFat} exceeds total fat ${fat}`);
    }

    const carbs = at(values, 205) ?? 0;
    const protein = at(values, 203) ?? 0;
    check(carbs + protein + (fat ?? 0) <= 101, `${where}: macros sum to more than 100 g`);

    // Atwater coherence, on the same 25% tolerance the app uses to demote
    // implausible Open Food Facts records. Counted rather than failed: a
    // handful of legitimate USDA foods (alcohol, polyols) sit outside it.
    if (energy && (carbs || protein || fat)) {
      const implied = 4 * carbs + 4 * protein + 9 * (fat ?? 0);
      if (Math.abs(energy - implied) / energy > 0.25) implausibleEnergy++;
    }

    for (const [label, grams] of portions ?? []) {
      check(typeof label === 'string' && label.length > 0, `${where}: portion with no label`);
      // A whole turkey is 5 kg and USDA lists it as one portion, so the
      // ceiling has to clear a bird rather than a plate.
      check(grams > 0 && grams < 20_000, `${where}: portion "${label}" weighs ${grams} g`);
    }
  }

  // A canary, not a rule. Alcohol, polyols and a few fortified products are
  // legitimately outside Atwater, and the current export sits at 2.9% — so the
  // bar is set where a systematic unit error would trip it and normal drift
  // would not.
  const rate = implausibleEnergy / Math.max(1, dataset.foods.length);
  check(rate < 0.06, `${(rate * 100).toFixed(1)}% of foods have energy incoherent with their macros`);
  check(withEnergy === dataset.foods.length, `${dataset.foods.length - withEnergy} foods without energy`);

  console.log(`  ${dataset.foods.length.toLocaleString()} foods, ${dataset.columns.length} nutrient columns`);
  console.log(`  ${implausibleEnergy} with energy outside Atwater tolerance (${(rate * 100).toFixed(2)}%)`);
}

// ---------------------------------------------------------------------------
// Source comparison — re-derived from the raw CSVs, sharing no code with the builder
// ---------------------------------------------------------------------------

async function* readCsv(file) {
  const stream = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let header = null;
  for await (const line of stream) {
    const cells = splitCsv(line);
    if (!header) {
      header = cells;
      continue;
    }
    const row = {};
    header.forEach((key, i) => (row[key] = cells[i] ?? ''));
    yield row;
  }
}

function splitCsv(line) {
  const out = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cell);
      cell = '';
    } else cell += ch;
  }
  out.push(cell);
  return out;
}

async function findCsv(root, name) {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name === name) return path.join(entry.parentPath ?? entry.path, name);
  }
  throw new Error(`${name} not found under ${root}`);
}

/**
 * Energy for a sample of foods, read straight from the raw export.
 *
 * The priority order is restated here on purpose. Importing it from the
 * builder would mean a wrong order agrees with itself and the check proves
 * nothing — the whole point is that these two are written independently.
 */
async function auditAgainstSource(dataset, sourceDir) {
  const index = new Map(dataset.columns.map((id, i) => [id, i]));
  const energyAt = index.get(208);

  const wanted = new Map();
  const pool = [...dataset.foods];
  for (let i = 0; i < Math.min(SAMPLES, pool.length); i++) {
    const pick = pool[Math.floor(Math.random() * pool.length)];
    wanted.set(String(pick[4]), { name: pick[0], energy: pick[2][energyAt] });
  }
  console.log(`  sampling ${wanted.size} foods against ${sourceDir}`);

  const numberById = new Map();
  for await (const row of readCsv(await findCsv(sourceDir, 'nutrient.csv'))) {
    const number = Number(row.nutrient_nbr);
    if (Number.isFinite(number)) numberById.set(row.id, number);
  }

  // 208 outright, else Atwater specific, else Atwater general, else kJ.
  const RANK = new Map([[208, 0], [958, 1], [957, 2], [268, 3]]);
  const best = new Map();

  for await (const row of readCsv(await findCsv(sourceDir, 'food_nutrient.csv'))) {
    if (!wanted.has(row.fdc_id)) continue;
    const number = numberById.get(row.nutrient_id) ?? Number(row.nutrient_id);
    const rank = RANK.get(number);
    if (rank === undefined) continue;
    const amount = Number(row.amount);
    if (!Number.isFinite(amount)) continue;
    const current = best.get(row.fdc_id);
    if (current && current.rank <= rank) continue;
    best.set(row.fdc_id, { rank, kcal: number === 268 ? amount / 4.184 : amount });
  }

  // Descriptions, checked independently of the numbers.
  const descriptions = new Map();
  for await (const row of readCsv(await findCsv(sourceDir, 'food.csv'))) {
    if (wanted.has(row.fdc_id)) descriptions.set(row.fdc_id, row.description);
  }

  let compared = 0;
  for (const [fdcId, expected] of wanted) {
    const raw = best.get(fdcId);
    if (!raw) {
      check(false, `${expected.name} (${fdcId}): no energy in the raw source`);
      continue;
    }
    compared++;
    const drift = Math.abs(expected.energy - raw.kcal) / Math.max(1, raw.kcal);
    check(
      drift <= TOLERANCE,
      `${expected.name} (${fdcId}): energy ${expected.energy} vs source ${raw.kcal.toFixed(1)} (${(drift * 100).toFixed(1)}% off)`,
    );

    const description = descriptions.get(fdcId);
    if (description) {
      // The builder tidies whitespace around commas but must not change words.
      const words = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      check(
        words(description) === words(expected.name),
        `${expected.name} (${fdcId}): name differs from source "${description}"`,
      );
    }
  }
  console.log(`  ${compared} foods compared against the raw export`);
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`Auditing ${DATASET}\n`);
  const dataset = JSON.parse(await readFile(DATASET, 'utf8'));

  console.log('Invariants:');
  auditInvariants(dataset);

  if (argv.source && argv.source !== 'true') {
    console.log('\nAgainst the raw USDA export:');
    await auditAgainstSource(dataset, path.resolve(argv.source));
  } else {
    console.log('\nSkipping the source comparison (pass --source=<dir> to run it).');
  }

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length > 0) {
    console.error(`\n${failures.length} failures:`);
    for (const failure of failures.slice(0, 40)) console.error(`  ${failure}`);
    if (failures.length > 40) console.error(`  … and ${failures.length - 40} more`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
