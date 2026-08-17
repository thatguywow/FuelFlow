/**
 * Nutrient vocabulary.
 *
 * Nutrient identifiers are USDA FoodData Central nutrient numbers. Using the
 * upstream numbering (rather than inventing our own) means the dataset build
 * scripts, the bundled core foods, the remote branded database and any future
 * import path all speak the same language with no translation table.
 *
 * Every food in FuelFlow stores its nutrients per 100 g (or per 100 ml for
 * liquids). Portions are stored as gram weights, so all arithmetic in the app
 * is a single multiply — no unit ambiguity ever reaches the UI layer.
 */

export const N = {
  // Energy & macros
  ENERGY: 208,
  PROTEIN: 203,
  FAT: 204,
  CARBS: 205,
  FIBER: 291,
  SUGAR: 269,
  ADDED_SUGAR: 539,
  STARCH: 209,
  ALCOHOL: 221,
  WATER: 255,

  // Lipid detail
  SAT_FAT: 606,
  MONO_FAT: 645,
  POLY_FAT: 646,
  TRANS_FAT: 605,
  CHOLESTEROL: 601,
  OMEGA3_ALA: 851,
  OMEGA3_EPA: 629,
  OMEGA3_DHA: 621,

  // Minerals
  CALCIUM: 301,
  IRON: 303,
  MAGNESIUM: 304,
  PHOSPHORUS: 305,
  POTASSIUM: 306,
  SODIUM: 307,
  ZINC: 309,
  COPPER: 312,
  MANGANESE: 315,
  SELENIUM: 317,

  // Vitamins
  VIT_A: 320,
  VIT_C: 401,
  VIT_D: 328,
  VIT_E: 323,
  VIT_K: 430,
  THIAMIN: 404,
  RIBOFLAVIN: 405,
  NIACIN: 406,
  PANTOTHENIC: 410,
  VIT_B6: 415,
  FOLATE: 435,
  VIT_B12: 418,
  CHOLINE: 421,

  // Other
  CAFFEINE: 262,

  // Essential amino acids
  TRYPTOPHAN: 501,
  THREONINE: 502,
  ISOLEUCINE: 503,
  LEUCINE: 504,
  LYSINE: 505,
  METHIONINE: 506,
  CYSTINE: 507,
  PHENYLALANINE: 508,
  TYROSINE: 509,
  VALINE: 510,
  HISTIDINE: 512,
} as const;

export type NutrientId = (typeof N)[keyof typeof N];

/** A sparse nutrient vector, always expressed per 100 g / 100 ml of the food. */
export type Nutrients = Partial<Record<number, number>>;

export type NutrientUnit = 'kcal' | 'g' | 'mg' | 'µg' | 'ml';

export type NutrientGroup = 'energy' | 'macro' | 'lipid' | 'mineral' | 'vitamin' | 'amino' | 'other';

export interface NutrientDef {
  id: NutrientId;
  /** Stable machine name, used in exports and CSV headers. */
  key: string;
  label: string;
  /** Compact label for dense UI (chips, table headers). */
  short: string;
  unit: NutrientUnit;
  group: NutrientGroup;
  /** Decimal places to show. Micronutrients need more than macros. */
  precision: number;
  /** Nutrients that are a subset of another (e.g. sugar within carbs). */
  parent?: NutrientId;
  /** Lower is better — flips progress-bar semantics from "hit it" to "cap it". */
  limit?: boolean;
}

