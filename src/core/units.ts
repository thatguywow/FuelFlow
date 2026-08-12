import { formatCount } from './format';

/**
 * Unit conversion.
 *
 * Internally FuelFlow is metric and only metric: grams, millilitres, kilograms,
 * centimetres, kilocalories. Imperial exists solely as a display/entry skin at
 * the edges. Every conversion lives here so no screen ever invents its own.
 */

export type MassUnit = 'kg' | 'lb' | 'st';
export type LengthUnit = 'cm' | 'in' | 'ft';
export type EnergyUnit = 'kcal' | 'kJ';
export type VolumeUnit = 'ml' | 'fl_oz' | 'cup';
export type UnitSystem = 'metric' | 'imperial';

export const KG_PER_LB = 0.45359237;
export const CM_PER_IN = 2.54;
export const KJ_PER_KCAL = 4.184;
export const ML_PER_FL_OZ = 29.5735295625;
export const ML_PER_CUP = 240;

/**
 * Energy density of body-mass change. The classic "3500 kcal per pound" rule
 * assumes pure fat; real weight change is a mix of fat and lean tissue, so
 * ~7700 kcal/kg is the value used by the adaptive expenditure model.
 */
export const KCAL_PER_KG_BODY_MASS = 7700;

export const lbToKg = (lb: number) => lb * KG_PER_LB;
export const kgToLb = (kg: number) => kg / KG_PER_LB;
export const inToCm = (inches: number) => inches * CM_PER_IN;
export const cmToIn = (cm: number) => cm / CM_PER_IN;
export const kcalToKj = (kcal: number) => kcal * KJ_PER_KCAL;
export const kjToKcal = (kj: number) => kj / KJ_PER_KCAL;

export function toKg(value: number, unit: MassUnit): number {
  switch (unit) {
    case 'kg':
      return value;
    case 'lb':
      return lbToKg(value);
    case 'st':
      return lbToKg(value * 14);
  }
}

export function fromKg(kg: number, unit: MassUnit): number {
  switch (unit) {
    case 'kg':
      return kg;
    case 'lb':
      return kgToLb(kg);
    case 'st':
      return kgToLb(kg) / 14;
  }
}

export function toCm(value: number, unit: LengthUnit): number {
  switch (unit) {
    case 'cm':
      return value;
    case 'in':
      return inToCm(value);
    case 'ft':
      return inToCm(value * 12);
  }
}

/** Split centimetres into feet + inches for imperial height entry. */
export function cmToFtIn(cm: number): { ft: number; in: number } {
  const totalInches = cmToIn(cm);
  const ft = Math.floor(totalInches / 12);
  return { ft, in: Math.round((totalInches - ft * 12) * 10) / 10 };
}

/**
 * Household measures, as gram weights. Volume measures need a density to become
 * a mass, so they carry `ml` instead and are resolved against the food's own
 * density when one is known (water-like 1.0 g/ml is the fallback).
 */
export interface Measure {
  label: string;
  grams?: number;
  ml?: number;
}

export const COMMON_MEASURES: readonly Measure[] = [
  { label: 'g', grams: 1 },
  { label: 'oz', grams: 28.349523125 },
  { label: 'lb', grams: 453.59237 },
  { label: 'ml', ml: 1 },
  { label: 'fl oz (US)', ml: ML_PER_FL_OZ },
  { label: 'cup (US)', ml: ML_PER_CUP },
  { label: 'tbsp', ml: 14.7867647813 },
  { label: 'tsp', ml: 4.92892159375 },
] as const;

/** Resolve a measure to grams given the food's density in g/ml. */
export function measureToGrams(measure: Measure, densityGPerMl = 1): number {
  if (measure.grams !== undefined) return measure.grams;
  if (measure.ml !== undefined) return measure.ml * densityGPerMl;
  return 0;
}

export function formatMass(kg: number, unit: MassUnit, decimals = 1): string {
  const value = fromKg(kg, unit);
  return `${value.toFixed(decimals)} ${unit}`;
}

export function formatEnergy(kcal: number, unit: EnergyUnit = 'kcal'): string {
  const value = unit === 'kcal' ? kcal : kcalToKj(kcal);
  return `${formatCount(value)} ${unit}`;
}

/**
 * Volume for display.
 *
 * Litres with one decimal is wrong below about a litre: 250 ml renders as
 * "0.3 L", which looks like the app rounded your glass of water up by 50 ml.
 * Millilitres are exact and are how drinks are labelled anyway, so small
 * amounts stay in ml and only larger totals switch to litres.
 */
export function formatVolume(ml: number): string {
  const rounded = Math.round(ml);
  if (rounded < 1000) return `${rounded} ml`;
  const litres = rounded / 1000;
  // Two decimals only when the second one carries information.
  const text = litres.toFixed(2).replace(/0$/, '').replace(/\.$/, '');
  return `${text} L`;
}

/** Trim float noise from user-entered quantities (0.30000000000000004 → 0.3). */
export function cleanNumber(value: number, decimals = 2): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}
