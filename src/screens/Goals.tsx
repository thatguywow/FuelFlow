import { useState } from 'react';
import { useUi } from '../state/ui';
import { formatCount } from '../core/format';
import { useTargets } from '../state/useTargets';
import { saveProfile } from '../db/repo';
import { DIET_TEMPLATES, type AdaptSpeed, type DietTemplate, type GoalDirection, type MacroSplit } from '../core/profile';
import { computeTargets, macroEnergy } from '../core/macros';
import { KCAL_PER_G } from '../core/nutrients';
import { fromKg, toKg } from '../core/units';
import { Button, Card, Field, Input, SectionLabel, Segmented, Sheet, Toggle, cx } from '../ui/primitives';

type Mode = 'auto' | 'custom';

/**
 * Goal and target editor.
 *
 * Two modes. **Automatic** derives everything from your measured expenditure
 * and a rate of change, with guardrails. **Custom** lets you type the exact
 * numbers you want — a coach's figures, a protocol, a preference — and honours
 * them as typed. Custom still warns when a target dips under your resting
 * metabolic rate or when the macros do not add up, but it never silently
 * rewrites what you entered.
 *
 * Everything recomputes live as you drag, warnings included, so the
 * consequences of an aggressive goal are visible before it is saved.
 */
/**
 * `useTargets` returns undefined on its first render while the live query
 * resolves. Every control below seeds its initial state from the saved profile,
 * so the editor must not mount until that data exists — otherwise `useState`
 * captures the fallbacks once and the sheet silently opens on "Automatic" with
 * default macros even when custom targets are saved.
 */
export default function Goals() {
  const closeSheet = useUi((s) => s.closeSheet);
  const derived = useTargets();

  if (!derived) {
    return (
      <Sheet open onClose={closeSheet} title="Goal & targets">
        <div className="space-y-3 p-4">
          <div className="skeleton h-40" />
          <div className="skeleton h-12" />
          <div className="skeleton h-32" />
        </div>
      </Sheet>
    );
  }
  return <GoalsEditor derived={derived} />;
}

