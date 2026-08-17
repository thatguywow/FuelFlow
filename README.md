# FuelFlow

A calorie, macro and micronutrient tracker that runs with **no server, no accounts and no AI API** — as a native iOS/Android app and as a static site you can drop on GitHub Pages.

It measures your actual metabolic rate from your own logged data instead of guessing it from a formula, and it can search millions of packaged products without a backend.

---

## The two problems this solves

**"The food databases are too big to ship in the app."** They are. Open Food Facts is millions of products; USDA FoodData Central is hundreds of thousands. Neither fits in an app bundle, and hosting them needs a server.

**"I don't have a server."** You don't need one.

### Tiered lookup

| Tier | What | Where it lives | Cost of a lookup |
|---|---|---|---|
| 1. Personal | Everything you have ever logged, your recipes, your custom foods | IndexedDB, on device | 0 — instant, offline |
| 2. Core | USDA generic foods with full micronutrients | Bundled with the app, seeded into IndexedDB on first run | 0 — instant, offline |
| 3. Hosted | Open Food Facts **and** USDA — millions of products, global | One chunked SQLite file on GitHub Pages | ~3 KB over HTTP |
| 4. Live | Products newer than the last snapshot | Open Food Facts API | one request, then cached forever |

The load-bearing insight is tier 1: **people eat the same forty things.** After a fortnight your own device answers the overwhelming majority of lookups with no network at all, and every tier-3 or tier-4 result is written into tier 1, so the app gets faster the more you use it.

### How tier 3 works without a server

