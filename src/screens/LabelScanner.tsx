import { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { useUi } from '../state/ui';
import { logFood, upsertFood } from '../db/repo';
import {
  CameraDeniedError,
  captureFrame,
  openAppSettings,
  openCameraPreview,
  parseNutritionLabel,
  recognizeLabelFromDataUrl,
  recognizeLabelText,
  type ParsedLabel,
  type ScannerHandle,
} from '../scan/barcode';
import { N } from '../core/nutrients';
import { formatCount } from '../core/format';
import type { DayKey } from '../core/dates';
import { Button, Card, EmptyState, Field, Input, Sheet, Toggle, cx } from '../ui/primitives';
import { MealPicker } from './Sheets';
import { IconLabel, IconCheck, IconClose, IconFlash } from '../ui/icons';

type Basis = '100g' | 'serving';

/** Fixed key set so indexing stays type-safe under noUncheckedIndexedAccess. */
type LabelField = 'kcal' | 'protein' | 'carbs' | 'fat' | 'fiber' | 'sugar' | 'satFat' | 'sodium';

const LABEL_FIELDS: { key: LabelField; label: string }[] = [
  { key: 'kcal', label: 'Calories' },
  { key: 'protein', label: 'Protein (g)' },
  { key: 'carbs', label: 'Carbs (g)' },
  { key: 'fat', label: 'Fat (g)' },
  { key: 'fiber', label: 'Fiber (g)' },
  { key: 'sugar', label: 'Sugars (g)' },
  { key: 'satFat', label: 'Sat. fat (g)' },
  { key: 'sodium', label: 'Sodium (mg)' },
];

const EMPTY_VALUES: Record<LabelField, string> = {
  kcal: '', protein: '', carbs: '', fat: '', fiber: '', sugar: '', satFat: '', sodium: '',
};

/**
 * Nutrition-label scanner.
 *
 * Photographs a label, reads it on-device with ML Kit, and pre-fills the fields
 * it could parse. Everything stays editable, and anything it could not read
 * confidently is left blank rather than guessed — a wrong number entered
 * silently is far worse than an empty box.
 *
 * The result can be logged once and forgotten, or saved as a reusable food. Own
 * cooking and market produce have no barcode, so this is often the only way
 * those ever get into the database.
 *
 * Recognition is native-only: the web build would need a multi-megabyte model
 * or would have to send photographs of your food to somebody else's server.
 * There it opens straight into manual entry instead.
 */
export default function LabelScanner({ mealId, day }: { mealId: string; day: DayKey }) {
  const closeSheet = useUi((s) => s.closeSheet);
  const toast = useUi((s) => s.toast);

  const native = Capacitor.isNativePlatform();
  const [phase, setPhase] = useState<'camera' | 'reading' | 'form' | 'error' | 'denied'>(
    native ? 'camera' : 'form',
  );
  const [error, setError] = useState<string>();
  const [lines, setLines] = useState<string[]>([]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const handleRef = useRef<ScannerHandle | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [videoReady, setVideoReady] = useState(false);

  const [meal, setMeal] = useState(mealId);
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [basis, setBasis] = useState<Basis>('100g');
  const [servingG, setServingG] = useState('');
  const [save, setSave] = useState(true);
  const [values, setValues] = useState<Record<LabelField, string>>(EMPTY_VALUES);

  const stopCamera = () => {
    handleRef.current?.stop();
    handleRef.current = null;
    setTorchOn(false);
    setTorchAvailable(false);
    setVideoReady(false);
  };

  /** Reads the text of a captured frame and fills in whatever it recognised. */
  const readFrame = async (dataUrl: string) => {
    setPhase('reading');
    setError(undefined);
    try {
      const text = await recognizeLabelFromDataUrl(dataUrl);
      if (!text || text.length === 0) {
        setPhase('form');
        return;
      }
      setLines(text);
      applyParsed(parseNutritionLabel(text));
      setPhase('form');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the label.');
      setPhase('error');
    }
  };

  const shutter = async () => {
    const video = videoRef.current;
    if (!video) return;
    const frame = captureFrame(video);
    if (!frame) return;
    stopCamera();
    await readFrame(frame);
  };

  /**
   * Falls back to the operating system's own camera app.
   *
   * The in-app preview needs getUserMedia inside the WebView, which a given
   * device or OEM build can refuse even with the permission granted. Rather
   * than dead-end, the system camera still gets a photograph to read.
   */
  const scanWithSystemCamera = async () => {
    setPhase('reading');
    setError(undefined);
    try {
      const text = await recognizeLabelText();
      if (!text) {
        setPhase('form');
        return;
      }
      setLines(text);
      applyParsed(parseNutritionLabel(text));
      setPhase('form');
    } catch (err) {
      if (err instanceof CameraDeniedError) {
        setPhase('denied');
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not read the label.');
      setPhase('error');
    }
  };

  const applyParsed = (parsed: ParsedLabel) => {
    const set = (value: number | undefined) =>
      value === undefined ? '' : String(Math.round(value * 100) / 100);
    setValues({
      kcal: set(parsed.kcal),
      protein: set(parsed.protein),
      carbs: set(parsed.carbs),
      fat: set(parsed.fat),
      fiber: set(parsed.fiber),
      sugar: set(parsed.sugar),
      satFat: set(parsed.satFat),
      sodium: set(parsed.sodiumMg),
    });
    if (parsed.servingG !== undefined) {
      setServingG(String(parsed.servingG));
      setBasis('serving');
    }
  };

  // Native opens the camera immediately: the user already chose "scan label",
  // so making them press a second button is pure friction.
  useEffect(() => {
    if (!native || phase !== 'camera') return;
    let cancelled = false;
    void (async () => {
      const video = videoRef.current;
      if (!video) return;
      try {
        const handle = await openCameraPreview(video);
        if (cancelled) {
          handle.stop();
          return;
        }
        handleRef.current = handle;
        setTorchAvailable(handle.hasTorch());
      } catch (err) {
        if (cancelled) return;
        if (err instanceof CameraDeniedError) {
          setPhase('denied');
          return;
        }
        // No in-app preview on this device — hand off rather than dead-end.
        void scanWithSystemCamera();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Release the camera whenever this sheet goes away, by any route.
  useEffect(() => stopCamera, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeSheet();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [closeSheet]);

  // Only counts while the serving basis is selected. The field is hidden in
  // per-100g mode, so a value left over from an earlier choice is invisible —
  // and it used to still decide the portion, logging "1 serving (25 g)" for a
  // panel the user had just told us was per 100 g.
  const serving = basis === 'serving' ? Number(servingG) || 0 : 0;
  const parsedCount = Object.values(values).filter((v) => v !== '').length;
  const valid = Number(values.kcal) > 0 && (basis === '100g' || serving > 0);
  const setValue = (key: LabelField) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setValues((prev) => ({ ...prev, [key]: event.target.value }));

  const commit = async () => {
    // Everything is stored per 100 g, so label values entered per serving are
    // converted once, here, and never again.
    const factor = basis === '100g' ? 1 : 100 / serving;
    const num = (raw: string) => {
      const parsed = Number(raw);
      return Number.isFinite(parsed) && raw !== '' ? parsed * factor : undefined;
    };
    const defined = (id: number, value: number | undefined) => (value === undefined ? {} : { [id]: value });

    const food = await upsertFood({
      source: 'label',
      name: name.trim() || 'Scanned label',
      brand: brand.trim() || undefined,
      per100g: {
        [N.ENERGY]: num(values.kcal) ?? 0,
        ...defined(N.PROTEIN, num(values.protein)),
        ...defined(N.CARBS, num(values.carbs)),
        ...defined(N.FAT, num(values.fat)),
        ...defined(N.FIBER, num(values.fiber)),
        ...defined(N.SUGAR, num(values.sugar)),
        ...defined(N.SAT_FAT, num(values.satFat)),
        ...defined(N.SODIUM, num(values.sodium)),
      },
      portions: serving > 0
        ? [{ label: `1 serving (${serving} g)`, grams: serving, preferred: true }, { label: '100 g', grams: 100 }]
        : [{ label: '100 g', grams: 100, preferred: true }],
      quality: 0.8,
      verified: true,
      // A one-off is tombstoned right after logging, so it never clutters
      // search results — but the diary entry keeps its own nutrition snapshot
      // and stays intact.
      deleted: !save,
    });

    const grams = serving > 0 ? serving : 100;
    await logFood({
      food,
      day,
      mealId: meal,
      grams,
      portionLabel: serving > 0 ? `1 serving (${serving} g)` : '100 g',
    });

    closeSheet();
    toast(save ? `${food.name} saved and logged` : `${food.name} logged`);
  };

  // Full-screen viewfinder, framed portrait for a nutrition panel rather than
  // the wide slot the barcode scanner uses.
  if (phase === 'camera') {
    return (
      <div className="fixed inset-0 z-50 animate-fade-in bg-black">
        {/* Hidden until it has frames: an empty <video> paints the WebView's
            own broken-media glyph while the camera opens. */}
        <video
          ref={videoRef}
          onLoadedData={() => setVideoReady(true)}
          className={cx(
            'absolute inset-0 size-full object-cover transition-opacity duration-300',
            videoReady ? 'opacity-100' : 'opacity-0',
          )}
          playsInline
          muted
          autoPlay
        />
        {!videoReady && (
          <div className="absolute inset-0 grid place-items-center">
            <span className="size-9 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
          </div>
        )}

        <div className="pointer-events-none absolute inset-0">
          <div
            className="absolute left-1/2 top-[44%] h-[58%] w-[84%] -translate-x-1/2 -translate-y-1/2 rounded-3xl"
            style={{ boxShadow: '0 0 0 9999px rgb(0 0 0 / 0.58)' }}
          />
          <div className="absolute left-1/2 top-[44%] h-[58%] w-[84%] -translate-x-1/2 -translate-y-1/2">
            {[
              'left-0 top-0 border-l-[3px] border-t-[3px] rounded-tl-2xl',
              'right-0 top-0 border-r-[3px] border-t-[3px] rounded-tr-2xl',
              'left-0 bottom-0 border-l-[3px] border-b-[3px] rounded-bl-2xl',
              'right-0 bottom-0 border-r-[3px] border-b-[3px] rounded-br-2xl',
            ].map((corner) => (
              <span key={corner} className={cx('absolute size-9 border-white', corner)} />
            ))}
          </div>
        </div>

        <div className="safe-t absolute inset-x-0 top-0 flex items-center justify-between px-4 pt-3">
          <button
            onClick={closeSheet}
            aria-label="Close scanner"
            className="grid size-11 place-items-center rounded-full bg-black/45 text-white backdrop-blur transition-transform active:scale-90"
          >
            <IconClose size={20} />
          </button>
          <p className="text-[15px] font-semibold text-white">Scan label</p>
          {torchAvailable ? (
            <button
              onClick={async () => {
                const next = !torchOn;
                const achieved = await handleRef.current?.setTorch(next);
                setTorchOn(achieved ?? false);
                if (next && achieved === false) toast('This camera has no flash');
              }}
              aria-pressed={torchOn}
              aria-label="Toggle flash"
              className={cx(
                'grid size-11 place-items-center rounded-full backdrop-blur transition-colors active:scale-90',
                torchOn ? 'bg-white text-black' : 'bg-black/45 text-white',
              )}
            >
              <IconFlash size={20} off={!torchOn} />
            </button>
          ) : (
            <span className="size-11" />
          )}
        </div>

        <div className="safe-b absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-4 pb-5 pt-10">
          <p className="mb-4 text-center text-[13px] leading-relaxed text-white/80">
            Fill the frame with the nutrition table. Reading happens on this device.
          </p>
          <div className="flex items-center justify-between">
            <button
              onClick={() => {
                stopCamera();
                setPhase('form');
              }}
              className="text-[13.5px] font-medium text-white/85"
            >
              Type it instead
            </button>
            <button
              onClick={() => void shutter()}
              aria-label="Capture label"
              className="grid size-[68px] place-items-center rounded-full border-[3px] border-white/85 transition-transform active:scale-90"
            >
              <span className="size-14 rounded-full bg-white" />
            </button>
            <span className="w-[86px]" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <Sheet
      open
      onClose={closeSheet}
      title="Scan label"
      footer={
        phase === 'form' ? (
          <Button variant="primary" full disabled={!valid} onClick={commit}>
            <IconCheck size={18} />
            {save ? 'Save food and log it' : 'Log this once'}
          </Button>
        ) : undefined
      }
    >
      {phase === 'reading' && (
        <EmptyState icon={<IconLabel size={26} />} title="Reading the label…" detail="Recognition runs on your device. Nothing is uploaded." />
      )}

      {phase === 'denied' && (
        <div className="p-4">
          <EmptyState
            icon={<IconLabel size={26} />}
            title="Camera access is turned off"
            detail="Reading a label needs the camera. It cannot be requested again once refused, so it has to be re-enabled in settings."
          />
          <div className="flex gap-2">
            <Button
              variant="primary"
              className="flex-1"
              onClick={async () => {
                const opened = await openAppSettings();
                if (!opened) toast('Enable the camera for this app in system settings');
              }}
            >
              Open settings
            </Button>
            <Button className="flex-1" onClick={() => setPhase('form')}>
              Type it instead
            </Button>
          </div>
        </div>
      )}

      {phase === 'error' && Boolean(error) && (
        <div className="p-4">
          <EmptyState icon={<IconLabel size={26} />} title="Could not read that" detail={error} />
          <div className="flex gap-2">
            <Button className="flex-1" onClick={() => setPhase('camera')}>Try again</Button>
            <Button variant="primary" className="flex-1" onClick={() => setPhase('form')}>Type it instead</Button>
          </div>
        </div>
      )}

      {phase === 'form' && (
        <div className="space-y-4 p-4">
          {native ? (
            <Card className="flex items-center gap-3">
              <span className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-faint">
                {parsedCount > 0
                  ? `Read ${parsedCount} ${parsedCount === 1 ? 'value' : 'values'} off the label. Check them against the packet — anything it could not read confidently was left blank.`
                  : 'Nothing could be read from that photo. Fill the fields in by hand, or try again with better light.'}
              </span>
              <Button size="sm" onClick={() => setPhase('camera')}>Rescan</Button>
            </Card>
          ) : (
            <Card className="text-[12.5px] leading-relaxed text-faint">
              Label recognition needs the native app — the web build would have to ship a large
              model or send your photos to a third party. Enter the panel by hand here; it takes
              about twenty seconds and the food is saved for next time.
            </Card>
          )}

          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Oat milk, barista" />
          </Field>
          <Field label="Brand (optional)">
            <Input value={brand} onChange={(e) => setBrand(e.target.value)} />
          </Field>

          <Field label="Meal">
            <MealPicker value={meal} onChange={setMeal} />
          </Field>

          <Field label="Label values are per">
            <div className="flex gap-2">
              <Button variant={basis === '100g' ? 'primary' : 'secondary'} className="flex-1" onClick={() => setBasis('100g')}>
                100 g / ml
              </Button>
              <Button variant={basis === 'serving' ? 'primary' : 'secondary'} className="flex-1" onClick={() => setBasis('serving')}>
                Serving
              </Button>
            </div>
          </Field>

          {basis === 'serving' && (
            <Field label="Serving size (g)">
              <Input type="number" inputMode="decimal" value={servingG} onChange={(e) => setServingG(e.target.value)} placeholder="30" />
            </Field>
          )}

          <div className="grid grid-cols-2 gap-2">
            {LABEL_FIELDS.map(({ key, label }) => (
              <Field key={key} label={label}>
                <Input
                  type="number"
                  inputMode="decimal"
                  value={values[key]}
                  onChange={setValue(key)}
                  // Fields the scanner actually filled get a lit border, so it
                  // is obvious at a glance which numbers came off the packet
                  // and which still need a human.
                  className={cx(values[key] !== '' && 'border-brand/40')}
                />
              </Field>
            ))}
          </div>

          <Card className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-medium">Save for reuse</p>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-faint">
                On: it joins your food list and is one search away next time. Off: it is logged
                today and leaves no trace behind.
              </p>
            </div>
            <Toggle checked={save} onChange={setSave} label="Save for reuse" />
          </Card>

          {lines.length > 0 && (
            <details className="rounded-xl border border-border bg-surface-2 p-3">
              <summary className="cursor-pointer text-[12.5px] text-faint">What the camera read</summary>
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-faint">
                {lines.join('\n')}
              </pre>
            </details>
          )}

          {Number(values.kcal) > 0 && (
            <p className="text-center text-[12.5px] text-faint">
              Logging {formatCount(Number(values.kcal))} kcal per {basis === '100g' ? '100 g' : `${serving || 0} g serving`}
            </p>
          )}
        </div>
      )}
    </Sheet>
  );
}
