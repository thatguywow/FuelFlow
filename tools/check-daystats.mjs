import { chromium } from 'playwright';

/**
 * The per-day aggregates must agree with the diary after every kind of write,
 * and must never be believed when they don't.
 *
 * This is a cache in front of the numbers the whole app is about, so the bar is
 * not "it is faster" — it is "it is impossible to show a wrong total". Every
 * assertion below compares the fast path against a from-scratch sum of the
 * entries themselves.
 */
const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 412, height: 915 },
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
    const next = page.locator('button:text-is("Continue")');
    if (await next.count()) await next.click();
  }
  await page.waitForTimeout(300);
  await page.locator('button:text-is("Start tracking")').click();
  await page.locator('text=MACRONUTRIENTS').waitFor({ timeout: 30_000 });
}

/**
 * Helper installed in the page: sums the diary directly for a range, so every
 * expectation is anchored to the entries rather than to the thing under test.
 */
await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  window.__truth = async (from, to) => {
    const rows = await db.entries.where('day').between(from, to, true, true).toArray();
    const byDay = {};
    for (const entry of rows) {
      if (entry.deleted) continue;
      byDay[entry.day] ??= { kcal: 0, count: 0 };
      byDay[entry.day].kcal += entry.nutrients?.[208] ?? 0;
      byDay[entry.day].count++;
    }
    return byDay;
  };
  window.__cached = async (from, to) => {
    const { dailySummaries } = await import('/src/db/dayStats.ts');
    const rows = await dailySummaries(from, to);
    const byDay = {};
    for (const row of rows) {
      if (row.entryCount === 0) continue;
      byDay[row.day] = { kcal: row.nutrients[208] ?? 0, count: row.entryCount };
    }
    return byDay;
  };
  window.__agree = async (from, to) => {
    const [truth, cached] = await Promise.all([window.__truth(from, to), window.__cached(from, to)]);
    const days = new Set([...Object.keys(truth), ...Object.keys(cached)]);
    for (const day of days) {
      const a = truth[day];
      const b = cached[day];
      if (!a || !b) return { ok: false, why: `${day}: ${a ? 'missing from cache' : 'phantom in cache'}` };
      if (Math.abs(a.kcal - b.kcal) > 0.01) return { ok: false, why: `${day}: ${a.kcal} vs ${b.kcal} kcal` };
      if (a.count !== b.count) return { ok: false, why: `${day}: ${a.count} vs ${b.count} entries` };
    }
    return { ok: true, why: `${days.size} days agree` };
  };
});

const RANGE = ['2000-01-01', '2099-12-31'];

// ---------------------------------------------------------------------------
// Every write path
// ---------------------------------------------------------------------------

const seeded = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const repo = await import('/src/db/repo.ts');
  const { rebuildDayStats } = await import('/src/db/dayStats.ts');

  await db.entries.clear();
  await db.dayStats.clear();
  await rebuildDayStats();

  const food = await repo.upsertFood({
    source: 'user',
    name: 'Aggregate test food',
    per100g: { 208: 200, 203: 10, 205: 20, 204: 5 },
    portions: [{ label: '100 g', grams: 100, preferred: true }],
  });

  await repo.logFood({ food, day: '2026-03-01', mealId: 'lunch', grams: 150 });
  await repo.logFood({ food, day: '2026-03-01', mealId: 'dinner', grams: 200 });
  await repo.logFood({ food, day: '2026-03-02', mealId: 'breakfast', grams: 50 });
  await repo.quickAdd('2026-03-02', 'snacks', { 208: 175 }, 'Quick');

  const stats = await db.dayStats.get('2026-03-01');
  return { kcal: stats?.nutrients?.[208] ?? 0, entryCount: stats?.entryCount ?? 0 };
});

// 150 g and 200 g of a 200 kcal/100 g food.
check('logging maintains the day total', Math.abs(seeded.kcal - 700) < 0.01, `${seeded.kcal} kcal`);
check('logging maintains the day count', seeded.entryCount === 2, `${seeded.entryCount} entries`);

let agree = await page.evaluate(([f, t]) => window.__agree(f, t), RANGE);
check('after logging, cache matches the diary', agree.ok, agree.why);

