import { chromium } from 'playwright';

/**
 * Favourites, custom foods and recipes must have somewhere to live.
 *
 * Before this, favouriting only nudged a search ranking — there was no list to
 * open — and the Recipes tab was permanently empty because nothing could create
 * a recipe. Both looked like features and behaved like dead ends.
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

// Distinctive names so the ingredient search cannot accidentally match USDA.
await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const { upsertFood } = await import('/src/db/repo.ts');
  await db.recipes.clear();
  await db.usage.clear();
  for (const food of await db.foods.where('source').anyOf(['user', 'recipe']).toArray()) {
    await db.foods.delete(food.id);
  }
  await upsertFood({
    source: 'user',
    name: 'Zarquon beans',
    per100g: { 208: 120, 203: 8, 205: 18, 204: 1 },
    portions: [{ label: '100 g', grams: 100, preferred: true }],
  });
  await upsertFood({
    source: 'user',
    name: 'Zarquon oil',
    per100g: { 208: 900, 203: 0, 205: 0, 204: 100 },
    portions: [{ label: '100 g', grams: 100, preferred: true }],
  });
});
await page.waitForTimeout(600);

// ---------------------------------------------------------------------------
// The library exists and is reachable
// ---------------------------------------------------------------------------

await page.locator('nav button', { hasText: 'More' }).click();
await page.waitForTimeout(500);
const libraryRow = page.locator('button', { hasText: 'Your foods' }).first();
// Waited for, not slept on: the core dataset is still seeding in the
// background here and a fixed pause raced the first render of the tab.
await libraryRow.waitFor({ timeout: 20_000 }).catch(() => {});
check('More offers a way into your own foods', (await libraryRow.count()) > 0);

await libraryRow.click();
await page.waitForTimeout(700);
const dialog = page.locator('[role="dialog"]');
const sections = await dialog.innerText();
check('it has all three of them', /Favourites/.test(sections) && /My foods/.test(sections) && /Recipes/.test(sections));

await dialog.locator('button:text-is("My foods")').click();
await page.waitForTimeout(500);
const mine = await dialog.innerText();
check('custom foods are listed there', /Zarquon beans/.test(mine) && /Zarquon oil/.test(mine));

// ---------------------------------------------------------------------------
// Building a recipe
// ---------------------------------------------------------------------------

await dialog.locator('button:text-is("Recipes")').click();
await page.waitForTimeout(400);
check('an empty Recipes tab explains itself and offers a way out',
  /No recipes yet/.test(await dialog.innerText()));

await dialog.locator('button:has-text("Create a recipe")').first().click();
await page.waitForTimeout(700);

const builder = page.locator('[role="dialog"]');
check('the recipe builder opens', /New recipe/.test(await builder.innerText()));

await builder.locator('input[placeholder="Sunday chilli"]').fill('Zarquon stew');
await builder.locator('input[aria-label="Servings"]').fill('2');

const addIngredient = async (term, label) => {
  await builder.locator('input[placeholder="Search foods"]').fill(term);
  await page.waitForTimeout(900);
  await builder.locator('button', { hasText: label }).first().click();
  await page.waitForTimeout(400);
};
await addIngredient('zarquon beans', 'Zarquon beans');
await addIngredient('zarquon oil', 'Zarquon oil');

const withIngredients = await builder.innerText();
check('both ingredients are in the recipe',
  /Zarquon beans/.test(withIngredients) && /Zarquon oil/.test(withIngredients));

// 100 g of each: 120 + 900 = 1020 kcal, over two servings.
const cta = await builder.locator('footer button, button:has-text("Save")').last().textContent();
check('it costs out per serving before saving', /510/.test(cta ?? ''), cta ?? '');

await builder.locator('button:has-text("Save")').last().click();
await page.waitForTimeout(1500);

const saved = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const recipes = (await db.recipes.toArray()).filter((r) => !r.deleted);
  const mirror = await db.foods.where('[source+sourceId]').equals(['recipe', recipes[0]?.id ?? '']).first();
  return {
    count: recipes.length,
    name: recipes[0]?.name,
    servings: recipes[0]?.servings,
    ingredients: recipes[0]?.ingredients?.length,
    mirrored: Boolean(mirror),
    // 1020 kcal over 200 g raw.
    per100g: mirror?.per100g?.[208],
    servingPortion: mirror?.portions?.find((p) => p.preferred)?.grams,
  };
});

check('the recipe is saved', saved.count === 1 && saved.name === 'Zarquon stew', `${saved.count} recipes`);
check('with its ingredients and servings', saved.ingredients === 2 && saved.servings === 2,
  `${saved.ingredients} ingredients, ${saved.servings} servings`);
check('and mirrored into foods so it can be logged', saved.mirrored);
check('its nutrient density is computed from the total weight',
  Math.abs((saved.per100g ?? 0) - 510) < 1, `${saved.per100g} kcal/100 g`);
check('one serving is half the dish', saved.servingPortion === 100, `${saved.servingPortion} g`);

// ---------------------------------------------------------------------------
// It shows up where a recipe should
// ---------------------------------------------------------------------------

const listed = page.locator('[role="dialog"]');
await page.waitForTimeout(600);
check('the library lists it', /Zarquon stew/.test(await listed.innerText()));

await page.keyboard.press('Escape');
await page.waitForTimeout(500);
await page.locator('button[aria-label="Add to diary"]').click();
await page.waitForTimeout(500);
await page.locator('[role="menuitem"]', { hasText: 'Search foods' }).click();
await page.waitForTimeout(800);
const search = page.locator('[role="dialog"]');
await search.locator('button:text-is("Recipes")').click();
await page.waitForTimeout(500);
await search.locator('input[inputmode="search"]').fill('zarquon stew');
await page.waitForTimeout(1200);
check('the Recipes tab in search is no longer empty',
  /Zarquon stew/.test(await search.innerText()));

// Log it, to prove the mirror is a real, loggable food.
await search.locator('button', { hasText: 'Zarquon stew' }).first().click();
await page.waitForTimeout(800);
await page.locator('[role="dialog"] button', { hasText: /^Add /}).click();
await page.waitForTimeout(1200);

const logged = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const rows = (await db.entries.toArray()).filter((e) => !e.deleted && e.name === 'Zarquon stew');
  return { count: rows.length, kcal: rows[0]?.nutrients?.[208] };
});
check('a recipe can be logged like any other food', logged.count === 1, `${logged.count} entries`);
check('at its per-serving energy', Math.abs((logged.kcal ?? 0) - 510) < 1, `${logged.kcal} kcal`);

// ---------------------------------------------------------------------------
// Favourites now have a destination
// ---------------------------------------------------------------------------

await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const { toggleFavorite } = await import('/src/db/repo.ts');
  const beans = await db.foods.where('name').equals('Zarquon beans').first();
  await toggleFavorite(beans.id);
});
await page.waitForTimeout(500);

await page.locator('nav button', { hasText: 'More' }).click();
await page.waitForTimeout(400);
await page.locator('button', { hasText: 'Your foods' }).first().click();
await page.waitForTimeout(800);
const favSheet = page.locator('[role="dialog"]');
// The library reopens on the section last used — which is Recipes by now.
await favSheet.locator('button:text-is("Favourites")').click();
await page.waitForTimeout(500);
check('a favourited food appears under Favourites',
  /Zarquon beans/.test(await favSheet.innerText()));

await favSheet.locator('button[aria-label="Unfavourite Zarquon beans"]').click();
await page.waitForTimeout(900);
check('and unfavouriting removes it again',
  !/Zarquon beans/.test(await favSheet.innerText()));

// Tidy up after ourselves.
await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const { rebuildDayStats } = await import('/src/db/dayStats.ts');
  await db.recipes.clear();
  for (const food of await db.foods.where('source').anyOf(['user', 'recipe']).toArray()) {
    await db.foods.delete(food.id);
  }
  for (const entry of await db.entries.filter((e) => e.name === 'Zarquon stew').toArray()) {
    await db.entries.delete(entry.id);
  }
  await rebuildDayStats();
});

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
