/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BUYING — what to order, what has been ordered, and who may authorise it
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ---------------------------------------------------------------------------
 * THE CONTROL THIS SCREEN EXISTS TO HOLD: RAISING ≠ APPROVING
 * ---------------------------------------------------------------------------
 * One person who can both raise an order and authorise it can commit the
 * business to a spend nobody else saw. `purchase.order.create` and
 * `purchase.order.approve` are two separate capabilities and the template puts
 * them in different roles; the server derives the required one from the target
 * status and re-checks it at ingest, against an approval BOUND measured on its
 * own recomputed Σ(lines).
 *
 * So this screen never renders one button that "sends an order". Somebody who
 * can raise an order sees **Submit for approval** and, next to it, a sentence
 * saying who has to sign it off — because a control that silently does nothing
 * is worse than one that is honestly absent, and a control that implies you
 * approved something you did not is worse than both. Hiding **Approve** is a
 * COURTESY; the server refuses the transition regardless (CLAUDE.md §2.6).
 *
 * ---------------------------------------------------------------------------
 * THE STATE MACHINE IS THE DATABASE'S, AND THIS SCREEN ASKS IT
 * ---------------------------------------------------------------------------
 * The legal next steps come from `legalNextStatuses` on the order the server
 * just answered with — read from `app.purchase_order_legal_transitions()` by
 * the router. There is no transition table in this file. A second copy is a
 * second copy that drifts, and it would put a button in front of somebody that
 * the database will refuse.
 *
 * ---------------------------------------------------------------------------
 * REORDER SUGGESTIONS ARE THE PHASE 1 ALERT, NOT A SECOND OPINION
 * ---------------------------------------------------------------------------
 * The suggestion list is `procurement.reorderSuggestions`, which reuses the
 * low-stock alert's own input, its own query and its own `app.reorder_point`
 * rows. There is no second notion of "how low is low" anywhere on this screen.
 *
 * **IT SUGGESTS; IT NEVER ORDERS.** Every suggestion ends at a pre-filled
 * draft that a person still has to price, check and submit. The server refuses
 * to pick a supplier when several exist and none is preferred, because the
 * price it would pick from is decision support that may be a year old — and
 * this screen shows the alternatives instead of choosing for them.
 *
 * ---------------------------------------------------------------------------
 * ONLINE ONLY, AND IT SAYS SO
 * ---------------------------------------------------------------------------
 * Orders and suppliers are in no sync bucket, and raising or approving one is
 * a commitment made against terms and a bound a partitioned device may hold a
 * stale copy of. Nothing here is queued: a failure is a failure, said in the
 * server's own words, with nothing written. RECEIVING is the opposite and
 * works with the radio off — `features/receiving/Receiving.tsx`.
 *
 * Money is minor units end to end and becomes a string only at `<Money>`.
 * A typed price is `parse()`d against the tenant's own currency spec, which
 * refuses anything a float would have accepted.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MoneyError, format, lineNetMinor, parse } from '@erp/money';
import type { PurchaseOrderLineInput } from '@erp/contracts';
import type { ApiCallOptions } from '../../data/api/client';
import {
  changePurchaseOrderStatus,
  createPurchaseOrder,
  fetchPurchaseOrder,
  fetchPurchaseOrders,
  fetchReorderSuggestions,
  fetchSuppliers,
  updatePurchaseOrder,
  type ComparedSource,
  type PurchaseOrderDetail,
  type PurchaseOrderHeader,
  type PurchaseOrderLine,
  type PurchaseOrderStatus,
  type ReorderSuggestion,
  type Supplier,
} from '../../data/api/procurement';
import { CAPABILITY, holdsCapabilityAt, type PermissionsState } from '../../data/api/session';
import { useApiQuery } from '../../data/api/use-api-query';
import type { LocalDb } from '../../data/db';
import {
  loadPurchasableProducts,
  loadPurchaseUnits,
  type PurchasableProduct,
  type PurchaseUnit,
} from '../../data/queries/purchase-units';
import { readDeviceLocation } from '../../data/queries/session';
import { useLiveQuery } from '../../data/use-live-query';
import { businessDateFor } from '../../lib/business-date';
import { formatQtyScaled, oneWholeUnit, parseQtyScaled, QuantityInputError } from '../../lib/quantity';
import { uuidv7 } from '../../lib/uuidv7';
import { useCurrencySpec } from '../../money/CurrencyContext';
import { Money } from '../../money/Money';
import { Icon } from '../../ui/Icon';
import { FetchedAt, ServerPending, ServerUnavailable } from '../shell/ServerAnswer';

const WHAT_ORDERS = 'The order list';
const WHAT_ORDER = 'This order';
const WHAT_SUGGESTIONS = 'What needs ordering';

/** Stable identity, so a screen with no test seam does not refetch on render. */
const EMPTY_OPTIONS: ApiCallOptions = {};

/**
 * Product chrome for the PLATFORM's own closed status vocabulary
 * (`PURCHASE_ORDER_STATUSES` in `@erp/contracts`), so these are product words
 * and not one tenant's (§8.9). `Record<PurchaseOrderStatus, …>` is TOTAL:
 * adding a status to the contract without giving it words does not compile.
 */
const STATUS_COPY: Record<PurchaseOrderStatus, { label: string; note: string }> = {
  DRAFT: { label: 'Draft', note: 'Being written. Nothing is committed and the lines can change.' },
  SUBMITTED: { label: 'Waiting for approval', note: 'Sent for sign-off. The lines are frozen.' },
  APPROVED: { label: 'Approved', note: 'Authorised. Goods may now be signed for against it.' },
  PARTIALLY_RECEIVED: { label: 'Part delivered', note: 'Some of it has arrived.' },
  RECEIVED: { label: 'Delivered', note: 'All of it has arrived.' },
  CANCELLED: { label: 'Cancelled', note: 'Abandoned before anything arrived.' },
  CLOSED: { label: 'Closed', note: 'No more is expected — how a short delivery ends.' },
};

/**
 * WHICH CAPABILITY EACH MOVE NEEDS. The same split the server enforces, and
 * the reason this screen never offers one button for two different acts.
 * Total over the status union, so a new status cannot arrive without somebody
 * deciding who may reach it.
 */
const STATUS_CAPABILITY: Record<PurchaseOrderStatus, string> = {
  DRAFT: CAPABILITY.purchaseOrderCreate,
  SUBMITTED: CAPABILITY.purchaseOrderCreate,
  APPROVED: CAPABILITY.purchaseOrderApprove,
  PARTIALLY_RECEIVED: CAPABILITY.purchaseOrderCreate,
  RECEIVED: CAPABILITY.purchaseOrderCreate,
  CANCELLED: CAPABILITY.purchaseOrderCreate,
  CLOSED: CAPABILITY.purchaseOrderCreate,
};

