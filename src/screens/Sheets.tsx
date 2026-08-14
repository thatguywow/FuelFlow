import { useState } from 'react';
import { useUi } from '../state/ui';
import { useTargets } from '../state/useTargets';
import { toDayKey, type DayKey } from '../core/dates';
import { N } from '../core/nutrients';
import { fromKg, toKg } from '../core/units';
import { deleteEntry, getFood, logExercise, logWeight, moveEntry, quickAdd, restoreEntry, upsertFood, logFood } from '../db/repo';
import { db } from '../db/schema';
import { formatCount } from '../core/format';
import { Button, Card, Field, Input, Sheet, cx } from '../ui/primitives';

/**
 * Weigh-in sheet, in the user's own unit.
 *
 * Defaults to the day being viewed rather than to today, so a morning you
 * forgot can be filled in from that day's screen — the same rule the diary
 * follows. Future days are still excluded: there is no weight to record for a
 * day that has not happened, so the picker is capped at today.
 */
export function LogWeight() {
  const closeSheet = useUi((s) => s.closeSheet);
  const toast = useUi((s) => s.toast);
  const selectedDay = useUi((s) => s.day);
  const derived = useTargets();
  const unit = derived?.profile.display.massUnit ?? 'kg';

  const [value, setValue] = useState(() =>
    derived ? fromKg(derived.currentWeightKg, unit).toFixed(1) : '',
  );
  // Day keys are `YYYY-MM-DD`, so a string comparison is a date comparison.
  const [day, setDay] = useState<DayKey>(() =>
    selectedDay > toDayKey() ? toDayKey() : selectedDay,
  );

  return (
    <Sheet
      open
      onClose={closeSheet}
      size="auto"
      title="Log weight"
      footer={
        <Button
          variant="primary"
          full
          disabled={!Number.isFinite(Number(value)) || Number(value) <= 0}
          onClick={async () => {
            await logWeight(day, toKg(Number(value), unit));
            closeSheet();
            toast('Weight logged');
          }}
        >
          Save
        </Button>
      }
    >
      <div className="space-y-4 p-4">
        <Field label={`Weight (${unit})`}>
          <Input
            type="number"
            inputMode="decimal"
            step="any"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="h-14 text-center text-[26px] font-semibold"
          />
        </Field>

        <Field label="Date">
          <Input type="date" value={day} max={toDayKey()} onChange={(event) => setDay(event.target.value)} />
        </Field>

        <p className="px-1 text-[12.5px] leading-relaxed text-faint">
          Weigh in first thing, after the bathroom, before food or drink. Day-to-day swings are water
          and gut contents, not fat — FuelFlow shows you the trend line, not the raw number.
        </p>
      </div>
    </Sheet>
  );
}

/**
 * Logging exercise.
 *
 * The day already tracked burned calories and fed them into the ring — there
 * was simply no way to put a number in, so the field was permanently zero.
 *
 * Minutes are optional and stored but not used to derive the figure: guessing
 * kcal from duration needs a MET value per activity and the user's weight, and
 * a wrong number here silently inflates the day's allowance. Better to take
 * what the watch or machine reported.
 */
export function LogExercise({ day }: { day: DayKey }) {
  const closeSheet = useUi((s) => s.closeSheet);
  const toast = useUi((s) => s.toast);

  const [name, setName] = useState('');
  const [kcal, setKcal] = useState('');
  const [minutes, setMinutes] = useState('');

  const burned = Number(kcal) || 0;

  return (
    <Sheet
      open
      onClose={closeSheet}
      size="auto"
      title="Log exercise"
      footer={
        <Button
          variant="primary"
          full
          disabled={burned <= 0}
          onClick={async () => {
            await logExercise({
              day,
              name: name.trim() || 'Exercise',
              kcal: burned,
              minutes: Number(minutes) || undefined,
              source: 'manual',
            });
            closeSheet();
            toast(`${formatCount(burned)} kcal burned`);
          }}
        >
          {burned > 0 ? `Log ${formatCount(burned)} kcal burned` : 'Enter the calories burned'}
        </Button>
      }
    >
      <div className="space-y-4 p-4">
        <Field label="Calories burned">
          <Input
            type="number"
            inputMode="numeric"
            value={kcal}
            onChange={(e) => setKcal(e.target.value)}
            placeholder="0"
            className="h-14 text-center text-[26px] font-semibold"
          />
        </Field>

        <Field label="Activity (optional)">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Run, gym, cycling" />
        </Field>

        <Field
          label="Minutes (optional)"
          hint="Kept with the entry. The calorie figure is whatever you enter above — it is not estimated from duration, because a guess here quietly raises the day's allowance."
        >
          <Input type="number" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="45" />
        </Field>
      </div>
    </Sheet>
  );
}

