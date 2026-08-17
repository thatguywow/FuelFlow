import { chromium } from 'playwright';

/**
 * Guards against silently dropped CSS.
 *
 * Lightning CSS (Tailwind v4's bundler) treats a hand-written `-webkit-` line
 * and its standard counterpart as duplicates of one logical property and keeps
 * only one, re-prefixing for its own targets. When it kept the `-webkit-` form
 * the nav lost its blur in Chrome entirely — the same class of silent failure as
 * the `[--var]` shorthand. These assertions check the *rendered* result in a
 * real engine, not the source we wrote.
 */
const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 393, height: 873 }, colorScheme: 'dark' });
await page.goto('http://localhost:4173/app/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// The nav only exists past onboarding, and it is the surface that actually
// regressed — get through onboarding so the check has something to assert on.
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
  await page.waitForTimeout(800);
}

const probe = await page.evaluate(() => {
  const out = {};
  const make = (cls, pseudo) => {
    const el = document.createElement('div');
    el.className = cls;
    document.body.appendChild(el);
    const cs = getComputedStyle(el, pseudo);
    const v = {
      backdropFilter: cs.backdropFilter,
      webkitBackdropFilter: cs.webkitBackdropFilter,
      mask: cs.maskImage,
      maskComposite: cs.maskComposite,
      backgroundClip: cs.backgroundClip,
    };
    el.remove();
    return v;
  };
  out.glass = make('glass');
  out.panel = make('panel', '::after');
  out.brandText = make('brand-text');
  out.gradientRing = make('gradient-ring', '::before');
  const nav = document.querySelector('nav');
  out.nav = nav ? getComputedStyle(nav).backdropFilter : 'no nav';
  out.supports = CSS.supports('backdrop-filter', 'blur(1px)');
  return out;
});

console.log(JSON.stringify(probe, null, 2).slice(0, 900));
console.log('');

check('glass: blur applies in Chrome', probe.glass.backdropFilter?.includes('blur'), probe.glass.backdropFilter);
check('nav: blur applies in Chrome', String(probe.nav).includes('blur'), String(probe.nav));
// Cards deliberately carry no inset top highlight: at this radius the line
// cannot follow the corners and reads as a scratch above every card.
check('panel: no stray top hairline', probe.panel.mask === 'none', probe.panel.mask?.slice(0, 50));
check('brand-text: background-clip is text', probe.brandText.backgroundClip === 'text', probe.brandText.backgroundClip);
check('gradient-ring: mask applies', probe.gradientRing.mask !== 'none', probe.gradientRing.mask?.slice(0, 50));
// Two mask layers, so the computed value is one keyword per layer
// ("exclude, exclude") — every layer must exclude for the rim to survive.
check(
  'gradient-ring: mask-composite excludes',
  probe.gradientRing.maskComposite
    ?.split(',')
    .every((v) => ['exclude', 'xor'].includes(v.trim())),
  probe.gradientRing.maskComposite,
);

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
