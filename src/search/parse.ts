import type { Food, Portion } from '../db/schema';
import { ML_PER_CUP, ML_PER_FL_OZ } from '../core/units';
import { searchLocal, type SearchHit } from './local';

/**
 * Natural-language quick log.
 *
 * "2 eggs, 100g oats and a cup of milk" becomes three diary entries with no
 * network call, no API key and no model. It is a small deterministic grammar —
 * quantity, then unit, then the rest is the food name — resolved against the
 * local food index. Being deterministic is the feature: the same sentence always
 * produces the same entries, it works on a plane, and when it gets something
 * wrong you can see exactly which word confused it and fix that word.
 */

export interface ParsedItem {
  /** The slice of input this item came from, for highlighting. */
  raw: string;
  quantity: number;
  unit?: string;
  /** Text left over after quantity and unit — the food to look up. */
  query: string;
  /** Size adjective found in the text ("large egg"). */
  size?: 'small' | 'medium' | 'large';
  /** Resolved food, filled in by `resolveItems`. */
  match?: SearchHit;
  /** Alternative matches, offered in the confirm sheet. */
  alternatives?: SearchHit[];
  grams?: number;
  portionLabel?: string;
  /** 0–1 — how sure the resolver is. Low values get flagged for review. */
  confidence: number;
}

const WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12, couple: 2,
  half: 0.5, quarter: 0.25, few: 3,
};

const VULGAR_FRACTIONS: Record<string, number> = {
  '½': 0.5, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 0.25, '¾': 0.75,
  '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8, '⅙': 1 / 6, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
};

type UnitKind = 'mass' | 'volume' | 'count';

interface UnitDef {
  kind: UnitKind;
  /** Grams for mass units, millilitres for volume units. */
  factor: number;
  canonical: string;
}

