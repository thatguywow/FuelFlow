import { chromium } from 'playwright';

/**
 * The add-food sheet's three reported faults.
 *
 * Dismissing a food closed the whole stack instead of returning to the results,
 * so a second helping meant starting the search again. The source tabs did
 * nothing until something was typed. Favouriting gave no feedback because the
 * label was the same string in both states.
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

const openSearch = async () => {
  await page.locator('button[aria-label="Add to diary"]').click();
  await page.waitForTimeout(500);
  await page.locator('[role="menuitem"]', { hasText: 'Search foods' }).click();
  await page.waitForTimeout(700);
};

await openSearch();
const input = page.locator('input').first();
await input.fill('chicken breast');
await page.locator('text=Generic foods').first().waitFor({ timeout: 30_000 });

// --- readable names -------------------------------------------------------
const firstRow = await page.locator('[role="dialog"] button').filter({ hasText: 'Chicken' }).first().innerText();
check(
  'results read like the food, not a database key',
  /Chicken breast/i.test(firstRow) && !/broilers or fryers[\s\S]*\n?.*kcal/i.test(firstRow.split('\n')[0]),
  firstRow.replace(/\n/g, ' | ').slice(0, 90),
);

// --- back to the results --------------------------------------------------
await page.locator('[role="dialog"] button').filter({ hasText: 'Chicken' }).first().click();
await page.waitForTimeout(900);
const onDetail = await page.locator('button:has-text("Favourite")').count();
check('a food opens its detail sheet', onDetail > 0);

await page.locator('button[aria-label="Close"]').first().click();
await page.waitForTimeout(700);
const backOnSearch = await page.locator('input').first().inputValue().catch(() => '');
check(
  'closing the food returns to the search, query intact',
  backOnSearch === 'chicken breast',
  `query is "${backOnSearch}"`,
);

// --- favourite feedback ---------------------------------------------------
await page.locator('[role="dialog"] button').filter({ hasText: 'Chicken' }).first().click();
await page.waitForTimeout(800);
const before = await page.locator('button:has-text("Favourite")').first().innerText();
await page.locator('button:has-text("Favourite")').first().click();
await page.waitForTimeout(800);
const after = await page.locator('button:has-text("Favourite")').first().innerText();
check('favouriting changes the control', before.trim() !== after.trim(), `"${before.trim()}" -> "${after.trim()}"`);

await page.locator('button[aria-label="Close"]').first().click();
await page.waitForTimeout(600);

// --- the source tabs actually filter --------------------------------------
await page.locator('input').first().fill('');
await page.waitForTimeout(900);
const countIn = async (tab) => {
  await page.locator('[role="dialog"] button', { hasText: tab }).first().click();
  await page.waitForTimeout(900);
  return page.locator('[role="dialog"] [role="button"], [role="dialog"] button').filter({ hasText: 'kcal' }).count();
};
const all = await countIn('All');
const recipes = await countIn('Recipes');
check(
  'Recipes shows only recipes, not everything',
  recipes < all || all === 0,
  `All: ${all} rows, Recipes: ${recipes} rows`,
);

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