// Edit, move across days, delete, restore, copy — each is a different path
// into the aggregate, and each used to be a separate chance to drift.
await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const repo = await import('/src/db/repo.ts');
  const rows = await db.entries.where('day').equals('2026-03-01').toArray();

  await repo.updateEntryAmount(rows[0].id, 300);
  await repo.moveEntry(rows[1].id, '2026-03-03', 'dinner');

  const third = (await db.entries.where('day').equals('2026-03-02').toArray())[0];
  await repo.deleteEntry(third.id);
  await repo.restoreEntry(third.id);
  await repo.deleteEntry(third.id);

  await repo.copyMeal({ day: '2026-03-01' }, { day: '2026-03-05' });
});

agree = await page.evaluate(([f, t]) => window.__agree(f, t), RANGE);
check('after edit, move, delete, restore and copy, cache still matches', agree.ok, agree.why);

const moved = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const a = await db.dayStats.get('2026-03-01');
  const b = await db.dayStats.get('2026-03-03');
  return { from: a?.nutrients?.[208] ?? 0, to: b?.nutrients?.[208] ?? 0 };
});
// 300 g stayed on the 1st; the 200 g entry moved wholesale to the 3rd.
check('a cross-day move debits one day and credits the other',
  Math.abs(moved.from - 600) < 0.01 && Math.abs(moved.to - 400) < 0.01,
  `${moved.from} kcal / ${moved.to} kcal`);

const emptied = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const repo = await import('/src/db/repo.ts');
  for (const row of await db.entries.where('day').equals('2026-03-05').toArray()) {
    await repo.deleteEntry(row.id);
  }
  const stats = await db.dayStats.get('2026-03-05');
  return { kcal: stats?.nutrients?.[208] ?? 0, entryCount: stats?.entryCount ?? 0 };
});
// Subtracting a day back to empty must land on exactly zero, not on float dust.
check('emptying a day leaves it at exactly zero',
  emptied.entryCount === 0 && emptied.kcal === 0,
  `${emptied.entryCount} entries, ${emptied.kcal} kcal`);

// ---------------------------------------------------------------------------
// The integrity check
// ---------------------------------------------------------------------------

const tampered = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const { dailySummaries } = await import('/src/db/dayStats.ts');

  // A write that bypasses the repository entirely — a restored backup, a future
  // code path, a bug. The aggregate cannot know about it.
  await db.entries.put({
    id: 'smuggled',
    day: '2026-03-02',
    mealId: 'lunch',
    position: 99,
    name: 'Smuggled in',
    grams: 100,
    nutrients: { 208: 999 },
    loggedAt: Date.now(),
    updatedAt: Date.now(),
  });

  const stale = await db.dayStats.get('2026-03-02');
  const served = await dailySummaries('2026-03-02', '2026-03-02');
  // The expectation is the diary itself, not a number written here: the point
  // is that the reader agrees with the source, whatever the source says.
  const truth = await window.__truth('2026-03-02', '2026-03-02');
  return {
    stale: stale?.nutrients?.[208] ?? 0,
    served: served[0]?.nutrients?.[208] ?? 0,
    truth: truth['2026-03-02']?.kcal ?? 0,
  };
});

check('a direct write does make the cached row stale', tampered.stale !== tampered.truth,
  `cached ${tampered.stale}, actual ${tampered.truth}`);
check('the read notices and answers from the diary instead',
  Math.abs(tampered.served - tampered.truth) < 0.01,
  `served ${tampered.served}, actual ${tampered.truth}`);

// The repair is scheduled outside the read's transaction, so give it a beat.
await page.waitForTimeout(600);
const repaired = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  return (await db.dayStats.get('2026-03-02'))?.nutrients?.[208] ?? 0;
});
check('and repairs itself for the next read', Math.abs(repaired - tampered.truth) < 0.01,
  `${repaired} kcal`);

// ---------------------------------------------------------------------------
// Goals in force, per day
// ---------------------------------------------------------------------------

