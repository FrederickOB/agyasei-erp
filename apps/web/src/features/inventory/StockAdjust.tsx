/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STOCK ADJUSTMENT — and the one thing that makes it different from every
 * other screen added this pass
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reporting, the low-stock alert and the credit position are all server READS
 * of things this device does not hold, so each of them says "not available
 * offline" and shows nothing. **This screen is a WRITE, and it works offline.**
 *
 * Twenty bags broke in the yard whether or not the tower is up. A screen that
 * refused to record that until the radio came back would teach a yard hand to
 * keep the count in his head, which is the ledger this product exists to
 * replace. So an adjustment is recorded LOCALLY, atomically, in single-digit
 * milliseconds, and drains through the same ordered outbox a sale does — same
 * client-minted idempotency key, same completion only on the server's own ack,
 * same visible attention state when the server definitively refuses it
 * (`data/mutations/adjustStock.ts`, `data/sync/upload.ts`).
 *
 * Nothing on this screen awaits a socket and no control on it spins.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS SAID, AND WHAT IS CAREFULLY NOT SAID
 * ---------------------------------------------------------------------------
 * The confirmation after a save is *"Recorded on this device"* and the row
 * carries `Waiting to send` until the server acks it. It never says "saved",
 * because at that moment nothing has reached the server and the difference is
 * the whole of §8.5. The badge changes on its own when the ack lands.
 *
 * This screen also does NOT show what is on hand. On-hand is `stock.view` at
 * the location and is a SERVER read (`inventory.onHand`) that a partitioned
 * device cannot answer, and a resulting-balance figure beside a quantity field
 * is precisely the confident wrong number this codebase keeps refusing to
 * print. The adjustment is a signed DELTA; that is what is captured and that
 * is all that is shown.
 *
 * ---------------------------------------------------------------------------
 * WHO IS OFFERED THE FORM
 * ---------------------------------------------------------------------------
 * `stock.adjust` AT THIS LOCATION. Counter staff hold `stock.view` and do not
 * hold this. Hiding the form is a COURTESY that saves somebody filling it in
 * for nothing — the server derives the same capability from the movement's
 * `sourceKind` and re-checks it at ingest, so the write is refused there
 * regardless of what this screen offered (CLAUDE.md §2.6).
 *
 * Quantities are scaled integers in each product's STOCKING unit, typed
 * through `parseQtyScaled`, which refuses anything a float would have accepted
 * (ADR-0004). No unit is converted anywhere on this screen.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CAPABILITY, holdsCapabilityAt, type PermissionsState } from '../../data/api/session';
import type { LocalDb } from '../../data/db';
import {
  MOVEMENT_DIRECTION,
  recordAdjustment,
  ADJUSTMENT_KINDS,
  type AdjustmentKind,
} from '../../data/mutations/adjustStock';
import { recentAdjustments, type RecordedAdjustment } from '../../data/queries/adjustments';
import { getOrCreateDeviceNode } from '../../data/queries/config';
import { loadMovementReasons, type MovementReason } from '../../data/queries/movement-reasons';
import { loadStockedProducts, type StockedProduct } from '../../data/queries/products';
import { readDeviceLocation } from '../../data/queries/session';
import { useLiveQuery } from '../../data/use-live-query';
import { recordBadgeLabel } from '../../lib/badges';
import { createClaimedHlcClock, type ClaimedHlcClock } from '../../lib/hlc';
import { formatQtyScaled, parseQtyScaled, QuantityInputError } from '../../lib/quantity';
import { uuidv7 } from '../../lib/uuidv7';
import { Icon } from '../../ui/Icon';

// ---------------------------------------------------------------------------
// Product chrome for the PLATFORM's document kinds
// ---------------------------------------------------------------------------

/**
 * These are the platform's own closed vocabulary (`DIRECT_MOVEMENT_KINDS` in
 * `@erp/contracts`), so naming them here is product copy, not tenant
 * vocabulary — unlike the reason codes below, which are the tenant's words and
 * are rendered from the tenant's own rows (§8.9).
 *
 * `Record<AdjustmentKind, …>` is total: adding a kind to the adjust family
 * without giving it words does not compile.
 */
const KIND_COPY: Record<AdjustmentKind, { readonly label: string; readonly note: string }> = {
  CORRECTION: {
    label: 'Correction',
    note: 'The count on the shelf and the count in the book disagree. Can go either way.',
  },
  WRITE_OFF: {
    label: 'Write-off',
    note: 'Stock that no longer exists — broken, spoiled, gone. Always takes stock out.',
  },
  RETURN_TO_SUPPLIER: {
    label: 'Return to supplier',
    note: 'Goods going back where they came from. Always takes stock out.',
  },
  OPENING: {
    label: 'Opening count',
    note: 'The first count of something this location has never held before. Always puts stock in.',
  },
};

