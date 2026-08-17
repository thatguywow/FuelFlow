import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

/**
 * Captures the device-preview harness at several window widths, since the point
 * of the frame is that it survives a narrow pane as well as a wide one.
 */
const OUT = process.argv[2] ?? 'shots';
mkdirSync(OUT, { recursive: true });

const WIDTHS = [
  { w: 620, h: 900, name: '90-device-narrow' },
  { w: 1100, h: 1150, name: '91-device-wide' },
];

const browser = await chromium.launch();

for (const [index, size] of WIDTHS.entries()) {
  const page = await browser.newPage({ viewport: { width: size.w, height: size.h }, colorScheme: 'dark' });
  await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  const app = page.frameLocator('#app');
  if (index === 0 && (await app.locator('button:text-is("Set up")').count())) {
    await app.locator('button:text-is("Set up")').click();
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(200);
      const next = app.locator('button:text-is("Continue")');
      if (await next.count()) await next.click();
    }
    await page.waitForTimeout(250);
    await app.locator('button:text-is("Start tracking")').click();
    // Wait for real content, not a fixed delay — a timeout here catches the
    // skeletons and produces a shot of empty cards.
    await app.locator('text=MACRONUTRIENTS').waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1200);
  }

  // The frame must never itself scroll sideways.
  const scrolls = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  console.log(`${size.name}: ${size.w}px viewport — horizontal scroll: ${scrolls ? 'YES (bad)' : 'no'}`);

  await page.screenshot({ path: `${OUT}/${size.name}.png` });
  await page.close();
}

await browser.close();
console.log(`wrote ${WIDTHS.length} shots to ${OUT}`);