const UNITS: Record<string, UnitDef> = {
  // Mass
  g: { kind: 'mass', factor: 1, canonical: 'g' },
  gr: { kind: 'mass', factor: 1, canonical: 'g' },
  gram: { kind: 'mass', factor: 1, canonical: 'g' },
  grams: { kind: 'mass', factor: 1, canonical: 'g' },
  kg: { kind: 'mass', factor: 1000, canonical: 'kg' },
  kilo: { kind: 'mass', factor: 1000, canonical: 'kg' },
  kilos: { kind: 'mass', factor: 1000, canonical: 'kg' },
  kilogram: { kind: 'mass', factor: 1000, canonical: 'kg' },
  kilograms: { kind: 'mass', factor: 1000, canonical: 'kg' },
  oz: { kind: 'mass', factor: 28.349523125, canonical: 'oz' },
  ounce: { kind: 'mass', factor: 28.349523125, canonical: 'oz' },
  ounces: { kind: 'mass', factor: 28.349523125, canonical: 'oz' },
  lb: { kind: 'mass', factor: 453.59237, canonical: 'lb' },
  lbs: { kind: 'mass', factor: 453.59237, canonical: 'lb' },
  pound: { kind: 'mass', factor: 453.59237, canonical: 'lb' },
  pounds: { kind: 'mass', factor: 453.59237, canonical: 'lb' },

  // Volume
  ml: { kind: 'volume', factor: 1, canonical: 'ml' },
  l: { kind: 'volume', factor: 1000, canonical: 'l' },
  litre: { kind: 'volume', factor: 1000, canonical: 'l' },
  litres: { kind: 'volume', factor: 1000, canonical: 'l' },
  liter: { kind: 'volume', factor: 1000, canonical: 'l' },
  liters: { kind: 'volume', factor: 1000, canonical: 'l' },
  cup: { kind: 'volume', factor: ML_PER_CUP, canonical: 'cup' },
  cups: { kind: 'volume', factor: ML_PER_CUP, canonical: 'cup' },
  tbsp: { kind: 'volume', factor: 14.7867647813, canonical: 'tbsp' },
  tablespoon: { kind: 'volume', factor: 14.7867647813, canonical: 'tbsp' },
  tablespoons: { kind: 'volume', factor: 14.7867647813, canonical: 'tbsp' },
  tsp: { kind: 'volume', factor: 4.92892159375, canonical: 'tsp' },
  teaspoon: { kind: 'volume', factor: 4.92892159375, canonical: 'tsp' },
  teaspoons: { kind: 'volume', factor: 4.92892159375, canonical: 'tsp' },
  'fl oz': { kind: 'volume', factor: ML_PER_FL_OZ, canonical: 'fl oz' },
  shot: { kind: 'volume', factor: 44.36, canonical: 'shot' },

  // Countable portions — resolved against the food's own portion list.
  slice: { kind: 'count', factor: 1, canonical: 'slice' },
  slices: { kind: 'count', factor: 1, canonical: 'slice' },
  piece: { kind: 'count', factor: 1, canonical: 'piece' },
  pieces: { kind: 'count', factor: 1, canonical: 'piece' },
  serving: { kind: 'count', factor: 1, canonical: 'serving' },
  servings: { kind: 'count', factor: 1, canonical: 'serving' },
  scoop: { kind: 'count', factor: 1, canonical: 'scoop' },
  scoops: { kind: 'count', factor: 1, canonical: 'scoop' },
  handful: { kind: 'count', factor: 1, canonical: 'handful' },
  bar: { kind: 'count', factor: 1, canonical: 'bar' },
  bars: { kind: 'count', factor: 1, canonical: 'bar' },
  can: { kind: 'count', factor: 1, canonical: 'can' },
  cans: { kind: 'count', factor: 1, canonical: 'can' },
  bottle: { kind: 'count', factor: 1, canonical: 'bottle' },
  bottles: { kind: 'count', factor: 1, canonical: 'bottle' },
  packet: { kind: 'count', factor: 1, canonical: 'packet' },
  packets: { kind: 'count', factor: 1, canonical: 'packet' },
  pack: { kind: 'count', factor: 1, canonical: 'pack' },
  square: { kind: 'count', factor: 1, canonical: 'square' },
  squares: { kind: 'count', factor: 1, canonical: 'square' },
};

const SIZES: Record<string, 'small' | 'medium' | 'large'> = {
  small: 'small', sml: 'small', little: 'small', mini: 'small',
  medium: 'medium', med: 'medium', regular: 'medium', standard: 'medium',
  large: 'large', lrg: 'large', big: 'large', xl: 'large', jumbo: 'large',
};

/** Dropped before lookup — they carry no information about which food it is. */
const FILLER = new Set(['of', 'the', 'some', 'my', 'a', 'an', 'with', 'plus', 'and']);

/**
 * Household weights for countable foods, in grams.
 *
 * Needed because most database records carry no portion data at all — USDA
 * Foundation entries in particular are pure per-100 g analyses. Without this,
 * "3 slices of cheddar" resolves to three times 100 g, which is not a mistake a
 * user will notice until their day is 900 kcal over. Values follow the standard
 * USDA household measures.
 */
const COUNT_GRAMS: { match: RegExp; unit?: RegExp; grams: number }[] = [
  { match: /\begg white/, grams: 33 },
  { match: /\begg yolk|\byolk/, grams: 17 },
  { match: /\begg/, grams: 50 },
  { match: /\bbread|\btoast|\bbagel/, unit: /slice/, grams: 28 },
  { match: /\bbagel/, grams: 98 },
  { match: /\bcheese|cheddar|mozzarella|gouda|swiss/, unit: /slice/, grams: 21 },
  { match: /\bbacon/, unit: /slice|rasher/, grams: 12 },
  { match: /\bpizza/, unit: /slice/, grams: 107 },
  { match: /\bbanana/, grams: 118 },
  { match: /\bapple/, grams: 182 },
  { match: /\borange|\bmandarin|\bclementine/, grams: 131 },
  { match: /\bpotato/, grams: 173 },
  { match: /\btomato/, grams: 123 },
  { match: /\bonion/, grams: 110 },
  { match: /\bcarrot/, grams: 61 },
  { match: /\bavocado/, grams: 201 },
  { match: /\bgarlic/, unit: /clove/, grams: 3 },
  { match: /\btortilla|\bwrap/, grams: 45 },
  { match: /\bprotein powder|\bwhey|\bcasein/, unit: /scoop/, grams: 30 },
  { match: /\bnuts|almond|cashew|walnut|peanut/, unit: /handful/, grams: 30 },
  { match: /\bchocolate/, unit: /square/, grams: 10 },
  { match: /\brice cake|\bcracker/, grams: 9 },
  { match: /\bslice/, unit: /slice/, grams: 30 },
];

