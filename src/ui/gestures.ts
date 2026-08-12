import { useEffect, useRef } from 'react';

/**
 * Horizontal swipe detection.
 *
 * Used to move between diary days. Tapping a small chevron in the corner is the
 * kind of thing that works on a desktop and is tiresome on a phone; a swipe is
 * how people actually expect to move through days.
 *
 * Deliberately conservative about what counts: the gesture must be clearly
 * horizontal and travel a real distance, or every slightly-diagonal scroll
 * would flip the day out from under the reader.
 */
export interface SwipeOptions {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  /** Minimum horizontal travel in pixels. */
  threshold?: number;
  enabled?: boolean;
}

export function useSwipe<T extends HTMLElement>(options: SwipeOptions) {
  const { onSwipeLeft, onSwipeRight, threshold = 60, enabled = true } = options;
  const ref = useRef<T>(null);
  // Held in a ref so changing handlers never re-binds mid-gesture.
  const handlers = useRef({ onSwipeLeft, onSwipeRight });
  handlers.current = { onSwipeLeft, onSwipeRight };

  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;

    let startX = 0;
    let startY = 0;
    let tracking = false;

    const start = (event: PointerEvent) => {
      // Mouse drags across a page are usually text selection, not navigation.
      if (event.pointerType === 'mouse') return;
      startX = event.clientX;
      startY = event.clientY;
      tracking = true;
    };

    const end = (event: PointerEvent) => {
      if (!tracking) return;
      tracking = false;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      // Must be mostly sideways: a vertical scroll that drifts must not count.
      if (Math.abs(dx) < threshold || Math.abs(dx) < Math.abs(dy) * 1.6) return;
      if (dx < 0) handlers.current.onSwipeLeft?.();
      else handlers.current.onSwipeRight?.();
    };

    element.addEventListener('pointerdown', start as EventListener, { passive: true });
    element.addEventListener('pointerup', end as EventListener, { passive: true });
    element.addEventListener('pointercancel', () => (tracking = false), { passive: true });
    return () => {
      element.removeEventListener('pointerdown', start as EventListener);
      element.removeEventListener('pointerup', end as EventListener);
    };
  }, [threshold, enabled]);

  return ref;
}
