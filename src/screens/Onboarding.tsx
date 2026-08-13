import { useState } from 'react';
import { formatCount } from '../core/format';
import { logWeight, saveProfile } from '../db/repo';
import { toDayKey } from '../core/dates';
import { fromKg, toKg, type MassUnit } from '../core/units';
import { estimateExpenditure } from '../core/energy';
import { computeTargets } from '../core/macros';
import {
  ACTIVITY_LABELS,
  DIET_TEMPLATES,
  createDefaultProfile,
  type ActivityLevel,
  type DietTemplate,
  type GoalDirection,
  type ReferenceSex,
} from '../core/profile';
import { Button, Card, Field, Input, Segmented, cx } from '../ui/primitives';
import { IconCheck, IconMark } from '../ui/icons';

/**
 * First-run setup.
 *
 * Kept to five short steps and one screen of copy. Everything asked for here is
 * genuinely needed to produce a first target; anything that can be inferred
 * later, or corrected from real data, is not asked at all — the adaptive model
 * replaces most of these guesses within a fortnight anyway.
 */
export default function Onboarding() {
  const [step, setStep] = useState(0);
  const [unit, setUnit] = useState<MassUnit>('kg');
  const [sex, setSex] = useState<ReferenceSex>('neutral');
  const [birthYear, setBirthYear] = useState('');
  const [heightCm, setHeightCm] = useState('175');
  const [weight, setWeight] = useState('75');
  const [activity, setActivity] = useState<ActivityLevel>('light');
  const [direction, setDirection] = useState<GoalDirection>('maintain');
  const [rate, setRate] = useState(0.4);
  const [template, setTemplate] = useState<DietTemplate>('balanced');

  const weightKg = toKg(Number(weight) || 75, unit);
  const signedRate = direction === 'lose' ? -rate : direction === 'gain' ? rate : 0;

  const draft = {
    ...createDefaultProfile(toDayKey()),
    sex,
    birthYear: Number(birthYear) || undefined,
    heightCm: Number(heightCm) || 175,
    startWeightKg: weightKg,
    activity,
    goal: { direction, rateKgPerWeek: signedRate },
    macros: {
      ...createDefaultProfile(toDayKey()).macros,
      template,
      proteinGPerKg: template === 'custom' ? 1.6 : DIET_TEMPLATES[template].proteinGPerKg,
      minFatGPerKg: template === 'custom' ? 0.8 : DIET_TEMPLATES[template].minFatGPerKg,
      maxCarbsG: template === 'custom' ? undefined : DIET_TEMPLATES[template].maxCarbsG,
    },
    display: { ...createDefaultProfile(toDayKey()).display, unitSystem: unit === 'kg' ? ('metric' as const) : ('imperial' as const), massUnit: unit },
  };

  const expenditure = estimateExpenditure(draft, weightKg);
  const preview = computeTargets({
    profile: draft,
    weightKg,
    expenditureKcal: expenditure.tdee,
    bmrKcal: expenditure.bmr,
    source: 'formula',
  });

  const steps = [
    // ---- 0: welcome ----
    <div key="welcome" className="space-y-5 text-center">
      {/* The app's own mark, not a generic flame — same artwork as the launcher
          icon and the launch screen. */}
      <div className="mx-auto grid size-[72px] place-items-center">
        <IconMark size={64} />
      </div>
      <div>
        <h1 className="text-[26px] font-semibold tracking-[-0.02em]">FuelFlow</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-dim">
          A calorie and macro tracker that measures your actual metabolism instead of guessing it.
        </p>
      </div>
      <Card className="space-y-3 text-left">
        {[
          ['Everything stays on this device', 'No account, no server, nothing uploaded. Export a backup whenever you want.'],
          ['Works offline', 'The food database lives on your phone. Scanning and searching work on a plane.'],
          ['Learns your expenditure', 'After about two weeks of logging, targets come from your own data, not a textbook formula.'],
        ].map(([title, detail]) => (
          <div key={title} className="flex gap-3">
            <IconCheck size={17} className="mt-0.5 shrink-0 text-brand" />
            <div>
              <p className="text-[14px] font-medium">{title}</p>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-faint">{detail}</p>
            </div>
          </div>
        ))}
      </Card>
    </div>,

    // ---- 1: about you ----
    <div key="you" className="space-y-4">
      <Header title="About you" detail="Used by the metabolic equations and to set nutrient reference intakes." />
      <Field label="Units">
        <Segmented
          value={unit === 'kg' ? 'metric' : 'imperial'}
          onChange={(value) => setUnit(value === 'metric' ? 'kg' : 'lb')}
          options={[
            { value: 'metric', label: 'kg / cm' },
            { value: 'imperial', label: 'lb / in' },
          ]}
        />
      </Field>
      <Field label="Reference sex" hint="Physiology input for the equations, not an identity field. Neutral averages both reference sets.">
        <Segmented
          value={sex}
          onChange={setSex}
          options={[
            { value: 'female', label: 'Female' },
            { value: 'male', label: 'Male' },
            { value: 'neutral', label: 'Neutral' },
          ]}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Height (cm)">
          <Input type="number" inputMode="numeric" value={heightCm} onChange={(e) => setHeightCm(e.target.value)} />
        </Field>
        <Field label={`Weight (${unit})`}>
          <Input type="number" inputMode="decimal" step="any" value={weight} onChange={(e) => setWeight(e.target.value)} />
        </Field>
      </div>
      <Field label="Year of birth (optional)">
        <Input type="number" inputMode="numeric" value={birthYear} onChange={(e) => setBirthYear(e.target.value)} placeholder="1990" />
      </Field>
    </div>,

    // ---- 2: activity ----
    <div key="activity" className="space-y-4">
      <Header
        title="Day-to-day activity"
        detail="Only a starting guess — once you have logged for a couple of weeks FuelFlow measures this directly and this answer stops mattering."
      />
      <div className="space-y-1.5">
        {(['sedentary', 'light', 'moderate', 'active', 'very_active'] as const).map((level) => (
          <Choice
            key={level}
            active={activity === level}
            title={ACTIVITY_LABELS[level].title}
            detail={ACTIVITY_LABELS[level].detail}
            onClick={() => setActivity(level)}
          />
        ))}
      </div>
    </div>,

    // ---- 3: goal ----
    <div key="goal" className="space-y-4">
      <Header title="What are you aiming for?" />
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
      {direction !== 'maintain' && (
        <Card className="space-y-3">
          <div className="flex items-baseline gap-2">
            <span className="text-[24px] font-semibold tnum">{fromKg(rate, unit).toFixed(2)}</span>
            <span className="text-[13px] text-faint">{unit} per week</span>
          </div>
          <input
            type="range"
            min={0.1}
            max={1.2}
            step={0.05}
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
            className="w-full accent-(--color-brand)"
            aria-label="Rate per week"
          />
          <p className="text-[12.5px] leading-relaxed text-faint">
            {((rate / weightKg) * 100).toFixed(2)}% of your body mass per week.
            {(rate / weightKg) * 100 > 1
              ? ' That is fast — expect to lose muscle alongside fat and to be hungry.'
              : ' A sustainable pace for most people.'}
          </p>
        </Card>
      )}
    </div>,

    // ---- 4: macros + summary ----
    <div key="macros" className="space-y-4">
      <Header title="Macro style" detail="Changeable at any time, and only the starting point." />
      <div className="space-y-1.5">
        {(Object.keys(DIET_TEMPLATES) as (keyof typeof DIET_TEMPLATES)[]).map((key) => (
          <Choice
            key={key}
            active={template === key}
            title={DIET_TEMPLATES[key].label}
            detail={DIET_TEMPLATES[key].detail}
            onClick={() => setTemplate(key)}
          />
        ))}
      </div>

      <Card className="space-y-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-faint">Your starting targets</p>
        <div className="flex items-baseline gap-2">
          <span className="text-[32px] font-semibold tnum">{formatCount(preview.energyKcal)}</span>
          <span className="text-[14px] text-faint">kcal/day</span>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center">
          {(
            [
              ['Protein', preview.macros.protein, 'text-protein'],
              ['Carbs', preview.macros.carbs, 'text-carbs'],
              ['Fat', preview.macros.fat, 'text-fat'],
            ] as const
          ).map(([label, value, color]) => (
            <div key={label} className="rounded-xl bg-surface-2 py-2">
              <div className={cx('text-[17px] font-semibold tnum', color)}>{value} g</div>
              <div className="text-[11px] text-faint">{label}</div>
            </div>
          ))}
        </div>
        {preview.warnings.map((w) => (
          <p key={w.code} className="rounded-lg bg-warn/10 px-3 py-2 text-[12.5px] text-dim">{w.message}</p>
        ))}
        <p className="text-[12px] leading-relaxed text-faint">
          These come from a population formula for now. Log food and weigh in for two weeks and
          FuelFlow will replace them with numbers measured from you.
        </p>
      </Card>
    </div>,
  ];

  const last = step === steps.length - 1;

  return (
    <div className="mx-auto flex h-[100dvh] w-full max-w-lg flex-col overflow-hidden bg-bg">
      {/* No pt-* here: `safe-t` is emitted later than the padding utilities and
          would overwrite it. The clearance lives in --space-safe-t. */}
      <div className="safe-t flex gap-1.5 px-4">
        {steps.map((_, index) => (
          <div
            key={index}
            className={cx(
              'h-1 flex-1 rounded-full transition-colors duration-300',
              index <= step ? 'bg-brand' : 'bg-surface-2',
            )}
          />
        ))}
      </div>

      <div className="no-scrollbar flex-1 overflow-y-auto px-4 py-6">{steps[step]}</div>

      <div className="safe-b flex gap-2 border-t border-border p-4">
        {step > 0 && (
          <Button className="flex-1" onClick={() => setStep(step - 1)}>
            Back
          </Button>
        )}
        <Button
          variant="primary"
          className="flex-[2]"
          onClick={async () => {
            if (!last) {
              setStep(step + 1);
              return;
            }
            await saveProfile({
              ...draft,
              // Bumping updatedAt past createdAt is what marks onboarding done.
              updatedAt: Date.now() + 1,
            });
            await logWeight(toDayKey(), weightKg);
          }}
        >
          {last ? 'Start tracking' : step === 0 ? 'Set up' : 'Continue'}
        </Button>
      </div>
    </div>
  );
}

function Header({ title, detail }: { title: string; detail?: string }) {
  return (
    <div>
      <h1 className="text-[22px] font-semibold tracking-[-0.01em]">{title}</h1>
      {detail && <p className="mt-1.5 text-[13.5px] leading-relaxed text-faint">{detail}</p>}
    </div>
  );
}

function Choice({
  active,
  title,
  detail,
  onClick,
}: {
  active: boolean;
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        'flex w-full items-center gap-3 rounded-2xl border p-3.5 text-left transition-colors',
        active ? 'border-brand bg-brand-soft/40' : 'border-border bg-surface hover:bg-surface-2',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-medium">{title}</div>
        <div className="mt-0.5 text-[12.5px] leading-relaxed text-faint">{detail}</div>
      </div>
      {active && <div className="size-2 shrink-0 rounded-full bg-brand" />}
    </button>
  );
}
