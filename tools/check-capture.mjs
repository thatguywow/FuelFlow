import { chromium } from 'playwright';

/**
 * What the camera actually hands to OCR.
 *
 * The label scanner downscaled the *whole* frame to 1440 px and read that. A
 * nutrition panel is set in six to eight point type and occupies about half the
 * frame, so the text arrived at an x-height around ten pixels — under what ML
 * Kit needs. Reading only the rectangle the user aimed with keeps every source
 * pixel of the panel for the same bytes on the wire.
 */
const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const page = await browser.newPage({ viewport: { width: 412, height: 915 }, permissions: ['camera'] });
page.on('pageerror', (e) => console.log(`  [pageerror] ${String(e).slice(0, 200)}`));

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const capture = await page.evaluate(async () => {
  const { captureFrame } = await import('/src/scan/barcode.ts');

  // A stand-in for the camera: a canvas of known size, drawn as a video would
  // be. `captureFrame` only reads videoWidth/videoHeight and draws the source.
  const fake = document.createElement('canvas');
  fake.width = 1920;
  fake.height = 1080;
  const ctx = fake.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 1920, 1080);

  // captureFrame expects an element exposing videoWidth/videoHeight.
  Object.defineProperty(fake, 'videoWidth', { value: 1920 });
  Object.defineProperty(fake, 'videoHeight', { value: 1080 });

  const measure = (dataUrl) =>
    new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.width, height: img.height });
      img.src = dataUrl;
    });

  const whole = await measure(captureFrame(fake));
  const guide = { x: 0.08, y: 0.15, width: 0.84, height: 0.58 };
  const cropped = await measure(captureFrame(fake, { crop: guide }));

  return { whole, cropped, guide };
});

// The uncropped path is unchanged: a barcode is large and may be anywhere.
check('an uncropped capture still caps its width', capture.whole.width === 1440,
  `${capture.whole.width}x${capture.whole.height}`);

// 84% of 1920 = 1613, 58% of 1080 = 626 — kept at source resolution.
check('a cropped capture keeps the region at full resolution',
  capture.cropped.width === 1613 && capture.cropped.height === 626,
  `${capture.cropped.width}x${capture.cropped.height}`);

/*
 * The number that matters. Panel text scales with how many source pixels
 * survive per unit of the panel, and cropping raises that by the ratio below.
 */
const before = (capture.whole.height * capture.guide.height) / (1080 * capture.guide.height);
const after = capture.cropped.height / (1080 * capture.guide.height);
check('which is a real gain in pixels on the text',
  after > before * 1.3, `${before.toFixed(2)}x source before, ${after.toFixed(2)}x after`);

const throttle = await page.evaluate(async () => {
  const source = await fetch('/src/scan/barcode.ts').then((r) => r.text());
  return {
    // The decode loop ran once per animation frame — 60 to 120 full-resolution
    // barcode detections a second, competing with the preview it draws over.
    throttled: /DECODE_INTERVAL_MS/.test(source),
    // The label scanner asks for everything the sensor has; the barcode one
    // deliberately does not.
    highRes: /width: \{ ideal: 3840 \}/.test(source),
    barcodeModest: /width: \{ ideal: 1280 \}/.test(source),
  };
});
check('the barcode decode loop is throttled', throttle.throttled);
check('the label preview asks for full sensor resolution', throttle.highRes);
check('the barcode preview does not', throttle.barcodeModest);

const salt = await page.evaluate(async () => {
  const { parseNutritionLabel } = await import('/src/scan/barcode.ts');
  return {
    english: parseNutritionLabel(['Salt 1.2 g'])?.sodiumMg,
    greek: parseNutritionLabel(['Αλάτι 1,2 g'])?.sodiumMg,
    german: parseNutritionLabel(['Salz 1,2 g'])?.sodiumMg,
    comma: parseNutritionLabel(['Πρωτεΐνες 12,5 g'])?.protein,
  };
});
check('salt converts to sodium in English', Math.round(salt.english ?? 0) === 480, `${salt.english}`);
check('and in Greek and German', Math.round(salt.greek ?? 0) === 480 && Math.round(salt.german ?? 0) === 480,
  `el ${salt.greek}, de ${salt.german}`);
check('a comma decimal is a decimal, not a thousands separator',
  salt.comma === 12.5, `${salt.comma} g protein`);

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
