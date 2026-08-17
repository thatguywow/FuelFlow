import { db, newId, tokenize } from './schema';
import type {
  Biometric,
  BiometricType,
  DiaryEntry,
  ExerciseLog,
  FastSession,
  Food,
  FoodSource,
  FoodUsage,
  MealTemplate,
  Recipe,
  WaterLog,
  WeightLog,
} from './schema';
import { applyEntryChange, applyEntryChanges } from './dayStats';
import { N, scaleNutrients, sumNutrients, type Nutrients } from '../core/nutrients';
import { addDays, daysBetween, toDayKey, type DayKey } from '../core/dates';
import type { DailyObservation } from '../core/adaptive';
import { createDefaultProfile, type UserProfile } from '../core/profile';

/**
 * Repository layer.
 *
 * Everything the UI needs, expressed as intent ("log this food into lunch")
 * rather than as table writes. Keeps Dexie out of the components and gives one
 * place to enforce invariants like tombstoning instead of deleting.
 */

const now = () => Date.now();

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/**
 * Read the profile without ever writing.
 *
 * This distinction matters: Dexie's `liveQuery` runs its callback inside a
 * read-only transaction and throws if anything writes. Hooks must use this;
 * only event handlers and startup may use `ensureProfile`.
 */
export async function readProfile(): Promise<UserProfile | undefined> {
  return db.profile.get('me');
}

/** Read the profile, creating the default row if this is a fresh install. */
export async function ensureProfile(): Promise<UserProfile> {
  const existing = await db.profile.get('me');
  if (existing) return existing;
  const fresh = createDefaultProfile(toDayKey());
  await db.profile.put(fresh);
  return fresh;
}

export async function saveProfile(patch: Partial<UserProfile>): Promise<UserProfile> {
  const current = await ensureProfile();
  const next: UserProfile = { ...current, ...patch, id: 'me', updatedAt: now() };
  await db.profile.put(next);
  return next;
}

// ---------------------------------------------------------------------------
// Foods
// ---------------------------------------------------------------------------

export type FoodDraft = Omit<Food, 'id' | 'tokens' | 'createdAt' | 'updatedAt'> &
  Partial<Pick<Food, 'id' | 'createdAt'>>;

/**
 * Sources that are a cache of somebody else's database rather than the user's
 * own data. Only these are eligible to be skipped and pruned.
 */
const CACHE_SOURCES = new Set<FoodSource>(['off', 'branded']);

/**
 * Insert or refresh a food. Foods arriving from the same upstream source and id
 * collapse onto one record, so scanning the same barcode twice never produces a
 * duplicate.
 *
 * When a cached food comes back from upstream unchanged — the common case, since
 * every search result is written back — nothing is written to `foods` at all.
 * Rewriting it meant re-tokenising the name and rebuilding its rows in the
 * multiEntry token index, dozens of times per search, to store bytes identical
 * to the ones already there. All that actually changed was when we last saw it,
 * and that now lives in its own tiny row.
 */
export async function upsertFood(draft: FoodDraft): Promise<Food> {
  const ts = now();
  let id = draft.id;

  if (!id && draft.sourceId) {
    const match = await db.foods.where('[source+sourceId]').equals([draft.source, draft.sourceId]).first();
    id = match?.id;
  }
  if (!id && draft.barcode) {
    const match = await db.foods.where('barcode').equals(draft.barcode).first();
    id = match?.id;
  }

  if (id && CACHE_SOURCES.has(draft.source)) {
    const existing = await db.foods.get(id);
    if (existing && sameContent(existing, draft)) {
      await db.foodMeta.put({ foodId: id, seenAt: ts });
      return existing;
    }
    // A thin search result must never replace a record fetched in full. Both
    // describe the same product, but only one of them knows its serving size.
    if (existing?.detailed && !draft.detailed) {
      await db.foodMeta.put({ foodId: id, seenAt: ts });
      return existing;
    }
  }

  const food: Food = {
    ...draft,
    id: id ?? newId(),
    tokens: tokenize(draft.name, draft.brand, draft.category),
    createdAt: draft.createdAt ?? ts,
    updatedAt: ts,
  };
  await db.foods.put(food);
  if (CACHE_SOURCES.has(food.source)) await db.foodMeta.put({ foodId: food.id, seenAt: ts });
  return food;
}

/**
 * Whether an incoming copy says anything new about a food.
 *
 * Compares only the fields a lookup can actually change. `updatedAt` is
 * excluded on purpose — it is the very thing that used to force the write.
 */
