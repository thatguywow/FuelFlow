import { chromium } from 'playwright';

/**
 * The five things reported from the phone.
 *
 * Each of these was visible on a device and invisible in every test we had,
 * which is the pattern worth closing: assert the property, not the screenshot.
 */
const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// A synthetic camera, so the viewfinder can actually be opened and inspected
// rather than having its source read.
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const page = await browser.newPage({
  viewport: { width: 412, height: 915 },
  isMobile: true,
  hasTouch: true,
  colorScheme: 'dark',
  permissions: ['camera'],
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

// ---------------------------------------------------------------------------
// 1. A footerless sheet must not end under the system navigation bar
// ---------------------------------------------------------------------------

await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const { toDayKey } = await import('/src/core/dates.ts');
  const { rebuildDayStats } = await import('/src/db/dayStats.ts');
  await db.entries.clear();
  await db.entries.put({
    id: 'polish-entry',
    day: toDayKey(),
    mealId: 'lunch',
    position: 0,
    name: 'Pomegranate Ginger&Lime',
    grams: 100,
    nutrients: { 208: 250 },
    loggedAt: Date.now(),
    updatedAt: Date.now(),
  });
  await rebuildDayStats();
});
await page.waitForTimeout(1200);

await page.locator('button[aria-label="Options for Pomegranate Ginger&Lime"]').click();
await page.waitForTimeout(800);

