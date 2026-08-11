import { N } from './nutrients';
import type { ReferenceSex, UserProfile } from './profile';
import { ageFrom } from './profile';

/**
 * Dietary Reference Intakes.
 *
 * Values are the US/Canada Institute of Medicine RDAs (or AIs where no RDA
 * exists) for adults, plus Tolerable Upper Intake Levels where one is defined.
 * This is the same reference set Cronometer uses, and it is what turns a macro
 * tracker into something that can actually tell you your diet is short on
 * potassium.
 *
 * Targets that scale with body mass or energy intake (fiber, amino acids) are
 * computed rather than tabulated.
 */

export interface NutrientTarget {
  /** Recommended amount per day, in the nutrient's display unit. */
  target: number;
  /** Tolerable upper intake level, if one is defined. */
  upperLimit?: number;
  /** True when exceeding the target is the failure mode, not missing it. */
  isLimit?: boolean;
  /** Where the number came from, shown in the nutrient detail sheet. */
  basis: 'RDA' | 'AI' | 'UL' | 'CDRR' | 'computed' | 'custom';
}

interface DriRow {
  male: number;
  female: number;
  ul?: number;
  basis: NutrientTarget['basis'];
  /** Optional age-banded overrides, applied when age >= `from`. */
  bands?: { from: number; male?: number; female?: number }[];
}

const DRI: Record<number, DriRow> = {
  // --- Vitamins ---------------------------------------------------------
  [N.VIT_A]: { male: 900, female: 700, ul: 3000, basis: 'RDA' },
  [N.VIT_C]: { male: 90, female: 75, ul: 2000, basis: 'RDA' },
  [N.VIT_D]: { male: 15, female: 15, ul: 100, basis: 'RDA', bands: [{ from: 71, male: 20, female: 20 }] },
  [N.VIT_E]: { male: 15, female: 15, ul: 1000, basis: 'RDA' },
  [N.VIT_K]: { male: 120, female: 90, basis: 'AI' },
  [N.THIAMIN]: { male: 1.2, female: 1.1, basis: 'RDA' },
  [N.RIBOFLAVIN]: { male: 1.3, female: 1.1, basis: 'RDA' },
  [N.NIACIN]: { male: 16, female: 14, ul: 35, basis: 'RDA' },
  [N.PANTOTHENIC]: { male: 5, female: 5, basis: 'AI' },
  [N.VIT_B6]: { male: 1.3, female: 1.3, ul: 100, basis: 'RDA', bands: [{ from: 51, male: 1.7, female: 1.5 }] },
  [N.FOLATE]: { male: 400, female: 400, ul: 1000, basis: 'RDA' },
  [N.VIT_B12]: { male: 2.4, female: 2.4, basis: 'RDA' },
  [N.CHOLINE]: { male: 550, female: 425, ul: 3500, basis: 'AI' },

  // --- Minerals ---------------------------------------------------------
  [N.CALCIUM]: {
    male: 1000,
    female: 1000,
    ul: 2500,
    basis: 'RDA',
    bands: [
      { from: 51, female: 1200 },
      { from: 71, male: 1200, female: 1200 },
    ],
  },
  [N.IRON]: { male: 8, female: 18, ul: 45, basis: 'RDA', bands: [{ from: 51, female: 8 }] },
  [N.MAGNESIUM]: { male: 400, female: 310, basis: 'RDA', bands: [{ from: 31, male: 420, female: 320 }] },
  [N.PHOSPHORUS]: { male: 700, female: 700, ul: 4000, basis: 'RDA' },
  [N.POTASSIUM]: { male: 3400, female: 2600, basis: 'AI' },
  [N.ZINC]: { male: 11, female: 8, ul: 40, basis: 'RDA' },
  [N.COPPER]: { male: 0.9, female: 0.9, ul: 10, basis: 'RDA' },
  [N.MANGANESE]: { male: 2.3, female: 1.8, ul: 11, basis: 'AI' },
  [N.SELENIUM]: { male: 55, female: 55, ul: 400, basis: 'RDA' },

  // --- Limits -----------------------------------------------------------
  // Sodium has an AI of 1500 mg and a Chronic Disease Risk Reduction intake of
  // 2300 mg; the CDRR is the number worth showing as a ceiling.
  [N.SODIUM]: { male: 2300, female: 2300, basis: 'CDRR' },
  [N.CHOLESTEROL]: { male: 300, female: 300, basis: 'custom' },

  // --- Fats -------------------------------------------------------------
  [N.OMEGA3_ALA]: { male: 1.6, female: 1.1, basis: 'AI' },
};

/** Nutrients where staying under the number is the goal. */
const LIMIT_NUTRIENTS = new Set<number>([
  N.SODIUM,
  N.CHOLESTEROL,
  N.SAT_FAT,
  N.TRANS_FAT,
  N.ADDED_SUGAR,
]);

/**
 * Essential amino acid requirements, mg per kg of body mass per day
 * (WHO/FAO/UNU 2007). Methionine and phenylalanine figures are for the
 * sulphur-containing and aromatic amino acid groups respectively.
 */
