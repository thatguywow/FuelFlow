import { useEffect, useRef, useState } from 'react';
import { useUi } from '../state/ui';
import { lookupBarcode } from '../search';
import type { DayKey } from '../core/dates';
import {
  cameraPermission,
  openAppSettings,
  requestCameraPermission,
  scanFromVideo,
  scanNative,
  scanSource,
  type ScannerHandle,
} from '../scan/barcode';
import { Button, Card, EmptyState, Input, Sheet, cx } from '../ui/primitives';
import { IconBarcode, IconCheck, IconFlash, IconSparkle } from '../ui/icons';

type Phase = 'checking' | 'needs-permission' | 'denied' | 'scanning' | 'looking-up' | 'error';

/**
 * Barcode scanner.
 *
 * On native this hands off to ML Kit's own camera UI. On the web it renders a
 * viewfinder and decodes frames in-page. A hit walks the same tiered lookup as
 * everything else — local cache, then the hosted database over range requests,
 * then the live API.
 *
 * Permission is requested explicitly and its refusal is a first-class state.
 * Simply calling for the camera and letting it throw leaves the user stuck:
 * once denied, neither the browser nor the OS will prompt again, so the only
 * way forward is a link into system settings.
 */
export default function Scanner({ mealId, day }: { mealId: string; day: DayKey }) {
  const closeSheet = useUi((s) => s.closeSheet);
  const openSheet = useUi((s) => s.openSheet);
  const toast = useUi((s) => s.toast);

  const videoRef = useRef<HTMLVideoElement>(null);
  const handleRef = useRef<ScannerHandle | null>(null);
  const busyRef = useRef(false);

  const [phase, setPhase] = useState<Phase>('checking');
  const [error, setError] = useState<string>();
  const [torchOn, setTorchOn] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [manual, setManual] = useState('');
  const [showManual, setShowManual] = useState(false);

  const resolve = async (barcode: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    handleRef.current?.stop();
    setPhase('looking-up');

    const { food, tier } = await lookupBarcode(barcode);
    if (food) {
      openSheet({ kind: 'food-detail', food, mealId, day });
      toast(
        tier === 'personal'
          ? 'Found in your foods'
          : tier === 'remote'
            ? 'Found in the food database'
            : 'Found on Open Food Facts',
      );
    } else {
      openSheet({ kind: 'create-food', barcode, mealId, day });
    }
  };

  const startCamera = async () => {
    const video = videoRef.current;
    if (!video) return;
    const handle = await scanFromVideo(
      video,
      (barcode) => void resolve(barcode),
      (err) => {
        setError(
          err.name === 'NotAllowedError'
            ? 'Camera access was blocked.'
            : err.message || 'The camera could not be started.',
        );
        setPhase('error');
      },
    );
    handleRef.current = handle;
    setTorchAvailable(handle.hasTorch());
    setPhase((current) => (current === 'error' ? current : 'scanning'));
  };

  const begin = async () => {
    const state = await cameraPermission();
    if (state === 'denied') {
      setPhase('denied');
      return;
    }
    if (state === 'prompt') {
      setPhase('needs-permission');
      return;
    }
    if (state === 'unavailable') {
      setError('This device has no camera available to the app.');
      setPhase('error');
      return;
    }
    if (scanSource() === 'native') {
      try {
        const barcode = await scanNative();
        if (barcode) void resolve(barcode);
        else closeSheet();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Scanning failed.');
        setPhase('error');
      }
      return;
    }
    await startCamera();
  };

  useEffect(() => {
    void begin();
    return () => handleRef.current?.stop();
    // Runs once: restarting the camera on every render would thrash the device
    // and re-prompt for permission.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const grant = async () => {
    const state = await requestCameraPermission();
    if (state === 'granted') {
      setPhase('checking');
      await begin();
    } else if (state === 'denied') {
      setPhase('denied');
    } else {
      setError('This device has no camera available to the app.');
      setPhase('error');
    }
  };

  const toggleTorch = async () => {
    const next = !torchOn;
    const achieved = await handleRef.current?.setTorch(next);
    setTorchOn(achieved ?? false);
    if (next && achieved === false) toast('This camera has no flash');
  };

  return (
    <Sheet
      open
      onClose={closeSheet}
      title="Scan barcode"
      footer={
        <div className="flex gap-2">
          <Button className="flex-1" onClick={() => setShowManual((v) => !v)}>
            {showManual ? 'Hide keypad' : 'Type the barcode'}
          </Button>
          <Button
            variant="secondary"
            className="flex-1"
            onClick={() => openSheet({ kind: 'create-food', mealId, day })}
          >
            New food
          </Button>
        </div>
      }
    >
      <div className="p-4">
        {phase === 'denied' && (
          <>
            <EmptyState
              icon={<IconBarcode size={26} />}
              title="Camera access is turned off"
              detail="Scanning needs the camera. Neither the app nor the browser can ask again once it has been refused — it has to be re-enabled in settings."
            />
            <div className="flex gap-2">
              <Button
                variant="primary"
                className="flex-1"
                onClick={async () => {
                  const opened = await openAppSettings();
                  if (!opened) {
                    toast('Open your browser settings for this site to allow the camera');
                  }
                }}
              >
                Open settings
              </Button>
              <Button className="flex-1" onClick={() => setShowManual(true)}>
                Type it instead
              </Button>
            </div>
          </>
        )}

        {phase === 'needs-permission' && (
          <>
            <EmptyState
              icon={<IconBarcode size={26} />}
              title="Allow the camera?"
              detail="Used only to read barcodes. Frames are decoded on this device and no image is stored or sent anywhere."
            />
            <Button variant="primary" full onClick={() => void grant()}>
              Allow camera
            </Button>
          </>
        )}

        {phase === 'error' && (
          <>
            <EmptyState icon={<IconBarcode size={26} />} title="Cannot use the camera" detail={error} />
            <Button full onClick={() => setShowManual(true)}>
              Type the barcode instead
            </Button>
          </>
        )}

        {phase === 'looking-up' && (
          <EmptyState icon={<IconSparkle size={26} />} title="Looking it up…" />
        )}

        {(phase === 'checking' || phase === 'scanning') && scanSource() !== 'native' && (
          <>
            {/* A tall viewfinder with the surroundings dimmed and only the
                framing window left clear. A small boxed preview makes people
                hold the phone too far back; filling the space is what tells
                them to bring the packet close. */}
            <div className="relative aspect-[3/4] overflow-hidden rounded-[--radius-card] bg-black">
              <video ref={videoRef} className="size-full object-cover" playsInline muted autoPlay />

              {/* Scrim with a cut-out window, built from a box-shadow so the
                  hole is genuinely transparent rather than a lighter overlay. */}
              <div className="pointer-events-none absolute inset-0">
                <div
                  className="absolute left-1/2 top-1/2 h-32 w-[82%] -translate-x-1/2 -translate-y-1/2 rounded-2xl"
                  style={{ boxShadow: '0 0 0 9999px rgb(0 0 0 / 0.55)' }}
                />
                <div className="absolute left-1/2 top-1/2 h-32 w-[82%] -translate-x-1/2 -translate-y-1/2">
                  {/* Corner brackets rather than a full outline: they frame
                      without hiding the edges of the barcode itself. */}
                  {[
                    'left-0 top-0 border-l-2 border-t-2 rounded-tl-xl',
                    'right-0 top-0 border-r-2 border-t-2 rounded-tr-xl',
                    'left-0 bottom-0 border-l-2 border-b-2 rounded-bl-xl',
                    'right-0 bottom-0 border-r-2 border-b-2 rounded-br-xl',
                  ].map((corner) => (
                    <span key={corner} className={cx('absolute size-7 border-white/90', corner)} />
                  ))}
                  <span className="absolute inset-x-4 top-1/2 h-px -translate-y-1/2 bg-brand/70 shadow-[0_0_10px_1px_var(--ff-brand-glow)]" />
                </div>
              </div>

              {torchAvailable && (
                <button
                  onClick={() => void toggleTorch()}
                  aria-pressed={torchOn}
                  aria-label="Toggle flash"
                  className={cx(
                    'absolute right-3 top-3 grid size-11 place-items-center rounded-full backdrop-blur transition-colors',
                    torchOn ? 'bg-white text-black' : 'bg-black/45 text-white',
                  )}
                >
                  <IconFlash size={20} off={!torchOn} />
                </button>
              )}

              <p className="absolute inset-x-0 bottom-4 text-center text-[13px] font-medium text-white/85">
                {phase === 'checking' ? 'Starting the camera…' : 'Hold the barcode inside the frame'}
              </p>
            </div>
          </>
        )}

        {phase === 'checking' && scanSource() === 'native' && (
          <EmptyState icon={<IconBarcode size={26} />} title="Opening the camera…" />
        )}

        {showManual && (
          <Card className="mt-4 space-y-3">
            <p className="text-[13px] font-medium">Enter the barcode</p>
            <p className="text-[12px] leading-relaxed text-faint">
              The digits printed under the bars. Usually 13 on European products, 12 in the US.
            </p>
            <div className="flex gap-2">
              <Input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                autoFocus
                value={manual}
                onChange={(event) => setManual(event.target.value.replace(/\D/g, '').slice(0, 14))}
                placeholder="3017620422003"
                className="text-center text-[17px] tracking-[0.08em] tnum"
              />
              <Button
                variant="primary"
                disabled={manual.length < 6}
                onClick={() => {
                  busyRef.current = false;
                  void resolve(manual);
                }}
              >
                <IconCheck size={18} />
              </Button>
            </div>
            {manual.length > 0 && manual.length < 6 && (
              <p className="text-[12px] text-warn">That is too short to be a barcode.</p>
            )}
          </Card>
        )}
      </div>
    </Sheet>
  );
}

