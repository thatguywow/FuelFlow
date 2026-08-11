import { db, normalizeQuery, type Food, type FoodSource } from '../db/schema';
import { frecencyScore } from '../db/repo';
import { N } from '../core/nutrients';

/**
 * Local food search.
 *
 * Runs entirely against IndexedDB with no search library. The `*tokens`
 * multiEntry index does the heavy lifting: the rarest query token drives a
 * single indexed prefix scan, and the remaining tokens are checked in memory
 * against the (small) candidate set. That is one index range read plus one
 * bulk fetch per keystroke — fast enough to run on every character typed, with
 * a fraction of the bundle cost of a client-side search engine.
 */

export interface SearchHit {
  food: Food;
  score: number;
  /** Where the result came from, for the section header in the results list. */
  tier: 'personal' | 'core' | 'remote' | 'online';
  /** Amount to pre-fill in the picker: your usual amount, else a sane default. */
  suggestedGrams?: number;
  /**
   * The amount *you* last logged, when there is one. Deliberately separate from
   * `suggestedGrams`: a default of 100 g is a placeholder, whereas a real
   * personal history is evidence, and the quick-log parser must only treat the
   * latter as a per-unit weight.
   */
  typicalGrams?: number;
}

export interface LocalSearchOptions {
  limit?: number;
  /** Restrict to these sources — used by the "My foods" and "Recipes" filters. */
  sources?: FoodSource[];
  /** Candidate ceiling for the driving index scan. */
  candidateCap?: number;
}

/**
 * Words that mark a record as a narrower variant than a bare query implies —
 * either a component of the food or a processed form of it.
 */
const NARROWING_TERMS = [
  'yolk',
  'white',
  'dried',
  'powder',
  'dehydrated',
  'concentrate',
  'skin',
  'bone',
  'shell',
  'peel',
  'leaves',
  'juice',
  'canned',
  'infant',
  'baby food',
] as const;

/** Source trust ordering: your own data first, then curated, then crowd-sourced. */
const SOURCE_WEIGHT: Record<FoodSource, number> = {
  user: 1.35,
  recipe: 1.3,
  label: 1.2,
  usda: 1.15,
  branded: 1.0,
  off: 0.95,
};

export async function searchLocal(query: string, options: LocalSearchOptions = {}): Promise<SearchHit[]> {
  const limit = options.limit ?? 40;
  const tokens = normalizeQuery(query);
  if (tokens.length === 0) return recentFoods(limit);

  // A bare number of barcode length is a barcode, not a food name.
  if (/^\d{8,14}$/.test(query.trim())) {
    const exact = await db.foods.where('barcode').equals(query.trim()).first();
    if (exact && !exact.deleted) {
      return [{ food: exact, score: 1000, tier: tierFor(exact), suggestedGrams: await suggestGrams(exact) }];
    }
  }

  // The longest token is the most selective, so it drives the index scan.
  const driver = [...tokens].sort((a, b) => b.length - a.length)[0]!;
  const rest = tokens.filter((t) => t !== driver);

  const keys = await db.foods
    .where('tokens')
    .startsWith(driver)
    .limit(options.candidateCap ?? 1500)
    .primaryKeys();

  const unique = [...new Set(keys as string[])];
  if (unique.length === 0) return [];

  const candidates = (await db.foods.bulkGet(unique)).filter(
    (f): f is Food => !!f && !f.deleted && (!options.sources || options.sources.includes(f.source)),
  );

  const usage = await db.usage.bulkGet(candidates.map((f) => f.id));
  const usageById = new Map<string, (typeof usage)[number]>();
  candidates.forEach((f, i) => usageById.set(f.id, usage[i]));

  const at = Date.now();
  const hits: SearchHit[] = [];

  for (const food of candidates) {
    // Every remaining query token must prefix-match one of the food's tokens.
    let matchedAll = true;
    for (const token of rest) {
      if (!food.tokens.some((t) => t.startsWith(token))) {
        matchedAll = false;
        break;
      }
    }
    if (!matchedAll) continue;

    const score = scoreFood(food, tokens, usageById.get(food.id), at);
    hits.push({ food, score, tier: tierFor(food) });
  }

  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, limit);
  for (const hit of top) {
    const typical = usageById.get(hit.food.id)?.typicalGrams;
    hit.typicalGrams = typical;
    hit.suggestedGrams = suggestGramsSync(hit.food, typical);
  }
  return top;
}