function sameContent(existing: Food, draft: FoodDraft): boolean {
  return (
    existing.name === draft.name &&
    existing.brand === draft.brand &&
    existing.category === draft.category &&
    existing.barcode === draft.barcode &&
    existing.quality === draft.quality &&
    existing.verified === draft.verified &&
    existing.liquid === draft.liquid &&
    existing.densityGPerMl === draft.densityGPerMl &&
    !existing.deleted === !draft.deleted &&
    sameVector(existing.per100g, draft.per100g) &&
    samePortions(existing.portions, draft.portions)
  );
}

function sameVector(a: Nutrients, b: Nutrients): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[Number(key)] !== b[Number(key)]) return false;
  return true;
}

function samePortions(a: Food['portions'], b: Food['portions']): boolean {
  if (a.length !== b.length) return false;
  return a.every((portion, index) => {
    const other = b[index]!;
    return portion.label === other.label && portion.grams === other.grams && !portion.preferred === !other.preferred;
  });
}

export function getFood(id: string): Promise<Food | undefined> {
  return db.foods.get(id);
}

export async function getFoodByBarcode(barcode: string): Promise<Food | undefined> {
  const hit = await db.foods.where('barcode').equals(barcode).first();
  return hit?.deleted ? undefined : hit;
}

export async function deleteFood(id: string): Promise<void> {
  const food = await db.foods.get(id);
  if (!food) return;
  await db.foods.put({ ...food, deleted: true, updatedAt: now() });
}

// ---------------------------------------------------------------------------
// Usage / frecency
// ---------------------------------------------------------------------------

/**
 * Frecency score: recent use and frequent use both matter, and recency decays
 * with a two-week half-life. This is why the food you eat every morning sits at
 * the top of an empty search box.
 */
export function frecencyScore(usage: Pick<FoodUsage, 'useCount' | 'lastUsedAt'>, at = Date.now()): number {
  const ageDays = Math.max(0, (at - usage.lastUsedAt) / 86_400_000);
  const recency = Math.pow(0.5, ageDays / 14);
  return Math.log1p(usage.useCount) * (0.35 + 0.65 * recency);
}

export async function recordUsage(foodId: string, grams: number, mealId: string): Promise<void> {
  const ts = now();
  const existing = await db.usage.get(foodId);
  const affinity = existing?.mealAffinity ? [...existing.mealAffinity] : [];
  const index = affinity.indexOf(mealId);
  if (index > 0) affinity.splice(index, 1);
  if (index !== 0) affinity.unshift(mealId);

  await db.usage.put({
    foodId,
    useCount: (existing?.useCount ?? 0) + 1,
    lastUsedAt: ts,
    // Track the latest portion rather than an average: people change portion
    // sizes deliberately, and an average of 80 g and 200 g helps nobody.
    typicalGrams: grams,
    mealAffinity: affinity.slice(0, 3),
    favorite: existing?.favorite,
    updatedAt: ts,
  });
}

export async function toggleFavorite(foodId: string): Promise<boolean> {
  const ts = now();
  const existing = await db.usage.get(foodId);
  const favorite = !existing?.favorite;
  await db.usage.put({
    foodId,
    useCount: existing?.useCount ?? 0,
    lastUsedAt: existing?.lastUsedAt ?? ts,
    typicalGrams: existing?.typicalGrams,
    mealAffinity: existing?.mealAffinity,
    favorite,
    updatedAt: ts,
  });
  return favorite;
}

// ---------------------------------------------------------------------------
// Diary
// ---------------------------------------------------------------------------

export interface LogFoodInput {
  food: Food;
  day: DayKey;
  mealId: string;
  grams: number;
  portionLabel?: string;
  portionCount?: number;
  loggedAt?: number;
}

export async function logFood(input: LogFoodInput): Promise<DiaryEntry> {
  const ts = input.loggedAt ?? now();
  const position = await nextPosition(input.day, input.mealId);

  const entry: DiaryEntry = {
    id: newId(),
    day: input.day,
    mealId: input.mealId,
    position,
    foodId: input.food.id,
    name: input.food.name,
    brand: input.food.brand,
    grams: input.grams,
    portionLabel: input.portionLabel,
    portionCount: input.portionCount,
    nutrients: scaleNutrients(input.food.per100g, input.grams),
    loggedAt: ts,
    updatedAt: ts,
  };

  // The aggregate moves inside the same transaction as the entry. Outside it,
  // a failure between the two would leave the day's totals describing a diary
  // that was never written.
  await db.transaction('rw', db.entries, db.usage, db.dayStats, async () => {
    await db.entries.add(entry);
    await recordUsage(input.food.id, input.grams, input.mealId);
    await applyEntryChange(undefined, entry);
  });
  return entry;
}

