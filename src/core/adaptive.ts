import { daysBetween, type DayKey } from './dates';
import { KCAL_PER_KG_BODY_MASS } from './units';
import type { AdaptSpeed } from './profile';

/**
 * Adaptive energy expenditure.
 *
 * Textbook TDEE formulas are population averages and are routinely 300–500 kcal
 * wrong for an individual. But every logged day is a physics experiment: the
 * energy you ate minus the energy you burned shows up as a change in body mass.
 * Run enough of those experiments and your true expenditure falls out — no
 * formula, no lab, no wearable required.
 *
 * The estimator is a two-state Kalman filter over
 *
 *     W  — true body mass in kg (what the scale is a noisy sample of)
 *     E  — total daily energy expenditure in kcal/day
 *
 * with the process model
 *
 *     W[k] = W[k-1] + (intake[k-1] - E[k-1]) / 7700
 *     E[k] = E[k-1] + drift
 *
 * and the observation model `scale = W + noise`.
 *
 * Why a filter rather than the obvious "average intake minus weight change over
 * 4 weeks" arithmetic: the filter weighs every day by how much information it
 * actually carries, degrades gracefully when weigh-ins are skipped, tracks a
 * genuinely changing metabolism instead of smearing it across a fixed window,
 * and — most useful of all — reports its own uncertainty, so the app can say
 * "not enough data yet" instead of inventing a confident wrong number.
 *
 * A backward RTS smoothing pass then rewrites history with the benefit of
 * hindsight, which is what makes the expenditure chart stable instead of
 * re-drawing itself every morning.
 */

/** Kalman state and covariance. Covariance is [[p00, p01], [p10, p11]]. */
interface State {
  w: number;
  e: number;
  p00: number;
  p01: number;
  p10: number;
  p11: number;
}

export interface DailyObservation {
  day: DayKey;
  /** Total energy consumed that day, kcal. Undefined when nothing was logged. */
  intakeKcal?: number;
  /** Scale reading in kg. Undefined on days without a weigh-in. */
  weightKg?: number;
  /**
   * Explicit "this day's log is complete" marker. When absent, the estimator
   * applies its own plausibility heuristic.
   */
  logComplete?: boolean;
  /** Exercise energy from Health/Health Connect, kcal, if being added back. */
  exerciseKcal?: number;
}

export interface ExpenditurePoint {
  day: DayKey;
  /** Smoothed expenditure estimate for this day, kcal/day. */
  expenditureKcal: number;
  /** Standard deviation of that estimate, kcal/day. */
  sdKcal: number;
  /** Smoothed body mass for this day, kg. */
  trendWeightKg: number;
  /** Whether this day contributed usable intake information. */
  usedIntake: boolean;
}

export interface AdaptiveResult {
  /** Per-day history, oldest first, after backward smoothing. */
  series: ExpenditurePoint[];
  /** Current best estimate of daily expenditure, kcal. */
  expenditureKcal: number;
  /** ±1 SD on that estimate. */
  sdKcal: number;
  /** Current smoothed body mass, kg. */
  trendWeightKg: number;
  /** 0–1. Below ~0.5 the UI should keep showing the formula estimate. */
  confidence: number;
  /** Days that supplied both a complete intake log and were inside the window. */
  usableDays: number;
  /** Days with at least one weigh-in. */
  weighInDays: number;
}

export interface AdaptiveOptions {
  /** Starting guess for expenditure, normally the formula TDEE. */
  priorExpenditureKcal: number;
  /** Starting guess for body mass; defaults to the first weigh-in. */
  priorWeightKg?: number;
  adaptSpeed?: AdaptSpeed;
  /**
   * Variance of a scale reading around true body mass, kg². Captures water,
   * glycogen, gut contents and scale error. 0.49 ≈ a 0.7 kg standard deviation,
   * which matches typical morning-weigh-in behaviour.
   */
  measurementVariance?: number;
}

/** How fast we allow true expenditure to drift, as variance in (kcal/day)². */
const DRIFT_VARIANCE: Record<AdaptSpeed, number> = {
  gentle: 16, // ~4 kcal/day of drift per day
  balanced: 64, // ~8 kcal/day
  aggressive: 225, // ~15 kcal/day
};

/** Unmodelled body-mass change per day, kg². ~0.08 kg standard deviation. */
const MASS_PROCESS_VARIANCE = 0.0064;

/** A day with no intake information gets enough process noise to say nothing. */
const UNKNOWN_INTAKE_VARIANCE = 4.0;