/** Generic weights for container units when the food itself is unknown. */
const CONTAINER_GRAMS: Record<string, number> = {
  can: 355,
  bottle: 500,
  bar: 45,
  packet: 30,
  pack: 30,
  handful: 30,
  scoop: 30,
  slice: 30,
  piece: 50,
  square: 10,
};

const SIZE_FACTOR: Record<NonNullable<ParsedItem['size']>, number> = {
  small: 0.75,
  medium: 1,
  large: 1.3,
};

/**
 * Best guess at the weight of one countable unit, used only when the food's own
 * portion list has nothing better to offer.
 */
function fallbackUnitGrams(query: string, unit?: string, size?: ParsedItem['size']): number | null {
  const text = query.toLowerCase();
  const canonicalUnit = unit ? (UNITS[unit]?.canonical ?? unit) : undefined;

  for (const rule of COUNT_GRAMS) {
    if (!rule.match.test(text)) continue;
    // A rule tied to a specific unit only applies when that unit was spoken —
    // "a cheese" is not "a slice of cheese".
    if (rule.unit && (!canonicalUnit || !rule.unit.test(canonicalUnit))) continue;
    return rule.grams * (size ? SIZE_FACTOR[size] : 1);
  }

  if (canonicalUnit && CONTAINER_GRAMS[canonicalUnit] !== undefined) {
    return CONTAINER_GRAMS[canonicalUnit]! * (size ? SIZE_FACTOR[size] : 1);
  }
  return null;
}

/**
 * Split free text into candidate items. Splitting on "and" is greedy here and
 * repaired later: `resolveItems` re-joins neighbours when a fragment fails to
 * resolve, so "peanut butter and jelly sandwich" survives.
 */
