#!/usr/bin/env node
/**
 * Downloads the USDA FoodData Central bulk export.
 *
 * **No API key is required.** The FoodData Central *API* is rate limited and
 * needs a key; the bulk CSV exports are plain public files on nal.usda.gov and
 * need nothing at all. Since one download supplies both the bundled core
 * dataset and the hosted database, the key is unnecessary in this project.
 *
 * The download URLs are date-stamped with no "latest" alias, so this discovers
 * the newest one by reading the downloads page. If USDA ever reorganises that
 * page, pass `--url=` explicitly and everything downstream still works.
 *
 * Usage:
 *   node scripts/fetch-usda.mjs
 *   node scripts/fetch-usda.mjs --out=data-build/usda
 *   node scripts/fetch-usda.mjs --url=https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_csv_2026-04-30.zip
 */

import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const argv = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    return [key, value];
  }),
);

const DOWNLOADS_PAGE = 'https://fdc.nal.usda.gov/download-datasets/';
const DATASET_BASE = 'https://fdc.nal.usda.gov/fdc-datasets/';
const OUT_DIR = path.resolve(argv.out ?? 'data-build/usda');

/**
 * Only these tables are needed. The full export unzips to several gigabytes,
 * most of it derivation and provenance tables we never read, and CI runners are
 * not generous with disk.
 */
const WANTED = [
  'food.csv',
  'food_nutrient.csv',
  'nutrient.csv',
  'branded_food.csv',
  'food_portion.csv',
  'measure_unit.csv',
];

/**
 * Finds the newest `FoodData_Central_csv_<date>.zip` — the "Full Download of
 * All Data Types", which contains Foundation, SR Legacy, Survey and Branded in
 * one file.
 */
async function discoverUrl() {
  if (argv.url && argv.url !== 'true') return argv.url;

  process.stdout.write('Finding the latest USDA export… ');
  const response = await fetch(DOWNLOADS_PAGE);
  if (!response.ok) {
    throw new Error(
      `Could not read ${DOWNLOADS_PAGE} (HTTP ${response.status}).\n` +
        'Pass the zip URL directly with --url=… from https://fdc.nal.usda.gov/download-datasets',
    );
  }
  const html = await response.text();

  // The full export has no data-type segment: FoodData_Central_csv_<date>.zip.
  const matches = [...html.matchAll(/FoodData_Central_csv_(\d{4}-\d{2}-\d{2})\.zip/g)];
  if (matches.length === 0) {
    throw new Error(
      'No full CSV export found on the downloads page — USDA may have changed its layout.\n' +
        'Pass one directly with --url=…',
    );
  }

  const latest = matches
    .map((m) => ({ file: m[0], date: m[1] }))
    .sort((a, b) => (a.date < b.date ? 1 : -1))[0];

  console.log(`${latest.date}`);
  return `${DATASET_BASE}${latest.file}`;
}

async function download(url, target) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
  }

  const totalBytes = Number(response.headers.get('content-length') ?? 0);
  console.log(`Downloading ${(totalBytes / 1024 / 1024).toFixed(0)} MB…`);

  let received = 0;
  let lastReport = 0;
  const source = Readable.fromWeb(response.body);
  source.on('data', (chunk) => {
    received += chunk.length;
    const percent = totalBytes ? (received / totalBytes) * 100 : 0;
    if (percent - lastReport >= 10) {
      lastReport = percent;
      process.stdout.write(`  ${percent.toFixed(0)}%\n`);
    }
  });
  await pipeline(source, createWriteStream(target));
}

/**
 * Node has no built-in zip reader, so this shells out. `unzip` is present on CI
 * runners and macOS; Windows 10+ ships bsdtar, which reads zip archives. One of
 * the two exists nearly everywhere.
 */
function extract(zipPath, outDir) {
  const unzip = spawnSync('unzip', ['-o', '-j', zipPath, ...WANTED.map((f) => `*${f}`), '-d', outDir], {
    stdio: 'inherit',
  });
  if (unzip.status === 0) return;

  console.log('`unzip` unavailable — falling back to tar.');
  const tar = spawnSync('tar', ['-xf', zipPath, '-C', outDir], { stdio: 'inherit' });
  if (tar.status !== 0) {
    throw new Error(
      'Could not extract the archive. Install `unzip`, or unzip it by hand into ' +
        `${outDir} and rerun the build scripts with --usda=${outDir}`,
    );
  }
}

async function main() {
  const url = await discoverUrl();
  await mkdir(OUT_DIR, { recursive: true });

  const zipPath = path.join(path.dirname(OUT_DIR), 'usda-export.zip');
  const cached = await stat(zipPath).then((s) => s.size > 0).catch(() => false);

  if (cached && !argv.force) {
    console.log(`Using cached ${zipPath}`);
  } else {
    await download(url, zipPath);
  }

  console.log(`Extracting into ${OUT_DIR}…`);
  extract(zipPath, OUT_DIR);

  if (!argv['keep-zip']) await rm(zipPath, { force: true });

  const files = await readdir(OUT_DIR, { recursive: true });
  const found = WANTED.filter((name) => files.some((f) => String(f).endsWith(name)));
  const missing = WANTED.filter((name) => !found.includes(name));

  console.log(`\nExtracted ${found.length}/${WANTED.length} expected tables into ${OUT_DIR}`);
  if (missing.length > 0) {
    console.warn(`  Missing: ${missing.join(', ')} — those parts of the build will be skipped.`);
  }
  console.log('\nNext:');
  console.log(`  node scripts/build-core-db.mjs --usda=${path.relative(process.cwd(), OUT_DIR)}`);
  console.log(`  node scripts/build-food-db.mjs --usda=${path.relative(process.cwd(), OUT_DIR)}`);
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
