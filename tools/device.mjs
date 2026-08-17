#!/usr/bin/env node
/**
 * Device preview.
 *
 * Serves the **production build** — byte for byte what the APK packages into
 * `assets/public/` — inside a phone frame, so the app can be reviewed at real
 * device size without installing anything. The native shell adds ML Kit
 * scanning, a settable User-Agent and the share sheet; everything else you see
 * here is exactly what runs on the phone.
 *
 * Served over http://localhost, which browsers treat as a secure context, so
 * even the camera works — the barcode scanner runs against a webcam.
 *
 * Usage:
 *   npm run build && npm run device
 *   npm run device -- --port=4173
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const argv = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    return [key, value];
  }),
);

const PORT = Number(argv.port ?? 4173);
const ROOT = path.resolve('dist');

if (!existsSync(path.join(ROOT, 'index.html'))) {
  console.error('No production build found.\n\n  npm run build && npm run device\n');
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

const DEVICES = [
  { id: 'pixel', label: 'Pixel 8', w: 412, h: 915 },
  { id: 'iphone', label: 'iPhone 15', w: 393, h: 852 },
  { id: 'small', label: 'iPhone SE', w: 375, h: 667 },
  { id: 'tall', label: 'Xiaomi / tall', w: 393, h: 873 },
  { id: 'tablet', label: 'Tablet', w: 768, h: 1024 },
];

/**
 * The frame page. Kept as one self-contained document so the preview has no
 * build step of its own and cannot drift from the app it is framing.
 */
const FRAME = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>FuelFlow — device preview</title>
<script>
  /*
   * Self-heal a stale service worker.
   *
   * A worker installed by an earlier session precached this origin's root — the
   * *frame* page — as its navigation fallback, so it answers every navigation
   * with the frame, including the iframe's own /app/ request. The result is a
   * frame inside a frame, forever. Server-side guards cannot fix it: the worker
   * intercepts those requests before they reach the network, so it must be torn
   * down from a page it already controls.
   *
   * Runs before the iframe is parsed. The sessionStorage latch means a single
   * reload, never a loop, if anything else ever serves this page.
   */
  (async () => {
    const nested = window.top !== window.self;
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        if (regs.length && !sessionStorage.getItem('ff.sw-cleared')) {
          sessionStorage.setItem('ff.sw-cleared', '1');
          await Promise.all(regs.map((r) => r.unregister()));
          if (window.caches) {
            await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
          }
          // Still worker-controlled until the document is reloaded.
          location.reload();
          return;
        }
      }
    } catch { /* nothing we can do; fall through to the nesting guard */ }
    // Belt and braces: never render a frame inside the frame's own iframe.
    if (nested) location.replace('/app/');
  })();