const MOVE_LABEL: Record<PurchaseOrderStatus, string> = {
  DRAFT: 'Back to draft',
  SUBMITTED: 'Submit for approval',
  APPROVED: 'Approve this order',
  PARTIALLY_RECEIVED: 'Mark part delivered',
  RECEIVED: 'Mark delivered',
  CANCELLED: 'Cancel this order',
  CLOSED: 'Close — expect no more',
};

function isStatus(value: string): value is PurchaseOrderStatus {
  return Object.prototype.hasOwnProperty.call(STATUS_COPY, value);
}

function statusLabel(value: string): string {
  return isStatus(value) ? STATUS_COPY[value].label : value;
}

// ---------------------------------------------------------------------------
// A draft line, as the buyer typed it
// ---------------------------------------------------------------------------

interface DraftLine {
  readonly key: string;
  readonly product: PurchasableProduct;
  readonly unit: PurchaseUnit;
  /** Scaled integer in the PURCHASE unit. */
  readonly qtyOrdered: bigint;
  /** Minor units per ONE purchase unit ×10⁴. */
  readonly unitPriceE4: bigint;
}

/** Once, on the extended amount, never on the unit price (04 §4.13 row 3). */
function draftLineNet(line: DraftLine): bigint {
  return lineNetMinor(line.qtyOrdered, line.unit.buyScale, line.unitPriceE4, 'half-up');
}

/** What one purchase unit costs, for display. Rounded once, never fed back. */
function priceOfOneUnit(rateE4: bigint, scale: number): bigint {
  return lineNetMinor(oneWholeUnit(scale), scale, rateE4, 'half-up');
}

// ---------------------------------------------------------------------------
// Raising an order
// ---------------------------------------------------------------------------

interface Prefill {
  readonly productId: string;
  readonly supplierId: string | null;
  readonly qtyToOrder: bigint | null;
  readonly purchaseUomId: string | null;
}

