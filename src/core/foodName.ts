/**
 * Turning USDA descriptions into something a person would recognise.
 *
 * USDA writes its descriptions as database keys, head noun first and every
 * qualifier appended: "Chicken, broilers or fryers, breast, meat only, raw".
 * That is precise and unreadable — someone who typed "chicken breast raw" gets
 * back a string that does not look like what they asked for, even though it is
 * exactly the right food.
 *
 * This runs at display time rather than in the dataset. Search matches against
 * the original text, so "broilers" still finds the record, and the diary keeps
 * whatever name it was logged under. Only the label changes.
 *
 * Deliberately conservative: anything it cannot confidently rearrange is left
 * exactly as it was. A wrong name on the right food is worse than an ugly one.
 */

/**
 * A portion label short enough to read in a picker.
 *
 * USDA measure names carry their whole derivation — "breast, bone removed
 * (yield from 1 lb ready-to-cook chicken)" — which is a paragraph in a control
 * about two words wide. The parenthetical is provenance, not what you are
 * choosing, so it goes.
 */
export function shortPortion(label: string): string {
  const withoutAside = label.replace(/\s*\([^)]*\)/g, '').trim();
  const base = withoutAside.length > 0 ? withoutAside : label.trim();
  // Still long? Keep the first two clauses — "breast, bone removed" says it.
  const clauses = base.split(',').map((c) => c.trim()).filter(Boolean);
  if (clauses.length > 2) return clauses.slice(0, 2).join(', ');
  return base;
}

/**
 * True when a portion's name already states its weight, so printing the mass
 * beside it would just say the same thing twice — "100 g · 100 g".
 */
export function portionStatesItsMass(label: string): boolean {
  return /^[\d.,]+\s*(g|ml|kg|l|oz|lb)$/i.test(label.trim());
}

/** How the food was prepared. These read naturally after a comma. */
const PREPARATIONS = new Set([
  'raw',
  'cooked',
  'roasted',
  'baked',
  'boiled',
  'braised',
  'fried',
  'grilled',
  'broiled',
  'stewed',
  'steamed',
  'poached',
  'microwaved',
  'dried',
  'frozen',
  'canned',
  'smoked',
  'unprepared',
  'prepared',
  'toasted',
]);

/**
 * Cataloguing detail that means nothing to a person choosing a food. These are
 * dropped from the headline and kept in the detail line.
 */
const CATALOGUE = [
  'broilers or fryers',
  'broiler or fryers',
  'all classes',
  'composite of trimmed retail cuts',
  'trimmed to',
  'separable lean only',
  'separable lean and fat',
  'meat only',
  'meat and skin',
  'with added solution',
  'enhanced',
  'includes foods for usda',
  'unenriched',
  'enriched',
  'commercially prepared',
  'home-prepared',
  'nfs',
  'usda commodity',
];

const isPreparation = (clause: string) => PREPARATIONS.has(clause.toLowerCase());
const isCatalogue = (clause: string) => {
  const lower = clause.toLowerCase();
  return CATALOGUE.some((term) => lower.includes(term));
};

export interface DisplayName {
  /** What to show as the food's name. */
  primary: string;
  /** The qualifiers that were moved out of it, or undefined if none were. */
  detail?: string;
}

/**
 * "Chicken, broilers or fryers, breast, meat only, raw"
 *   -> { primary: "Chicken breast, raw", detail: "broilers or fryers · meat only" }
 */
export function displayName(name: string): DisplayName {
  const clauses = name
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  // One or two clauses is already readable: "Bananas, raw", "Olive oil".
  if (clauses.length <= 2) return { primary: name.trim() };

  const head = clauses[0]!;
  const rest = clauses.slice(1);

  const preparations: string[] = [];
  const catalogue: string[] = [];
  const descriptors: string[] = [];

  for (const clause of rest) {
    if (isPreparation(clause)) preparations.push(clause);
    else if (isCatalogue(clause)) catalogue.push(clause);
    else descriptors.push(clause);
  }

  // The cut or variety — "breast", "short-grain" — belongs in the name itself,
  // reading as a compound noun with the head: "Chicken breast", "Rice, white".
  // Only a single-word descriptor is promoted; anything longer is a phrase that
  // would not read as part of the noun.
  const promoted = descriptors.find((d) => !d.includes(' '));
  const remaining = descriptors.filter((d) => d !== promoted);

  const primaryParts = [promoted ? `${head} ${promoted}` : head];
  if (remaining.length > 0) primaryParts.push(...remaining);
  if (preparations.length > 0) primaryParts.push(preparations.join(', '));

  const primary = primaryParts.join(', ');
  const detail = catalogue.length > 0 ? catalogue.join(' · ') : undefined;

  // If nothing was actually moved, keep the original rather than reassembling
  // an identical string by a different route.
  if (primary.toLowerCase() === name.trim().toLowerCase()) return { primary: name.trim() };

  return { primary, detail };
}
