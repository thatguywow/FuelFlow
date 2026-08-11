import { ageFrom, activityFactor, type ReferenceSex, type UserProfile } from './profile';

/**
 * Resting and total energy expenditure formulas.
 *
 * These are the *prior* — the starting guess the app uses on day one and the
 * fallback when there is not enough logged data. Once ~14 days of intake and
 * weight exist, `adaptive.ts` replaces them with an estimate derived from the
 * user's own energy balance, which is far more accurate than any population
 * equation. Every formula here is population-average and can be wrong by
 * ±20% for an individual; the UI should never present them as fact.
 */

export type BmrFormula = 'mifflin' | 'katch' | 'harris' | 'cunningham';

export interface BmrInput {
  weightKg: number;
  heightCm: number;
  ageYears: number;
  sex: ReferenceSex;
  /** Body-fat percentage 0–100. Required by lean-mass formulas. */
  bodyFatPct?: number;
}

/** Sex constant, averaged for 'neutral' so the neutral option stays usable. */
function sexOffset(sex: ReferenceSex, male: number, female: number): number {
  if (sex === 'male') return male;
  if (sex === 'female') return female;
  return (male + female) / 2;
}

export function leanBodyMassKg(weightKg: number, bodyFatPct: number): number {
  return weightKg * (1 - bodyFatPct / 100);
}

/** Mifflin-St Jeor (1990) — the best-validated general population equation. */
export function mifflinStJeor(input: BmrInput): number {
  const { weightKg, heightCm, ageYears, sex } = input;
  return 10 * weightKg + 6.25 * heightCm - 5 * ageYears + sexOffset(sex, 5, -161);
}

/** Revised Harris-Benedict (Roza & Shizgal, 1984). */
export function harrisBenedict(input: BmrInput): number {
  const { weightKg, heightCm, ageYears, sex } = input;
  const male = 88.362 + 13.397 * weightKg + 4.799 * heightCm - 5.677 * ageYears;
  const female = 447.593 + 9.247 * weightKg + 3.098 * heightCm - 4.33 * ageYears;
  return sexOffset(sex, male, female);
}

/** Katch-McArdle — lean-mass based, more accurate for lean/muscular people. */
export function katchMcArdle(input: BmrInput): number {
  const lbm = leanBodyMassKg(input.weightKg, input.bodyFatPct ?? 25);
  return 370 + 21.6 * lbm;
}

/** Cunningham — like Katch-McArdle but tuned for trained athletes. */
export function cunningham(input: BmrInput): number {
  const lbm = leanBodyMassKg(input.weightKg, input.bodyFatPct ?? 20);
  return 500 + 22 * lbm;
}

export function basalMetabolicRate(input: BmrInput, formula: BmrFormula = 'mifflin'): number {
  switch (formula) {
    case 'mifflin':
      return mifflinStJeor(input);
    case 'harris':
      return harrisBenedict(input);
    case 'katch':
      return katchMcArdle(input);
    case 'cunningham':
      return cunningham(input);
  }
}

/**
 * Pick the best formula for the data available: lean-mass equations win when a
 * body-fat percentage is known, otherwise Mifflin-St Jeor.
 */
export function bestBmrFormula(bodyFatPct?: number): BmrFormula {
  return bodyFatPct !== undefined && bodyFatPct > 0 ? 'katch' : 'mifflin';
}

export interface ExpenditureEstimate {
  bmr: number;
  tdee: number;
  formula: BmrFormula;
  activityFactor: number;
}

/** Textbook TDEE: BMR × activity multiplier. */
export function estimateExpenditure(
  profile: UserProfile,
  currentWeightKg: number,
  now = new Date(),
): ExpenditureEstimate {
  const formula = bestBmrFormula(profile.bodyFatPct);
  const bmr = basalMetabolicRate(
    {
      weightKg: currentWeightKg,
      heightCm: profile.heightCm,
      ageYears: ageFrom(profile, now),
      sex: profile.sex,
      bodyFatPct: profile.bodyFatPct,
    },
    formula,
  );
  const factor = activityFactor(profile);
  return { bmr, tdee: bmr * factor, formula, activityFactor: factor };
}

/**
 * Safety floor for a daily energy target.
 *
 * Eating below resting metabolic rate for extended periods is where tracking
 * apps do real harm. FuelFlow refuses to *generate* a target below this line
 * and warns when a manual one crosses it. The absolute floors are the widely
 * cited clinical minimums for unsupervised dieting.
 */
export function minimumSafeIntake(bmr: number, sex: ReferenceSex): number {
  const absoluteFloor = sexOffset(sex, 1500, 1200);
  return Math.max(absoluteFloor, Math.round(bmr));
}
