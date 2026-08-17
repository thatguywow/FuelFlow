import { chromium } from 'playwright';

/**
 * The two-column nutrition table, as OCR actually returns it.
 *
 * Fixture built from a real scan of a Greek/English packet. ML Kit grouped the
 * label column and the figures column into separate blocks, so the flattened
 * text read every name first and every number last:
 *
 *     Λιπαρά/Fat
 *     εκ των οποίων Κορεσμένα/of which Saturates
 *     ...
 *     1g
 *     20g
 *     20g
 *     3g
 *     09
 *     0g
 *
 * Note the figures are not even in label order, and "0g" came back as "09".
 * Any parser expecting the number beside its label reads the energy line —
 * which happens to print inline — and nothing else, which is exactly what the
 * app did. Pairing by vertical position reconstructs the rows.
 *
 * Truth for this packet, per 100g:
 *   260 kcal · fat 20 · saturates 3 · carbs 0 · sugars 0 · protein 20 · salt 1
 */

// x, y and height in image pixels, matching the photograph's layout: labels in
// a left column, figures right-aligned in a column beside them.
const LINES = [
  { text: 'ΔΙΑΤΡΟΦΙΚΗ ΔΗΛΩΣΗ', x: 240, y: 840, height: 34 },
  { text: 'NUTRITION DECLARATION**', x: 240, y: 878, height: 30 },

  { text: 'Ενέργεια/Energy', x: 240, y: 1000, height: 34 },
  { text: '1080kJ / 260kcal', x: 780, y: 1000, height: 34 },

  { text: 'Λιπαρά/Fat', x: 240, y: 1062, height: 34 },
  { text: 'εκ των οποίων Κορεσμένα/', x: 240, y: 1122, height: 34 },
  { text: 'of which Saturates', x: 240, y: 1158, height: 30 },
  { text: 'Υδατάνθρακες/Carbohydrate', x: 240, y: 1218, height: 34 },
  { text: 'εκ των οποίων Σάκχαρα/', x: 240, y: 1278, height: 34 },
  { text: 'of which Sugars', x: 240, y: 1314, height: 30 },
  { text: 'Πρωτεΐνες/Protein', x: 240, y: 1374, height: 34 },
  { text: 'Αλάτι/Salt', x: 240, y: 1434, height: 34 },

  // The figures column, in the order the recogniser happened to emit it.
  { text: '1g', x: 800, y: 1434, height: 32 },
  { text: '20g', x: 900, y: 1374, height: 32 },
  { text: '20g', x: 900, y: 1062, height: 32 },
  { text: '3g', x: 900, y: 1122, height: 32 },
  { text: '09', x: 1030, y: 1218, height: 32 },
  { text: '0g', x: 1030, y: 1278, height: 32 },

  { text: '**(ανά 100g προϊόντος/per 100g of product)', x: 260, y: 1560, height: 30 },
];

const EXPECT = { kcal: 260, fat: 20, satFat: 3, carbs: 0, sugar: 0, protein: 20 };

const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const parsed = await page.evaluate(async (lines) => {
  const mod = await import('/src/scan/barcode.ts');
  return {
    spatial: mod.parseLabelLines(lines),
    flat: mod.parseNutritionLabel(lines.map((l) => l.text)),
  };
}, LINES);

console.log(`  flat parser    : ${JSON.stringify(parsed.flat)}`);
console.log(`  spatial parser : ${JSON.stringify(parsed.spatial)}\n`);

for (const [key, want] of Object.entries(EXPECT)) {
  const got = parsed.spatial[key];
  check(`${key} = ${want}`, got !== undefined && Math.abs(got - want) < 0.01, got === undefined ? 'not read' : `got ${got}`);
}

// Salt 1 g is stored as sodium.
check(
  'salt converted to sodium',
  parsed.spatial.sodiumMg !== undefined && Math.abs(parsed.spatial.sodiumMg - 400) < 1,
  `${parsed.spatial.sodiumMg} mg`,
);

// And the whole point: the flat parser could not do this.
const flatFound = Object.keys(parsed.flat).filter((k) => parsed.flat[k] !== undefined).length;
const spatialFound = Object.keys(parsed.spatial).filter((k) => parsed.spatial[k] !== undefined).length;
check(
  'reading positions beats reading flattened text',
  spatialFound > flatFound,
  `${spatialFound} values vs ${flatFound}`,
);

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
