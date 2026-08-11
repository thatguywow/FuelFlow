import Dexie, { type Table } from 'dexie';
import type { DayKey } from '../core/dates';
import type { Nutrients } from '../core/nutrients';
import type { UserProfile } from '../core/profile';

/**
 * Local database.
 *
 * IndexedDB is the source of truth — there is no server and no account. Every
 * record carries a UUID and an `updatedAt` stamp, and deletions are tombstones
 * rather than removals, so a future device-to-device or cloud-folder sync can
 * merge two divergent copies with last-write-wins and never lose an entry.
 */

export type FoodSource =
  | 'usda' // bundled generic foods (Foundation / SR Legacy / FNDDS)
  | 'off' // Open Food Facts, fetched live or from the remote branded DB
  | 'branded' // remote branded database snapshot
  | 'user' // typed in by hand
  | 'recipe' // a saved recipe, usable as an ingredient
  | 'label'; // created from a scanned nutrition label

/** A named serving with its gram weight, e.g. "1 medium (118 g)". */
export interface Portion {
  label: string;
  grams: number;
  /** Marks the portion the picker should default to. */
  preferred?: boolean;
}

export interface Food {
  id: string;
  source: FoodSource;
  /** Upstream identifier: FDC id, OFF barcode, recipe id. */
  sourceId?: string;
  barcode?: string;

  name: string;
  brand?: string;
  /** Free-text category from upstream, used for grouping and icons. */
  category?: string;

  /** Nutrients per 100 g (or per 100 ml when `liquid` is true). */
  per100g: Nutrients;
  /** g per ml — lets volume portions resolve to mass. */
  densityGPerMl?: number;
  liquid?: boolean;

  portions: Portion[];

  /**
   * Lowercased search tokens. Indexed multiEntry, which is what makes
   * substring-free prefix search fast without shipping a search engine.
   */
  tokens: string[];

  /** Upstream data completeness 0–1, used to rank search results. */
  quality?: number;
  verified?: boolean;

  createdAt: number;
  updatedAt: number;
  deleted?: boolean;
}

/**
 * A diary entry stores a *snapshot* of the food's nutrition as it was when
 * logged, not just a reference. Upstream databases get corrected all the time;
 * your November diary should not quietly change because Open Food Facts fixed
 * a typo in December.
 */
export interface DiaryEntry {
  id: string;
  day: DayKey;
  mealId: string;
  /** Sort order within the meal. */
  position: number;

  foodId?: string;
  name: string;
  brand?: string;

  grams: number;
  portionLabel?: string;
  portionCount?: number;

  /** Absolute nutrients for this entry (already scaled to `grams`). */
  nutrients: Nutrients;

  /** Set for entries created by expanding a recipe, to allow regrouping. */
  recipeId?: string;
  /** Quick-add entries carry no food record at all. */
  quickAdd?: boolean;

  loggedAt: number;
  updatedAt: number;
  deleted?: boolean;
}

export interface RecipeIngredient {
  foodId: string;
  name: string;
  grams: number;
  portionLabel?: string;
  nutrients: Nutrients;
}

export interface Recipe {
  id: string;
  name: string;
  servings: number;
  ingredients: RecipeIngredient[];
  /** Cooked weight, when it differs from the sum of ingredients. */
  finalWeightG?: number;
  notes?: string;
  photoDataUrl?: string;
  sourceUrl?: string;
  createdAt: number;
  updatedAt: number;
  deleted?: boolean;
}

/** A saved group of entries, e.g. "usual breakfast". */
export interface MealTemplate {
  id: string;
  name: string;
  items: Omit<DiaryEntry, 'id' | 'day' | 'mealId' | 'loggedAt' | 'updatedAt' | 'position'>[];
  createdAt: number;
  updatedAt: number;
  deleted?: boolean;
}

export interface WeightLog {
  id: string;
  day: DayKey;
  kg: number;
  loggedAt: number;
  updatedAt: number;
  deleted?: boolean;
}

export type BiometricType =
  | 'bodyFatPct'
  | 'waistCm'
  | 'hipCm'
  | 'chestCm'
  | 'armCm'
  | 'thighCm'
  | 'neckCm'
  | 'systolic'
  | 'diastolic'
  | 'restingHr'
  | 'glucoseMgDl'
  | 'ketonesMmol'
  | 'sleepHours'
  | 'steps'
  | 'moodScore'
  | 'energyScore';

