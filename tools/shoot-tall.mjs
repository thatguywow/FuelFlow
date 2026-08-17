import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

/** Reproduces the reported setup exactly: Xiaomi/tall in a 994x906 window. */
mkdirSync('shots', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 994, height: 906 }, colorScheme: 'dark' });
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.selectOption('#device', 'tall');
await page.waitForTimeout(800);
await page.screenshot({ path: 'shots/94-tall-welcome.png' });

const app = page.frameLocator('#app');
if (await app.locator('button:text-is("Set up")').count()) {
  await app.locator('button:text-is("Set up")').click();
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(250);
    const next = app.locator('button:text-is("Continue")');
    if (await next.count()) await next.click();
  }
  await page.waitForTimeout(300);
  await app.locator('button:text-is("Start tracking")').click();
  await app.locator('text=MACRONUTRIENTS').waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1200);
}
await page.screenshot({ path: 'shots/95-tall-today.png' });
console.log('wrote shots/94-tall-welcome.png and shots/95-tall-today.png');
await browser.close();
