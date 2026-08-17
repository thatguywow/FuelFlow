import { chromium } from 'playwright';

/**
 * What happens when something throws.
 *
 * React unmounts the whole tree on an uncaught render error, so one bad value
 * anywhere replaced the entire app with a blank white screen — on a phone, with
 * no console and no way back but clearing the app's data. For something holding
 * months of a diary that is the worst failure available: the data is safe and
 * the user has no way to know it.
 */
const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 412, height: 915 }, colorScheme: 'dark' });
// The boundary logs deliberately; swallow that so it does not read as a failure.
page.on('pageerror', () => undefined);

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

check('the app renders normally to begin with',
  (await page.locator('body').innerText()).includes('MACRONUTRIENTS'));

/*
 * Break a screen for real rather than by injecting a component: plant a diary
 * entry whose nutrients are a shape the renderer cannot handle. This is the
 * class of failure that actually happens — bad data reaching a component — not
 * a synthetic `throw` in a test-only child.
 */
await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const { toDayKey } = await import('/src/core/dates.ts');
  await db.entries.put({
    id: 'poison',
    day: toDayKey(),
    mealId: 'lunch',
    position: 0,
    name: 'Poison entry',
    grams: 100,
    // Null rather than a nutrient vector. This is the shape real corruption
    // takes — a restored backup from an older schema, an interrupted write —
    // and every renderer that reads `nutrients[208]` throws on it.
    nutrients: null,
    loggedAt: Date.now(),
    updatedAt: Date.now(),
  });
});
await page.waitForTimeout(2000);

const body = await page.locator('body').innerText();
const blank = body.trim().length < 40;

check('the app does not go blank', !blank, `${body.trim().length} characters on screen`);
check('it explains what happened', /Something went wrong/i.test(body), body.split('\n')[0] ?? '');
check('it reassures that the diary is intact', /Nothing you have logged is affected/i.test(body));
check('it offers a way out',
  (await page.locator('button:has-text("Reload the app")').count()) > 0);

// The tab bar lives outside the per-tab boundary, so the rest of the app is
// still reachable while one screen is broken.
const navUsable = await page.locator('nav button', { hasText: 'More' }).count();
check('the rest of the app is still reachable', navUsable > 0, `${navUsable} nav buttons`);

if (navUsable > 0) {
  await page.locator('nav button', { hasText: 'More' }).click();
  await page.waitForTimeout(700);
  check('another tab still works', /Library|Display|Targets/i.test(await page.locator('body').innerText()));
}

await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  await db.entries.delete('poison');
});

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
