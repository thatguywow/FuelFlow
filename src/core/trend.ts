import { daysBetween, toDayKey, type DayKey } from './dates';

/**
 * Weight trend smoothing.
 *
 * Scale weight swings ±1–2 kg on water, glycogen and gut contents alone, which
 * completely swamps the ~0.1 kg/day signal an actual deficit produces. Showing
 * raw scale weight is the single most demoralising thing a tracker can do, so
 * every weight number in the UI is a trend value and the raw points are shown
 * only as faint dots behind it.
 */

export interface WeightEntry {
  day: DayKey;
  kg: number;
}

export interface TrendPoint {
  day: DayKey;
  /** Smoothed body mass in kg. */
  trendKg: number;
  /** Raw reading for this day, if one exists. */
  rawKg?: number;
}

/**
 * Exponentially weighted moving average with gap-aware decay.
 *
 * A plain EWMA assumes evenly spaced samples. Real logs have holidays and
 * forgotten mornings, so the smoothing factor is compounded across the gap:
 * a reading after a 7-day silence moves the trend much more than one taken the
 * next morning, which is the behaviour you actually want.
 */
export function smoothWeights(entries: WeightEntry[], halfLifeDays = 10): TrendPoint[] {
  if (entries.length === 0) return [];
  const sorted = [...entries].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  // Daily smoothing factor implied by the requested half-life.
  const dailyRetention = Math.pow(0.5, 1 / halfLifeDays);

  const out: TrendPoint[] = [];
  const first = sorted[0]!;
  let trend = first.kg;
  let previousDay = first.day;
  out.push({ day: first.day, trendKg: trend, rawKg: first.kg });

  for (let i = 1; i < sorted.length; i++) {
    const entry = sorted[i]!;
    const gap = Math.max(1, daysBetween(previousDay, entry.day));
    const retention = Math.pow(dailyRetention, gap);
    const alpha = 1 - retention;
    trend = trend * retention + entry.kg * alpha;
    out.push({ day: entry.day, trendKg: trend, rawKg: entry.kg });
    previousDay = entry.day;
  }
  return out;
}

/** Fill a trend series so every calendar day between endpoints has a value. */
export function densifyTrend(points: TrendPoint[], through: DayKey = toDayKey()): TrendPoint[] {
  if (points.length === 0) return [];
  const byDay = new Map(points.map((p) => [p.day, p]));
  const start = points[0]!.day;
  const total = daysBetween(start, through);
  if (total < 0) return points;

  const out: TrendPoint[] = [];
  let last = points[0]!.trendKg;
  for (let i = 0; i <= total; i++) {
    const day = shiftDay(start, i);
    const hit = byDay.get(day);
    if (hit) {
      last = hit.trendKg;
      out.push(hit);
    } else {
      out.push({ day, trendKg: last });
    }
  }
  return out;
}

function shiftDay(key: DayKey, days: number): DayKey {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days);
  return toDayKey(date);
}

export interface RateOfChange {
  /** kg per week. Negative means losing. */
  kgPerWeek: number;
  /** ±95% confidence half-width on the rate, in kg/week. */
  confidenceKgPerWeek: number;
  /** Fraction of variance explained; low values mean "too noisy to call yet". */
  rSquared: number;
  sampleDays: number;
}

/**
 * Ordinary least-squares slope of the trend over a window, with a real
 * confidence interval. The interval is what lets the app say "you're losing
 * 0.4 kg/week" versus "not enough data to tell yet" honestly.
 */
export function rateOfChange(points: TrendPoint[], windowDays = 28): RateOfChange | null {
  if (points.length < 2) return null;
  const last = points[points.length - 1]!;
  const cutoff = -windowDays;
  const window = points.filter((p) => daysBetween(last.day, p.day) >= cutoff);
  const n = window.length;
  if (n < 2) return null;

  const xs = window.map((p) => daysBetween(window[0]!.day, p.day));
  const ys = window.map((p) => p.trendKg);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return null;

  const slopePerDay = sxy / sxx;
  const residualSS = Math.max(0, syy - slopePerDay * sxy);
  const rSquared = syy === 0 ? 1 : 1 - residualSS / syy;

  // Standard error of the slope; 1.96 for a ~95% interval (n is usually large
  // enough here that the normal approximation is fine).
  const standardError = n > 2 ? Math.sqrt(residualSS / (n - 2) / sxx) : Infinity;

  return {
    kgPerWeek: slopePerDay * 7,
    confidenceKgPerWeek: Number.isFinite(standardError) ? standardError * 7 * 1.96 : Infinity,
    rSquared,
    sampleDays: daysBetween(window[0]!.day, last.day) + 1,
  };
}

/**
 * Projected day the goal weight is reached at the current rate.
 * Returns null when the trend is flat or moving the wrong way.
 */
export function projectGoalDate(
  currentKg: number,
  targetKg: number,
  kgPerWeek: number,
): { days: number; day: DayKey } | null {
  const delta = targetKg - currentKg;
  if (Math.abs(delta) < 0.1) return null;
  if (kgPerWeek === 0) return null;
  if (Math.sign(delta) !== Math.sign(kgPerWeek)) return null;
  const weeks = delta / kgPerWeek;
  const days = Math.ceil(weeks * 7);
  if (days > 3650) return null;
  return { days, day: shiftDay(toDayKey(), days) };
}
