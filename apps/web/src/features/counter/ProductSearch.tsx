/**
 * Tolerant local search over the synced catalogue (§8.7). Reads are local, so
 * results are effectively instant; the input is debounced so the main thread
 * never chases keystrokes. Empty query shows the catalogue — the quick grid.
 *
 * WHAT THIS SCREEN OWES A PERSON IN A QUEUE:
 *
 *   1. A WAY TO BROWSE WITHOUT TYPING. The chips are the tenant's OWN
 *      categories, read off the rows the sync stream delivered — not a list
 *      anybody typed into this file (§8.9). Browsing shows the WHOLE of what
 *      was chosen: an earlier cap of 30 hid most of a 219-line catalogue from
 *      anybody who did not already know what to type.
 *   2. SOMETHING ON SCREEN WHILE THE READ RESOLVES. Skeletons in the shape of
 *      the thing that is coming; a blank counter reads as a broken till.
 *   3. CONFIRMATION THAT THE TAP LANDED, where the finger already is: the card
 *      flashes, and from then on carries how many of it are in the sale. The
 *      grid itself answers "did I already ring that?" — the question a
 *      cashier otherwise answers by opening the cart.
 *
 * THE SCROLL. Only the grid scrolls (`.catalogue-scroll`); the search and the
 * chips stay where the hand left them, so changing department halfway down a
 * long list is one tap rather than a scroll back to the top.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { lineNetMinor } from '@erp/money';
import { searchProducts } from '../../lib/search';
import { formatQtyScaled, oneWholeUnit } from '../../lib/quantity';
import type { ProductWithPrice } from '../../data/queries/products';
import { Money } from '../../money/Money';
import { Icon } from '../../ui/Icon';

const DEBOUNCE_MS = 120;
/** A typed search narrows; past this many matches, typing more is faster than scrolling. */
const MAX_SEARCH_RESULTS = 60;
const ADDED_MS = 700;
/** Enough to browse by, few enough to stay one thumb-swipe from the start. */
const MAX_CHIPS = 8;
/** How many colours the category key cycles through (app.css `.cat-0` …). */
const CATEGORY_SWATCHES = 8;

/** What is already in the sale, per product — the badge on its card. */
export interface InCart {
  readonly qtyScaled: bigint;
  readonly qtyScale: number;
  readonly uomLabel: string;
}

/** Display price for one whole selling unit, rounded once. */
function unitPriceMinor(p: ProductWithPrice): bigint {
  return lineNetMinor(oneWholeUnit(p.qtyScale), p.qtyScale, p.unitPriceE4, 'half-up');
}

/**
 * The tile's initials: the first letter of each of the name's first two words
 * ("Aluzinc Roofing Sheets" → "AR"). Read off the tenant's own product name —
 * something to find by shape before reading, like a numbered key on a till.
 */
export function initialsOf(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
  return words
    .slice(0, 2)
    .map((w) => w.charAt(0).toLocaleUpperCase())
    .join('');
}

/** The categories this counter's own catalogue actually uses, busiest first. */
function categoriesOf(products: readonly ProductWithPrice[]): readonly string[] {
  const counts = new Map<string, number>();
  for (const p of products) {
    if (p.category === null) continue;
    counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_CHIPS)
    .map(([name]) => name);
}

/**
 * A colour per category, so a department reads at a glance across the grid
 * and matches its chip. Assigned by the category's place in the alphabet of
 * the tenant's own categories — never by its name — so no tenant's word is
 * ever looked up, and two categories in the first eight never share a colour.
 */
function swatchesOf(products: readonly ProductWithPrice[]): ReadonlyMap<string, number> {
  const names = [...new Set(products.map((p) => p.category).filter((c): c is string => c !== null))].sort(
    (a, b) => a.localeCompare(b),
  );
  return new Map(names.map((name, i) => [name, i % CATEGORY_SWATCHES]));
}