/** A calories-only (or macros-only) entry with no food behind it. */
export async function quickAdd(
  day: DayKey,
  mealId: string,
  nutrients: Nutrients,
  name = 'Quick add',
): Promise<DiaryEntry> {
  const ts = now();
  const entry: DiaryEntry = {
    id: newId(),
    day,
    mealId,
    position: await nextPosition(day, mealId),
    name,
    grams: 0,
    nutrients,
    quickAdd: true,
    loggedAt: ts,
    updatedAt: ts,
  };
  await db.transaction('rw', db.entries, db.dayStats, async () => {
    await db.entries.add(entry);
    await applyEntryChange(undefined, entry);
  });
  return entry;
}

async function nextPosition(day: DayKey, mealId: string): Promise<number> {
  const existing = await db.entries.where('[day+mealId]').equals([day, mealId]).toArray();
  const live = existing.filter((e) => !e.deleted);
  return live.length === 0 ? 0 : Math.max(...live.map((e) => e.position)) + 1;
}

/** Change the amount of an existing entry, rescaling its nutrients. */
export async function updateEntryAmount(entryId: string, grams: number, portionLabel?: string): Promise<void> {
  const entry = await db.entries.get(entryId);
  if (!entry) return;

  let nutrients: Nutrients;
  if (entry.grams > 0) {
    nutrients = scaleNutrients(entry.nutrients, (grams / entry.grams) * 100);
  } else if (entry.foodId) {
    const food = await db.foods.get(entry.foodId);
    nutrients = food ? scaleNutrients(food.per100g, grams) : entry.nutrients;
  } else {
    nutrients = entry.nutrients;
  }

  const next: DiaryEntry = {
    ...entry,
    grams,
    portionLabel: portionLabel ?? entry.portionLabel,
    nutrients,
    updatedAt: now(),
  };
  await writeEntry(entry, next);
}

export async function moveEntry(entryId: string, day: DayKey, mealId: string): Promise<void> {
  const entry = await db.entries.get(entryId);
  if (!entry) return;
  const next: DiaryEntry = {
    ...entry,
    day,
    mealId,
    position: await nextPosition(day, mealId),
    updatedAt: now(),
  };
  // A move can cross days, which is why the aggregate takes both sides rather
  // than a signed amount: the old day gives the food back and the new one takes
  // it, in one step.
  await writeEntry(entry, next);
}

export async function deleteEntry(entryId: string): Promise<DiaryEntry | undefined> {
  const entry = await db.entries.get(entryId);
  if (!entry) return undefined;
  await writeEntry(entry, { ...entry, deleted: true, updatedAt: now() });
  return entry;
}

/** Undo support for the delete toast. */
export async function restoreEntry(entryId: string): Promise<void> {
  const entry = await db.entries.get(entryId);
  if (!entry) return;
  await writeEntry(entry, { ...entry, deleted: false, updatedAt: now() });
}

/** The one place an existing entry is rewritten, so no change escapes the totals. */
async function writeEntry(before: DiaryEntry, after: DiaryEntry): Promise<void> {
  await db.transaction('rw', db.entries, db.dayStats, async () => {
    await db.entries.put(after);
    await applyEntryChange(before, after);
  });
}

export async function entriesForDay(day: DayKey): Promise<DiaryEntry[]> {
  const rows = await db.entries.where('day').equals(day).toArray();
  return rows.filter((e) => !e.deleted).sort((a, b) => a.position - b.position);
}

export async function entriesForRange(from: DayKey, to: DayKey): Promise<DiaryEntry[]> {
  const rows = await db.entries.where('day').between(from, to, true, true).toArray();
  return rows.filter((e) => !e.deleted);
}

export async function dayTotals(day: DayKey): Promise<Nutrients> {
  const entries = await entriesForDay(day);
  return sumNutrients(entries.map((e) => e.nutrients));
}

