import { db, normalizeQuery, type Food, type FoodSource } from '../db/schema';
import { frecencyScore } from '../db/repo';
import { isImperialUnitPortion } from '../core/foodName';
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
  // Components of a food rather than the food.
  'yolk',
  'white',
  'skin',
  'bone',
  'shell',
  'peel',
  'leaves',
  // Preserved or reconstituted forms.
  'dried',
  'powder',
  'dehydrated',
  'concentrate',
  'juice',
  'canned',
  'infant',
  'baby food',
  // Prepared products made *from* the food. Searching "chicken breast" was
  // returning "Chicken breast, roll, oven-roasted" and "breast tenders,
  // breaded" above the actual cut, because those names are shorter and carry
  // fewer comma-separated clauses — the two things the score already rewards.
  // Nobody typing a bare cut means the deli product.
  'roll',
  'breaded',
  'battered',
  'sliced',
  'flavor',
  'flavour',
  'smoked',
  'cured',
  'patty',
  'nugget',
  'luncheon',
  'spread',
  'with added solution',
  // Things made *from* the food, which USDA files under the food's own name:
  // "Fish oil, salmon" outranked every actual salmon, and "Egg custards, dry
  // mix" outranked the egg. Naming the term in the query lifts the penalty, so
  // searching "olive oil" or "cake mix" still works.
  'oil',
  'mix',
  'custard',
  'chips',
  'snack',
  'sauce',
  'soup',
  'candies',
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

  // Fetch the candidate keys for every token, then drive from the *rarest*.
  //
  // Driving from the longest token instead looks reasonable and is subtly
  // broken: searching "white rice cooked" picked "cooked", which matches ~1800
  // foods, so the candidate cap truncated the list before the right row was
  // reached and the search returned nothing — while the half-typed "white rice
  // cooke" happened to pick "white" (~240 matches) and worked. Longer does not
  // mean rarer. The smallest key set is the selective one by definition, and
  // it is the only one guaranteed not to have been truncated.
  const cap = options.candidateCap ?? 4000;
  const keySets = await Promise.all(
    tokens.map((token) => db.foods.where('tokens').startsWith(token).limit(cap).primaryKeys()),
  );

  let driverIndex = 0;
  for (let i = 1; i < keySets.length; i++) {
    if (keySets[i]!.length < keySets[driverIndex]!.length) driverIndex = i;
  }

  const unique = [...new Set(keySets[driverIndex] as string[])];
  const rest = tokens.filter((_, i) => i !== driverIndex);
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
  //
  // Kept deliberately light. The canonical generic entries are the verbose
  // ones — "Chicken, broilers or fryers, breast, meat only, raw" — so a heavy
  // per-clause penalty demotes exactly the records a bare query wants, and
  // hands the top spot to short deli-product names instead.
  score -= Math.max(0, name.split(',').length - 2) * 0.8;

  // Searching "egg" should not surface dried egg yolk powder, and "chicken
  // breast" should not surface a sliced oven-roasted roll. Penalise component
  // and prepared-product qualifiers the query did not actually ask for. This
  // has to outweigh the concision bonus a short product name earns, or the
  // product still wins.
  for (const term of NARROWING_TERMS) {
    if (name.includes(term) && !tokens.some((token) => term.startsWith(token))) score -= 9;
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
  // Bare imperial units are unit conversions, not servings. USDA marks them
  // preferred often enough that search rows advertised "113 g" — one ounce —
  // as the amount for a chicken breast.
  const usable = food.portions.filter((p) => !isImperialUnitPortion(p.label));
  const preferred = usable.find((p) => p.preferred) ?? usable.find((p) => p.grams === 100) ?? usable[0];
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
