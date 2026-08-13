#!/usr/bin/env node
/**
 * Validates the Android resources the patch scripts generate.
 *
 * These files are inflated by the OS before any of the app's own code runs, so
 * a mistake in them is not a visual bug — it is a process that dies on launch
 * with "force closed due to an internal error" and no way in. Gradle compiles
 * them happily; the failure only appears on a device.
 *
 * That is exactly what happened: the launch background wrapped a vector in
 * <bitmap>, which BitmapDrawable cannot take, and every install crashed at
 * startup. These assertions run against a throwaway copy of Capacitor's
 * generated tree, so they hold without an Android SDK present.
 *
 * Usage: node scripts/check-android-resources.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// --- a stand-in for what `cap add android` writes -------------------------
const root = mkdtempSync(path.join(tmpdir(), 'ff-res-'));
const res = path.join(root, 'res');
mkdirSync(path.join(res, 'values'), { recursive: true });

writeFileSync(
  path.join(res, 'values', 'styles.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="AppTheme" parent="Theme.AppCompat.DayNight.NoActionBar" />
    <style name="AppTheme.NoActionBar" parent="Theme.AppCompat.DayNight.NoActionBar">
        <item name="windowActionBar">false</item>
        <item name="windowNoTitle">true</item>
    </style>
    <style name="AppTheme.NoActionBarLaunch" parent="AppTheme.NoActionBar">
        <item name="android:background">@drawable/splash</item>
    </style>
</resources>
`,
);
writeFileSync(
  path.join(res, 'values', 'colors.xml'),
  `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="colorPrimary">#3880FF</color>\n</resources>\n`,
);

execFileSync(process.execPath, ['scripts/patch-android-theme.mjs', res], { stdio: 'pipe' });

// --- collect every drawable/mipmap the script wrote -----------------------
const xmlFiles = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (full.endsWith('.xml')) xmlFiles.push(full);
  }
};
walk(res);

const read = (file) => readFileSync(file, 'utf8');
const vectors = new Set(
  xmlFiles.filter((f) => read(f).includes('<vector')).map((f) => path.basename(f, '.xml')),
);

// --- the failure that shipped --------------------------------------------
let bitmapOfVector = null;
for (const file of xmlFiles) {
  const xml = read(file);
  // <bitmap android:src="@drawable/x"> where x is a vector.
  for (const match of xml.matchAll(/<bitmap[^>]*android:src="@drawable\/([^"]+)"/g)) {
    if (vectors.has(match[1])) bitmapOfVector = `${path.basename(file)} -> ${match[1]}`;
  }
}
check(
  'no <bitmap> wrapping a vector drawable',
  bitmapOfVector === null,
  bitmapOfVector ?? 'BitmapDrawable cannot take a vector src; it throws while inflating',
);

// --- every drawable reference resolves ------------------------------------
const declaredDrawables = new Set(xmlFiles.map((f) => path.basename(f, '.xml')));
const declaredColors = new Set();
for (const file of xmlFiles.filter((f) => f.endsWith('colors.xml'))) {
  for (const m of read(file).matchAll(/<color name="([^"]+)"/g)) declaredColors.add(m[1]);
}

// Only our own resources are validated. Capacitor's template references its
// own drawables (`@drawable/splash`) that the real project supplies and this
// fixture does not.
const missing = [];
for (const file of xmlFiles) {
  const xml = read(file);
  for (const m of xml.matchAll(/@drawable\/(ff_[A-Za-z0-9_]+)/g)) {
    if (!declaredDrawables.has(m[1])) missing.push(`${path.basename(file)} -> @drawable/${m[1]}`);
  }
  for (const m of xml.matchAll(/@color\/(ff[A-Za-z0-9_]+)/g)) {
    if (!declaredColors.has(m[1])) missing.push(`${path.basename(file)} -> @color/${m[1]}`);
  }
}
check('every generated reference resolves', missing.length === 0, missing.slice(0, 4).join('; '));

// --- style parents must exist --------------------------------------------
const styleNames = new Set();
for (const file of xmlFiles.filter((f) => f.endsWith('styles.xml'))) {
  for (const m of read(file).matchAll(/<style name="([^"]+)"/g)) styleNames.add(m[1]);
}
const badParents = [];
for (const file of xmlFiles.filter((f) => f.endsWith('styles.xml'))) {
  for (const m of read(file).matchAll(/<style name="[^"]+" parent="([^"]+)"/g)) {
    const parent = m[1];
    // Platform and AppCompat parents are resolved by the toolchain; only our
    // own names have to be present in these files.
    if (parent.startsWith('Theme.') || parent.startsWith('android:')) continue;
    if (!styleNames.has(parent)) badParents.push(`${path.basename(file)} -> ${parent}`);
  }
}
check('style parents are defined', badParents.length === 0, badParents.join('; '));

// --- the things the app depends on ---------------------------------------
const nightStyles = path.join(res, 'values-night', 'styles.xml');
const dayStyles = path.join(res, 'values', 'styles.xml');
check('day theme sets the navigation bar', read(dayStyles).includes('android:navigationBarColor'));
check('night variant exists', xmlFiles.includes(nightStyles));
check(
  'launch window paints the mark',
  read(dayStyles).includes('@drawable/ff_launch'),
  'so a cold start does not sit on a bare colour',
);
check(
  'adaptive icon has a monochrome layer',
  read(path.join(res, 'mipmap-anydpi-v26', 'ic_launcher.xml')).includes('<monochrome'),
  'required for Android 13 themed icons',
);

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
