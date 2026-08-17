import { chromium } from 'playwright';

/** Reports the frame's real geometry so bezel/scroll issues are diagnosed, not guessed. */
const browser = await chromium.launch();

for (const width of [620, 1100]) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: 'dark' });
  await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  console.log(`\n=== viewport ${width}x900 ===`);

  for (const id of ['pixel', 'small', 'tablet']) {
    await page.selectOption('#device', id);
    await page.waitForTimeout(500);
    const g = await page.evaluate(() => {
      const el = (s) => document.querySelector(s);
      const h = (s) => Math.round(el(s).getBoundingClientRect().height);
      const stage = document.getElementById('stage');
      const body = document.body;
      const cs = getComputedStyle(body);
      return {
        scale: document.getElementById('phone').style.transform,
        barH: h('.bar'),
        stageTop: Math.round(stage.getBoundingClientRect().top),
        stageH: h('#stage'),
        phoneH: h('#phone'),
        hintH: h('.hint'),
        hintBottom: Math.round(el('.hint').getBoundingClientRect().bottom),
        bodyH: Math.round(body.getBoundingClientRect().height),
        bodyMinH: cs.minHeight,
        bodyPad: cs.padding,
        scrollH: document.documentElement.scrollHeight,
        innerH: window.innerHeight,
        over: document.documentElement.scrollHeight - window.innerHeight,
      };
    });
    console.log(`  ${id.padEnd(7)} ${JSON.stringify(g)}`);
  }
  await page.close();
}

await browser.close();
