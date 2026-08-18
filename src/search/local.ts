import { db, normalizeQuery, type Food, type FoodSource } from '../db/schema';
import { frecencyScore } from '../db/repo';
import { isImperialUnitPortion } from '../core/foodName';
import { foodGrade, headMatch, isAnimalProduct, singular } from '../core/grading';
import { expandToken } from '../core/aliases';
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
  //
  // Phrases, not bare words, and matched on word boundaries. "skin" used to
  // match "skinless" and "bone" used to match "boneless", so the canonical
  // "Chicken, breast, skinless, boneless, meat only, raw" was docked eighteen
  // points for being precisely the cut people search for. "white" did the same
  // to white rice and white bread.
  'yolk',
  'egg white',
  'and skin',
  'skin only',
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
  // Meat analogues file under the meat's own name — "Chicken, meatless" was
  // the top hit for "chicken", ahead of every actual bird.
  'meatless',
  'substitute',
  'imitation',
  // Offal and trim. USDA files these under the animal, so "chicken" returned
  // heart, liver and giblets before any cut anybody eats as chicken.
  'giblets',
  'liver',
  'heart',
  'gizzard',
  'neck',
  'tail',
  'feet',
  'brain',
  'kidney',
  'tongue',
  'tripe',
  // Species and forms that are the marked case. Nobody typing "milk" means
  // sheep milk or evaporated milk, but USDA files them under the same head
  // word as the cow's milk everybody does mean.
  'sheep',
  'goat',
  'buffalo',
  'camel',
  'reindeer',
  'evaporated',
  'condensed',
  'dry',
] as const;

/** Preparation words, so a query naming one suppresses the raw-food tiebreak. */
const PREPARATIONS = new Set([
  'raw', 'cooked', 'roasted', 'baked', 'boiled', 'braised', 'fried', 'grilled',
  'broiled', 'stewed', 'steamed', 'poached', 'scrambled', 'omelet', 'dried',
  'frozen', 'canned', 'smoked', 'toasted', 'hard', 'soft',
]);

/** Source trust ordering: your own data first, then curated, then crowd-sourced. */
const SOURCE_WEIGHT: Record<FoodSource, number> = {
  user: 1.35,
  recipe: 1.3,
  label: 1.2,
  usda: 1.15,
  branded: 1.0,
  off: 0.95,
};

/**
 * Every form of a query word worth looking up: synonyms, plus the singular.
 *
 * The token index is prefix-only, so a query word has to be a *prefix* of the
 * stored token to retrieve anything. That works in one direction — "apple"
 * finds "Apples" — and fails completely in the other, because "white" does not
 * start with "whites". Searching "eggs" therefore returned fish roe and a
 * frozen scrambled mixture: the only foods USDA literally names "Eggs, …",
 * while all ninety-nine filed under "Egg, …" were never even candidates.
 *
 * `singular` already existed for scoring. It was simply never applied to
 * retrieval, so the ranking could only ever order what the index had already
 * thrown away.
 */