`scripts/build-food-db.mjs` distils the Open Food Facts bulk export *and* the USDA FoodData Central export into one SQLite file with an FTS5 index, then splits it into sub-100 MB chunks published as ordinary static files. At runtime SQLite runs in a WebWorker and reads that file over **HTTP range requests** ([`sql.js-httpvfs`](https://github.com/phiresky/sql.js-httpvfs)), pulling only the B-tree pages a query actually touches.

The consequence worth internalising: **database size barely affects the user.** A lookup costs the same few kilobytes whether the file holds 200,000 products or 4,000,000, because range requests never download the rest. That is why the default scope is **global** rather than a country filter — European, Asian and Latin American coverage costs you nothing at runtime, and Open Food Facts is far stronger outside the US than any American database.

Three structural choices make it cheap:

- **`id INTEGER PRIMARY KEY`** makes the id the table's rowid, so rows are physically ordered by it. A barcode lookup is a direct B-tree descent — about three page reads — rather than an index probe plus a scattered row fetch. (`EXPLAIN QUERY PLAN` confirms `SEARCH products USING INTEGER PRIMARY KEY`.) Barcoded products use the barcode as the id; USDA generic foods, which have none, use the *negative* of their FDC id, so one clustered table serves both with no second index.
- **`page_size = 1024`** matches the client's request chunk size, so no read straddles a chunk boundary and triggers a second request.
- **FTS5 `optimize`** merges the index into a single b-tree, roughly halving the requests a text search costs.

When the same barcode appears in both sources, the higher-quality record wins — USDA's laboratory measurements beat crowd-sourced entries, and the loser is dropped at build time rather than deduplicated on every query.

The "server" is a CDN serving byte ranges of a static file. No backend, no API key, no rate limit, no per-request cost.

### And GitHub Actions is the build server

The workflows download the upstream dumps, build both datasets, and upload them straight into the Pages artifact. **Nothing is committed to the repository** — a several-hundred-megabyte food database never touches git history.

---

## What it does

**Adaptive expenditure** (the thing MacroFactor is worth paying for) — every logged day is a physics experiment: energy in, minus energy burned, shows up as a change in body mass. A two-state Kalman filter over `[body mass, expenditure]` recovers your true TDEE from your own intake and weight trend, with a backward RTS smoothing pass so the history chart stops rewriting itself every morning. It reports its own uncertainty, so the app says *"not enough data yet"* instead of inventing a confident wrong number, and only takes over from the textbook formula once it is genuinely better. See `src/core/adaptive.ts`.

**Micronutrients** (Cronometer parity) — 50 nutrients including vitamins, minerals and essential amino acids, against IOM DRI reference intakes banded by age and sex. The nutrient screen also shows *data coverage*, because packaged products only publish the label panel and pretending a missing value is a zero is a lie.

**Natural-language logging without a model** — "2 eggs, 100 g oats and a cup of milk" becomes three entries via a deterministic quantity/unit grammar resolved against the local index. Instant, offline, free, and identical every time. Handles fractions (`1 1/2 cups`), word numbers (`half an avocado`), size adjectives (`1 large banana`), and repairs its own over-eager splits so "peanut butter and jelly" survives. Falls back to a household-measure table so "3 slices of cheddar" is 63 g, not 300 g.

**Barcode scanning** — ML Kit on native, the platform `BarcodeDetector` in browsers that have it, ZXing as a lazy-loaded fallback. A miss drops into custom-food creation with the code pre-filled, so a scan is never a dead end.

**Targets, automatic or your own** — automatic mode derives everything from measured expenditure and a rate of change. Custom mode lets you type an exact calorie figure and exact macro grams; it is honoured as typed, with a live readout of what your macros actually add up to and a one-tap **Balance** that puts the remainder into carbohydrate.

Plus: weight-trend smoothing with gap-aware decay, rate of change with a real confidence interval, recipe builder with cooked-weight handling, meal templates, copy-day, fasting timer, water, body measurements, streaks, diet templates, net carbs, and encrypted backup/restore.

**Safety rails are real, not decorative.** In automatic mode deficits are capped at 25% of expenditure, targets are raised to your resting metabolic rate, and protein and fat floors are protected before carbohydrate absorbs the remainder. In custom mode nothing is silently rewritten — a 900 kcal target stays 900 kcal and is clearly flagged as below your RMR, because an explicit choice deserves a warning rather than a quiet override.

---

## Privacy

IndexedDB is the source of truth. There is no account and no server, and nothing is uploaded. Backups are plain JSON, optionally wrapped in AES-256-GCM with PBKDF2-SHA256 (310,000 iterations) when you supply a passphrase. Restore merges by `updatedAt`, so importing onto a device that has kept logging never loses anything.

The only outbound requests are to Open Food Facts (tier 4) and to your own Pages deployment (tier 3).

---

## Running it

```bash
npm install
npm run data:usda
npm run data:core
npm run dev
```

**No API key is needed anywhere.** The FoodData Central *API* is rate limited and wants a key; the bulk CSV exports are plain public downloads and want nothing. `data:usda` fetches the latest export (it discovers the date-stamped URL itself), and `data:core` turns it into the ~7,800-food bundled dataset with full micronutrients — 2.5 MB raw, 660 KB gzipped over the wire.

The same download also feeds the hosted database, so one fetch serves both.

> There is still a `--mode=api` path in `build-core-db.mjs`. It needs no key either, but the shared `DEMO_KEY` caps it at 30 requests/hour, which yields roughly 300 foods instead of 7,800. It exists only as a quick option when you do not want to download half a gigabyte — it is not part of a real build.

### Building the hosted database locally

Optional — the app works fine without it. The Open Food Facts download is roughly a gigabyte and the build takes a while.

```bash
npm run data:hosted
```

That folds the USDA export you already fetched together with a global Open Food Facts snapshot. For Open Food Facts alone, drop the `--usda` flag:

```bash
node scripts/build-food-db.mjs
```

Narrowing by country is supported but rarely worth it — range requests mean a bigger database costs nothing at lookup time:

```bash
node scripts/build-food-db.mjs --countries=germany,greece,france
```

### Deploying to GitHub Pages

Push to `main`. `.github/workflows/deploy.yml` builds everything and deploys. Enable Pages with source "GitHub Actions" first.

Optional repository settings:

**No secrets are required.** Both upstream datasets are public downloads. Two optional repository *variables* exist if you want them:

| Variable | Purpose |
|---|---|
| `FOOD_DB_COUNTRIES` | Narrow the hosted database to specific markets. Leave unset for global, which is the recommended default |
| `FOOD_DB_VERSION` | Bump to force a rebuild |

`refresh-food-db.yml` rebuilds both datasets monthly and redeploys.

### Native apps

```bash
npm run build
npx cap add android
npx cap add ios
npm run cap:android
```

> **Build the web bundle with `VITE_BASE` unset before `cap sync`.** The `/<repo>/` base path used for GitHub Pages will break every asset path inside the native shell.

---

## Known constraints

- **This directory's name contains `&` and spaces.** `npx` mis-resolves paths here (use `node node_modules/vite/bin/vite.js` instead of `npx vite`), and **Android's Gradle build will fail outright**. Move or rename the project folder before running `cap add android` — something like `C:\dev\fuelflow`.
- **Label OCR is native-only.** ML Kit runs the model on-device. The web build deliberately has no OCR rather than shipping a multi-megabyte model or posting photos of your food to a third party; it offers a fast manual label form instead.
- **Open Food Facts asks clients to identify themselves with a custom `User-Agent`.** Browsers forbid setting that header, so the native build sends it properly via `CapacitorHttp` and the web build falls back to the documented `app_name` query parameters. Client-side rate limiting stays well under the published 15/min read and 10/min search limits.
- **`sql.js-httpvfs` never evicts its page cache.** A long session running many different queries grows worker memory; the app closes the database when backgrounded to release it.
- **Micronutrient totals are a floor, not a measurement**, whenever branded products are involved. The nutrient screen says so.

---

## Layout

```
src/
  core/        Nutrition and energy science — no UI, no I/O, no framework
    nutrients  50 nutrients keyed by USDA nutrient number
    energy     Mifflin-St Jeor, Katch-McArdle, Harris-Benedict, Cunningham
    trend      Gap-aware EWMA weight smoothing, OLS rate with confidence
    adaptive   Two-state Kalman filter + RTS smoother for expenditure
    macros     Target solver with safety rails
    dri        IOM reference intakes, age- and sex-banded
  db/          Dexie schema, repositories, seeding, encrypted backup
  search/      Tiered lookup: local index, remote SQLite, OFF client, NL parser
  scan/        Barcode and on-device label OCR
  ui/          Primitives, hand-drawn SVG charts, icons
  screens/     Today, Trends, Body, More, sheets, onboarding
scripts/
  fetch-usda      Downloads the USDA bulk export (discovers the latest URL; no key)
  build-core-db   That export -> the bundled offline dataset
  build-food-db   That export + Open Food Facts -> the hosted chunked database
```

The scripts have no dependencies at all — Node 22+ ships SQLite with FTS5 built in.

Diary entries store a **snapshot** of a food's nutrition as it was when logged, not a reference to it. Upstream databases get corrected constantly; your November diary should not quietly change because someone fixed a typo in December.

## Data sources

- [USDA FoodData Central](https://fdc.nal.usda.gov/) — public domain (17 U.S.C. § 105)
- [Open Food Facts](https://world.openfoodfacts.org/) — Open Database License; product names and brands remain their owners' property

## Licence

FuelFlow is free software under the [GNU General Public License v3.0](LICENSE).

You may use, study, share and modify it. If you distribute a modified version,
it has to stay under the same licence and its source has to be available — which
is the point: the app is free, and no one can take this work and ship a closed
paid version of it.

## Privacy

FuelFlow collects nothing. There is no account, no server of ours, and no
analytics. See [PRIVACY.md](PRIVACY.md), published at
[/privacy.html](https://thatguywow.github.io/FuelFlow/privacy.html).

## Running the checks

The tests drive the real app in a real browser, because most of what has gone
wrong in this project was invisible to a unit test.

```bash
npm run dev      # one terminal
npm run check    # another; --only=relevance,portions for a subset
```

`node scripts/audit-core-db.mjs` validates the bundled food dataset separately,
and runs in CI on every build.