export const NUTRIENTS: readonly NutrientDef[] = [
  { id: N.ENERGY, key: 'energy', label: 'Energy', short: 'kcal', unit: 'kcal', group: 'energy', precision: 0 },

  { id: N.PROTEIN, key: 'protein', label: 'Protein', short: 'Protein', unit: 'g', group: 'macro', precision: 1 },
  { id: N.CARBS, key: 'carbs', label: 'Carbohydrate', short: 'Carbs', unit: 'g', group: 'macro', precision: 1 },
  { id: N.FAT, key: 'fat', label: 'Fat', short: 'Fat', unit: 'g', group: 'macro', precision: 1 },
  { id: N.FIBER, key: 'fiber', label: 'Fiber', short: 'Fiber', unit: 'g', group: 'macro', precision: 1, parent: N.CARBS },
  { id: N.SUGAR, key: 'sugar', label: 'Sugars', short: 'Sugar', unit: 'g', group: 'macro', precision: 1, parent: N.CARBS },
  { id: N.ADDED_SUGAR, key: 'addedSugar', label: 'Added sugars', short: 'Added sug.', unit: 'g', group: 'macro', precision: 1, parent: N.CARBS, limit: true },
  { id: N.STARCH, key: 'starch', label: 'Starch', short: 'Starch', unit: 'g', group: 'macro', precision: 1, parent: N.CARBS },
  { id: N.ALCOHOL, key: 'alcohol', label: 'Alcohol', short: 'Alcohol', unit: 'g', group: 'macro', precision: 1 },
  { id: N.WATER, key: 'water', label: 'Water', short: 'Water', unit: 'g', group: 'macro', precision: 0 },

  { id: N.SAT_FAT, key: 'satFat', label: 'Saturated fat', short: 'Sat. fat', unit: 'g', group: 'lipid', precision: 1, parent: N.FAT, limit: true },
  { id: N.MONO_FAT, key: 'monoFat', label: 'Monounsaturated fat', short: 'Mono', unit: 'g', group: 'lipid', precision: 1, parent: N.FAT },
  { id: N.POLY_FAT, key: 'polyFat', label: 'Polyunsaturated fat', short: 'Poly', unit: 'g', group: 'lipid', precision: 1, parent: N.FAT },
  { id: N.TRANS_FAT, key: 'transFat', label: 'Trans fat', short: 'Trans', unit: 'g', group: 'lipid', precision: 2, parent: N.FAT, limit: true },
  { id: N.CHOLESTEROL, key: 'cholesterol', label: 'Cholesterol', short: 'Chol.', unit: 'mg', group: 'lipid', precision: 0, limit: true },
  { id: N.OMEGA3_ALA, key: 'ala', label: 'Omega-3 ALA', short: 'ALA', unit: 'g', group: 'lipid', precision: 2 },
  { id: N.OMEGA3_EPA, key: 'epa', label: 'Omega-3 EPA', short: 'EPA', unit: 'g', group: 'lipid', precision: 3 },
  { id: N.OMEGA3_DHA, key: 'dha', label: 'Omega-3 DHA', short: 'DHA', unit: 'g', group: 'lipid', precision: 3 },

  { id: N.CALCIUM, key: 'calcium', label: 'Calcium', short: 'Ca', unit: 'mg', group: 'mineral', precision: 0 },
  { id: N.IRON, key: 'iron', label: 'Iron', short: 'Fe', unit: 'mg', group: 'mineral', precision: 1 },
  { id: N.MAGNESIUM, key: 'magnesium', label: 'Magnesium', short: 'Mg', unit: 'mg', group: 'mineral', precision: 0 },
  { id: N.PHOSPHORUS, key: 'phosphorus', label: 'Phosphorus', short: 'P', unit: 'mg', group: 'mineral', precision: 0 },
  { id: N.POTASSIUM, key: 'potassium', label: 'Potassium', short: 'K', unit: 'mg', group: 'mineral', precision: 0 },
  { id: N.SODIUM, key: 'sodium', label: 'Sodium', short: 'Na', unit: 'mg', group: 'mineral', precision: 0, limit: true },
  { id: N.ZINC, key: 'zinc', label: 'Zinc', short: 'Zn', unit: 'mg', group: 'mineral', precision: 1 },
  { id: N.COPPER, key: 'copper', label: 'Copper', short: 'Cu', unit: 'mg', group: 'mineral', precision: 2 },
  { id: N.MANGANESE, key: 'manganese', label: 'Manganese', short: 'Mn', unit: 'mg', group: 'mineral', precision: 2 },
  { id: N.SELENIUM, key: 'selenium', label: 'Selenium', short: 'Se', unit: 'µg', group: 'mineral', precision: 1 },

  { id: N.VIT_A, key: 'vitaminA', label: 'Vitamin A', short: 'A', unit: 'µg', group: 'vitamin', precision: 0 },
  { id: N.VIT_C, key: 'vitaminC', label: 'Vitamin C', short: 'C', unit: 'mg', group: 'vitamin', precision: 1 },
  { id: N.VIT_D, key: 'vitaminD', label: 'Vitamin D', short: 'D', unit: 'µg', group: 'vitamin', precision: 1 },
  { id: N.VIT_E, key: 'vitaminE', label: 'Vitamin E', short: 'E', unit: 'mg', group: 'vitamin', precision: 1 },
  { id: N.VIT_K, key: 'vitaminK', label: 'Vitamin K', short: 'K', unit: 'µg', group: 'vitamin', precision: 1 },
  { id: N.THIAMIN, key: 'thiamin', label: 'Thiamin (B1)', short: 'B1', unit: 'mg', group: 'vitamin', precision: 2 },
  { id: N.RIBOFLAVIN, key: 'riboflavin', label: 'Riboflavin (B2)', short: 'B2', unit: 'mg', group: 'vitamin', precision: 2 },
  { id: N.NIACIN, key: 'niacin', label: 'Niacin (B3)', short: 'B3', unit: 'mg', group: 'vitamin', precision: 1 },
  { id: N.PANTOTHENIC, key: 'pantothenicAcid', label: 'Pantothenic acid (B5)', short: 'B5', unit: 'mg', group: 'vitamin', precision: 2 },
  { id: N.VIT_B6, key: 'vitaminB6', label: 'Vitamin B6', short: 'B6', unit: 'mg', group: 'vitamin', precision: 2 },
  { id: N.FOLATE, key: 'folate', label: 'Folate', short: 'Folate', unit: 'µg', group: 'vitamin', precision: 0 },
  { id: N.VIT_B12, key: 'vitaminB12', label: 'Vitamin B12', short: 'B12', unit: 'µg', group: 'vitamin', precision: 2 },
  { id: N.CHOLINE, key: 'choline', label: 'Choline', short: 'Choline', unit: 'mg', group: 'vitamin', precision: 0 },

  { id: N.CAFFEINE, key: 'caffeine', label: 'Caffeine', short: 'Caffeine', unit: 'mg', group: 'other', precision: 0 },

  { id: N.HISTIDINE, key: 'histidine', label: 'Histidine', short: 'His', unit: 'g', group: 'amino', precision: 2 },
  { id: N.ISOLEUCINE, key: 'isoleucine', label: 'Isoleucine', short: 'Ile', unit: 'g', group: 'amino', precision: 2 },
  { id: N.LEUCINE, key: 'leucine', label: 'Leucine', short: 'Leu', unit: 'g', group: 'amino', precision: 2 },
  { id: N.LYSINE, key: 'lysine', label: 'Lysine', short: 'Lys', unit: 'g', group: 'amino', precision: 2 },
  { id: N.METHIONINE, key: 'methionine', label: 'Methionine', short: 'Met', unit: 'g', group: 'amino', precision: 2 },
  { id: N.CYSTINE, key: 'cystine', label: 'Cystine', short: 'Cys', unit: 'g', group: 'amino', precision: 2 },
  { id: N.PHENYLALANINE, key: 'phenylalanine', label: 'Phenylalanine', short: 'Phe', unit: 'g', group: 'amino', precision: 2 },
  { id: N.TYROSINE, key: 'tyrosine', label: 'Tyrosine', short: 'Tyr', unit: 'g', group: 'amino', precision: 2 },
  { id: N.THREONINE, key: 'threonine', label: 'Threonine', short: 'Thr', unit: 'g', group: 'amino', precision: 2 },
  { id: N.TRYPTOPHAN, key: 'tryptophan', label: 'Tryptophan', short: 'Trp', unit: 'g', group: 'amino', precision: 2 },
  { id: N.VALINE, key: 'valine', label: 'Valine', short: 'Val', unit: 'g', group: 'amino', precision: 2 },
] as const;

