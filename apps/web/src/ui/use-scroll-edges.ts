/**
 * For a horizontally scrolling strip (the counter's destinations, category
 * chips): which ends have more hidden behind them, so the frame can fade that
 * edge. A clipped "Decisio" with no fade reads as a rendering bug; a fade
 * reads as "there is more this way".
 *
 * Also keeps the CURRENT item in view: switching destinations from a screen
 * link must not leave the highlighted tab scrolled off the edge.
 *
 * Everything is guarded — jsdom has no ResizeObserver and no scrollIntoView,
 * and a missing fade must never break the nav it decorates.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';

export interface ScrollEdges {
  readonly start: '0' | '1';
  readonly end: '0' | '1';
}

export function useScrollEdges<T extends HTMLElement>(currentKey: unknown): {
  readonly ref: RefObject<T>;
  readonly more: ScrollEdges;
} {
  const ref = useRef<T>(null);
  const [more, setMore] = useState<ScrollEdges>({ start: '0', end: '0' });

  useEffect(() => {
    const el = ref.current;
    if (el === null) return undefined;
    const measure = (): void => {
      const max = el.scrollWidth - el.clientWidth;
      // A few pixels of slack: scroll-snap can park the first item a
      // padding's width from zero, and that is not "more this way".
      const start = el.scrollLeft > 8 ? '1' : '0';
      const end = max - el.scrollLeft > 8 ? '1' : '0';
      setMore((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    const current = ref.current?.querySelector<HTMLElement>('[aria-current="true"]');
    if (current !== null && current !== undefined && typeof current.scrollIntoView === 'function') {
      current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [currentKey]);

  return { ref, more };
}
