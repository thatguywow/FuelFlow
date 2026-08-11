import { KCAL_PER_G, N, type Nutrients } from './nutrients';
import { minimumSafeIntake } from './energy';
import { KCAL_PER_KG_BODY_MASS } from './units';
import type { MacroSplit, UserProfile } from './profile';
import { leanBodyMassKg } from './energy';

/**
 * Target solver.
 *
 * Turns "I want to lose 0.5 kg a week" into a defensible daily energy figure
 * and a macro split, with hard guardrails. The order of operations matters:
 * energy is decided first, then protein is protected, then fat is floored, and
 * carbohydrate absorbs whatever is left. That ordering is what keeps a large
 * deficit from silently eating into protein and costing lean mass.
 */

export interface Targets {
  energyKcal: number;
  macros: MacroSplit;
  /** Percentage of energy from each macro, for the ring chart legend. */
  share: { protein: number; carbs: number; fat: number };
  /** Expenditure the target was derived from. */
  expenditureKcal: number;
  /** Daily surplus/deficit actually applied, after clamping. */
  energyDeltaKcal: number;
  /** Body-mass change this target implies, kg/week. */
  impliedRateKgPerWeek: number;
  /** Non-fatal problems worth telling the user about. */
  warnings: TargetWarning[];
  source: 'adaptive' | 'formula' | 'manual';
}

export interface TargetWarning {
  code:
    | 'below-safe-floor'
    | 'deficit-capped'
    | 'surplus-capped'
    | 'protein-capped'
    | 'macros-rebalanced'
    | 'manual-below-floor'
    | 'manual-macro-mismatch';
  message: string;
}

export interface TargetInput {
  profile: UserProfile;
  weightKg: number;
  /** Best available expenditure estimate. */
  expenditureKcal: number;
  /** Resting rate, used for the safety floor. */
  bmrKcal: number;
  source: Targets['source'];
}

/** Largest sustainable deficit as a fraction of expenditure. */
const MAX_DEFICIT_FRACTION = 0.25;
/** Largest sensible surplus — beyond this you are mostly gaining fat. */
const MAX_SURPLUS_FRACTION = 0.2;
/** Protein above this share of energy displaces too much of everything else. */
const MAX_PROTEIN_ENERGY_SHARE = 0.45;

export function computeTargets(input: TargetInput): Targets {
  const { profile, weightKg, expenditureKcal, bmrKcal } = input;
  const warnings: TargetWarning[] = [];

  const floor = minimumSafeIntake(bmrKcal, profile.sex);

  // ---- Manual energy target ----------------------------------------------
  // An explicit number is a decision, not a calculation, so it is honoured as
  // typed. The safety floor still speaks up — it just warns instead of
  // silently overwriting what the user asked for.
  if (profile.manualEnergyKcal && profile.manualEnergyKcal > 0) {
    const energyKcal = Math.round(profile.manualEnergyKcal);
    if (energyKcal < floor) {
      warnings.push({
        code: 'manual-below-floor',
        message: `${energyKcal} kcal is below your estimated resting metabolic rate of ${Math.round(floor)} kcal. Sustained, that costs muscle, bone and mood — not just fat.`,
      });
    }
    const manualDelta = energyKcal - expenditureKcal;
    let macros = profile.macros.manual;
    if (macros) checkMacroSum(macros, energyKcal, warnings);
    else macros = autoMacros(profile, weightKg, energyKcal, warnings);
    return finish(macros, energyKcal, expenditureKcal, manualDelta, warnings, 'manual');
  }

  // ---- Energy ------------------------------------------------------------
  const requestedDelta = (profile.goal.rateKgPerWeek * KCAL_PER_KG_BODY_MASS) / 7;
  let delta = requestedDelta;

  const maxDeficit = -expenditureKcal * MAX_DEFICIT_FRACTION;
  const maxSurplus = expenditureKcal * MAX_SURPLUS_FRACTION;

  if (delta < maxDeficit) {
    delta = maxDeficit;
    warnings.push({
      code: 'deficit-capped',
      message: `That rate needs a deficit larger than ${Math.round(MAX_DEFICIT_FRACTION * 100)}% of your expenditure. Capped to protect lean mass.`,
    });
  }
  if (delta > maxSurplus) {
    delta = maxSurplus;
    warnings.push({
      code: 'surplus-capped',
      message: 'Surplus capped — gaining faster than this is mostly fat gain.',
    });
  }

  let energyKcal = expenditureKcal + delta;

  if (energyKcal < floor) {
    energyKcal = floor;
    delta = energyKcal - expenditureKcal;
    warnings.push({
      code: 'below-safe-floor',
      message: `Raised to ${Math.round(floor)} kcal — your resting metabolic rate. Eating under this long-term costs muscle, bone and mood, not just fat.`,
    });
  }

  energyKcal = Math.round(energyKcal / 5) * 5;

  // ---- Macros ------------------------------------------------------------
  if (profile.macros.manual) {
    checkMacroSum(profile.macros.manual, energyKcal, warnings);
    return finish(profile.macros.manual, energyKcal, expenditureKcal, delta, warnings, input.source);
  }

  const macros = autoMacros(profile, weightKg, energyKcal, warnings);
  return finish(macros, energyKcal, expenditureKcal, delta, warnings, input.source);
}

