import { useMemo, useState } from 'react';
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
import { displayName } from '../core/foodName';
import { formatFoodMass } from '../core/units';
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
  const toast = useUi((s) => s.toast);
  const derived = useTargets();

  const entry = useLiveQuery(() => (entryId ? db.entries.get(entryId) : undefined), [entryId]);
  const usage = useLiveQuery(() => db.usage.get(food.id), [food.id]);

  const portions = useMemo(() => {
    const list = [...food.portions];
    if (!list.some((p) => p.grams === 100)) list.push({ label: '100 g', grams: 100 });
    if (!list.some((p) => p.grams === 1)) list.push({ label: 'gram', grams: 1 });
    return list;
  }, [food.portions]);

  const initialPortion =
    portions.findIndex((p) => p.label === entry?.portionLabel) >= 0
      ? portions.findIndex((p) => p.label === entry?.portionLabel)
      : Math.max(0, portions.findIndex((p) => p.preferred));

  const [portionIndex, setPortionIndex] = useState(initialPortion);
  const [portionOpen, setPortionOpen] = useState(false);
  const unitSystem = derived?.profile.display.unitSystem ?? 'metric';
  const [count, setCount] = useState(() => {
    const portion = portions[initialPortion];
    if (entry && portion) return round(entry.grams / portion.grams);
    if (usage?.typicalGrams && portion) return round(usage.typicalGrams / portion.grams);
    return 1;
  });
  const [selectedMeal, setSelectedMeal] = useState(mealId);
  const [showAll, setShowAll] = useState(false);

  const portion = portions[portionIndex] ?? portions[0]!;
  const grams = Math.max(0, count * portion.grams);
  const scaled = scaleNutrients(food.per100g, grams);

  const groups: NutrientGroup[] = showAll
    ? ['energy', 'macro', 'lipid', 'mineral', 'vitamin', 'amino', 'other']
    : ['energy', 'macro'];

  return (
    <Sheet
      open
      onClose={backSheet}
      title={
        <div className="min-w-0">
          <h2 className="truncate text-[17px] font-semibold">{displayName(food.name).primary}</h2>
          {(food.brand || displayName(food.name).detail) && (
            <p className="truncate text-[12.5px] text-faint">
              {[food.brand, displayName(food.name).detail].filter(Boolean).join(' · ')}
            </p>
          )}
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
                  food,
                  day,
                  mealId: selectedMeal,
                  grams,
                  portionLabel: portion.label,
                  portionCount: count,
                });
                toast(`${food.name} added`);
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
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={String(count)}
              onChange={(event) => setCount(Number(event.target.value) || 0)}
              className="w-24 text-center text-[17px] font-semibold"
              aria-label="Amount"
            />
            {/*
              A button and a list, not a <select>.

              The native control rendered as an empty box with an arrow on the
              Android WebView while showing its text correctly in every desktop
              browser, so the fault could not be reproduced — or a fix verified
              — anywhere the app is actually testable. Two attempts at patching
              its CSS shipped without fixing it. Drawing the control ourselves
              removes the platform from the question entirely, and it now
              matches the rest of the app instead of the OS.
            */}
            <button
              type="button"
              onClick={() => setPortionOpen((open) => !open)}
              aria-haspopup="listbox"
              aria-expanded={portionOpen}
              className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-xl border border-border bg-surface-2 pl-3 pr-2.5 text-left text-[15px] text-text transition-colors hover:border-border-strong"
            >
              <span className="min-w-0 flex-1 truncate">
                {portion.label} · {formatFoodMass(portion.grams, unitSystem)}
              </span>
              <IconChevronDown
                size={18}
                className={cx(
                  'shrink-0 text-faint transition-transform duration-200',
                  portionOpen && 'rotate-180',
                )}
              />
            </button>
          </div>

          {portionOpen && (
            <div
              role="listbox"
              aria-label="Portion"
              className="no-scrollbar max-h-56 overflow-y-auto rounded-xl border border-border bg-surface-2"
            >
              {portions.map((p, index) => (
                <button
                  key={`${p.label}-${index}`}
                  role="option"
                  aria-selected={index === portionIndex}
                  onClick={() => {
                    setPortionIndex(index);
                    setPortionOpen(false);
                  }}
                  className={cx(
                    'flex w-full items-center gap-2 px-3 py-2.5 text-left text-[14.5px] transition-colors',
                    index > 0 && 'border-t border-border',
                    index === portionIndex ? 'bg-brand-soft text-brand' : 'hover:bg-surface-3',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{p.label}</span>
                  <span className="shrink-0 text-[13px] text-faint tnum">
                    {formatFoodMass(p.grams, unitSystem)}
                  </span>
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between">
            <span className="text-[13px] text-faint tnum">
              {formatFoodMass(grams, unitSystem)} total
            </span>
            <button
              onClick={async () => {
                const favorite = await toggleFavorite(food.id);
                toast(favorite ? 'Added to favourites' : 'Removed from favourites');
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
          {sourceLabel(food)}
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