/**
 * What you can do to a diary entry, reached by holding it.
 *
 * Delete used to be a trash icon revealed on hover — which a phone does not
 * have, so on the device it was invisible and the only way to remove something
 * was to open it and find the button inside. Moving an entry between meals was
 * not possible at all: logging lunch into breakfast meant deleting it and
 * starting again.
 */
export function EntryActions({
  entryId,
  entryName,
  mealId,
  day,
}: {
  entryId: string;
  entryName: string;
  mealId: string;
  day: DayKey;
}) {
  const closeSheet = useUi((s) => s.closeSheet);
  const openSheet = useUi((s) => s.openSheet);
  const toast = useUi((s) => s.toast);
  const derived = useTargets();

  const [moving, setMoving] = useState(false);

  return (
    <Sheet open onClose={closeSheet} size="auto" title={entryName}>
      <div className="space-y-2 p-4">
        {moving ? (
          <Field label="Move to">
            <div className="flex flex-wrap gap-1.5">
              {(derived?.profile.meals ?? []).map((meal) => (
                <button
                  key={meal.id}
                  disabled={meal.id === mealId}
                  onClick={async () => {
                    await moveEntry(entryId, day, meal.id);
                    closeSheet();
                    toast(`Moved to ${meal.name}`);
                  }}
                  className={cx(
                    'rounded-full px-3.5 py-2 text-[13.5px] transition-colors',
                    meal.id === mealId
                      ? 'bg-surface-3 text-faint'
                      : 'bg-surface-2 text-dim hover:bg-surface-3',
                  )}
                >
                  {meal.name}
                  {meal.id === mealId && ' · here'}
                </button>
              ))}
            </div>
          </Field>
        ) : (
          <>
            <Button
              full
              onClick={async () => {
                const entry = await db.entries.get(entryId);
                const food = entry?.foodId ? await getFood(entry.foodId) : undefined;
                if (food) openSheet({ kind: 'food-detail', food, mealId, day, entryId });
                else toast('This entry has no food to edit');
              }}
            >
              Edit amount
            </Button>

            <Button full onClick={() => setMoving(true)}>
              Move to another meal
            </Button>

            <Button
              variant="danger"
              full
              onClick={async () => {
                await deleteEntry(entryId);
                closeSheet();
                toast(`Removed ${entryName}`, {
                  action: { label: 'Undo', run: () => void restoreEntry(entryId) },
                });
              }}
            >
              Delete
            </Button>
          </>
        )}
      </div>
    </Sheet>
  );
}

/**
 * Meal chooser, shared by the quick-entry sheets. Every one of them needs to
 * ask the same question, and the answer should be visible before saving rather
 * than assumed from the clock.
 */
export function MealPicker({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (mealId: string) => void;
  className?: string;
}) {
  const derived = useTargets();
  if (!derived) return null;
  return (
    <div className={cx('flex flex-wrap gap-1.5', className)}>
      {derived.profile.meals.map((meal) => (
        <button
          key={meal.id}
          onClick={() => onChange(meal.id)}
          className={cx(
            'rounded-full px-3.5 py-1.5 text-[13px] transition-colors',
            value === meal.id
              ? 'brand-gradient font-medium text-brand-contrast'
              : 'bg-surface-2 text-dim hover:bg-surface-3',
          )}
        >
          {meal.name}
        </button>
      ))}
    </div>
  );
}

/**
 * Quick calorie entry: a name if you want one, calories, and macros if you know
 * them. For the restaurant meal you will never find in a database and do not
 * want to spend three minutes approximating.
 */
