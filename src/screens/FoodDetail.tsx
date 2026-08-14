import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useUi } from '../state/ui';
import { useTargets } from '../state/useTargets';
import type { DayKey } from '../core/dates';
import {
  GROUP_LABEL,
  N,
  NUTRIENTS,
  formatNutrient,
  scaleNutrients,
  type NutrientGroup,
} from '../core/nutrients';
import { nutrientStatus } from '../core/dri';
import { db, type Food } from '../db/schema';
import { deleteEntry, logFood, toggleFavorite, updateEntryAmount } from '../db/repo';
import { displayName, isImperialUnitPortion, portionStatesItsMass, shortPortion } from '../core/foodName';
import { formatFoodMass } from '../core/units';
import { hydrateFood } from '../search';
import { Button, Card, Divider, Input, Sheet, cx } from '../ui/primitives';
import { IconChevronDown, IconStar, IconTrash } from '../ui/icons';

/**
 * Portion picker and nutrition panel.
 *
 * Doubles as the edit view for an existing diary entry, because the two
 * screens differ only in which button sits at the bottom.
 */
export default function FoodDetail({
  food,
  mealId,
  day,
  entryId,
}: {
  food: Food;
  mealId: string;
  day: DayKey;
  entryId?: string;
}) {
  const closeSheet = useUi((s) => s.closeSheet);
  // Dismissing this sheet returns to whatever opened it — usually the search
  // results — so picking a second food does not mean starting the search again.
  const backSheet = useUi((s) => s.backSheet);
  const openSheet = useUi((s) => s.openSheet);
  const toast = useUi((s) => s.toast);
  const derived = useTargets();

  const entry = useLiveQuery(() => (entryId ? db.entries.get(entryId) : undefined), [entryId]);
  const usage = useLiveQuery(() => db.usage.get(food.id), [food.id]);

  /**
   * Search results are a thin projection: names and macros, no serving sizes
   * and no micronutrients. The full record is fetched for the one product
   * actually opened, and the panel re-reads it from the database when it lands
   * — so the sheet fills in rather than opening on a stub.
   */
  const stored = useLiveQuery(() => db.foods.get(food.id), [food.id]);
  useEffect(() => {
    void hydrateFood(food).catch(() => undefined);
  }, [food]);
  const shown = stored ?? food;

  const unitSystem = derived?.profile.display.unitSystem ?? 'metric';

  const portions = useMemo(() => {
    // Bare imperial units are unit conversions rather than servings, and USDA
    // marks them preferred often enough that a metric profile kept opening on
    // "oz · 113 g". Dropped entirely on metric — the amount field already
    // expresses any weight you like.
    const list = shown.portions.filter(
      (p) => !(unitSystem === 'metric' && isImperialUnitPortion(p.label)),
    );
    if (!list.some((p) => p.grams === 100)) list.push({ label: '100 g', grams: 100 });
    if (!list.some((p) => p.grams === 1)) list.push({ label: 'gram', grams: 1 });
    return list;
  }, [shown.portions, unitSystem]);

  /**
   * Which portion to open on.
   *
   * The entry's own portion when editing, then whatever the source marked
   * preferred, and 100 g as the floor — never simply index 0, which is an
   * arbitrary row of the upstream measure table.
   */
  const defaultPortion = useMemo(() => {
    const byEntry = portions.findIndex((p) => p.label === entry?.portionLabel);
    if (byEntry >= 0) return byEntry;
    const preferred = portions.findIndex((p) => p.preferred);
    if (preferred >= 0) return preferred;
    const hundred = portions.findIndex((p) => p.grams === 100);
    return hundred >= 0 ? hundred : 0;
  }, [portions, entry?.portionLabel]);

  const [portionIndex, setPortionIndex] = useState(defaultPortion);
  const [count, setCount] = useState(() => {
    const portion = portions[defaultPortion];
    if (usage?.typicalGrams && portion) return round(usage.typicalGrams / portion.grams);
    return 1;
  });

  /**
   * Seed the fields from the entry once it arrives.
   *
   * `useLiveQuery` returns undefined on the first render, and a `useState`
   * initialiser only runs on that render — so opening "Edit amount" showed
   * 1 x the default portion regardless of what had actually been logged, and
   * saving silently overwrote the real amount with it.
   */
  const seeded = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!entry || seeded.current === entry.id) return;
    seeded.current = entry.id;
    const index = portions.findIndex((p) => p.label === entry.portionLabel);
    const chosen = index >= 0 ? index : defaultPortion;
    setPortionIndex(chosen);
    const portion = portions[chosen];
    if (portion) setCount(round(entry.grams / portion.grams));
  }, [entry, portions, defaultPortion]);
  const [selectedMeal, setSelectedMeal] = useState(mealId);
  const [showAll, setShowAll] = useState(false);

  const portion = portions[portionIndex] ?? portions[0]!;
  const grams = Math.max(0, count * portion.grams);
  const scaled = scaleNutrients(shown.per100g, grams);

  const groups: NutrientGroup[] = showAll
    ? ['energy', 'macro', 'lipid', 'mineral', 'vitamin', 'amino', 'other']
    : ['energy', 'macro'];

  return (
    <Sheet
      open
      onClose={backSheet}
      title={
        <div className="min-w-0">
          <h2 className="truncate text-[17px] font-semibold">{displayName(shown.name).primary}</h2>
          {/* The stripped-out qualifiers are not shown. They are, by the
              definition that removed them from the name, the parts that mean
              nothing to a person choosing a food — "broiler or fryers",
              "meat only" — so printing them underneath put the cataloguing
              noise back on screen with an extra line of its own. */}
          {shown.brand && <p className="truncate text-[12.5px] text-faint">{shown.brand}</p>}
        </div>
      }
      footer={
        <div className="flex gap-2">
          {entryId && (
            <Button
              variant="danger"
              onClick={async () => {
                await deleteEntry(entryId);
                closeSheet();
                toast('Entry removed');
              }}
            >
              <IconTrash size={17} />
            </Button>
          )}
          <Button
            variant="primary"
            className="flex-1"
            disabled={grams <= 0}
            onClick={async () => {
              if (entryId) {
                await updateEntryAmount(entryId, grams, portion.label);
                toast('Entry updated');
              } else {
                await logFood({
                  food: shown,
                  day,
                  mealId: selectedMeal,
                  grams,
                  portionLabel: portion.label,
                  portionCount: count,
                });
                toast(`${displayName(shown.name).primary} added`);
              }
              closeSheet();
            }}
          >
            {entryId ? 'Save changes' : `Add ${Math.round(scaled[N.ENERGY] ?? 0)} kcal`}
          </Button>
        </div>
      }
    >
      <div className="space-y-4 p-4">
        {/* ---------- Amount ---------- */}
        <Card className="space-y-3">
          <div className="flex gap-2">
            {/*
              The width lives on a wrapper, not on the Input.

              `Input` carries `w-full` in its own base classes, and a `w-24`
              passed through className loses to it — both are width utilities,
              so the one emitted later in the compiled sheet wins regardless of
              the order they appear in the attribute. The amount field was
              therefore taking the entire row, squeezing the portion select to
              zero width and pushing it off the screen edge. That, not the
              padding, is why the portion text kept ending up under the arrow.
            */}
            <div className="w-32 shrink-0">
              <Input
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                value={String(count)}
                onChange={(event) => setCount(Number(event.target.value) || 0)}
                className="text-center text-[17px] font-semibold"
                aria-label="Amount"
              />
            </div>
            {/*
              The original control, with the one thing that was wrong with it
              fixed: the platform drew its dropdown arrow *over* the select's
              own box, so a long portion name ran underneath it.

              `appearance-none` removes the platform's arrow and we draw our
              own into padding reserved for it, which is the only way the text
              and the indicator cannot occupy the same pixels. The select itself
              stays — its picker is the one part of this the OS does better than
              we would, and replacing the whole control was an overreaction to a
              spacing bug.

              Note there is no `truncate`: on the Android WebView `text-overflow`
              on a <select> blanks the selected option instead of ellipsising
              it. A long name is allowed to be clipped by the padding edge.

              `min-w-0` on the select is what actually fixed the overlap. A
              <select> takes an intrinsic minimum width from its longest option,
              so without it the control grew wider than its own wrapper and its
              text ran on underneath the arrow — which is positioned against the
              wrapper. `w-full` alone does not stop that, which is why reserving
              padding looked like it had no effect.
            */}
            <div className="relative min-w-0 flex-1">
              <select
                value={portionIndex}
                onChange={(event) => setPortionIndex(Number(event.target.value))}
                className="h-11 w-full min-w-0 appearance-none rounded-xl border border-border bg-surface-2 pl-3 pr-10 text-[15px] text-text focus:border-brand focus:outline-none"
                aria-label="Portion"
              >
                {portions.map((p, index) => (
                  <option key={`${p.label}-${index}`} value={index}>
                    {/* A portion called "100 g" does not need "· 100 g" after
                        it, and the derivation in brackets is provenance rather
                        than the thing being chosen. */}
                    {portionStatesItsMass(p.label)
                      ? formatFoodMass(p.grams, unitSystem)
                      : `${shortPortion(p.label)} · ${formatFoodMass(p.grams, unitSystem)}`}
                  </option>
                ))}
              </select>
              <IconChevronDown
                size={18}
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-faint"
              />
            </div>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-[13px] text-faint tnum">
              {formatFoodMass(grams, unitSystem)} total
            </span>
            <button
              onClick={async () => {
                const favorite = await toggleFavorite(food.id);
                // Naming the destination, because the old message did not and
                // the honest answer at the time was that there wasn't one.
                toast(
                  favorite ? 'Favourited — More › Your foods' : 'Removed from favourites',
                  favorite ? { action: { label: 'Open', run: () => openSheet({ kind: 'my-foods' }) } } : undefined,
                );
              }}
              className={cx(
                'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] transition-colors',
                usage?.favorite ? 'bg-brand-soft text-brand' : 'text-faint hover:text-dim',
              )}
            >
              {/* The label was the same string in both branches, so the only
                  feedback was a faint background change and the control looked
                  like it did nothing. */}
              <IconStar size={15} filled={usage?.favorite} />
              {usage?.favorite ? 'Favourited' : 'Favourite'}
            </button>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {[0.5, 1, 1.5, 2, 3].map((value) => (
              <button
                key={value}
                onClick={() => setCount(value)}
                className={cx(
                  'rounded-full px-3 py-1 text-[13px] transition-colors tnum',
                  count === value ? 'bg-brand text-brand-contrast' : 'bg-surface-2 text-dim hover:bg-surface-3',
                )}
              >
                {value}×
              </button>
            ))}
          </div>
        </Card>

        {/* ---------- Meal ---------- */}
        {!entryId && derived && (
          <div className="flex flex-wrap gap-1.5">
            {derived.profile.meals.map((meal) => (
              <button
                key={meal.id}
                onClick={() => setSelectedMeal(meal.id)}
                className={cx(
                  'rounded-full px-3.5 py-1.5 text-[13px] transition-colors',
                  selectedMeal === meal.id
                    ? 'bg-brand text-brand-contrast font-medium'
                    : 'bg-surface-2 text-dim hover:bg-surface-3',
                )}
              >
                {meal.name}
              </button>
            ))}
          </div>
        )}

        {/* ---------- Nutrition ---------- */}
        <Card padded={false} className="overflow-hidden">
          {groups.map((group) => {
            const rows = NUTRIENTS.filter(
              (def) => def.group === group && scaled[def.id] !== undefined,
            );
            if (rows.length === 0) return null;
            return (
              <div key={group}>
                <div className="bg-surface-2 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-faint">
                  {GROUP_LABEL[group]}
                </div>
                {rows.map((def, index) => {
                  const amount = scaled[def.id];
                  const target = derived?.nutrientTargets.get(def.id);
                  const pct = target && target.target > 0 ? ((amount ?? 0) / target.target) * 100 : null;
                  const status = nutrientStatus(amount, target);
                  return (
                    <div key={def.id}>
                      {index > 0 && <Divider className="ml-4" />}
                      <div
                        className={cx(
                          'flex items-center gap-3 px-4 py-2',
                          def.parent && 'pl-8 text-[13px] text-dim',
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate">{def.label}</span>
                        <span className="shrink-0 tnum">
                          {formatNutrient(def.id, amount)} {def.unit === 'kcal' ? '' : def.unit}
                        </span>
                        {pct !== null && (
                          <span
                            className={cx(
                              'w-12 shrink-0 text-right text-[12px] tnum',
                              status === 'over-limit'
                                ? 'text-danger'
                                : status === 'ok'
                                  ? 'text-ok'
                                  : 'text-faint',
                            )}
                          >
                            {Math.round(pct)}%
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}

          <button
            onClick={() => setShowAll(!showAll)}
            className="w-full border-t border-border py-3 text-[13px] font-medium text-brand"
          >
            {showAll ? 'Show less' : 'Show all nutrients & % of daily target'}
          </button>
        </Card>

        <p className="px-1 text-center text-[11.5px] leading-relaxed text-faint">
          {sourceLabel(shown)}
        </p>
      </div>
    </Sheet>
  );
}

function sourceLabel(food: Food): string {
  switch (food.source) {
    case 'usda':
      return 'USDA FoodData Central · analytically measured, public domain';
    case 'off':
      return 'Open Food Facts · crowd-sourced, check the label if something looks wrong';
    case 'branded':
      return 'Branded database snapshot · rebuilt monthly from Open Food Facts and USDA';
    case 'recipe':
      return 'Your recipe';
    case 'label':
      return 'Created from a nutrition label you scanned';
    default:
      return 'Custom food you created';
  }
}

// formatGrams lived here and was metric-only, which is part of why switching to
// imperial changed the body weight and nothing else. Replaced by formatFoodMass
// in core/units, which every food weight now goes through.

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
