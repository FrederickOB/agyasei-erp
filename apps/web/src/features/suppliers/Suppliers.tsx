/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SUPPLIERS — who sells us what, and which of them is actually cheapest
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING THIS SCREEN EXISTS TO GET RIGHT
 * ---------------------------------------------------------------------------
 * Three quotes for the same material, in three different units, are not
 * comparable numbers. One supplier prices by the tonne, another by the sack,
 * a third by the pallet — and the lowest figure on the page is routinely not
 * the cheapest source. Buying from the wrong one because the number LOOKED
 * smaller is a margin decision made by a formatting accident.
 *
 * So every source is shown twice: the supplier's own quote in the supplier's
 * own unit, AND the same money per ONE STOCKING unit, which is the only
 * denominator all three share. The second figure is the one the eye should
 * land on, and it is the one the ranking is done from.
 *
 * **THE ORDER COMES FROM THE SERVER AND IS NEVER RE-SORTED HERE.** The server
 * ranks on exact rational arithmetic — `pa·db·nb ? pb·da·na`, cross-multiplied
 * — while the per-stocking-unit figure it sends is rounded once for display.
 * Re-sorting on the rounded figure could transpose two sources that differ by
 * less than one rounding step, which is precisely the error the exact
 * comparison exists to prevent. This screen renders the list in the order it
 * arrived and says which one the server called cheapest.
 *
 * ---------------------------------------------------------------------------
 * WHY IT CANNOT WORK OFFLINE, AND WHY THAT IS SAID PLAINLY
 * ---------------------------------------------------------------------------
 * `app.supplier` and `app.supplier_product` are in no sync bucket. A
 * partitioned device does not hold who supplies what or at what price, so this
 * screen asks the server and, when it cannot, says so — never an empty list
 * that reads as "nobody supplies this", never last week's price rendered like
 * today's.
 *
 * ---------------------------------------------------------------------------
 * A PRICE WITH NO RECORD IS AN ABSENCE, NEVER A ZERO
 * ---------------------------------------------------------------------------
 * A supplier we have never bought from has `lastPriceE4: null`. Rendering that
 * as 0.00 would put the cheapest-looking source in the business next to a
 * supplier nobody has a quote from. The absence is rendered as an absence,
 * with the server's own reason.
 *
 * ---------------------------------------------------------------------------
 * IT IS NO LONGER READ-ONLY
 * ---------------------------------------------------------------------------
 * A holder of `supplier.manage` can add and amend a supplier and record a
 * source for a product; a holder of `supplier.view` sees everything on this
 * screen and is offered neither control. Hiding a button is a courtesy — the
 * server refuses the write regardless, and the form prints its refusal in the
 * server's own words. Both writes are ONLINE-ONLY and refused rather than
 * queued; `features/suppliers/SupplierForms.tsx` has the reasons.
 *
 * Money becomes a string only through `@erp/money`, at the `<Money>` boundary.
 * `lastPriceE4` is a RATE ×10⁴, so the displayed figure is the price of ONE
 * whole unit — `lineNetMinor(oneWholeUnit(scale), scale, rate, 'half-up')` —
 * the same expression the counter uses for a shelf price, rounded once, for
 * display only. No arithmetic anywhere is done on a displayed value.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { lineNetMinor } from '@erp/money';
import type { ApiCallOptions } from '../../data/api/client';
import {
  HAULAGE,
  fetchSourcesForProduct,
  fetchSuppliers,
  type ComparedSource,
  type ProductSources,
  type Supplier,
} from '../../data/api/procurement';
import { CAPABILITY, holdsCapability, type PermissionsState } from '../../data/api/session';
import { useApiQuery } from '../../data/api/use-api-query';
import type { LocalDb } from '../../data/db';
import { loadPurchasableProducts, type PurchasableProduct } from '../../data/queries/purchase-units';
import { useLiveQuery } from '../../data/use-live-query';
import { oneWholeUnit } from '../../lib/quantity';
import { Money } from '../../money/Money';
import { Icon } from '../../ui/Icon';
import { FetchedAt, ServerPending, ServerUnavailable } from '../shell/ServerAnswer';
import { SourceForm, SupplierForm } from './SupplierForms';