</script>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center;
    gap: 14px; padding: 14px 10px 24px; overflow-x: hidden;
    background: radial-gradient(60rem 40rem at 20% -10%, #12203a, #0a0c11 60%);
    color: #e8edf5;
    font: 14px/1.4 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .bar {
    display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
    background: #12151d; border: 1px solid #1e2431; border-radius: 14px; padding: 10px 12px;
    box-shadow: 0 8px 30px -12px rgb(0 0 0 / .7);
  }
  .bar strong { font-size: 13px; letter-spacing: .02em; margin-right: 4px; }
  select, button {
    font: inherit; color: inherit; background: #191d27; border: 1px solid #2a3242;
    border-radius: 9px; padding: 6px 10px; cursor: pointer;
  }
  button:hover, select:hover { border-color: #3a465c; }
  button.on { background: linear-gradient(135deg,#38bdf8,#4f46e5); border-color: transparent; color: #04121c; font-weight: 600; }
  /* margin: 0 — a <p>'s default block margins are not collapsed in a flex
     column, so they added height the fit() maths did not know about. */
  .hint { margin: 0; font-size: 12px; color: #7d8798; max-width: 62ch; text-align: center; }
  /* The frame is scaled to fit whatever space it has, rather than assuming a
     desktop window. In a narrow pane an unscaled 412px phone plus its bezel
     overflowed, which produced nested scrollbars and cut the device in half. */
  /* align-items must not stretch: the stage is given an explicit *post-scale*
     height, and a stretched phone would adopt that number as its pre-scale
     height — ending up shorter than the screen it contains, which then spilled
     out past the bottom bezel. */
  .stage { display: flex; justify-content: center; align-items: flex-start; width: 100%; }
  .phone {
    position: relative; border-radius: 42px; padding: 12px;
    background: linear-gradient(160deg,#2a3040,#12151d);
    box-shadow: 0 30px 80px -20px rgb(0 0 0 / .9), 0 0 0 1px #2a3242;
    transform-origin: top center;
    flex: 0 0 auto;
  }
  .screen { border-radius: 32px; overflow: hidden; background: #000; position: relative; }
  iframe { border: 0; display: block; width: 100%; height: 100%; }
  .notch {
    position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
    width: 92px; height: 20px; border-radius: 12px; background: #05070b; z-index: 3; pointer-events: none;
  }
  .size { font-variant-numeric: tabular-nums; color: #7d8798; font-size: 12px; }
</style>
</head>
<body>
  <div class="bar">
    <strong>FuelFlow</strong>
    <select id="device">${DEVICES.map(
      (d, i) => `<option value="${d.id}" ${i === 0 ? 'selected' : ''}>${d.label} · ${d.w}×${d.h}</option>`,
    ).join('')}</select>
    <button id="theme-dark" class="on">Dark</button>
    <button id="theme-light">Light</button>
    <button id="reload">Reload</button>
    <button id="wipe" title="Delete all local data and start from onboarding">Reset data</button>
    <span class="size" id="size"></span>
  </div>

  <div class="stage" id="stage">
    <div class="phone" id="phone">
      <div class="notch"></div>
      <div class="screen" id="screen"><iframe id="app" src="/app/" allow="camera; fullscreen"></iframe></div>
    </div>
  </div>

  <p class="hint">
    This is the production build — the same bundle the Android app packages. Served over
    localhost, so the camera works here too and the barcode scanner can read from a webcam.
    Native-only differences: ML Kit scanning and label OCR, and the OS share sheet.
  </p>

<script>
  const DEVICES = ${JSON.stringify(DEVICES)};
  const phone = document.getElementById('phone');
  const screen = document.getElementById('screen');
  const app = document.getElementById('app');
  const sizeLabel = document.getElementById('size');

  let current = DEVICES[0];

  function apply(id) {
    current = DEVICES.find((x) => x.id === id) ?? DEVICES[0];
    screen.style.width = current.w + 'px';
    screen.style.height = current.h + 'px';
    sizeLabel.textContent = current.w + ' × ' + current.h;
    // Keep the picker in step: restoring a saved device without this left the
    // dropdown showing one size while the frame rendered another.
    document.getElementById('device').value = current.id;
    localStorage.setItem('ff.device', current.id);
    fit();
  }

  /**
   * Scale the whole device down so it always fits the viewport. The iframe
   * still lays out at true device pixels — only the presentation is scaled —
   * so what you see is exactly what a phone of that size renders.
   */
  function fit() {
    const bezel = 24;
    const stage = document.getElementById('stage');
    const hint = document.querySelector('.hint');
    const availableW = stage.clientWidth;
    // Measure what actually sits below the phone instead of guessing a
    // constant — the guess under-reserved and left the whole page scrolling.
    const gap = 14, bodyPadBottom = 24;
    const hintStyle = getComputedStyle(hint);
    const below =
      hint.offsetHeight +
      parseFloat(hintStyle.marginTop) +
      parseFloat(hintStyle.marginBottom) +
      gap +
      bodyPadBottom;
    // Read the stage's top, not the phone's: the stage does not move when the
    // phone is rescaled, so this cannot feed back into itself.
    const availableH = window.innerHeight - stage.getBoundingClientRect().top - below;
    const scale = Math.max(
      0.35,
      Math.min(1, (availableW - 8) / (current.w + bezel), availableH / (current.h + bezel)),
    );
    phone.style.transform = 'scale(' + scale + ')';
    // Scaling does not shrink the space the element reserves, so the stage is
    // told the post-scale height explicitly or the page keeps a tall gap.
    stage.style.height = (current.h + bezel) * scale + 'px';

    // Say so when the phone is not rendering 1:1. At a fractional scale the
    // browser resamples the whole device, which softens hairlines and smears
    // anything behind a translucent surface — artefacts that are the preview's,
    // not the app's. Worth knowing before chasing one.
    const percent = Math.round(scale * 100);
    sizeLabel.textContent =
      current.w + ' × ' + current.h + (percent === 100 ? '' : '  ·  ' + percent + '%');
    sizeLabel.title =
      percent === 100
        ? 'Rendering 1:1'
        : 'Scaled to fit — fine detail is resampled. Widen the window or pick a smaller device to judge at 100%.';
  }

  window.addEventListener('resize', fit);

  function setTheme(theme) {
    // The app reads its own stored preference, so the frame writes the same
    // key the app uses rather than trying to reach into its React state.
    try {
      app.contentWindow.document.documentElement.dataset.theme = theme;
    } catch { /* not loaded yet */ }
    document.getElementById('theme-dark').classList.toggle('on', theme === 'dark');
    document.getElementById('theme-light').classList.toggle('on', theme === 'light');
    localStorage.setItem('ff.theme', theme);
  }

  document.getElementById('device').addEventListener('change', (e) => apply(e.target.value));
  document.getElementById('theme-dark').addEventListener('click', () => setTheme('dark'));
  document.getElementById('theme-light').addEventListener('click', () => setTheme('light'));
  document.getElementById('reload').addEventListener('click', () => app.contentWindow.location.reload());

  document.getElementById('wipe').addEventListener('click', async () => {
    if (!confirm('Delete all local FuelFlow data in this preview and restart onboarding?')) return;
    try {
      const w = app.contentWindow;
      const dbs = (await w.indexedDB.databases?.()) ?? [{ name: 'fuelflow' }];
      await Promise.all(dbs.map((d) => d.name && new Promise((res) => {
        const r = w.indexedDB.deleteDatabase(d.name); r.onsuccess = r.onerror = r.onblocked = res;
      })));
      w.localStorage.clear();
      w.location.reload();
    } catch (err) { alert('Could not clear: ' + err); }
  });

  app.addEventListener('load', () => {
    setTheme(localStorage.getItem('ff.theme') ?? 'dark');
    fit();
  });
  apply(localStorage.getItem('ff.device') ?? 'pixel');
</script>
</body>
</html>`;

/**
 * Neutralises the service worker for the preview.
 *
 * The app's worker registers at the origin root and precaches `index.html`.
 * Under this server that URL is the *frame* page, so the worker then answered
 * the iframe's own navigation with the frame — which loaded another frame
 * inside itself, and another, recursively.
 *
 * Unregistering is also just better for iteration: a stale worker otherwise
 * keeps serving an old build after a rebuild.
 */
const UNREGISTER_SW = `
(async () => {
  if (!('serviceWorker' in navigator)) return;
  const regs = await navigator.serviceWorker.getRegistrations();
  if (regs.length === 0) return;
  await Promise.all(regs.map((r) => r.unregister()));
  if (window.caches) {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  }
  // Reload once so the page is no longer worker-controlled.
  if (!sessionStorage.getItem('ff.sw-cleared')) {
    sessionStorage.setItem('ff.sw-cleared', '1');
    location.reload();
  }
})();
`;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(FRAME);
    return;
  }

  if (pathname === '/registerSW.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    res.end(UNREGISTER_SW);
    return;
  }

  // Refuse to hand out the worker at all, so nothing can re-register it.
  if (pathname === '/sw.js' || pathname.startsWith('/workbox-')) {
    res.writeHead(404, { 'cache-control': 'no-store' }).end('disabled in preview');
    return;
  }

  // The app is mounted under /app/ so the frame can own the root.
  if (pathname === '/app' || pathname === '/app/') pathname = '/app/index.html';
  const relative = pathname.startsWith('/app/') ? pathname.slice('/app'.length) : pathname;

  const file = path.join(ROOT, path.normalize(relative).replace(/^([/\\])+/, ''));
  // Never serve outside the build directory.
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  if (existsSync(file) && statSync(file).isFile()) {
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      // The scanner needs the camera inside the frame's iframe.
      'permissions-policy': 'camera=(self)',
    });
    createReadStream(file).pipe(res);
    return;
  }

  // Single-page fallback.
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  createReadStream(path.join(ROOT, 'index.html')).pipe(res);
});

server.listen(PORT, () => {
  const dir = path.relative(process.cwd(), ROOT) || 'dist';
  console.log(`\n  Device preview   http://localhost:${PORT}`);
  console.log(`  App on its own   http://localhost:${PORT}/app/`);
  console.log(`  Serving          ${dir}${path.sep} (production build)\n`);
  console.log('  Rebuild with `npm run build` to pick up changes.\n');
});

process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