export function QuickAddSheet({ mealId, day }: { mealId: string; day: DayKey }) {
  const closeSheet = useUi((s) => s.closeSheet);
  const toast = useUi((s) => s.toast);

  const [meal, setMeal] = useState(mealId);
  const [name, setName] = useState('');
  const [kcal, setKcal] = useState('');
  const [protein, setProtein] = useState('');
  const [carbs, setCarbs] = useState('');
  const [fat, setFat] = useState('');

  const parsed = {
    kcal: Number(kcal) || 0,
    protein: Number(protein) || 0,
    carbs: Number(carbs) || 0,
    fat: Number(fat) || 0,
  };
  // If only macros were entered, derive the energy rather than logging zero.
  const derivedKcal = parsed.protein * 4 + parsed.carbs * 4 + parsed.fat * 9;
  const energy = parsed.kcal > 0 ? parsed.kcal : derivedKcal;

  return (
    <Sheet
      open
      onClose={closeSheet}
      size="auto"
      title="Quick calories"
      footer={
        <Button
          variant="primary"
          full
          disabled={energy <= 0}
          onClick={async () => {
            await quickAdd(
              day,
              meal,
              {
                [N.ENERGY]: energy,
                ...(parsed.protein ? { [N.PROTEIN]: parsed.protein } : {}),
                ...(parsed.carbs ? { [N.CARBS]: parsed.carbs } : {}),
                ...(parsed.fat ? { [N.FAT]: parsed.fat } : {}),
              },
              name.trim() || 'Quick add',
            );
            closeSheet();
            toast(`${formatCount(energy)} kcal added`);
          }}
        >
          {energy > 0 ? `Add ${formatCount(energy)} kcal` : 'Enter calories or macros'}
        </Button>
      }
    >
      <div className="space-y-4 p-4">
        <Field label="Calories">
          <Input
            type="number"
            inputMode="numeric"
            value={kcal}
            onChange={(e) => setKcal(e.target.value)}
            placeholder="0"
            className="h-14 text-center text-[26px] font-semibold"
          />
        </Field>

        <Field label="Meal">
          <MealPicker value={meal} onChange={setMeal} />
        </Field>

        <Field label="Name (optional)">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Restaurant meal" />
        </Field>

        <Field
          label="Macros (optional)"
          hint={
            parsed.kcal === 0 && derivedKcal > 0
              ? `Calories left blank, so ${formatCount(derivedKcal)} kcal is used from these macros.`
              : 'Leave blank if you only know the calorie figure.'
          }
        >
          <div className="grid grid-cols-3 gap-2">
            <Input type="number" inputMode="decimal" value={protein} onChange={(e) => setProtein(e.target.value)} placeholder="Protein" aria-label="Protein grams" />
            <Input type="number" inputMode="decimal" value={carbs} onChange={(e) => setCarbs(e.target.value)} placeholder="Carbs" aria-label="Carbs grams" />
            <Input type="number" inputMode="decimal" value={fat} onChange={(e) => setFat(e.target.value)} placeholder="Fat" aria-label="Fat grams" />
          </div>
        </Field>
      </div>
    </Sheet>
  );
}

/**
 * Custom food creation, also used as the "barcode not found" fallback: the
 * scanned code is carried through so the food is findable by scan next time,
 * on this device and in any export.
 */
