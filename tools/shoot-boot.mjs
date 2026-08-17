import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

/** Catches the launch screen while it is still up. */
mkdirSync('shots', { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 412, height: 915 },
  isMobile: true,
  hasTouch: true,
  colorScheme: 'dark',
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
// Throttled hard so the loader is on screen long enough to photograph.
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 });

// Hold the bundle so the loader stays up long enough to photograph. Even at
// 20x throttle the app was mounting before the shutter.
await page.route('**/assets/*.js', (route) => setTimeout(() => route.abort(), 4000));
await page.goto('http://localhost:4173/app/', { waitUntil: 'commit' });
await page.locator('#boot').waitFor({ state: 'attached', timeout: 10_000 });
await page.waitForTimeout(700);
await page.screenshot({ path: 'shots/9d-boot-dark.png' });
console.log('wrote shots/9d-boot-dark.png');

await context.close();

const light = await browser.newContext({
  viewport: { width: 412, height: 915 },
  isMobile: true,
  colorScheme: 'light',
});
const lp = await light.newPage();
const lcdp = await light.newCDPSession(lp);
await lcdp.send('Emulation.setCPUThrottlingRate', { rate: 20 });
await lp.route('**/assets/*.js', (route) => setTimeout(() => route.abort(), 4000));
await lp.goto('http://localhost:4173/app/', { waitUntil: 'commit' });
await lp.locator('#boot').waitFor({ state: 'attached', timeout: 10_000 });
await lp.waitForTimeout(700);
await lp.screenshot({ path: 'shots/9e-boot-light.png' });
console.log('wrote shots/9e-boot-light.png');

await browser.close();
