/**
 * A live media query, so a component can know which LAYOUT it is in.
 *
 * Needed for one honest reason: the cart is a docked column on a tablet and a
 * modal sheet on a phone, and `aria-modal` must be true only in the second
 * case. CSS alone can move the box; it cannot tell a screen reader whether the
 * rest of the screen is still available, and claiming a modal that is not one
 * traps people inside a panel they could have simply walked out of.
 */
import { useEffect, useState } from 'react';

/**
 * Fails to the NARROW layout when the API is absent, which is the safe
 * direction: the narrow layout is the one that works at any size, and it is
 * the one the pilot's devices actually use.
 */
function supported(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => supported() && window.matchMedia(query).matches);

  useEffect(() => {
    if (!supported()) return;
    const list = window.matchMedia(query);
    const onChange = (): void => setMatches(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/** The one breakpoint the counter changes shape at (app.css: 900px). */
export const WIDE_LAYOUT = '(min-width: 900px)';
