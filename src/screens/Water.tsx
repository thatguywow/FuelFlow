import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useUi } from '../state/ui';
import { useTargets } from '../state/useTargets';
import { addWater, deleteWater, saveProfile, waterEntriesForDay } from '../db/repo';
import { formatVolume } from '../core/units';
import { formatTime, type DayKey } from '../core/dates';
import { N } from '../core/nutrients';
import { Button, Card, EmptyState, IconButton, Input, List, Sheet, cx } from '../ui/primitives';
import { useAnimatedNumber, tapFeedback } from '../ui/motion';
import { IconDroplet, IconPlus, IconTrash } from '../ui/icons';

/** Common glass and bottle sizes, so the usual amount is one tap. */
const PRESETS = [200, 250, 330, 500, 750];

/** Round daily goals people actually pick. */
const GOAL_PRESETS = [1500, 2000, 2500, 3000, 3500];

/**
 * Water for a day: the running total, one-tap amounts, and every individual
 * drink so a mistaken tap can actually be undone. Previously water could only
 * ever be added — there was no way to see or correct what had been logged.
 */
export default function Water({ day }: { day: DayKey }) {
  const closeSheet = useUi((s) => s.closeSheet);
  const toast = useUi((s) => s.toast);
  const derived = useTargets();
  const [custom, setCustom] = useState('');
  const [editingGoal, setEditingGoal] = useState(false);
  const [goalDraft, setGoalDraft] = useState('');

  const saveGoal = async (ml: number) => {
    if (!(ml >= 250)) return;
    await saveProfile({ waterTargetMl: Math.round(ml) });
    setEditingGoal(false);
    setGoalDraft('');
    toast(`Daily goal set to ${formatVolume(ml)}`);
  };

  const entries = useLiveQuery(() => waterEntriesForDay(day), [day], []);
  const total = entries.reduce((sum, entry) => sum + entry.ml, 0);
  const target = derived?.nutrientTargets.get(N.WATER)?.target ?? 3000;

  const shown = useAnimatedNumber(total, { duration: 550 });
  const ratio = target > 0 ? Math.min(1, total / target) : 0;
  const width = useAnimatedNumber(ratio * 100, { duration: 600, epsilon: 0.2 });

  const log = async (ml: number) => {
    if (ml <= 0) return;
    await addWater(day, ml);
    void tapFeedback();
  };

  return (
    <Sheet open onClose={closeSheet} title="Water">
      <div className="space-y-5 p-4">
        <Card className="space-y-3">
          <div className="flex items-baseline justify-between">
            <div className="flex items-baseline gap-2">
              <span className="text-[32px] font-semibold leading-none tnum">
                {formatVolume(shown)}
              </span>
            </div>
            <span className="text-[12.5px] text-faint tnum">of {formatVolume(target)}</span>
          </div>
          <div
            className="h-2 overflow-hidden rounded-full bg-surface-2"
            style={{ boxShadow: 'inset 0 1px 2px rgb(0 0 0 / 0.25)' }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${width}%`,
                background: 'var(--color-brand)',
                boxShadow: '0 0 10px -1px var(--color-brand)',
              }}
            />
          </div>
          <button
            onClick={() => setEditingGoal((v) => !v)}
            className="text-[12.5px] font-semibold text-brand"
          >
            {editingGoal ? 'Cancel' : 'Change daily goal'}
          </button>

          {editingGoal && (
            <div className="space-y-2 border-t border-border pt-3">
              <div className="flex flex-wrap gap-1.5">
                {GOAL_PRESETS.map((ml) => (
                  <button
                    key={ml}
                    onClick={() => void saveGoal(ml)}
                    className={cx(
                      'rounded-full px-3 py-1.5 text-[12.5px] transition-colors',
                      target === ml
                        ? 'brand-gradient font-medium text-brand-contrast'
                        : 'bg-surface-2 text-dim hover:bg-surface-3',
                    )}
                  >
                    {formatVolume(ml)}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  type="number"
                  inputMode="numeric"
                  value={goalDraft}
                  onChange={(event) => setGoalDraft(event.target.value)}
                  placeholder="Your own goal, in ml"
                />
                <Button
                  variant="primary"
                  disabled={!(Number(goalDraft) >= 250)}
                  onClick={() => void saveGoal(Number(goalDraft))}
                >
                  Set
                </Button>
              </div>
              <p className="text-[11.5px] leading-relaxed text-faint">
                The default comes from the reference intake for total water, which counts moisture
                from food too — so it is deliberately higher than a drinking target.
              </p>
            </div>
          )}
        </Card>

        <section>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {PRESETS.map((ml) => (
              <button
                key={ml}
                onClick={() => void log(ml)}
                className="flex-1 rounded-[--radius-input] border border-border bg-surface-2 px-2 py-2.5 text-[13px] font-medium transition-colors hover:border-brand/40 hover:bg-brand-soft active:scale-[0.97]"
              >
                +{ml}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              type="number"
              inputMode="numeric"
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
              placeholder="Another amount, in ml"
            />
            <Button
              variant="primary"
              disabled={!(Number(custom) > 0)}
              onClick={async () => {
                await log(Number(custom));
                setCustom('');
              }}
            >
              <IconPlus size={17} />
            </Button>
          </div>
        </section>

        <section>
          <div className="mb-2 px-1.5 text-[11px] font-semibold uppercase tracking-[0.11em] text-faint">
            Today's drinks
          </div>
          {entries.length === 0 ? (
            <EmptyState
              icon={<IconDroplet size={22} />}
              title="Nothing logged yet"
              detail="Tap an amount above and it appears here, where you can remove it again."
            />
          ) : (
            <List>
              {entries.map((entry) => (
                <div key={entry.id} className="flex items-center gap-3 px-4 py-2.5">
                  <IconDroplet size={16} className="shrink-0 text-brand" />
                  <span className="flex-1 text-[14.5px] font-medium tnum">
                    {formatVolume(entry.ml)}
                  </span>
                  <span className="text-[12px] text-faint tnum">{formatTime(entry.loggedAt)}</span>
                  <IconButton
                    label={`Remove ${formatVolume(entry.ml)}`}
                    onClick={async () => {
                      await deleteWater(entry.id);
                      toast('Removed');
                    }}
                  >
                    <IconTrash size={15} />
                  </IconButton>
                </div>
              ))}
            </List>
          )}
        </section>
      </div>
    </Sheet>
  );
}
