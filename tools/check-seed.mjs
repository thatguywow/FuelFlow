import { chromium } from 'playwright';

/**
 * Core-dataset seeding must be idempotent.
 *
 * It was not: two overlapping installs each saw an empty table, each minted its
 * own random ids for the same USDA records, and each wrote them — leaving 4,293
 * foods stored twice and listed twice in search, with nothing to ever clear it.
 * These drive the seeder the way that happened: concurrently, then again.
 */
const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 412, height: 915 }, colorScheme: 'dark' });
page.on('pageerror', (e) => console.log(`  [pageerror] ${String(e).slice(0, 200)}`));

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const census = async () =>
  page.evaluate(async () => {
    const { db } = await import('/src/db/schema.ts');
    const all = await db.foods.where('source').equals('usda').toArray();
    const bySource = new Map();
    for (const f of all) {
      const key = f.sourceId ?? f.name;
      bySource.set(key, (bySource.get(key) ?? 0) + 1);
    }
    const dupes = [...bySource.values()].filter((n) => n > 1).length;
    return { rows: all.length, distinct: bySource.size, duplicated: dupes };
  });

// Two installs racing, which is exactly how the duplicates were created.
await page.evaluate(async () => {
  const seed = await import('/src/db/seed.ts');
  await Promise.all([seed.ensureCoreData(), seed.ensureCoreData(), seed.ensureCoreData()]);
});
await page.waitForTimeout(1000);
const afterRace = await census();
check(
  'three concurrent installs write each food once',
  afterRace.duplicated === 0,
  `${afterRace.rows} rows / ${afterRace.distinct} distinct / ${afterRace.duplicated} duplicated`,
);

// And a forced re-install on top must not double anything either.
await page.evaluate(async () => {
  const seed = await import('/src/db/seed.ts');
  await seed.ensureCoreData(undefined, { force: true });
});
await page.waitForTimeout(1000);
const afterForce = await census();
check(
  'a forced re-install does not duplicate',
  afterForce.duplicated === 0 && afterForce.rows === afterRace.rows,
  `${afterForce.rows} rows / ${afterForce.duplicated} duplicated`,
);

// A record the user has logged against must keep its id across a re-install.
const idStable = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const before = await db.foods.where('source').equals('usda').first();
  const seed = await import('/src/db/seed.ts');
  await seed.ensureCoreData(undefined, { force: true });
  const after = await db.foods.get(before.id);
  return { kept: Boolean(after), id: before.id };
});
check('ids survive a re-install, so history stays attached', idStable.kept, idStable.id);

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
