import { useLiveQuery } from 'dexie-react-hooks';
import { useUi } from '../state/ui';
import { useDay, useTargets } from '../state/useTargets';
import { formatDayLabel, isToday, toDayKey } from '../core/dates';
import { N, sumNutrients } from '../core/nutrients';
import { describeConfidence } from '../core/adaptive';
import { addWater, currentStreak, deleteEntry, restoreEntry, setDayComplete } from '../db/repo';
import { getFood } from '../db/repo';
import { Button, Card, IconButton, SectionLabel, cx } from '../ui/primitives';
import { EnergyRing, MacroBars } from '../ui/charts';
import {
  IconBarcode,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconDroplet,
  IconPlus,
  IconSparkle,
  IconTrash,
} from '../ui/icons';

export default function Today() {
  const day = useUi((s) => s.day);
  const stepDay = useUi((s) => s.stepDay);
  const setDay = useUi((s) => s.setDay);
  const openSheet = useUi((s) => s.openSheet);
  const toast = useUi((s) => s.toast);

  const derived = useTargets();
  const dayData = useDay(day);
  const streak = useLiveQuery(() => currentStreak(), [], 0);

  if (!derived || !dayData) return <TodaySkeleton />;

  const { targets, profile, adaptive } = derived;
  const consumed = sumNutrients(dayData.entries.map((e) => e.nutrients));
  const exerciseBonus = profile.addExerciseCalories ? dayData.exerciseKcal : 0;
  const energy = consumed[N.ENERGY] ?? 0;
  const confidence = describeConfidence(adaptive);
  const showLearning = profile.useAdaptiveTdee && confidence.level !== 'good';

  return (
    <div className="safe-t px-4 pb-6">
      {/* ---------- Day navigation ---------- */}
      <header className="flex items-center justify-between py-3">
        <IconButton label="Previous day" onClick={() => stepDay(-1)}>
          <IconChevronLeft />
        </IconButton>

        <button
          onClick={() => setDay(toDayKey())}
          className="flex flex-col items-center px-3"
          title="Jump to today"
        >
          <span className="text-[17px] font-semibold">{formatDayLabel(day)}</span>
          {streak > 1 && !profile.display.hideStreaks && (
            <span className="text-[11px] font-medium text-brand">{streak} day streak</span>
          )}
        </button>

        <IconButton
          label="Next day"
          onClick={() => stepDay(1)}
          className={cx(isToday(day) && 'pointer-events-none opacity-30')}
        >
          <IconChevronRight />
        </IconButton>
      </header>

      {/* ---------- Hero ---------- */}
      <Card glow className="flex flex-col items-center gap-6 overflow-hidden py-7">
        <EnergyRing consumed={energy} target={targets.energyKcal + exerciseBonus} />

        <div className="grid w-full grid-cols-3 divide-x divide-border text-center">
          <Stat label="Eaten" value={Math.round(energy)} />
          <Stat
            label="Target"
            value={Math.round(targets.energyKcal + exerciseBonus)}
            accent
            onClick={() => openSheet({ kind: 'goals' })}
          />
          <Stat label={exerciseBonus > 0 ? 'Exercise' : 'Burned'} value={Math.round(dayData.exerciseKcal)} />
        </div>

        <div className="w-full border-t border-border pt-5">
          <MacroBars
            compact
            data={[
              { key: 'protein', label: 'Protein', consumed: consumed[N.PROTEIN] ?? 0, target: targets.macros.protein },
              {
                key: 'carbs',
                label: profile.display.netCarbs ? 'Net carbs' : 'Carbs',
                consumed: profile.display.netCarbs
                  ? Math.max(0, (consumed[N.CARBS] ?? 0) - (consumed[N.FIBER] ?? 0))
                  : (consumed[N.CARBS] ?? 0),
                target: targets.macros.carbs,
              },
              { key: 'fat', label: 'Fat', consumed: consumed[N.FAT] ?? 0, target: targets.macros.fat },
            ]}
          />
        </div>

        <button
          onClick={() => openSheet({ kind: 'nutrient-detail', day })}
          className="rounded-full border border-border bg-surface-2 px-4 py-2 text-[13px] font-medium text-brand transition-colors hover:border-brand/40 hover:bg-brand-soft"
        >
          All nutrients →
        </button>
      </Card>

      {/* ---------- Adaptive status ---------- */}
      {showLearning && (
        <button
          onClick={() => useUi.getState().setTab('trends')}
          className="mt-3 flex w-full items-start gap-3 rounded-[--radius-card] border border-border bg-brand-soft/40 p-3.5 text-left"
        >
          <IconSparkle size={18} className="mt-0.5 shrink-0 text-brand" />
          <div>
            <p className="text-[14px] font-medium">{confidence.headline}</p>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-dim">{confidence.detail}</p>
          </div>
        </button>
      )}

      {targets.warnings.length > 0 && (
        <div className="mt-3 rounded-[--radius-card] border border-warn/30 bg-warn/10 p-3.5">
          {targets.warnings.map((warning) => (
            <p key={warning.code} className="text-[12.5px] leading-relaxed text-dim">
              {warning.message}
            </p>
          ))}
        </div>
      )}

      {/* ---------- Quick actions ---------- */}
      <div className="mt-4 grid grid-cols-3 gap-2">
        <QuickAction
          icon={<IconSparkle size={18} />}
          label="Quick log"
          onClick={() => openSheet({ kind: 'quick-log', mealId: defaultMeal(profile.meals), day })}
        />
        <QuickAction
          icon={<IconBarcode size={18} />}
          label="Scan"
          onClick={() => openSheet({ kind: 'scanner', mealId: defaultMeal(profile.meals), day })}
        />
        <QuickAction
          icon={<IconDroplet size={18} />}
          label={`Water ${dayData.waterMl > 0 ? `· ${(dayData.waterMl / 1000).toFixed(1)} L` : ''}`}
          onClick={async () => {
            await addWater(day, 250);
            toast('250 ml logged');
          }}
        />
      </div>

      {/* ---------- Meals ---------- */}
      <div className="mt-6 space-y-5">
        {profile.meals.map((meal) => {
          const entries = dayData.entries.filter((e) => e.mealId === meal.id);
          const mealKcal = entries.reduce((sum, e) => sum + (e.nutrients[N.ENERGY] ?? 0), 0);

          return (
            <section key={meal.id}>
              <SectionLabel
                action={
                  <span className="text-[12px] font-medium text-faint tnum">
                    {Math.round(mealKcal).toLocaleString()} kcal
                  </span>
                }
              >
                {meal.name}
              </SectionLabel>

              <Card padded={false} className="overflow-hidden">
                {entries.map((entry, index) => (
                  <div key={entry.id}>
                    {index > 0 && <div className="ml-4 h-px bg-border" />}
                    <div className="group flex items-center gap-2 pr-2">
                      <button
                        onClick={async () => {
                          const food = entry.foodId ? await getFood(entry.foodId) : undefined;
                          if (food) openSheet({ kind: 'food-detail', food, mealId: meal.id, day, entryId: entry.id });
                        }}
                        className="min-w-0 flex-1 px-4 py-3 text-left transition-colors hover:bg-surface-2"
                      >
                        <div className="truncate text-[15px]">{entry.name}</div>
                        <div className="mt-0.5 truncate text-[12.5px] text-faint">
                          {entry.brand ? `${entry.brand} · ` : ''}
                          {entry.quickAdd
                            ? 'Quick add'
                            : entry.portionLabel ?? `${Math.round(entry.grams)} g`}
                        </div>
                      </button>

                      <span className="shrink-0 text-[14px] text-dim tnum">
                        {Math.round(entry.nutrients[N.ENERGY] ?? 0)}
                      </span>

                      <IconButton
                        label={`Remove ${entry.name}`}
                        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        onClick={async () => {
                          await deleteEntry(entry.id);
                          toast(`Removed ${entry.name}`, {
                            action: { label: 'Undo', run: () => void restoreEntry(entry.id) },
                          });
                        }}
                      >
                        <IconTrash size={16} />
                      </IconButton>
                    </div>
                  </div>
                ))}

                <div className={cx('flex items-center', entries.length > 0 && 'border-t border-border')}>
                  <button
                    onClick={() => openSheet({ kind: 'add-food', mealId: meal.id, day })}
                    className="flex flex-1 items-center gap-2 px-4 py-3 text-[14px] font-medium text-brand transition-colors hover:bg-surface-2"
                  >
                    <IconPlus size={17} />
                    Add food
                  </button>
                  {entries.length > 0 && (
                    <IconButton
                      label={`Copy ${meal.name} to another day`}
                      onClick={() => openSheet({ kind: 'add-food', mealId: meal.id, day })}
                      className="mr-2"
                    >
                      <IconCopy size={16} />
                    </IconButton>
                  )}
                </div>
              </Card>
            </section>
          );
        })}
      </div>

      {/* ---------- Complete-log marker ---------- */}
      {dayData.entries.length > 0 && (
        <Button
          variant={dayData.logComplete ? 'primary' : 'secondary'}
          full
          className="mt-6"
          onClick={async () => {
            await setDayComplete(day, !dayData.logComplete);
            toast(
              dayData.logComplete
                ? 'Marked as incomplete'
                : 'Marked complete — this day now counts towards your expenditure estimate',
            );
          }}
        >
          <IconCheck size={18} />
          {dayData.logComplete ? 'Logged everything' : 'Mark day complete'}
        </Button>
      )}

      <p className="mt-3 px-2 text-center text-[11.5px] leading-relaxed text-faint">
        Marking a day complete tells the expenditure model this intake is real, not a half-finished log.
      </p>
    </div>
  );
}