/**
 * Below this fraction of estimated expenditure a day is almost certainly a
 * partial log rather than a real fast, and using it would bias expenditure
 * downwards. Such days are treated as missing unless explicitly confirmed.
 */
const IMPLAUSIBLE_INTAKE_RATIO = 0.4;

const C = KCAL_PER_KG_BODY_MASS;

export function estimateAdaptiveExpenditure(
  observations: DailyObservation[],
  options: AdaptiveOptions,
): AdaptiveResult | null {
  const sorted = [...observations].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const firstWeighIn = sorted.find((o) => o.weightKg !== undefined);
  if (!firstWeighIn || sorted.length === 0) return null;

  const measurementVariance = options.measurementVariance ?? 0.49;
  const driftVariance = DRIFT_VARIANCE[options.adaptSpeed ?? 'balanced'];

  // Densify: the physics runs per calendar day, including days with no entries.
  const start = sorted[0]!.day;
  const end = sorted[sorted.length - 1]!.day;
  const byDay = new Map(sorted.map((o) => [o.day, o]));
  const totalDays = daysBetween(start, end);
  if (totalDays < 0) return null;

  const days: DayKey[] = [];
  for (let i = 0; i <= totalDays; i++) days.push(shift(start, i));

  let state: State = {
    w: options.priorWeightKg ?? firstWeighIn.weightKg!,
    e: options.priorExpenditureKcal,
    // Body mass is known about as well as the scale can report it; expenditure
    // starts wide open (±350 kcal) so real data overrides the formula quickly.
    p00: measurementVariance,
    p01: 0,
    p10: 0,
    p11: 350 * 350,
  };

  const filtered: State[] = [];
  const predicted: State[] = [];
  const usedIntakeFlags: boolean[] = [];
  let usableDays = 0;
  let weighInDays = 0;

  for (let i = 0; i < days.length; i++) {
    const day = days[i]!;
    const obs = byDay.get(day);

    // ---- Predict ---------------------------------------------------------
    // Note on exercise: E is *total* daily expenditure, so a user's habitual
    // training is already inside the estimate. Adding tracked workout calories
    // here would double-count them. `exerciseKcal` is carried on the
    // observation for display and for the optional "eat back" target
    // adjustment only — the estimator deliberately ignores it.
    const intake = obs?.intakeKcal;

    const plausible =
      intake !== undefined &&
      (obs?.logComplete === true || intake >= state.e * IMPLAUSIBLE_INTAKE_RATIO);
    const usable = intake !== undefined && plausible;
    if (usable) usableDays++;
    usedIntakeFlags.push(usable);

    // With no trustworthy intake the balance equation carries no information,
    // so assume maintenance and widen the mass uncertainty to match.
    const effectiveIntake = usable ? intake! : state.e;
    const massNoise = usable ? MASS_PROCESS_VARIANCE : UNKNOWN_INTAKE_VARIANCE;

    const a = 1 / C;
    const w = state.w + (effectiveIntake - state.e) / C;
    const e = state.e;

    // P' = F P Fᵀ + Q, with F = [[1, -a], [0, 1]].
    const p00 = state.p00 - a * state.p10 - a * state.p01 + a * a * state.p11 + massNoise;
    const p01 = state.p01 - a * state.p11;
    const p10 = state.p10 - a * state.p11;
    const p11 = state.p11 + driftVariance;

    const prior: State = { w, e, p00, p01, p10, p11 };
    predicted.push(prior);

    // ---- Update ----------------------------------------------------------
    if (obs?.weightKg !== undefined) {
      weighInDays++;
      const innovation = obs.weightKg - prior.w;
      const s = prior.p00 + measurementVariance;
      const k0 = prior.p00 / s;
      const k1 = prior.p10 / s;

      state = {
        w: prior.w + k0 * innovation,
        e: prior.e + k1 * innovation,
        p00: (1 - k0) * prior.p00,
        p01: (1 - k0) * prior.p01,
        p10: prior.p10 - k1 * prior.p00,
        p11: prior.p11 - k1 * prior.p01,
      };
    } else {
      state = prior;
    }
    filtered.push(state);
  }

  // ---- Backward RTS smoothing -------------------------------------------
  // Rewrites the history using later observations so the expenditure chart
  // stops changing shape behind the user every time they step on the scale.
  const smoothed: State[] = new Array(filtered.length);
  smoothed[filtered.length - 1] = filtered[filtered.length - 1]!;

  const a = 1 / C;
  for (let k = filtered.length - 2; k >= 0; k--) {
    const f = filtered[k]!;
    const priorNext = predicted[k + 1]!;
    const sNext = smoothed[k + 1]!;

    // G = P_k Fᵀ (P'_{k+1})⁻¹, with Fᵀ = [[1, 0], [-a, 1]].
    const m00 = f.p00 - a * f.p01;
    const m01 = f.p01;
    const m10 = f.p10 - a * f.p11;
    const m11 = f.p11;

    const det = priorNext.p00 * priorNext.p11 - priorNext.p01 * priorNext.p10;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
      smoothed[k] = f;
      continue;
    }
    const i00 = priorNext.p11 / det;
    const i01 = -priorNext.p01 / det;
    const i10 = -priorNext.p10 / det;
    const i11 = priorNext.p00 / det;

    const g00 = m00 * i00 + m01 * i10;
    const g01 = m00 * i01 + m01 * i11;
    const g10 = m10 * i00 + m11 * i10;
    const g11 = m10 * i01 + m11 * i11;

    const dw = sNext.w - priorNext.w;
    const de = sNext.e - priorNext.e;

    // P_k^s = P_k + G (P^s_{k+1} - P'_{k+1}) Gᵀ
    const d00 = sNext.p00 - priorNext.p00;
    const d01 = sNext.p01 - priorNext.p01;
    const d10 = sNext.p10 - priorNext.p10;
    const d11 = sNext.p11 - priorNext.p11;

    const gd00 = g00 * d00 + g01 * d10;
    const gd01 = g00 * d01 + g01 * d11;
    const gd10 = g10 * d00 + g11 * d10;
    const gd11 = g10 * d01 + g11 * d11;

    smoothed[k] = {
      w: f.w + g00 * dw + g01 * de,
      e: f.e + g10 * dw + g11 * de,
      p00: f.p00 + gd00 * g00 + gd01 * g01,
      p01: f.p01 + gd00 * g10 + gd01 * g11,
      p10: f.p10 + gd10 * g00 + gd11 * g01,
      p11: f.p11 + gd10 * g10 + gd11 * g11,
    };
  }

  const series: ExpenditurePoint[] = days.map((day, i) => {
    const s = smoothed[i]!;
    return {
      day,
      expenditureKcal: s.e,
      sdKcal: Math.sqrt(Math.max(0, s.p11)),
      trendWeightKg: s.w,
      usedIntake: usedIntakeFlags[i] ?? false,
    };
  });

  const latest = filtered[filtered.length - 1]!;
  const sdKcal = Math.sqrt(Math.max(0, latest.p11));

  return {
    series,
    expenditureKcal: latest.e,
    sdKcal,
    trendWeightKg: latest.w,
    confidence: confidenceFrom(sdKcal, usableDays, weighInDays),
    usableDays,
    weighInDays,
  };
}

