import { useEffect, useRef, useState } from 'react';

/**
 * Motion primitives.
 *
 * The difference between an app that feels built and one that feels generated
 * is almost entirely here: values that *travel* to their new position instead
 * of teleporting. A calorie total that counts up, a ring that springs to its
 * new arc, a bar that slides — each one tells you something changed and how
 * much, without a word of copy.
 *
 * Everything is hand-rolled on requestAnimationFrame. A spring library would
 * be a larger dependency than the twenty lines it would replace, and these
 * need to respect `prefers-reduced-motion` anyway, which most do not.
 */

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  );
}

/** Same curve as the CSS `--ease-out-quint` token, for visual consistency. */
const easeOutQuint = (t: number) => 1 - Math.pow(1 - t, 5);

export interface AnimatedNumberOptions {
  /** Milliseconds for the full travel. */
  duration?: number;
  /** Skip the animation on first render — avoids everything counting up at once. */
  animateOnMount?: boolean;
  /** Values closer than this snap instead of animating. */
  epsilon?: number;
}

/**
 * Tweens towards `value`, returning the current intermediate.
 *
 * Duration scales a little with distance: a jump from 0 to 2,400 should take
 * longer than 2,400 to 2,450, or small edits feel sluggish and large ones feel
 * instant. Reduced-motion users get the final value immediately.
 */
export function useAnimatedNumber(value: number, options: AnimatedNumberOptions = {}): number {
  const { duration = 600, animateOnMount = false, epsilon = 0.5 } = options;
  const [display, setDisplay] = useState(animateOnMount ? 0 : value);
  const fromRef = useRef(animateOnMount ? 0 : value);
  const frameRef = useRef(0);

  useEffect(() => {
    const from = fromRef.current;
    const to = Number.isFinite(value) ? value : 0;

    if (Math.abs(to - from) < epsilon || prefersReducedMotion()) {
      fromRef.current = to;
      setDisplay(to);
      return;
    }

    // Longer travel earns a little more time, capped so nothing ever drags.
    const span = Math.abs(to - from);
    const scale = Math.min(1, 0.35 + span / Math.max(1, Math.abs(to) || span) / 2);
    const total = duration * scale;
    const start = performance.now();

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / total);
      const current = from + (to - from) * easeOutQuint(t);
      setDisplay(current);
      fromRef.current = current;
      if (t < 1) frameRef.current = requestAnimationFrame(tick);
      else fromRef.current = to;
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [value, duration, epsilon]);

  return display;
}

/**
 * Staggered mount reveal. Returns true once this row's turn arrives, so a list
 * can cascade in rather than appearing as one slab.
 */
export function useStagger(index: number, step = 40, enabled = true): boolean {
  const [shown, setShown] = useState(!enabled || prefersReducedMotion());

  useEffect(() => {
    if (shown) return;
    // Cap the cascade so the twentieth row is not left waiting a full second.
    const delay = Math.min(index * step, 400);
    const timer = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(timer);
  }, [index, step, shown]);

  return shown;
}

/**
 * Tracks a pointer across an element and reports position as 0–1.
 *
 * Used for chart scrubbing. Pointer events cover mouse, touch and pen in one
 * path, and capture keeps the gesture alive when the finger leaves the element,
 * which is what makes dragging feel solid rather than slippery.
 */
export function useScrub(ref: React.RefObject<SVGSVGElement | HTMLElement | null>) {
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const positionOf = (event: PointerEvent) => {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0) return 0;
      return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    };

    const down = (event: PointerEvent) => {
      element.setPointerCapture(event.pointerId);
      setProgress(positionOf(event));
    };
    const move = (event: PointerEvent) => {
      if (!element.hasPointerCapture(event.pointerId)) return;
      // Stops the page from scrolling while a chart is being scrubbed.
      event.preventDefault();
      setProgress(positionOf(event));
    };
    const up = (event: PointerEvent) => {
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
      setProgress(null);
    };

    // `move` needs to be non-passive so preventDefault can stop the page from
    // scrolling mid-scrub; touch listeners default to passive otherwise.
    const listen = (type: string, fn: (event: PointerEvent) => void, options?: AddEventListenerOptions) =>
      element.addEventListener(type, fn as EventListener, options);

    listen('pointerdown', down);
    listen('pointermove', move, { passive: false });
    listen('pointerup', up);
    listen('pointercancel', up);
    return () => {
      element.removeEventListener('pointerdown', down as EventListener);
      element.removeEventListener('pointermove', move as EventListener);
      element.removeEventListener('pointerup', up as EventListener);
      element.removeEventListener('pointercancel', up as EventListener);
    };
  }, [ref]);

  return progress;
}

/** Fires a short haptic tap on native; a no-op on the web. */
export async function tapFeedback(): Promise<void> {
  try {
    const { Capacitor } = await import('@capacitor/core');
    if (!Capacitor.isNativePlatform()) return;
    const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
    await Haptics.impact({ style: ImpactStyle.Light });
  } catch {
    /* Haptics are a nicety, never a requirement. */
  }
}
