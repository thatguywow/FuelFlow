import { useEffect, useState } from 'react';
import { useUi } from '../state/ui';
import { parseQuickLog, type ParsedItem } from '../search';
import { searchOnline, isOnline } from '../search/off';
import { logFood } from '../db/repo';
import type { DayKey } from '../core/dates';
import { N, scaleNutrients } from '../core/nutrients';
import { Button, Card, EmptyState, Sheet, cx } from '../ui/primitives';
import { IconCheck, IconSparkle } from '../ui/icons';

const EXAMPLES = [
  '2 eggs, 60 g oats and a cup of milk',
  '150g chicken breast with 1 cup rice',
  '1 banana, 2 tbsp peanut butter',
];

/**
 * Natural-language logging.
 *
 * Type a sentence, get a reviewable list of entries. No model runs here: it is
 * a quantity/unit grammar resolved against the local food index, so it is
 * instant, offline, free, and repeatable. Every row shows what it matched and
 * how confident it is, and low-confidence rows are flagged rather than silently
 * logged — the whole point is that you can see and correct the guess.
 */
export default function QuickLog({ mealId, day }: { mealId: string; day: DayKey }) {
  const closeSheet = useUi((s) => s.closeSheet);
  const openSheet = useUi((s) => s.openSheet);
  const toast = useUi((s) => s.toast);

  const [text, setText] = useState('');
  const [items, setItems] = useState<ParsedItem[]>([]);
  const [parsing, setParsing] = useState(false);
  const [dropped, setDropped] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (text.trim().length < 2) {
      setItems([]);
      return;
    }
    let cancelled = false;
    setParsing(true);
    const timer = setTimeout(async () => {
      const parsed = await parseQuickLog(text, {
        onlineLookup: isOnline() ? (q) => searchOnline(q, { limit: 5 }) : undefined,
      });
      if (cancelled) return;
      setItems(parsed);
      setDropped(new Set());
      setParsing(false);
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text]);

  const kept = items.filter((_, index) => !dropped.has(index));
  const totalKcal = kept.reduce((sum, item) => {
    if (!item.match || !item.grams) return sum;
    return sum + (scaleNutrients(item.match.food.per100g, item.grams)[N.ENERGY] ?? 0);
  }, 0);
  const loggable = kept.filter((item) => item.match && item.grams && item.grams > 0);

  return (
    <Sheet
      open
      onClose={closeSheet}
      title="Quick log"
      footer={
        <Button
          variant="primary"
          full
          disabled={loggable.length === 0}
          onClick={async () => {
            for (const item of loggable) {
              await logFood({
                food: item.match!.food,
                day,
                mealId,
                grams: item.grams!,
                portionLabel: item.portionLabel,
                portionCount: item.quantity,
              });
            }
            closeSheet();
            toast(`Logged ${loggable.length} ${loggable.length === 1 ? 'item' : 'items'}`);
          }}
        >
          <IconCheck size={18} />
          {loggable.length === 0
            ? 'Nothing to log yet'
            : `Log ${loggable.length} ${loggable.length === 1 ? 'item' : 'items'} · ${Math.round(totalKcal)} kcal`}
        </Button>
      }
    >
      <div className="space-y-4 p-4">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={3}
          autoFocus
          placeholder="2 eggs, 60 g oats and a cup of milk"
          className="w-full resize-none rounded-2xl border border-border bg-surface-2 p-3.5 text-[15px] leading-relaxed text-text placeholder:text-faint focus:border-brand focus:outline-none"
        />

        {items.length === 0 && !parsing && (
          <EmptyState
            icon={<IconSparkle size={28} />}
            title="Write what you ate"
            detail="Amounts, units and food names in any order. Everything is matched against your own food list first, so the things you eat often resolve instantly."
            action={
              <div className="flex flex-col gap-1.5">
                {EXAMPLES.map((example) => (
                  <button
                    key={example}
                    onClick={() => setText(example)}
                    className="rounded-full bg-surface-2 px-3.5 py-1.5 text-[13px] text-dim transition-colors hover:bg-surface-3"
                  >
                    {example}
                  </button>
                ))}
              </div>
            }
          />
        )}

        {parsing && <div className="skeleton h-20 rounded-(--radius-card)" />}

        {items.map((item, index) => {
          const isDropped = dropped.has(index);
          const kcal = item.match && item.grams
            ? scaleNutrients(item.match.food.per100g, item.grams)[N.ENERGY] ?? 0
            : 0;
          const low = item.confidence < 0.45;

          return (
            <Card
              key={`${item.raw}-${index}`}
              className={cx('space-y-2', isDropped && 'opacity-40')}
            >
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] text-faint">"{item.raw}"</p>
                  {item.match ? (
                    <>
                      <p className="mt-0.5 truncate text-[15px] font-medium">{item.match.food.name}</p>
                      <p className="mt-0.5 text-[12.5px] text-dim">
                        {item.portionLabel ?? `${Math.round(item.grams ?? 0)} g`} ·{' '}
                        {Math.round(item.grams ?? 0)} g · {Math.round(kcal)} kcal
                      </p>
                    </>
                  ) : (
                    <p className="mt-0.5 text-[14px] text-warn">No match found</p>
                  )}
                </div>

                <button
                  onClick={() =>
                    setDropped((prev) => {
                      const next = new Set(prev);
                      if (next.has(index)) next.delete(index);
                      else next.add(index);
                      return next;
                    })
                  }
                  className="shrink-0 rounded-full px-2.5 py-1 text-[12px] text-faint transition-colors hover:bg-surface-2 hover:text-text"
                >
                  {isDropped ? 'Include' : 'Skip'}
                </button>
              </div>

              {low && item.match && (
                <p className="rounded-lg bg-warn/10 px-2.5 py-1.5 text-[12px] text-dim">
                  Not confident about this one — tap an alternative or open it to check.
                </p>
              )}

              {item.alternatives && item.alternatives.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {item.alternatives.slice(0, 3).map((alt) => (
                    <button
                      key={alt.food.id}
                      onClick={() =>
                        setItems((prev) =>
                          prev.map((entry, i) =>
                            i === index
                              ? {
                                  ...entry,
                                  match: alt,
                                  alternatives: [entry.match!, ...(entry.alternatives ?? [])].filter(
                                    (h) => h.food.id !== alt.food.id,
                                  ),
                                  grams: entry.grams,
                                  confidence: 1,
                                }
                              : entry,
                          ),
                        )
                      }
                      className="max-w-full truncate rounded-full bg-surface-2 px-2.5 py-1 text-[12px] text-dim transition-colors hover:bg-surface-3"
                    >
                      {alt.food.name}
                    </button>
                  ))}
                </div>
              )}

              {item.match && (
                <button
                  onClick={() =>
                    openSheet({ kind: 'food-detail', food: item.match!.food, mealId, day })
                  }
                  className="text-[12.5px] font-medium text-brand"
                >
                  Adjust amount →
                </button>
              )}
            </Card>
          );
        })}
      </div>
    </Sheet>
  );
}
