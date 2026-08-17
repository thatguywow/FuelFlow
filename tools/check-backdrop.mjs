import { chromium } from 'playwright';

/**
 * Is the missing nav blur real, or an artefact of the headless renderer?
 * Old headless Chromium has no backdrop-filter, so the @supports guard in
 * `glass` evaluates false there and the screenshots show unblurred bleed-through
 * that a real device would never render.
 */
for (const [label, args] of [
  ['default headless', []],
  ['headless + gpu-ish', ['--use-gl=swiftshader', '--enable-features=Vulkan']],
]) {
  const browser = await chromium.launch({ args });
  const page = await browser.newPage({ viewport: { width: 393, height: 873 }, colorScheme: 'dark' });
  await page.goto('http://localhost:4173/app/', { waitUntil: 'domcontentloaded' });
  const r = await page.evaluate(() => ({
    supportsPlain: CSS.supports('backdrop-filter', 'blur(1px)'),
    supportsWebkit: CSS.supports('-webkit-backdrop-filter', 'blur(1px)'),
    ua: navigator.userAgent.match(/(Headless)?Chrome\/[\d.]+/)?.[0],
  }));
  console.log(`${label}: ${JSON.stringify(r)}`);
  await browser.close();
}
