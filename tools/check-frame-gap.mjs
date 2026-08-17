import { chromium } from 'playwright';

/**
 * Is the strip under the tab bar the app, or the preview frame?
 *
 * Compares the app served on its own against the same build inside the device
 * frame. If the app's nav reaches the viewport bottom but the framed iframe
 * falls short of the phone's screen well, the strip is the harness showing its
 * own background and nothing in the app needs fixing.
 */
const browser = await chromium.launch();

// --- the app, standalone -------------------------------------------------
const bare = await browser.newPage({ viewport: { width: 412, height: 915 }, colorScheme: 'dark' });
await bare.goto('http://localhost:4173/app/', { waitUntil: 'networkidle' });
await bare.waitForTimeout(1500);
if (await bare.locator('button:text-is("Set up")').count()) {
  await bare.locator('button:text-is("Set up")').click();
  for (let i = 0; i < 4; i++) {
    await bare.waitForTimeout(250);
    const n = bare.locator('button:text-is("Continue")');
    if (await n.count()) await n.click();
  }
  await bare.waitForTimeout(300);
  await bare.locator('button:text-is("Start tracking")').click();
  await bare.locator('text=MACRONUTRIENTS').waitFor({ timeout: 30_000 });
  await bare.waitForTimeout(1000);
}
const app = await bare.evaluate(() => {
  const nav = document.querySelector('nav').getBoundingClientRect();
  const atBottom = document.elementFromPoint(Math.round(window.innerWidth / 2), window.innerHeight - 2);
  return {
    innerHeight: window.innerHeight,
    navBottom: Math.round(nav.bottom),
    gapBelowNav: Math.round(window.innerHeight - nav.bottom),
    elementAtVeryBottom: atBottom ? atBottom.tagName.toLowerCase() : null,
    bottomIsNav: atBottom ? Boolean(atBottom.closest('nav')) : false,
  };
});
console.log('app standalone :', JSON.stringify(app));
await bare.close();

// --- the same build inside the device frame ------------------------------
const framed = await browser.newPage({ viewport: { width: 1100, height: 950 }, colorScheme: 'dark' });
await framed.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await framed.waitForTimeout(1800);
const frame = await framed.evaluate(() => {
  const screenEl = document.getElementById('screen');
  const iframe = document.getElementById('app');
  const s = screenEl.getBoundingClientRect();
  const f = iframe.getBoundingClientRect();
  return {
    screenHeight: +s.height.toFixed(2),
    iframeHeight: +f.height.toFixed(2),
    // Positive = the phone's screen well extends below the app's viewport,
    // exposing the harness behind it.
    gapAtBottom: +(s.bottom - f.bottom).toFixed(2),
    screenBg: getComputedStyle(screenEl).backgroundColor,
    scale: document.getElementById('phone').style.transform,
  };
});
console.log('device frame   :', JSON.stringify(frame));
await framed.close();

await browser.close();

console.log('');
if (app.gapBelowNav === 0 && app.bottomIsNav) {
  console.log('VERDICT: in the app itself the tab bar reaches the very bottom — nothing can show beneath it.');
} else {
  console.log(`VERDICT: the app leaves ${app.gapBelowNav}px below the tab bar — this is a real app bug.`);
}
