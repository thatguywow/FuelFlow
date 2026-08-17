import { chromium } from 'playwright';

/**
 * What a one-word query should return.
 *
 * Search used to reward short names, and USDA writes its canonical entries as
 * the longest ones — so "apple" returned apple strudel, apple croissants and
 * three Applebee's dishes before it returned an apple, and "egg" returned egg
 * products before the egg. These assertions are the contract that replaced it.
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
if (await page.locator('button:text-is("Set up")').count()) {
  await page.locator('button:text-is("Set up")').click();
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(250);
    const next = page.locator('button:text-is("Continue")');
    if (await next.count()) await next.click();
  }
  await page.waitForTimeout(300);
  await page.locator('button:text-is("Start tracking")').click();
  await page.locator('text=MACRONUTRIENTS').waitFor({ timeout: 30_000 });
}
await page.evaluate(async () => {
  const { ensureCoreData } = await import('/src/db/seed.ts');
  await ensureCoreData(undefined, { force: true });
});
await page.waitForTimeout(1000);

const grading = await page.evaluate(async () => {
  const { headMatch, foodGrade, singular } = await import('/src/core/grading.ts');
  return {
    // The food itself versus a product containing it.
    apples: headMatch('Apples, raw, with skin', ['apple']),
    strudel: headMatch('Strudel, apple', ['apple']),
    // Exactly the food versus a variant of it.
    potatoes: headMatch('Potatoes, raw, skin', ['potato']),
    potatoFlour: headMatch('Potato flour', ['potato']),
    // A prefix is not a word.
    bread: headMatch('Bread, rye', ['bread']),
    breadfruit: headMatch('Breadfruit, raw', ['bread']),
    // Category grading.
    fruit: foodGrade('9'),
    restaurant: foodGrade('25'),
    plural: [singular('apples'), singular('potatoes'), singular('berries')],
  };
});

check('the food outranks a product containing it',
  grading.apples > grading.strudel, `apples ${grading.apples.toFixed(2)} vs strudel ${grading.strudel.toFixed(2)}`);
check('the plain food outranks a variant of it',
  grading.potatoes > grading.potatoFlour,
  `potatoes ${grading.potatoes.toFixed(2)} vs potato flour ${grading.potatoFlour.toFixed(2)}`);
check('a whole word outranks a mere prefix',
  grading.bread > grading.breadfruit, `bread ${grading.bread.toFixed(2)} vs breadfruit ${grading.breadfruit.toFixed(2)}`);
check('ingredients grade above restaurant dishes',
  grading.fruit > grading.restaurant, `${grading.fruit} vs ${grading.restaurant}`);
check('plurals reduce to the singular people type', grading.plural.join(',') === 'apple,potato,berry',
  grading.plural.join(','));

// ---------------------------------------------------------------------------
// End to end, against the real dataset
// ---------------------------------------------------------------------------

const ranked = await page.evaluate(async () => {
  const { searchLocal } = await import('/src/search/local.ts');
  const run = async (q) => (await searchLocal(q, { limit: 8, sources: ['usda'] })).map((h) => h.food.name);
  return {
    egg: await run('egg'),
    chicken: await run('chicken'),
    apple: await run('apple'),
    potato: await run('potato'),
    rice: await run('rice'),
    banana: await run('banana'),
    bread: await run('bread'),
    oats: await run('oats'),
  };
});

const report = (q) => ranked[q].slice(0, 3).map((n) => n.slice(0, 34)).join(' | ');

// The complaint that started this: "I look for an egg and I get egg products
// first and the actual whole raw egg last."
check('"egg" returns the whole raw egg first', /^Egg, whole, raw/.test(ranked.egg[0] ?? ''), report('egg'));
check('"egg" does not lead with the white or the yolk',
  !/yolk|^Egg, white/i.test(ranked.egg[0] ?? ''), ranked.egg[0] ?? '');

check('"chicken" returns actual chicken, not a meat analogue or offal',
  ranked.chicken.slice(0, 3).every((n) => !/meatless|liver|heart|giblets/i.test(n)), report('chicken'));

check('"apple" returns the fruit, not pastry or a restaurant dish',
  ranked.apple.slice(0, 3).every((n) => /^Apples/i.test(n)), report('apple'));

check('"potato" returns the vegetable, not flour or salad',
  /^Potatoes/i.test(ranked.potato[0] ?? ''), report('potato'));

check('"rice" returns rice, not rice crackers or rice flour',
  ranked.rice.slice(0, 3).every((n) => /^Rice,/i.test(n)), report('rice'));

check('"banana" returns the fruit first', /^Bananas, raw/.test(ranked.banana[0] ?? ''), report('banana'));

check('"bread" returns bread, not breadfruit',
  !/breadfruit/i.test(ranked.bread[0] ?? ''), report('bread'));

check('"oats" returns oats first', /^Oats/i.test(ranked.oats[0] ?? ''), report('oats'));

// Every result must still actually match the query — grading must not smuggle
// in high-grade foods that have nothing to do with what was typed.
const bogus = Object.entries(ranked).filter(([q, names]) =>
  names.some((n) => !n.toLowerCase().includes(q.replace(/s$/, ''))));
check('every result still contains the query', bogus.length === 0,
  bogus.map(([q]) => q).join(', ') || 'all clean');

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