/**
 * Derive a macro split for a given energy target.
 *
 * Order of operations matters: energy is already decided, then protein is
 * protected, then fat is floored, and carbohydrate absorbs whatever is left.
 * That ordering is what keeps a large deficit from silently eating into protein
 * and costing lean mass.
 */
function autoMacros(
  profile: UserProfile,
  weightKg: number,
  energyKcal: number,
  warnings: TargetWarning[],
): MacroSplit {
  const proteinBasisKg =
    profile.macros.proteinFromLeanMass && profile.bodyFatPct
      ? leanBodyMassKg(weightKg, profile.bodyFatPct)
      : weightKg;

  let proteinG = profile.macros.proteinGPerKg * proteinBasisKg;
  const proteinCapG = (energyKcal * MAX_PROTEIN_ENERGY_SHARE) / KCAL_PER_G.protein;
  if (proteinG > proteinCapG) {
    proteinG = proteinCapG;
    warnings.push({
      code: 'protein-capped',
      message: 'Protein trimmed to leave room for enough fat and carbohydrate.',
    });
  }

  const minFatG = profile.macros.minFatGPerKg * weightKg;
  const proteinKcal = proteinG * KCAL_PER_G.protein;
  let remainingKcal = energyKcal - proteinKcal;

  let fatG: number;
  let carbsG: number;

  const carbCap = profile.macros.maxCarbsG;
  if (carbCap !== undefined) {
    // Carb-restricted templates: carbohydrate is a ceiling, fat is the buffer.
    const carbKcal = Math.min(carbCap * KCAL_PER_G.carbs, Math.max(0, remainingKcal));
    carbsG = carbKcal / KCAL_PER_G.carbs;
    fatG = Math.max(minFatG, (remainingKcal - carbKcal) / KCAL_PER_G.fat);
  } else {
    // Otherwise split what is left, keeping fat above its floor.
    const preferredFatKcal = remainingKcal * fatShareFor(profile);
    const fatKcal = Math.max(minFatG * KCAL_PER_G.fat, preferredFatKcal);
    fatG = fatKcal / KCAL_PER_G.fat;
    carbsG = Math.max(0, (remainingKcal - fatKcal) / KCAL_PER_G.carbs);
  }

  // ---- Reconcile ---------------------------------------------------------
  // Protein and fat floors can jointly exceed the energy target on a hard cut.
  // Scale both back proportionally rather than letting carbs go negative.
  const total =
    proteinG * KCAL_PER_G.protein + fatG * KCAL_PER_G.fat + carbsG * KCAL_PER_G.carbs;
  if (total > energyKcal + 1) {
    const scale = energyKcal / total;
    proteinG *= scale;
    fatG *= scale;
    carbsG *= scale;
    warnings.push({
      code: 'macros-rebalanced',
      message: 'Protein and fat minimums did not fit the energy target, so all three were scaled to fit.',
    });
  }

  remainingKcal = energyKcal - (proteinG * KCAL_PER_G.protein + fatG * KCAL_PER_G.fat);
  if (carbCap === undefined) carbsG = Math.max(0, remainingKcal / KCAL_PER_G.carbs);

  return {
    protein: Math.round(proteinG),
    carbs: Math.round(carbsG),
    fat: Math.round(fatG),
  };
}

