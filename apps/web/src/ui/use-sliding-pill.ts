/**
 * A highlight that GLIDES to the chosen tab instead of jumping there.
 *
 * Motion with a job: when a person taps a destination, the pill travelling
 * from where they were to where they are going says "you moved from there to
 * here" — the one thing an instant swap of two backgrounds cannot say. It is
 * one absolutely positioned element moved with `transform`, so the browser
 * composites it without laying anything out: cheap enough for the low-end
 * tablet every budget is set against.
 *
 * Measured, not computed: tabs differ in width (labels, badges, bold), so the
 * pill takes the active tab's own box. Until that box is known — jsdom, a
 * first paint, a tab that is not rendered — the pill reports `null` and the
 * tab keeps its own background, so nothing is ever left un-highlighted.
 *
 * The first placement does NOT animate: sliding in from the left edge on page
 * load would be motion that means nothing.
 */
import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

export interface SlidingPill {
  /** Inline style for the pill element; null until a tab has been measured. */
  readonly style: CSSProperties | null;
}

export function useSlidingPill(
  containerRef: RefObject<HTMLElement>,
  activeKey: unknown,
  activeSelector: string,
): SlidingPill {
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [placed, setPlaced] = useState(false);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null) return undefined;
    const measure = (): void => {
      const tab = container.querySelector<HTMLElement>(activeSelector);
      if (tab === null || tab.offsetWidth === 0) {
        setBox(null);
        return;
      }
      const next = { x: tab.offsetLeft, y: tab.offsetTop, w: tab.offsetWidth, h: tab.offsetHeight };
      setBox((prev) =>
        prev !== null && prev.x === next.x && prev.y === next.y && prev.w === next.w && prev.h === next.h
          ? prev
          : next,
      );
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(container);
    // Tabs change width when a badge appears or a web font lands.
    // Not the pill itself: its own width transition would re-measure every frame.
    for (const child of Array.from(container.children)) {
      if (!child.classList.contains('nav-pill')) observer?.observe(child);
    }
    return () => observer?.disconnect();
  }, [containerRef, activeKey, activeSelector]);

  // Enable the transition only after the first placement has painted.
  useLayoutEffect(() => {
    if (box === null || placed) return undefined;
    const frame = requestAnimationFrame(() => setPlaced(true));
    return () => cancelAnimationFrame(frame);
  }, [box, placed]);

  if (box === null) return { style: null };
  return {
    style: {
      width: `${String(box.w)}px`,
      height: `${String(box.h)}px`,
      transform: `translate(${String(box.x)}px, ${String(box.y)}px)`,
      transitionDuration: placed ? undefined : '0ms',
    },
  };
}
