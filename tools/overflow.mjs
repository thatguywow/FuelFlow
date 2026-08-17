import { chromium } from 'playwright';

/**
 * Finds anything that overflows the viewport horizontally, or sits closer to
 * the edge than the layout's own gutter. Run at the narrowest device we claim
 * to support — that is where crowding shows up first.
 */
const BASE = process.argv[2] ?? 'http://localhost:5173';
const WIDTH = Number(process.argv[3] ?? 360);
const GUTTER = 8; // anything inside this of either edge is too close

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: WIDTH, height: 780 },
  isMobile: true,
  hasTouch: true,
  colorScheme: 'dark',
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

if (await page.locator('button:text-is("Set up")').count()) {
  console.log('--- onboarding ---');
  await report(page, 'welcome');
  await page.locator('button:text-is("Set up")').click();
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(200);
    const next = page.locator('button:text-is("Continue")');
    if (await next.count()) await next.click();
  }
  await page.waitForTimeout(250);
  await page.locator('button:text-is("Start tracking")').click();
  await page.waitForTimeout(2000);
}

await page.evaluate(async () => {
  const seed = await import('/src/db/seed.ts');
  await seed.ensureCoreData();
});
await page.waitForTimeout(800);

for (const [tab, name] of [['Today', 'today'], ['Trends', 'trends'], ['Body', 'body'], ['More', 'more']]) {
  const t = page.locator('nav button', { hasText: tab }).first();
  if (await t.count()) {
    await t.click();
    await page.waitForTimeout(900);
    await report(page, name);
  }
}

// Sheets, which have their own padding and are easy to get wrong.
await page.locator('nav button', { hasText: 'Today' }).first().click();
await page.waitForTimeout(600);
await page.locator('button[aria-label="Add to diary"]').click();
await page.waitForTimeout(600);
await report(page, 'add-menu');
for (const item of ['Search foods', 'Quick calories', 'Log a whole meal']) {
  const entry = page.locator('[role="menuitem"]', { hasText: item });
  if (!(await entry.count())) continue;
  await entry.click();
  await page.waitForTimeout(900);
  await report(page, 'sheet: ' + item);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.locator('button[aria-label="Add to diary"]').click();
  await page.waitForTimeout(400);
}

await browser.close();

async function report(page, label) {
  const findings = await page.evaluate((gutter) => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.opacity === '0') continue;
      // Fixed chrome legitimately spans the full width.
      if (style.position === 'fixed') continue;

      const describe = () =>
        el.tagName.toLowerCase() +
        (el.className && typeof el.className === 'string'
          ? '.' + el.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.')
          : '') +
        ' — "' + (el.textContent ?? '').trim().slice(0, 28) + '"';

      // Real overflow is always worth reporting, whatever the element.
      if (r.right > vw + 0.5) {
        out.push({ kind: 'overflows right', by: Math.round(r.right - vw), el: describe() });
        continue;
      }
      if (r.left < -0.5) {
        out.push({ kind: 'overflows left', by: Math.round(-r.left), el: describe() });
        continue;
      }

      // Edge proximity only matters for things that are *seen* at the edge:
      // painted surfaces and text. Structural wrappers are meant to be
      // full-bleed and reporting them buries the real findings.
      const painted =
        style.backgroundImage !== 'none' ||
        (style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent') ||
        style.borderTopWidth !== '0px';
      const hasOwnText = [...el.childNodes].some(
        (n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 0,
      );
      if (!painted && !hasOwnText) continue;
      // Anything spanning essentially the whole width is deliberate.
      if (r.width >= vw - 1) continue;

      if (r.left < gutter) out.push({ kind: 'crowds left edge', by: Math.round(r.left), el: describe() });
      else if (vw - r.right < gutter) out.push({ kind: 'crowds right edge', by: Math.round(vw - r.right), el: describe() });
    }
    const scrolls = document.documentElement.scrollWidth > vw + 0.5;
    return { scrolls, scrollWidth: document.documentElement.scrollWidth, vw, out: out.slice(0, 8) };
  }, GUTTER);

  const flag = findings.scrolls ? `PAGE SCROLLS HORIZONTALLY (${findings.scrollWidth} > ${findings.vw})` : '';
  if (findings.out.length === 0 && !flag) {
    console.log(`  ok    ${label}`);
    return;
  }
  console.log(`  ISSUE ${label} ${flag}`);
  for (const f of findings.out) console.log(`          ${f.kind} by ${f.by}px: ${f.el}`);
}