function defaultMeal(meals: { id: string; defaultTime: number }[]): string {
  const minutes = new Date().getHours() * 60 + new Date().getMinutes();
  let best = meals[0];
  let bestDistance = Infinity;
  for (const meal of meals) {
    const distance = Math.abs(meal.defaultTime - minutes);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = meal;
    }
  }
  return best?.id ?? 'snacks';
}

function Stat({
  label,
  value,
  accent,
  onClick,
}: {
  label: string;
  value: number;
  accent?: boolean;
  onClick?: () => void;
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag onClick={onClick} className={cx('py-1', onClick && 'transition-opacity hover:opacity-70')}>
      <div className={cx('text-[20px] font-semibold tracking-[-0.02em] tnum', accent && 'brand-text')}>
        {value.toLocaleString()}
      </div>
      <div className="mt-1 text-[10.5px] font-medium uppercase tracking-[0.09em] text-faint">
        {label}
      </div>
    </Tag>
  );
}

function QuickAction({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="panel flex flex-col items-center gap-2 py-3.5 text-[12px] font-medium text-dim transition-[transform,border-color] duration-150 hover:border-border-strong active:scale-[0.97]"
    >
      {/* Tinted glyph tile rather than a bare icon — gives the row weight and
          picks the brand gradient up from the hero above it. */}
      <span className="grid size-9 place-items-center rounded-xl bg-brand-soft text-brand">
        {icon}
      </span>
      <span className="truncate px-1">{label}</span>
    </button>
  );
}

function TodaySkeleton() {
  return (
    <div className="safe-t space-y-3 px-4 pt-6">
      <div className="skeleton h-10 rounded-xl" />
      <div className="skeleton h-80 rounded-[--radius-card]" />
      <div className="skeleton h-24 rounded-[--radius-card]" />
      <div className="skeleton h-24 rounded-[--radius-card]" />
    </div>
  );
}