function queryGroup(token: string): string[] {
  const stem = singular(token);
  const words = expandToken(token);
  // Stems of the synonyms too, so "courgettes" reaches "zucchini".
  const all = [...words, stem, ...words.map(singular)];
  return [...new Set(all)];
}

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
  /*
   * Each token becomes a group of interchangeable words.
   *
   * "aubergine" also searches "eggplant", "soda" also searches "cola" and
   * "carbonated". The group is satisfied when any of its members matches, so a
   * multi-word query still requires every *concept* to be present — widening
   * recall without loosening the AND.
   *
   * Almost every word expands to just itself, so the common case costs one
   * extra array of length one.
   */
  const groups = tokens.map(queryGroup);

  const cap = options.candidateCap ?? 4000;
  const keySets = await Promise.all(
    groups.map(async (group) => {
      const perWord = await Promise.all(
        group.map((word) => db.foods.where('tokens').startsWith(word).limit(cap).primaryKeys()),
      );
      return [...new Set(perWord.flat() as string[])];
    }),
  );

  let driverIndex = 0;
  for (let i = 1; i < keySets.length; i++) {
    if (keySets[i]!.length < keySets[driverIndex]!.length) driverIndex = i;
  }

  const unique = [...new Set(keySets[driverIndex] as string[])];
  const rest = groups.filter((_, i) => i !== driverIndex);
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
    // Every remaining group must be satisfied by at least one of its words.
    let matchedAll = true;
    for (const group of rest) {
      if (!group.some((word) => food.tokens.some((t) => t.startsWith(word)))) {
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

/**
 * Anatomical parts, recognised as a whole clause of the name.
 *
 * "Egg, white, raw" is the white; "Rice, white, long-grain" is white rice. Only
 * applied to animal products, where the part reading is the right one.
 */
const PART_CLAUSES = new Set([
  'white', 'whites', 'yolk', 'yolks', 'skin', 'fat', 'separable fat',
  'giblets', 'bone', 'bones', 'shell', 'rind',
]);

/** True when a clause of the name names a part rather than a preparation. */
function namesAPart(food: Food, tokens: string[]): boolean {
  if (!isAnimalProduct(food.category)) return false;
  return food.name
    .toLowerCase()
    .split(',')
    .slice(1)
    .map((clause) => clause.trim().replace(/\s*\(.*$/, ''))
    .some((clause) => PART_CLAUSES.has(clause) && !tokens.some((token) => clause.startsWith(token)));
}

/** True when `term` appears in `name` as a whole word (or whole phrase). */
function containsWord(name: string, term: string): boolean {
  const index = name.indexOf(term);
  if (index < 0) return false;
  const before = index === 0 ? ' ' : name[index - 1]!;
  const after = name[index + term.length] ?? ' ';
  return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
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
    // Matched against the stem as well: with a plural query every food would
    // otherwise miss the exact-token bonus and score as a weak partial match.
    const stem = singular(token);
    const exact = food.tokens.includes(token) || food.tokens.includes(stem);
    score += exact ? 10 : 5;
    if (name.includes(token) || name.includes(stem)) score += 3;
  }

  /*
   * Does the query name the food, or something the food is in?
   *
   * This is the signal that was missing, and it is the one that matters most.
   * USDA leads every description with the food and appends qualifiers, so the
   * clause before the first comma is its identity: "Apples" in "Apples, raw",
   * but "Strudel" in "Strudel, apple". Searching "apple" used to return the
   * strudel, the croissant and three Applebee's dishes before the fruit,
   * because all of them contain the word somewhere and the strudel's name is
   * shorter.
   *
   * Scaled rather than boolean, so "Potatoes" beats "Potato flour" for the
   * query "potato" — both begin with it, but only one is *only* it.
   */
  score += headMatch(food.name, tokens) * 26;

  /*
   * How basic the food is, independent of the query.
   *
   * A raw apple and an apple strudel are not equally likely answers to
   * "apple", and USDA's own category already says which is which. Applied as a
   * multiplier so it scales the whole match rather than adding a constant a
   * strong text match could swamp.
   */
  score *= 0.55 + 0.45 * (food.grade ?? foodGrade(food.category));

  // The old concision bonus lived here and had to go: it rewarded short names,
  // and USDA's canonical entries are the long ones. "Rice crackers" beat
  // "Rice, white, long-grain, regular, raw" on brevity alone.
  //
  // A much lighter version survives as a tiebreak: among foods the query names
  // equally well, the one carrying fewer qualifiers is the plainer variant.
  // Small enough that it cannot outweigh the head match or the grade.
  score -= Math.max(0, food.name.split(',').length - 3) * 0.7;

  // Searching "egg" should not surface dried egg yolk powder, and "chicken
  // breast" should not surface a sliced oven-roasted roll. Penalise component
  // and prepared-product qualifiers the query did not actually ask for.
  for (const term of NARROWING_TERMS) {
    // Word boundaries: a term must be a word of the name, not a fragment of a
    // longer one. Substring matching is what made "boneless" read as "bone".
    if (!containsWord(name, term)) continue;
    if (tokens.some((token) => term.startsWith(token))) continue;
    score -= 9;
  }

  if (namesAPart(food, tokens)) score -= 12;

  /*
   * A tiebreak, so the order among equivalent variants is chosen rather than
   * accidental.
   *
   * Every "Egg, whole, …" entry scored exactly 53.7 — raw, poached, scrambled
   * and fried were indistinguishable, and the raw one leading was luck. When
   * the query names no preparation, the unprepared form is the one it means:
   * it is the base the others are derived from, and the one people weigh.
   * Deliberately small — it separates equals and cannot outrank a better match.
   */
  if (!tokens.some((token) => PREPARATIONS.has(token)) && containsWord(name, 'raw')) score += 1.5;

  // Records without usable energy data are noise.
  const energy = food.per100g[N.ENERGY];
  if (energy === undefined || energy <= 0) score -= 25;

  score *= SOURCE_WEIGHT[food.source] ?? 1;
  score += (food.quality ?? 0.5) * 6;
  if (food.verified) score += 4;
  // A figure a laboratory measured is worth more than one calculated from a
  // recipe. Small on purpose: it breaks ties between comparable records rather
  // than reordering the results.
  if (food.origin === 'analysis') score += 3;
  else if (food.origin === 'calculated') score -= 1;

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
