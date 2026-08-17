import { chromium } from 'playwright';

/**
 * Cache pruning deletes rows, so what it must *not* delete matters more than
 * what it does. These plant a table of cached foods with known ages and
 * relationships, run the prune, and check each survivor and casualty by name.
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

const outcome = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const { pruneStaleFoods } = await import('/src/db/prune.ts');

  const DAY = 86_400_000;
  const now = Date.now();
  const ancient = now - 200 * DAY;

  await db.foods.clear();
  await db.usage.clear();
  await db.entries.clear();

  const food = (id, source, updatedAt, name) => ({
    id,
    source,
    name,
    per100g: { 1008: 100 },
    portions: [{ label: '100 g', grams: 100, preferred: true }],
    tokens: [name],
    createdAt: updatedAt,
    updatedAt,
  });

  const rows = [
    food('stale-off', 'off', ancient, 'stale off product'),
    food('stale-branded', 'branded', ancient, 'stale branded product'),
    food('fresh-off', 'off', now - 3 * DAY, 'fresh off product'),
    food('logged', 'off', ancient, 'logged long ago but in the diary'),
    food('favourite', 'off', ancient, 'old but favourited'),
    food('eaten-recently', 'off', ancient, 'cached long ago, eaten last week'),
    food('mine', 'user', ancient, 'my own food'),
    food('recipe', 'recipe', ancient, 'my recipe'),
    food('label', 'label', ancient, 'my scanned label'),
    food('usda', 'usda', ancient, 'bundled generic food'),
  ];

  // Padding so the table clears the floor below which pruning is not worth it.
  for (let i = 0; i < 500; i++) rows.push(food(`pad-${i}`, 'off', ancient, `padding ${i}`));

  await db.foods.bulkPut(rows);

  await db.usage.bulkPut([
    { foodId: 'favourite', useCount: 1, lastUsedAt: ancient, favorite: true, updatedAt: ancient },
    { foodId: 'eaten-recently', useCount: 4, lastUsedAt: now - 7 * DAY, updatedAt: now - 7 * DAY },
  ]);

  await db.entries.put({
    id: 'entry-1',
    day: '2020-01-01',
    mealId: 'lunch',
    foodId: 'logged',
    name: 'logged long ago but in the diary',
    grams: 100,
    nutrients: { 1008: 100 },
    loggedAt: ancient,
    updatedAt: ancient,
  });

  const before = await db.foods.count();
  const result = await pruneStaleFoods();
  const after = await db.foods.count();

  const survives = async (id) => Boolean(await db.foods.get(id));
  return {
    before,
    after,
    result,
    staleOff: await survives('stale-off'),
    staleBranded: await survives('stale-branded'),
    freshOff: await survives('fresh-off'),
    logged: await survives('logged'),
    favourite: await survives('favourite'),
    eatenRecently: await survives('eaten-recently'),
    mine: await survives('mine'),
    recipe: await survives('recipe'),
    label: await survives('label'),
    usda: await survives('usda'),
    orphanUsage: await db.usage.get('stale-off'),
  };
});

console.log(`  ${outcome.before} rows -> ${outcome.after} (removed ${outcome.result.removed})\n`);

check('stale cached OFF product is removed', outcome.staleOff === false);
check('stale cached branded product is removed', outcome.staleBranded === false);
check('recently cached product is kept', outcome.freshOff === true);
check('a food referenced by a diary entry is kept', outcome.logged === true, 'editing that entry re-reads the food');
check('a favourite is kept however old', outcome.favourite === true);
check('something eaten recently is kept', outcome.eatenRecently === true);
check('the user\'s own foods are never touched', outcome.mine === true);
check('recipes are never touched', outcome.recipe === true);
check('scanned labels are never touched', outcome.label === true);
check('the bundled USDA set is never touched', outcome.usda === true);
check('usage rows for deleted foods go too', outcome.orphanUsage === undefined);
check('something was actually removed', outcome.result.removed > 400, `${outcome.result.removed}`);

// ---------------------------------------------------------------------------
// The sidecar: seeing a cached food again must not rewrite it
// ---------------------------------------------------------------------------

const sidecar = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const { upsertFood } = await import('/src/db/repo.ts');

  await db.foods.clear();
  await db.foodMeta.clear();

  const draft = {
    source: 'off',
    sourceId: '5000112637922',
    barcode: '5000112637922',
    name: 'Cached product',
    brand: 'Brand',
    per100g: { 208: 42, 203: 1 },
    portions: [{ label: '100 g', grams: 100, preferred: true }],
    quality: 0.7,
  };

  const first = await upsertFood(draft);
  const afterFirst = await db.foods.get(first.id);

  // The same product coming back from a later search, byte for byte.
  await new Promise((r) => setTimeout(r, 25));
  const second = await upsertFood(draft);
  const afterSecond = await db.foods.get(second.id);
  const meta = await db.foodMeta.get(first.id);

  // Now something upstream actually changed.
  await new Promise((r) => setTimeout(r, 25));
  await upsertFood({ ...draft, per100g: { 208: 45, 203: 1 } });
  const afterChange = await db.foods.get(first.id);

  return {
    sameRow: first.id === second.id,
    untouched: afterFirst.updatedAt === afterSecond.updatedAt,
    seenLater: (meta?.seenAt ?? 0) > afterFirst.updatedAt,
    rewritten: afterChange.updatedAt > afterSecond.updatedAt,
    energy: afterChange.per100g[208],
    rows: await db.foods.count(),
  };
});

check('re-seeing a cached food reuses its row', sidecar.sameRow && sidecar.rows === 1, `${sidecar.rows} rows`);
check('and does not rewrite the food record', sidecar.untouched);
check('but does record that we saw it', sidecar.seenLater);
check('a genuine change is still written through', sidecar.rewritten && sidecar.energy === 45,
  `${sidecar.energy} kcal`);

await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  await db.foods.clear();
  await db.foodMeta.clear();
});

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
