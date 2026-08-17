import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

/**
 * Captures the barcode and label scanner HUDs.
 *
 * Chromium is given a synthetic camera (a moving test pattern) so the viewfinder
 * shows a live feed rather than a permission prompt, and permissions are granted
 * up front — otherwise every shot is just the "allow camera" state.
 */
mkdirSync('shots', { recursive: true });

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--allow-file-access-from-files',
  ],
});
const context = await browser.newContext({
  viewport: { width: 412, height: 915 },
  isMobile: true,
  hasTouch: true,
  colorScheme: 'dark',
  permissions: ['camera'],
  origins: undefined,
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log(`  [pageerror] ${String(e).slice(0, 300)}`));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log(`  [${m.type()}] ${m.text().slice(0, 220)}`);
});

await page.goto('http://localhost:4173/app/', { waitUntil: 'networkidle' });
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
  await page.waitForTimeout(1200);
}

async function openMenu() {
  await page.locator('button[aria-label="Add to diary"]').click();
  await page.waitForTimeout(700);
}

// --- the add menu itself, for context ---
await openMenu();
await page.screenshot({ path: 'shots/97-add-menu.png' });
const items = await page.locator('[role="menuitem"]').allInnerTexts();
console.log('menu items:', JSON.stringify(items));

async function openScanner(match, shot) {
  const entry = page.locator('[role="menuitem"]', { hasText: match });
  if (!(await entry.count())) {
    console.log(`  !! no menu item matching ${match}`);
    return false;
  }
  await entry.click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `shots/${shot}` });
  const text = (await page.locator('body').innerText()).replace(/\n+/g, ' | ').slice(0, 220);
  console.log(`${shot}: ${text}`);
  return true;
}

await openScanner('Scan barcode', '98-scanner-barcode.png');
await page.keyboard.press('Escape');
await page.waitForTimeout(800);

await openMenu();
await openScanner('Scan label', '99-scanner-label.png');

await browser.close();
console.log('done');
