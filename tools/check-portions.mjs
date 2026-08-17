import { chromium } from 'playwright';

/**
 * Default portions across the real bundled dataset.
 *
 * USDA lists a bare unit conversion first on about 40% of its foods, and the
 * seeder took that first entry as the default — so a beer opened on "1 fl oz"
 * while "can or bottle (12 fl oz)" sat right behind it. A unit is not a
 * serving; it is the same weight said differently.
 */
const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 412, height: 915 },
  isMobile: true,
  hasTouch: true,
  colorScheme: 'dark',
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

// Reseed so the rows under test come from the current unpack rule.
const seeded = await page.evaluate(async () => {
  const { ensureCoreData } = await import('/src/db/seed.ts');
  await ensureCoreData(undefined, { force: true });
  const { db } = await import('/src/db/schema.ts');
  return db.foods.where('source').equals('usda').count();
});
check('the core dataset is installed', seeded > 5000, `${seeded} foods`);

const audit = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const { isImperialUnitPortion, portionStatesItsMass } = await import('/src/core/foodName.ts');
  const foods = await db.foods.where('source').equals('usda').toArray();

  let noDefault = 0;
  let bareUnitDefault = 0;
  let householdDefault = 0;
  let hundredDefault = 0;
  const offenders = [];

  for (const food of foods) {
    const preferred = food.portions.find((p) => p.preferred);
    if (!preferred) {
      noDefault++;
      continue;
    }
    if (isImperialUnitPortion(preferred.label)) {
      bareUnitDefault++;
      if (offenders.length < 5) offenders.push(`${food.name.slice(0, 40)} -> ${preferred.label}`);
      continue;
    }
    if (preferred.grams === 100) hundredDefault++;
    else if (!portionStatesItsMass(preferred.label)) householdDefault++;
  }

  // USDA derives carbohydrate by difference, so low-carb meats round below
  // zero — ten foods in the shipping export do. A negative nutrient is never a
  // valid answer, so the seeder clamps them.
  const negatives = [];
  for (const food of foods) {
    for (const [id, value] of Object.entries(food.per100g)) {
      if (typeof value === 'number' && value < 0) negatives.push(`${food.name.slice(0, 36)} n${id}=${value}`);
    }
  }

  const beer = foods.find((f) => /beer, light$/i.test(f.name));
  return {
    total: foods.length,
    noDefault,
    bareUnitDefault,
    householdDefault,
    hundredDefault,
    offenders,
    negatives: negatives.slice(0, 4),
    negativeCount: negatives.length,
    beerDefault: beer?.portions.find((p) => p.preferred)?.label ?? 'none',
    beerHasOunce: beer?.portions.some((p) => /fl\.?\s*oz/i.test(p.label)) ?? false,
  };
});

check('every food has exactly one default portion', audit.noDefault === 0,
  `${audit.noDefault} without one`);
check('no food defaults to a bare unit conversion', audit.bareUnitDefault === 0,
  audit.offenders.join(' | ') || `${audit.bareUnitDefault}`);
// Metric wants 100 g: the data is expressed per 100 g and generic foods are
// weighed rather than counted.
check('the overwhelming majority default to 100 g',
  audit.hundredDefault > audit.total * 0.8, `${audit.hundredDefault} of ${audit.total}`);
// …except where 100 g is a laboratory quantity rather than a helping — a
// teaspoon of bacon grease, a cup of amaranth leaves, one cookie.
check('foods too small to weigh at 100 g keep a household measure',
  audit.householdDefault > 300 && audit.householdDefault < audit.total * 0.2,
  `${audit.householdDefault} of ${audit.total}`);

check('no seeded food carries a negative nutrient value',
  audit.negativeCount === 0, audit.negatives.join(' | ') || '0');

// The specific case that exposed this.
check('light beer no longer opens on one fluid ounce',
  !/fl\.?\s*oz$/i.test(audit.beerDefault), `defaults to "${audit.beerDefault}"`);
check('and the ounce measure is still offered, just not first', audit.beerHasOunce);

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
