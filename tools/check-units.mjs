import { chromium } from 'playwright';

/** What does switching to imperial actually change? Measured, not assumed. */
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
await page.waitForTimeout(1200);

const sample = async (label) => {
  // Body screen: the weight figure and its unit.
  await page.locator('nav button', { hasText: 'Body' }).first().click();
  await page.waitForTimeout(900);
  const bodyText = (await page.locator('body').innerText()).replace(/\n+/g, ' | ');
  const weight = bodyText.match(/([\d.]+)\s*\|?\s*(kg|lb)/i)?.[0] ?? 'not found';

  // A food's amounts.
  await page.locator('nav button', { hasText: 'Today' }).first().click();
  await page.waitForTimeout(700);
  await page.locator('button[aria-label="Add to diary"]').click();
  await page.waitForTimeout(500);
  await page.locator('[role="menuitem"]', { hasText: 'Search foods' }).click();
  await page.waitForTimeout(600);
  await page.locator('input').first().fill('banana');
  await page.locator('text=Generic foods').first().waitFor({ timeout: 30_000 });
  const row = await page.locator('[role="dialog"] button').filter({ hasText: 'Banana' }).first().innerText();
  await page.locator('[role="dialog"] button').filter({ hasText: 'Banana' }).first().click();
  await page.waitForTimeout(900);
  const portion = await page.locator('select').first().evaluate((el) => el.options[el.selectedIndex]?.text ?? '(empty)');
  const total = (await page.locator('body').innerText()).match(/[\d.]+\s*g\s+total/i)?.[0] ?? 'not found';
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  console.log(`\n${label}`);
  console.log(`  body weight   : ${weight}`);
  console.log(`  search row    : ${row.replace(/\n/g, ' | ').slice(0, 70)}`);
  console.log(`  portion option: ${portion}`);
  console.log(`  detail total  : ${total}`);
};

await sample('METRIC (default)');

// Flip to imperial the way the settings screen does.
await page.evaluate(async () => {
  const repo = await import('/src/db/repo.ts');
  const { readProfile } = repo;
  const profile = await readProfile();
  await repo.saveProfile({
    ...profile,
    display: { ...profile.display, unitSystem: 'imperial', massUnit: 'lb' },
  });
});
await page.waitForTimeout(1200);

await sample('IMPERIAL');

await browser.close();