function scoreFood(
  food: Food,
  tokens: string[],
  usage: { useCount: number; lastUsedAt: number; favorite?: boolean } | undefined,
  at: number,
): number {
  const name = food.name.toLowerCase();
  let score = 0;

  for (const token of tokens) {
    const exact = food.tokens.includes(token);
    score += exact ? 10 : 5;
    // A query that matches the beginning of the name is almost always what the
    // user meant: "chicken" should surface "Chicken, breast" over
    // "Soup, cream of chicken".
    if (name.startsWith(token)) score += 8;
    else if (name.includes(token)) score += 3;
  }

  // Prefer concise names. Long USDA descriptions are usually oddly specific
  // variants ("Chicken, broiler, meat and skin, cooked, stewed").
  score += Math.max(0, 8 - name.length / 12);

  // USDA descriptions are "food, qualifier, qualifier, …". Each extra clause
  // narrows the record, so a plain search should favour the plainer entry.
  score -= Math.max(0, name.split(',').length - 2) * 1.5;

  // Searching "egg" should not surface dried egg yolk powder. Penalise
  // component and processing qualifiers the query did not actually ask for.
  for (const term of NARROWING_TERMS) {
    if (name.includes(term) && !tokens.some((token) => term.startsWith(token))) score -= 4;
  }

  // Records without usable energy data are noise.
  const energy = food.per100g[N.ENERGY];
  if (energy === undefined || energy <= 0) score -= 25;

  score *= SOURCE_WEIGHT[food.source] ?? 1;
  score += (food.quality ?? 0.5) * 6;
  if (food.verified) score += 4;

  if (usage) {
    score += frecencyScore(usage, at) * 18;
    if (usage.favorite) score += 15;
  }
  return score;
}

function tierFor(food: Food): SearchHit['tier'] {
  if (food.source === 'user' || food.source === 'recipe' || food.source === 'label') return 'personal';
  if (food.source === 'usda') return 'core';
  return 'remote';
}

/** Best default amount: what you used last time, else the preferred portion. */
function suggestGramsSync(food: Food, typicalGrams?: number): number {
  if (typicalGrams && typicalGrams > 0) return typicalGrams;
  const preferred = food.portions.find((p) => p.preferred) ?? food.portions[0];
  return preferred?.grams ?? 100;
}

async function suggestGrams(food: Food): Promise<number> {
  const usage = await db.usage.get(food.id);
  return suggestGramsSync(food, usage?.typicalGrams);
}

/**
 * The empty-search-box list: favourites first, then most-frecent foods. After a
 * couple of weeks this is where the majority of logging actually happens, and
 * it never touches the network.
 */
export async function recentFoods(limit = 30): Promise<SearchHit[]> {
  const usage = await db.usage.orderBy('lastUsedAt').reverse().limit(300).toArray();
  if (usage.length === 0) return [];

  const at = Date.now();
  const ranked = usage
    .map((u) => ({ usage: u, score: frecencyScore(u, at) + (u.favorite ? 5 : 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const foods = await db.foods.bulkGet(ranked.map((r) => r.usage.foodId));
  const hits: SearchHit[] = [];
  ranked.forEach((r, i) => {
    const food = foods[i];
    if (!food || food.deleted) return;
    hits.push({
      food,
      score: r.score,
      tier: tierFor(food),
      typicalGrams: r.usage.typicalGrams,
      suggestedGrams: suggestGramsSync(food, r.usage.typicalGrams),
    });
  });
  return hits;
}

/** Foods usually eaten at this meal, used to pre-populate the add sheet. */
export async function suggestionsForMeal(mealId: string, limit = 12): Promise<SearchHit[]> {
  const usage = await db.usage.orderBy('lastUsedAt').reverse().limit(400).toArray();
  const relevant = usage.filter((u) => u.mealAffinity?.[0] === mealId);
  if (relevant.length === 0) return recentFoods(limit);

  const at = Date.now();
  const ranked = relevant
    .map((u) => ({ usage: u, score: frecencyScore(u, at) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const foods = await db.foods.bulkGet(ranked.map((r) => r.usage.foodId));
  const hits: SearchHit[] = [];
  ranked.forEach((r, i) => {
    const food = foods[i];
    if (!food || food.deleted) return;
    hits.push({
      food,
      score: r.score,
      tier: tierFor(food),
      typicalGrams: r.usage.typicalGrams,
      suggestedGrams: suggestGramsSync(food, r.usage.typicalGrams),
    });
  });
  return hits;
}