/**
 * Hand-entered macros rarely add up to the calorie target on the first try.
 * Rather than quietly rescaling what the user typed, say so and let them decide
 * — the diary tracks both numbers independently anyway.
 */
export function macroEnergy(macros: MacroSplit): number {
  return (
    macros.protein * KCAL_PER_G.protein +
    macros.carbs * KCAL_PER_G.carbs +
    macros.fat * KCAL_PER_G.fat
  );
}

function checkMacroSum(macros: MacroSplit, energyKcal: number, warnings: TargetWarning[]): void {
  const fromMacros = macroEnergy(macros);
  const drift = fromMacros - energyKcal;
  if (Math.abs(drift) <= Math.max(25, energyKcal * 0.03)) return;
  warnings.push({
    code: 'manual-macro-mismatch',
    message: `Your macros add up to ${Math.round(fromMacros)} kcal, which is ${Math.abs(Math.round(drift))} ${drift > 0 ? 'above' : 'below'} your ${Math.round(energyKcal)} kcal target. Both are tracked as you set them.`,
  });
}

/** Preferred share of non-protein energy taken by fat, per diet template. */
function fatShareFor(profile: UserProfile): number {
  switch (profile.macros.template) {
    case 'low_fat':
      return 0.25;
    case 'mediterranean':
      return 0.55;
    case 'low_carb':
    case 'keto':
      return 0.8;
    default:
      return 0.4;
  }
}

function finish(
  macros: MacroSplit,
  energyKcal: number,
  expenditureKcal: number,
  delta: number,
  warnings: TargetWarning[],
  source: Targets['source'],
): Targets {
  const proteinKcal = macros.protein * KCAL_PER_G.protein;
  const carbKcal = macros.carbs * KCAL_PER_G.carbs;
  const fatKcal = macros.fat * KCAL_PER_G.fat;
  const total = proteinKcal + carbKcal + fatKcal || 1;

  return {
    energyKcal,
    macros,
    share: {
      protein: proteinKcal / total,
      carbs: carbKcal / total,
      fat: fatKcal / total,
    },
    expenditureKcal,
    energyDeltaKcal: delta,
    impliedRateKgPerWeek: (delta * 7) / KCAL_PER_KG_BODY_MASS,
    warnings,
    source,
  };
}

/** Remaining allowance for a day, given what has been eaten so far. */
export interface Remaining {
  energyKcal: number;
  protein: number;
  carbs: number;
  fat: number;
  /** 0–1 progress against each target, clamped at 1 for bar rendering. */
  progress: { energy: number; protein: number; carbs: number; fat: number };
  /** True progress, uncapped, so overshoot can be shown in a different colour. */
  raw: { energy: number; protein: number; carbs: number; fat: number };
}

export function remainingFor(
  targets: Targets,
  consumed: Nutrients,
  options: { netCarbs?: boolean; exerciseKcal?: number } = {},
): Remaining {
  const energy = consumed[N.ENERGY] ?? 0;
  const protein = consumed[N.PROTEIN] ?? 0;
  const fat = consumed[N.FAT] ?? 0;
  const carbsTotal = consumed[N.CARBS] ?? 0;
  const fiber = consumed[N.FIBER] ?? 0;
  const carbs = options.netCarbs ? Math.max(0, carbsTotal - fiber) : carbsTotal;

  const energyTarget = targets.energyKcal + (options.exerciseKcal ?? 0);

  const ratio = (value: number, target: number) => (target > 0 ? value / target : 0);
  const raw = {
    energy: ratio(energy, energyTarget),
    protein: ratio(protein, targets.macros.protein),
    carbs: ratio(carbs, targets.macros.carbs),
    fat: ratio(fat, targets.macros.fat),
  };

  return {
    energyKcal: energyTarget - energy,
    protein: targets.macros.protein - protein,
    carbs: targets.macros.carbs - carbs,
    fat: targets.macros.fat - fat,
    progress: {
      energy: Math.min(1, raw.energy),
      protein: Math.min(1, raw.protein),
      carbs: Math.min(1, raw.carbs),
      fat: Math.min(1, raw.fat),
    },
    raw,
  };
}
