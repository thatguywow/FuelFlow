import { chromium } from 'playwright';

/**
 * The portion picker's text and its arrow must not share pixels.
 *
 * This is the bug that took three attempts: the platform draws the dropdown
 * indicator *over* the select's own box, so a long portion name ran underneath
 * it. Every previous fix was judged by eye on a screenshot. This measures the
 * two boxes instead — the select's text area against the indicator — and fails
 * if they overlap, on whatever food has the longest portion name.
 */
const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 360, height: 780 }, // deliberately narrow
  isMobile: true,
  hasTouch: true,
  colorScheme: 'dark',
});
page.on('pageerror', (e) => console.log(`  [pageerror] ${String(e).slice(0, 200)}`));

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
if (await page.locator('button:text-is("Set up")').count()) {
  await page.locator('button:text-is("Set up")').click();
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(250);
    const n = page.locator('button:text-is("Continue")');
    if (await n.count()) await n.click();
  }
  await page.waitForTimeout(300);
  await page.locator('button:text-is("Start tracking")').click();
  await page.locator('text=MACRONUTRIENTS').waitFor({ timeout: 30_000 });
}
await page.evaluate(async () => {
  const seed = await import('/src/db/seed.ts');
  await seed.ensureCoreData();
});
await page.waitForTimeout(1200);

await page.locator('button[aria-label="Add to diary"]').click();
await page.waitForTimeout(500);
await page.locator('[role="menuitem"]', { hasText: 'Search foods' }).click();
await page.waitForTimeout(600);
// A record with a deliberately long portion name.
await page.locator('input').first().fill('chicken breast raw');
await page.locator('text=Generic foods').first().waitFor({ timeout: 30_000 });
await page.locator('[role="dialog"] button').filter({ hasText: 'Chicken' }).first().click();
await page.waitForTimeout(900);

const diag = await page.evaluate(() => {
  const selects = [...document.querySelectorAll('select')];
  return selects.map((s) => ({
    cls: s.className.slice(0, 60),
    parentCls: s.parentElement?.className.slice(0, 40),
    rect: (({ left, right, width }) => ({ left: Math.round(left), right: Math.round(right), width: Math.round(width) }))(s.getBoundingClientRect()),
    parentRect: s.parentElement
      ? (({ left, right, width }) => ({ left: Math.round(left), right: Math.round(right), width: Math.round(width) }))(s.parentElement.getBoundingClientRect())
      : null,
  }));
});
console.log('  selects on page:', JSON.stringify(diag, null, 1));

const geometry = await page.evaluate(() => {
  const select = document.querySelector('select');
  if (!select) return { missing: true };
  const style = getComputedStyle(select);
  const box = select.getBoundingClientRect();
  const arrow = select.parentElement?.querySelector('svg')?.getBoundingClientRect();
  return {
    selectedText: select.options[select.selectedIndex]?.text ?? '',
    appearance: style.appearance || style.webkitAppearance,
    paddingRight: parseFloat(style.paddingRight),
    right: box.right,
    // Where the text is allowed to run to.
    textEdge: box.right - parseFloat(style.paddingRight),
    arrowLeft: arrow?.left ?? null,
    arrowRight: arrow?.right ?? null,
    width: box.width,
  };
});

check('the picker shows its selected portion', !geometry.missing && geometry.selectedText.length > 0, geometry.selectedText);
check(
  "the platform's own arrow is suppressed",
  geometry.appearance === 'none',
  `appearance: ${geometry.appearance}`,
);
check(
  'our indicator is drawn inside the reserved padding',
  geometry.arrowLeft !== null && geometry.arrowLeft >= geometry.textEdge - 1,
  `text may run to ${Math.round(geometry.textEdge)}px; arrow starts at ${Math.round(geometry.arrowLeft ?? 0)}px`,
);
check(
  'the indicator sits inside the control',
  geometry.arrowRight !== null && geometry.arrowRight <= geometry.right + 1,
  `arrow ends ${Math.round(geometry.arrowRight ?? 0)}px, control ends ${Math.round(geometry.right)}px`,
);

await page.screenshot({ path: 'shots/9f-portion-picker.png', clip: { x: 0, y: 60, width: 360, height: 260 } });
console.log('  wrote shots/9f-portion-picker.png');

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
