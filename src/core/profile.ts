import type { DayKey } from './dates';
import type { EnergyUnit, LengthUnit, MassUnit, UnitSystem } from './units';

/**
 * Biological sex is required for BMR equations and for most micronutrient
 * reference intakes, which are published separately for males and females.
 * It is a physiology input, not an identity field — the UI labels it as such
 * and offers a neutral option that averages the two reference sets.
 */
export type ReferenceSex = 'male' | 'female' | 'neutral';

export type ActivityLevel =
  | 'sedentary'
  | 'light'
  | 'moderate'
  | 'active'
  | 'very_active'
  | 'custom';

export type GoalDirection = 'lose' | 'maintain' | 'gain';

/** How aggressively targets react to new data. Mirrors MacroFactor's coaching dial. */
export type AdaptSpeed = 'gentle' | 'balanced' | 'aggressive';

export type DietTemplate =
  | 'balanced'
  | 'high_protein'
  | 'low_carb'
  | 'keto'
  | 'low_fat'
  | 'mediterranean'
  | 'custom';

export interface MacroSplit {
  /** Grams per day. */
  protein: number;
  carbs: number;
  fat: number;
}

export interface EnergyGoal {
  direction: GoalDirection;
  /**
   * Target rate of body-mass change in kg per week. Negative for loss.
   * Zero for maintenance.
   */
  rateKgPerWeek: number;
  /** Optional goal weight in kg; drives the projected-date estimate. */
  targetWeightKg?: number;
}

export interface MacroPreferences {
  template: DietTemplate;
  /** Protein target expressed per kg of body mass (or lean mass if known). */
  proteinGPerKg: number;
  /** Never let fat fall below this per kg — hormonal floor. */
  minFatGPerKg: number;
  /** Fixed carb ceiling in grams, for keto/low-carb templates. */
  maxCarbsG?: number;
  /** When set, overrides all computed values. */
  manual?: MacroSplit;
  /** Base protein on lean body mass instead of total mass when body fat % known. */
  proteinFromLeanMass: boolean;
}

export interface DisplayPreferences {
  theme: 'dark' | 'light' | 'system';
  unitSystem: UnitSystem;
  massUnit: MassUnit;
  lengthUnit: LengthUnit;
  energyUnit: EnergyUnit;
  /** Show net carbs (carbs − fiber) instead of total carbs. */
  netCarbs: boolean;
  /** Nutrient ids pinned to the daily summary beyond the headline four. */
  pinnedNutrients: number[];
  /** First day of week: 0 = Sunday, 1 = Monday. */
  weekStart: 0 | 1;
  hideStreaks: boolean;
}

export interface MealSlot {
  id: string;
  name: string;
  /** Minutes past midnight, used only to sort and to pre-select on add. */
  defaultTime: number;
  /** Optional per-meal calorie share (0–1) for meal-level targets. */
  energyShare?: number;
}

export const DEFAULT_MEALS: MealSlot[] = [
  { id: 'breakfast', name: 'Breakfast', defaultTime: 8 * 60 },
  { id: 'lunch', name: 'Lunch', defaultTime: 13 * 60 },
  { id: 'dinner', name: 'Dinner', defaultTime: 19 * 60 },
  { id: 'snacks', name: 'Snacks', defaultTime: 16 * 60 },
];

export interface UserProfile {
  id: 'me';
  createdAt: number;
  updatedAt: number;

  name?: string;
  birthYear?: number;
  sex: ReferenceSex;
  heightCm: number;
  /** Starting weight; live weight comes from the weight log. */
  startWeightKg: number;
  /** Most recent known body-fat percentage (0–100), if the user tracks it. */
  bodyFatPct?: number;
  /** Pregnancy / lactation shift several micronutrient reference intakes. */
  lifeStage?: 'none' | 'pregnancy' | 'lactation';

  activity: ActivityLevel;
  /** Only used when `activity` is 'custom'. */
  customActivityFactor?: number;

  goal: EnergyGoal;
  macros: MacroPreferences;
  /**
   * Explicit daily energy target, overriding everything derived.
   *
   * Set when the user wants their own number — a coach's figure, a protocol
   * they are following, or simply a preference. It bypasses the deficit caps
   * because it is a deliberate decision rather than a computed one; the safety
   * floor still produces a warning, it just no longer silently rewrites the
   * value the user typed.
   */
  manualEnergyKcal?: number;
  adaptSpeed: AdaptSpeed;
  /**
   * When true the app estimates expenditure from your own intake and weight
   * data instead of trusting a textbook formula. Needs ~14 days of data.
   */
  useAdaptiveTdee: boolean;
  /** Add exercise calories from Health/Health Connect back to the daily target. */
  addExerciseCalories: boolean;