export function ProductSearch({
  products,
  onAdd,
  inCart,
  toolbar,
}: {
  /** `undefined` means the local read has not resolved — not "no products". */
  readonly products: readonly ProductWithPrice[] | undefined;
  readonly onAdd: (product: ProductWithPrice) => void;
  /** Quantity already in the open sale, by product id. */
  readonly inCart?: ReadonlyMap<string, InCart>;
  /** Shown beside the search on a wide screen (the till's state). */
  readonly toolbar?: ReactNode;
}): ReactNode {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [addedId, setAddedId] = useState<string | null>(null);
  const addedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => () => {
    if (addedTimer.current !== null) clearTimeout(addedTimer.current);
  }, []);

  // A new department or a new search starts at the top of its own list.
  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: 0 });
  }, [category, debounced]);

  const all = products ?? [];
  const categories = useMemo(() => categoriesOf(all), [all]);
  const swatches = useMemo(() => swatchesOf(all), [all]);
  const matched = useMemo(() => {
    const scoped = category === null ? all : all.filter((p) => p.category === category);
    return searchProducts(scoped, debounced);
  }, [all, category, debounced]);
  const searching = debounced.trim().length > 0;
  const results = searching ? matched.slice(0, MAX_SEARCH_RESULTS) : matched;

  const add = (product: ProductWithPrice): void => {
    onAdd(product);
    setAddedId(product.id);
    if (addedTimer.current !== null) clearTimeout(addedTimer.current);
    addedTimer.current = setTimeout(() => setAddedId(null), ADDED_MS);
  };

  const swatchClass = (name: string | null): string => {
    const i = name === null ? undefined : swatches.get(name);
    return i === undefined ? 'cat-none' : `cat-${String(i)}`;
  };

  return (
    <section className="product-search" aria-label="Catalogue">
      <div className="catalogue-head">
        <div className="search-row">
          <div className="search-field">
            <Icon name="search" size={22} className="search-icon" />
            <input
              ref={inputRef}
              className="search-input"
              type="search"
              inputMode="search"
              placeholder="Search products"
              aria-label="Search products"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query.length > 0 ? (
              <button
                type="button"
                className="search-clear pressable"
                aria-label="Clear search"
                onClick={() => {
                  setQuery('');
                  setDebounced('');
                  inputRef.current?.focus();
                }}
              >
                <Icon name="close" size={18} />
              </button>
            ) : null}
          </div>
          {toolbar}
        </div>

        {categories.length > 0 ? (
          <div className="chip-row" role="group" aria-label="Filter by category">
            <button
              type="button"
              className="chip pressable"
              aria-pressed={category === null}
              onClick={() => setCategory(null)}
            >
              All
            </button>
            {categories.map((name) => (
              <button
                key={name}
                type="button"
                className={`chip chip-cat pressable ${swatchClass(name)}`}
                aria-pressed={category === name}
                onClick={() => setCategory(category === name ? null : name)}
              >
                <span className="chip-swatch" aria-hidden="true" />
                {name}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="catalogue-scroll" ref={scrollRef}>
        {products === undefined ? (
          <ul className="product-grid" aria-hidden="true">
            {Array.from({ length: 12 }, (_, i) => (
              <li key={i} className="skeleton skeleton-card" />
            ))}
          </ul>
        ) : results.length > 0 ? (
          <>
            <ul className="product-grid" aria-label="Products">
              {results.map((p) => {
                const held = inCart?.get(p.id);
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      className={`product-card pressable ${swatchClass(p.category)}${held === undefined ? '' : ' in-cart'}`}
                      onClick={() => add(p)}
                    >
                      <span className="product-top" aria-hidden="true">
                        <span className="product-mono">{initialsOf(p.name)}</span>
                        {held === undefined ? null : (
                          // Keyed by the quantity, so each change replays the bump.
                          <span className="product-qty tabular" key={held.qtyScaled.toString()}>
                            ×{formatQtyScaled(held.qtyScaled, held.qtyScale)}
                          </span>
                        )}
                      </span>
                      <span className="product-name">{p.name}</span>
                      <span className="product-foot">
                        <Money amount={unitPriceMinor(p)} className="money product-price" />
                        <span className="product-unit">/ {p.uomLabel}</span>
                      </span>
                      {held === undefined ? null : (
                        <span className="visually-hidden">
                          {`, ${formatQtyScaled(held.qtyScaled, held.qtyScale)} ${held.uomLabel} in the sale`}
                        </span>
                      )}
                      {addedId === p.id ? (
                        <span className="product-added" aria-hidden="true">
                          <Icon name="check" size={22} />
                          Added
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
            {searching && matched.length > results.length ? (
              <p className="catalogue-more">
                Showing {results.length} of {matched.length} matches — keep typing to narrow it down.
              </p>
            ) : null}
          </>
        ) : all.length === 0 ? (
          <div className="empty-state">
            <Icon name="tag" size={40} />
            <span className="empty-title">No products priced yet</span>
            <p className="empty-body">
              This counter has no prices for the list it sells from. It will fill in as they arrive —
              leave the device connected.
            </p>
          </div>
        ) : (
          <div className="empty-state">
            <Icon name="search" size={40} />
            <span className="empty-title">Nothing found</span>
            <p className="empty-body">
              {debounced.length > 0
                ? `No product matches “${debounced}”. Try a shorter word, or a local name.`
                : 'No products in this category.'}
            </p>
            <button
              type="button"
              className="secondary-action pressable"
              onClick={() => {
                setQuery('');
                setCategory(null);
              }}
            >
              Show everything
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