/**
 * Confidence blends statistical precision with plain data sufficiency, because
 * a filter can look precise while running on three data points.
 */
function confidenceFrom(sdKcal: number, usableDays: number, weighInDays: number): number {
  // ±150 kcal is roughly the point where the estimate beats a good formula.
  const precision = clamp01(1 - (sdKcal - 40) / 260);
  const intakeCoverage = clamp01(usableDays / 14);
  const weightCoverage = clamp01(weighInDays / 10);
  return clamp01(precision * 0.5 + intakeCoverage * 0.3 + weightCoverage * 0.2);
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

function shift(key: DayKey, days: number): DayKey {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days);
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Human-readable state of the estimator, used verbatim on the Trends screen.
 */
export function describeConfidence(result: AdaptiveResult | null): {
  level: 'none' | 'learning' | 'fair' | 'good';
  headline: string;
  detail: string;
} {
  if (!result || result.usableDays < 3) {
    return {
      level: 'none',
      headline: 'Learning your metabolism',
      detail: 'Log food and weigh in for about two weeks and FuelFlow will work out your real expenditure.',
    };
  }
  if (result.confidence < 0.5) {
    const remaining = Math.max(1, 14 - result.usableDays);
    return {
      level: 'learning',
      headline: 'Still learning',
      detail: `About ${remaining} more logged ${remaining === 1 ? 'day' : 'days'} until the estimate is solid. Using the formula estimate until then.`,
    };
  }
  if (result.confidence < 0.75) {
    return {
      level: 'fair',
      headline: 'Estimate forming',
      detail: `Your expenditure looks like ${Math.round(result.expenditureKcal)} kcal/day, give or take ${Math.round(result.sdKcal)}.`,
    };
  }
  return {
    level: 'good',
    headline: 'Dialled in',
    detail: `Measured from your own data: ${Math.round(result.expenditureKcal)} ± ${Math.round(result.sdKcal)} kcal/day.`,
  };
}
