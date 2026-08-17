import { chromium } from 'playwright';

/**
 * Exercises the label scanner and the scanner's torch control.
 *
 * The label sheet is the only route into the database for food with no barcode,
 * and its one piece of real arithmetic — converting per-serving values to the
 * per-100g the store keeps — is invisible until a number comes out wrong in the
 * diary. These log real entries and read the diary back.
 *
 * The torch button only renders when the video track reports the capability, and
 * no virtual webcam does, so the capability is stubbed to prove the control
 * appears and toggles rather than to test the camera itself.
 */
const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const context = await browser.newContext({
  viewport: { width: 412, height: 915 },
  isMobile: true,
  hasTouch: true,
  colorScheme: 'dark',
  permissions: ['camera'],
});

// Make the fake webcam claim a torch, so the control's own logic is exercised.
await context.addInitScript(() => {
  const orig = MediaStreamTrack.prototype.getCapabilities;
  MediaStreamTrack.prototype.getCapabilities = function () {
    const caps = orig ? orig.call(this) : {};
    return { ...caps, torch: true };
  };
  // Resolve rather than delegating: a virtual webcam rejects a torch
  // constraint, and the app is right to leave the button off when the device
  // refuses. Accepting it here is what a real phone does.
  const applied = [];
  MediaStreamTrack.prototype.applyConstraints = function (c) {
    applied.push(JSON.stringify(c));
    window.__torchCalls = applied;
    return Promise.resolve();
  };
});

const page = await context.newPage();
page.on('pageerror', (e) => console.log(`  [pageerror] ${String(e).slice(0, 200)}`));

await page.goto('http://localhost:4173/app/', { waitUntil: 'networkidle' });
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
  await page.waitForTimeout(1200);
}

const openMenu = async () => {
  await page.locator('button[aria-label="Add to diary"]').click();
  await page.waitForTimeout(600);
};

// --- torch ---------------------------------------------------------------
await openMenu();
await page.locator('[role="menuitem"]', { hasText: 'Scan barcode' }).click();
await page.waitForTimeout(2500);
const torch = page.locator('button[aria-label="Toggle flash"]');
check('scanner: flash control renders when the camera has one', (await torch.count()) === 1);
if (await torch.count()) {
  check('scanner: flash starts off', (await torch.getAttribute('aria-pressed')) === 'false');
  await torch.click();
  await page.waitForTimeout(500);
  check('scanner: flash toggles on', (await torch.getAttribute('aria-pressed')) === 'true');
  const calls = await page.evaluate(() => window.__torchCalls ?? []);
  check(
    'scanner: torch constraint reaches the track',
    calls.some((c) => c.includes('torch') && c.includes('true')),
    calls.at(-1),
  );
}
await page.keyboard.press('Escape');
await page.waitForTimeout(800);

// --- label scanner, per-100g ---------------------------------------------
async function fillLabel({ name, basis, servingG, kcal, protein }) {
  await openMenu();
  await page.locator('[role="menuitem"]', { hasText: 'Scan label' }).click();
  await page.waitForTimeout(900);
  await page.locator('input').first().fill(name);
  await page.locator('button:text-is(' + JSON.stringify(basis) + ')').click();
  await page.waitForTimeout(300);
  if (servingG) {
    await page.locator('input[placeholder="30"]').fill(String(servingG));
    await page.waitForTimeout(200);
  }
  await page.locator('label:has-text("Calories") input').fill(String(kcal));
  if (protein !== undefined) await page.locator('label:has-text("Protein (g)") input').fill(String(protein));
  await page.waitForTimeout(300);
}

await fillLabel({ name: 'Test Oatmilk', basis: '100 g / ml', kcal: 46, protein: 1 });
const cta1 = await page.locator('button:has-text("Save food and log it")').innerText();
check('label: CTA offers to save and log', cta1.includes('Save food and log it'), cta1.trim());
await page.locator('button:has-text("Save food and log it")').click();
await page.waitForTimeout(2000);

let diary = await page.locator('body').innerText();
check('label: per-100g entry lands in the diary', diary.includes('Test Oatmilk'), 'found');
check('label: per-100g logs 46 kcal for 100 g', /\b46\b/.test(diary), diary.match(/Test Oatmilk[\s\S]{0,60}/)?.[0]?.replace(/\n/g, ' '));

// --- label scanner, per-serving (the conversion that can go wrong) --------
await fillLabel({ name: 'Test Bar', basis: 'Serving', servingG: 30, kcal: 150 });
await page.locator('button:has-text("Save food and log it")').click();
await page.waitForTimeout(2000);

diary = await page.locator('body').innerText();
check('label: per-serving entry lands in the diary', diary.includes('Test Bar'), 'found');
// A 30 g serving at 150 kcal must log 150 kcal, not 150 kcal per 100 g (=45).
const barRow = diary.match(/Test Bar[\s\S]{0,80}/)?.[0]?.replace(/\n/g, ' ') ?? '';
check('label: per-serving logs the serving, not 100 g', /\b150\b/.test(barRow), barRow);

// --- serving size entered, then basis switched back to per-100g -----------
// The serving field is hidden in 100g mode, so a value left behind from an
// earlier choice is invisible to the user. What gets logged must follow the
// basis actually selected, not the stale field.
await openMenu();
await page.locator('[role="menuitem"]', { hasText: 'Scan label' }).click();
await page.waitForTimeout(900);
await page.locator('input').first().fill('Test Switch');
await page.locator('button:text-is("Serving")').click();
await page.waitForTimeout(300);
await page.locator('input[placeholder="30"]').fill('25');
await page.waitForTimeout(200);
await page.locator('button:text-is("100 g / ml")').click();   // switch back
await page.waitForTimeout(300);
await page.locator('label:has-text("Calories") input').fill('200');
await page.waitForTimeout(300);
const switchCta = await page.locator('button:has-text("Save food and log it")').innerText();
void switchCta;
await page.locator('button:has-text("Save food and log it")').click();
await page.waitForTimeout(2000);

diary = await page.locator('body').innerText();
const switchRow = diary.match(/Test Switch[\s\S]{0,80}/)?.[0]?.replace(/\n/g, ' ') ?? '';
check(
  'label: per-100g after entering a serving logs 100 g',
  switchRow.includes('100 g') && /\b200\b/.test(switchRow),
  switchRow,
);

await page.screenshot({ path: 'shots/9a-label-logged.png' });

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
