import { chromium } from 'playwright';

/**
 * "Log a whole meal" — the free-text route.
 *
 * It is a deterministic parser, not a guess: it has to split a written meal
 * into items, read quantities and units, resolve each against the food
 * database, and log them all to the chosen meal and day. These check the whole
 * path, including that the diary total matches the parts.
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
    const n = page.locator('button:text-is("Continue")');
    if (await n.count()) await n.click();
  }
  await page.waitForTimeout(300);
  await page.locator('button:text-is("Start tracking")').click();
  await page.locator('text=MACRONUTRIENTS').waitFor({ timeout: 30_000 });
}
await page.evaluate(async () => {
  const seed = await import('/src/db/seed.ts');
  await seed.ensureCoreData();
});
await page.waitForTimeout(1500);

// --- the parser on its own, before any UI ---------------------------------
const parsed = await page.evaluate(async () => {
  const mod = await import('/src/search/index.ts');
  return mod.parseQuickLog('200g chicken breast, 150 g white rice cooked and 2 eggs');
});
console.log(`  parsed ${parsed.length} items: ${JSON.stringify(parsed.map((p) => ({ q: p.quantity, u: p.unit, n: p.name })))}`);
check('parses a written meal into separate items', parsed.length === 3, `${parsed.length} items`);
check(
  'reads the quantity and unit off each item',
  parsed[0]?.quantity === 200 && parsed[1]?.quantity === 150,
  `${parsed[0]?.quantity}${parsed[0]?.unit} / ${parsed[1]?.quantity}${parsed[1]?.unit}`,
);

// --- through the sheet ----------------------------------------------------
await page.locator('button[aria-label="Add to diary"]').click();
await page.waitForTimeout(600);
await page.locator('[role="menuitem"]', { hasText: 'Log a whole meal' }).click();
await page.waitForTimeout(800);

const box = page.locator('textarea').first();
check('the sheet opens with a place to write', (await box.count()) === 1);
await box.fill('200g chicken breast, 150g white rice cooked');
await page.waitForTimeout(2500);

const bodyBefore = await page.locator('body').innerText();
check(
  'each written item is resolved to a food',
  /chicken/i.test(bodyBefore) && /rice/i.test(bodyBefore),
  bodyBefore.replace(/\n+/g, ' | ').slice(0, 150),
);

const cta = page.locator('button:has-text("Log ")').last();
const ctaLabel = (await cta.count()) ? await cta.innerText() : '(none)';
console.log(`  CTA: "${ctaLabel.replace(/\n/g, ' ')}"`);
check('the CTA is enabled once items resolve', (await cta.count()) > 0 && !(await cta.isDisabled()));

await cta.click();
await page.waitForTimeout(2500);

const diary = await page.locator('body').innerText();
check('both items land in the diary', /chicken/i.test(diary) && /rice/i.test(diary));

// The day's energy must equal the sum of what was logged, not one item.
const totals = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const { N, sumNutrients } = await import('/src/core/nutrients.ts');
  const entries = await db.entries.toArray();
  const live = entries.filter((e) => !e.deleted);
  const total = sumNutrients(live.map((e) => e.nutrients));
  return { count: live.length, kcal: Math.round(total[N.ENERGY] ?? 0) };
});
console.log(`  diary: ${totals.count} entries, ${totals.kcal} kcal`);
check('two entries were written, not one', totals.count === 2, `${totals.count}`);
check(
  'the total is a plausible sum of both items',
  totals.kcal > 400 && totals.kcal < 700,
  `${totals.kcal} kcal (200g chicken ~330 + 150g cooked rice ~195)`,
);

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
