import { chromium } from 'playwright';

/**
 * Search ranking and the two-stage product fetch.
 *
 * Ideas taken from OpenNutriTracker: rank a wide candidate pool by fusing the
 * API's relevance order with how often a product is actually looked up, demote
 * entries whose energy contradicts their own macros, ask the index in the
 * user's language, and fetch the full record only for the product opened.
 *
 * The network is stubbed throughout, so this asserts our behaviour rather than
 * Open Food Facts' mood.
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

// ---------------------------------------------------------------------------
// A canned Open Food Facts, so ordering is the only variable
// ---------------------------------------------------------------------------

const product = (code, name, popularity, countries, nutriments) => ({
  code,
  product_name: name,
  brands: 'Test',
  quantity: '250 g',
  nutriments,
  completeness: 0.5,
  popularity_key: popularity,
  countries_tags: countries,
});

const sane = { 'energy-kcal_100g': 100, proteins_100g: 5, carbohydrates_100g: 15, fat_100g: 2 };
// 900 kcal declared against macros implying ~100: a gross data error.
const nonsense = { 'energy-kcal_100g': 900, proteins_100g: 5, carbohydrates_100g: 15, fat_100g: 2 };

let searchUrl = '';
await page.route('**/search.openfoodfacts.org/search**', async (route) => {
  searchUrl = route.request().url();
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      hits: [
        // Relevance order as the API returned it. Deliberately adversarial:
        // the most relevant slot holds an implausible record, and the popular
        // local product is buried near the bottom.
        product('1000000000001', 'Broken numbers', 0, ['en:france'], nonsense),
        product('1000000000002', 'Unloved product', 1, ['en:france'], sane),
        product('1000000000003', 'Also unloved', 2, ['en:france'], sane),
        product('1000000000004', 'Popular in Greece', 9999, ['en:greece'], sane),
      ],
    }),
  });
});

await page.route('**/world.openfoodfacts.org/api/v2/product/**', async (route) => {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      status: 1,
      product: {
        code: '1000000000004',
        product_name: 'Popular in Greece',
        brands: 'Test',
        // Only the full record carries a serving size.
        serving_size: '30 g',
        serving_quantity: 30,
        nutriments: { ...sane, fiber_100g: 3, calcium_100g: 0.12 },
        completeness: 0.9,
      },
    }),
  });
});

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

// ---------------------------------------------------------------------------
// Plausibility
// ---------------------------------------------------------------------------

const plausible = await page.evaluate(async () => {
  const { isEnergyPlausible } = await import('/src/search/off.ts');
  return {
    sparse: isEnergyPlausible({ 208: 250 }),
    exact: isEnergyPlausible({ 208: 100, 205: 15, 203: 5, 204: 2 }),
    rounding: isEnergyPlausible({ 208: 112, 205: 15, 203: 5, 204: 2 }),
    gross: isEnergyPlausible({ 208: 900, 205: 15, 203: 5, 204: 2 }),
    zero: isEnergyPlausible({}),
  };
});
check('a product with no macros is not judged', plausible.sparse && plausible.zero);
check('normal rounding error passes', plausible.exact && plausible.rounding);
check('energy that contradicts its own macros fails', plausible.gross === false);

// ---------------------------------------------------------------------------
// The request we actually send
// ---------------------------------------------------------------------------

const hits = await page.evaluate(async () => {
  const { searchOnline, setOnlineSearchForTesting } = await import('/src/search/off.ts');
  // A browser cannot reach the real search host (no CORS), and this test
  // stubs it anyway — so the platform gate is lifted for the call.
  setOnlineSearchForTesting(true);
  const found = await searchOnline('test ranking probe', { limit: 10 });
  return found.map((h) => ({ name: h.food.name, score: h.score, detailed: h.food.detailed }));
});

const params = new URL(searchUrl).searchParams;
check('the index is queried in the device language', (params.get('langs') ?? '').startsWith('el'),
  params.get('langs') ?? 'absent');
check('English stays as a fallback language', (params.get('langs') ?? '').includes('en'),
  params.get('langs') ?? 'absent');
check('a wide candidate pool is fetched, not one page of results',
  Number(params.get('page_size')) >= 100, params.get('page_size') ?? 'absent');
check('the search projection stays thin',
  !(params.get('fields') ?? '').includes('serving_size'), params.get('fields') ?? '');
check('and asks for the popularity signal',
  (params.get('fields') ?? '').includes('popularity_key'));

// ---------------------------------------------------------------------------
// The ordering that comes out
// ---------------------------------------------------------------------------

const names = hits.map((h) => h.name);
check('the popular local product is lifted above the unloved ones',
  names.indexOf('Popular in Greece') < names.indexOf('Unloved product'), names.join(' | '));
check('the implausible record is demoted to last',
  names[names.length - 1] === 'Broken numbers', names.join(' | '));
check('but it is demoted, not dropped', names.includes('Broken numbers'));
check('scores descend with the ranking',
  hits.every((h, i) => i === 0 || h.score <= hits[i - 1].score),
  hits.map((h) => h.score.toFixed(1)).join(' > '));
check('search results are marked as not fully fetched', hits.every((h) => !h.detailed));

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

const hydrated = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const { hydrateFood } = await import('/src/search/index.ts');

  const thin = await db.foods.where('barcode').equals('1000000000004').first();
  const before = { portions: thin.portions.length, detailed: thin.detailed ?? false, serving: thin.portions.some((x) => x.grams === 30) };

  const full = await hydrateFood(thin);
  const after = await db.foods.get(full.id);

  // Now let a thin search result come back over the top of the good record.
  const { upsertFood } = await import('/src/db/repo.ts');
  await upsertFood({
    source: 'off',
    sourceId: '1000000000004',
    barcode: '1000000000004',
    name: 'Popular in Greece',
    per100g: { 208: 100 },
    portions: [{ label: '100 g', grams: 100, preferred: true }],
    quality: 0.5,
  });
  const survived = await db.foods.get(full.id);

  return {
    before,
    after: { portions: after.portions.length, detailed: after.detailed ?? false, serving: after.portions.some((x) => x.grams === 30) },
    survivedPortions: survived.portions.length,
    survivedServing: survived.portions.some((x) => x.grams === 30),
    survivedDetailed: survived.detailed ?? false,
    keptMicros: survived.per100g[301] !== undefined,
  };
});

check('a search result starts out thin', hydrated.before.detailed === false,
  `${hydrated.before.portions} portions`);
check('opening it fetches the full record', hydrated.after.detailed === true);
// The thin projection has no serving_size at all, so this is the field the
// two-stage fetch exists to recover.
check('which brings the serving size with it',
  hydrated.before.serving === false && hydrated.after.serving === true,
  `serving portion before ${hydrated.before.serving}, after ${hydrated.after.serving}`);
check('a later thin result cannot overwrite it',
  hydrated.survivedDetailed && hydrated.survivedServing,
  `serving kept ${hydrated.survivedServing}, detailed ${hydrated.survivedDetailed}`);
check('so the micronutrients survive too', hydrated.keptMicros);

await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  for (const food of await db.foods.where('source').equals('off').toArray()) {
    if (food.barcode?.startsWith('10000000000')) await db.foods.delete(food.id);
  }
});

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
