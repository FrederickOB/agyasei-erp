/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LOW STOCK — what is at or below its reorder point at this counter
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING THIS SCREEN EXISTS TO GET RIGHT
 * ---------------------------------------------------------------------------
 * An empty alert list means one of two completely different things:
 *
 *   · thresholds are set here and nothing has fallen below one — stock is
 *     healthy;
 *   · nobody has ever set a threshold here, so NOTHING CAN BE LOW, and the
 *     empty list is the absence of a question rather than a reassuring answer.
 *
 * Showing the second as the first is exactly how a stock-out is missed: the
 * screen answers a question it was never asked, and does it reassuringly.
 * The two are rendered as different screens with different words, and a third
 * rendering exists for "this device could not find out", because that is a
 * third fact and not a tie-breaker between the first two.
 *
 * ---------------------------------------------------------------------------
 * WHY IT CANNOT WORK OFFLINE, AND WHY THAT IS SAID PLAINLY
 * ---------------------------------------------------------------------------
 * `app.reorder_point` is in no sync bucket. A partitioned device does not
 * hold the thresholds and cannot compute the alert, so this screen asks the
 * server and, when it cannot, says so — never an empty list, never yesterday's
 * list dressed as today's (`data/api/inventory.ts`).
 *
 * ---------------------------------------------------------------------------
 * WHO MAY CHANGE A THRESHOLD
 * ---------------------------------------------------------------------------
 * `stock.reorder.manage` AT THIS LOCATION. Counter staff hold `stock.view`
 * and see the list; they are not offered the control. That is a courtesy —
 * the server re-authorises the write at ingest and refuses it there
 * regardless of what this screen offered (CLAUDE.md §2.6).
 *
 * Quantities are scaled integers in each product's STOCKING unit, with the
 * scale and the unit coming from the server on every row. The counter never
 * converts a unit; typing a threshold goes through `parseQtyScaled`, which
 * refuses anything a float would have accepted (ADR-0004).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ApiCallOptions } from '../../data/api/client';
import {
  ensureReorderPoints,
  fetchLowStockPicture,
  setReorderPoint,
  type LowStockAlert,
  type LowStockPicture,
  type ThresholdCoverage,
} from '../../data/api/inventory';
import { CAPABILITY, holdsCapabilityAt, type PermissionsState } from '../../data/api/session';
import { useApiQuery } from '../../data/api/use-api-query';
import type { LocalDb } from '../../data/db';
import { getOrCreateDeviceNode } from '../../data/queries/config';
import { loadActiveProducts, type ProductWithPrice } from '../../data/queries/products';
import { readDeviceLocation } from '../../data/queries/session';
import { useLiveQuery } from '../../data/use-live-query';
import { createClaimedHlcClock, type ClaimedHlcClock } from '../../lib/hlc';
import { formatQtyScaled, parseQtyScaled, QuantityInputError } from '../../lib/quantity';
import { formatBasisPointsAsPercent } from '../../lib/ratio';
import { uuidv7 } from '../../lib/uuidv7';
import { Icon } from '../../ui/Icon';
import { Unit } from '../../ui/Unit';
import { FetchedAt, ServerPending, ServerUnavailable } from '../shell/ServerAnswer';

const WHAT = 'The low-stock list';

// ---------------------------------------------------------------------------
// The threshold form
// ---------------------------------------------------------------------------

interface EditTarget {
  readonly productId: string;
  readonly productName: string;
  readonly skuCode: string;
  readonly qtyScale: number;
  readonly uomCode: string;
  /** The threshold in force, when there is one. */
  readonly currentQty: bigint | null;
}

