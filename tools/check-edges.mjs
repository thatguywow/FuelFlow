import { chromium } from 'playwright';

/**
 * Asserts the top and bottom chrome keep clear of the display edges.
 *
 * `safe-t`/`safe-b` are emitted after the padding utilities, so a bare
 * `env(safe-area-inset-*)` — which is 0 without a notch — used to win the
 * cascade and zero out the screen's own `pt-*`/`p-*`, pinning content to the
 * edge. These measure the rendered result rather than trusting the classes.
 *
 * Full-bleed wrappers and decorative fixed overlays are excluded: they are
 * *meant* to span the display, and reporting them buries the real findings.
 */
const MIN = 10;

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
await page.goto('http://localhost:4173/app/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

async function edges(label) {
  const g = await page.evaluate(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    let top = Infinity, bottom = Infinity, topEl = '', bottomEl = '';
    // Content that scrolls beneath the tab bar is governed by the fade above it,
    // not by edge padding — measuring it just reports the scroll position.
    const navTop = document.querySelector('nav')?.getBoundingClientRect().top ?? vh;
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
      if (cs.pointerEvents === 'none') continue;          // decorative overlays
      if (r.width >= vw - 1 && r.height >= vh - 1) continue; // full-screen wrapper
      if (r.bottom > vh + 1 || r.top < -1) continue;      // scrolled out of view
      // Edge-anchored chrome is *meant* to meet the edge — a tab bar that
      // floated above it would look broken. Its contents are checked separately.
      if (cs.position === 'fixed' && (r.bottom >= vh - 1 || r.top <= 1)) continue;
      if (cs.position !== 'fixed' && r.bottom > navTop) continue; // scrolls under the bar

      // Only things the eye reads as an element.
      const paints =
        cs.backgroundImage !== 'none' ||
        (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') ||
        [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!paints) continue;

      const describe = () =>
        el.tagName.toLowerCase() +
        ' "' + (el.textContent ?? '').trim().slice(0, 20).replace(/\s+/g, ' ') + '"';
      if (r.top < top) { top = r.top; topEl = describe(); }
      if (vh - r.bottom < bottom) { bottom = vh - r.bottom; bottomEl = describe(); }
    }
    return { top: Math.round(top), bottom: Math.round(bottom), topEl, bottomEl };
  });
  check(`${label}: top clear`, g.top >= MIN, `${g.top}px — ${g.topEl}`);
  check(`${label}: bottom clear`, g.bottom >= MIN, `${g.bottom}px — ${g.bottomEl}`);

  // The tab bar spans to the edge by design, but its labels must not sit on it.
  const nav = await page.evaluate(() => {
    const n = document.querySelector('nav');
    if (!n) return null;
    const vh = window.innerHeight;
    let lowest = Infinity, which = '';
    for (const el of n.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.height < 3) continue;
      if (![...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) continue;
      if (vh - r.bottom < lowest) { lowest = vh - r.bottom; which = el.textContent.trim().slice(0, 12); }
    }
    return { gap: Math.round(lowest), which };
  });
  if (nav) check(`${label}: nav labels clear`, nav.gap >= MIN, `${nav.gap}px — "${nav.which}"`);
}

await edges('onboarding');

if (await page.locator('button:text-is("Set up")').count()) {
  await page.locator('button:text-is("Set up")').click();
  await page.waitForTimeout(500);
  await edges('onboarding step 2');
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

for (const [tab, name] of [['Today', 'today'], ['Trends', 'trends'], ['Body', 'body'], ['More', 'more']]) {
  const t = page.locator('nav button', { hasText: tab }).first();
  if (await t.count()) {
    await t.click();
    await page.waitForTimeout(1000);
    await edges(name);
  }
}

/**
 * The tab bar must own the bottom of the display outright.
 *
 * A pixel diff of the strip behind the bar was tried first and rejected: it
 * passed with the defect deliberately reinstated, because the page reserves
 * enough bottom padding that content clears the bar at rest, and the smearing
 * that made the bleed visible came from the preview's fractional downscale
 * rather than from the app at 1:1. These assertions check the two things that
 * are actually load-bearing — the bar reaches the bottom edge, and the bottom
 * row of pixels belongs to it — either of which failing is a real gap.
 */
await page.locator('nav button', { hasText: 'Today' }).first().click();
await page.waitForTimeout(900);
const navSeal = await page.evaluate(() => {
  const nav = document.querySelector('nav');
  const r = nav.getBoundingClientRect();
  const mid = Math.round(window.innerWidth / 2);
  const probes = [40, mid, window.innerWidth - 40].map((x) => {
    const el = document.elementFromPoint(x, window.innerHeight - 2);
    return el ? Boolean(el.closest('nav') || el.closest('[aria-label="Add to diary"]')) : false;
  });
  return {
    gapBelow: Math.round(window.innerHeight - r.bottom),
    bottomRowIsChrome: probes.every(Boolean),
    opacity: getComputedStyle(nav).backgroundColor,
  };
});
check('nav: no gap beneath the tab bar', navSeal.gapBelow === 0, `${navSeal.gapBelow}px`);
check('nav: the bottom row of pixels belongs to the bar', navSeal.bottomRowIsChrome);

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
