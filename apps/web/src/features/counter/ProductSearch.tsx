/**
 * Tolerant local search over the synced catalogue (§8.7). Reads are local, so
 * results are effectively instant; the input is debounced so the main thread
 * never chases keystrokes. Empty query shows the catalogue — the quick grid.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { lineNetMinor } from '@erp/money';
import { searchProducts } from '../../lib/search';
import { oneWholeUnit } from '../../lib/quantity';
import type { ProductWithPrice } from '../../data/queries/products';
import { Money } from '../../money/Money';

const DEBOUNCE_MS = 120;
const MAX_RESULTS = 30;

/** Display price for one whole selling unit, rounded once. */
function unitPriceMinor(p: ProductWithPrice): bigint {
  return lineNetMinor(oneWholeUnit(p.qtyScale), p.qtyScale, p.unitPriceE4, 'half-up');
}

export function ProductSearch({
  products,
  onAdd,
}: {
  readonly products: readonly ProductWithPrice[];
  readonly onAdd: (product: ProductWithPrice) => void;
}): ReactNode {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const results = useMemo(
    () => searchProducts(products, debounced).slice(0, MAX_RESULTS),
    [products, debounced],
  );

  return (
    <section className="product-search">
      <input
        className="search-input"
        type="search"
        inputMode="search"
        placeholder="Search products"
        aria-label="Search products"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {results.length === 0 ? (
        <p className="search-empty">
          Nothing found for “{debounced}”. Try a shorter word, or browse the catalogue.
        </p>
      ) : (
        <ul className="product-grid" aria-label="Products">
          {results.map((p) => (
            <li key={p.id}>
              <button type="button" className="product-card" onClick={() => onAdd(p)}>
                <span className="product-name">{p.name}</span>
                <span className="product-meta">
                  <Money amount={unitPriceMinor(p)} /> / {p.uomLabel}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