type Direction = 'add' | 'remove';

function directionsFor(kind: AdjustmentKind): readonly Direction[] {
  switch (MOVEMENT_DIRECTION[kind]) {
    case 'in':
      return ['add'];
    case 'out':
      return ['remove'];
    case 'either':
      return ['add', 'remove'];
  }
}

const DIRECTION_LABEL: Record<Direction, string> = {
  add: 'Adds to the count',
  remove: 'Takes off the count',
};

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

type Saved = { readonly qtyDelta: bigint; readonly product: StockedProduct } | null;

function AdjustForm({
  db,
  products,
  reasons,
  hlc,
  onSaved,
}: {
  readonly db: LocalDb;
  readonly products: readonly StockedProduct[];
  readonly reasons: readonly MovementReason[];
  readonly hlc: ClaimedHlcClock;
  readonly onSaved: (saved: NonNullable<Saved>) => void;
}): ReactNode {
  const [productId, setProductId] = useState<string>('');
  const [kind, setKind] = useState<AdjustmentKind>('CORRECTION');
  const [direction, setDirection] = useState<Direction>('remove');
  const [qtyText, setQtyText] = useState('');
  const [reasonCode, setReasonCode] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // THE IDEMPOTENCY KEY IS MINTED WHEN THE FORM OPENS, not when Save is
  // tapped — the same discipline as the sale id (§8.2). A double-tap, a
  // resumed form and a retry after a crash all carry the same key, so the
  // server sees one movement however many times it arrives.
  const keyRef = useRef<string>(uuidv7());

  const product = products.find((p) => p.id === productId) ?? null;
  const allowed = directionsFor(kind);
  const effectiveDirection = allowed.includes(direction) ? direction : (allowed[0] as Direction);

  const save = useCallback(() => {
    if (product === null) {
      setProblem('Pick the product this adjustment is about.');
      return;
    }
    // A reason is required, and it is required HERE rather than only by the
    // server: CLAUDE.md §3 lists "adjustments with reason codes" as one thing,
    // and a server refusal for a missing reason arrives as a
    // PRECONDITION_FAILED that the drain classes retryable — it would wedge
    // the queue rather than come back to this person.
    if (reasonCode.length === 0) {
      setProblem('Pick a reason. An adjustment without one cannot be explained later.');
      return;
    }
    let magnitude: bigint;
    try {
      magnitude = parseQtyScaled(qtyText, product.qtyScale);
    } catch (err) {
      setProblem(
        err instanceof QuantityInputError
          ? err.message
          : 'That is not a quantity this unit can hold.',
      );
      return;
    }
    if (magnitude === 0n) {
      setProblem('An adjustment has to change the count by something.');
      return;
    }
    const qtyDelta = effectiveDirection === 'remove' ? -magnitude : magnitude;

    setProblem(null);
    setSaving(true);
    void recordAdjustment(db, {
      movementId: keyRef.current,
      productId: product.id,
      qtyDelta,
      kind,
      reasonCode,
      hlc,
    }).then(
      () => {
        setSaving(false);
        // The key has been spent. A fresh one for the next adjustment.
        keyRef.current = uuidv7();
        setQtyText('');
        setReasonCode('');
        onSaved({ qtyDelta, product });
      },
      (err: unknown) => {
        setSaving(false);
        // Refused BEFORE anything was queued, with the cart-equivalent still
        // on screen: nothing was dropped and nothing was sent.
        setProblem(
          err instanceof Error
            ? err.message
            : 'This adjustment was not recorded, and nothing was queued.',
        );
      },
    );
  }, [db, effectiveDirection, hlc, kind, onSaved, product, qtyText, reasonCode]);

  return (
    <form
      className="adjust-form"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label className="threshold-form-field">
        <span>Which product</span>
        <select value={productId} onChange={(e) => setProductId(e.currentTarget.value)}>
          <option value="">Choose a product…</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.code}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="adjust-kinds">
        <legend>What kind of adjustment</legend>
        <div className="adjust-kind-row">
          {ADJUSTMENT_KINDS.map((k) => (
            <label key={k} className={`adjust-kind pressable${kind === k ? ' adjust-kind-on' : ''}`}>
              <input
                type="radio"
                name="adjust-kind"
                value={k}
                checked={kind === k}
                onChange={() => setKind(k)}
              />
              <span>{KIND_COPY[k].label}</span>
            </label>
          ))}
        </div>
        <p className="adjust-kind-note">{KIND_COPY[kind].note}</p>
      </fieldset>

      {/* The sign is never implied. Either the operator chooses it, or the
          screen states the only direction this kind of movement can go — which
          is the same rule the stock ledger's own CHECK enforces. */}
      {allowed.length > 1 ? (
        <fieldset className="adjust-kinds">
          <legend>Which way</legend>
          <div className="adjust-kind-row">
            {allowed.map((d) => (
              <label
                key={d}
                className={`adjust-kind pressable${effectiveDirection === d ? ' adjust-kind-on' : ''}`}
              >
                <input
                  type="radio"
                  name="adjust-direction"
                  value={d}
                  checked={effectiveDirection === d}
                  onChange={() => setDirection(d)}
                />
                <span>{DIRECTION_LABEL[d]}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : (
        <p className="adjust-kind-note" role="note">
          {DIRECTION_LABEL[effectiveDirection]}.
        </p>
      )}

      <label className="threshold-form-field">
        <span>How much</span>
        <span className="threshold-form-input">
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={qtyText}
            aria-label={
              product === null
                ? 'Quantity'
                : `Quantity in ${product.uomLabel}`
            }
            onChange={(e) => setQtyText(e.currentTarget.value)}
          />
          <span className="threshold-form-uom">{product?.uomLabel ?? ''}</span>
        </span>
      </label>

      {/* The tenant's OWN words, from the tenant's own rows. Nothing in this
          file compares one of these codes to a literal (§8.9). */}
      <label className="threshold-form-field">
        <span>Why</span>
        <select
          value={reasonCode}
          aria-label="Reason"
          onChange={(e) => setReasonCode(e.currentTarget.value)}
        >
          <option value="">Choose a reason…</option>
          {reasons.map((r) => (
            <option key={r.code} value={r.code}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      {reasons.length === 0 ? (
        <p className="adjust-kind-note">
          This device has not received the list of reasons yet. An adjustment cannot be recorded
          without one.
        </p>
      ) : null}

      {problem === null ? null : (
        <p className="device-gate-error" role="alert">
          <Icon name="alert" size={20} />
          <span>{problem}</span>
        </p>
      )}

      <div className="threshold-form-actions">
        <button
          type="submit"
          className="primary-action pressable"
          disabled={saving || reasons.length === 0}
        >
          {saving ? 'Recording…' : 'Record adjustment'}
        </button>
      </div>
      <p className="adjust-offline-note">
        <Icon name="cloud-off" size={18} />
        Recorded on this device straight away, connection or not, and sent when there is one.
      </p>
    </form>
  );
}

// ---------------------------------------------------------------------------
// What this device has recorded
// ---------------------------------------------------------------------------

function AdjustmentRow({
  adjustment,
  products,
  reasons,
}: {
  readonly adjustment: RecordedAdjustment;
  readonly products: readonly StockedProduct[];
  readonly reasons: readonly MovementReason[];
}): ReactNode {
  const product = products.find((p) => p.id === adjustment.productId) ?? null;
  const reason = reasons.find((r) => r.code === adjustment.reasonCode) ?? null;
  const scale = product?.qtyScale ?? 0;
  const outward = adjustment.qtyDelta < 0n;
  return (
    <li className={`adjust-row${adjustment.syncState === 'attention' ? ' adjust-row-attn' : ''}`}>
      <span className="stock-row-head">
        <span className="report-loc-name">{product?.name ?? 'A product this device no longer holds'}</span>
        <span className="report-loc-code tabular">{product?.code ?? adjustment.productId}</span>
      </span>
      <span className="adjust-delta tabular">
        {outward ? '−' : '+'}
        {formatQtyScaled(outward ? -adjustment.qtyDelta : adjustment.qtyDelta, scale)}{' '}
        {product?.uomLabel ?? ''}
      </span>
      <span className="adjust-meta">
        <span>{adjustment.kind === null ? '' : KIND_COPY[adjustment.kind].label}</span>
        <span>{reason?.name ?? adjustment.reasonCode}</span>
        <span className="tabular">{adjustment.businessDate}</span>
      </span>
      <span className={`sync-badge badge-${adjustment.syncState}`}>
        <Icon
          name={
            adjustment.syncState === 'synced'
              ? 'check'
              : adjustment.syncState === 'pending'
                ? 'clock'
                : 'alert'
          }
          size={14}
        />
        {recordBadgeLabel(adjustment.syncState)}
      </span>
      {/* A definitive refusal is WORK, not a toast that disappears. The stock
          has moved in the yard and the ledger does not know: the row stays
          here, named, with the server's own sentence on it. */}
      {adjustment.syncState === 'attention' ? (
        <p className="adjust-rejected" role="status">
          <Icon name="alert" size={18} />
          <span>
            The office refused this adjustment, so the count there has not changed. Tell your
            manager.
            {adjustment.rejectReason === null ? null : (
              <>
                {' '}
                <span className="server-answer-detail-label">They will want to know:</span>{' '}
                <span className="tabular">{adjustment.rejectReason}</span>
              </>
            )}
          </span>
        </p>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export interface StockAdjustProps {
  readonly db: LocalDb;
  readonly permissions: PermissionsState;
}

export function StockAdjust({ db, permissions }: StockAdjustProps): ReactNode {
  const location = useLiveQuery(db, readDeviceLocation, []);
  const products = useLiveQuery(db, loadStockedProducts, []);
  const reasons = useLiveQuery(db, loadMovementReasons, []);
  const adjustments = useLiveQuery(db, (d) => recentAdjustments(d, 20), []);
  const [hlc, setHlc] = useState<ClaimedHlcClock | null>(null);
  const [saved, setSaved] = useState<Saved>(null);

  useEffect(() => {
    let alive = true;
    void getOrCreateDeviceNode(db).then((node) => {
      if (alive) setHlc(createClaimedHlcClock(node));
    });
    return () => {
      alive = false;
    };
  }, [db]);

  const onSaved = useCallback((next: NonNullable<Saved>) => setSaved(next), []);

  const canAdjust = useMemo(
    () =>
      location === undefined || location === null
        ? false
        : holdsCapabilityAt(permissions, CAPABILITY.stockAdjust, location.id),
    [location, permissions],
  );

  if (location === undefined) {
    // A local read: a frame or two, not a spinner. Nothing on this screen ever
    // waits on a network.
    return <div className="adjust-screen" />;
  }

  if (location === null) {
    return (
      <div className="empty-state empty-attn">
        <Icon name="pin" size={40} />
        <span className="empty-title">This device does not know where it is</span>
        <p className="empty-body">
          Stock is counted per location, so an adjustment cannot be recorded until this device is
          bound to a counter.
        </p>
      </div>
    );
  }

  return (
    <div className="adjust-screen">
      <header className="report-panel-head">
        <h2>Adjust stock · {location.code}</h2>
      </header>

      {canAdjust ? (
        hlc === null ? (
          <div className="adjust-screen" />
        ) : (
          <>
            {saved === null ? null : (
              <p className="adjust-saved" role="status">
                <Icon name="check" size={20} />
                <span>
                  Recorded on this device: {saved.qtyDelta < 0n ? '−' : '+'}
                  {formatQtyScaled(
                    saved.qtyDelta < 0n ? -saved.qtyDelta : saved.qtyDelta,
                    saved.product.qtyScale,
                  )}{' '}
                  {saved.product.uomLabel} of {saved.product.name}. It is waiting to send — it has
                  not reached the office yet.
                </span>
              </p>
            )}
            <AdjustForm
              db={db}
              products={products ?? []}
              reasons={reasons ?? []}
              hlc={hlc}
              onSaved={onSaved}
            />
          </>
        )
      ) : (
        <section className="server-answer server-answer-calm" role="status">
          <Icon name="alert" size={28} />
          <div className="server-answer-body">
            <h3 className="server-answer-title">Changing a count is not part of what you do.</h3>
            <p className="server-answer-text">
              Your manager can record an adjustment for this counter. Anything already recorded on
              this device is listed below so you can see whether it went through.
            </p>
          </div>
        </section>
      )}

      <h3 className="adjust-list-head">Recorded on this device</h3>
      {adjustments === undefined ? (
        <ul className="adjust-list" aria-hidden="true">
          {Array.from({ length: 3 }, (_, i) => (
            <li key={i} className="skeleton skeleton-row" />
          ))}
        </ul>
      ) : adjustments.length === 0 ? (
        <div className="empty-state">
          <Icon name="tag" size={40} />
          <span className="empty-title">No adjustments yet</span>
          <p className="empty-body">
            Adjustments recorded here appear in this list with their sending state — including the
            ones recorded while offline.
          </p>
        </div>
      ) : (
        <ul className="adjust-list" aria-label="Recorded adjustments">
          {adjustments.map((a) => (
            <AdjustmentRow
              key={a.id}
              adjustment={a}
              products={products ?? []}
              reasons={reasons ?? []}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