  meals: MealSlot[];
  display: DisplayPreferences;

  /** Custom micronutrient targets keyed by nutrient id; overrides the DRI table. */
  nutrientTargetOverrides?: Record<number, number>;

  /**
   * Daily water goal in millilitres. The reference intake counts water from
   * food as well, which makes it a poor drinking target — most people want to
   * set their own, so this overrides it when present.
   */
  waterTargetMl?: number;

  /** Day the user started, used for streaks and the "since" copy. */
  startedOn: DayKey;
}

export const ACTIVITY_FACTORS: Record<Exclude<ActivityLevel, 'custom'>, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

export const ACTIVITY_LABELS: Record<ActivityLevel, { title: string; detail: string }> = {
  sedentary: { title: 'Sedentary', detail: 'Desk job, little deliberate exercise' },
  light: { title: 'Lightly active', detail: 'Light exercise 1–3 days a week' },
  moderate: { title: 'Moderately active', detail: 'Moderate exercise 3–5 days a week' },
  active: { title: 'Active', detail: 'Hard exercise 6–7 days a week' },
  very_active: { title: 'Very active', detail: 'Physical job or twice-daily training' },
  custom: { title: 'Custom', detail: 'Set your own multiplier' },
};

export const DIET_TEMPLATES: Record<
  Exclude<DietTemplate, 'custom'>,
  { label: string; detail: string; proteinGPerKg: number; minFatGPerKg: number; maxCarbsG?: number }
> = {
  balanced: {
    label: 'Balanced',
    detail: 'Even split, no restrictions',
    proteinGPerKg: 1.6,
    minFatGPerKg: 0.8,
  },
  high_protein: {
    label: 'High protein',
    detail: 'Prioritises muscle retention while cutting',
    proteinGPerKg: 2.2,
    minFatGPerKg: 0.7,
  },
  low_carb: {
    label: 'Low carb',
    detail: 'Carbs capped, fat fills the gap',
    proteinGPerKg: 2.0,
    minFatGPerKg: 1.0,
    maxCarbsG: 100,
  },
  keto: {
    label: 'Keto',
    detail: 'Carbs held near 25 g to sustain ketosis',
    proteinGPerKg: 1.6,
    minFatGPerKg: 1.2,
    maxCarbsG: 25,
  },
  low_fat: {
    label: 'Low fat',
    detail: 'Fat at the healthy minimum, carbs high',
    proteinGPerKg: 1.8,
    minFatGPerKg: 0.5,
  },
  mediterranean: {
    label: 'Mediterranean',
    detail: 'Moderate carbs, generous unsaturated fat',
    proteinGPerKg: 1.5,
    minFatGPerKg: 1.1,
  },
};

export function ageFrom(profile: Pick<UserProfile, 'birthYear'>, now = new Date()): number {
  if (!profile.birthYear) return 30;
  return Math.max(1, now.getFullYear() - profile.birthYear);
}

export function activityFactor(profile: UserProfile): number {
  if (profile.activity === 'custom') return profile.customActivityFactor ?? 1.4;
  return ACTIVITY_FACTORS[profile.activity];
}

export function createDefaultProfile(startedOn: DayKey): UserProfile {
  const now = Date.now();
  return {
    id: 'me',
    createdAt: now,
    updatedAt: now,
    sex: 'neutral',
    heightCm: 175,
    startWeightKg: 75,
    activity: 'light',
    goal: { direction: 'maintain', rateKgPerWeek: 0 },
    macros: {
      template: 'balanced',
      proteinGPerKg: DIET_TEMPLATES.balanced.proteinGPerKg,
      minFatGPerKg: DIET_TEMPLATES.balanced.minFatGPerKg,
      proteinFromLeanMass: false,
    },
    adaptSpeed: 'balanced',
    useAdaptiveTdee: true,
    addExerciseCalories: false,
    meals: DEFAULT_MEALS,
    display: {
      theme: 'system',
      unitSystem: 'metric',
      massUnit: 'kg',
      lengthUnit: 'cm',
      energyUnit: 'kcal',
      netCarbs: false,
      pinnedNutrients: [],
      weekStart: 1,
      hideStreaks: false,
    },
    startedOn,
  };
}