/** Copy every entry of one meal (or a whole day) onto another day. */
export async function copyMeal(
  from: { day: DayKey; mealId?: string },
  to: { day: DayKey; mealId?: string },
): Promise<number> {
  const source = (await entriesForDay(from.day)).filter(
    (e) => from.mealId === undefined || e.mealId === from.mealId,
  );
  if (source.length === 0) return 0;

  const ts = now();
  const copies: DiaryEntry[] = [];
  const positions = new Map<string, number>();

  for (const entry of source) {
    const mealId = to.mealId ?? entry.mealId;
    const base = positions.get(mealId) ?? (await nextPosition(to.day, mealId));
    positions.set(mealId, base + 1);
    copies.push({
      ...entry,
      id: newId(),
      day: to.day,
      mealId,
      position: base,
      loggedAt: ts,
      updatedAt: ts,
      deleted: false,
    });
  }
  await db.transaction('rw', db.entries, db.dayStats, async () => {
    await db.entries.bulkAdd(copies);
    await applyEntryChanges(copies.map((after) => ({ after })));
  });
  return copies.length;
}

// ---------------------------------------------------------------------------
// Meal templates
// ---------------------------------------------------------------------------

export async function saveMealTemplate(name: string, day: DayKey, mealId: string): Promise<MealTemplate> {
  const entries = (await entriesForDay(day)).filter((e) => e.mealId === mealId);
  const ts = now();
  const template: MealTemplate = {
    id: newId(),
    name,
    items: entries.map(({ id: _id, day: _day, mealId: _meal, loggedAt: _at, updatedAt: _up, position: _p, ...rest }) => rest),
    createdAt: ts,
    updatedAt: ts,
  };
  await db.mealTemplates.add(template);
  return template;
}

