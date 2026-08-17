import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

/** Screenshots of the new library and recipe builder. */
mkdirSync('shots', { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 412, height: 915 },
  isMobile: true,
  hasTouch: true,
  colorScheme: 'dark',
  deviceScaleFactor: 2,
});

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1800);

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
  const { db } = await import('/src/db/schema.ts');
  const { upsertFood, saveRecipe } = await import('/src/db/repo.ts');
  const { newId } = await import('/src/db/schema.ts');

  const beans = await upsertFood({
    source: 'user', name: 'Black beans, cooked',
    per100g: { 208: 132, 203: 8.9, 205: 23.7, 204: 0.5 },
    portions: [{ label: '100 g', grams: 100, preferred: true }],
  });
  const rice = await upsertFood({
    source: 'user', name: 'Brown rice, cooked',
    per100g: { 208: 123, 203: 2.7, 205: 25.6, 204: 1 },
    portions: [{ label: '100 g', grams: 100, preferred: true }],
  });
  const oil = await upsertFood({
    source: 'user', name: 'Olive oil',
    per100g: { 208: 884, 203: 0, 205: 0, 204: 100 },
    portions: [{ label: '1 tbsp', grams: 14, preferred: true }],
  });

  const ts = Date.now();
  const ingredient = (food, grams) => ({
    foodId: food.id, name: food.name, grams,
    nutrients: Object.fromEntries(
      Object.entries(food.per100g).map(([k, v]) => [k, (v * grams) / 100]),
    ),
  });
  await saveRecipe({
    id: newId(), name: 'Rice and beans', servings: 4,
    ingredients: [ingredient(beans, 400), ingredient(rice, 500), ingredient(oil, 28)],
    createdAt: ts, updatedAt: ts,
  });
  await db.usage.put({ foodId: beans.id, useCount: 6, lastUsedAt: ts, favorite: true, updatedAt: ts });
  await db.usage.put({ foodId: rice.id, useCount: 3, lastUsedAt: ts - 8.64e7, favorite: true, updatedAt: ts });
});
await page.waitForTimeout(900);

await page.locator('nav button', { hasText: 'More' }).click();
await page.waitForTimeout(600);
await page.locator('button', { hasText: 'Your foods' }).first().click();
await page.waitForTimeout(1000);

const sheet = page.locator('[role="dialog"]');
await sheet.locator('button:text-is("Favourites")').click();
await page.waitForTimeout(600);
await page.screenshot({ path: 'shots/library-favourites.png' });

await sheet.locator('button:text-is("Recipes")').click();
await page.waitForTimeout(700);
await page.screenshot({ path: 'shots/library-recipes.png' });

await sheet.locator('button[aria-label="Edit Rice and beans"]').click();
await page.waitForTimeout(1100);
await page.screenshot({ path: 'shots/recipe-builder.png' });

// Leave nothing behind.
await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  await db.recipes.clear();
  await db.usage.clear();
  for (const food of await db.foods.where('source').anyOf(['user', 'recipe']).toArray()) {
    await db.foods.delete(food.id);
  }
});

await browser.close();
console.log('wrote shots/library-favourites.png, shots/library-recipes.png, shots/recipe-builder.png');
