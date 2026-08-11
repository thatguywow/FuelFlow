import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useUi } from '../state/ui';
import { formatCount } from '../core/format';
import { useTargets } from '../state/useTargets';
import { saveProfile } from '../db/repo';
import { coreDataStatus, ensureCoreData, type SeedProgress } from '../db/seed';
import { exportBackup, exportCsv, importBackup, saveBlob } from '../db/backup';
import { remoteDbInfo } from '../search';
import { db } from '../db/schema';
import { toDayKey } from '../core/dates';
import { Button, Card, Divider, Field, Input, Row, SectionLabel, Segmented, Sheet, Toggle, cx } from '../ui/primitives';
import { IconBook, IconInfo, IconSettings } from '../ui/icons';

/** Settings, data management and the honest "where does this come from" page. */
export default function More() {
  const derived = useTargets();
  const openSheet = useUi((s) => s.openSheet);
  const [panel, setPanel] = useState<'none' | 'data' | 'about' | 'profile'>('none');

  if (!derived) return <div className="safe-t p-4"><div className="skeleton h-64 rounded-[--radius-card]" /></div>;
  const { profile } = derived;

  const update = (patch: Parameters<typeof saveProfile>[0]) => void saveProfile(patch);
  const setDisplay = (patch: Partial<typeof profile.display>) =>
    update({ display: { ...profile.display, ...patch } });

  return (
    <div className="safe-t space-y-5 px-4 pb-8 pt-4">
      <h1 className="text-[22px] font-semibold tracking-[-0.01em]">More</h1>

      <section>
        <SectionLabel>Targets</SectionLabel>
        <Card padded={false} className="overflow-hidden">
          <Row
            title="Goal & macros"
            detail={`${formatCount(derived.targets.energyKcal)} kcal · ${derived.targets.macros.protein}P / ${derived.targets.macros.carbs}C / ${derived.targets.macros.fat}F`}
            onClick={() => openSheet({ kind: 'goals' })}
          />
          <Divider className="ml-4" />
          <Row
            title="You"
            detail={`${profile.heightCm} cm · ${profile.sex === 'neutral' ? 'neutral reference' : profile.sex} · ${profile.activity.replace('_', ' ')}`}
            onClick={() => setPanel('profile')}
          />
        </Card>
      </section>

      <section>
        <SectionLabel>Display</SectionLabel>
        <Card className="space-y-4">
          <Field label="Theme">
            <Segmented
              value={profile.display.theme}
              onChange={(theme) => setDisplay({ theme })}
              options={[
                { value: 'system', label: 'System' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
            />
          </Field>

          <Field label="Units">
            <Segmented
              value={profile.display.unitSystem}
              onChange={(unitSystem) =>
                setDisplay({
                  unitSystem,
                  massUnit: unitSystem === 'metric' ? 'kg' : 'lb',
                  lengthUnit: unitSystem === 'metric' ? 'cm' : 'in',
                })
              }
              options={[
                { value: 'metric', label: 'Metric' },
                { value: 'imperial', label: 'Imperial' },
              ]}
            />
          </Field>

          <SettingToggle
            title="Show net carbs"
            detail="Subtracts fiber from the carbohydrate target. Useful on keto and low-carb."
            checked={profile.display.netCarbs}
            onChange={(netCarbs) => setDisplay({ netCarbs })}
          />
          <SettingToggle
            title="Hide streaks"
            detail="Turns off streak counting if it makes logging feel like an obligation."
            checked={profile.display.hideStreaks}
            onChange={(hideStreaks) => setDisplay({ hideStreaks })}
          />
          <SettingToggle
            title="Add exercise calories to my target"
            detail="Off by default. With adaptive expenditure on, your usual training is already inside the estimate, so eating workouts back a second time double-counts them."
            checked={profile.addExerciseCalories}
            onChange={(addExerciseCalories) => update({ addExerciseCalories })}
          />
        </Card>
      </section>

      <section>
        <SectionLabel>Data</SectionLabel>
        <Card padded={false} className="overflow-hidden">
          <Row title="Backup, restore & export" detail="Everything lives on this device" onClick={() => setPanel('data')} />
          <Divider className="ml-4" />
          <Row title="Food databases" detail="What is installed and where it comes from" onClick={() => setPanel('about')} />
        </Card>
      </section>

      <p className="px-1 text-center text-[11.5px] leading-relaxed text-faint">
        FuelFlow keeps everything on this device. No account, no server, nothing uploaded.
      </p>

      {panel === 'data' && <DataPanel onClose={() => setPanel('none')} />}
      {panel === 'about' && <DatabasePanel onClose={() => setPanel('none')} />}
      {panel === 'profile' && <ProfilePanel onClose={() => setPanel('none')} />}
    </div>
  );
}

function SettingToggle({
  title,
  detail,
  checked,
  onChange,
}: {
  title: string;
  detail: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-[15px]">{title}</p>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-faint">{detail}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} label={title} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function DataPanel({ onClose }: { onClose: () => void }) {
  const toast = useUi((s) => s.toast);
  const fileRef = useRef<HTMLInputElement>(null);
  const [passphrase, setPassphrase] = useState('');
  const [includeCore, setIncludeCore] = useState(false);
  const [busy, setBusy] = useState(false);

  const counts = useLiveQuery(async () => ({
    entries: await db.entries.count(),
    foods: await db.foods.count(),
    weights: await db.weights.count(),
    recipes: await db.recipes.count(),
  }));

  return (
    <Sheet open onClose={onClose} title="Your data">
      <div className="space-y-5 p-4">
        <Card className="grid grid-cols-4 gap-2 text-center">
          {[
            ['Entries', counts?.entries],
            ['Foods', counts?.foods],
            ['Weigh-ins', counts?.weights],
            ['Recipes', counts?.recipes],
          ].map(([label, value]) => (
            <div key={String(label)}>
              <div className="text-[17px] font-semibold tnum">{value ?? '—'}</div>
              <div className="text-[11px] text-faint">{label}</div>
            </div>
          ))}
        </Card>

        <section>
          <SectionLabel>Backup</SectionLabel>
          <Card className="space-y-3">
            <Field
              label="Passphrase (optional)"
              hint="Encrypts the backup with AES-256-GCM before it leaves the app. There is no recovery if you forget it — that is the point."
            >
              <Input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="Leave blank for plain JSON"
                autoComplete="new-password"
              />
            </Field>

            <SettingToggle
              title="Include the USDA food database"
              detail="Makes the file much larger. It is re-downloadable, so leaving it out is usually right."
              checked={includeCore}
              onChange={setIncludeCore}
            />

            <div className="flex gap-2">
              <Button
                variant="primary"
                className="flex-1"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const blob = await exportBackup({
                      includeCoreFoods: includeCore,
                      passphrase: passphrase || undefined,
                    });
                    await saveBlob(blob, `fuelflow-backup-${toDayKey()}.json`);
                    toast('Backup saved');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Export backup
              </Button>
              <Button
                className="flex-1"
                disabled={busy}
                onClick={async () => {
                  await saveBlob(await exportCsv(), `fuelflow-diary-${toDayKey()}.csv`);
                  toast('CSV saved');
                }}
              >
                Export CSV
              </Button>
            </div>
          </Card>
        </section>

        <section>
          <SectionLabel>Restore</SectionLabel>
          <Card className="space-y-3">
            <p className="text-[12.5px] leading-relaxed text-faint">
              Restoring merges: for every record, whichever copy was edited most recently wins.
              Importing onto a device that has kept logging will not lose anything.
            </p>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                setBusy(true);
                try {
                  const result = await importBackup(file, passphrase || undefined);
                  toast(`Restored ${result.imported} records (${result.skipped} already current)`);
                } catch (error) {
                  toast(error instanceof Error ? error.message : 'Restore failed', { tone: 'danger' });
                } finally {
                  setBusy(false);
                  event.target.value = '';
                }
              }}
            />
            <Button full disabled={busy} onClick={() => fileRef.current?.click()}>
              Choose a backup file
            </Button>
          </Card>
        </section>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------

function DatabasePanel({ onClose }: { onClose: () => void }) {
  const toast = useUi((s) => s.toast);
  const status = useLiveQuery(() => coreDataStatus(), []);
  const [progress, setProgress] = useState<SeedProgress | null>(null);
  const remote = remoteDbInfo();

  return (
    <Sheet open onClose={onClose} title="Food databases">
      <div className="space-y-5 p-4">
        <Card className="space-y-2">
          <div className="flex items-center gap-2">
            <IconBook size={17} className="text-brand" />
            <h3 className="flex-1 text-[15px] font-medium">Core foods (USDA)</h3>
            <span className="text-[12.5px] text-faint tnum">
              {status?.installed ? `${formatCount(status.count ?? 0)} foods` : 'not installed'}
            </span>
          </div>
          <p className="text-[12.5px] leading-relaxed text-faint">
            Generic whole foods with full micronutrient detail, from USDA FoodData Central. Ships
            with the app, lives on your device, works with no connection at all.
          </p>
          {progress && progress.phase === 'installing' && (
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full bg-brand transition-[width]"
                style={{ width: `${(progress.loaded / Math.max(1, progress.total)) * 100}%` }}
              />
            </div>
          )}
          {progress?.phase === 'unavailable' && (
            <p className="rounded-lg bg-warn/10 px-3 py-2 text-[12.5px] text-dim">{progress.message}</p>
          )}
          <Button
            size="sm"
            onClick={async () => {
              const written = await ensureCoreData(setProgress, { force: true });
              if (written > 0) toast(`Installed ${formatCount(written)} foods`);
            }}
          >
            {status?.installed ? 'Reinstall' : 'Install'}
          </Button>
        </Card>

        <Card className="space-y-2.5">
          <div className="flex items-center gap-2">
            <IconSettings size={17} className="text-brand" />
            <h3 className="flex-1 text-[15px] font-medium">Hosted database</h3>
            <span className="text-[12.5px] text-faint">
              {remote ? remote.version : 'not reachable'}
            </span>
          </div>
          <p className="text-[12.5px] leading-relaxed text-faint">
            Open Food Facts and USDA in one SQLite file served as static files. FuelFlow reads it
            over HTTP range requests, pulling only the few kilobytes of database pages a lookup
            actually touches — no server, no API key, no rate limit. Because of that, a lookup costs
            the same whether the file holds two hundred thousand products or four million.
          </p>

          {remote?.breakdown && (
            <div className="grid grid-cols-3 gap-2 pt-1 text-center">
              {[
                ['Open Food Facts', remote.breakdown.off],
                ['USDA branded', remote.breakdown.usdaBranded],
                ['USDA generic', remote.breakdown.usdaGeneric],
              ].map(([label, count]) => (
                <div key={String(label)} className="rounded-xl bg-surface-2 py-2">
                  <div className="text-[15px] font-semibold tnum">
                    {formatCount(Number(count))}
                  </div>
                  <div className="text-[10.5px] leading-tight text-faint">{label}</div>
                </div>
              ))}
            </div>
          )}

          {remote && (
            <p className="text-[11.5px] text-faint">
              {formatCount(remote.productCount)} products · coverage: {remote.scope ?? 'global'}
            </p>
          )}
        </Card>

        <Card className="space-y-2">
          <div className="flex items-center gap-2">
            <IconInfo size={17} className="text-brand" />
            <h3 className="flex-1 text-[15px] font-medium">Open Food Facts</h3>
          </div>
          <p className="text-[12.5px] leading-relaxed text-faint">
            The live fallback, used only for products newer than the snapshot. Anything it returns is
            saved to your device, so each product is fetched at most once. Crowd-sourced data —
            worth a glance at the label if a number looks wrong.
          </p>
        </Card>

        <p className="px-1 text-[11.5px] leading-relaxed text-faint">
          USDA FoodData Central is public domain. Open Food Facts data is licensed under the Open
          Database License; product names and brands remain the property of their owners.
        </p>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------

function ProfilePanel({ onClose }: { onClose: () => void }) {
  const derived = useTargets();
  // Same reason as the goals editor: the fields seed from saved values, so the
  // form must not mount before the live query has produced them.
  if (!derived) return null;
  return <ProfileForm profile={derived.profile} onClose={onClose} />;
}

function ProfileForm({
  profile,
  onClose,
}: {
  profile: NonNullable<ReturnType<typeof useTargets>>['profile'];
  onClose: () => void;
}) {
  const toast = useUi((s) => s.toast);
  const [height, setHeight] = useState(String(profile.heightCm));
  const [birthYear, setBirthYear] = useState(String(profile.birthYear ?? ''));

  return (
    <Sheet
      open
      onClose={onClose}
      title="You"
      footer={
        <Button
          variant="primary"
          full
          onClick={async () => {
            await saveProfile({
              heightCm: Number(height) || profile.heightCm,
              birthYear: Number(birthYear) || undefined,
            });
            onClose();
            toast('Saved');
          }}
        >
          Save
        </Button>
      }
    >
      <div className="space-y-4 p-4">
        <Field label="Height (cm)">
          <Input type="number" inputMode="numeric" value={height} onChange={(e) => setHeight(e.target.value)} />
        </Field>
        <Field label="Year of birth" hint="Used by the resting-rate equations and by age-banded nutrient targets.">
          <Input type="number" inputMode="numeric" value={birthYear} onChange={(e) => setBirthYear(e.target.value)} placeholder="1990" />
        </Field>

        <Field
          label="Reference sex"
          hint="A physiology input for metabolic equations and nutrient reference intakes, not an identity field. Neutral averages the male and female reference sets."
        >
          <Segmented
            value={profile.sex}
            onChange={(sex) => void saveProfile({ sex })}
            options={[
              { value: 'female', label: 'Female' },
              { value: 'male', label: 'Male' },
              { value: 'neutral', label: 'Neutral' },
            ]}
          />
        </Field>

        <Field label="Activity outside deliberate exercise">
          <div className="space-y-1.5">
            {(['sedentary', 'light', 'moderate', 'active', 'very_active'] as const).map((level) => (
              <button
                key={level}
                onClick={() => void saveProfile({ activity: level })}
                className={cx(
                  'w-full rounded-xl border p-3 text-left text-[14px] transition-colors',
                  profile.activity === level
                    ? 'border-brand bg-brand-soft/40'
                    : 'border-border bg-surface hover:bg-surface-2',
                )}
              >
                {level.replace('_', ' ')}
              </button>
            ))}
          </div>
        </Field>
      </div>
    </Sheet>
  );
}