export async function applyMealTemplate(templateId: string, day: DayKey, mealId: string): Promise<number> {
  const template = await db.mealTemplates.get(templateId);
  if (!template) return 0;
  const ts = now();
  const base = await nextPosition(day, mealId);
  const entries: DiaryEntry[] = template.items.map((item, index) => ({
    ...item,
    id: newId(),
    day,
    mealId,
    position: base + index,
    loggedAt: ts,
    updatedAt: ts,
  }));
  await db.transaction('rw', db.entries, db.dayStats, async () => {
    await db.entries.bulkAdd(entries);
    await applyEntryChanges(entries.map((after) => ({ after })));
  });
  return entries.length;
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

/** Total weight and nutrition of a recipe, and the per-serving breakdown. */
export function recipeNutrition(recipe: Recipe): {
  totalGrams: number;
  total: Nutrients;
  perServing: Nutrients;
  per100g: Nutrients;
} {
  const total = sumNutrients(recipe.ingredients.map((i) => i.nutrients));
  const rawGrams = recipe.ingredients.reduce((sum, i) => sum + i.grams, 0);
  // Cooking drives off water. When a cooked weight is recorded, nutrient
  // density per 100 g must be computed against it, not against raw weight.
  const totalGrams = recipe.finalWeightG ?? rawGrams;
  const servings = Math.max(1, recipe.servings);

  const perServing = scaleBy(total, 1 / servings);
  const per100g = totalGrams > 0 ? scaleBy(total, 100 / totalGrams) : {};
  return { totalGrams, total, perServing, per100g };
}

function scaleBy(vector: Nutrients, factor: number): Nutrients {
  const out: Nutrients = {};
  for (const key in vector) {
    const value = vector[key];
    if (value !== undefined) out[key] = value * factor;
  }
  return out;
}

/** Save a recipe and mirror it into `foods` so it is searchable and loggable. */
export async function saveRecipe(recipe: Recipe): Promise<Food> {
  const ts = now();
  await db.recipes.put({ ...recipe, updatedAt: ts });
  const { totalGrams, per100g } = recipeNutrition(recipe);
  const servingGrams = totalGrams / Math.max(1, recipe.servings);

  return upsertFood({
    source: 'recipe',
    sourceId: recipe.id,
    name: recipe.name,
    category: 'Recipe',
    per100g,
    portions: [
      { label: '1 serving', grams: Math.round(servingGrams), preferred: true },
      { label: 'Whole recipe', grams: Math.round(totalGrams) },
      { label: '100 g', grams: 100 },
    ],
    quality: 1,
    verified: true,
  });
}

/** Live recipes, newest first. */
export async function listRecipes(): Promise<Recipe[]> {
  const rows = await db.recipes.toArray();
  return rows.filter((r) => !r.deleted).sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Retire a recipe and the food it is mirrored into.
 *
 * Both are tombstoned rather than removed: diary entries hold their own
 * nutrition snapshot so history is safe either way, but editing one of those
 * entries re-reads the food, and a hard delete would turn that into a dead end.
 */
export async function deleteRecipe(recipeId: string): Promise<void> {
  const ts = now();
  const recipe = await db.recipes.get(recipeId);
  if (recipe) await db.recipes.put({ ...recipe, deleted: true, updatedAt: ts });

  const mirror = await db.foods.where('[source+sourceId]').equals(['recipe', recipeId]).first();
  if (mirror) await db.foods.put({ ...mirror, deleted: true, updatedAt: ts });
}

/** The food record a recipe is mirrored into, which is what gets logged. */
export function foodForRecipe(recipeId: string): Promise<Food | undefined> {
  return db.foods.where('[source+sourceId]').equals(['recipe', recipeId]).first();
}

/** Foods the user made themselves, newest first. */
export async function listOwnFoods(): Promise<Food[]> {
  const rows = await db.foods.where('source').anyOf(['user', 'label']).toArray();
  return rows.filter((f) => !f.deleted).sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Everything marked a favourite.
 *
 * Scanned rather than indexed: IndexedDB has no boolean key type, so rows with
 * `favorite: true` never appear in the `favorite` index at all. The usage table
 * only holds foods this device has actually touched, so the scan is small.
 */
export async function listFavorites(): Promise<Food[]> {
  const marked = await db.usage.filter((row) => row.favorite === true).toArray();
  if (marked.length === 0) return [];
  const foods = await db.foods.bulkGet(marked.map((row) => row.foodId));
  const byId = new Map(foods.filter(Boolean).map((food) => [food!.id, food!]));
  return marked
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .map((row) => byId.get(row.foodId))
    .filter((food): food is Food => food !== undefined && !food.deleted);
}

// ---------------------------------------------------------------------------
// Body, water, exercise, fasting
// ---------------------------------------------------------------------------

export async function logWeight(day: DayKey, kg: number): Promise<WeightLog> {
  const ts = now();
  const existing = (await db.weights.where('day').equals(day).toArray()).find((w) => !w.deleted);
  const record: WeightLog = existing
    ? { ...existing, kg, updatedAt: ts }
    : { id: newId(), day, kg, loggedAt: ts, updatedAt: ts };
  await db.weights.put(record);
  return record;
}

export async function getWeights(): Promise<WeightLog[]> {
  const rows = await db.weights.toArray();
  return rows.filter((w) => !w.deleted).sort((a, b) => (a.day < b.day ? -1 : 1));
}

export async function logBiometric(day: DayKey, type: BiometricType, value: number, note?: string): Promise<void> {
  const ts = now();
  const existing = (await db.biometrics.where('[day+type]').equals([day, type]).toArray()).find((b) => !b.deleted);
  const record: Biometric = existing
    ? { ...existing, value, note, updatedAt: ts }
    : { id: newId(), day, type, value, note, loggedAt: ts, updatedAt: ts };
  await db.biometrics.put(record);
}

export async function getBiometrics(type: BiometricType): Promise<Biometric[]> {
  const rows = await db.biometrics.where('type').equals(type).toArray();
  return rows.filter((b) => !b.deleted).sort((a, b) => (a.day < b.day ? -1 : 1));
}

export async function addWater(day: DayKey, ml: number): Promise<void> {
  const ts = now();
  await db.water.add({ id: newId(), day, ml, loggedAt: ts, updatedAt: ts } satisfies WaterLog);
}

export async function waterForDay(day: DayKey): Promise<number> {
  const rows = await db.water.where('day').equals(day).toArray();
  return rows.filter((w) => !w.deleted).reduce((sum, w) => sum + w.ml, 0);
}

/** Individual drinks for a day, newest first, so they can be reviewed and removed. */
export async function waterEntriesForDay(day: DayKey): Promise<WaterLog[]> {
  const rows = await db.water.where('day').equals(day).toArray();
  return rows.filter((w) => !w.deleted).sort((a, b) => b.loggedAt - a.loggedAt);
}

export async function deleteWater(id: string): Promise<void> {
  const entry = await db.water.get(id);
  if (!entry) return;
  await db.water.put({ ...entry, deleted: true, updatedAt: now() });
}

export async function updateWater(id: string, ml: number): Promise<void> {
  const entry = await db.water.get(id);
  if (!entry) return;
  await db.water.put({ ...entry, ml, updatedAt: now() });
}

export async function logExercise(entry: Omit<ExerciseLog, 'id' | 'loggedAt' | 'updatedAt'>): Promise<void> {
  const ts = now();
  await db.exercise.add({ ...entry, id: newId(), loggedAt: ts, updatedAt: ts });
}

export async function exerciseForDay(day: DayKey): Promise<number> {
  const rows = await db.exercise.where('day').equals(day).toArray();
  return rows.filter((e) => !e.deleted).reduce((sum, e) => sum + e.kcal, 0);
}

export async function startFast(targetHours: number): Promise<FastSession> {
  const ts = now();
  const session: FastSession = { id: newId(), startTs: ts, targetHours, updatedAt: ts };
  await db.fasts.add(session);
  return session;
}

export async function endFast(id: string): Promise<void> {
  const session = await db.fasts.get(id);
  if (!session) return;
  await db.fasts.put({ ...session, endTs: now(), updatedAt: now() });
}

export async function activeFast(): Promise<FastSession | undefined> {
  const rows = await db.fasts.orderBy('startTs').reverse().limit(5).toArray();
  return rows.find((f) => !f.deleted && f.endTs === undefined);
}

// ---------------------------------------------------------------------------
// Day metadata & streaks
// ---------------------------------------------------------------------------

export async function setDayComplete(day: DayKey, complete: boolean): Promise<void> {
  await db.dayMeta.put({ day, logComplete: complete, updatedAt: now() });
}

/** Consecutive days ending today (or yesterday) with at least one entry. */
export async function currentStreak(today: DayKey = toDayKey()): Promise<number> {
  const start = addDays(today, -400);
  const entries = await entriesForRange(start, today);
  const logged = new Set(entries.map((e) => e.day));

  // A streak survives until today ends: if nothing is logged yet today but
  // yesterday was logged, the streak is still alive.
  let cursor = logged.has(today) ? today : addDays(today, -1);
  if (!logged.has(cursor)) return 0;

  let streak = 0;
  while (logged.has(cursor) && streak < 400) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

// ---------------------------------------------------------------------------
// Adaptive expenditure input
// ---------------------------------------------------------------------------

/**
 * Assemble the per-day intake and weight series the Kalman estimator consumes.
 * Days with no entries at all are omitted rather than reported as zero intake —
 * "I did not log" and "I ate nothing" are very different claims.
 */
export async function buildObservations(days = 180, end: DayKey = toDayKey()): Promise<DailyObservation[]> {
  const start = addDays(end, -(days - 1));
  const [entries, weights, meta, exercise] = await Promise.all([
    entriesForRange(start, end),
    getWeights(),
    db.dayMeta.toArray(),
    db.exercise.where('day').between(start, end, true, true).toArray(),
  ]);

  const intake = new Map<DayKey, number>();
  for (const entry of entries) {
    const kcal = entry.nutrients?.[N.ENERGY] ?? 0;
    intake.set(entry.day, (intake.get(entry.day) ?? 0) + kcal);
  }

  const weightByDay = new Map<DayKey, number>();
  for (const w of weights) {
    if (daysBetween(start, w.day) >= 0 && daysBetween(w.day, end) >= 0) weightByDay.set(w.day, w.kg);
  }

  const completeByDay = new Map<DayKey, boolean>();
  for (const m of meta) if (m.logComplete !== undefined) completeByDay.set(m.day, m.logComplete);

  const exerciseByDay = new Map<DayKey, number>();
  for (const e of exercise) {
    if (e.deleted) continue;
    exerciseByDay.set(e.day, (exerciseByDay.get(e.day) ?? 0) + e.kcal);
  }

  const allDays = new Set<DayKey>([...intake.keys(), ...weightByDay.keys()]);
  return [...allDays]
    .sort()
    .map((day) => ({
      day,
      intakeKcal: intake.get(day),
      weightKg: weightByDay.get(day),
      logComplete: completeByDay.get(day),
      exerciseKcal: exerciseByDay.get(day),
    }));
}

// ---------------------------------------------------------------------------
// Aggregation helpers for the analytics screens
// ---------------------------------------------------------------------------

// Day totals are served from the precomputed aggregates rather than by adding
// up the diary on every read. Re-exported from here because this is where every
// screen already looks for them.
export { dailySummaries, type DailySummary } from './dayStats';
