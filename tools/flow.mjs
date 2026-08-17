import { chromium } from 'playwright';

/**
 * End-to-end checks for the entry flows.
 *
 * Screenshots prove a screen renders; these prove it actually does something.
 * Run against the dev server: `node tools/flow.mjs`.
 */

const BASE = 'http://localhost:5173';
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
    locale: 'en-GB',
  });
  page.on('pageerror', (e) => check('no page errors', false, String(e).slice(0, 120)));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  // Onboarding, if this is a fresh profile.
  if (await page.locator('button:text-is("Set up")').count()) {
    await page.locator('button:text-is("Set up")').click();
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(180);
      const next = page.locator('button:text-is("Continue")');
      if (await next.count()) await next.click();
    }
    await page.waitForTimeout(200);
    await page.locator('button:text-is("Start tracking")').click();
    await page.waitForTimeout(1500);
  }

  await page.evaluate(async () => {
    const seed = await import('/src/db/seed.ts');
    await seed.ensureCoreData();
  });
  await page.waitForTimeout(800);

  // ---- Search regression: complete and half-typed must agree ---------------
  const search = await page.evaluate(async () => {
    const { searchLocal } = await import('/src/search/local.ts');
    const run = async (q) => (await searchLocal(q, { limit: 3 })).map((h) => h.food.name);
    return {
      complete: await run('White Rice Cooked'),
      partial: await run('White Rice Cooke'),
      chicken: await run('chicken breast cooked'),
    };
  });
  check('search: "White Rice Cooked" returns results', search.complete.length > 0, search.complete[0] ?? 'none');
  check(
    'search: complete and half-typed agree',
    JSON.stringify(search.complete) === JSON.stringify(search.partial),
  );
  check('search: "chicken breast cooked" returns results', search.chicken.length > 0, search.chicken[0] ?? 'none');

  // ---- Add menu -----------------------------------------------------------
  const fab = page.locator('button[aria-label="Add to diary"]');
  check('add button exists', (await fab.count()) === 1);
  await fab.click();
  await page.waitForTimeout(600);
  const items = await page.locator('[role="menuitem"]').allTextContents();
  // Named rather than counted: a bare count fails every time a route is added,
  // which says nothing about whether the menu is right.
  const expected = ['Search foods', 'Scan barcode', 'Scan label', 'Quick calories', 'Log a whole meal', 'Log exercise'];
  const missing = expected.filter((label) => !items.some((t) => t.includes(label)));
  check('add menu offers every way in', missing.length === 0, missing.join(', ') || items.length + ' items');
  // Water lives on the Today card, not in this menu — having it in both places
  // made the menu look padded.
  check('water is not duplicated in the menu', !items.some((t) => /^Water/.test(t.trim())));

  // ---- Quick calories -----------------------------------------------------
  await page.locator('[role="menuitem"]', { hasText: 'Quick calories' }).click();
  await page.waitForTimeout(800);
  const dialog = page.locator('[role="dialog"]');
  check('quick calories sheet opens', (await dialog.count()) === 1);

  await dialog.locator('input[inputmode="numeric"]').first().fill('640');
  await dialog.locator('button:text-is("Dinner")').click();
  await dialog.locator('input[placeholder="Restaurant meal"]').fill('Souvlaki');
  await dialog.locator('input[aria-label="Protein grams"]').fill('45');
  await page.waitForTimeout(500);

  const cta = await dialog.locator('button', { hasText: /^Add / }).textContent();
  check('CTA shows the total', /640/.test(cta ?? ''), cta ?? '');
  await dialog.locator('button', { hasText: /^Add / }).click();
  await page.waitForTimeout(1400);

  const body = await page.locator('body').innerText();
  check('quick entry appears in the diary', body.includes('Souvlaki'));
  // Meal headings are title case now, not the old uppercase section labels.
  const at = body.indexOf('Dinner');
  const dinnerBlock = body.slice(at, at + 90).replace(/\n+/g, ' | ');
  check('logged into the chosen meal', at >= 0 && dinnerBlock.includes('Souvlaki'), dinnerBlock);

  // ---- Label scanner ------------------------------------------------------
  await fab.click();
  await page.waitForTimeout(500);
  await page.locator('[role="menuitem"]', { hasText: 'Scan label' }).click();
  await page.waitForTimeout(900);
  const labelSheet = page.locator('[role="dialog"]');
  const labelTitle = await labelSheet.locator('h2').first().textContent();
  check('label scanner opens', labelTitle === 'Scan label', labelTitle ?? '');
  const webNotice = await labelSheet.innerText();
  check('label scanner explains the web limitation', webNotice.includes('native app'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // ---- Water: placement, editing and the rounding fix ---------------------
  const waterRow = page.locator('button', { hasText: /^Water/ }).first();
  check('water row is on the Today card', (await waterRow.count()) > 0);
  await waterRow.click();
  await page.waitForTimeout(800);
  const waterSheet = page.locator('[role="dialog"]');
  await waterSheet.locator('button:text-is("+250")').click();
  await page.waitForTimeout(700);
  const waterText = await waterSheet.innerText();
  // 250 ml used to render as "0.3 L", which looked like the app rounded up.
  check('250 ml is shown exactly, not rounded to 0.3 L', waterText.includes('250 ml'),
    waterText.split('\n').find((l) => /ml|L/.test(l)) ?? '');
  check('individual drinks are listed and removable',
    (await waterSheet.locator('button[aria-label^="Remove"]').count()) > 0);
  await waterSheet.locator('button[aria-label^="Remove"]').first().click();
  await page.waitForTimeout(600);
  check('a logged drink can be deleted',
    (await waterSheet.innerText()).includes('Nothing logged yet'));

  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
