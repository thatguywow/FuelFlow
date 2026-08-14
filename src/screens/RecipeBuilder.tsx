import { useEffect, useMemo, useState } from 'react';
import { useUi } from '../state/ui';
import { useTargets } from '../state/useTargets';
import { searchTiered, type SearchHit } from '../search';
import { newId, type Recipe, type RecipeIngredient } from '../db/schema';
import { db } from '../db/schema';
import { recipeNutrition, saveRecipe } from '../db/repo';
import { N, scaleNutrients } from '../core/nutrients';
import { formatCount } from '../core/format';
import { displayName } from '../core/foodName';
import { formatFoodMass } from '../core/units';
import { Button, Card, Divider, EmptyState, Field, Input, List, SectionLabel, Sheet, cx } from '../ui/primitives';
import { IconBook, IconPlus, IconSearch, IconTrash } from '../ui/icons';

/**
 * Recipe builder.
 *
 * A `recipes` filter and a `recipe-builder` sheet kind both existed already,
 * with nothing behind either — so the tab was permanently empty and the only
 * way to record something you cook was to save the meal you had just eaten.
 * That is a different thing: a meal template repeats one day's entries, a
 * recipe is a food, with a weight and a nutrient density, that can be logged in
 * any portion on any day.
 *
 * Saving mirrors it into `foods` (source `recipe`), which is what makes it
 * searchable, loggable, and usable as an ingredient in another recipe.
 */