function ThresholdForm({
  target,
  locationId,
  db,
  apiOptions,
  onDone,
  onCancel,
}: {
  readonly target: EditTarget;
  readonly locationId: string;
  readonly db: LocalDb;
  readonly apiOptions: ApiCallOptions;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const [text, setText] = useState(
    target.currentQty === null ? '' : formatQtyScaled(target.currentQty, target.qtyScale),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const hlcRef = useRef<ClaimedHlcClock | null>(null);
  // THE IDEMPOTENCY KEY IS MINTED WHEN THE FORM OPENS, not when Save is
  // tapped — the same discipline as the sale id (§8.2). A double-tap, a
  // retry after a timeout and a resumed form all carry the same key, so the
  // server sees one write.
  const keyRef = useRef<string>(uuidv7());

  useEffect(() => {
    void getOrCreateDeviceNode(db).then((node) => {
      hlcRef.current = createClaimedHlcClock(node);
    });
  }, [db]);

  const save = useCallback(() => {
    let qty: bigint;
    try {
      qty = parseQtyScaled(text, target.qtyScale);
    } catch (err) {
      setProblem(
        err instanceof QuantityInputError ? err.message : 'That is not a quantity this unit can hold.',
      );
      return;
    }
    setProblem(null);
    setSaving(true);
    const hlc = hlcRef.current;
    void setReorderPoint(
      {
        idempotencyKey: keyRef.current,
        ...(hlc === null ? {} : { claimedHlc: hlc.next() }),
        clientWallAt: new Date().toISOString(),
        locationId,
        productId: target.productId,
        reorderPointQty: qty.toString(),
      },
      apiOptions,
    ).then((result) => {
      setSaving(false);
      if (result.ok) {
        // A new key for the next edit; this one has been spent.
        keyRef.current = uuidv7();
        onDone();
        return;
      }
      // Never queued and never assumed: a threshold that could not be set is
      // a threshold that is not set, and the screen says which "no" it was.
      setProblem(
        result.failure.kind === 'offline'
          ? 'Not saved. Thresholds are kept on the server and this device cannot reach it. Nothing was queued.'
          : `Not saved. ${result.failure.detail ?? result.failure.message}`,
      );
    });
  }, [apiOptions, locationId, onDone, target.productId, target.qtyScale, text]);

  return (
    <form
      className="threshold-form"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <p className="threshold-form-product">
        <span className="report-loc-name">{target.productName}</span>
        <span className="report-loc-code tabular">{target.skuCode}</span>
      </p>
      <label className="threshold-form-field">
        <span>Tell me when it drops to</span>
        <span className="threshold-form-input">
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={text}
            aria-label={`Reorder threshold in ${target.uomCode}`}
            onChange={(e) => setText(e.currentTarget.value)}
          />
          <span className="threshold-form-uom"><Unit code={target.uomCode} /></span>
        </span>
      </label>
      {problem === null ? null : (
        <p className="device-gate-error" role="alert">
          <Icon name="alert" size={20} />
          <span>{problem}</span>
        </p>
      )}
      <div className="threshold-form-actions">
        <button type="submit" className="primary-action pressable" disabled={saving}>
          {saving ? 'Saving…' : 'Save threshold'}
        </button>
        <button type="button" className="secondary-action pressable" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

function AlertRow({
  alert,
  canManage,
  onEdit,
}: {
  readonly alert: LowStockAlert;
  readonly canManage: boolean;
  readonly onEdit: () => void;
}): ReactNode {
  const gone = alert.qtyOnHand <= 0n;
  return (
    <li className={`stock-row ${gone ? 'stock-row-gone' : ''}`}>
      <span className="stock-row-head">
        <span className="report-loc-name">{alert.productName}</span>
        <span className="report-loc-code tabular">{alert.skuCode}</span>
      </span>
      <span className={`stock-badge ${gone ? 'stock-badge-gone' : 'stock-badge-low'}`}>
        <Icon name={gone ? 'alert' : 'clock'} size={16} />
        {gone ? 'None left' : 'Below threshold'}
      </span>
      <dl className="stock-figures">
        <div>
          <dt>On hand</dt>
          <dd className="tabular">
            {formatQtyScaled(alert.qtyOnHand, alert.qtyScale)} <Unit code={alert.uomCode} />
          </dd>
        </div>
        <div>
          <dt>Threshold</dt>
          <dd className="tabular">
            {formatQtyScaled(alert.reorderPointQty, alert.qtyScale)} <Unit code={alert.uomCode} />
          </dd>
        </div>
        <div>
          <dt>Short by</dt>
          <dd className="tabular">
            {formatQtyScaled(alert.shortfallQty, alert.qtyScale)} <Unit code={alert.uomCode} />
          </dd>
        </div>
        {alert.coverageBp === null ? null : (
          <div>
            <dt>Of threshold</dt>
            <dd className="tabular">{formatBasisPointsAsPercent(alert.coverageBp)}%</dd>
          </div>
        )}
        {alert.leadTimeDays === null ? null : (
          <div>
            <dt>Lead time</dt>
            <dd className="tabular">
              {String(alert.leadTimeDays)} day{alert.leadTimeDays === 1 ? '' : 's'}
            </dd>
          </div>
        )}
      </dl>
      {canManage ? (
        <button type="button" className="secondary-action pressable" onClick={onEdit}>
          Change threshold
        </button>
      ) : null}
    </li>
  );
}

/**
 * The empty case, told apart. Three renderings, because there are three
 * facts, and the difference between the first two is the whole point of the
 * screen.
 */
function EmptyList({
  coverage,
  canManage,
  onAddFirst,
}: {
  readonly coverage: ThresholdCoverage | undefined;
  readonly canManage: boolean;
  readonly onAddFirst: () => void;
}): ReactNode {
  if (coverage === undefined || coverage.kind === 'unknown') {
    return (
      <div className="empty-state empty-attn">
        <Icon name="cloud-off" size={40} />
        <span className="empty-title">This device could not check</span>
        <p className="empty-body">
          It could not find out whether any thresholds are set here, so it cannot tell you whether
          stock is healthy. This is not a report that nothing is low.
        </p>
      </div>
    );
  }
  if (coverage.kind === 'none') {
    return (
      <div className="empty-state empty-state-attention">
        <Icon name="alert" size={40} />
        <span className="empty-title">No thresholds have been set here yet</span>
        <p className="empty-body">
          Nothing can show as low until somebody says what low means for it. This is not a report
          that stock is healthy — it is a report that nobody has asked the question.
        </p>
        {canManage ? (
          <button type="button" className="primary-action pressable" onClick={onAddFirst}>
            Set the first threshold
          </button>
        ) : (
          <p className="empty-body">Your manager can set thresholds for this counter.</p>
        )}
      </div>
    );
  }
  return (
    <div className="empty-state empty-good">
      <Icon name="check" size={40} />
      <span className="empty-title">Nothing is below its threshold</span>
      <p className="empty-body">
        All {String(coverage.count)} product{coverage.count === 1 ? '' : 's'} with a threshold at
        this counter are above it.
      </p>
    </div>
  );
}

/** Picking a product that has no threshold yet, from the LOCAL catalogue. */
function ProductPicker({
  products,
  onPick,
  onCancel,
}: {
  readonly products: readonly ProductWithPrice[];
  readonly onPick: (product: ProductWithPrice) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const [productId, setProductId] = useState<string>(products[0]?.id ?? '');
  return (
    <form
      className="threshold-form"
      onSubmit={(e) => {
        e.preventDefault();
        const picked = products.find((p) => p.id === productId);
        if (picked !== undefined) onPick(picked);
      }}
    >
      <label className="threshold-form-field">
        <span>Which product</span>
        <select value={productId} onChange={(e) => setProductId(e.currentTarget.value)}>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.code}
            </option>
          ))}
        </select>
      </label>
      <div className="threshold-form-actions">
        <button type="submit" className="primary-action pressable" disabled={products.length === 0}>
          Continue
        </button>
        <button type="button" className="secondary-action pressable" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export interface LowStockProps {
  readonly db: LocalDb;
  readonly permissions: PermissionsState;
  readonly apiOptions?: ApiCallOptions;
}

type Editing = { readonly kind: 'picking' } | { readonly kind: 'editing'; readonly target: EditTarget } | null;

/**
 * WHERE THIS DEVICE IS, RESOLVED BEFORE ANYTHING IS ASKED.
 *
 * Stock is counted per location, so the question has no meaning until the
 * device can name one. Asking first and re-asking when the location arrives
 * would drop a list that had figures on it back to skeletons a beat later,
 * which at a counter reads as a screen that cannot make up its mind.
 */
export function LowStock({ db, permissions, apiOptions }: LowStockProps): ReactNode {
  const location = useLiveQuery(db, readDeviceLocation, []);

  if (location === undefined) {
    // A local read, so this is a frame or two, not a spinner.
    return (
      <div className="stock-screen">
        <ServerPending shape="cards" what={WHAT} rows={4} />
      </div>
    );
  }

  if (location === null) {
    return (
      <div className="empty-state empty-attn">
        <Icon name="pin" size={40} />
        <span className="empty-title">This device does not know where it is</span>
        <p className="empty-body">
          Stock is counted per location, so this list cannot be produced until this device is
          bound to a counter.
        </p>
      </div>
    );
  }

  return (
    <LowStockAt
      db={db}
      permissions={permissions}
      apiOptions={apiOptions ?? EMPTY_OPTIONS}
      locationId={location.id}
      locationCode={location.code}
      locationName={location.name ?? null}
    />
  );
}

/** Stable identity, so a screen with no test seam does not refetch on render. */
const EMPTY_OPTIONS: ApiCallOptions = {};

/**
 * THE BUTTON (phase2-gate §5.1 D1): seed a threshold for every product this
 * location holds that has none yet — a 25-location, 219-SKU tenant does not set
 * thresholds one at a time. The level is the template's guess (a fraction of
 * what the location opened with), said so on screen, and every one is then an
 * ordinary threshold to tune. Pressing it twice changes nothing.
 */
function SeedThresholds({
  locationId,
  apiOptions,
  onSeeded,
}: {
  readonly locationId: string;
  readonly apiOptions: ApiCallOptions;
  readonly onSeeded: () => void;
}): ReactNode {
  const [state, setState] = useState<
    { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; seeded: number; review: boolean } | { kind: 'failed'; message: string }
  >({ kind: 'idle' });
  const run = async (): Promise<void> => {
    setState({ kind: 'busy' });
    const r = await ensureReorderPoints(locationId, apiOptions);
    if (!r.ok) {
      setState({ kind: 'failed', message: r.failure.message });
      return;
    }
    setState({ kind: 'done', seeded: r.data.seeded, review: r.data.needsFounderReview });
    onSeeded();
  };
  return (
    <div className="seed-thresholds">
      <button type="button" className="secondary-action pressable" disabled={state.kind === 'busy'} onClick={() => void run()}>
        <Icon name="box" size={20} />
        {state.kind === 'busy' ? 'Setting thresholds…' : 'Set thresholds for everything held here'}
      </button>
      {state.kind === 'done' ? (
        <p className="report-note" role="status">
          {state.seeded === 0
            ? 'Every product held here already has a threshold — nothing was changed.'
            : `${String(state.seeded)} threshold${state.seeded === 1 ? '' : 's'} set from the stock held here.`}
          {state.review ? ' Each starts at a quarter of the opening stock — a starting guess to review, not a calculated level.' : ''}
        </p>
      ) : null}
      {state.kind === 'failed' ? (
        <p className="tender-hint" role="alert">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}

function LowStockAt({
  db,
  permissions,
  apiOptions,
  locationId,
  locationCode,
  locationName,
}: {
  readonly db: LocalDb;
  readonly permissions: PermissionsState;
  readonly apiOptions: ApiCallOptions;
  readonly locationId: string;
  readonly locationCode: string;
  readonly locationName: string | null;
}): ReactNode {
  const products = useLiveQuery(db, loadActiveProducts, []);
  const [editing, setEditing] = useState<Editing>(null);

  // Narrowed to THIS counter deliberately. `locationIds` narrows and never
  // widens (the server intersects it with what the caller may see), and the
  // question this screen answers is "what am I about to run out of HERE".
  const { state, refresh } = useApiQuery(
    () => fetchLowStockPicture({ locationIds: [locationId] }, apiOptions),
    [locationId, apiOptions],
  );

  const canManage = holdsCapabilityAt(permissions, CAPABILITY.reorderManage, locationId);

  const closeAndRefresh = useCallback(() => {
    setEditing(null);
    refresh();
  }, [refresh]);

  return (
    <div className="stock-screen">
      <header className="report-panel-head">
        <h2>Low stock · {locationName ?? locationCode}</h2>
        {state.status === 'ready' ? <FetchedAt atMs={state.fetchedAtMs} /> : null}
      </header>

      {state.status === 'loading' ? <ServerPending shape="cards" what={WHAT} slow={state.slow} rows={4} /> : null}
      {state.status === 'failed' ? (
        <ServerUnavailable what={WHAT} failure={state.failure} onRetry={refresh} />
      ) : null}

      {state.status === 'ready' && canManage ? (
        <SeedThresholds locationId={locationId} apiOptions={apiOptions} onSeeded={refresh} />
      ) : null}

      {state.status === 'ready' ? (
        <LowStockBody
          picture={state.data}
          locationId={locationId}
          canManage={canManage}
          products={products ?? []}
          db={db}
          apiOptions={apiOptions}
          editing={editing}
          setEditing={setEditing}
          onSaved={closeAndRefresh}
        />
      ) : null}
    </div>
  );
}

function LowStockBody({
  picture,
  locationId,
  canManage,
  products,
  db,
  apiOptions,
  editing,
  setEditing,
  onSaved,
}: {
  readonly picture: LowStockPicture;
  readonly locationId: string;
  readonly canManage: boolean;
  readonly products: readonly ProductWithPrice[];
  readonly db: LocalDb;
  readonly apiOptions: ApiCallOptions;
  readonly editing: Editing;
  readonly setEditing: (next: Editing) => void;
  readonly onSaved: () => void;
}): ReactNode {
  const alerts = picture.report.alerts;
  const coverage = picture.coverage.get(locationId);

  if (editing !== null) {
    if (editing.kind === 'picking') {
      return (
        <ProductPicker
          products={products}
          onCancel={() => setEditing(null)}
          onPick={(p) =>
            setEditing({
              kind: 'editing',
              target: {
                productId: p.id,
                productName: p.name,
                skuCode: p.code,
                // The scale comes from this device's own catalogue row for a
                // product that has no threshold yet. The server echoes ITS
                // scale back on success, so a disagreement is visible rather
                // than silently applied to the number that was typed.
                qtyScale: p.qtyScale,
                uomCode: p.uomLabel,
                currentQty: null,
              },
            })
          }
        />
      );
    }
    return (
      <ThresholdForm
        target={editing.target}
        locationId={locationId}
        db={db}
        apiOptions={apiOptions}
        onDone={onSaved}
        onCancel={() => setEditing(null)}
      />
    );
  }

  if (alerts.length === 0) {
    return (
      <EmptyList
        coverage={coverage}
        canManage={canManage}
        onAddFirst={() => setEditing({ kind: 'picking' })}
      />
    );
  }

  return (
    <>
      <p className="report-note">
        {String(alerts.length)} product{alerts.length === 1 ? '' : 's'} at or below the level
        somebody set for this counter, most urgent first.
        {coverage !== undefined && coverage.kind === 'configured'
          ? ` ${String(coverage.count)} product${coverage.count === 1 ? ' has' : 's have'} a threshold here.`
          : ''}
      </p>
      <ul className="stock-list" aria-label="Low stock">
        {alerts.map((a) => (
          <AlertRow
            key={a.reorderPointId}
            alert={a}
            canManage={canManage}
            onEdit={() =>
              setEditing({
                kind: 'editing',
                target: {
                  productId: a.productId,
                  productName: a.productName,
                  skuCode: a.skuCode,
                  qtyScale: a.qtyScale,
                  uomCode: a.uomCode,
                  currentQty: a.reorderPointQty,
                },
              })
            }
          />
        ))}
      </ul>
      {canManage ? (
        <button
          type="button"
          className="secondary-action pressable"
          onClick={() => setEditing({ kind: 'picking' })}
        >
          Set a threshold for another product
        </button>
      ) : null}
    </>
  );
}
