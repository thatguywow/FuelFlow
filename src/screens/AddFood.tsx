import { useEffect, useMemo, useRef, useState } from 'react';
import { useUi } from '../state/ui';
import { searchTiered, suggestionsForMeal, type SearchHit } from '../search';
import type { DayKey } from '../core/dates';
import { N } from '../core/nutrients';
import { Button, EmptyState, Input, List, SectionLabel, Segmented, Sheet, cx } from '../ui/primitives';
import { IconPlus, IconSearch } from '../ui/icons';
import { formatCount } from '../core/format';
import type { FoodSource } from '../db/schema';

/** Provenance colours for the leading dot on each result. */
const TIER_COLOR: Record<SearchHit['tier'], string> = {
  personal: 'var(--color-brand)',
  core: 'var(--color-fiber)',
  remote: 'var(--color-fat)',
  online: 'var(--color-faint)',
};

type Filter = 'all' | 'mine' | 'recipes';

const FILTER_SOURCES: Record<Filter, FoodSource[] | undefined> = {
  all: undefined,
  mine: ['user', 'label'],
  recipes: ['recipe'],
};

/**
 * Food search sheet.
 *
 * Results stream in tiers: local hits render on the first keystroke, then the
 * remote snapshot and the live API merge in behind them. Typing never blocks on
 * a network request, and with no query at all this shows the foods you actually
 * eat at this time of day.
 */
export default function AddFood({ mealId, day }: { mealId: string; day: DayKey }) {
  const closeSheet = useUi((s) => s.closeSheet);
  const openSheet = useUi((s) => s.openSheet);

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [pending, setPending] = useState(false);
  const [suggestions, setSuggestions] = useState<SearchHit[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void suggestionsForMeal(mealId).then(setSuggestions);
    // Autofocus is deliberate here: opening this sheet is always an explicit
    // "I want to add something" action.
    const timer = setTimeout(() => inputRef.current?.focus(), 250);
    return () => clearTimeout(timer);
  }, [mealId]);

  useEffect(() => {
    const controller = new AbortController();
    // Debounce so a fast typist fires one search, not eight.
    const timer = setTimeout(() => {
      setPending(true);
      void searchTiered(
        query,
        (result) => {
          if (controller.signal.aborted) return;
          setHits(result.hits);
          setPending(result.pending);
        },
        { sources: FILTER_SOURCES[filter], signal: controller.signal },
      ).finally(() => {
        if (!controller.signal.aborted) setPending(false);
      });
    }, query.length === 0 ? 0 : 180);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, filter]);

  const shown = query.trim().length === 0 && hits.length === 0 ? suggestions : hits;

  const grouped = useMemo(() => {
    const order: SearchHit['tier'][] = ['personal', 'core', 'remote', 'online'];
    // Named by where the data actually comes from. "Generic foods" and
    // "Branded database" said nothing about provenance, and two of these tiers
    // are both Open Food Facts — one a snapshot on the device, one the live
    // API — which is impossible to tell apart from the old labels.
    const labels: Record<SearchHit['tier'], string> = {
      personal: 'Your foods',
      core: 'Generic foods · USDA',
      remote: 'Packaged foods · on this device',
      online: 'Packaged foods · Open Food Facts',
    };
    return order
      .map((tier) => ({ tier, label: labels[tier], items: shown.filter((h) => h.tier === tier) }))
      .filter((group) => group.items.length > 0);
  }, [shown]);

  return (
    <Sheet
      open
      onClose={closeSheet}
      title={
        <div className="flex items-center gap-2">
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search foods, brands or a barcode"
            className="h-10"
            inputMode="search"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      }
      footer={
        // Scanning and describing a meal now live in the central add menu, so
        // repeating them here was just noise. What is genuinely missing at this
        // point is the food you searched for and could not find.
        <Button
          variant="secondary"
          full
          onClick={() => openSheet({ kind: 'create-food', mealId, day })}
        >
          <IconPlus size={17} />
          Create a custom food
        </Button>
      }
    >
      <div className="sticky top-0 z-10 bg-bg-elevated px-4 py-2.5">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'mine', label: 'My foods' },
            { value: 'recipes', label: 'Recipes' },
          ]}
        />
      </div>

      {grouped.length === 0 && !pending && (
        <EmptyState
          icon={<IconSearch size={30} />}
          title={query ? 'Nothing found' : 'Start typing'}
          detail={
            query
              ? 'Try fewer words, or add it as a custom food so it is there next time.'
              : 'Foods you log show up here automatically, ranked by how often and how recently you eat them.'
          }
          action={
            query ? (
              <Button onClick={() => openSheet({ kind: 'create-food', mealId, day })}>
                Create "{query.slice(0, 24)}"
              </Button>
            ) : undefined
          }
        />
      )}

      <div className="space-y-4 px-4 pb-4">
        {grouped.map((group) => (
          <section key={group.tier}>
            <SectionLabel>{group.label}</SectionLabel>
            <List>
              {group.items.map((hit) => (
                <button
                  key={hit.food.id}
                  onClick={() => openSheet({ kind: 'food-detail', food: hit.food, mealId, day })}
                  className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-surface-2 active:bg-surface-3"
                >
                  {/* Provenance dot. Tells you at a glance whether a result is
                      something you have eaten, curated reference data, or a
                      stranger's crowd-sourced entry. */}
                  <span
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ background: TIER_COLOR[hit.tier] }}
                    title={group.label}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14.5px]">{hit.food.name}</div>
                    <div className="mt-0.5 truncate text-[12px] text-faint">
                      {[hit.food.brand, hit.suggestedGrams ? `${Math.round(hit.suggestedGrams)} g` : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-[14.5px] font-semibold tnum">
                      {formatCount(
                        ((hit.food.per100g[N.ENERGY] ?? 0) * (hit.suggestedGrams ?? 100)) / 100,
                      )}
                    </div>
                    <div className="text-[9.5px] font-medium uppercase tracking-[0.08em] text-faint">
                      kcal
                    </div>
                  </div>
                </button>
              ))}
            </List>
          </section>
        ))}

        {pending && (
          <div className="flex items-center justify-center gap-2 px-4 py-4 text-[12.5px] text-faint">
            <span className={cx('size-1.5 animate-pulse rounded-full bg-brand')} />
            Searching the branded database and Open Food Facts…
          </div>
        )}
      </div>
    </Sheet>
  );
}
