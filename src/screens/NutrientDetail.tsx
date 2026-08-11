import { useMemo, useState } from 'react';
import { useUi } from '../state/ui';
import { useDay, useTargets } from '../state/useTargets';
import type { DayKey } from '../core/dates';
import { GROUP_LABEL, NUTRIENTS, sumNutrients, type NutrientGroup } from '../core/nutrients';
import { nutrientStatus } from '../core/dri';
import { Card, EmptyState, Segmented, Sheet } from '../ui/primitives';
import { NutrientBar } from '../ui/charts';

/**
 * Full micronutrient breakdown for a day.
 *
 * This is the Cronometer-grade view: every tracked nutrient against its
 * reference intake, grouped and colour-coded. It is only useful because the
 * bundled USDA core dataset carries real analytical micronutrient values —
 * branded databases mostly do not, which is why "Data coverage" is shown
 * honestly at the bottom rather than pretending a zero is a measurement.
 */
export default function NutrientDetail({ day }: { day: DayKey }) {
  const closeSheet = useUi((s) => s.closeSheet);
  const derived = useTargets();
  const dayData = useDay(day);
  const [group, setGroup] = useState<'all' | NutrientGroup>('all');

  const consumed = useMemo(
    () => sumNutrients((dayData?.entries ?? []).map((e) => e.nutrients)),
    [dayData?.entries],
  );

  if (!derived || !dayData) return null;

  const groups: NutrientGroup[] =
    group === 'all' ? ['macro', 'lipid', 'vitamin', 'mineral', 'amino', 'other'] : [group];

  // How much of the day's energy came from foods that carry micronutrient data
  // at all. Below ~60% the micronutrient totals are structurally understated.
  const coverage = computeCoverage(dayData.entries);

  return (
    <Sheet open onClose={closeSheet} title="Nutrients">
      <div className="sticky top-0 z-10 bg-bg-elevated px-4 py-2.5">
        <Segmented
          value={group}
          onChange={setGroup}
          options={[
            { value: 'all', label: 'All' },
            { value: 'vitamin', label: 'Vitamins' },
            { value: 'mineral', label: 'Minerals' },
            { value: 'lipid', label: 'Lipids' },
          ]}
        />
      </div>

      {dayData.entries.length === 0 ? (
        <EmptyState title="Nothing logged yet" detail="Add some food and the full nutrient breakdown appears here." />
      ) : (
        <div className="space-y-4 p-4">
          {groups.map((section) => {
            const rows = NUTRIENTS.filter((def) => def.group === section);
            if (rows.length === 0) return null;
            return (
              <div key={section}>
                <h3 className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-[0.09em] text-faint">
                  {GROUP_LABEL[section]}
                </h3>
                <Card className="py-1">
                  {rows.map((def) => {
                    const amount = consumed[def.id] ?? 0;
                    const target = derived.nutrientTargets.get(def.id);
                    return (
                      <NutrientBar
                        key={def.id}
                        label={def.label}
                        amount={amount}
                        target={target?.target}
                        unit={def.unit === 'kcal' ? 'kcal' : def.unit}
                        status={nutrientStatus(amount, target)}
                      />
                    );
                  })}
                </Card>
              </div>
            );
          })}

          <Card className="space-y-2">
            <h3 className="text-[13px] font-semibold">Data coverage</h3>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full bg-brand transition-[width] duration-500"
                style={{ width: `${Math.round(coverage * 100)}%` }}
              />
            </div>
            <p className="text-[12.5px] leading-relaxed text-faint">
              {Math.round(coverage * 100)}% of today's energy came from foods with micronutrient data.
              Packaged products usually only publish the label panel, so vitamin and mineral totals
              are a floor, not a measurement.
            </p>
          </Card>
        </div>
      )}
    </Sheet>
  );
}

/** Energy-weighted share of entries that carry at least a few micronutrients. */
function computeCoverage(entries: { nutrients: Record<number, number | undefined> }[]): number {
  let withData = 0;
  let total = 0;
  for (const entry of entries) {
    const energy = entry.nutrients[208] ?? 0;
    total += energy;
    const micros = NUTRIENTS.filter(
      (def) => (def.group === 'vitamin' || def.group === 'mineral') && entry.nutrients[def.id] !== undefined,
    ).length;
    if (micros >= 5) withData += energy;
  }
  return total > 0 ? withData / total : 0;
}