export function CreateFood({
  barcode,
  mealId,
  day,
}: {
  barcode?: string;
  mealId?: string;
  day?: DayKey;
}) {
  const closeSheet = useUi((s) => s.closeSheet);
  const toast = useUi((s) => s.toast);

  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [basis, setBasis] = useState<'100g' | 'serving'>('100g');
  const [servingG, setServingG] = useState('');
  const [values, setValues] = useState({ kcal: '', protein: '', carbs: '', fat: '', fiber: '', sugar: '', satFat: '', sodium: '' });

  const set = (key: keyof typeof values) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setValues((prev) => ({ ...prev, [key]: event.target.value }));

  const serving = Number(servingG) || 0;
  const valid = name.trim().length > 0 && Number(values.kcal) > 0 && (basis === '100g' || serving > 0);

  return (
    <Sheet
      open
      onClose={closeSheet}
      title={barcode ? 'New food from barcode' : 'New food'}
      footer={
        <Button
          variant="primary"
          full
          disabled={!valid}
          onClick={async () => {
            // Everything is stored per 100 g, so label values entered per
            // serving are converted once, here, and never again.
            const factor = basis === '100g' ? 1 : 100 / serving;
            const number = (raw: string) => {
              const parsed = Number(raw);
              return Number.isFinite(parsed) && raw !== '' ? parsed * factor : undefined;
            };

            const food = await upsertFood({
              source: barcode ? 'label' : 'user',
              barcode,
              name: name.trim(),
              brand: brand.trim() || undefined,
              per100g: {
                [N.ENERGY]: number(values.kcal) ?? 0,
                ...defined(N.PROTEIN, number(values.protein)),
                ...defined(N.CARBS, number(values.carbs)),
                ...defined(N.FAT, number(values.fat)),
                ...defined(N.FIBER, number(values.fiber)),
                ...defined(N.SUGAR, number(values.sugar)),
                ...defined(N.SAT_FAT, number(values.satFat)),
                ...defined(N.SODIUM, number(values.sodium)),
              },
              portions: serving > 0
                ? [{ label: `1 serving (${serving} g)`, grams: serving, preferred: true }, { label: '100 g', grams: 100 }]
                : [{ label: '100 g', grams: 100, preferred: true }],
              quality: 0.8,
              verified: true,
            });

            if (mealId && day) {
              await logFood({
                food,
                day,
                mealId,
                grams: serving > 0 ? serving : 100,
                portionLabel: serving > 0 ? `1 serving (${serving} g)` : '100 g',
              });
              toast(`${food.name} created and logged`);
            } else {
              toast(`${food.name} saved`);
            }
            closeSheet();
          }}
        >
          {mealId ? 'Save and log' : 'Save food'}
        </Button>
      }
    >
      <div className="space-y-3 p-4">
        {barcode && (
          <Card className="text-[13px] text-dim">
            Barcode <span className="font-mono text-text">{barcode}</span> is not in any database yet.
            Enter what the label says and it will be there next time you scan it.
          </Card>
        )}

        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Oat milk, barista" />
        </Field>
        <Field label="Brand (optional)">
          <Input value={brand} onChange={(e) => setBrand(e.target.value)} />
        </Field>

        <Field label="Label values are per">
          <div className="flex gap-2">
            <Button variant={basis === '100g' ? 'primary' : 'secondary'} className="flex-1" onClick={() => setBasis('100g')}>
              100 g / ml
            </Button>
            <Button variant={basis === 'serving' ? 'primary' : 'secondary'} className="flex-1" onClick={() => setBasis('serving')}>
              Serving
            </Button>
          </div>
        </Field>

        {basis === 'serving' && (
          <Field label="Serving size (g)">
            <Input type="number" inputMode="decimal" value={servingG} onChange={(e) => setServingG(e.target.value)} placeholder="30" />
          </Field>
        )}

        <div className="grid grid-cols-2 gap-2">
          <Field label="Calories"><Input type="number" inputMode="decimal" value={values.kcal} onChange={set('kcal')} /></Field>
          <Field label="Protein (g)"><Input type="number" inputMode="decimal" value={values.protein} onChange={set('protein')} /></Field>
          <Field label="Carbs (g)"><Input type="number" inputMode="decimal" value={values.carbs} onChange={set('carbs')} /></Field>
          <Field label="Fat (g)"><Input type="number" inputMode="decimal" value={values.fat} onChange={set('fat')} /></Field>
          <Field label="Fiber (g)"><Input type="number" inputMode="decimal" value={values.fiber} onChange={set('fiber')} /></Field>
          <Field label="Sugars (g)"><Input type="number" inputMode="decimal" value={values.sugar} onChange={set('sugar')} /></Field>
          <Field label="Sat. fat (g)"><Input type="number" inputMode="decimal" value={values.satFat} onChange={set('satFat')} /></Field>
          <Field label="Sodium (mg)"><Input type="number" inputMode="decimal" value={values.sodium} onChange={set('sodium')} /></Field>
        </div>
      </div>
    </Sheet>
  );
}

function defined(id: number, value: number | undefined): Record<number, number> {
  return value === undefined ? {} : { [id]: value };
}
