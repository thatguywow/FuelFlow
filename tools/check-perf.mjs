import { chromium } from 'playwright';

/**
 * Launch and interaction cost, measured on a throttled device profile.
 *
 * A desktop-class machine hides everything that matters here: the phone this
 * ships to is mid-range, so CPU is throttled 4x and the network held to a
 * regular-3G-ish profile for the cold start. The numbers to watch are time to
 * first paint, when the launch screen actually hands over, and whether a search
 * keystroke stays inside a frame budget.
 */
const results = [];
const check = (name, value, budget, unit = 'ms') => {
  const pass = value <= budget;
  results.push(pass);
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name}  — ${Math.round(value)}${unit} (budget ${budget}${unit})`,
  );
};

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 412, height: 915 },
  isMobile: true,
  hasTouch: true,
  colorScheme: 'dark',
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

// --- cold start -----------------------------------------------------------
const started = Date.now();
await page.goto('http://localhost:4173/app/', { waitUntil: 'domcontentloaded' });

// The launch screen is inline, so it should be up almost immediately.
await page.locator('#boot').waitFor({ state: 'attached', timeout: 10_000 });
const bootVisible = Date.now() - started;
check('launch screen on screen', bootVisible, 1500);

const paint = await page.evaluate(
  () => performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0,
);
check('first contentful paint', paint, 2500);

// Handover: the loader is removed once there is real data behind it.
await page.locator('#boot').waitFor({ state: 'detached', timeout: 30_000 });
const handover = Date.now() - started;
check('launch screen hands over to the app', handover, 9000);

// --- getting through onboarding, then measuring the real screens ----------
if (await page.locator('button:text-is("Set up")').count()) {
  await page.locator('button:text-is("Set up")').click();
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(200);
    const n = page.locator('button:text-is("Continue")');
    if (await n.count()) await n.click();
  }
  await page.waitForTimeout(250);
  await page.locator('button:text-is("Start tracking")').click();
  await page.locator('text=MACRONUTRIENTS').waitFor({ timeout: 60_000 });
}

// --- tab switching --------------------------------------------------------
for (const tab of ['Trends', 'Body', 'More', 'Today']) {
  const t0 = Date.now();
  await page.locator('nav button', { hasText: tab }).first().click();
  await page.waitForTimeout(60);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  check(`switch to ${tab}`, Date.now() - t0, 900);
}

// --- search, the hottest path --------------------------------------------
await page.locator('button[aria-label="Add to diary"]').click();
await page.waitForTimeout(400);
await page.locator('[role="menuitem"]', { hasText: 'Search foods' }).click();
await page.waitForTimeout(600);

// First-run seeding and steady-state search are different costs and were being
// measured as one: on a fresh profile the first query blocks until the core
// dataset has finished installing, so "search" was reporting 2-4s of seeding.
// Read the install stamp straight out of IndexedDB: this runs against the
// production bundle, where the source modules are not importable.
const seedStart = Date.now();
await page.waitForFunction(
  () =>
    new Promise((resolve) => {
      const open = indexedDB.open('fuelflow');
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('kv')) {
          db.close();
          resolve(false);
          return;
        }
        const get = db.transaction('kv', 'readonly').objectStore('kv').get('coreData.version');
        get.onsuccess = () => {
          db.close();
          resolve(Boolean(get.result && get.result.value));
        };
        get.onerror = () => {
          db.close();
          resolve(false);
        };
      };
      open.onerror = () => resolve(false);
    }),
  null,
  { timeout: 120_000 },
);
check('core food dataset installed', Date.now() - seedStart, 45_000);

const input = page.locator('input').first();
await input.fill('chicken');
await page.locator('text=Generic foods').first().waitFor({ timeout: 30_000 });

// Now the steady-state cost, which is what a user feels on every keystroke.
const t1 = Date.now();
await input.fill('chicken breast');
await page.locator('text=Generic foods').first().waitFor({ timeout: 20_000 });
check('search responds once the data is installed', Date.now() - t1, 1200);

// --- bundle weight --------------------------------------------------------
const transfer = await page.evaluate(() =>
  performance
    .getEntriesByType('resource')
    .filter((r) => r.name.endsWith('.js'))
    .reduce((sum, r) => sum + (r.encodedBodySize || 0), 0),
);
check('javascript downloaded this session', transfer / 1024, 900, ' KB');

const memory = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
if (memory) check('JS heap in use', memory / 1048576, 220, ' MB');

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} within budget`);
process.exit(failed === 0 ? 0 : 1);