const spacing = await page.evaluate(() => {
  const dialog = document.querySelector('[role="dialog"]');
  const scroller = dialog?.querySelector('.no-scrollbar');
  const del = [...(dialog?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === 'Delete');
  return {
    padding: scroller ? parseFloat(getComputedStyle(scroller).paddingBottom) : -1,
    // How much room is left between the last control and the bottom of the
    // screen. On the phone this is what the navigation bar was eating.
    gapBelowDelete: del ? Math.round(window.innerHeight - del.getBoundingClientRect().bottom) : -1,
  };
});

check('a footerless sheet reserves the bottom inset', spacing.padding >= 24, `${spacing.padding}px`);
check('the last action clears the bottom edge', spacing.gapBelowDelete >= 24,
  `${spacing.gapBelowDelete}px below Delete`);

await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// ---------------------------------------------------------------------------
// 2. Viewfinders must never show the WebView's broken-media placeholder
// ---------------------------------------------------------------------------

const openViewfinder = async (kind) => {
  await page.evaluate(async (sheetKind) => {
    const { useUi } = await import('/src/state/ui.ts');
    const { toDayKey } = await import('/src/core/dates.ts');
    useUi.getState().openSheet({ kind: sheetKind, mealId: 'lunch', day: toDayKey() });
  }, kind);
  await page.waitForTimeout(900);
  // Headless Chromium reports "prompt" even with the permission granted on the
  // context, so the sheet asks first. On the phone this step has already
  // happened once and the viewfinder opens straight away.
  const allow = page.locator('button:text-is("Allow camera")');
  if (await allow.count()) {
    await allow.click();
    await page.waitForTimeout(1200);
  }
  await page.waitForTimeout(900);
  const found = await page.evaluate(() => {
    const video = document.querySelector('video');
    if (!video) return null;
    return { poster: video.getAttribute('poster') ?? '', background: getComputedStyle(video).backgroundColor };
  });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  return found;
};

const barcodeView = await openViewfinder('scanner');

check('the barcode viewfinder renders a video with a poster',
  (barcodeView?.poster ?? '').startsWith('data:image/'), barcodeView ? 'poster set' : 'no video element');
check('the video paints black rather than transparent while it opens',
  /rgb\(0,\s*0,\s*0\)/.test(barcodeView?.background ?? ''), barcodeView?.background ?? '');

// The label scanner only opens a preview on native — in a browser it goes
// straight to the typed form — so its viewfinder cannot be rendered here. The
// wiring is checked in the compiled module instead, which is weaker than the
// DOM assertion above but still catches the attribute being dropped.
const labelWiring = await page.evaluate(async () => {
  const source = await fetch('/src/screens/LabelScanner.tsx').then((r) => r.text());
  const { VIDEO_POSTER } = await import('/src/scan/barcode.ts');
  return {
    wired: /poster:\s*VIDEO_POSTER/.test(source),
    isImage: typeof VIDEO_POSTER === 'string' && VIDEO_POSTER.startsWith('data:image/'),
  };
});
check('the label viewfinder passes the same poster', labelWiring.wired && labelWiring.isImage);

// A cancelled play() is not a camera failure. This is what put the barcode
// scanner into "Cannot use the camera" instead of showing the viewfinder.
const playAbort = await page.evaluate(async () => {
  const source = await fetch('/src/scan/barcode.ts').then((r) => r.text());
  return {
    guarded: /AbortError/.test(source),
    // Both viewfinders go through the guard rather than calling play directly.
    routed: (source.match(/await startPlayback\(video\)/g) ?? []).length === 2,
  };
});
check('an interrupted play() is not reported as a camera failure',
  playAbort.guarded && playAbort.routed,
  `guard ${playAbort.guarded}, call sites routed ${playAbort.routed}`);

// ---------------------------------------------------------------------------
// 3 & 4. Names and portions on a USDA-shaped food
// ---------------------------------------------------------------------------

const food = await page.evaluate(async () => {
  const { upsertFood } = await import('/src/db/repo.ts');
  const made = await upsertFood({
    source: 'usda',
    sourceId: 'polish-chicken',
    name: 'Chicken, broiler or fryers, breast, skinless, boneless, meat only, raw',
    per100g: { 208: 120, 203: 22.5, 205: 0, 204: 2.6 },
    // Exactly the shape that produced "oz · 113 g": USDA marks the ounce
    // measure preferred on a great many foods.
    portions: [
      { label: 'oz', grams: 28.35 },
      { label: 'piece', grams: 113, preferred: true },
      { label: '100 g', grams: 100 },
    ],
  });
  return { id: made.id, name: made.name };
});
await page.waitForTimeout(400);

const naming = await page.evaluate(async () => {
  const { displayName } = await import('/src/core/foodName.ts');
  const { isImperialUnitPortion } = await import('/src/core/foodName.ts');
  const shown = displayName('Chicken, broiler or fryers, breast, skinless, boneless, meat only, raw');
  return {
    primary: shown.primary,
    strips: /broiler|meat only/i.test(shown.primary) === false,
    ozIsImperial: isImperialUnitPortion('oz') && isImperialUnitPortion('lb'),
    cupIsNot: isImperialUnitPortion('cup, chopped') === false,
  };
});
check('the headline drops the cataloguing clauses', naming.strips, naming.primary);
check('bare imperial units are recognised as unit conversions', naming.ozIsImperial);
check('but a real serving name is not', naming.cupIsNot);

// Open it and read what the picker actually defaults to.
await page.evaluate(async () => {
  const { useUi } = await import('/src/state/ui.ts');
  const { db } = await import('/src/db/schema.ts');
  const { toDayKey } = await import('/src/core/dates.ts');
  const target = await db.foods.where('[source+sourceId]').equals(['usda', 'polish-chicken']).first();
  useUi.getState().openSheet({ kind: 'food-detail', food: target, mealId: 'lunch', day: toDayKey() });
});
await page.waitForTimeout(900);

const detail = page.locator('[role="dialog"]');
const picker = await page.evaluate(() => {
  const select = document.querySelector('[role="dialog"] select[aria-label="Portion"]');
  const options = [...(select?.options ?? [])].map((o) => o.text);
  return { options, selected: select?.selectedOptions?.[0]?.text ?? '' };
});

check('metric drops the bare ounce measure from the picker',
  !picker.options.some((o) => /^oz\b/i.test(o)), picker.options.join(' | '));
check('and the default portion is not an ounce',
  !/oz/i.test(picker.selected), `defaults to "${picker.selected}"`);

const header = await detail.locator('h2').first().textContent();
const subline = await detail.evaluate((node) => {
  const p = node.querySelector('h2 + p');
  return p?.textContent ?? '';
});
check('the food detail header has no catalogue subline', subline.trim() === '',
  `header "${header}", subline "${subline}"`);

await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// ---------------------------------------------------------------------------
// 5. Search must publish each tier as it lands, and never sleep on the limiter
// ---------------------------------------------------------------------------

const gate = await page.evaluate(async () => {
  const { searchOnline, canSearchOnline, OffUnavailableError } = await import('/src/search/off.ts');
  const started = performance.now();
  let refusedInstantly = 0;
  await Promise.all(
    Array.from({ length: 9 }, (_, i) =>
      searchOnline(`throttle probe ${i}`, { limit: 1 }).catch((error) => {
        if (error instanceof OffUnavailableError) refusedInstantly++;
      }),
    ),
  );
  return {
    canSearch: canSearchOnline(),
    refusedInstantly,
    elapsed: Math.round(performance.now() - started),
  };
});

/*
 * A browser cannot text-search Open Food Facts at all: the search host sends no
 * CORS headers, so the request fails before any timeout of ours applies. The
 * app now knows that and declines up front rather than spending a guaranteed
 * failure — and a second one on the retired CGI endpoint — on every query.
 */
check('a browser knows it cannot text-search Open Food Facts', gate.canSearch === false);
check('so it refuses instantly instead of failing slowly',
  gate.refusedInstantly === 9 && gate.elapsed < 500,
  `${gate.refusedInstantly}/9 refused in ${gate.elapsed} ms`);

const progressive = await page.evaluate(async () => {
  const { searchTiered } = await import('/src/search/index.ts');
  const publishes = [];
  const started = performance.now();
  // A branded query the bundled USDA set cannot satisfy, so the network tiers
  // genuinely run. A query local data answers well short-circuits by design.
  await searchTiered(
    'kinder bueno white',
    (r) => publishes.push({ at: Math.round(performance.now() - started), n: r.hits.length, pending: r.pending }),
    { limit: 30 },
  );
  return { publishes, total: Math.round(performance.now() - started) };
});

const trail = progressive.publishes.map((p) => `${p.at}ms:${p.n}${p.pending ? '…' : ''}`).join(' → ');
// Either local answered it outright (one publish, no network), or the network
// tiers ran and each reported separately. Under `Promise.all` the second case
// produced exactly two publishes, the last arriving only when the slowest tier
// finished — so "not exactly two" is the property being defended.
check('each search tier reports as it lands',
  progressive.publishes.length === 1 || progressive.publishes.length >= 3, trail);
check('local results are on screen almost immediately',
  (progressive.publishes[0]?.at ?? 9999) < 400, `${progressive.publishes[0]?.at}ms`);
check('and the whole search settles in a usable time',
  progressive.total < 12_000, `${progressive.total}ms`);

await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const { rebuildDayStats } = await import('/src/db/dayStats.ts');
  await db.entries.clear();
  const junk = await db.foods.where('[source+sourceId]').equals(['usda', 'polish-chicken']).first();
  if (junk) await db.foods.delete(junk.id);
  await rebuildDayStats();
});

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
