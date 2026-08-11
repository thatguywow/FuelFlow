import { useEffect, useRef, useState } from 'react';
import { useUi } from '../state/ui';
import { lookupBarcode } from '../search';
import type { DayKey } from '../core/dates';
import { scanFromVideo, scanNative, scanSource, type ScannerHandle } from '../scan/barcode';
import { Button, EmptyState, Sheet } from '../ui/primitives';
import { IconBarcode } from '../ui/icons';

/**
 * Barcode scanner.
 *
 * On native this hands straight off to ML Kit's own camera UI. On the web it
 * renders a viewfinder and decodes frames in-page. A hit walks the same tiered
 * lookup as everything else — local cache, then the branded snapshot over
 * range requests, then the live API — and a miss drops into custom-food
 * creation with the code pre-filled, so a scan is never a dead end.
 */
export default function Scanner({ mealId, day }: { mealId: string; day: DayKey }) {
  const closeSheet = useUi((s) => s.closeSheet);
  const openSheet = useUi((s) => s.openSheet);
  const toast = useUi((s) => s.toast);

  const videoRef = useRef<HTMLVideoElement>(null);
  const handleRef = useRef<ScannerHandle | null>(null);
  const busyRef = useRef(false);

  const [status, setStatus] = useState<'starting' | 'scanning' | 'looking-up' | 'error'>('starting');
  const [error, setError] = useState<string>();

  const handleBarcode = async (barcode: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    handleRef.current?.stop();
    setStatus('looking-up');

    const { food, tier } = await lookupBarcode(barcode);
    if (food) {
      openSheet({ kind: 'food-detail', food, mealId, day });
      toast(tier === 'personal' ? 'Found in your foods' : tier === 'remote' ? 'Found in the branded database' : 'Found on Open Food Facts');
    } else {
      openSheet({ kind: 'create-food', barcode, mealId, day });
    }
  };

  useEffect(() => {
    let cancelled = false;

    if (scanSource() === 'native') {
      void scanNative()
        .then((barcode) => {
          if (cancelled) return;
          if (barcode) void handleBarcode(barcode);
          else closeSheet();
        })
        .catch((err: Error) => {
          if (cancelled) return;
          setError(err.message);
          setStatus('error');
        });
      return () => {
        cancelled = true;
      };
    }

    const video = videoRef.current;
    if (!video) return;

    void scanFromVideo(
      video,
      (barcode) => void handleBarcode(barcode),
      (err) => {
        if (cancelled) return;
        setError(
          err.name === 'NotAllowedError'
            ? 'Camera access was blocked. Allow it in your browser settings, or add the food by hand.'
            : err.message,
        );
        setStatus('error');
      },
    ).then((handle) => {
      handleRef.current = handle;
      if (cancelled) handle.stop();
      else setStatus('scanning');
    });

    return () => {
      cancelled = true;
      handleRef.current?.stop();
    };
    // Intentionally runs once: restarting the camera on every render would
    // thrash the device and re-prompt for permission.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Sheet
      open
      onClose={closeSheet}
      title="Scan barcode"
      footer={
        <Button variant="secondary" full onClick={() => openSheet({ kind: 'create-food', mealId, day })}>
          Enter it by hand instead
        </Button>
      }
    >
      {status === 'error' ? (
        <EmptyState icon={<IconBarcode size={30} />} title="Cannot use the camera" detail={error} />
      ) : scanSource() === 'native' ? (
        <EmptyState
          icon={<IconBarcode size={30} />}
          title={status === 'looking-up' ? 'Looking it up…' : 'Opening the camera…'}
        />
      ) : (
        <div className="p-4">
          <div className="relative aspect-[4/3] overflow-hidden rounded-[--radius-card] bg-black">
            <video
              ref={videoRef}
              className="size-full object-cover"
              playsInline
              muted
              autoPlay
            />
            {/* Framing guide — a plain rounded window with a bright centre line,
                which is what people instinctively line a barcode up against. */}
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div className="relative h-28 w-4/5 rounded-xl border-2 border-white/70">
                <div className="absolute inset-x-3 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-danger/80" />
              </div>
            </div>
          </div>

          <p className="mt-4 text-center text-[13px] text-faint">
            {status === 'looking-up'
              ? 'Looking it up…'
              : status === 'starting'
                ? 'Starting the camera…'
                : 'Line the barcode up inside the frame.'}
          </p>
        </div>
      )}
    </Sheet>
  );
}