function DraftOrderForm({
  db,
  suppliers,
  products,
  locationId,
  timeZone,
  apiOptions,
  prefill,
  onRaised,
  onCancel,
}: {
  readonly db: LocalDb;
  readonly suppliers: readonly Supplier[];
  readonly products: readonly PurchasableProduct[];
  readonly locationId: string;
  readonly timeZone: string | null;
  readonly apiOptions: ApiCallOptions;
  readonly prefill: Prefill | null;
  readonly onRaised: (purchaseOrderId: string) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const spec = useCurrencySpec();
  const [supplierId, setSupplierId] = useState(prefill?.supplierId ?? '');
  const [orderDate] = useState(() => businessDateFor(new Date().toISOString(), timeZone));
  const [expectedAt, setExpectedAt] = useState('');
  const [lines, setLines] = useState<readonly DraftLine[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Line editor state.
  const [productId, setProductId] = useState(prefill?.productId ?? '');
  const [units, setUnits] = useState<readonly PurchaseUnit[]>([]);
  const [uomId, setUomId] = useState(prefill?.purchaseUomId ?? '');
  const [qtyText, setQtyText] = useState('');
  const [priceText, setPriceText] = useState('');

  // THE IDEMPOTENCY KEY IS MINTED WHEN THE FORM OPENS, not when Submit is
  // tapped (§8.2). A double-tap, a resumed form and a retry after a timeout
  // all carry the same key, so the server sees one order.
  const keyRef = useRef<string>(uuidv7());

  // Buyable units come from the DEVICE's own `product_uom` rows — the same
  // machinery selling uses, filtered on `can_buy` (04 §4.10).
  useEffect(() => {
    let alive = true;
    if (productId === '') {
      setUnits([]);
      return () => {
        alive = false;
      };
    }
    void loadPurchaseUnits(db, productId).then((next) => {
      if (!alive) return;
      setUnits(next);
      setUomId((current) =>
        next.some((u) => u.uomId === current) ? current : (next[0]?.uomId ?? ''),
      );
    });
    return () => {
      alive = false;
    };
  }, [db, productId]);

  const product = products.find((p) => p.id === productId) ?? null;
  const unit = units.find((u) => u.uomId === uomId) ?? null;
  const total = lines.reduce((a, l) => a + draftLineNet(l), 0n);

  const addLine = useCallback(() => {
    if (product === null || unit === null) {
      setProblem('Pick a product and the unit it is being bought in.');
      return;
    }
    let qty: bigint;
    try {
      qty = parseQtyScaled(qtyText, unit.buyScale);
    } catch (err) {
      setProblem(
        err instanceof QuantityInputError ? err.message : 'That is not a quantity this unit holds.',
      );
      return;
    }
    if (qty <= 0n) {
      setProblem('An order line has to be for something.');
      return;
    }
    let priceMinor: bigint;
    try {
      // The tenant's OWN currency spec decides how many decimals a price may
      // carry; `parse` refuses anything a float would have accepted, and
      // refuses more precision than the currency has (ADR-0004).
      priceMinor = parse(priceText.trim(), spec);
    } catch (err) {
      setProblem(
        err instanceof MoneyError
          ? 'Enter the agreed price using digits, and a dot for any decimals.'
          : 'That is not a price.',
      );
      return;
    }
    if (priceMinor < 0n) {
      setProblem('A price cannot be negative.');
      return;
    }
    setProblem(null);
    setLines((current) => [
      ...current,
      {
        key: uuidv7(),
        product,
        unit,
        qtyOrdered: qty,
        // A price typed at the currency's own precision, carried at the rate's
        // ×10⁴ precision exactly. Nothing is rounded on the way in.
        unitPriceE4: priceMinor * 10_000n,
      },
    ]);
    setQtyText('');
    setPriceText('');
  }, [priceText, product, qtyText, spec, unit]);

  const submit = useCallback(() => {
    if (supplierId === '') {
      setProblem('Say who this order is with.');
      return;
    }
    if (lines.length === 0) {
      setProblem('An order for nothing is not an order. Add a line.');
      return;
    }
    setProblem(null);
    setSaving(true);
    // Typed as the CONTRACT's own line shape: a field the API does not accept,
    // or one it requires and this omits, stops the build.
    const wireLines: PurchaseOrderLineInput[] = lines.map((l, i) => ({
      lineNo: i + 1,
      productId: l.product.id,
      uomId: l.unit.uomId,
      qtyOrdered: l.qtyOrdered.toString(),
      unitPriceE4: l.unitPriceE4.toString(),
    }));
    void createPurchaseOrder(
      {
        idempotencyKey: keyRef.current,
        clientWallAt: new Date().toISOString(),
        supplierId,
        deliverToLocationId: locationId,
        orderDate,
        ...(expectedAt.length === 0 ? {} : { expectedAt }),
        lines: wireLines,
      },
      apiOptions,
    ).then((result) => {
      setSaving(false);
      if (result.ok) {
        keyRef.current = uuidv7();
        onRaised(result.data.purchaseOrderId);
        return;
      }
      // NOTHING WAS QUEUED, and the screen says so. An order is a commitment
      // made against terms this device cannot check offline; a queued one
      // would be a promise nobody had authorised.
      setProblem(
        result.failure.kind === 'offline'
          ? 'Not raised. Orders are kept on the server and this device cannot reach it. Nothing was queued and nothing was ordered.'
          : `Not raised. ${result.failure.detail ?? result.failure.message}`,
      );
    });
  }, [apiOptions, expectedAt, lines, locationId, onRaised, orderDate, supplierId]);

  return (
    <form
      className="threshold-form"
      aria-label="New order"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="threshold-form-field">
        <span>Who it is with</span>
        <select
          value={supplierId}
          aria-label="Supplier"
          onChange={(e) => setSupplierId(e.currentTarget.value)}
        >
          <option value="">Choose a supplier…</option>
          {suppliers
            .filter((s) => s.isActive)
            .map((s) => (
              <option key={s.supplierId} value={s.supplierId}>
                {s.name} · {s.code}
              </option>
            ))}
        </select>
      </label>

      <label className="threshold-form-field">
        <span>Expected (optional)</span>
        <input
          type="date"
          value={expectedAt}
          aria-label="Expected delivery date"
          onChange={(e) => setExpectedAt(e.currentTarget.value)}
        />
      </label>

      <fieldset className="adjust-kinds">
        <legend>Add a line</legend>
        <label className="threshold-form-field">
          <span>Product</span>
          <select
            value={productId}
            aria-label="Product"
            onChange={(e) => setProductId(e.currentTarget.value)}
          >
            <option value="">Choose a product…</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.code}
              </option>
            ))}
          </select>
        </label>
        <label className="threshold-form-field">
          <span>Bought in</span>
          <select
            value={uomId}
            aria-label="Purchase unit"
            onChange={(e) => setUomId(e.currentTarget.value)}
          >
            {units.map((u) => (
              <option key={u.uomId} value={u.uomId}>
                {u.uomLabel}
              </option>
            ))}
          </select>
        </label>
        {unit === null ? null : (
          <p className="adjust-kind-note">
            One {unit.uomCode} is{' '}
            {unit.factorDen === 1n
              ? unit.factorNum.toString()
              : `${unit.factorNum.toString()}/${unit.factorDen.toString()}`}{' '}
            {unit.stockingUomCode} on the shelf.
          </p>
        )}
        <label className="threshold-form-field">
          <span>How many</span>
          <span className="threshold-form-input">
            <input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={qtyText}
              aria-label="Quantity ordered"
              onChange={(e) => setQtyText(e.currentTarget.value)}
            />
            <span className="threshold-form-uom">{unit?.uomCode ?? ''}</span>
          </span>
        </label>
        <label className="threshold-form-field">
          <span>Agreed price for one {unit?.uomCode ?? 'unit'}</span>
          <span className="threshold-form-input">
            <input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={priceText}
              aria-label="Agreed unit price"
              onChange={(e) => setPriceText(e.currentTarget.value)}
            />
          </span>
        </label>
        <button type="button" className="secondary-action pressable" onClick={addLine}>
          Add to the order
        </button>
      </fieldset>

      {lines.length === 0 ? null : (
        <ul className="order-line-list" aria-label="Order lines">
          {lines.map((l) => (
            <li key={l.key} className="order-line">
              <span className="stock-row-head">
                <span className="report-loc-name">{l.product.name}</span>
                <span className="report-loc-code tabular">{l.product.code}</span>
              </span>
              <span className="tabular">
                {formatQtyScaled(l.qtyOrdered, l.unit.buyScale)} {l.unit.uomCode} ×{' '}
                <Money amount={priceOfOneUnit(l.unitPriceE4, l.unit.buyScale)} />
              </span>
              <span className="order-line-net tabular">
                <Money amount={draftLineNet(l)} />
              </span>
              <button
                type="button"
                className="line-remove pressable"
                aria-label={`Remove ${l.product.name}`}
                onClick={() => setLines((c) => c.filter((x) => x.key !== l.key))}
              >
                <Icon name="trash" size={20} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {lines.length === 0 ? null : (
        <p className="total-row">
          <span className="total-label">Order total</span>
          <span className="total-value">
            <Money amount={total} />
          </span>
        </p>
      )}

      {problem === null ? null : (
        <p className="device-gate-error" role="alert">
          <Icon name="alert" size={20} />
          <span>{problem}</span>
        </p>
      )}

      <div className="threshold-form-actions">
        <button type="submit" className="primary-action pressable" disabled={saving}>
          {saving ? 'Raising…' : 'Raise as a draft'}
        </button>
        <button type="button" className="secondary-action pressable" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {/* Raising is not approving, and the form says so before it is tapped. */}
      <p className="adjust-kind-note">
        This creates a draft. It commits nothing until somebody who holds the approval capability
        signs it off — raising an order and authorising it are deliberately two different acts by
        two different people.
      </p>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Correcting an order that has not left DRAFT
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AMENDING IS OFFERED ON A DRAFT AND ON NOTHING ELSE
 * ═══════════════════════════════════════════════════════════════════════════
 * Until this form existed a mistyped quantity meant cancelling the order and
 * raising another one, which puts an abandoned document in the audit trail for
 * a typing slip.
 *
 * The window is DRAFT, and that is the server's rule, not a preference: once
 * an order is submitted its lines are frozen, and once it is approved a silent
 * line change would mean an approval certified nothing — whatever turned up
 * could be written back onto the order afterwards and the receipt would match
 * perfectly. The API refuses every non-DRAFT status with PRECONDITION_FAILED,
 * and 0008's trigger refuses a line edit that never reaches the router at all.
 * So this screen offers the control on DRAFT ALONE rather than offering it
 * everywhere and letting a person discover the refusal after typing. Hiding it
 * remains a courtesy; the boundary is the server's (CLAUDE.md §2.6).
 *
 * ---------------------------------------------------------------------------
 * AN UNTOUCHED LINE IS SENT BACK EXACTLY AS IT WAS AGREED
 * ---------------------------------------------------------------------------
 * Supplying `lines` REPLACES all of them, so every line has to be restated —
 * including the ones nobody edited. Those are sent back as the `bigint` the
 * server itself last computed, NEVER as a value that has been through a text
 * box: a rate is carried at ×10⁴ precision and the currency may not have four
 * decimals, so re-typing an untouched rate is exactly the "round for display,
 * then store the rounded figure" this codebase forbids (ADR-0004). A rate that
 * cannot be typed at the currency's own precision is shown, locked, and said
 * to be locked — it still goes back untouched.
 */
interface AmendRow {
  readonly key: string;
  readonly line: PurchaseOrderLine;
  readonly qtyText: string;
  readonly priceText: string;
  readonly qtyEdited: boolean;
  readonly priceEdited: boolean;
  readonly removed: boolean;
}

/** The rate as a typable amount, or null when it carries sub-minor precision. */
function typableUnitPrice(unitPriceE4: bigint): bigint | null {
  return unitPriceE4 % 10_000n === 0n ? unitPriceE4 / 10_000n : null;
}

function AmendDraftForm({
  order,
  apiOptions,
  onAmended,
  onCancel,
}: {
  readonly order: PurchaseOrderDetail;
  readonly apiOptions: ApiCallOptions;
  readonly onAmended: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const spec = useCurrencySpec();
  const [expectedAt, setExpectedAt] = useState(order.expectedAt ?? '');
  const [notes, setNotes] = useState(order.notes ?? '');
  const [rows, setRows] = useState<readonly AmendRow[]>(() =>
    order.lines.map((line) => {
      const typable = typableUnitPrice(line.unitPriceE4);
      return {
        key: line.purchaseOrderLineId,
        line,
        qtyText: formatQtyScaled(line.qtyOrdered, line.qtyScale),
        priceText: typable === null ? '' : format(typable, spec),
        qtyEdited: false,
        priceEdited: false,
        removed: false,
      };
    }),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Minted when the form opens (§8.2): a double-tap is one amendment.
  const keyRef = useRef<string>(uuidv7());

  const patch = useCallback((key: string, next: Partial<AmendRow>) => {
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...next } : r)));
  }, []);

  const linesTouched = rows.some((r) => r.removed || r.qtyEdited || r.priceEdited);
  const headerTouched = expectedAt !== (order.expectedAt ?? '') || notes !== (order.notes ?? '');

  const submit = useCallback(() => {
    if (!linesTouched && !headerTouched) {
      setProblem('Nothing has been changed, so there is nothing to send.');
      return;
    }
    let wireLines: PurchaseOrderLineInput[] | null = null;
    if (linesTouched) {
      const live = rows.filter((r) => !r.removed);
      if (live.length === 0) {
        setProblem('An order for nothing is not an order. Cancel it instead of emptying it.');
        return;
      }
      const built: PurchaseOrderLineInput[] = [];
      for (const [i, row] of live.entries()) {
        let qty: bigint;
        if (row.qtyEdited) {
          try {
            qty = parseQtyScaled(row.qtyText, row.line.qtyScale);
          } catch (err) {
            setProblem(
              err instanceof QuantityInputError
                ? `${row.line.productName}: ${err.message}`
                : `${row.line.productName}: that is not a quantity this unit holds.`,
            );
            return;
          }
          if (qty <= 0n) {
            setProblem(`${row.line.productName}: an order line has to be for something.`);
            return;
          }
        } else {
          // Untouched: the figure the server itself computed, verbatim.
          qty = row.line.qtyOrdered;
        }

        let unitPriceE4: bigint;
        if (row.priceEdited) {
          let priceMinor: bigint;
          try {
            priceMinor = parse(row.priceText.trim(), spec);
          } catch (err) {
            setProblem(
              err instanceof MoneyError
                ? `${row.line.productName}: enter the agreed price using digits, and a dot for any decimals.`
                : `${row.line.productName}: that is not a price.`,
            );
            return;
          }
          if (priceMinor < 0n) {
            setProblem(`${row.line.productName}: a price cannot be negative.`);
            return;
          }
          unitPriceE4 = priceMinor * 10_000n;
        } else {
          // Untouched: the agreed rate at its own ×10⁴ precision, verbatim.
          unitPriceE4 = row.line.unitPriceE4;
        }

        built.push({
          lineNo: i + 1,
          productId: row.line.productId,
          uomId: row.line.uomId,
          qtyOrdered: qty.toString(),
          unitPriceE4: unitPriceE4.toString(),
          ...(row.line.notes === null ? {} : { notes: row.line.notes }),
        });
      }
      wireLines = built;
    }

    setProblem(null);
    setSaving(true);
    void updatePurchaseOrder(
      {
        idempotencyKey: keyRef.current,
        clientWallAt: new Date().toISOString(),
        purchaseOrderId: order.purchaseOrderId,
        ...(expectedAt.length === 0 ? {} : { expectedAt }),
        ...(notes.trim().length === 0 ? {} : { notes: notes.trim() }),
        ...(wireLines === null ? {} : { lines: wireLines }),
      },
      apiOptions,
    ).then((result) => {
      setSaving(false);
      if (result.ok) {
        keyRef.current = uuidv7();
        onAmended();
        return;
      }
      // NOTHING WAS QUEUED. An amendment is a change to a document that lives
      // on the server, and a queued one would be a correction nobody could see
      // until it drained — beside an order still showing the old figures.
      setProblem(
        result.failure.kind === 'offline'
          ? 'Not changed. Orders are kept on the server and this device cannot reach it. Nothing was queued and the order still says what it said.'
          : `Not changed. ${result.failure.detail ?? result.failure.message}`,
      );
    });
  }, [
    apiOptions,
    expectedAt,
    headerTouched,
    linesTouched,
    notes,
    onAmended,
    order.purchaseOrderId,
    rows,
    spec,
  ]);

  const liveRows = rows.filter((r) => !r.removed);
  const runningTotal = liveRows.reduce((a, r) => {
    if (!r.qtyEdited && !r.priceEdited) return a + r.line.lineNetMinor;
    // Shown from what is currently typed, and only when it parses. An
    // unreadable box contributes nothing rather than a guess.
    let qty: bigint;
    try {
      qty = r.qtyEdited ? parseQtyScaled(r.qtyText, r.line.qtyScale) : r.line.qtyOrdered;
    } catch {
      return a;
    }
    let rate: bigint;
    if (r.priceEdited) {
      try {
        rate = parse(r.priceText.trim(), spec) * 10_000n;
      } catch {
        return a;
      }
    } else {
      rate = r.line.unitPriceE4;
    }
    return a + lineNetMinor(qty, r.line.qtyScale, rate, 'half-up');
  }, 0n);

  return (
    <form
      className="threshold-form"
      aria-label="Correct this order"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="adjust-kind-note">
        This order has not been submitted, so its lines can still be corrected. Once it is sent for
        approval the lines are frozen — the order that was approved and the order goods are signed
        for against have to be the same document.
      </p>
      {/* Said rather than left to be discovered: quantities, prices and whole
          lines can be changed here, and something FORGOTTEN needs a new order.
          A form that silently cannot do a thing is a form somebody hunts
          through twice. */}
      <p className="adjust-kind-note">
        What is on the order can be changed or taken off. Something that was left off it
        altogether has to go on an order of its own.
      </p>

      <label className="threshold-form-field">
        <span>Expected (optional)</span>
        <input
          type="date"
          value={expectedAt}
          aria-label="Expected delivery date"
          onChange={(e) => setExpectedAt(e.currentTarget.value)}
        />
      </label>

      <label className="threshold-form-field">
        <span>Note on the order (optional)</span>
        <input
          type="text"
          autoComplete="off"
          value={notes}
          aria-label="Note on the order"
          onChange={(e) => setNotes(e.currentTarget.value)}
        />
      </label>

      <ul className="order-line-list" aria-label="Lines on this order">
        {rows.map((r) => (
          <li
            key={r.key}
            className={r.removed ? 'order-line-edit order-line-removed' : 'order-line-edit'}
          >
            <span className="stock-row-head">
              <span className="report-loc-name">{r.line.productName}</span>
              <span className="report-loc-code tabular">{r.line.skuCode}</span>
            </span>
            {r.removed ? (
              <>
                <span className="figure-withheld">Will be taken off this order</span>
                <button
                  type="button"
                  className="secondary-action pressable"
                  onClick={() => patch(r.key, { removed: false })}
                >
                  {`Put ${r.line.productName} back`}
                </button>
              </>
            ) : (
              <>
                <label className="threshold-form-field">
                  <span>How many</span>
                  <span className="threshold-form-input">
                    <input
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      value={r.qtyText}
                      aria-label={`Quantity ordered for ${r.line.productName}`}
                      onChange={(e) =>
                        patch(r.key, { qtyText: e.currentTarget.value, qtyEdited: true })
                      }
                    />
                    <span className="threshold-form-uom">{r.line.uomCode}</span>
                  </span>
                </label>
                <label className="threshold-form-field">
                  <span>{`Agreed price for one ${r.line.uomCode}`}</span>
                  <span className="threshold-form-input">
                    <input
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      value={r.priceText}
                      disabled={typableUnitPrice(r.line.unitPriceE4) === null}
                      aria-label={`Agreed unit price for ${r.line.productName}`}
                      onChange={(e) =>
                        patch(r.key, { priceText: e.currentTarget.value, priceEdited: true })
                      }
                    />
                  </span>
                </label>
                {typableUnitPrice(r.line.unitPriceE4) === null ? (
                  <p className="adjust-kind-note">
                    The agreed rate on this line carries more precision than an amount can be typed
                    at, so it is locked here and goes back exactly as it was agreed rather than
                    being rounded to fit a box.
                  </p>
                ) : null}
                <button
                  type="button"
                  className="line-remove pressable"
                  aria-label={`Take ${r.line.productName} off this order`}
                  onClick={() => patch(r.key, { removed: true })}
                >
                  <Icon name="trash" size={20} />
                </button>
              </>
            )}
          </li>
        ))}
      </ul>

      <p className="total-row">
        <span className="total-label">Order total after this correction</span>
        <span className="total-value">
          <Money amount={runningTotal} />
        </span>
      </p>
      <p className="adjust-kind-note">
        A guide only. The server recomputes every line from the conversion it holds and answers
        with its own total, which is the figure an approval is measured against.
      </p>

      {problem === null ? null : (
        <p className="device-gate-error" role="alert">
          <Icon name="alert" size={20} />
          <span>{problem}</span>
        </p>
      )}

      <div className="threshold-form-actions">
        <button type="submit" className="primary-action pressable" disabled={saving}>
          {saving ? 'Correcting…' : 'Save the correction'}
        </button>
        <button type="button" className="secondary-action pressable" onClick={onCancel}>
          Leave it as it is
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// One order, and the moves available on it
// ---------------------------------------------------------------------------

function OrderDetail({
  purchaseOrderId,
  permissions,
  apiOptions,
  onChanged,
  onBack,
}: {
  readonly purchaseOrderId: string;
  readonly permissions: PermissionsState;
  readonly apiOptions: ApiCallOptions;
  readonly onChanged: () => void;
  readonly onBack: () => void;
}): ReactNode {
  const { state, refresh } = useApiQuery(
    () => fetchPurchaseOrder(purchaseOrderId, apiOptions),
    [purchaseOrderId, apiOptions],
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [amending, setAmending] = useState(false);
  const [corrected, setCorrected] = useState(false);
  const keyRef = useRef<string>(uuidv7());

  const move = useCallback(
    (order: PurchaseOrderDetail, toStatus: PurchaseOrderStatus, reason: string) => {
      // The contract refuses a cancellation with no reason, and it is right
      // to: an order abandoned with no explanation is an audit question
      // nobody can answer six months later. Refused HERE as well, because a
      // BAD_REQUEST discovered after the tap is a worse way to learn it.
      const needsReason = toStatus === 'CANCELLED';
      if (needsReason && reason.trim().length === 0) {
        setProblem('Say why. An order cancelled with no explanation cannot be accounted for later.');
        return;
      }
      setProblem(null);
      setMoving(toStatus);
      void changePurchaseOrderStatus(
        {
          idempotencyKey: keyRef.current,
          clientWallAt: new Date().toISOString(),
          purchaseOrderId: order.purchaseOrderId,
          toStatus,
          ...(needsReason ? { reason } : {}),
        },
        apiOptions,
      ).then((result) => {
        setMoving(null);
        if (result.ok) {
          keyRef.current = uuidv7();
          refresh();
          onChanged();
          return;
        }
        setProblem(
          result.failure.kind === 'offline'
            ? 'Not changed. This is kept on the server and this device cannot reach it. Nothing was queued.'
            : `Not changed. ${result.failure.detail ?? result.failure.message}`,
        );
      });
    },
    [apiOptions, onChanged, refresh],
  );

  return (
    <section className="report-panel">
      <header className="report-panel-head">
        <h2>Order</h2>
        {state.status === 'ready' ? <FetchedAt atMs={state.fetchedAtMs} /> : null}
      </header>
      <button type="button" className="secondary-action pressable" onClick={onBack}>
        <Icon name="back" size={20} />
        Back to the list
      </button>

      {state.status === 'loading' ? (
        <ServerPending what={WHAT_ORDER} slow={state.slow} rows={4} />
      ) : null}
      {state.status === 'failed' ? (
        <ServerUnavailable what={WHAT_ORDER} failure={state.failure} onRetry={refresh} />
      ) : null}
      {state.status === 'ready' && amending ? (
        <AmendDraftForm
          order={state.data}
          apiOptions={apiOptions}
          onAmended={() => {
            setAmending(false);
            setCorrected(true);
            refresh();
            onChanged();
          }}
          onCancel={() => setAmending(false)}
        />
      ) : null}

      {state.status === 'ready' && !amending ? (
        <>
          {corrected ? (
            <p className="adjust-saved" role="status">
              <Icon name="check" size={20} />
              <span>
                Corrected. What is below is what the server holds now, with its own recomputed
                total.
              </span>
            </p>
          ) : null}
          <OrderBody
            order={state.data}
            permissions={permissions}
            moving={moving}
            problem={problem}
            onMove={(to, reason) => move(state.data, to, reason)}
            onAmend={() => {
              setCorrected(false);
              setAmending(true);
            }}
          />
        </>
      ) : null}
    </section>
  );
}

function OrderBody({
  order,
  permissions,
  moving,
  problem,
  onMove,
  onAmend,
}: {
  readonly order: PurchaseOrderDetail;
  readonly permissions: PermissionsState;
  readonly moving: string | null;
  readonly problem: string | null;
  readonly onMove: (to: PurchaseOrderStatus, reason: string) => void;
  readonly onAmend: () => void;
}): ReactNode {
  // A cancellation needs an explanation, so the field is on the page next to
  // the button rather than in a dialog that vanishes with what was typed in it.
  const [reason, setReason] = useState('');
  // Only the statuses the DATABASE says are reachable from here.
  const legal = order.legalNextStatuses.filter(isStatus);
  const canReach = (to: PurchaseOrderStatus): boolean =>
    holdsCapabilityAt(permissions, STATUS_CAPABILITY[to], order.deliverToLocationId);
  const offered = legal.filter(canReach);
  const withheld = legal.filter((to) => !canReach(to));
  /**
   * DRAFT AND ONLY DRAFT. `updatePurchaseOrder` is refused by the server on
   * every other status and by 0008's trigger underneath it, so offering the
   * control anywhere else would be offering a refusal. The capability is the
   * same one that raised the order — amending a draft is part of raising it,
   * never part of approving it.
   */
  const canAmend =
    order.status === 'DRAFT' &&
    holdsCapabilityAt(permissions, CAPABILITY.purchaseOrderCreate, order.deliverToLocationId);

  return (
    <>
      <dl className="stock-figures">
        <div>
          <dt>Supplier</dt>
          <dd>
            {order.supplierName} · <span className="tabular">{order.supplierCode}</span>
          </dd>
        </div>
        <div>
          <dt>Delivering to</dt>
          <dd>
            {order.locationName} · <span className="tabular">{order.locationCode}</span>
          </dd>
        </div>
        <div>
          <dt>State</dt>
          <dd>{statusLabel(order.status)}</dd>
        </div>
        <div>
          <dt>Ordered on</dt>
          <dd className="tabular">{order.orderDate}</dd>
        </div>
        {order.expectedAt === null ? null : (
          <div>
            <dt>Expected</dt>
            <dd className="tabular">{order.expectedAt}</dd>
          </div>
        )}
        <div>
          <dt>Total</dt>
          <dd className="tabular">
            <Money amount={order.totalMinor} />
          </dd>
        </div>
      </dl>
      {isStatus(order.status) ? (
        <p className="report-note">{STATUS_COPY[order.status].note}</p>
      ) : null}
      {order.cancelReason === null ? null : (
        <p className="report-note">Cancelled because: {order.cancelReason}</p>
      )}

      <div className="report-table-scroll">
        <table className="report-table">
          <caption>Lines, with what is still outstanding on each</caption>
          <thead>
            <tr>
              <th scope="col">Product</th>
              <th scope="col" className="numeric">
                Ordered
              </th>
              <th scope="col" className="numeric">
                Received
              </th>
              <th scope="col" className="numeric">
                Outstanding
              </th>
              <th scope="col" className="numeric">
                Line
              </th>
            </tr>
          </thead>
          <tbody>
            {order.lines.map((l) => (
              <tr key={l.purchaseOrderLineId}>
                <th scope="row">
                  <span className="report-loc-name">{l.productName}</span>{' '}
                  <span className="report-loc-code tabular">{l.skuCode}</span>
                </th>
                <td className="numeric tabular">
                  {formatQtyScaled(l.qtyOrdered, l.qtyScale)} {l.uomCode}
                </td>
                <td className="numeric tabular">
                  {formatQtyScaled(l.qtyReceived, l.qtyScale)} {l.uomCode}
                </td>
                {/* SIGNED, and deliberately not clamped: a negative is an
                    over-delivery, and hiding it hides the one an invoice will
                    be raised for. */}
                <td className="numeric tabular">
                  {l.qtyOutstanding < 0n ? (
                    <span className="over-delivered">
                      {formatQtyScaled(-l.qtyOutstanding, l.qtyScale)} {l.uomCode} over
                    </span>
                  ) : (
                    `${formatQtyScaled(l.qtyOutstanding, l.qtyScale)} ${l.uomCode}`
                  )}
                </td>
                <td className="numeric tabular">
                  <Money amount={l.lineNetMinor} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              <td className="numeric" />
              <td className="numeric" />
              <td className="numeric" />
              <td className="numeric tabular">
                <Money amount={order.totalMinor} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {problem === null ? null : (
        <p className="device-gate-error" role="alert">
          <Icon name="alert" size={20} />
          <span>{problem}</span>
        </p>
      )}

      {canAmend ? (
        <>
          <button type="button" className="secondary-action pressable" onClick={onAmend}>
            <Icon name="edit" size={20} />
            Correct this order
          </button>
          <p className="adjust-kind-note">
            Quantities, prices and the lines themselves can still be changed while it is a draft.
            After it goes for approval they cannot — correcting an issued order means cancelling
            it and raising another, which is why this is here.
          </p>
        </>
      ) : null}

      {/* Said out loud on an order that has moved on, because "the button is
          missing" and "this can no longer be changed" are not the same
          message, and the second is the one that stops somebody hunting. */}
      {!canAmend &&
      order.status !== 'DRAFT' &&
      holdsCapabilityAt(permissions, CAPABILITY.purchaseOrderCreate, order.deliverToLocationId) ? (
        <p className="report-note">
          This order has left draft, so its lines are frozen and cannot be corrected. The order
          that was approved and the order goods are signed for against have to be the same
          document. Cancel it and raise another if it is wrong.
        </p>
      ) : null}

      {offered.length === 0 && withheld.length === 0 ? (
        <p className="report-note">There is nothing further to do with this order.</p>
      ) : null}

      {offered.includes('CANCELLED') ? (
        <label className="threshold-form-field">
          <span>Why, if you are cancelling it</span>
          <input
            type="text"
            autoComplete="off"
            value={reason}
            aria-label="Reason for cancelling"
            onChange={(e) => setReason(e.currentTarget.value)}
          />
        </label>
      ) : null}

      {offered.length === 0 ? null : (
        <div className="order-actions">
          {offered.map((to) => (
            <button
              key={to}
              type="button"
              className={to === 'APPROVED' ? 'primary-action pressable' : 'secondary-action pressable'}
              disabled={moving !== null}
              onClick={() => onMove(to, reason)}
            >
              {moving === to ? 'Working…' : MOVE_LABEL[to]}
            </button>
          ))}
        </div>
      )}

      {/* THE HONEST HALF. Somebody who may raise an order but not approve one
          is told who has to, rather than shown a button that will be refused —
          and rather than shown nothing, which reads as "there is nothing left
          to do" and leaves an order sitting unsigned. */}
      {withheld.length === 0 ? null : (
        <p className="report-note" role="status">
          <Icon name="alert" size={18} />{' '}
          {withheld.includes('APPROVED')
            ? 'This order still needs approving, and approving is not part of what you do. Somebody who holds that capability at this location has to sign it off.'
            : `Somebody else has to do this next: ${withheld.map((s) => MOVE_LABEL[s]).join(', ')}.`}
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// What needs ordering — the Phase 1 alert, sourced
// ---------------------------------------------------------------------------

/**
 * The sources a human has to choose between, priced IN A COMMON UNIT.
 *
 * `stockScale` is the STOCKING unit's own digit count, carried in from the
 * suggestion rather than assumed — `pricePerStockUnitE4` is a rate per one
 * stocking unit, and reading it at the wrong scale would render a price a
 * hundred or a thousand times out.
 */
function AlternativeList({
  alternatives,
  stockScale,
  uomCode,
}: {
  readonly alternatives: readonly ComparedSource[];
  readonly stockScale: number;
  readonly uomCode: string;
}): ReactNode {
  return (
    <ul className="source-alternatives">
      {alternatives.map((a) => (
        <li key={a.supplierProductId}>
          <span className="report-loc-name">{a.supplierName}</span>{' '}
          <span className="tabular">
            {a.pricePerStockUnitE4 === null ? (
              <span className="figure-withheld">no price on file</span>
            ) : (
              <>
                <Money amount={priceOfOneUnit(a.pricePerStockUnitE4, stockScale)} /> per {uomCode}
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function SuggestionRow({
  suggestion,
  canRaise,
  onOrder,
}: {
  readonly suggestion: ReorderSuggestion;
  readonly canRaise: boolean;
  readonly onOrder: (prefill: Prefill) => void;
}): ReactNode {
  const rec = suggestion.recommendation;
  return (
    <li className="stock-row">
      <span className="stock-row-head">
        <span className="report-loc-name">{suggestion.productName}</span>
        <span className="report-loc-code tabular">{suggestion.skuCode}</span>
      </span>
      <dl className="stock-figures">
        <div>
          <dt>On hand</dt>
          <dd className="tabular">
            {formatQtyScaled(suggestion.qtyOnHand, suggestion.qtyScale)} {suggestion.uomCode}
          </dd>
        </div>
        <div>
          <dt>Threshold</dt>
          <dd className="tabular">
            {formatQtyScaled(suggestion.reorderPointQty, suggestion.qtyScale)} {suggestion.uomCode}
          </dd>
        </div>
        <div>
          <dt>Buy from</dt>
          <dd>
            {rec.supplierName ?? (
              <span className="figure-withheld">
                {String(suggestion.alternativeCount)} sources, none preferred — you choose
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>How much</dt>
          <dd className="tabular">
            {rec.qtyToOrder === null || rec.buyScale === null ? (
              <span className="figure-withheld">
                {rec.qtyUnavailableReason === 'NO_ORDER_UP_TO_LEVEL'
                  ? 'No order-up-to level is set, so nothing says how much'
                  : 'Not until a single source is chosen'}
              </span>
            ) : (
              `${formatQtyScaled(rec.qtyToOrder, rec.buyScale)} ${rec.purchaseUomCode ?? ''}`
            )}
          </dd>
        </div>
        <div>
          <dt>Roughly</dt>
          <dd className="tabular">
            {/* An ESTIMATE from what we last paid. Never a quote, and never a
                zero standing in for "we do not know". */}
            {rec.estimatedCostMinor === null ? (
              <span className="figure-withheld">
                {rec.estimateUnavailableReason === 'NO_RECORDED_PRICE'
                  ? 'Nothing bought from them yet'
                  : 'No estimate'}
              </span>
            ) : (
              <Money amount={rec.estimatedCostMinor} />
            )}
          </dd>
        </div>
      </dl>
      {rec.basis === 'AMBIGUOUS' && suggestion.alternatives.length > 0 ? (
        <AlternativeList
          alternatives={suggestion.alternatives}
          stockScale={suggestion.qtyScale}
          uomCode={suggestion.uomCode}
        />
      ) : null}
      {canRaise ? (
        <button
          type="button"
          className="secondary-action pressable"
          onClick={() =>
            onOrder({
              productId: suggestion.productId,
              supplierId: rec.supplierId,
              qtyToOrder: rec.qtyToOrder,
              purchaseUomId: rec.purchaseUomId,
            })
          }
        >
          Start an order for this
        </button>
      ) : null}
    </li>
  );
}

function SuggestionsPanel({
  locationId,
  canRaise,
  apiOptions,
  onOrder,
}: {
  readonly locationId: string;
  readonly canRaise: boolean;
  readonly apiOptions: ApiCallOptions;
  readonly onOrder: (prefill: Prefill) => void;
}): ReactNode {
  const input = useMemo(() => ({ locationIds: [locationId] }), [locationId]);
  const { state, refresh } = useApiQuery(
    () => fetchReorderSuggestions(input, apiOptions),
    [input, apiOptions],
  );

  return (
    <section className="report-panel">
      <header className="report-panel-head">
        <h2>What needs ordering</h2>
        {state.status === 'ready' ? <FetchedAt atMs={state.fetchedAtMs} /> : null}
      </header>
      {state.status === 'loading' ? (
        <ServerPending what={WHAT_SUGGESTIONS} slow={state.slow} rows={3} />
      ) : null}
      {state.status === 'failed' ? (
        <ServerUnavailable what={WHAT_SUGGESTIONS} failure={state.failure} onRetry={refresh} />
      ) : null}
      {state.status === 'ready' ? (
        <>
          {/* AN EMPTY LIST IS NOT ONE FACT. "Nothing is low" and "nobody has
              said what low means here" look identical as an empty array and
              mean opposite things — the second is reassuring and false. */}
          {state.data.state === 'NO_THRESHOLDS_CONFIGURED' ? (
            <div className="empty-state empty-state-attention">
              <Icon name="alert" size={40} />
              <span className="empty-title">No thresholds have been set here yet</span>
              <p className="empty-body">
                Nothing can show as needing ordering until somebody says what low means for it.
                This is not a report that stock is healthy — it is a report that nobody has asked
                the question.
              </p>
            </div>
          ) : null}
          {state.data.state === 'NOTHING_BELOW_REORDER_POINT' ? (
            <div className="empty-state">
              <Icon name="check" size={40} />
              <span className="empty-title">Nothing is below its threshold</span>
              <p className="empty-body">
                All {String(state.data.activeThresholdCount)} product
                {state.data.activeThresholdCount === 1 ? '' : 's'} with a threshold here are above
                it.
              </p>
            </div>
          ) : null}
          {state.data.unsourced.length > 0 ? (
            <div className="server-answer server-answer-attn" role="status">
              <Icon name="alert" size={28} />
              <div className="server-answer-body">
                <h3 className="server-answer-title">
                  {String(state.data.unsourced.length)} of these has nobody to buy it from
                </h3>
                <p className="server-answer-text">
                  {state.data.unsourced.map((u) => u.productName).join(', ')} — low here, and no
                  active supplier is recorded. These are listed first because they cannot be
                  ordered at all until somebody is.
                </p>
              </div>
            </div>
          ) : null}
          {state.data.suggestions.length > 0 ? (
            <ul className="stock-list" aria-label="Reorder suggestions">
              {state.data.suggestions.map((s) => (
                <SuggestionRow
                  key={s.reorderPointId}
                  suggestion={s}
                  canRaise={canRaise}
                  onOrder={onOrder}
                />
              ))}
            </ul>
          ) : null}
          <p className="report-note">
            These are suggestions built from the same thresholds the stock alert uses and from
            what was last paid, which may be old. Nothing here orders anything on its own.
          </p>
        </>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The order list
// ---------------------------------------------------------------------------

function OrderRow({
  order,
  onOpen,
}: {
  readonly order: PurchaseOrderHeader;
  readonly onOpen: () => void;
}): ReactNode {
  return (
    <li className="order-row">
      <button type="button" className="order-row-open pressable" onClick={onOpen}>
        <span className="stock-row-head">
          <span className="report-loc-name">{order.supplierName}</span>
          <span className="report-loc-code tabular">{order.locationCode}</span>
        </span>
        <span className="order-row-status">{statusLabel(order.status)}</span>
        <span className="order-row-figures tabular">
          {String(order.lineCount)} line{order.lineCount === 1 ? '' : 's'} ·{' '}
          <Money amount={order.totalMinor} /> · {order.orderDate}
        </span>
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export interface PurchasingProps {
  readonly db: LocalDb;
  readonly permissions: PermissionsState;
  readonly apiOptions?: ApiCallOptions;
}

type Mode =
  | { readonly kind: 'list' }
  | { readonly kind: 'order'; readonly purchaseOrderId: string }
  | { readonly kind: 'draft'; readonly prefill: Prefill | null };

export function Purchasing({ db, permissions, apiOptions }: PurchasingProps): ReactNode {
  const location = useLiveQuery(db, readDeviceLocation, []);

  if (location === undefined) {
    // A local read, so this is a frame or two, not a spinner.
    return (
      <div className="buying-screen">
        <ServerPending what={WHAT_ORDERS} rows={3} />
      </div>
    );
  }
  if (location === null) {
    return (
      <div className="empty-state">
        <Icon name="pin" size={40} />
        <span className="empty-title">This device does not know where it is</span>
        <p className="empty-body">
          Goods are ordered to a place, so nothing can be raised until this device is bound to one.
        </p>
      </div>
    );
  }

  return (
    <PurchasingAt
      db={db}
      permissions={permissions}
      apiOptions={apiOptions ?? EMPTY_OPTIONS}
      locationId={location.id}
      locationCode={location.code}
      timeZone={location.timeZone}
    />
  );
}

function PurchasingAt({
  db,
  permissions,
  apiOptions,
  locationId,
  locationCode,
  timeZone,
}: {
  readonly db: LocalDb;
  readonly permissions: PermissionsState;
  readonly apiOptions: ApiCallOptions;
  readonly locationId: string;
  readonly locationCode: string;
  readonly timeZone: string | null;
}): ReactNode {
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const products = useLiveQuery(db, loadPurchasableProducts, []);
  const listInput = useMemo(() => ({ locationIds: [locationId] }), [locationId]);
  const { state, refresh } = useApiQuery(
    () => fetchPurchaseOrders(listInput, apiOptions),
    [listInput, apiOptions],
  );
  const supplierQuery = useApiQuery(() => fetchSuppliers({}, apiOptions), [apiOptions]);
  // NO HLC CLOCK HERE, deliberately. A claimed HLC is what an OUTBOX write
  // carries so the server can order it against other device writes; nothing on
  // this screen is queued, so there is nothing to order. `features/receiving`
  // is the screen that has one.

  const canRaise = holdsCapabilityAt(permissions, CAPABILITY.purchaseOrderCreate, locationId);

  const onRaised = useCallback(
    (purchaseOrderId: string) => {
      setMode({ kind: 'order', purchaseOrderId });
      refresh();
    },
    [refresh],
  );

  if (mode.kind === 'order') {
    return (
      <div className="buying-screen">
        <OrderDetail
          purchaseOrderId={mode.purchaseOrderId}
          permissions={permissions}
          apiOptions={apiOptions}
          onChanged={refresh}
          onBack={() => setMode({ kind: 'list' })}
        />
      </div>
    );
  }

  if (mode.kind === 'draft') {
    const suppliers = supplierQuery.state.status === 'ready' ? supplierQuery.state.data.suppliers : [];
    return (
      <div className="buying-screen">
        <section className="report-panel">
          <header className="report-panel-head">
            <h2>New order · {locationCode}</h2>
          </header>
          {supplierQuery.state.status === 'loading' ? (
            <ServerPending what="The supplier list" slow={supplierQuery.state.slow} rows={2} />
          ) : null}
          {supplierQuery.state.status === 'failed' ? (
            <ServerUnavailable
              what="The supplier list"
              failure={supplierQuery.state.failure}
              onRetry={supplierQuery.refresh}
            />
          ) : null}
          {supplierQuery.state.status === 'ready' ? (
            <DraftOrderForm
              db={db}
              suppliers={suppliers}
              products={products ?? []}
              locationId={locationId}
              timeZone={timeZone}
              apiOptions={apiOptions}
              prefill={mode.prefill}
              onRaised={onRaised}
              onCancel={() => setMode({ kind: 'list' })}
            />
          ) : null}
        </section>
      </div>
    );
  }

  return (
    <div className="buying-screen">
      <SuggestionsPanel
        locationId={locationId}
        canRaise={canRaise}
        apiOptions={apiOptions}
        onOrder={(prefill) => setMode({ kind: 'draft', prefill })}
      />

      <section className="report-panel">
        <header className="report-panel-head">
          <h2>Orders · {locationCode}</h2>
          {state.status === 'ready' ? <FetchedAt atMs={state.fetchedAtMs} /> : null}
        </header>

        {canRaise ? (
          <button
            type="button"
            className="primary-action pressable"
            onClick={() => setMode({ kind: 'draft', prefill: null })}
          >
            <Icon name="plus" size={20} />
            Raise an order
          </button>
        ) : null}

        {state.status === 'loading' ? (
          <ServerPending what={WHAT_ORDERS} slow={state.slow} rows={4} />
        ) : null}
        {state.status === 'failed' ? (
          <ServerUnavailable what={WHAT_ORDERS} failure={state.failure} onRetry={refresh} />
        ) : null}
        {state.status === 'ready' ? (
          state.data.orders.length === 0 ? (
            <div className="empty-state">
              <Icon name="receipt" size={40} />
              <span className="empty-title">No orders here yet</span>
              <p className="empty-body">
                Nothing has been ordered to this place. Anything low will show above.
              </p>
            </div>
          ) : (
            <>
              <p className="report-note">
                {String(state.data.orderCount)} order
                {state.data.orderCount === 1 ? '' : 's'} totalling{' '}
                <Money amount={state.data.totalMinor} /> across{' '}
                {state.data.scope.network
                  ? 'the whole organisation'
                  : `${String(state.data.scope.locationCount)} place${state.data.scope.locationCount === 1 ? '' : 's'} you can see`}
                .
              </p>
              <ul className="order-list" aria-label="Purchase orders">
                {state.data.orders.map((o) => (
                  <OrderRow
                    key={o.purchaseOrderId}
                    order={o}
                    onOpen={() => setMode({ kind: 'order', purchaseOrderId: o.purchaseOrderId })}
                  />
                ))}
              </ul>
            </>
          )
        ) : null}
      </section>
    </div>
  );
}