export function splitItems(input: string): string[] {
  return input
    .split(/\s*[,;\n]\s*|\s+\+\s+|\s+&\s+|\s+and\s+|\s+with\s+/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function parseItem(raw: string): ParsedItem {
  const words = raw.trim().split(/\s+/);
  let index = 0;
  let quantity = 1;
  let sawQuantity = false;

  // --- Quantity ---------------------------------------------------------
  const leading = words[0];
  if (leading !== undefined) {
    const numeric = parseQuantityToken(leading);
    if (numeric !== null) {
      quantity = numeric;
      sawQuantity = true;
      index = 1;
      // "1 1/2 cups" — a mixed number spelled as two tokens.
      const second = words[1];
      if (second !== undefined && Number.isInteger(quantity)) {
        const fraction = parseFractionToken(second);
        if (fraction !== null) {
          quantity += fraction;
          index = 2;
        }
      }
    }
  }

  // "100g" with no space is extremely common; peel the unit off the number.
  let unit: string | undefined;
  if (!sawQuantity && leading !== undefined) {
    const glued = /^([\d.]+)\s*([a-z]+)$/i.exec(leading);
    if (glued && glued[1] && glued[2] && UNITS[glued[2].toLowerCase()]) {
      quantity = Number(glued[1]);
      unit = glued[2].toLowerCase();
      sawQuantity = true;
      index = 1;
    }
  } else if (sawQuantity && words[index] !== undefined) {
    const glued = /^([a-z]+)$/i.exec(words[index]!);
    if (glued && glued[1] && UNITS[glued[1].toLowerCase()]) {
      unit = glued[1].toLowerCase();
      index++;
    }
  }

  // "fl oz" is the only two-word unit worth special-casing.
  if (!unit && words[index]?.toLowerCase() === 'fl' && words[index + 1]?.toLowerCase().startsWith('oz')) {
    unit = 'fl oz';
    index += 2;
  }

  // --- Size adjective ---------------------------------------------------
  let size: ParsedItem['size'];
  const sizeWord = words[index]?.toLowerCase().replace(/[^a-z]/g, '');
  if (sizeWord && SIZES[sizeWord]) {
    size = SIZES[sizeWord];
    index++;
  }

  const rest = words
    .slice(index)
    .filter((w, i) => !(i === 0 && FILLER.has(w.toLowerCase())))
    .join(' ')
    .trim();

  return {
    raw: raw.trim(),
    quantity: sawQuantity ? quantity : 1,
    unit,
    size,
    query: rest || raw.trim(),
    confidence: 0,
  };
}

function parseQuantityToken(token: string): number | null {
  const clean = token.toLowerCase().replace(/[^\w./½⅓⅔¼¾⅕⅖⅗⅘⅙⅛⅜⅝⅞]/g, '');
  if (clean === '') return null;
  if (WORD_NUMBERS[clean] !== undefined) return WORD_NUMBERS[clean]!;
  const fraction = parseFractionToken(clean);
  if (fraction !== null) return fraction;
  const numeric = Number(clean);
  return Number.isFinite(numeric) && clean !== '' ? numeric : null;
}

function parseFractionToken(token: string): number | null {
  const vulgar = VULGAR_FRACTIONS[token];
  if (vulgar !== undefined) return vulgar;
  const match = /^(\d+)\/(\d+)$/.exec(token);
  if (match && match[1] && match[2]) {
    const denominator = Number(match[2]);
    return denominator === 0 ? null : Number(match[1]) / denominator;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Pick the portion that best matches a spoken unit and size adjective. */
export function choosePortion(food: Food, unit?: string, size?: string): Portion | undefined {
  const portions = food.portions ?? [];
  if (portions.length === 0) return undefined;

  const wanted = unit ? UNITS[unit]?.canonical ?? unit : undefined;

  if (wanted) {
    const byUnit = portions.find((p) => p.label.toLowerCase().includes(wanted));
    if (byUnit) return byUnit;
  }
  if (size) {
    const bySize = portions.find((p) => p.label.toLowerCase().includes(size));
    if (bySize) return bySize;
  }
  return portions.find((p) => p.preferred) ?? portions[0];
}

export function gramsFor(item: ParsedItem, food: Food, typicalGrams?: number): { grams: number; label?: string } {
  const unitDef = item.unit ? UNITS[item.unit] : undefined;
  const density = food.densityGPerMl ?? (food.liquid ? 1 : 1);

  if (unitDef?.kind === 'mass') {
    return { grams: item.quantity * unitDef.factor, label: `${item.quantity} ${unitDef.canonical}` };
  }

  if (unitDef?.kind === 'volume') {
    // A food's own "1 cup" portion beats a generic density conversion, because
    // it accounts for how the food actually packs into the cup.
    const named = food.portions.find((p) => p.label.toLowerCase().includes(unitDef.canonical));
    if (named) return { grams: item.quantity * named.grams, label: `${item.quantity} × ${named.label}` };
    return {
      grams: item.quantity * unitDef.factor * density,
      label: `${item.quantity} ${unitDef.canonical}`,
    };
  }

  // Preference order for a countable amount: a portion the food itself defines,
  // then the amount you personally used last time, then the household-measure
  // table, and only then the generic 100 g — which is nearly always wrong for
  // anything you would count rather than weigh.
  const portion = choosePortion(food, item.unit, item.size);
  const namedPortion = portion && portion.grams !== 100 ? portion : undefined;
  if (namedPortion) {
    return { grams: item.quantity * namedPortion.grams, label: `${item.quantity} × ${namedPortion.label}` };
  }

  if (typicalGrams && typicalGrams > 0) {
    return { grams: item.quantity * typicalGrams, label: `${item.quantity} × ${Math.round(typicalGrams)} g` };
  }

  const fallback = fallbackUnitGrams(`${item.query} ${food.name}`, item.unit, item.size);
  if (fallback !== null) {
    const unitName = item.unit ? UNITS[item.unit]?.canonical ?? item.unit : 'serving';
    return { grams: item.quantity * fallback, label: `${item.quantity} × ${unitName} (${Math.round(fallback)} g)` };
  }

  if (portion) {
    return { grams: item.quantity * portion.grams, label: `${item.quantity} × ${portion.label}` };
  }
  return { grams: item.quantity * 100, label: `${item.quantity} × 100 g` };
}

export interface ResolveOptions {
  /** Extra lookup for items the local index cannot answer. */
  onlineLookup?: (query: string) => Promise<SearchHit[]>;
}

/**
 * Resolve parsed items against the food index, repairing over-eager splits.
 *
 * When a fragment resolves badly, it is re-joined with the following fragment
 * and retried; if the combined phrase scores better, the merge is kept. That is
 * what rescues "peanut butter and jelly" from being logged as peanut butter
 * plus jelly.
 */
export async function resolveItems(items: ParsedItem[], options: ResolveOptions = {}): Promise<ParsedItem[]> {
  const out: ParsedItem[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    let hits = await lookup(item.query, options);
    let chosen = item;

    const next = items[i + 1];
    if (next && (hits.length === 0 || (hits[0]?.score ?? 0) < 30)) {
      const merged = parseItem(`${item.raw} and ${next.raw}`);
      const mergedHits = await lookup(merged.query, options);
      if ((mergedHits[0]?.score ?? 0) > (hits[0]?.score ?? 0) * 1.25) {
        chosen = merged;
        hits = mergedHits;
        i++; // The next fragment was absorbed.
      }
    }

    const best = hits[0];
    if (best) {
      const { grams, label } = gramsFor(chosen, best.food, best.typicalGrams);
      out.push({
        ...chosen,
        match: best,
        alternatives: hits.slice(1, 6),
        grams,
        portionLabel: label,
        confidence: confidenceFor(hits),
      });
    } else {
      out.push({ ...chosen, confidence: 0 });
    }
  }
  return out;
}

async function lookup(query: string, options: ResolveOptions): Promise<SearchHit[]> {
  if (!query.trim()) return [];
  const local = await searchLocal(query, { limit: 8 });
  if (local.length > 0 && (local[0]?.score ?? 0) >= 30) return local;
  if (options.onlineLookup) {
    try {
      const online = await options.onlineLookup(query);
      if (online.length > 0) return [...local, ...online].sort((a, b) => b.score - a.score).slice(0, 8);
    } catch {
      // Offline or rate-limited: local results, however weak, are still better
      // than failing the whole parse.
    }
  }
  return local;
}

/**
 * Confidence is mostly about *separation*: one strong match well clear of the
 * runner-up means we picked the right food. A tie means we guessed.
 */
function confidenceFor(hits: SearchHit[]): number {
  const best = hits[0]?.score ?? 0;
  if (best <= 0) return 0;
  const runnerUp = hits[1]?.score ?? 0;
  const separation = runnerUp > 0 ? Math.min(1, (best - runnerUp) / best) : 1;
  const strength = Math.min(1, best / 80);
  return Math.round((strength * 0.6 + separation * 0.4) * 100) / 100;
}

/** One-call convenience wrapper for the quick-log box. */
export async function parseQuickLog(input: string, options: ResolveOptions = {}): Promise<ParsedItem[]> {
  return resolveItems(splitItems(input).map(parseItem), options);
}