const AMINO_MG_PER_KG: Record<number, number> = {
  [N.HISTIDINE]: 10,
  [N.ISOLEUCINE]: 20,
  [N.LEUCINE]: 39,
  [N.LYSINE]: 30,
  [N.METHIONINE]: 15,
  [N.PHENYLALANINE]: 25,
  [N.THREONINE]: 15,
  [N.TRYPTOPHAN]: 4,
  [N.VALINE]: 26,
};

function pick(row: DriRow, sex: ReferenceSex, age: number): number {
  let male = row.male;
  let female = row.female;
  for (const band of row.bands ?? []) {
    if (age >= band.from) {
      if (band.male !== undefined) male = band.male;
      if (band.female !== undefined) female = band.female;
    }
  }
  if (sex === 'male') return male;
  if (sex === 'female') return female;
  return (male + female) / 2;
}

export interface TargetContext {
  profile: UserProfile;
  /** Current body mass in kg, used for amino acids and protein. */
  weightKg: number;
  /** Daily energy target in kcal, used for fiber and saturated fat. */
  energyTargetKcal: number;
  now?: Date;
}

/**
 * Full per-day nutrient target set for a user. Keys are nutrient ids; anything
 * absent from the map simply has no reference value and is displayed as an
 * amount with no progress bar.
 */
export function dailyNutrientTargets(ctx: TargetContext): Map<number, NutrientTarget> {
  const { profile, weightKg, energyTargetKcal } = ctx;
  const age = ageFrom(profile, ctx.now ?? new Date());
  const out = new Map<number, NutrientTarget>();

  for (const [idText, row] of Object.entries(DRI)) {
    const id = Number(idText);
    out.set(id, {
      target: pick(row, profile.sex, age),
      upperLimit: row.ul,
      isLimit: LIMIT_NUTRIENTS.has(id),
      basis: row.basis,
    });
  }

  // Fiber: 14 g per 1000 kcal (IOM AI), which correctly scales with intake
  // instead of pinning everyone to the same number.
  out.set(N.FIBER, {
    target: Math.round((energyTargetKcal / 1000) * 14),
    basis: 'AI',
  });

  // Saturated fat: under 10% of energy (WHO/DGA).
  out.set(N.SAT_FAT, {
    target: Math.round(((energyTargetKcal * 0.1) / 9) * 10) / 10,
    isLimit: true,
    basis: 'computed',
  });

  // Added sugar: under 10% of energy.
  out.set(N.ADDED_SUGAR, {
    target: Math.round((energyTargetKcal * 0.1) / 4),
    isLimit: true,
    basis: 'computed',
  });

  // Trans fat: no safe level; the target is simply "as low as possible".
  out.set(N.TRANS_FAT, { target: 0, isLimit: true, basis: 'computed' });

  // Water AI (IOM total water, including food moisture): 3.7 L male, 2.7 L female.
  out.set(N.WATER, {
    target: profile.sex === 'male' ? 3700 : profile.sex === 'female' ? 2700 : 3200,
    basis: 'AI',
  });

  for (const [idText, mgPerKg] of Object.entries(AMINO_MG_PER_KG)) {
    out.set(Number(idText), {
      // Stored in grams to match the nutrient definition's unit.
      target: Math.round((mgPerKg * weightKg) / 100) / 10,
      basis: 'computed',
    });
  }

  // Pregnancy and lactation shift a handful of intakes substantially.
  if (profile.lifeStage === 'pregnancy') {
    applyMultipliers(out, { [N.FOLATE]: 600 / 400, [N.IRON]: 27 / 18, [N.VIT_B12]: 2.6 / 2.4 });
  } else if (profile.lifeStage === 'lactation') {
    applyMultipliers(out, { [N.VIT_A]: 1300 / 700, [N.VIT_C]: 120 / 75, [N.IRON]: 9 / 18 });
  }

  for (const [idText, value] of Object.entries(profile.nutrientTargetOverrides ?? {})) {
    const id = Number(idText);
    const existing = out.get(id);
    out.set(id, {
      target: value,
      upperLimit: existing?.upperLimit,
      isLimit: existing?.isLimit ?? LIMIT_NUTRIENTS.has(id),
      basis: 'custom',
    });
  }

  return out;
}

function applyMultipliers(map: Map<number, NutrientTarget>, factors: Record<number, number>) {
  for (const [idText, factor] of Object.entries(factors)) {
    const id = Number(idText);
    const existing = map.get(id);
    if (existing) map.set(id, { ...existing, target: existing.target * factor });
  }
}

/**
 * Status of a nutrient against its target, used to colour the micronutrient
 * grid. Deliberately forgiving in the middle: nutrient intake is meant to be
 * averaged over days, not hit exactly every 24 hours.
 */
export type NutrientStatus = 'low' | 'ok' | 'high' | 'over-limit' | 'unknown';

export function nutrientStatus(
  amount: number | undefined,
  target: NutrientTarget | undefined,
): NutrientStatus {
  if (target === undefined) return 'unknown';
  if (amount === undefined) return 'low';
  if (target.isLimit) {
    return amount > target.target ? 'over-limit' : 'ok';
  }
  if (target.upperLimit !== undefined && amount > target.upperLimit) return 'over-limit';
  if (amount < target.target * 0.7) return 'low';
  if (amount > target.target * 2.5) return 'high';
  return 'ok';
}