function GoalsEditor({ derived }: { derived: NonNullable<ReturnType<typeof useTargets>> }) {
  const closeSheet = useUi((s) => s.closeSheet);
  const toast = useUi((s) => s.toast);

  const [mode, setMode] = useState<Mode>(
    derived.profile.manualEnergyKcal || derived.profile.macros.manual ? 'custom' : 'auto',
  );
  const [direction, setDirection] = useState<GoalDirection>(derived.profile.goal.direction);
  const [rate, setRate] = useState(Math.abs(derived.profile.goal.rateKgPerWeek));
  const [template, setTemplate] = useState<DietTemplate>(derived.profile.macros.template);
  const [proteinGPerKg, setProteinGPerKg] = useState(derived.profile.macros.proteinGPerKg);
  const [adaptSpeed, setAdaptSpeed] = useState<AdaptSpeed>(derived.profile.adaptSpeed);
  const [useAdaptive, setUseAdaptive] = useState(derived.profile.useAdaptiveTdee);
  const [goalWeight, setGoalWeight] = useState(() =>
    derived.profile.goal.targetWeightKg
      ? fromKg(derived.profile.goal.targetWeightKg, derived.profile.display.massUnit).toFixed(1)
      : '',
  );

  // Custom mode state, seeded from whatever is currently in effect so switching
  // to custom starts from your real numbers rather than from zero.
  const [customKcal, setCustomKcal] = useState(() =>
    String(derived.profile.manualEnergyKcal ?? derived.targets.energyKcal),
  );
  const [customMacros, setCustomMacros] = useState<MacroSplit>(
    () => derived.profile.macros.manual ?? derived.targets.macros,
  );
  const [customMacrosOn, setCustomMacrosOn] = useState(Boolean(derived.profile.macros.manual));

  const unit = derived.profile.display.massUnit;

  const signedRate = direction === 'lose' ? -rate : direction === 'gain' ? rate : 0;
  const expenditureKcal =
    useAdaptive && derived.adaptive && derived.adaptive.confidence >= 0.5
      ? derived.adaptive.expenditureKcal
      : derived.formulaTdee;

  const draftMacros = {
    ...derived.profile.macros,
    template,
    proteinGPerKg,
    minFatGPerKg:
      template === 'custom' ? derived.profile.macros.minFatGPerKg : DIET_TEMPLATES[template].minFatGPerKg,
    maxCarbsG: template === 'custom' ? derived.profile.macros.maxCarbsG : DIET_TEMPLATES[template].maxCarbsG,
    manual: mode === 'custom' && customMacrosOn ? customMacros : undefined,
  };

  const preview = computeTargets({
    profile: {
      ...derived.profile,
      goal: { ...derived.profile.goal, direction, rateKgPerWeek: signedRate },
      macros: draftMacros,
      manualEnergyKcal: mode === 'custom' ? Number(customKcal) || undefined : undefined,
      adaptSpeed,
      useAdaptiveTdee: useAdaptive,
    },
    weightKg: derived.currentWeightKg,
    expenditureKcal,
    bmrKcal: derived.bmr,
    source: 'formula',
  });

  // A percentage of body mass per week is the honest way to express rate:
  // 0.5 kg/week is gentle at 100 kg and aggressive at 55 kg.
  const percentPerWeek = (rate / derived.currentWeightKg) * 100;
  const aggressive = percentPerWeek > 1;

  const save = async () => {
    const parsedGoalWeight = Number(goalWeight);
    await saveProfile({
      goal: {
        direction,
        rateKgPerWeek: signedRate,
        targetWeightKg:
          Number.isFinite(parsedGoalWeight) && parsedGoalWeight > 0
            ? toKg(parsedGoalWeight, unit)
            : undefined,
      },
      macros: draftMacros,
      manualEnergyKcal: mode === 'custom' ? Number(customKcal) || undefined : undefined,
      adaptSpeed,
      useAdaptiveTdee: useAdaptive,
    });
    closeSheet();
    toast('Targets updated');
  };

  return (
    <Sheet
      open
      onClose={closeSheet}
      title="Goal & targets"
      footer={
        <Button variant="primary" full onClick={save}>
          Save targets
        </Button>
      }
    >
      <div className="space-y-5 p-4">
        {/* ---------- Live preview ---------- */}
        <Card glow className="space-y-3.5">
          <div className="flex items-end justify-between">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">
                Daily target
              </p>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="brand-text text-[36px] font-semibold leading-none tracking-[-0.03em] tnum">
                  {formatCount(preview.energyKcal)}
                </span>
                <span className="text-[14px] text-faint">kcal</span>
              </div>
            </div>
            <div className="text-right text-[12px] text-faint">
              <div className="tnum">{formatCount(expenditureKcal)} burned</div>
              <div className={cx('tnum', preview.energyDeltaKcal < 0 ? 'text-ok' : 'text-info')}>
                {preview.energyDeltaKcal >= 0 ? '+' : ''}
                {Math.round(preview.energyDeltaKcal)} / day
              </div>
            </div>
          </div>

          <MacroSummary macros={preview.macros} />

          {preview.warnings.map((warning) => (
            <p
              key={warning.code}
              className={cx(
                'rounded-xl px-3 py-2.5 text-[12.5px] leading-relaxed',
                warning.code === 'manual-below-floor' || warning.code === 'below-safe-floor'
                  ? 'bg-danger/10 text-danger'
                  : 'bg-warn/10 text-dim',
              )}
            >
              {warning.message}
            </p>
          ))}
        </Card>

        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'auto', label: 'Automatic' },
            { value: 'custom', label: 'Set my own' },
          ]}
        />

        {mode === 'custom' ? (
          <CustomTargets
            kcal={customKcal}
            onKcal={setCustomKcal}
            macros={customMacros}
            onMacros={setCustomMacros}
            macrosOn={customMacrosOn}
            onMacrosOn={setCustomMacrosOn}
            autoMacros={preview.macros}
          />
        ) : (
          <>
            {/* ---------- Direction ---------- */}
            <section>
              <SectionLabel>Goal</SectionLabel>
              <Segmented
                value={direction}
                onChange={(value) => {
                  setDirection(value);
                  if (value === 'maintain') setRate(0);
                  else if (rate === 0) setRate(0.4);
                }}
                options={[
                  { value: 'lose', label: 'Lose' },
                  { value: 'maintain', label: 'Maintain' },
                  { value: 'gain', label: 'Gain' },
                ]}
              />
            </section>

            {direction !== 'maintain' && (
              <section>
                <SectionLabel
                  action={
                    <span className="text-[12px] text-faint tnum">
                      {percentPerWeek.toFixed(2)}% of body mass / week
                    </span>
                  }
                >
                  Rate
                </SectionLabel>
                <Card className="space-y-3">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[26px] font-semibold tracking-[-0.02em] tnum">
                      {fromKg(rate, unit).toFixed(2)}
                    </span>
                    <span className="text-[13px] text-faint">{unit} per week</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1.2}
                    step={0.05}
                    value={rate}
                    onChange={(event) => setRate(Number(event.target.value))}
                    className="w-full"
                    aria-label="Rate of change per week"
                  />
                  <p className={cx('text-[12.5px] leading-relaxed', aggressive ? 'text-warn' : 'text-faint')}>
                    {aggressive
                      ? 'Above about 1% of body mass a week you start losing meaningful muscle alongside fat, and hunger becomes hard to sustain.'
                      : '0.5–0.75% of body mass a week is the range most people can hold without losing muscle or their sanity.'}
                  </p>
                </Card>

                <Field label={`Goal weight (${unit}, optional)`} className="mt-3">
                  <Input
                    type="number"
                    inputMode="decimal"
                    step="any"
                    value={goalWeight}
                    onChange={(event) => setGoalWeight(event.target.value)}
                    placeholder="Optional"
                  />
                </Field>
              </section>
            )}

            {/* ---------- Diet template ---------- */}
            <section>
              <SectionLabel>Macro style</SectionLabel>
              <div className="space-y-1.5">
                {(Object.keys(DIET_TEMPLATES) as (keyof typeof DIET_TEMPLATES)[]).map((key) => {
                  const item = DIET_TEMPLATES[key];
                  const active = template === key;
                  return (
                    <button
                      key={key}
                      onClick={() => {
                        setTemplate(key);
                        setProteinGPerKg(item.proteinGPerKg);
                      }}
                      className={cx(
                        'flex w-full items-center gap-3 rounded-2xl border p-3.5 text-left transition-all duration-150',
                        active
                          ? 'border-brand/50 bg-brand-soft shadow-[0_0_16px_-6px_var(--ff-brand-glow)]'
                          : 'border-border bg-surface hover:border-border-strong hover:bg-surface-2',
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-[15px] font-medium">{item.label}</div>
                        <div className="mt-0.5 text-[12.5px] text-faint">{item.detail}</div>
                      </div>
                      {active && <div className="size-2 shrink-0 rounded-full bg-brand" />}
                    </button>
                  );
                })}
              </div>
            </section>

            <Field
              label={`Protein: ${proteinGPerKg.toFixed(1)} g per kg of body mass`}
              hint={`${Math.round(proteinGPerKg * derived.currentWeightKg)} g/day at your current weight. 1.6 g/kg is enough for most people; 2.2 g/kg protects muscle best during a deficit.`}
            >
              <input
                type="range"
                min={0.8}
                max={3}
                step={0.1}
                value={proteinGPerKg}
                onChange={(event) => {
                  setProteinGPerKg(Number(event.target.value));
                  setTemplate('custom');
                }}
                className="w-full"
              />
            </Field>
          </>
        )}

        {/* ---------- Adaptive ---------- */}
        <section>
          <SectionLabel>Adaptive expenditure</SectionLabel>
          <Card className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-medium">Measure my expenditure</p>
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-faint">
                  Works out your real metabolic rate from your logged intake and weight trend.
                  {mode === 'custom'
                    ? ' With a custom target this only powers the Trends charts — your typed numbers stand.'
                    : ' Falls back to the formula until there is enough data.'}
                </p>
              </div>
              <Toggle checked={useAdaptive} onChange={setUseAdaptive} label="Use adaptive expenditure" />
            </div>

            {useAdaptive && (
              <>
                <Segmented
                  value={adaptSpeed}
                  onChange={setAdaptSpeed}
                  options={[
                    { value: 'gentle', label: 'Gentle' },
                    { value: 'balanced', label: 'Balanced' },
                    { value: 'aggressive', label: 'Reactive' },
                  ]}
                />
                <p className="text-[12px] leading-relaxed text-faint">
                  How quickly the estimate chases new data. Gentle is steadier and better if your
                  weigh-ins are irregular; reactive catches genuine metabolic changes sooner but
                  moves your target around more.
                </p>
              </>
            )}
          </Card>
        </section>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------

const MACRO_META = [
  { key: 'protein', label: 'Protein', color: 'var(--color-protein)', kcalPerG: KCAL_PER_G.protein },
  { key: 'carbs', label: 'Carbs', color: 'var(--color-carbs)', kcalPerG: KCAL_PER_G.carbs },
  { key: 'fat', label: 'Fat', color: 'var(--color-fat)', kcalPerG: KCAL_PER_G.fat },
] as const;

function MacroSummary({ macros }: { macros: MacroSplit }) {
  const total = macroEnergy(macros) || 1;
  return (
    <div>
      {/* Proportional bar: the split is easier to judge as one divided line
          than as three numbers that have to be mentally added up. */}
      <div className="mb-2.5 flex h-2 overflow-hidden rounded-full bg-surface-2">
        {MACRO_META.map((meta) => (
          <div
            key={meta.key}
            style={{
              width: `${((macros[meta.key] * meta.kcalPerG) / total) * 100}%`,
              background: meta.color,
            }}
            className="transition-[width] duration-300"
          />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        {MACRO_META.map((meta) => (
          <div key={meta.key} className="rounded-xl bg-surface-2 py-2">
            <div className="text-[17px] font-semibold tnum" style={{ color: meta.color }}>
              {macros[meta.key]} g
            </div>
            <div className="text-[11px] text-faint">
              {meta.label} · {Math.round(((macros[meta.key] * meta.kcalPerG) / total) * 100)}%
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Manual target editor.
 *
 * Macros are entered in grams because that is what the diary counts, with the
 * percentage shown alongside so the split stays legible. "Balance to target"
 * puts the leftover energy into carbohydrate, which is the adjustment almost
 * everyone actually wants — protein and fat are the ones people set
 * deliberately.
 */
function CustomTargets({
  kcal,
  onKcal,
  macros,
  onMacros,
  macrosOn,
  onMacrosOn,
  autoMacros,
}: {
  kcal: string;
  onKcal: (value: string) => void;
  macros: MacroSplit;
  onMacros: (value: MacroSplit) => void;
  macrosOn: boolean;
  onMacrosOn: (value: boolean) => void;
  autoMacros: MacroSplit;
}) {
  const targetKcal = Number(kcal) || 0;
  const fromMacros = macroEnergy(macros);
  const drift = fromMacros - targetKcal;
  const balanced = Math.abs(drift) <= Math.max(25, targetKcal * 0.03);

  const setMacro = (key: keyof MacroSplit) => (event: React.ChangeEvent<HTMLInputElement>) =>
    onMacros({ ...macros, [key]: Math.max(0, Math.round(Number(event.target.value) || 0)) });

  const balance = () => {
    const nonCarbKcal = macros.protein * KCAL_PER_G.protein + macros.fat * KCAL_PER_G.fat;
    onMacros({
      ...macros,
      carbs: Math.max(0, Math.round((targetKcal - nonCarbKcal) / KCAL_PER_G.carbs)),
    });
  };

  return (
    <div className="space-y-4">
      <Field
        label="Daily calories"
        hint="Used exactly as entered. Deficit caps do not apply here — this is your call."
      >
        <Input
          type="number"
          inputMode="numeric"
          value={kcal}
          onChange={(event) => onKcal(event.target.value)}
          className="h-14 text-center text-[26px] font-semibold"
        />
      </Field>

      <Card className="space-y-3.5">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-medium">Set macros manually</p>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-faint">
              Off means macros are still derived from your protein and fat preferences, just against
              your custom calorie target.
            </p>
          </div>
          <Toggle
            checked={macrosOn}
            onChange={(on) => {
              // Seed from the derived split so the first edit is a tweak, not a
              // blank slate.
              if (on) onMacros(autoMacros);
              onMacrosOn(on);
            }}
            label="Set macros manually"
          />
        </div>

        {macrosOn && (
          <>
            <div className="space-y-2.5">
              {MACRO_META.map((meta) => {
                const grams = macros[meta.key];
                const share = fromMacros > 0 ? ((grams * meta.kcalPerG) / fromMacros) * 100 : 0;
                return (
                  <div key={meta.key} className="flex items-center gap-3">
                    <span className="size-2.5 shrink-0 rounded-full" style={{ background: meta.color }} />
                    <span className="w-16 shrink-0 text-[14px]">{meta.label}</span>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      value={String(grams)}
                      onChange={setMacro(meta.key)}
                      className="h-10 w-24 text-center"
                      aria-label={`${meta.label} grams`}
                    />
                    <span className="w-10 shrink-0 text-[13px] text-faint">g</span>
                    <span className="ml-auto w-20 shrink-0 text-right text-[12.5px] text-faint tnum">
                      {Math.round(share)}% · {Math.round(grams * meta.kcalPerG)} kcal
                    </span>
                  </div>
                );
              })}
            </div>

            <div
              className={cx(
                'flex items-center gap-3 rounded-xl px-3 py-2.5 text-[12.5px]',
                balanced ? 'bg-ok/10 text-ok' : 'bg-warn/10 text-dim',
              )}
            >
              <span className="flex-1 leading-relaxed">
                {balanced
                  ? `Macros add up to ${Math.round(fromMacros)} kcal — matches your target.`
                  : `Macros add up to ${Math.round(fromMacros)} kcal, ${Math.abs(Math.round(drift))} ${drift > 0 ? 'over' : 'under'} target.`}
              </span>
              {!balanced && (
                <Button size="sm" onClick={balance}>
                  Balance
                </Button>
              )}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
