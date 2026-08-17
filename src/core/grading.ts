/**
 * How basic a food is, and how well a query names it.
 *
 * Searching "apple" returned apple strudel, apple croissants and three
 * Applebee's menu items before it returned an apple. "rice" returned rice
 * crackers and rice flour. "milk" returned a milk-and-cereal bar. The cause was
 * a scoring rule that rewarded short names, and USDA writes its canonical
 * entries as the *longest* ones — "Rice, white, long-grain, regular, raw,
 * enriched" against "Rice crackers".
 *
 * Two ideas replace it, and they are independent of each other.
 *
 * `grade` is a property of the food alone, computed once when it is stored: how
 * close it is to an ingredient rather than a manufactured product. USDA files
 * every food under a category, and those categories separate a raw apple
 * (Fruits) from a strudel (Baked Products) and from an Applebee's side
 * (Restaurant Foods) exactly as a person would.
 *
 * `headMatch` is a property of the query against the name: whether the words
 * typed name the food itself or something the food is merely *in*. USDA leads
 * with the food and appends qualifiers, so the clause before the first comma is
 * the food's actual identity — "Apples" in "Apples, raw", but "Strudel" in
 * "Strudel, apple". A query that matches the head is asking for the food; one
 * that only matches later is asking for a product containing it.
 */

/**
 * USDA food category ids, graded by how processed the category is.
 *
 * These ids are stable and shipped with every food, which is what makes this
 * cheap: no extra data, no curation, no per-food judgement.
 */
const CATEGORY_GRADE = new Map<number, number>([
  // Whole ingredients.
  [1, 1.0],   // Dairy and Egg Products
  [2, 0.95],  // Spices and Herbs
  [4, 0.95],  // Fats and Oils
  [5, 1.0],   // Poultry Products
  [9, 1.0],   // Fruits and Fruit Juices
  [10, 1.0],  // Pork Products
  [11, 1.0],  // Vegetables and Vegetable Products
  [12, 1.0],  // Nut and Seed Products
  [13, 1.0],  // Beef Products
  [15, 1.0],  // Finfish and Shellfish Products
  [16, 1.0],  // Legumes and Legume Products
  [17, 1.0],  // Lamb, Veal, and Game Products
  [20, 1.0],  // Cereal Grains and Pasta

  // Processed, but still what somebody might mean by the bare word.
  [7, 0.75],  // Sausages and Luncheon Meats
  [8, 0.7],   // Breakfast Cereals
  [14, 0.8],  // Beverages

  // Composite dishes and manufactured products.
  [6, 0.55],  // Soups, Sauces, and Gravies
  [18, 0.5],  // Baked Products
  [19, 0.5],  // Sweets
  [22, 0.5],  // Meals, Entrees, and Side Dishes
  [23, 0.45], // Snacks
  [24, 0.6],  // American Indian/Alaska Native Foods

  // Somebody else cooked it. Almost never what a one-word query means.
  [3, 0.3],   // Baby Foods
  [21, 0.3],  // Fast Foods
  [25, 0.3],  // Restaurant Foods
]);

/**
 * Categories where a food is an animal product.
 *
 * Needed because the same word means different things by category: "white" is
 * a *part* of an egg but a *variety* of rice, and "skin" is a part of a chicken
 * but the good bit of a potato. Penalising the word outright demoted white rice
 * and apples with skin; keying on the category gets both right.
 */
const ANIMAL_CATEGORIES = new Set([1, 5, 7, 10, 13, 15, 17]);

export function isAnimalProduct(category: string | undefined): boolean {
  return category !== undefined && ANIMAL_CATEGORIES.has(Number(category));
}

/** Grade for a food that carries no USDA category — products, recipes, labels. */
const UNGRADED = 0.85;

/**
 * 0–1, higher meaning closer to a plain ingredient.
 *
 * Deliberately not a judgement about nutrition. A raw apple and lard are both
 * ingredients and both score 1.0; the question is only whether somebody typing
 * one word is likely to have meant this record.
 */
export function foodGrade(category: string | undefined): number {
  if (!category) return UNGRADED;
  const id = Number(category);
  if (!Number.isFinite(id)) return UNGRADED;
  return CATEGORY_GRADE.get(id) ?? 0.7;
}

/**
 * Crude singular form, enough to match "apple" against "Apples".
 *
 * Not a real stemmer and does not need to be: it only has to make the plural
 * USDA uses for produce line up with the singular people type.
 */
export function singular(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  // "-oes" belongs here too: without it "potatoes" stemmed to "potatoe" and
  // stopped matching "potato", which is what let potato flour outrank the
  // potato.
  if (/(s|x|z|ch|sh|o)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** Words of the clause before the first comma — the food's own identity. */
export function headWords(name: string): string[] {
  return (name.split(',')[0] ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .split(/[^a-z0-9%]+/)
    .filter(Boolean);
}

/**
 * How completely the query names the food itself, 0–1.
 *
 * 1.0 means the head clause is exactly the query: "Apples" for "apple",
 * "Rice" for "rice". Extra words in the head dilute it, so "Potato flour"
 * scores below "Potatoes" for the query "potato" even though both begin with
 * it. Zero means the query does not appear in the head at all, which is the
 * case for every product that merely contains the food.
 */
export function headMatch(name: string, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const head = headWords(name).map(singular);
  if (head.length === 0) return 0;

  /*
   * A whole word counts for far more than a prefix.
   *
   * "bread" is a prefix of "breadfruit", and a one-word head scores full marks
   * on brevity — so breadfruit was the top result for "bread". Prefix matching
   * still earns something, because it is what lets a half-typed query work
   * while it is being typed.
   */
  let matched = 0;
  for (const token of queryTokens) {
    const stem = singular(token);
    if (head.some((word) => word === stem)) matched += 1;
    else if (head.some((word) => word.startsWith(stem) || stem.startsWith(word))) matched += 0.45;
  }
  if (matched === 0) return 0;

  // Every query word present, and the head says nothing else: an exact naming.
  const coverage = matched / queryTokens.length;
  const brevity = queryTokens.length / Math.max(queryTokens.length, head.length);
  return coverage * brevity;
}
