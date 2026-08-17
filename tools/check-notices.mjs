import { chromium } from 'playwright';

/**
 * Dismissing a home-screen notice must actually dismiss it.
 *
 * The close button worked, wrote to storage and re-rendered — the notice
 * itself. The parent held the "should this be shown" check and never re-read
 * it, so nothing moved until a reload. A test that only asserted the button
 * exists would have passed throughout.
 */
const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 412, height: 915 },
  isMobile: true,
  hasTouch: true,
  colorScheme: 'dark',
});
const page = await context.newPage();
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
await page.waitForTimeout(1200);

// A fresh profile has no logging history, so the metabolism notice is showing.
const learning = page.locator('text=Learning your metabolism');
check('a fresh profile shows the metabolism notice', (await learning.count()) > 0);

const dismissers = page.locator('button[aria-label="Dismiss"]');
const before = await dismissers.count();
check('every notice offers a way to dismiss it', before > 0, `${before} on screen`);

await dismissers.first().click();
await page.waitForTimeout(600);

check('pressing it removes that notice immediately',
  (await dismissers.count()) === before - 1, `${await dismissers.count()} left`);
check('and the metabolism notice is the one that went',
  (await learning.count()) === 0);

// Dismiss whatever else is there, then prove it survives a reload.
//
// Bounded on purpose. With the bug present the count never falls, and an
// unbounded loop hangs the whole run instead of reporting a failure — which is
// exactly what happened when this was checked against the old code.
for (let i = 0; i < 8 && (await dismissers.count()) > 0; i++) {
  await dismissers.first().click();
  await page.waitForTimeout(400);
}
check('the home screen can be cleared of notices entirely',
  (await dismissers.count()) === 0);

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
check('they stay dismissed across a reload',
  (await page.locator('button[aria-label="Dismiss"]').count()) === 0);
check('and the diary is still there', (await page.locator('text=Diary').count()) > 0);

// A notice whose message changes is a different notice, and must come back.
const returns = await page.evaluate(() => {
  const raw = localStorage.getItem('ff.dismissedNotices');
  const keys = raw ? JSON.parse(raw) : [];
  // Keys carry what was said, not just that something was said.
  return keys.every((key) => /^(learning|warn):/.test(key)) && keys.length > 0;
});
check('dismissals are keyed by what the notice said', returns);

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