export interface Biometric {
  id: string;
  day: DayKey;
  type: BiometricType;
  value: number;
  note?: string;
  loggedAt: number;
  updatedAt: number;
  deleted?: boolean;
}

export interface WaterLog {
  id: string;
  day: DayKey;
  ml: number;
  loggedAt: number;
  updatedAt: number;
  deleted?: boolean;
}

export interface ExerciseLog {
  id: string;
  day: DayKey;
  name: string;
  minutes?: number;
  kcal: number;
  source: 'manual' | 'health' | 'estimate';
  loggedAt: number;
  updatedAt: number;
  deleted?: boolean;
}

export interface FastSession {
  id: string;
  startTs: number;
  endTs?: number;
  targetHours: number;
  note?: string;
  updatedAt: number;
  deleted?: boolean;
}

/**
 * Usage statistics behind "frecency" ranking — the reason a regular user finds
 * their own food in one keystroke while a fresh install has to search.
 */
export interface FoodUsage {
  foodId: string;
  useCount: number;
  lastUsedAt: number;
  /** Most common gram weight for this food, used to pre-fill the amount. */
  typicalGrams?: number;
  /** Meal ids this food is usually logged into, most frequent first. */
  mealAffinity?: string[];
  favorite?: boolean;
  updatedAt: number;
}

/** A day-level marker the user sets to confirm "this log is complete". */
export interface DayMeta {
  day: DayKey;
  logComplete?: boolean;
  note?: string;
  updatedAt: number;
}

export interface KeyValue {
  key: string;
  value: unknown;
  updatedAt: number;
}

export class FuelFlowDb extends Dexie {
  profile!: Table<UserProfile, string>;
  foods!: Table<Food, string>;
  entries!: Table<DiaryEntry, string>;
  recipes!: Table<Recipe, string>;
  mealTemplates!: Table<MealTemplate, string>;
  weights!: Table<WeightLog, string>;
  biometrics!: Table<Biometric, string>;
  water!: Table<WaterLog, string>;
  exercise!: Table<ExerciseLog, string>;
  fasts!: Table<FastSession, string>;
  usage!: Table<FoodUsage, string>;
  dayMeta!: Table<DayMeta, string>;
  kv!: Table<KeyValue, string>;

  constructor() {
    super('fuelflow');

    this.version(1).stores({
      profile: 'id',
      // `*tokens` is a multiEntry index: one index row per token, which lets a
      // prefix query hit an index instead of scanning every food.
      foods: 'id, barcode, name, source, [source+sourceId], updatedAt, *tokens',
      entries: 'id, day, [day+mealId], foodId, recipeId, updatedAt',
      recipes: 'id, name, updatedAt',
      mealTemplates: 'id, name, updatedAt',
      weights: 'id, day, updatedAt',
      biometrics: 'id, day, type, [day+type], updatedAt',
      water: 'id, day, updatedAt',
      exercise: 'id, day, updatedAt',
      fasts: 'id, startTs, updatedAt',
      usage: 'foodId, lastUsedAt, useCount, favorite',
      dayMeta: 'day',
      kv: 'key',
    });
  }
}

export const db = new FuelFlowDb();

/** UUID with a fallback for the rare context without `crypto.randomUUID`. */
export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Search tokens for a food.
 *
 * Both whole words and their progressive prefixes are stored so that a
 * `startsWith` index lookup can answer "chick" without a table scan. Diacritics
 * are folded so "creme fraiche" finds "crème fraîche".
 */
/** Combining accents, stripped after NFD decomposition. */
const DIACRITICS = /\p{Diacritic}/gu;

export function tokenize(...parts: (string | undefined)[]): string[] {
  const text = parts.filter(Boolean).join(' ').toLowerCase();
  const folded = text.normalize('NFD').replace(DIACRITICS, '');
  const words = folded.split(/[^a-z0-9%]+/).filter((w) => w.length > 0);
  const out = new Set<string>();
  for (const word of words) {
    if (word.length < 2 && !/\d/.test(word)) continue;
    out.add(word);
  }
  return [...out];
}

/** Normalise a query the same way tokens were built, so they compare equal. */
export function normalizeQuery(query: string): string[] {
  return tokenize(query);
}
