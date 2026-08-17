import { chromium } from 'playwright';

/**
 * Search quality probe.
 *
 * Runs real queries through the shipped search module and prints what a user
 * would actually see, ranked. The question it exists to answer is whether
 * ordinary phrasing finds the right food — nobody types "Chicken, broilers or
 * fryers, breast, meat only, raw", they type "chicken breast raw".
 */
const QUERIES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'chicken breast raw skinless',
      'chicken breast',
      'raw chicken breast',
      'skinless chicken breast raw',
      'white rice cooked',
      'greek yoghurt',
      'greek yogurt',
      'olive oil',
      'banana',
      'egg boiled',
      'oats',
      'salmon fillet',
      'cheddar',
      'brown rice',
    ];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 412, height: 915 }, colorScheme: 'dark' });
page.on('pageerror', (e) => console.log(`  [pageerror] ${String(e).slice(0, 200)}`));

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// Make sure the bundled USDA core set is installed before querying it.
await page.evaluate(async () => {
  const seed = await import('/src/db/seed.ts');
  await seed.ensureCoreData();
});
await page.waitForTimeout(1200);

for (const query of QUERIES) {
  // The sheet asks for 40 and renders them grouped by tier, so judging the
  // ranking on a flat top-8 hides whatever the user would actually see under
  // "Generic foods".
  const hits = await page.evaluate(async (q) => {
    const mod = await import('/src/search/index.ts');
    const { N } = await import('/src/core/nutrients.ts');
    const found = await mod.search(q, { limit: 40 });
    return found.map((h) => ({
      name: h.food?.name ?? h.name,
      brand: h.food?.brand ?? h.brand,
      tier: h.tier,
      kcal: Math.round(h.food?.per100g?.[N.ENERGY] ?? 0),
      score: typeof h.score === 'number' ? Number(h.score.toFixed(1)) : undefined,
    }));
  }, query);

  console.log(`\n"${query}"`);
  if (hits.length === 0) {
    console.log('   (nothing)');
    continue;
  }
  for (const tier of ['personal', 'core', 'remote', 'online']) {
    const inTier = hits.filter((h) => h.tier === tier).slice(0, 4);
    if (inTier.length === 0) continue;
    console.log(`  ${tier}:`);
    for (const h of inTier) {
      const brand = h.brand ? ` · ${h.brand}` : '';
      console.log(`     ${h.name}${brand}  — ${h.kcal} kcal  (${h.score})`);
    }
  }
}

await browser.close();
