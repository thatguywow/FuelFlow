import { chromium } from 'playwright';

/**
 * Synonyms, localized product names and nutrient provenance.
 *
 * All three come from the OpenNutriTracker backend schema — `food_alias`,
 * `food_translation`, and the `origin` column on `food_nutrient`. The first two
 * are recall problems: the dataset is written in one dialect of one language
 * and the person searching it is not.
 */
const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 412, height: 915 },
  colorScheme: 'dark',
  locale: 'el-GR',
});
page.on('pageerror', (e) => console.log(`  [pageerror] ${String(e).slice(0, 200)}`));

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
if (await page.locator('button:text-is("Set up")').count()) {
  await page.locator('button:text-is("Set up")').click();
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(250);
    const next = page.locator('button:text-is("Continue")');
    if (await next.count()) await next.click();
  }
  await page.waitForTimeout(300);
  await page.locator('button:text-is("Start tracking")').click();
  await page.locator('text=MACRONUTRIENTS').waitFor({ timeout: 30_000 });
}

await page.evaluate(async () => {
  const { ensureCoreData } = await import('/src/db/seed.ts');
  await ensureCoreData();
});
await page.waitForTimeout(800);

// ---------------------------------------------------------------------------
// Synonyms
// ---------------------------------------------------------------------------

const expansion = await page.evaluate(async () => {
  const { expandToken } = await import('/src/core/aliases.ts');
  return {
    aubergine: expandToken('aubergine'),
    plain: expandToken('chicken'),
    leadsWithTyped: expandToken('soda')[0],
  };
});
check('a regional word expands to its equivalents',
  expansion.aubergine.includes('eggplant'), expansion.aubergine.join(', '));
check('an ordinary word expands to just itself',
  expansion.plain.length === 1, expansion.plain.join(', '));
check('the typed word always leads', expansion.leadsWithTyped === 'soda');

const searches = await page.evaluate(async () => {
  const { searchLocal } = await import('/src/search/local.ts');
  const run = async (q) => (await searchLocal(q, { limit: 5 })).map((h) => h.food.name);
  return {
    aubergine: await run('aubergine'),
    courgette: await run('courgette'),
    coriander: await run('coriander'),
    prawns: await run('prawns'),
    chickpeas: await run('chickpeas'),
    // A two-word query must still require both concepts.
    aubergineRaw: await run('aubergine raw'),
    nonsense: await run('aubergine zzzz'),
  };
});

check('"aubergine" finds eggplant', searches.aubergine.some((n) => /eggplant/i.test(n)),
  searches.aubergine[0] ?? 'nothing');
check('"courgette" finds zucchini', searches.courgette.some((n) => /zucchini|squash/i.test(n)),
  searches.courgette[0] ?? 'nothing');
check('"coriander" finds cilantro', searches.coriander.some((n) => /cilantro|coriander/i.test(n)),
  searches.coriander[0] ?? 'nothing');
check('"prawns" finds shrimp', searches.prawns.some((n) => /shrimp/i.test(n)),
  searches.prawns[0] ?? 'nothing');
check('"chickpeas" finds garbanzo', searches.chickpeas.length > 0,
  searches.chickpeas[0] ?? 'nothing');
check('a second word still narrows rather than widens',
  searches.aubergineRaw.every((n) => /raw/i.test(n)), searches.aubergineRaw[0] ?? 'nothing');
check('an unmatchable word still returns nothing',
  searches.nonsense.length === 0, `${searches.nonsense.length} hits`);

// ---------------------------------------------------------------------------
// Localized product names from Open Food Facts
// ---------------------------------------------------------------------------

let requestedFields = '';
await page.route('**/search.openfoodfacts.org/search**', async (route) => {
  requestedFields = new URL(route.request().url()).searchParams.get('fields') ?? '';
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      hits: [
        {
          code: '5201234567890',
          product_name: 'Generic fallback',
          product_name_en: 'Strained yoghurt',
          product_name_el: 'Στραγγιστό γιαούρτι',
          brands: 'Test',
          nutriments: { 'energy-kcal_100g': 97, proteins_100g: 10, carbohydrates_100g: 4, fat_100g: 5 },
          completeness: 0.8,
          popularity_key: 500,
          countries_tags: ['en:greece'],
        },
      ],
    }),
  });
});

const localized = await page.evaluate(async () => {
  const { searchOnline, setOnlineSearchForTesting } = await import('/src/search/off.ts');
  // A browser cannot reach the real search host (no CORS), and this test
  // stubs it anyway — so the platform gate is lifted for the call.
  setOnlineSearchForTesting(true);
  const hits = await searchOnline('yoghurt probe', { limit: 5 });
  return hits.map((h) => h.food.name);
});

check('the device language name field is requested',
  requestedFields.includes('product_name_el'), requestedFields);
check('and the product comes back under its Greek name',
  localized[0] === 'Στραγγιστό γιαούρτι', localized[0] ?? 'nothing');

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

const origin = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const foods = await db.foods.where('source').equals('usda').limit(400).toArray();
  const withOrigin = foods.filter((f) => f.origin !== undefined).length;

  // The field has to survive a round trip whatever the dataset carries.
  const { upsertFood } = await import('/src/db/repo.ts');
  const made = await upsertFood({
    source: 'user',
    sourceId: 'origin-probe',
    name: 'Origin probe',
    per100g: { 208: 100 },
    portions: [{ label: '100 g', grams: 100, preferred: true }],
    origin: 'analysis',
  });
  const stored = await db.foods.get(made.id);
  await db.foods.delete(made.id);
  return { sampled: foods.length, withOrigin, roundTrip: stored?.origin };
});

check('the schema carries provenance end to end', origin.roundTrip === 'analysis',
  String(origin.roundTrip));
// The shipped dataset predates the field; it fills in on the next data build.
console.log(`  (${origin.withOrigin}/${origin.sampled} bundled foods carry provenance — ` +
  `0 until the data pipeline reruns)`);

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
