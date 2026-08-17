import { chromium } from 'playwright';

/** Close-up of the app's bottom nav at true device pixels, no frame scaling. */
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 393, height: 873 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
  colorScheme: 'dark',
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

await page.screenshot({ path: 'shots/96-nav-closeup.png', clip: { x: 0, y: 700, width: 393, height: 173 } });

const nav = await page.evaluate(() => {
  const n = document.querySelector('nav');
  if (!n) return null;
  const r = n.getBoundingClientRect();
  const cs = getComputedStyle(n);
  return {
    top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height),
    viewportH: window.innerHeight,
    gapBelow: Math.round(window.innerHeight - r.bottom),
    position: cs.position, background: cs.backgroundColor, backdrop: cs.backdropFilter,
    paddingBottom: cs.paddingBottom,
  };
});
console.log(JSON.stringify(nav, null, 2));
await browser.close();
