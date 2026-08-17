import { chromium } from 'playwright';

/**
 * Holding a diary entry must offer edit, move and delete — and moving must
 * carry the entry, not copy or lose it.
 *
 * Delete was previously a trash icon revealed on hover, so on a phone it did
 * not exist; moving between meals was impossible entirely.
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

// Plant one entry so the row exists regardless of search or network.
await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const { toDayKey } = await import('/src/core/dates.ts');
  await db.entries.clear();
  await db.entries.put({
    id: 'move-me',
    day: toDayKey(),
    mealId: 'lunch',
    foodId: 'none',
    name: 'Test Entry',
    grams: 100,
    nutrients: { 1008: 250 },
    loggedAt: Date.now(),
    updatedAt: Date.now(),
  });
});
await page.waitForTimeout(1200);

const row = page.locator('button', { hasText: 'Test Entry' }).first();
check('the entry is in the diary', (await row.count()) > 0);

// The overflow control must exist without hovering — the old trash icon did not.
const overflow = page.locator('button[aria-label="Options for Test Entry"]');
check('an options control is visible without hovering', (await overflow.count()) === 1);

await overflow.click();
await page.waitForTimeout(700);
const body = await page.locator('body').innerText();
check('offers edit', /Edit amount/i.test(body));
check('offers move', /Move to another meal/i.test(body));
check('offers delete', /Delete/i.test(body));

// Move it to Dinner.
await page.locator('button:has-text("Move to another meal")').click();
await page.waitForTimeout(500);
await page.locator('[role="dialog"] button', { hasText: 'Dinner' }).first().click();
await page.waitForTimeout(1500);

const after = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const all = await db.entries.toArray();
  const live = all.filter((e) => !e.deleted);
  return { count: live.length, mealId: live[0]?.mealId, name: live[0]?.name, kcal: live[0]?.nutrients?.[1008] };
});

check('the entry moved to the chosen meal', after.mealId === 'dinner', `now in ${after.mealId}`);
check('it moved rather than copied', after.count === 1, `${after.count} entries`);
check('its nutrition survived the move', after.kcal === 250, `${after.kcal} kcal`);

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
