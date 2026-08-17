import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

/**
 * Drives the barcode scanner with a synthetic camera that shows a real EAN-13.
 *
 * Chromium's built-in fake device emits a green test pattern — useless both as a
 * screenshot and as a test, since nothing can decode it. Here `getUserMedia` is
 * replaced with a canvas stream rendering a genuine barcode, so the HUD is shown
 * over something realistic *and* the decode path is exercised for real: ZXing
 * has to read the bars, and the hit then walks the normal tiered lookup.
 */
mkdirSync('shots', { recursive: true });

const BARCODE = process.argv[2] ?? '3017620422003'; // Nutella 400g
const EXPECT = process.argv[3] ?? 'Nutella';

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
  permissions: ['camera'],
});

await context.addInitScript((code) => {
  // --- EAN-13 encoding ----------------------------------------------------
  const L = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
  const G = ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
  const R = ['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100'];
  const PARITY = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];

  const digits = code.split('').map(Number);
  const parity = PARITY[digits[0]];
  let bits = '101';
  for (let i = 1; i <= 6; i++) bits += (parity[i - 1] === 'L' ? L : G)[digits[i]];
  bits += '01010';
  for (let i = 7; i <= 12; i++) bits += R[digits[i]];
  bits += '101';

  const W = 800, H = 600;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Module width must be a whole number of pixels. At a fractional width the
  // rounding on each rect shifts bar boundaries by up to a pixel and the
  // pattern no longer decodes, however sharp it looks.
  // EAN-13 also needs a quiet zone of ~11 modules either side of the bars.
  const barW = 5;
  const BAR_SPAN = barW * bits.length;      // 95 modules
  const BAR_LEFT = Math.round((W - BAR_SPAN) / 2);

  const draw = () => {
    // A packet-ish background so the shot looks like a real scan, not a swatch.
    ctx.fillStyle = '#2b2f36';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#3a4049';
    ctx.fillRect(0, 0, W, 190);

    // White label spanning well past the bars on both sides.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(60, 240, W - 120, 220);
    // Runs of adjacent modules are drawn as one rect so no seam appears
    // between them at any scale.
    ctx.fillStyle = '#000000';
    for (let i = 0; i < bits.length; ) {
      if (bits[i] === '1') {
        let j = i;
        while (j < bits.length && bits[j] === '1') j++;
        ctx.fillRect(BAR_LEFT + i * barW, 260, (j - i) * barW, 160);
        i = j;
      } else i++;
    }
    ctx.font = '20px monospace';
    ctx.fillText(code, W / 2 - 66, 445);
    requestAnimationFrame(draw);
  };
  draw();

  const stream = canvas.captureStream(30);
  // The app probes for a torch; the canvas track has no capabilities at all.
  const track = stream.getVideoTracks()[0];
  track.getCapabilities = () => ({ torch: true });
  track.applyConstraints = () => Promise.resolve();

  navigator.mediaDevices.getUserMedia = async () => stream;
  navigator.mediaDevices.enumerateDevices = async () => [
    { kind: 'videoinput', deviceId: 'fake', label: 'Synthetic camera', groupId: 'g', toJSON: () => ({}) },
  ];
}, BARCODE);

const page = await context.newPage();
page.on('pageerror', (e) => console.log(`  [pageerror] ${String(e).slice(0, 200)}`));
let zxingAttempts = 0;
page.on('console', (m) => {
  const t = m.text();
  if (t.includes('MultiFormatReader') || t.includes('NotFound')) zxingAttempts++;
  else if (m.type() === 'error') console.log(`  [error] ${t.slice(0, 200)}`);
});

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

await page.locator('button[aria-label="Add to diary"]').click();
await page.waitForTimeout(600);
await page.locator('[role="menuitem"]', { hasText: 'Scan barcode' }).click();

// Catch the HUD while it is still hunting, before a hit replaces it.
await page.waitForTimeout(1200);
await page.screenshot({ path: 'shots/9b-hud-barcode.png' });

const closeBtn = page.locator('button[aria-label="Close scanner"]');
check('HUD: full-screen scanner is used', (await closeBtn.count()) === 1);
check('HUD: flash control present', (await page.locator('button[aria-label="Toggle flash"]').count()) === 1);
const hint = await page.locator('text=Hold the barcode inside the frame').count();
check('HUD: framing hint shown', hint === 1);

// Now let the decode land.
// The decode is instant; the tiered lookup behind it is a network round trip to
// the hosted database and then Open Food Facts, so allow for a slow one.
// Match against the whole document, then keep an excerpt for the report — the
// result sheet's text follows the page behind it, so truncating first hides it.
let hit = false;
let excerpt = 'never appeared';
for (let i = 0; i < 120; i++) {
  await page.waitForTimeout(500);
  const body = await page.locator('body').innerText();
  if (body.includes(EXPECT)) {
    hit = true;
    const at = body.indexOf(EXPECT);
    excerpt = body.slice(at, at + 160).replace(/\n+/g, ' | ');
    break;
  }
  if (body.includes('Looking it up')) excerpt = 'still looking it up';
}
void zxingAttempts;
check(`scan: ${BARCODE} decoded and resolved to "${EXPECT}"`, hit, excerpt);
// The camera must be released once a hit lands, not left running behind the
// result sheet — a live capture drains the battery and holds the torch on.
const cameraReleased = await page.evaluate(() => !document.querySelector('video'));
check('scan: camera released after a hit', cameraReleased);
await page.screenshot({ path: 'shots/9c-hud-result.png' });

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
