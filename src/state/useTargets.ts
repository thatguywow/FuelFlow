import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/schema';
import { buildObservations, readProfile, getWeights } from '../db/repo';
import { createDefaultProfile } from '../core/profile';
import { toDayKey } from '../core/dates';
import { estimateAdaptiveExpenditure, type AdaptiveResult } from '../core/adaptive';
import { estimateExpenditure } from '../core/energy';
import { computeTargets, type Targets } from '../core/macros';
import { smoothWeights, rateOfChange, type RateOfChange, type TrendPoint } from '../core/trend';
import { dailyNutrientTargets, type NutrientTarget } from '../core/dri';
import type { UserProfile } from '../core/profile';

/**
 * The single derived-state hook.
 *
 * Everything downstream of "what should I eat today" is computed here and
 * nowhere else: expenditure (adaptive if there is enough data, formula if not),
 * energy and macro targets, weight trend, rate of change, and micronutrient
 * reference intakes. Screens consume the result; none of them re-derive it.
 */

export interface DerivedTargets {
  profile: UserProfile;
  targets: Targets;
  adaptive: AdaptiveResult | null;
  /** Formula expenditure, always available as the fallback and comparison. */
  formulaTdee: number;
  bmr: number;
  currentWeightKg: number;
  trend: TrendPoint[];
  rate: RateOfChange | null;
  nutrientTargets: Map<number, NutrientTarget>;
  ready: boolean;
}

export function useTargets(): DerivedTargets | undefined {
  return useLiveQuery(async () => {
    // liveQuery callbacks run in a read-only transaction, so the profile row is
    // never created here — App seeds it on mount and this falls back to the
    // in-memory default for the one render before that lands.
    const profile = (await readProfile()) ?? createDefaultProfile(toDayKey());
    const weights = await getWeights();

    const trend = smoothWeights(weights.map((w) => ({ day: w.day, kg: w.kg })));
    const latestTrend = trend[trend.length - 1];
    const currentWeightKg = latestTrend?.trendKg ?? profile.startWeightKg;

    const formula = estimateExpenditure(profile, currentWeightKg);

    let adaptive: AdaptiveResult | null = null;
    if (profile.useAdaptiveTdee) {
      const observations = await buildObservations(180);
      adaptive = estimateAdaptiveExpenditure(observations, {
        priorExpenditureKcal: formula.tdee,
        priorWeightKg: weights[0]?.kg,
        adaptSpeed: profile.adaptSpeed,
      });
    }

    // The adaptive estimate only takes over once it is genuinely better than a
    // population formula. Below that bar the formula is the honest answer.
    const useAdaptive = adaptive !== null && adaptive.confidence >= 0.5;
    const expenditureKcal = useAdaptive ? adaptive!.expenditureKcal : formula.tdee;

    const targets = computeTargets({
      profile,
      weightKg: currentWeightKg,
      expenditureKcal,
      bmrKcal: formula.bmr,
      source: profile.macros.manual ? 'manual' : useAdaptive ? 'adaptive' : 'formula',
    });

    const nutrientTargets = dailyNutrientTargets({
      profile,
      weightKg: currentWeightKg,
      energyTargetKcal: targets.energyKcal,
    });

    return {
      profile,
      targets,
      adaptive,
      formulaTdee: formula.tdee,
      bmr: formula.bmr,
      currentWeightKg,
      trend,
      rate: rateOfChange(trend),
      nutrientTargets,
      ready: true,
    } satisfies DerivedTargets;
    // Recomputes whenever any input table changes.
  }, [], undefined as DerivedTargets | undefined);
}

/** Live entries + totals for one day. */
export function useDay(day: string) {
  return useLiveQuery(async () => {
    const [entries, water, exercise, meta] = await Promise.all([
      db.entries.where('day').equals(day).toArray(),
      db.water.where('day').equals(day).toArray(),
      db.exercise.where('day').equals(day).toArray(),
      db.dayMeta.get(day),
    ]);
    const live = entries.filter((e) => !e.deleted).sort((a, b) => a.position - b.position);
    return {
      entries: live,
      waterMl: water.filter((w) => !w.deleted).reduce((sum, w) => sum + w.ml, 0),
      exerciseKcal: exercise.filter((e) => !e.deleted).reduce((sum, e) => sum + e.kcal, 0),
      logComplete: meta?.logComplete ?? false,
    };
  }, [day]);
}