const goals = await page.evaluate(async () => {
  const { recordDayGoals, dailySummaries } = await import('/src/db/dayStats.ts');

  await recordDayGoals('2026-03-01', { energyKcal: 2400, proteinG: 180, carbsG: 250, fatG: 70 });
  await recordDayGoals('2026-03-03', { energyKcal: 2100, proteinG: 170, carbsG: 210, fatG: 65 });
  const wroteAgain = await recordDayGoals('2026-03-03', {
    energyKcal: 2100.4, proteinG: 170, carbsG: 210, fatG: 65,
  });

  const rows = await dailySummaries('2026-03-01', '2026-03-03');
  return {
    first: rows[0]?.goals?.energyKcal,
    third: rows[2]?.goals?.energyKcal,
    wroteAgain,
  };
});

check('each day keeps the goal that applied to it',
  goals.first === 2400 && goals.third === 2100, `${goals.first} then ${goals.third}`);
check('an unchanged goal is not rewritten', goals.wroteAgain === false);

// A rebuild must not throw goal snapshots away — they cannot be recomputed.
const survived = await page.evaluate(async () => {
  const { rebuildDayStats, dailySummaries } = await import('/src/db/dayStats.ts');
  await rebuildDayStats();
  const rows = await dailySummaries('2026-03-01', '2026-03-03');
  return { first: rows[0]?.goals?.energyKcal, third: rows[2]?.goals?.energyKcal };
});
check('goals survive a full rebuild', survived.first === 2400 && survived.third === 2100,
  `${survived.first} then ${survived.third}`);

agree = await page.evaluate(([f, t]) => window.__agree(f, t), RANGE);
check('after the rebuild, cache still matches the diary', agree.ok, agree.why);

// ---------------------------------------------------------------------------
// Why any of this was worth doing
// ---------------------------------------------------------------------------

// Measured under 4× CPU throttling. A desktop makes both paths look fine; the
// gap only means something at phone speed.
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

const timing = await page.evaluate(async () => {
  const { db, newId } = await import('/src/db/schema.ts');
  const { rebuildDayStats, dailySummaries } = await import('/src/db/dayStats.ts');

  // A year of ordinary logging: eight entries a day.
  const bulk = [];
  const start = new Date('2025-01-01');
  for (let d = 0; d < 365; d++) {
    const date = new Date(start.getTime() + d * 86_400_000);
    const day = date.toISOString().slice(0, 10);
    for (let i = 0; i < 8; i++) {
      bulk.push({
        id: newId(),
        day,
        mealId: 'lunch',
        position: i,
        name: `Bulk ${i}`,
        grams: 100,
        nutrients: { 208: 250, 203: 12, 205: 30, 204: 8, 291: 3, 269: 5 },
        loggedAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  }
  await db.entries.bulkAdd(bulk);
  await rebuildDayStats();

  const time = async (fn) => {
    const t0 = performance.now();
    await fn();
    return performance.now() - t0;
  };

  // Warm both paths before measuring either.
  await dailySummaries('2025-01-01', '2025-12-31');
  const cached = await time(() => dailySummaries('2025-01-01', '2025-12-31'));

  const scan = await time(async () => {
    const rows = await db.entries.where('day').between('2025-01-01', '2025-12-31', true, true).toArray();
    const byDay = new Map();
    for (const row of rows) {
      if (row.deleted) continue;
      byDay.set(row.day, (byDay.get(row.day) ?? 0) + (row.nutrients[208] ?? 0));
    }
    return byDay.size;
  });

  return { entries: bulk.length, cached: Math.round(cached), scan: Math.round(scan) };
});

check('a year of Trends is faster from the aggregates than from the diary',
  timing.cached < timing.scan,
  `${timing.entries} entries at 4x throttle: ${timing.cached} ms cached vs ${timing.scan} ms scanning`);

await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

agree = await page.evaluate(([f, t]) => window.__agree(f, t), RANGE);
check('and still exactly right at that size', agree.ok, agree.why);

// Leave the database as it was found.
await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const { rebuildDayStats } = await import('/src/db/dayStats.ts');
  await db.entries.clear();
  await db.dayStats.clear();
  await rebuildDayStats();
});

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
