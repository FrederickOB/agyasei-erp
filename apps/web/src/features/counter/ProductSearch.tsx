/**
 * Tolerant local search over the synced catalogue (§8.7). Reads are local, so
 * results are effectively instant; the input is debounced so the main thread
 * never chases keystrokes. Empty query shows the catalogue — the quick grid.
 *
 * THREE THINGS THIS SCREEN OWES A PERSON IN A QUEUE, which it did not pay:
 *
 *   1. A WAY TO BROWSE WITHOUT TYPING. 219 products behind a text box is a
 *      catalogue only findable by someone who already knows what it is called.
 *      The chips are the tenant's OWN categories, read off the rows the sync
 *      stream delivered — not a list anybody typed into this file (§8.9).
 *   2. SOMETHING ON SCREEN WHILE THE READ RESOLVES. `undefined` used to render
 *      as nothing, and a blank counter reads as a broken till, not as a fast
 *      one. Skeletons in the shape of the thing that is coming.
 *   3. CONFIRMATION THAT THE TAP LANDED. The card flashes what it did, where
 *      the finger already is — the cart total moving at the bottom of the
 *      screen is the wrong place to look for it, and in a queue nobody does.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { lineNetMinor } from '@erp/money';
import { searchProducts } from '../../lib/search';
import { oneWholeUnit } from '../../lib/quantity';
import type { ProductWithPrice } from '../../data/queries/products';
import { Money } from '../../money/Money';
import { Icon } from '../../ui/Icon';

const DEBOUNCE_MS = 120;
const MAX_RESULTS = 30;
const ADDED_MS = 700;
/** Enough to browse by, few enough to stay one thumb-swipe from the start. */
const MAX_CHIPS = 8;

/** Display price for one whole selling unit, rounded once. */
function unitPriceMinor(p: ProductWithPrice): bigint {
  return lineNetMinor(oneWholeUnit(p.qtyScale), p.qtyScale, p.unitPriceE4, 'half-up');
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

export function ProductSearch({
  products,
  onAdd,
}: {
  /** `undefined` means the local read has not resolved — not "no products". */
  readonly products: readonly ProductWithPrice[] | undefined;
  readonly onAdd: (product: ProductWithPrice) => void;
}): ReactNode {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [addedId, setAddedId] = useState<string | null>(null);
  const addedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => () => {
    if (addedTimer.current !== null) clearTimeout(addedTimer.current);
  }, []);

  const all = products ?? [];
  const categories = useMemo(() => categoriesOf(all), [all]);
  const results = useMemo(() => {
    const scoped = category === null ? all : all.filter((p) => p.category === category);
    return searchProducts(scoped, debounced).slice(0, MAX_RESULTS);
  }, [all, category, debounced]);

  const add = (product: ProductWithPrice): void => {
    onAdd(product);
    setAddedId(product.id);
    if (addedTimer.current !== null) clearTimeout(addedTimer.current);
    addedTimer.current = setTimeout(() => setAddedId(null), ADDED_MS);
  };

  return (
    <section className="product-search" aria-label="Catalogue">
      <div className="search-field">
        <Icon name="search" size={22} className="search-icon" />
        <input
          className="search-input"
          type="search"
          inputMode="search"
          placeholder="Search products"
          aria-label="Search products"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
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
              className="chip pressable"
              aria-pressed={category === name}
              onClick={() => setCategory(category === name ? null : name)}
            >
              {name}
            </button>
          ))}
        </div>
      ) : null}

      {products === undefined ? (
        <ul className="product-grid" aria-hidden="true">
          {Array.from({ length: 8 }, (_, i) => (
            <li key={i} className="skeleton skeleton-card" />
          ))}
        </ul>
      ) : results.length > 0 ? (
        <ul className="product-grid" aria-label="Products">
          {results.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="product-card pressable"
                onClick={() => add(p)}
              >
                <span className="product-name">{p.name}</span>
                <span className="product-foot">
                  <Money amount={unitPriceMinor(p)} className="money product-price" />
                  <span className="product-unit">{p.uomLabel}</span>
                </span>
                {addedId === p.id ? (
                  <span className="product-added" aria-hidden="true">
                    <Icon name="check" size={22} />
                    Added
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
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
    </section>
  );
}
