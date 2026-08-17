import { chromium } from 'playwright';

/**
 * Diary-day rules.
 *
 * A day is the user's local calendar day. Entries must land on the day being
 * viewed — not on whatever today happens to be — so a meal missed yesterday can
 * still be recorded, and tomorrow's can be entered in advance. The app must also
 * follow local midnight while it is left open.
 */
const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 412, height: 915 },
  isMobile: true,
  hasTouch: true,
  colorScheme: 'dark',
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log(`  [pageerror] ${String(e).slice(0, 200)}`));

// The dev server is used so the store module can be imported directly for the
// rollover check, rather than exposing it globally just to be testable.
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
  await page.waitForTimeout(1200);
}

const dayLabel = () => page.locator('header button span').first().innerText();
const next = page.locator('button[aria-label="Next day"]');
const prev = page.locator('button[aria-label="Previous day"]');

check('starts on Today', (await dayLabel()) === 'Today', await dayLabel());

// --- forward navigation, for pre-logging --------------------------------
await next.click();
await page.waitForTimeout(500);
check('can move forward to Tomorrow', (await dayLabel()) === 'Tomorrow', await dayLabel());

async function quickAdd(name, kcal) {
  await page.locator('button[aria-label="Add to diary"]').click();
  await page.waitForTimeout(500);
  await page.locator('[role="menuitem"]', { hasText: 'Quick calories' }).click();
  await page.waitForTimeout(700);
  await page.locator('label:has-text("Calories") input').fill(String(kcal));
  await page.locator('label:has-text("Name (optional)") input').fill(name);
  await page.waitForTimeout(400);
  const cta = page.locator('button:has-text("Add ")').last();
  const label = await cta.innerText();
  const disabled = await cta.isDisabled();
  console.log(`    (quickAdd "${name}": CTA "${label.replace(/\n/g, ' ')}" disabled=${disabled})`);
  await cta.click();
  // Wait for the row rather than sleeping. The core dataset is still seeding
  // in the background at this point, and a fixed pause raced it.
  await page.locator(`text=${name}`).first().waitFor({ timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(400);
}

await quickAdd('Prelog Dinner', 700);
let body = await page.locator('body').innerText();
check('pre-logged entry appears on Tomorrow', body.includes('Prelog Dinner'));

// It must NOT have landed on today.
await prev.click();
await page.waitForTimeout(800);
check('back on Today', (await dayLabel()) === 'Today', await dayLabel());
body = await page.locator('body').innerText();
check('pre-logged entry is not on Today', !body.includes('Prelog Dinner'));

// --- backward navigation, for a missed day ------------------------------
await prev.click();
await page.waitForTimeout(600);
check('can move back to Yesterday', (await dayLabel()) === 'Yesterday', await dayLabel());
await quickAdd('Missed Lunch', 450);
body = await page.locator('body').innerText();
check('back-logged entry appears on Yesterday', body.includes('Missed Lunch'));

await next.click();
await page.waitForTimeout(800);
body = await page.locator('body').innerText();
check('back-logged entry is not on Today', !body.includes('Missed Lunch'));

// --- weigh-in follows the selected day ----------------------------------
await prev.click();                                  // Yesterday
await page.waitForTimeout(600);
const yesterdayKey = await page.evaluate(() => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
});
await page.locator('nav button', { hasText: 'Body' }).first().click();
await page.waitForTimeout(900);
await page.locator('button:has-text("Weigh in")').click();
await page.waitForTimeout(700);
const dateValue = await page.locator('input[type="date"]').inputValue();
check('weigh-in defaults to the selected day', dateValue === yesterdayKey, `${dateValue} vs ${yesterdayKey}`);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// --- midnight rollover ---------------------------------------------------
const rolled = await page.evaluate(async () => {
  const { useUi } = await import('/src/state/ui.ts');
  const real = Date.prototype.getDate;
  const advance = () => {
    // eslint-disable-next-line no-extend-native
    Date.prototype.getDate = function () { return real.call(this) + 1; };
  };
  const restore = () => { Date.prototype.getDate = real; };

  // Sitting on today: the rollover should carry the user forward.
  useUi.setState({ day: useUi.getState().todayKey });
  const wasToday = useUi.getState().day;
  advance();
  useUi.getState().syncToday();
  const followed = useUi.getState().day;
  const newToday = useUi.getState().todayKey;
  restore();

  // Parked on another day: the rollover must not move the screen under them.
  useUi.setState({ day: '2020-01-01', todayKey: useUi.getState().todayKey });
  advance();
  useUi.getState().syncToday();
  const parked = useUi.getState().day;
  restore();

  return { wasToday, followed, newToday, parked };
});
check(
  'rolls the diary over at local midnight',
  rolled.followed === rolled.newToday && rolled.followed !== rolled.wasToday,
  JSON.stringify(rolled),
);
check(
  'rollover leaves a user who navigated elsewhere alone',
  rolled.parked === '2020-01-01',
  rolled.parked,
);

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
