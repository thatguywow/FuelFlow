import { chromium } from 'playwright';

/**
 * Proves Open Food Facts data is genuinely reachable in production.
 *
 * Runs against the deployed site, not the dev server, so it exercises the real
 * chain: chunked SQLite on GitHub Pages, read over HTTP range requests, in a
 * browser. European products are used deliberately — the whole reason for
 * shipping Open Food Facts globally is coverage the USDA sets do not have.
 */

const BASE = process.argv[2] ?? 'https://thatguywow.github.io/FuelFlow/';

// Well-known European barcodes, none of which exist in any USDA dataset.
const EUROPEAN = [
  { code: '3017620422003', name: 'Nutella', where: 'France / Italy' },
  { code: '5449000000996', name: 'Coca-Cola 330 ml', where: 'EU' },
  { code: '4008400402222', name: 'Kinder Bueno', where: 'Germany' },
  { code: '8000500310427', name: 'Ferrero product', where: 'Italy' },
  { code: '5201360604203', name: 'Greek product', where: 'Greece' },
];

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });

  const rangeRequests = [];
  page.on('response', (r) => {
    if (r.status() === 206 && /fooddb/.test(r.url())) rangeRequests.push(r.url());
  });

  console.log(`Loading ${BASE}\n`);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  if (await page.locator('button:text-is("Set up")').count()) {
    await page.locator('button:text-is("Set up")').click();
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(180);
      const next = page.locator('button:text-is("Continue")');
      if (await next.count()) await next.click();
    }
    await page.waitForTimeout(200);
    await page.locator('button:text-is("Start tracking")').click();
    await page.waitForTimeout(2500);
  }

  const manifest = await page.evaluate(async (base) => {
    const r = await fetch(new URL('fooddb/manifest.json', base).toString());
    return r.ok ? r.json() : null;
  }, BASE);

  check('hosted database manifest is served', manifest !== null);
  if (manifest) {
    check(
      'Open Food Facts rows present in the snapshot',
      (manifest.breakdown?.off ?? 0) > 1_000_000,
      `${(manifest.breakdown?.off ?? 0).toLocaleString()} OFF products`,
    );
    check('scope is global, not country-filtered', manifest.scope === 'global', manifest.scope);
  }

  // Look each barcode up through the app's own production bundle.
  const found = [];
  for (const item of EUROPEAN) {
    const result = await page.evaluate(async (code) => {
      const started = performance.now();
      // The production bundle exposes nothing globally, so drive the lookup the
      // way the scanner does: through the service the app already loaded.
      const mod = window.__ff_lookup;
      if (!mod) return { unsupported: true };
      const hit = await mod(code);
      return { name: hit?.food?.name ?? null, tier: hit?.tier ?? null, ms: Math.round(performance.now() - started) };
    }, item.code);

    if (result.unsupported) {
      found.push({ ...item, skipped: true });
      continue;
    }
    found.push({ ...item, ...result });
  }

  if (found.some((f) => f.skipped)) {
    console.log('\n(no test hook in the production bundle — falling back to the search UI)\n');

    // Search is the same tiered path; a European brand name only resolves if
    // the Open Food Facts rows are actually queryable.
    for (const term of ['nutella', 'kinder bueno', 'barilla']) {
      await page.locator('button[aria-label="Add to diary"]').click();
      await page.waitForTimeout(500);
      await page.locator('[role="menuitem"]', { hasText: 'Search foods' }).click();
      await page.waitForTimeout(700);
      const dialog = page.locator('[role="dialog"]');
      await dialog.locator('input[inputmode="search"]').fill(term);
      await page.waitForTimeout(4000);
      const text = await dialog.innerText();
      const hasHit = new RegExp(term.split(' ')[0], 'i').test(text);
      check(`search finds "${term}"`, hasHit, hasHit ? 'resolved' : 'no match');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }
  } else {
    for (const f of found) {
      check(`${f.name} (${f.where})`, f.name !== null, f.name ? `${f.name} via ${f.tier}, ${f.ms}ms` : 'not found');
    }
  }

  await page.waitForTimeout(1000);
  check(
    'range requests were used against the hosted database',
    rangeRequests.length > 0,
    `${rangeRequests.length} partial responses`,
  );

  await browser.close();
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