export default function RecipeBuilder({ recipeId }: { recipeId?: string }) {
  // Steps back rather than dismissing everything: this is usually opened from
  // the library, and saving a recipe only to be dropped onto the home screen
  // hides the very list the recipe was just added to.
  const backSheet = useUi((s) => s.backSheet);
  const toast = useUi((s) => s.toast);
  const unitSystem = useTargets()?.profile.display.unitSystem ?? 'metric';

  const [loaded, setLoaded] = useState(!recipeId);
  const [name, setName] = useState('');
  const [servings, setServings] = useState('4');
  const [finalWeight, setFinalWeight] = useState('');
  const [ingredients, setIngredients] = useState<RecipeIngredient[]>([]);
  const [saving, setSaving] = useState(false);

  // Editing an existing recipe seeds the form once. A live query would fight
  // the fields the moment the mirrored food is written back on save.
  useEffect(() => {
    if (!recipeId) return;
    let cancelled = false;
    void db.recipes.get(recipeId).then((recipe) => {
      if (cancelled || !recipe) {
        setLoaded(true);
        return;
      }
      setName(recipe.name);
      setServings(String(recipe.servings));
      setFinalWeight(recipe.finalWeightG ? String(recipe.finalWeightG) : '');
      setIngredients(recipe.ingredients);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [recipeId]);

  const draft: Recipe = useMemo(
    () => ({
      id: recipeId ?? 'draft',
      name: name.trim(),
      servings: Math.max(1, Number(servings) || 1),
      ingredients,
      finalWeightG: Number(finalWeight) || undefined,
      createdAt: 0,
      updatedAt: 0,
    }),
    [recipeId, name, servings, ingredients, finalWeight],
  );

  const totals = useMemo(() => recipeNutrition(draft), [draft]);
  const rawGrams = ingredients.reduce((sum, item) => sum + item.grams, 0);
  const valid = name.trim().length > 0 && ingredients.length > 0;

  const setGrams = (index: number, grams: number) =>
    setIngredients((prev) =>
      prev.map((item, i) =>
        i === index
          ? {
              ...item,
              grams,
              // Nutrition is stored absolute per ingredient, so changing the
              // amount has to rescale it — from the ratio, since the per-100 g
              // figures are not kept on the ingredient row.
              nutrients:
                item.grams > 0
                  ? scaleNutrients(item.nutrients, (grams / item.grams) * 100)
                  : item.nutrients,
            }
          : item,
      ),
    );

  return (
    <Sheet
      open
      onClose={backSheet}
      title={recipeId ? 'Edit recipe' : 'New recipe'}
      footer={
        <Button
          variant="primary"
          full
          disabled={!valid || saving}
          onClick={async () => {
            setSaving(true);
            try {
              const ts = Date.now();
              await saveRecipe({
                ...draft,
                id: recipeId ?? newId(),
                createdAt: ts,
                updatedAt: ts,
              });
              backSheet();
              toast(`${draft.name} saved — find it under Recipes`);
            } finally {
              setSaving(false);
            }
          }}
        >
          {valid
            ? `Save · ${formatCount(totals.perServing[N.ENERGY] ?? 0)} kcal per serving`
            : 'Name it and add an ingredient'}
        </Button>
      }
    >
      {!loaded ? (
        <div className="p-4">
          <div className="skeleton h-40 rounded-(--radius-card)" />
        </div>
      ) : (
        <div className="space-y-4 p-4">
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Sunday chilli" />
            </Field>
            <Field label="Servings">
              <div className="w-24">
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={servings}
                  onChange={(e) => setServings(e.target.value)}
                  className="text-center"
                  aria-label="Servings"
                />
              </div>
            </Field>
          </div>

          {/* ---------- What is in it ---------- */}
          <section>
            <SectionLabel
              action={
                ingredients.length > 0 ? (
                  <span className="text-[12px] text-faint tnum">
                    {formatFoodMass(rawGrams, unitSystem)} raw
                  </span>
                ) : undefined
              }
            >
              Ingredients
            </SectionLabel>

            {ingredients.length === 0 ? (
              <EmptyState
                icon={<IconBook size={26} />}
                title="Nothing added yet"
                detail="Search below for each ingredient and give the weight you actually used."
              />
            ) : (
              <List>
                {ingredients.map((item, index) => (
                  <div key={`${item.foodId}-${index}`}>
                    {index > 0 && <Divider className="ml-4" />}
                    <div className="flex items-center gap-2 px-3.5 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[14px]">{displayName(item.name).primary}</div>
                        <div className="mt-0.5 text-[11.5px] text-faint tnum">
                          {formatCount(item.nutrients[N.ENERGY] ?? 0)} kcal
                        </div>
                      </div>
                      {/* Same lesson as the portion picker: the width goes on a
                          wrapper, because Input carries w-full in its own base
                          classes and beats anything passed through className. */}
                      <div className="w-20 shrink-0">
                        <Input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          value={String(item.grams)}
                          onChange={(e) => setGrams(index, Number(e.target.value) || 0)}
                          className="h-9 text-center text-[14px]"
                          aria-label={`Grams of ${item.name}`}
                        />
                      </div>
                      <span className="shrink-0 text-[12px] text-faint">g</span>
                      <button
                        onClick={() => setIngredients((prev) => prev.filter((_, i) => i !== index))}
                        aria-label={`Remove ${item.name}`}
                        className="shrink-0 rounded-lg p-2 text-faint transition-colors hover:bg-surface-2 hover:text-danger"
                      >
                        <IconTrash size={16} />
                      </button>
                    </div>
                  </div>
                ))}
              </List>
            )}
          </section>

          <IngredientPicker
            onPick={(hit) => {
              const grams = hit.suggestedGrams ?? preferredGrams(hit) ?? 100;
              setIngredients((prev) => [
                ...prev,
                {
                  foodId: hit.food.id,
                  name: hit.food.name,
                  grams,
                  portionLabel: hit.food.portions.find((p) => p.preferred)?.label,
                  nutrients: scaleNutrients(hit.food.per100g, grams),
                },
              ]);
            }}
          />

          {/* ---------- Yield ---------- */}
          {ingredients.length > 0 && (
            <Card className="space-y-3">
              {/* The heading carries "per serving" so all four labels stay one
                  word — a label that wraps makes one column taller than its
                  neighbours and the row stops reading as a set. */}
              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-faint">
                  Per serving
                </div>
                <div className="grid grid-cols-4 gap-2 text-center">
                  <Total label="Energy" value={formatCount(totals.perServing[N.ENERGY] ?? 0)} unit="kcal" />
                  <Total label="Protein" value={formatCount(totals.perServing[N.PROTEIN] ?? 0)} unit="g" />
                  <Total label="Carbs" value={formatCount(totals.perServing[N.CARBS] ?? 0)} unit="g" />
                  <Total label="Fat" value={formatCount(totals.perServing[N.FAT] ?? 0)} unit="g" />
                </div>
              </div>

              <Field
                label="Cooked weight (optional)"
                hint="Cooking drives off water. Weigh the finished dish and the per-100 g figures are computed against that instead of the raw total, which is what makes logging a portion by weight correct."
              >
                <Input
                  type="number"
                  inputMode="decimal"
                  value={finalWeight}
                  onChange={(e) => setFinalWeight(e.target.value)}
                  placeholder={String(Math.round(rawGrams))}
                />
              </Field>

              <p className="text-[11.5px] leading-relaxed text-faint">
                {formatFoodMass(totals.totalGrams, unitSystem)} total ·{' '}
                {formatFoodMass(totals.totalGrams / Math.max(1, draft.servings), unitSystem)} per serving
              </p>
            </Card>
          )}
        </div>
      )}
    </Sheet>
  );
}

function preferredGrams(hit: SearchHit): number | undefined {
  return hit.food.portions.find((p) => p.preferred)?.grams ?? hit.food.portions[0]?.grams;
}

function Total({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div>
      <div className="text-[17px] font-semibold tnum">{value}</div>
      <div className="text-[10px] uppercase tracking-[0.06em] text-faint">
        {label} · {unit}
      </div>
    </div>
  );
}

/**
 * Inline search, rather than pushing the full food sheet.
 *
 * Building a recipe is a loop — find, weigh, repeat — and a stack of sheets
 * that has to be climbed back down between every ingredient makes a five-item
 * recipe feel like fifteen steps.
 */
function IngredientPicker({ onPick }: { onPick: (hit: SearchHit) => void }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);

  useEffect(() => {
    if (query.trim().length === 0) {
      setHits([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void searchTiered(
        query,
        (result) => {
          if (!controller.signal.aborted) setHits(result.hits.slice(0, 8));
        },
        { signal: controller.signal },
      ).catch(() => undefined);
    }, 180);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query]);

  return (
    <section>
      <SectionLabel>Add an ingredient</SectionLabel>
      <div className="relative">
        <IconSearch
          size={16}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search foods"
          className="pl-9"
          inputMode="search"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      {hits.length > 0 && (
        <List className="mt-2">
          {hits.map((hit, index) => (
            <div key={hit.food.id}>
              {index > 0 && <Divider className="ml-4" />}
              <button
                onClick={() => {
                  onPick(hit);
                  setQuery('');
                  setHits([]);
                }}
                className={cx(
                  'flex w-full items-center gap-3 px-3.5 py-2.5 text-left',
                  'transition-colors hover:bg-surface-2 active:bg-surface-3',
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px]">{displayName(hit.food.name).primary}</div>
                  <div className="mt-0.5 truncate text-[11.5px] text-faint">
                    {[hit.food.brand, `${formatCount(hit.food.per100g[N.ENERGY] ?? 0)} kcal / 100 g`]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
                <IconPlus size={16} className="shrink-0 text-brand" />
              </button>
            </div>
          ))}
        </List>
      )}
    </section>
  );
}
