import { chromium } from 'playwright';

/**
 * Does the display name actually read like the food you asked for?
 *
 * Cases are taken verbatim from the shipped dataset. The rule being tested is
 * that the headline names the food a person would recognise, and that nothing
 * which changes what the food *is* — the cut, the preparation — gets demoted
 * into the detail line.
 */
const CASES = [
  {
    raw: 'Chicken, broilers or fryers, breast, meat only, raw',
    primary: 'Chicken breast, raw',
  },
  {
    raw: 'Chicken, broiler or fryers, breast, skinless, boneless, meat only, raw',
    primary: 'Chicken breast, skinless, boneless, raw',
  },
  {
    raw: 'Rice, white, short-grain, enriched, cooked',
    primary: 'Rice white, short-grain, cooked',
  },
  { raw: 'Bananas, raw', primary: 'Bananas, raw' },
  { raw: 'Olive oil', primary: 'Olive oil' },
  {
    raw: 'Fish, salmon, chum, raw',
    primary: 'Fish salmon, chum, raw',
  },
  {
    raw: 'Egg, whole, cooked, hard-boiled',
    primary: 'Egg whole, hard-boiled, cooked',
  },
];

const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const out = await page.evaluate(async (cases) => {
  const { displayName } = await import('/src/core/foodName.ts');
  return cases.map((c) => ({ ...c, got: displayName(c.raw) }));
}, CASES);

for (const c of out) {
  check(
    `"${c.raw.slice(0, 46)}${c.raw.length > 46 ? '…' : ''}"`,
    c.got.primary === c.primary,
    `expected: ${c.primary}\n        got:      ${c.got.primary}${c.got.detail ? `   [${c.got.detail}]` : ''}`,
  );
}

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
