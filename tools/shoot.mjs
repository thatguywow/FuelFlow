import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2] ?? 'shots';
const ONLY = process.argv[3];
mkdirSync(OUT, { recursive: true });

const BASE = 'http://localhost:5173';

/**
 * Seeds ~6 weeks of plausible history directly through the app's own
 * repository layer, so every screen has something real to render. Screens shot
 * against an empty database tell you nothing about how the design behaves.
 */
async function seed(page) {
  await page.evaluate(async () => {
    const repo = await import('/src/db/repo.ts');
    const { db } = await import('/src/db/schema.ts');
    const { toDayKey } = await import('/src/core/dates.ts');
    const seedMod = await import('/src/db/seed.ts');

    await Promise.all([
      db.entries.clear(), db.weights.clear(), db.usage.clear(),
      db.water.clear(), db.biometrics.clear(), db.dayMeta.clear(), db.fasts.clear(),
    ]);
    await seedMod.ensureCoreData();

    await repo.saveProfile({
      sex: 'male', birthYear: 1995, heightCm: 180, startWeightKg: 84,
      activity: 'moderate', useAdaptiveTdee: true, adaptSpeed: 'balanced',
      goal: { direction: 'lose', rateKgPerWeek: -0.45, targetWeightKg: 76 },
      manualEnergyKcal: undefined,
      macros: { template: 'high_protein', proteinGPerKg: 2.0, minFatGPerKg: 0.7, proteinFromLeanMass: false, manual: undefined },
      updatedAt: Date.now() + 1,
    });

    const day = (back) => { const d = new Date(); d.setDate(d.getDate() - back); return toDayKey(d); };

    // Deterministic wobble so runs are comparable.
    let s = 7;
    const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };

    const picks = ['chicken breast', 'oats', 'banana', 'rice', 'egg', 'yogurt', 'almond', 'salmon', 'broccoli', 'bread'];
    const found = {};
    for (const p of picks) {
      const hits = await (await import('/src/search/local.ts')).searchLocal(p, { limit: 1 });
      if (hits[0]) found[p] = hits[0].food;
    }
    const foods = Object.values(found);

    for (let back = 41; back >= 0; back--) {
      const d = day(back);
      // 84 kg trending to ~81.5 with daily water noise.
      await repo.logWeight(d, 84 - (41 - back) * 0.062 + (rnd() - 0.5) * 0.8);
      if (back === 0) continue;
      const meals = ['breakfast', 'lunch', 'dinner', 'snacks'];
      for (const meal of meals) {
        const n = 1 + Math.floor(rnd() * 2);
        for (let i = 0; i < n; i++) {
          const f = foods[Math.floor(rnd() * foods.length)];
          if (!f) continue;
          await repo.logFood({ food: f, day: d, mealId: meal, grams: 60 + Math.round(rnd() * 160), portionLabel: '100 g' });
        }
      }
      await repo.setDayComplete(d, true);
    }
    // Today: partially logged, which is the normal mid-day state.
    for (const meal of ['breakfast', 'lunch']) {
      const f = foods[Math.floor(rnd() * foods.length)];
      if (f) await repo.logFood({ food: f, day: day(0), mealId: meal, grams: 120, portionLabel: '100 g' });
    }
    await repo.addWater(day(0), 750);
    await repo.logBiometric(day(0), 'bodyFatPct', 18.4);
    await repo.logBiometric(day(0), 'waistCm', 84);
    await repo.logBiometric(day(1), 'waistCm', 84.5);
    await repo.logBiometric(day(5), 'waistCm', 85.2);
  });
}

const shots = [];
async function shot(page, name) {
  if (ONLY && !name.includes(ONLY)) return;
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  shots.push(file);
  console.log('  ' + file);
}

const tap = async (page, text) => {
  const el = page.locator(`button:text-is("${text}")`).first();
  if (await el.count()) { await el.click(); await page.waitForTimeout(700); return true; }
  return false;
};

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    // The profile default is "system", so without this every shot comes back in
    // light theme and the dark design never gets reviewed.
    colorScheme: process.env.SHOT_THEME === 'light' ? 'light' : 'dark',
    locale: 'en-GB',
  });

  page.on('console', (m) => { if (m.type() === 'error') console.log('  [console error]', m.text().slice(0, 160)); });
  page.on('pageerror', (e) => console.log('  [page error]', String(e).slice(0, 160)));

  console.log('Loading…');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // Onboarding, first run only.
  if (await page.locator('button:text-is("Set up")').count()) {
    await shot(page, '00-onboarding-welcome');
    await tap(page, 'Set up');
    await shot(page, '01-onboarding-about');
    await tap(page, 'Continue');
    await shot(page, '02-onboarding-activity');
    await tap(page, 'Continue');
    await tap(page, 'Continue');
    await shot(page, '03-onboarding-macros');
    await tap(page, 'Start tracking');
  }

  console.log('Seeding history…');
  await seed(page);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  console.log('Capturing…');
  await shot(page, '10-today');
  await page.evaluate(() => window.scrollTo(0, 700));
  await page.waitForTimeout(500);
  await shot(page, '11-today-meals');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);

  // The central add menu, expanded.
  const addBtn = page.locator('button[aria-label="Add to diary"]').first();
  if (await addBtn.count()) {
    await addBtn.click();
    await page.waitForTimeout(800);
    await shot(page, '12-add-menu');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }

  // Sheets
  if (await tap(page, 'All nutrients →')) { await shot(page, '20-nutrients'); await page.keyboard.press('Escape'); await page.waitForTimeout(500); }

  const target = page.locator('button', { hasText: /Target$/ }).first();
  if (await target.count()) {
    await target.click(); await page.waitForTimeout(900);
    await shot(page, '21-goals-auto');
    await tap(page, 'Set my own');
    await shot(page, '22-goals-custom');
    await page.keyboard.press('Escape'); await page.waitForTimeout(500);
  }

  if (await tap(page, 'Add food')) {
    await shot(page, '23-add-food-empty');
    await page.locator('input[inputmode="search"]').fill('chicken');
    await page.waitForTimeout(1200);
    await shot(page, '24-add-food-results');
    const first = page.locator('[role="dialog"] .overflow-y-auto button').first();
    if (await first.count()) { await first.click(); await page.waitForTimeout(900); await shot(page, '25-food-detail'); }
    await page.keyboard.press('Escape'); await page.waitForTimeout(400);
    await page.keyboard.press('Escape'); await page.waitForTimeout(500);
  }

  if (await tap(page, 'Quick log')) {
    await page.locator('textarea').fill('2 eggs, 60 g oats and a cup of milk');
    await page.waitForTimeout(1800);
    await shot(page, '26-quick-log');
    await page.keyboard.press('Escape'); await page.waitForTimeout(500);
  }

  // Tabs
  for (const [tab, name] of [['Trends', '30-trends'], ['Body', '40-body'], ['More', '50-more']]) {
    const t = page.locator('nav button', { hasText: tab }).first();
    if (await t.count()) {
      await t.click(); await page.waitForTimeout(1200);
      await shot(page, name);
      await page.evaluate(() => window.scrollTo(0, 900));
      await page.waitForTimeout(500);
      await shot(page, name + '-scrolled');
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(300);
    }
  }

  // Light theme
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  const today = page.locator('nav button', { hasText: 'Today' }).first();
  if (await today.count()) { await today.click(); await page.waitForTimeout(1000); }
  await shot(page, '60-today-light');

  // Desktop width
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.waitForTimeout(800);
  await shot(page, '70-desktop');

  await browser.close();
  console.log(`\n${shots.length} shots written to ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