export const NUTRIENT_BY_ID: ReadonlyMap<number, NutrientDef> = new Map(
  NUTRIENTS.map((n) => [n.id as number, n]),
);

export const NUTRIENT_BY_KEY: ReadonlyMap<string, NutrientDef> = new Map(
  NUTRIENTS.map((n) => [n.key, n]),
);

export const GROUP_LABEL: Record<NutrientGroup, string> = {
  energy: 'Energy',
  macro: 'Macronutrients',
  lipid: 'Lipids',
  mineral: 'Minerals',
  vitamin: 'Vitamins',
  amino: 'Amino acids',
  other: 'Other',
};

/** Nutrients shown on the compact daily summary, in display order. */
export const HEADLINE_NUTRIENTS: readonly NutrientId[] = [
  N.ENERGY,
  N.PROTEIN,
  N.CARBS,
  N.FAT,
] as const;

/** Atwater factors — kcal per gram of each energy-yielding macronutrient. */
export const KCAL_PER_G = {
  protein: 4,
  carbs: 4,
  fat: 9,
  alcohol: 7,
  /** Fiber is partially fermented; the EU label convention is 2 kcal/g. */
  fiber: 2,
} as const;

/** Energy implied by a nutrient vector, used to sanity-check imported data. */
export function derivedEnergy(n: Nutrients): number {
  const protein = n[N.PROTEIN] ?? 0;
  const carbs = n[N.CARBS] ?? 0;
  const fat = n[N.FAT] ?? 0;
  const alcohol = n[N.ALCOHOL] ?? 0;
  return protein * KCAL_PER_G.protein + carbs * KCAL_PER_G.carbs + fat * KCAL_PER_G.fat + alcohol * KCAL_PER_G.alcohol;
}