const WHAT_SUPPLIERS = 'The supplier list';
const WHAT_SOURCES = 'Who supplies this product';

/** Stable identity, so a screen with no test seam does not refetch on render. */
const EMPTY_OPTIONS: ApiCallOptions = {};

/**
 * A rate ×10⁴ as the money for ONE whole unit, rounded once, for DISPLAY.
 *
 * The same expression the counter's shelf price uses. It is never fed back
 * into arithmetic and never stored — the comparison and the ordering are the
 * server's, on exact rationals.
 */
function priceOfOneUnit(rateE4: bigint, scale: number): bigint {
  return lineNetMinor(oneWholeUnit(scale), scale, rateE4, 'half-up');
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

function SourceRow({
  source,
  sources,
  cheapestSupplierId,
}: {
  readonly source: ComparedSource;
  readonly sources: ProductSources;
  readonly cheapestSupplierId: string | null;
}): ReactNode {
  const cheapest = cheapestSupplierId !== null && source.supplierId === cheapestSupplierId;
  return (
    <li className={`source-row${cheapest ? ' source-row-best' : ''}`}>
      <span className="stock-row-head">
        <span className="report-loc-name">{source.supplierName}</span>
        <span className="report-loc-code tabular">{source.supplierCode}</span>
      </span>
      <span className="source-flags">
        {cheapest ? (
          <span className="stock-badge source-badge-best">
            <Icon name="check" size={16} />
            Cheapest per {sources.stockingUomCode}
          </span>
        ) : null}
        {source.isPreferred ? (
          <span className="stock-badge source-badge-preferred">
            <Icon name="tag" size={16} />
            Preferred
          </span>
        ) : null}
        {source.supplierIsActive ? null : (
          <span className="stock-badge stock-badge-gone">
            <Icon name="alert" size={16} />
            Not in use
          </span>
        )}
      </span>
      <dl className="stock-figures">
        <div>
          <dt>Their price</dt>
          <dd className="tabular">
            {source.lastPriceE4 === null ? (
              <span className="figure-withheld">No price recorded</span>
            ) : (
              <>
                <Money amount={priceOfOneUnit(source.lastPriceE4, source.buyScale)} /> per{' '}
                {source.purchaseUomCode}
              </>
            )}
          </dd>
        </div>
        <div>
          {/* THE FIGURE THAT MAKES THEM COMPARABLE. Everything above this line
              is in a unit only this supplier uses. */}
          <dt>Same money per {sources.stockingUomCode}</dt>
          <dd className="tabular">
            {source.pricePerStockUnitE4 === null ? (
              <span className="figure-withheld">
                {source.priceUnavailableReason === null
                  ? 'Not comparable'
                  : 'Nothing bought from them yet'}
              </span>
            ) : (
              <Money amount={priceOfOneUnit(source.pricePerStockUnitE4, sources.qtyScale)} />
            )}
          </dd>
        </div>
        <div>
          <dt>One {source.purchaseUomCode} is</dt>
          <dd className="tabular">
            {source.stockUnitsPerPurchaseUnitDen === 1n
              ? source.stockUnitsPerPurchaseUnitNum.toString()
              : `${source.stockUnitsPerPurchaseUnitNum.toString()}/${source.stockUnitsPerPurchaseUnitDen.toString()}`}{' '}
            {sources.stockingUomCode}
          </dd>
        </div>
        <div>
          <dt>Terms</dt>
          <dd className="tabular">
            {source.paymentTermsDays === 0
              ? 'On delivery'
              : `${String(source.paymentTermsDays)} days`}
          </dd>
        </div>
        {source.leadTimeDays === null ? null : (
          <div>
            <dt>Lead time</dt>
            <dd className="tabular">
              {String(source.leadTimeDays)} day{source.leadTimeDays === 1 ? '' : 's'}
            </dd>
          </div>
        )}
        {source.supplierSku === null ? null : (
          <div>
            <dt>Their code for it</dt>
            <dd className="tabular">{source.supplierSku}</dd>
          </div>
        )}
      </dl>
    </li>
  );
}

function SourceComparison({
  productId,
  apiOptions,
}: {
  readonly productId: string;
  readonly apiOptions: ApiCallOptions;
}): ReactNode {
  const { state, refresh } = useApiQuery(
    () => fetchSourcesForProduct(productId, apiOptions),
    [productId, apiOptions],
  );

  return (
    <section className="report-panel">
      <header className="report-panel-head">
        <h3>Sources</h3>
        {state.status === 'ready' ? <FetchedAt atMs={state.fetchedAtMs} /> : null}
      </header>
      {state.status === 'loading' ? (
        <ServerPending what={WHAT_SOURCES} slow={state.slow} rows={3} />
      ) : null}
      {state.status === 'failed' ? (
        <ServerUnavailable what={WHAT_SOURCES} failure={state.failure} onRetry={refresh} />
      ) : null}
      {state.status === 'ready' ? (
        state.data.sources.length === 0 ? (
          <div className="empty-state empty-state-attention">
            <Icon name="alert" size={40} />
            <span className="empty-title">Nobody is recorded as supplying this</span>
            <p className="empty-body">
              There is no source on file for {state.data.productName}, so nothing can be ordered
              against it and it will show as unsourced on the buying list.
            </p>
          </div>
        ) : (
          <>
            <p className="report-note">
              {String(state.data.sourceCount)} source
              {state.data.sourceCount === 1 ? '' : 's'}, cheapest first —{' '}
              <strong>compared per {state.data.stockingUomCode}</strong>, which is the only unit
              they all share.
              {state.data.pricedSourceCount < state.data.sourceCount
                ? ` ${String(state.data.sourceCount - state.data.pricedSourceCount)} of them have no price on file and are listed last.`
                : ''}
            </p>
            <ul className="source-list" aria-label="Sources">
              {state.data.sources.map((s) => (
                <SourceRow
                  key={s.supplierProductId}
                  source={s}
                  sources={state.data}
                  cheapestSupplierId={state.data.cheapestSupplierId}
                />
              ))}
            </ul>
          </>
        )
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The supplier list
// ---------------------------------------------------------------------------

function SupplierRow({
  supplier,
  onAmend,
}: {
  readonly supplier: Supplier;
  /** Absent for a viewer: no control is offered where none may be used. */
  readonly onAmend: ((supplier: Supplier) => void) | null;
}): ReactNode {
  // The PLATFORM kind, never the tenant's own code for it (ADR-0006).
  const hauls = supplier.capabilities.some((c) => c.kind === HAULAGE);
  return (
    <li className="supplier-row">
      <span className="stock-row-head">
        <span className="report-loc-name">{supplier.name}</span>
        <span className="report-loc-code tabular">{supplier.code}</span>
      </span>
      <span className="source-flags">
        {/* The tenant's OWN words for its own taxonomy, rendered from its own
            rows. Nothing in this file compares one of these codes to a
            literal — only the platform `kind` above is branched on (§8.9). */}
        {supplier.capabilities.map((c) => (
          <span key={c.capabilityTypeId} className="stock-badge source-badge-cap">
            {c.name}
          </span>
        ))}
        {hauls ? (
          <span className="stock-badge source-badge-preferred">
            <Icon name="download" size={16} />
            Carries loads
          </span>
        ) : null}
        {supplier.isActive ? null : (
          <span className="stock-badge stock-badge-gone">
            <Icon name="alert" size={16} />
            Not in use
          </span>
        )}
      </span>
      <dl className="stock-figures">
        <div>
          <dt>Terms</dt>
          <dd className="tabular">
            {supplier.paymentTermsDays === 0
              ? 'On delivery'
              : `${String(supplier.paymentTermsDays)} days`}
          </dd>
        </div>
        {supplier.contactName === null ? null : (
          <div>
            <dt>Contact</dt>
            <dd>{supplier.contactName}</dd>
          </div>
        )}
        {supplier.contactPhone === null ? null : (
          <div>
            <dt>Phone</dt>
            <dd className="tabular">{supplier.contactPhone}</dd>
          </div>
        )}
      </dl>
      {onAmend === null ? null : (
        <div className="order-actions">
          <button
            type="button"
            className="secondary-action pressable"
            onClick={() => onAmend(supplier)}
          >
            <Icon name="tag" size={18} />
            Amend {supplier.code}
          </button>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export interface SuppliersProps {
  readonly db: LocalDb;
  readonly permissions: PermissionsState;
  readonly apiOptions?: ApiCallOptions;
}

/**
 * What the screen is doing: reading, writing a supplier, or writing a source.
 * A closed union rather than two booleans, so "amending a supplier while also
 * adding a source" is unrepresentable.
 */
type Mode =
  | { readonly kind: 'list' }
  | { readonly kind: 'supplier'; readonly supplier: Supplier | undefined }
  | { readonly kind: 'source' };

export function Suppliers({ db, permissions, apiOptions }: SuppliersProps): ReactNode {
  const options = useMemo<ApiCallOptions>(() => apiOptions ?? EMPTY_OPTIONS, [apiOptions]);
  const products = useLiveQuery(db, loadPurchasableProducts, []);
  const [productId, setProductId] = useState<string>('');
  const [onlyCarriers, setOnlyCarriers] = useState(false);
  const [mode, setMode] = useState<Mode>({ kind: 'list' });

  const listInput = useMemo(
    () => (onlyCarriers ? { kind: HAULAGE } : {}),
    [onlyCarriers],
  );
  const { state, refresh } = useApiQuery(
    () => fetchSuppliers(listInput, options),
    [listInput, options],
  );

  const onPickProduct = useCallback((next: string) => setProductId(next), []);

  // A courtesy: the server refuses the read regardless of what this screen
  // offered, and the panel below says so in the server's own words.
  const canView = holdsCapability(permissions, CAPABILITY.supplierView);
  // The same courtesy on the write side. `supplier.manage` is held at the
  // TENANT ROOT — a supplier's terms are the same fact at every outlet — and
  // the server checks it there, whatever this screen chose to render.
  const canManage = holdsCapability(permissions, CAPABILITY.supplierManage);

  if (!canView) {
    return (
      <div className="buying-screen">
        <section className="server-answer server-answer-calm" role="status">
          <Icon name="alert" size={28} />
          <div className="server-answer-body">
            <h3 className="server-answer-title">Who supplies what is not part of what you see.</h3>
            <p className="server-answer-text">
              Suppliers, their terms and their prices are commercial facts kept to a narrower
              group. Nothing is shown here rather than an empty list, which would read as “we have
              no suppliers”.
            </p>
          </div>
        </section>
      </div>
    );
  }

  const catalogue: readonly PurchasableProduct[] = products ?? [];
  const known = state.status === 'ready' ? state.data : null;

  // ── Writing ──────────────────────────────────────────────────────────────
  // Both forms need the tenant's own capability taxonomy and its live supplier
  // list, which arrive together on `listSuppliers`. If that read has not
  // landed, there is nothing honest to put in a dropdown, so the form is not
  // offered — never an empty one that reads as "this tenant has no suppliers".
  if (mode.kind === 'supplier' && known !== null) {
    return (
      <div className="buying-screen">
        <section className="report-panel">
          <header className="report-panel-head">
            <h2>{mode.supplier === undefined ? 'Add a supplier' : `Amend ${mode.supplier.code}`}</h2>
          </header>
          <p className="report-note">
            Suppliers are kept on the server, so this is saved there and not on this device. If
            there is no connection it is refused outright — nothing is queued.
          </p>
          <SupplierForm
            supplier={mode.supplier}
            capabilityTypes={known.capabilityTypes}
            apiOptions={options}
            onSaved={() => {
              setMode({ kind: 'list' });
              refresh();
            }}
            onCancel={() => setMode({ kind: 'list' })}
          />
        </section>
      </div>
    );
  }

  if (mode.kind === 'source' && known !== null) {
    return (
      <div className="buying-screen">
        <section className="report-panel">
          <header className="report-panel-head">
            <h2>Record a source</h2>
          </header>
          <p className="report-note">
            A source says this supplier can supply this product, in a unit they quote in. Three
            suppliers for one product is three of these — which is what makes the comparison
            possible at all.
          </p>
          <SourceForm
            db={db}
            suppliers={known.suppliers.filter((sup) => sup.isActive)}
            products={catalogue}
            productId={productId === '' ? undefined : productId}
            apiOptions={options}
            onSaved={() => setMode({ kind: 'list' })}
            onCancel={() => setMode({ kind: 'list' })}
          />
        </section>
      </div>
    );
  }

  return (
    <div className="buying-screen">
      <section className="report-panel">
        <header className="report-panel-head">
          <h2>Suppliers</h2>
          {state.status === 'ready' ? <FetchedAt atMs={state.fetchedAtMs} /> : null}
        </header>

        {canManage ? (
          <button
            type="button"
            className="primary-action pressable"
            disabled={known === null}
            onClick={() => setMode({ kind: 'supplier', supplier: undefined })}
          >
            <Icon name="plus" size={20} />
            Add a supplier
          </button>
        ) : null}

        <div className="buying-filters">
          <button
            type="button"
            className="chip pressable"
            aria-pressed={onlyCarriers}
            onClick={() => setOnlyCarriers((v) => !v)}
          >
            Only the ones that carry loads
          </button>
        </div>

        {state.status === 'loading' ? (
          <ServerPending what={WHAT_SUPPLIERS} slow={state.slow} rows={4} />
        ) : null}
        {state.status === 'failed' ? (
          <ServerUnavailable what={WHAT_SUPPLIERS} failure={state.failure} onRetry={refresh} />
        ) : null}
        {state.status === 'ready' ? (
          state.data.suppliers.length === 0 ? (
            <div className="empty-state">
              <Icon name="search" size={40} />
              <span className="empty-title">
                {onlyCarriers ? 'No supplier is recorded as carrying loads' : 'No suppliers yet'}
              </span>
              <p className="empty-body">
                {onlyCarriers
                  ? 'A carrier is a supplier that hauls. Give one a haulage capability and it will appear here.'
                  : 'Nothing can be ordered until somebody is recorded as selling it.'}
              </p>
            </div>
          ) : (
            <ul className="supplier-list" aria-label="Suppliers">
              {state.data.suppliers.map((s) => (
                <SupplierRow
                  key={s.supplierId}
                  supplier={s}
                  onAmend={
                    canManage
                      ? (supplier) => setMode({ kind: 'supplier', supplier })
                      : null
                  }
                />
              ))}
            </ul>
          )
        ) : null}
      </section>

      <section className="report-panel">
        <header className="report-panel-head">
          <h2>Compare sources</h2>
        </header>
        <p className="report-note">
          Pick a product to see every supplier for it side by side, priced in one common unit —
          the lowest figure on a quote is not the cheapest source when the quotes are in different
          units.
        </p>
        <label className="threshold-form-field">
          <span>Which product</span>
          <select
            value={productId}
            aria-label="Product to compare sources for"
            onChange={(e) => onPickProduct(e.currentTarget.value)}
          >
            <option value="">Choose a product…</option>
            {catalogue.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.code}
              </option>
            ))}
          </select>
        </label>
        {catalogue.length === 0 ? (
          <p className="adjust-kind-note">
            This device has not received a catalogue of things it can buy yet.
          </p>
        ) : null}
        {canManage ? (
          <button
            type="button"
            className="secondary-action pressable"
            disabled={known === null}
            onClick={() => setMode({ kind: 'source' })}
          >
            <Icon name="plus" size={20} />
            Record a source
          </button>
        ) : null}
      </section>

      {productId === '' ? null : (
        <SourceComparison productId={productId} apiOptions={options} />
      )}
    </div>
  );
}
