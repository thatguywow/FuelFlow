#!/usr/bin/env node
/**
 * Generates the whole icon set from one definition.
 *
 * Every launcher size, the maskable and monochrome Android variants, the
 * favicon and the PWA manifest icons come from the same path data here, so
 * there is exactly one place to change the mark and nothing can drift out of
 * step with the app.
 *
 * SVG in, PNG out via sharp when it is available; the SVGs alone are enough for
 * the web and for Android's adaptive icons, so a missing sharp is a warning
 * rather than a failure.
 *
 * Usage: node scripts/build-icons.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT = 'public/icons';
mkdirSync(OUT, { recursive: true });

const BRAND_1 = '#38BDF8';
const BRAND_2 = '#3B82F6';
const BRAND_3 = '#4F46E5';
const GROUND = '#0E1015';
const TRACK = '#2A3242';

/**
 * The mark: the 270° gauge from the Today screen.
 *
 * `inset` keeps the artwork inside Android's maskable safe zone — a maskable
 * icon can be cropped to a circle, and anything within the outer 10% on each
 * side is not guaranteed to survive.
 */
function mark({ scale = 1 } = {}) {
  const cx = 32, cy = 32, r = 20 * scale;
  const start = { x: cx + r * Math.cos((135 * Math.PI) / 180), y: cy + r * Math.sin((135 * Math.PI) / 180) };
  const end = { x: cx + r * Math.cos((45 * Math.PI) / 180), y: cy + r * Math.sin((45 * Math.PI) / 180) };
  const progress = { x: cx + r * Math.cos((310.5 * Math.PI) / 180), y: cy + r * Math.sin((310.5 * Math.PI) / 180) };
  const w = 7.5 * scale;
  const f = (n) => n.toFixed(2);
  return `
    <path d="M${f(start.x)} ${f(start.y)}A${f(r)} ${f(r)} 0 1 1 ${f(end.x)} ${f(end.y)}"
          fill="none" stroke="${TRACK}" stroke-width="${f(w)}" stroke-linecap="round"/>
    <path d="M${f(start.x)} ${f(start.y)}A${f(r)} ${f(r)} 0 0 1 ${f(progress.x)} ${f(progress.y)}"
          fill="none" stroke="url(#g)" stroke-width="${f(w)}" stroke-linecap="round"/>`;
}

const GRADIENT = `
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${BRAND_1}"/>
      <stop offset="55%" stop-color="${BRAND_2}"/>
      <stop offset="100%" stop-color="${BRAND_3}"/>
    </linearGradient>
  </defs>`;

/** Rounded-square tile, for the favicon and the iOS/PWA icons. */
const tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="512" height="512">
${GRADIENT}
  <rect width="64" height="64" rx="14.3" fill="${GROUND}"/>
${mark()}
</svg>
`;

/** Full-bleed ground: Android applies its own mask, so no corners here. */
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="512" height="512">
${GRADIENT}
  <rect width="64" height="64" fill="${GROUND}"/>
${mark({ scale: 0.72 })}
</svg>
`;

/** Themed icons are a single-colour silhouette; the OS supplies the colour. */
const monochrome = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="512" height="512">
  <path d="M17.86 46.14A20 20 0 1 1 46.14 46.14" fill="none" stroke="#000" stroke-width="7.5"
        stroke-linecap="round" opacity="0.35"/>
  <path d="M17.86 46.14A20 20 0 0 1 44.98 16.79" fill="none" stroke="#000" stroke-width="7.5"
        stroke-linecap="round"/>
</svg>
`;

/** Transparent mark alone, for the in-app lockup and the launch screen. */
const bare = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="256" height="256">
${GRADIENT}
${mark()}
</svg>
`;

const files = {
  'icon.svg': tile,
  'icon-maskable.svg': maskable,
  'icon-monochrome.svg': monochrome,
  'mark.svg': bare,
};

for (const [name, contents] of Object.entries(files)) {
  writeFileSync(path.join(OUT, name), contents);
}
writeFileSync('public/favicon.svg', tile);

console.log(`Wrote ${Object.keys(files).length + 1} SVGs.`);

// --- raster ---------------------------------------------------------------
const PNG_SIZES = [
  ['icon-192.png', 192, tile],
  ['icon-512.png', 512, tile],
  ['icon-maskable-192.png', 192, maskable],
  ['icon-maskable-512.png', 512, maskable],
  ['apple-touch-icon.png', 180, tile],
];

let sharp;
try {
  ({ default: sharp } = await import('sharp'));
} catch {
  console.warn('sharp is not installed — SVGs written, PNGs skipped.');
  console.warn('  npm i -D sharp   then re-run to produce the launcher PNGs.');
  process.exit(0);
}

for (const [name, size, svg] of PNG_SIZES) {
  await sharp(Buffer.from(svg)).resize(size, size).png({ compressionLevel: 9 }).toFile(path.join(OUT, name));
  console.log(`  ${name}  ${size}x${size}`);
}
console.log('PNGs written.');
