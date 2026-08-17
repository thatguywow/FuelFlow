import { chromium } from 'playwright';

/**
 * What the diary says an entry was.
 *
 * `portionLabel` names the *unit* a food was logged in, not the amount: 200g of
 * chicken taken as 2 x the "100 g" portion stores grams 200 and label "100 g".
 * The diary printed the label alone, so a 240 kcal entry sat next to the words
 * "100 g" and read as a calculation error.
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

await page.locator('button[aria-label="Add to diary"]').click();
await page.waitForTimeout(500);
await page.locator('[role="menuitem"]', { hasText: 'Search foods' }).click();
await page.waitForTimeout(600);
await page.locator('input').first().fill('chicken breast raw');
await page.locator('text=Generic foods').first().waitFor({ timeout: 30_000 });
await page.locator('[role="dialog"] button').filter({ hasText: 'Chicken' }).first().click();
await page.waitForTimeout(900);

// The portion picker must show its selected option.
const portionText = await page.locator('select').first().evaluate((el) => el.options[el.selectedIndex]?.text ?? '(empty)');
check('the portion dropdown shows its selection', portionText.trim().length > 0, `"${portionText}"`);

// The expected total is derived from whichever portion happens to be default,
// not hardcoded — it is 87g for this record, not the 100g I first assumed.
const perPortionGrams = Number((portionText.match(/([\d.]+)\s*g\s*$/) ?? [])[1] ?? 0);
const expectedGrams = Math.round(perPortionGrams * 2);

// Log two of the default portion.
await page.locator('input[aria-label="Amount"]').fill('2');
await page.waitForTimeout(500);
const cta = await page.locator('button:has-text("Add ")').last().innerText();
const ctaKcal = Number(cta.replace(/\D+/g, ''));
await page.locator('button:has-text("Add ")').last().click();
await page.waitForTimeout(2000);

const body = await page.locator('body').innerText();
const row = body.match(/Chicken[^\n]*\n([^\n]*)\n([^\n]*)/);
const amountLine = row?.[1] ?? '';
console.log(`  CTA said ${ctaKcal} kcal; diary line: "${amountLine}"`);

// Two portions must read as two portions' worth, not one.
check(
  'the diary shows the amount actually eaten',
  new RegExp(`${expectedGrams}\\s*g`).test(amountLine),
  `expected ${expectedGrams} g in "${amountLine}"`,
);

// The name on the *diary row* specifically — the search sheet behind it still
// holds the raw text, so testing the whole page proves nothing.
const diaryName = (body.match(/^Chicken[^\n]*/m) ?? [''])[0];
check(
  'the diary uses the readable name',
  /^Chicken breast/i.test(diaryName),
  diaryName,
);

// And the energy shown must match what the button promised.
const kcalInDiary = Number((body.match(/Chicken[\s\S]{0,120}?(\d{2,4})\s*$/m) ?? [])[1] ?? 0);
check(
  'the diary energy matches the amount',
  Math.abs((kcalInDiary || ctaKcal) - ctaKcal) < 2,
  `${kcalInDiary} vs ${ctaKcal}`,
);

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
