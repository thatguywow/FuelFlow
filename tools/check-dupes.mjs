import { chromium } from 'playwright';

/** Are duplicate search rows two records, or one record listed twice? */
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 412, height: 915 }, colorScheme: 'dark' });
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.evaluate(async () => {
  const seed = await import('/src/db/seed.ts');
  await seed.ensureCoreData();
});
await page.waitForTimeout(1500);

const report = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const all = await db.foods.where('source').equals('usda').toArray();
  const byName = new Map();
  for (const f of all) {
    const key = f.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push({ id: f.id, barcode: f.barcode });
  }
  const dupes = [...byName.entries()].filter(([, v]) => v.length > 1);
  return {
    total: all.length,
    distinctNames: byName.size,
    duplicateNames: dupes.length,
    duplicateRows: dupes.reduce((n, [, v]) => n + v.length - 1, 0),
    examples: dupes.slice(0, 6).map(([name, v]) => ({ name, ids: v.map((x) => x.id) })),
  };
});

console.log(JSON.stringify(report, null, 2));
await browser.close();
