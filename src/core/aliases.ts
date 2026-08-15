/**
 * Food synonyms, so a search finds the food rather than the exact phrase USDA
 * happened to file it under.
 *
 * OpenNutriTracker's backend keeps a `food_alias` table: extra names per food,
 * per locale, so "Spaghetti" or a romanised Hindi name reaches the record. The
 * same problem exists here — searching "soda" never found "Carbonated beverage,
 * cola", and "aubergine" never found an eggplant — but the fix belongs on the
 * other side of the index for us.
 *
 * Expanding the *query* rather than the stored tokens means no dataset rebuild,
 * no reseeding, and it works on every food already on the device, including the
 * ones cached from Open Food Facts. It also keeps the multiEntry token index
 * exactly as small as it is now; the alternative would have added several
 * million index rows to store words nobody typed.
 *
 * Groups are unordered sets of equivalents: matching any member matches the
 * group. Kept deliberately short and specific. A loose thesaurus makes search
 * worse, not better — "chicken" should not quietly also mean "poultry", because
 * then a search for one can never exclude the other.
 */

/** Each line is one set of interchangeable words. */
const GROUPS: string[][] = [
  // Regional English. The single largest source of misses: the dataset is
  // written in American English and half the world is not.
  ['aubergine', 'eggplant', 'brinjal'],
  ['courgette', 'zucchini'],
  ['coriander', 'cilantro'],
  ['rocket', 'arugula'],
  ['swede', 'rutabaga'],
  ['spring', 'scallion', 'scallions'],
  ['capsicum', 'pepper', 'peppers'],
  ['maize', 'corn'],
  ['groundnut', 'groundnuts', 'peanut', 'peanuts'],
  ['chickpea', 'chickpeas', 'garbanzo', 'garbanzos'],
  ['prawn', 'prawns', 'shrimp'],
  ['mince', 'minced', 'ground'],
  ['porridge', 'oatmeal'],
  ['biscuit', 'biscuits', 'cookie', 'cookies'],
  ['sultana', 'sultanas', 'raisin', 'raisins'],
  ['beetroot', 'beet', 'beets'],
  ['okra', 'ladyfinger'],
  ['curd', 'curds', 'yogurt', 'yoghurt'],
  ['sweetcorn', 'corn'],
  ['pak', 'bok'],

  // Spelling variants.
  ['yoghurt', 'yogurt'],
  ['doughnut', 'doughnuts', 'donut', 'donuts'],
  ['fibre', 'fiber'],
  ['flavour', 'flavor'],
  ['savoury', 'savory'],
  ['wholemeal', 'wholewheat', 'wholegrain'],

  // Colloquial names for things the dataset files under a technical phrase.
  ['soda', 'sodas', 'pop', 'cola', 'carbonated'],
  ['fries', 'chips', 'fried'],
  ['crisps', 'chips'],
  ['soy', 'soya', 'soybean', 'soybeans'],
  ['aubergines', 'eggplants'],
  ['courgettes', 'zucchinis'],
  ['tomatoe', 'tomato', 'tomatoes'],
  ['potatoe', 'potato', 'potatoes'],

  // Cuts and preparations people type but the catalogue words differently.
  ['skinless', 'skin'],
  ['boneless', 'bone'],
  ['wholemilk', 'whole'],
  ['semiskimmed', 'reduced'],
  ['skimmed', 'skim', 'nonfat', 'fatfree'],
  ['courgette', 'zucchini'],
  ['rasher', 'rashers', 'bacon'],
  ['aubergine', 'eggplant'],
];

/**
 * word -> every equivalent, itself included.
 *
 * Built once. A word appearing in two groups accumulates both, which is what
 * makes "chips" reach french fries and potato crisps alike.
 */
const EQUIVALENTS = new Map<string, Set<string>>();
for (const group of GROUPS) {
  for (const word of group) {
    let set = EQUIVALENTS.get(word);
    if (!set) {
      set = new Set<string>();
      EQUIVALENTS.set(word, set);
    }
    for (const other of group) set.add(other);
  }
}

/**
 * Every form of a query token worth searching for, the original first.
 *
 * Returns a single-element list for the overwhelming majority of words, so the
 * caller pays nothing for the ones that have no synonyms.
 */
export function expandToken(token: string): string[] {
  const equivalents = EQUIVALENTS.get(token);
  if (!equivalents) return [token];
  // The typed word leads: it is the one the relevance scorer should reward
  // most, and the alternatives exist to widen recall rather than to reorder.
  return [token, ...[...equivalents].filter((word) => word !== token)];
}

/** True when the word carries alternatives — used only for reporting. */
export function hasAliases(token: string): boolean {
  return EQUIVALENTS.has(token);
}
