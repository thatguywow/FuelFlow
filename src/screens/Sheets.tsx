import { useState } from 'react';
import { useUi } from '../state/ui';
import { useTargets } from '../state/useTargets';
import { toDayKey, type DayKey } from '../core/dates';
import { N } from '../core/nutrients';
import { fromKg, toKg } from '../core/units';
import { logWeight, quickAdd, upsertFood, logFood } from '../db/repo';
import { Button, Card, Field, Input, Sheet } from '../ui/primitives';

/** Weigh-in sheet. Defaults to today and to the user's own unit. */
export function LogWeight() {
  const closeSheet = useUi((s) => s.closeSheet);
  const toast = useUi((s) => s.toast);
  const derived = useTargets();
  const unit = derived?.profile.display.massUnit ?? 'kg';

  const [value, setValue] = useState(() =>
    derived ? fromKg(derived.currentWeightKg, unit).toFixed(1) : '',
  );
  const [day, setDay] = useState<DayKey>(toDayKey());

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
            autoFocus
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

/** Calories-and-macros-only entry, for meals you cannot be bothered to itemise. */
export function QuickAddSheet({ mealId, day }: { mealId: string; day: DayKey }) {
  const closeSheet = useUi((s) => s.closeSheet);
  const toast = useUi((s) => s.toast);

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
      title="Quick add"
      footer={
        <Button
          variant="primary"
          full
          disabled={energy <= 0}
          onClick={async () => {
            await quickAdd(
              day,
              mealId,
              {
                [N.ENERGY]: energy,
                ...(parsed.protein ? { [N.PROTEIN]: parsed.protein } : {}),
                ...(parsed.carbs ? { [N.CARBS]: parsed.carbs } : {}),
                ...(parsed.fat ? { [N.FAT]: parsed.fat } : {}),
              },
              name.trim() || 'Quick add',
            );
            closeSheet();
            toast('Added');
          }}
        >
          Add {energy > 0 ? `${Math.round(energy)} kcal` : ''}
        </Button>
      }
    >
      <div className="space-y-3 p-4">
        <Field label="Description (optional)">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Restaurant meal" autoFocus />
        </Field>
        <Field label="Calories" hint={parsed.kcal === 0 && derivedKcal > 0 ? `Leaving this blank uses ${Math.round(derivedKcal)} kcal from the macros below.` : undefined}>
          <Input type="number" inputMode="numeric" value={kcal} onChange={(e) => setKcal(e.target.value)} placeholder="0" />
        </Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Protein (g)">
            <Input type="number" inputMode="decimal" value={protein} onChange={(e) => setProtein(e.target.value)} placeholder="0" />
          </Field>
          <Field label="Carbs (g)">
            <Input type="number" inputMode="decimal" value={carbs} onChange={(e) => setCarbs(e.target.value)} placeholder="0" />
          </Field>
          <Field label="Fat (g)">
            <Input type="number" inputMode="decimal" value={fat} onChange={(e) => setFat(e.target.value)} placeholder="0" />
          </Field>
        </div>
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
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Oat milk, barista" />
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
