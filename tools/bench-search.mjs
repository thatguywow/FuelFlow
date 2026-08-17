import { chromium } from 'playwright';

/**
 * Where does a search actually spend its time?
 *
 * Splits the local path into its two halves — pulling candidate keys out of the
 * index, and scoring them — so an optimisation targets whichever one is
 * actually the cost rather than the one that looks expensive.
 */
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 412, height: 915 }, colorScheme: 'dark' });
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.evaluate(async () => {
  const seed = await import('/src/db/seed.ts');
  await seed.ensureCoreData();
});
await page.waitForTimeout(1500);

const report = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const local = await import('/src/search/local.ts');

  const queries = ['chicken breast', 'egg', 'white rice cooked', 'banana', 'greek yoghurt'];
  const out = [];

  for (const q of queries) {
    const tokens = q.toLowerCase().split(/\s+/);

    // Half one: candidate keys from the multiEntry index.
    const t0 = performance.now();
    const keySets = await Promise.all(
      tokens.map((t) => db.foods.where('tokens').startsWith(t).limit(4000).primaryKeys()),
    );
    const t1 = performance.now();

    let driver = 0;
    for (let i = 1; i < keySets.length; i++) if (keySets[i].length < keySets[driver].length) driver = i;
    const unique = [...new Set(keySets[driver])];

    // Half two: hydrating those rows.
    const rows = await db.foods.bulkGet(unique);
    const t2 = performance.now();

    // The whole thing, as the app calls it.
    const t3 = performance.now();
    const hits = await local.searchLocal(q, { limit: 40 });
    const t4 = performance.now();

    out.push({
      q,
      candidates: unique.length,
      keysMs: Math.round(t1 - t0),
      hydrateMs: Math.round(t2 - t1),
      totalMs: Math.round(t4 - t3),
      hits: hits.length,
      rows: rows.length,
    });
  }
  return out;
});

console.log('query                    cands   keys  hydrate   total   hits');
for (const r of report) {
  console.log(
    `${r.q.padEnd(22)} ${String(r.candidates).padStart(6)} ${String(r.keysMs).padStart(6)} ${String(r.hydrateMs).padStart(8)} ${String(r.totalMs).padStart(7)} ${String(r.hits).padStart(6)}`,
  );
}

await browser.close();