/** Scale a per-100 g vector to an arbitrary gram weight. */
export function scaleNutrients(per100g: Nutrients, grams: number): Nutrients {
  const factor = grams / 100;
  const out: Nutrients = {};
  if (!per100g) return out;
  for (const key in per100g) {
    const value = per100g[key];
    if (value !== undefined) out[key] = value * factor;
  }
  return out;
}

/** Sum nutrient vectors in place-free fashion. */
export function addNutrients(target: Nutrients, source: Nutrients): Nutrients {
  // Tolerates a missing vector. A diary row restored from an older backup, or
  // written by an interrupted migration, can carry no nutrients at all — and
  // every total in the app is built from this function, so one such row used to
  // throw inside the live query that computes the day's targets. That is above
  // any screen-level boundary, so a single bad record took down the whole app.
  if (!source) return target;
  for (const key in source) {
    const value = source[key];
    if (value === undefined) continue;
    target[key] = (target[key] ?? 0) + value;
  }
  return target;
}

export function sumNutrients(vectors: Iterable<Nutrients>): Nutrients {
  const out: Nutrients = {};
  for (const v of vectors) addNutrients(out, v);
  return out;
}

/**
 * Format a nutrient amount for display. Small non-zero values collapse to
 * "<0.1" rather than a misleading "0.0".
 */
export function formatNutrient(id: number, value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return '—';
  const def = NUTRIENT_BY_ID.get(id);
  const precision = def?.precision ?? 1;
  if (value === 0) return '0';
  const floor = Math.pow(10, -precision);
  if (value > 0 && value < floor) return `<${floor.toFixed(precision)}`;
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: precision,
  });
}
