import { chromium } from 'playwright';

/**
 * What does a Trends window actually cost?
 *
 * Daily totals are recomputed from the raw entries every time — there is no
 * stored per-day aggregate — so the cost scales with everything ever logged
 * inside the window, and it is paid again on every change because the query is
 * live. This plants a realistic history and times it.
 */
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 412, height: 915 }, colorScheme: 'dark' });
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

page.on('pageerror', (e) => console.log(`  [pageerror] ${String(e).slice(0, 200)}`));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const report = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const { dailySummaries } = await import('/src/db/repo.ts');

  await db.entries.clear();

  // A year of moderately heavy logging: 8 entries a day, each carrying the
  // nutrient set a real food does.
  const nutrients = {};
  for (let id = 1000; id < 1040; id++) nutrients[id] = Math.random() * 50;

  const rows = [];
  const today = new Date();
  for (let d = 0; d < 365; d++) {
    const date = new Date(today);
    date.setDate(date.getDate() - d);
    const p = (n) => String(n).padStart(2, '0');
    const day = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
    for (let i = 0; i < 8; i++) {
      rows.push({
        id: `bench-${d}-${i}`,
        day,
        mealId: 'lunch',
        foodId: `f-${i}`,
        name: `Bench food ${i}`,
        grams: 100,
        nutrients: { ...nutrients },
        loggedAt: date.getTime(),
        updatedAt: date.getTime(),
      });
    }
  }
  await db.entries.bulkPut(rows);

  const p = (n) => String(n).padStart(2, '0');
  const key = (offset) => {
    const date = new Date(today);
    date.setDate(date.getDate() - offset);
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  };

  const time = async (label, from, to) => {
    // Warm once, then measure three runs.
    await dailySummaries(from, to);
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      await dailySummaries(from, to);
      runs.push(performance.now() - t0);
    }
    return { label, ms: Math.round(Math.min(...runs)) };
  };

  return {
    entries: rows.length,
    windows: [
      await time('7 days', key(6), key(0)),
      await time('30 days', key(29), key(0)),
      await time('90 days', key(89), key(0)),
      await time('365 days', key(364), key(0)),
    ],
  };
});

console.log(`\n${report.entries} diary entries planted (a year at 8/day)\n`);
for (const w of report.windows) console.log(`  ${w.label.padEnd(9)} ${String(w.ms).padStart(5)} ms`);

await browser.close();
