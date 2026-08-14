/**
 * How well a food's text matches what was typed, on a scale every tier shares.
 *
 * Each tier scores its own results on its own terms — the local index counts
 * token hits and applies frecency, the hosted snapshot ranks by its own index,
 * Open Food Facts returns its popularity order. Those numbers are not
 * comparable, so merging the tiers by "score" sorted apples against oranges:
 * searching "egg" once put French pastries above "Egg, whole, raw" purely
 * because the online tier's numbers ran higher.
 *
 * This recomputes relevance from the text alone, 0 to 1, so a single ordering
 * across tiers is meaningful. Adapted from OpenNutriTracker's meal relevance
 * ranker (github.com/simonoppowa/OpenNutriTracker), which solves the same
 * problem across its own set of sources.
 */

const normalise = (text: string | undefined): string =>
  (text ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');

const tokenise = (normalised: string): Set<string> =>
  new Set(normalised.split(/[^\p{L}\p{N}]+/u).filter(Boolean));

/**
 * Token-set overlap: 2·|A∩B| / (|A|+|B|).
 *
 * Order-independent by construction, so "milk chocolate" and "chocolate milk"
 * score identically — which is what a person means when they type either.
 */
function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (matches(token, b)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/**
 * A token counts as present if one side is a prefix of the other.
 *
 * Exact set intersection treats "banana" and "bananas" as unrelated, which
 * scored "Melon, banana (Navajo)" above "Bananas, raw" for the query "banana":
 * the compound name shares its token exactly, the plural shares none. Requiring
 * four characters before a prefix counts keeps short words from matching
 * everything.
 */
function matches(token: string, others: Set<string>): boolean {
  if (others.has(token)) return true;
  if (token.length < 4) return false;
  for (const other of others) {
    if (other.length < 4) continue;
    if (other.startsWith(token) || token.startsWith(other)) return true;
  }
  return false;
}

/**
 * Capped at 0.9 rather than 1, deliberately.
 *
 * Overlap plus both bonuses can exceed 1 for a short name that is close but
 * not equal — "Milk & hazelnut" against "milk" — and would then tie with a
 * genuine exact match and be settled by whatever order the tier happened to
 * return. Leaving headroom below 1 means an exact match always wins outright.
 */
function textScore(text: string | undefined, normalisedQuery: string): number {
  const normalised = normalise(text);
  if (normalised.length === 0) return 0;
  if (normalised === normalisedQuery) return 1;

  const overlap = dice(tokenise(normalised), tokenise(normalisedQuery));
  const contains = normalised.includes(normalisedQuery) ? 0.2 : 0;
  const prefix = normalised.startsWith(normalisedQuery) ? 0.15 : 0;
  return Math.min(0.9, overlap + contains + prefix);
}

/**
 * Relevance of a food to a query, 0 to 1.
 *
 * A brand-only match still surfaces the product — searching "barilla" should
 * find their pasta — but counts for less than the same match on the food's own
 * name, so a query naming a food never loses to a brand that happens to
 * contain the word.
 */
export function relevance(name: string, brand: string | undefined, query: string): number {
  const normalisedQuery = normalise(query);
  if (normalisedQuery.length === 0) return 0;

  const byName = textScore(name, normalisedQuery);
  const byBrand = textScore(brand, normalisedQuery) * 0.6;
  return Math.max(byName, byBrand);
}

/**
 * The key two records must share to be considered the same food.
 *
 * Deliberately exact on normalised text rather than fuzzy: "Chicken breast"
 * and "Chicken breast, grilled" are different foods with different numbers,
 * and silently collapsing them would show one and hide the other. A branded
 * record only ever merges with the same brand, and an unbranded one only with
 * another unbranded — a bare "Milk" must not absorb "Milk (Arla)", because
 * there is no reason to believe they are the same product.
 */
export function nearDuplicateKey(name: string, brand: string | undefined): string | null {
  const normalisedName = normalise(name);
  if (normalisedName.length === 0) return null;
  const normalisedBrand = normalise(brand);
  return normalisedBrand.length === 0 ? normalisedName : `${normalisedName}|${normalisedBrand}`;
}
