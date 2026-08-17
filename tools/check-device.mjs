import { chromium } from 'playwright';

/**
 * Guards the device preview against the failure that produced infinitely
 * nested frames: the app's service worker precached the origin root, which
 * under this server is the frame page, so the iframe was answered with another
 * frame. Checks nesting depth, that no worker registers, and that the frame
 * fits without a horizontal scrollbar.
 */
const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch();

for (const width of [620, 1100]) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: 'dark' });
  const page = await context.newPage();
  await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  // One frame for the page, one for the app. Anything more is recursion.
  const frames = page.frames().length;
  check(`${width}px: no nested frames`, frames <= 2, `${frames} frames`);

  const swCount = await page.evaluate(async () =>
    'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0,
  );
  check(`${width}px: no service worker registered`, swCount === 0, `${swCount} registrations`);

  const scrolls = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  check(`${width}px: frame fits without horizontal scroll`, !scrolls);

  // The iframe must be showing the app, not the harness.
  const inner = await page.frameLocator('#app').locator('body').innerText();
  check(`${width}px: iframe shows the app`, !inner.includes('Reset data'), inner.slice(0, 40).replace(/\n/g, ' '));

  // Every device, not just the default: the screen must stay inside the bezel,
  // and the whole frame must fit without the page scrolling.
  for (const id of ['pixel', 'iphone', 'small', 'tall', 'tablet']) {
    await page.selectOption('#device', id);
    await page.waitForTimeout(500);
    const g = await page.evaluate(() => {
      const p = document.getElementById('phone').getBoundingClientRect();
      const s = document.getElementById('screen').getBoundingClientRect();
      return {
        bottom: Math.round(s.bottom - p.bottom),
        right: Math.round(s.right - p.right),
        top: Math.round(p.top - s.top),
        scrollsY: document.documentElement.scrollHeight > window.innerHeight + 1,
      };
    });
    const contained = g.bottom <= 0 && g.right <= 0 && g.top <= 0;
    check(`${width}px/${id}: screen inside the bezel`, contained, `bottom ${g.bottom}, right ${g.right}`);
    check(`${width}px/${id}: frame fits vertically`, !g.scrollsY);
  }

  await context.close();
}

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
