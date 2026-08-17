import { chromium } from 'playwright';

/**
 * Exercises the nutrition-label parser against the text OCR actually returns
 * from real packets — European "per 100 g" tables, US "Nutrition Facts" panels,
 * kilojoule-only labels and comma decimals.
 *
 * Runs the real module through the dev server rather than reimplementing it, so
 * this tests the shipped parser and not a copy of it.
 */
const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const CASES = [
  {
    name: 'EU per-100g (Nutella)',
    lines: [
      'Nutrition information',
      'Typical values per 100 g',
      'Energy 2255 kJ / 539 kcal',
      'Fat 30.9 g',
      'of which saturates 10.6 g',
      'Carbohydrate 57.5 g',
      'of which sugars 56.3 g',
      'Fibre 0 g',
      'Protein 6.3 g',
      'Salt 0.107 g',
    ],
    expect: { kcal: 539, fat: 30.9, satFat: 10.6, carbs: 57.5, sugar: 56.3, protein: 6.3 },
  },
  {
    name: 'US Nutrition Facts',
    lines: [
      'Nutrition Facts',
      'Serving size 2/3 cup (55g)',
      'Amount per serving',
      'Calories 230',
      'Total Fat 8g',
      'Saturated Fat 1g',
      'Sodium 160mg',
      'Total Carbohydrate 37g',
      'Dietary Fiber 4g',
      'Total Sugars 12g',
      'Protein 3g',
    ],
    expect: { kcal: 230, fat: 8, satFat: 1, sodiumMg: 160, carbs: 37, fiber: 4, sugar: 12, protein: 3, servingG: 55 },
  },
  {
    // A pack sold in Greece prints its table in several languages at once and
    // OCR returns them interleaved. Matching only the English word found the
    // energy line and almost nothing else.
    name: 'multilingual EU panel',
    lines: [
      'Διατροφική δήλωση / Nutrition declaration',
      'ανά 100 g / per 100 g',
      'Ενέργεια / Energy 2255 kJ / 539 kcal',
      'Λιπαρά / Fat / Grassi 30,9 g',
      'εκ των οποίων κορεσμένα / of which saturates 10,6 g',
      'Υδατάνθρακες / Carbohydrate / Glucides 57,5 g',
      'εκ των οποίων σάκχαρα / of which sugars 56,3 g',
      'Εδώδιμες ίνες / Fibre 0,5 g',
      'Πρωτεΐνες / Protein / Proteine 6,3 g',
      'Αλάτι / Salt 0,107 g',
    ],
    expect: { kcal: 539, fat: 30.9, satFat: 10.6, carbs: 57.5, sugar: 56.3, fiber: 0.5, protein: 6.3 },
  },
  {
    name: 'German panel',
    lines: [
      'Nährwerte pro 100 g',
      'Energie 1560 kJ / 373 kcal',
      'Fett 12,5 g',
      'davon gesättigte Fettsäuren 3,1 g',
      'Kohlenhydrate 45,2 g',
      'davon Zucker 8,4 g',
      'Eiweiss 8,2 g',
    ],
    expect: { kcal: 373, fat: 12.5, satFat: 3.1, carbs: 45.2, sugar: 8.4, protein: 8.2 },
  },
  {
    // Plenty of packs print the table as running prose rather than a grid —
    // small jars, sachets, anything without room for two columns.
    name: 'paragraph form, single line',
    lines: [
      'NUTRITION INFORMATION (per 100g): Energy 1080kJ/260kcal, Fat 20g, of which saturates 3g, Carbohydrate 0g, of which sugars 0g, Protein 20g, Salt 1g.',
    ],
    expect: { kcal: 260, fat: 20, satFat: 3, carbs: 0, sugar: 0, protein: 20 },
  },
  {
    name: 'paragraph form, wrapped across lines',
    lines: [
      'Nutrition per 100 g: Energy 2255 kJ / 539 kcal; Fat 30.9 g of',
      'which saturates 10.6 g; Carbohydrate 57.5 g of which sugars',
      '56.3 g; Fibre 0.5 g; Protein 6.3 g; Salt 0.107 g',
    ],
    expect: { kcal: 539, fat: 30.9, satFat: 10.6, carbs: 57.5, sugar: 56.3, fiber: 0.5, protein: 6.3 },
  },
  {
    name: 'kilojoules only, comma decimals',
    lines: [
      'Valeurs nutritionnelles pour 100 g',
      'Energie 1560 kJ',
      'Matières grasses 12,5 g',
      'Protéines 8,2 g',
    ],
    expect: { kcal: 373 },   // 1560 / 4.184
  },
];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

for (const testCase of CASES) {
  const parsed = await page.evaluate(async (lines) => {
    const mod = await import('/src/scan/barcode.ts');
    return mod.parseNutritionLabel(lines);
  }, testCase.lines);

  for (const [key, want] of Object.entries(testCase.expect)) {
    const got = parsed[key];
    const ok = got !== undefined && Math.abs(got - want) < Math.max(1, want * 0.02);
    check(`${testCase.name}: ${key} = ${want}`, ok, got === undefined ? 'not read' : `got ${got}`);
  }
}

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
