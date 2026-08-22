/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RECEIVING — the yard screen, and the only Phase 2 screen that works with
 * the radio off
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Buying is a conversation with a server: suppliers, terms, approval bounds.
 * RECEIVING IS NOT. The truck is at the gate, the bags are on the ground, and
 * whether the tower is up has nothing to do with either fact. A screen that
 * refused to record them until the connection came back would teach a yard
 * hand to write it on a pad — and the pad never reaches the ledger.
 *
 * So a receipt is recorded LOCALLY, atomically, in single-digit milliseconds,
 * and drains through the same ordered outbox a sale does: same client-minted
 * idempotency key, same completion only on the server's own per-key ack, same
 * visible attention state when the server definitively refuses it
 * (`data/mutations/recordGoodsReceipt.ts`, `data/sync/upload.ts`). Nothing on
 * this screen awaits a socket and no control on it spins.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS SAID, AND WHAT IS CAREFULLY NOT SAID
 * ---------------------------------------------------------------------------
 * The confirmation after signing is *"Recorded on this device"* and the row
 * carries `Waiting to send` until the server acks it. It never says the office
 * knows, because at that moment the office does not, and the difference is the
 * whole of §8.5. The badge changes on its own when the ack lands.
 *
 * ---------------------------------------------------------------------------
 * SHORT AND OVER ARE NORMAL TRADE. THEY ARE NOT AN ERROR PATH.
 * ---------------------------------------------------------------------------
 * Ten tonnes ordered, nine and a half invoiced, 190 bags counted off the truck
 * are THREE FACTS, not one fact and two mistakes. Recording the variance is
 * the ordinary path here: the quantity field opens on what is outstanding and
 * a yard hand simply types what turned up. The difference is shown as it is
 * typed, in words, with no red and no confirmation to dismiss — because a
 * screen that treats a short delivery as an error is a screen a yard hand
 * learns to route around, and a routed-around screen is a wrong ledger.
 *
 * ---------------------------------------------------------------------------
 * TWO QUANTITIES, AND ONE SIGNATURE
 * ---------------------------------------------------------------------------
 * `qtyReceived` is what the supplier invoiced, in THEIR unit. `qtyStock` is
 * what was counted, in the stocking unit, and is the only figure the movement
 * ledger sees. The screen shows what the conversion says — computed with the
 * SAME expression the server runs (`toStockQty`), so the two can never
 * disagree — and accepts it silently. Only when somebody OVERRIDES that figure
 * does the line ask for a signature, because at that point the invoice and the
 * yard disagree and a person is asserting which is right (04 §4.4.4).
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS A TAKE-DOWN, AND WHY IT IS NOT A STALE FIGURE
 * ---------------------------------------------------------------------------
 * Orders and suppliers are in NO sync bucket, so a partitioned device cannot
 * be handed the list of what is expected. The yard therefore takes a copy
 * while it has a connection, exactly as it would carry a printed one to the
 * gate. Every screen that reads that copy shows the minute it was taken and
 * says it is a copy; the one figure that can move behind the yard's back is
 * named `qtyOutstandingAtTakeDown` all the way through, and the server
 * recomputes the real one when the write lands
 * (`data/queries/takedown.ts`).
 *
 * ---------------------------------------------------------------------------
 * WHO IS OFFERED THE FORM
 * ---------------------------------------------------------------------------
 * `goods.receive` AT THIS LOCATION — deliberately not `purchase.order.approve`
 * and not `stock.adjust`. One person who can both authorise an order and sign
 * for its goods can fabricate a receipt against an order they invented. Hiding
 * the form is a COURTESY; the server re-checks the capability at the receiving
 * location on every drain, days later, from the database (CLAUDE.md §2.6).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MoneyError, lineNetMinor, parse } from '@erp/money';
import type { ApiCallOptions } from '../../data/api/client';
import {
  fetchPurchaseOrder,
  fetchPurchaseOrders,
  fetchSuppliers,
} from '../../data/api/procurement';
import { CAPABILITY, holdsCapabilityAt, type PermissionsState } from '../../data/api/session';
import { useApiQuery } from '../../data/api/use-api-query';
import type { LocalDb } from '../../data/db';
import {
  recordGoodsReceipt,
  varianceOf,
  type ReceiptLineDraft,
  type ReceiptVariance,
} from '../../data/mutations/recordGoodsReceipt';
import { getOrCreateDeviceNode } from '../../data/queries/config';
import { recentReceipts, type QueuedReceipt } from '../../data/queries/procurement-outbox';
import {
  loadPurchasableProducts,
  loadPurchaseUnits,
  toStockQty,
  withinTolerance,
  type PurchasableProduct,
  type PurchaseUnit,
} from '../../data/queries/purchase-units';
import { readDeviceLocation } from '../../data/queries/session';
import {
  clearTakeDown,
  orderToTakeDown,
  readTakeDown,
  supplierToTakeDown,
  writeTakeDown,
  type TakeDown,
  type TakenDownLine,
  type TakenDownOrder,
  type TakenDownSupplier,
} from '../../data/queries/takedown';
import { useLiveQuery } from '../../data/use-live-query';
import { recordBadgeLabel } from '../../lib/badges';
import { createClaimedHlcClock, type ClaimedHlcClock } from '../../lib/hlc';
import { formatQtyScaled, oneWholeUnit, parseQtyScaled, QuantityInputError } from '../../lib/quantity';
import { uuidv7 } from '../../lib/uuidv7';
import { useCurrencySpec } from '../../money/CurrencyContext';
import { Money } from '../../money/Money';
import { Icon } from '../../ui/Icon';
import { FetchedAt, ServerPending, ServerUnavailable } from '../shell/ServerAnswer';

const WHAT_EXPECTED = 'What is expected here';

/** Stable identity, so a screen with no test seam does not refetch on render. */
const EMPTY_OPTIONS: ApiCallOptions = {};

/** The statuses a receipt may be signed against. The server refuses the rest. */
const RECEIVABLE = ['APPROVED', 'PARTIALLY_RECEIVED'] as const;

function clockTime(atMs: number): string {
  const d = new Date(atMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const VARIANCE_WORDS: Record<ReceiptVariance, string> = {
  MATCHED: 'Exactly what was outstanding',
  SHORT: 'Short of what was outstanding',
  OVER: 'More than was outstanding',
  NO_ORDER: 'Not against an order',
};

// ---------------------------------------------------------------------------
// One line of the form
// ---------------------------------------------------------------------------

interface LineState {
  readonly key: string;
  readonly productId: string;
  readonly productName: string;
  readonly skuCode: string;
  /** Present only when this line matches an order line. */
  readonly purchaseOrderLineId: string | null;
  /** In the supplier's unit, at the take-down. Null for an unordered line. */
  readonly qtyExpected: bigint | null;
  readonly unit: PurchaseUnit;
  readonly qtyText: string;
  /** Empty until somebody overrides the conversion. */
  readonly countedText: string;
  readonly costText: string;
  readonly include: boolean;
}

interface LineFigures {
  readonly qtyReceived: bigint | null;
  readonly qtyComputed: bigint | null;
  readonly qtyCounted: bigint | null;
  readonly variance: ReceiptVariance;
  readonly overridden: boolean;
  readonly beyondTolerance: boolean;
  readonly problem: string | null;
}

/**
 * Everything derivable from what has been typed, computed on every keystroke
 * so the variance is visible while it is being entered rather than after.
 *
 * `qtyComputed` uses the SAME expression the server runs when the write lands.
 * If the two disagreed, every line would look like a variance the moment it
 * uploaded.
 */
function figuresFor(line: LineState): LineFigures {
  let qtyReceived: bigint | null = null;
  let problem: string | null = null;
  try {
    qtyReceived = line.qtyText.trim().length === 0 ? null : parseQtyScaled(line.qtyText, line.unit.buyScale);
  } catch (err) {
    problem = err instanceof QuantityInputError ? err.message : 'That is not a quantity.';
  }
  const qtyComputed = qtyReceived === null ? null : toStockQty(qtyReceived, line.unit);

  let qtyCounted: bigint | null = null;
  if (line.countedText.trim().length > 0) {
    try {
      qtyCounted = parseQtyScaled(line.countedText, line.unit.stockScale);
    } catch (err) {
      problem ??= err instanceof QuantityInputError ? err.message : 'That is not a count.';
    }
  }

  const effective = qtyCounted ?? qtyComputed;
  const overridden = qtyCounted !== null && qtyComputed !== null && qtyCounted !== qtyComputed;
  const beyondTolerance =
    overridden && effective !== null && qtyComputed !== null
      ? !withinTolerance(effective, qtyComputed, line.unit.toleranceBp)
      : false;

  return {
    qtyReceived,
    qtyComputed,
    qtyCounted,
    variance: qtyReceived === null ? 'NO_ORDER' : varianceOf(qtyReceived, line.qtyExpected),
    overridden,
    beyondTolerance,
    problem,
  };
}

function ReceiptLineFields({
  line,
  onChange,
  onRemove,
}: {
  readonly line: LineState;
  readonly onChange: (next: LineState) => void;
  readonly onRemove: (() => void) | null;
}): ReactNode {
  const figures = figuresFor(line);
  const [showCount, setShowCount] = useState(line.countedText.length > 0);

  return (
    <li className={`receipt-line${line.include ? '' : ' receipt-line-off'}`}>
      <span className="stock-row-head">
        <label className="receipt-line-include">
          <input
            type="checkbox"
            checked={line.include}
            aria-label={`Include ${line.productName}`}
            onChange={(e) => onChange({ ...line, include: e.currentTarget.checked })}
          />
          <span className="report-loc-name">{line.productName}</span>
        </label>
        <span className="report-loc-code tabular">{line.skuCode}</span>
      </span>

      {line.qtyExpected === null ? null : (
        <p className="adjust-kind-note">
          Outstanding when this was taken down:{' '}
          <span className="tabular">
            {formatQtyScaled(line.qtyExpected, line.unit.buyScale)} {line.unit.uomCode}
          </span>
        </p>
      )}

      <label className="threshold-form-field">
        <span>How much did they invoice</span>
        <span className="threshold-form-input">
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={line.qtyText}
            aria-label={`Quantity invoiced for ${line.productName}`}
            onChange={(e) => onChange({ ...line, qtyText: e.currentTarget.value })}
          />
          <span className="threshold-form-uom">{line.unit.uomCode}</span>
        </span>
      </label>

      {/* THE VARIANCE, IN WORDS, WHILE IT IS BEING TYPED. No red, no dialog,
          nothing to dismiss: a short delivery is a fact being recorded. */}
      {figures.qtyReceived !== null && line.qtyExpected !== null ? (
        <p
          className={`receipt-variance receipt-variance-${figures.variance.toLowerCase()}`}
          role="status"
        >
          <Icon name={figures.variance === 'MATCHED' ? 'check' : 'clock'} size={18} />
          <span>
            {VARIANCE_WORDS[figures.variance]}
            {figures.variance === 'MATCHED' ? (
              '.'
            ) : (
              <>
                {' '}
                by{' '}
                <span className="tabular">
                  {formatQtyScaled(
                    figures.qtyReceived > line.qtyExpected
                      ? figures.qtyReceived - line.qtyExpected
                      : line.qtyExpected - figures.qtyReceived,
                    line.unit.buyScale,
                  )}{' '}
                  {line.unit.uomCode}
                </span>
                . That is recorded as it stands — nothing here has to balance.
              </>
            )}
          </span>
        </p>
      ) : null}

      {figures.qtyComputed === null ? null : (
        <p className="adjust-kind-note">
          That is{' '}
          <span className="tabular">
            {formatQtyScaled(figures.qtyCounted ?? figures.qtyComputed, line.unit.stockScale)}{' '}
            {line.unit.stockingUomCode}
          </span>{' '}
          on the shelf.
          {showCount ? null : (
            <>
              {' '}
              <button
                type="button"
                className="link-action pressable"
                onClick={() => setShowCount(true)}
              >
                Counted something else?
              </button>
            </>
          )}
        </p>
      )}

      {showCount ? (
        <label className="threshold-form-field">
          <span>What you actually counted off the truck</span>
          <span className="threshold-form-input">
            <input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={line.countedText}
              aria-label={`Counted quantity for ${line.productName}`}
              onChange={(e) => onChange({ ...line, countedText: e.currentTarget.value })}
            />
            <span className="threshold-form-uom">{line.unit.stockingUomCode}</span>
          </span>
        </label>
      ) : null}

      {/* A signature is not a blank cheque. Past the unit's stated slack the
          difference is a claim against a supplier, and the server opens a
          review for it — said here, before the tap, not discovered later. */}
      {figures.overridden ? (
        <p className="receipt-signed" role="status">
          <Icon name="alert" size={18} />
          <span>
            You are signing for a count that differs from the invoice.
            {figures.beyondTolerance
              ? ' It is further out than this unit allows, so the office will be asked to look at it. Both figures are kept.'
              : ' Both figures are kept.'}
          </span>
        </p>
      ) : null}

      <label className="threshold-form-field">
        <span>Invoiced price for one {line.unit.uomCode}</span>
        <span className="threshold-form-input">
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={line.costText}
            aria-label={`Invoiced unit cost for ${line.productName}`}
            onChange={(e) => onChange({ ...line, costText: e.currentTarget.value })}
          />
        </span>
      </label>

      {figures.problem === null ? null : (
        <p className="device-gate-error" role="alert">
          <Icon name="alert" size={20} />
          <span>{figures.problem}</span>
        </p>
      )}

      {onRemove === null ? null : (
        <button
          type="button"
          className="line-remove pressable"
          aria-label={`Remove ${line.productName}`}
          onClick={onRemove}
        >
          <Icon name="trash" size={20} />
        </button>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

interface ReceiptTarget {
  /** Null for a delivery with no order — an emergency collection, say. */
  readonly order: TakenDownOrder | null;
  readonly supplierId: string;
  readonly supplierName: string;
}

function ReceiptForm({
  db,
  target,
  units,
  products,
  hlc,
  onSigned,
  onCancel,
}: {
  readonly db: LocalDb;
  readonly target: ReceiptTarget;
  /** Every buyable unit this device holds, by product id. */
  readonly units: ReadonlyMap<string, readonly PurchaseUnit[]>;
  readonly products: readonly PurchasableProduct[];
  readonly hlc: ClaimedHlcClock;
  readonly onSigned: (lineCount: number, confirmed: number) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const spec = useCurrencySpec();
  const [lines, setLines] = useState<readonly LineState[]>([]);
  const [unconvertible, setUnconvertible] = useState<readonly TakenDownLine[]>([]);
  const [deliveryNote, setDeliveryNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Adding an unordered line.
  const [extraProductId, setExtraProductId] = useState('');

  // THE IDEMPOTENCY KEY IS MINTED WHEN THE FORM OPENS (§8.2). A double-tap, a
  // resumed form and a retry after a crash all carry the same key, so the
  // server appends one receipt and one set of movements however many times it
  // arrives.
  const keyRef = useRef<string>(uuidv7());

  useEffect(() => {
    const order = target.order;
    if (order === null) {
      setLines([]);
      setUnconvertible([]);
      return;
    }
    const built: LineState[] = [];
    const missing: TakenDownLine[] = [];
    for (const l of order.lines) {
      // The unit the order is priced in has to be one THIS DEVICE holds, or
      // there is no conversion into the stocking unit and the line cannot be
      // built at all. Said plainly rather than guessed at.
      const unit = (units.get(l.productId) ?? []).find((u) => u.uomId === l.uomId);
      if (unit === undefined) {
        missing.push(l);
        continue;
      }
      built.push({
        key: l.purchaseOrderLineId,
        productId: l.productId,
        productName: l.productName,
        skuCode: l.skuCode,
        purchaseOrderLineId: l.purchaseOrderLineId,
        qtyExpected: l.qtyOutstandingAtTakeDown,
        unit,
        // OPENS ON WHAT IS OUTSTANDING, so the common case is one tap and the
        // uncommon one is a number typed over it. A negative outstanding is an
        // over-delivery already recorded, so the field opens empty instead.
        qtyText:
          l.qtyOutstandingAtTakeDown > 0n
            ? formatQtyScaled(l.qtyOutstandingAtTakeDown, l.qtyScale)
            : '',
        countedText: '',
        // The order's own agreed price, as money for one purchase unit.
        costText: formatMinorPlain(
          lineNetMinor(oneWholeUnit(l.qtyScale), l.qtyScale, l.unitPriceE4, 'half-up'),
          spec.scale,
        ),
        include: l.qtyOutstandingAtTakeDown > 0n,
      });
    }
    setLines(built);
    setUnconvertible(missing);
  }, [spec.scale, target.order, units]);

  const addExtra = useCallback(() => {
    const product = products.find((p) => p.id === extraProductId);
    const unit = (units.get(extraProductId) ?? [])[0];
    if (product === undefined || unit === undefined) {
      setProblem('Pick something this device knows how to convert into shelf units.');
      return;
    }
    setProblem(null);
    setLines((current) => [
      ...current,
      {
        key: uuidv7(),
        productId: product.id,
        productName: product.name,
        skuCode: product.code,
        purchaseOrderLineId: null,
        qtyExpected: null,
        unit,
        qtyText: '',
        countedText: '',
        costText: '',
        include: true,
      },
    ]);
    setExtraProductId('');
  }, [extraProductId, products, units]);

  const sign = useCallback(() => {
    const chosen = lines.filter((l) => l.include);
    if (chosen.length === 0) {
      setProblem('Tick at least one line. A receipt for nothing is not a receipt.');
      return;
    }
    const drafts: ReceiptLineDraft[] = [];
    for (const line of chosen) {
      const figures = figuresFor(line);
      if (figures.problem !== null) {
        setProblem(`${line.productName}: ${figures.problem}`);
        return;
      }
      if (figures.qtyReceived === null || figures.qtyReceived <= 0n) {
        setProblem(`${line.productName}: say how much was invoiced, or untick the line.`);
        return;
      }
      const counted = figures.qtyCounted ?? figures.qtyComputed;
      if (counted === null || counted <= 0n) {
        setProblem(`${line.productName}: that converts to nothing on the shelf.`);
        return;
      }
      let costMinor: bigint;
      try {
        costMinor = parse(line.costText.trim(), spec);
      } catch (err) {
        setProblem(
          err instanceof MoneyError
            ? `${line.productName}: enter the invoiced price using digits, and a dot for any decimals.`
            : `${line.productName}: that is not a price.`,
        );
        return;
      }
      drafts.push({
        ...(line.purchaseOrderLineId === null
          ? {}
          : { purchaseOrderLineId: line.purchaseOrderLineId }),
        productId: line.productId,
        unit: line.unit,
        qtyReceived: figures.qtyReceived,
        qtyStock: counted,
        // A price typed at the currency's own precision, carried at the rate's
        // ×10⁴ precision exactly. Nothing is rounded on the way in.
        unitCostE4: costMinor * 10_000n,
      });
    }

    setProblem(null);
    setSaving(true);
    void recordGoodsReceipt(db, {
      goodsReceiptId: keyRef.current,
      supplierId: target.supplierId,
      ...(target.order === null ? {} : { purchaseOrderId: target.order.purchaseOrderId }),
      ...(deliveryNote.trim().length === 0 ? {} : { supplierDeliveryNoteRef: deliveryNote.trim() }),
      lines: drafts,
      hlc,
    }).then(
      (result) => {
        setSaving(false);
        // The key has been spent. A fresh one for the next delivery.
        keyRef.current = uuidv7();
        onSigned(result.lineCount, result.confirmedLineNos.length);
      },
      (err: unknown) => {
        setSaving(false);
        // Refused BEFORE anything was queued: nothing was dropped and nothing
        // was sent, and the form is still on screen with everything in it.
        setProblem(
          err instanceof Error
            ? err.message
            : 'This delivery was not recorded, and nothing was queued.',
        );
      },
    );
  }, [db, deliveryNote, hlc, lines, onSigned, spec, target.order, target.supplierId]);

  return (
    <form
      className="threshold-form"
      aria-label="Sign for a delivery"
      onSubmit={(e) => {
        e.preventDefault();
        sign();
      }}
    >
      <p className="threshold-form-product">
        <span className="report-loc-name">{target.supplierName}</span>
        {target.order === null ? (
          <span className="report-loc-code">No order — recorded as it stands</span>
        ) : (
          <span className="report-loc-code tabular">
            Ordered {target.order.orderDate}
          </span>
        )}
      </p>

      <label className="threshold-form-field">
        <span>Their delivery note number (optional)</span>
        <input
          type="text"
          autoComplete="off"
          value={deliveryNote}
          aria-label="Supplier delivery note reference"
          onChange={(e) => setDeliveryNote(e.currentTarget.value)}
        />
      </label>

      {unconvertible.length === 0 ? null : (
        <p className="device-gate-error" role="alert">
          <Icon name="alert" size={20} />
          <span>
            {unconvertible.length === 1 ? 'One line' : `${String(unconvertible.length)} lines`} on
            this order {unconvertible.length === 1 ? 'is' : 'are'} priced in a unit this device has
            not received yet, so it cannot work out what that means on the shelf. Those lines are
            not shown and cannot be signed for here:{' '}
            {unconvertible.map((l) => l.productName).join(', ')}.
          </span>
        </p>
      )}

      {lines.length === 0 ? (
        <p className="adjust-kind-note">
          Nothing on this delivery yet. Add what came off the truck.
        </p>
      ) : (
        <ul className="receipt-lines" aria-label="Delivery lines">
          {lines.map((line) => (
            <ReceiptLineFields
              key={line.key}
              line={line}
              onChange={(next) =>
                setLines((current) => current.map((l) => (l.key === next.key ? next : l)))
              }
              onRemove={
                line.purchaseOrderLineId === null
                  ? () => setLines((current) => current.filter((l) => l.key !== line.key))
                  : null
              }
            />
          ))}
        </ul>
      )}

      {/* AN EXTRA IS NORMAL TOO. A substitute, or something that arrived on the
          same truck, is recorded as an unmatched line rather than left off. */}
      <fieldset className="adjust-kinds">
        <legend>Something that is not on the order</legend>
        <label className="threshold-form-field">
          <span>Product</span>
          <select
            value={extraProductId}
            aria-label="Extra product"
            onChange={(e) => setExtraProductId(e.currentTarget.value)}
          >
            <option value="">Choose a product…</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.code}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="secondary-action pressable"
          disabled={extraProductId === ''}
          onClick={addExtra}
        >
          Add it to this delivery
        </button>
      </fieldset>

      {problem === null ? null : (
        <p className="device-gate-error" role="alert">
          <Icon name="alert" size={20} />
          <span>{problem}</span>
        </p>
      )}

      <div className="threshold-form-actions">
        <button type="submit" className="primary-action pressable" disabled={saving}>
          {saving ? 'Recording…' : 'Sign for this delivery'}
        </button>
        <button type="button" className="secondary-action pressable" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="adjust-offline-note">
        <Icon name="cloud-off" size={18} />
        Recorded on this device straight away, connection or not, and sent when there is one.
      </p>
    </form>
  );
}

/**
 * A minor-unit amount as the plain digits a text field starts on — no symbol,
 * no grouping, so `parse()` reads back exactly what `format()` wrote.
 * `@erp/money` guarantees that round trip, which is why the field is seeded
 * from it rather than from a hand-rolled division.
 */
function formatMinorPlain(minor: bigint, scale: number): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(scale + 1, '0');
  const split = digits.length - scale;
  const whole = digits.slice(0, split);
  const frac = digits.slice(split);
  return `${negative ? '-' : ''}${whole}${scale === 0 ? '' : `.${frac}`}`;
}

// ---------------------------------------------------------------------------
// What this device has queued
// ---------------------------------------------------------------------------

function QueuedReceiptRow({
  receipt,
  products,
}: {
  readonly receipt: QueuedReceipt;
  readonly products: readonly PurchasableProduct[];
}): ReactNode {
  const nameOf = (productId: string): string =>
    products.find((p) => p.id === productId)?.name ?? 'A product this device no longer holds';
  const confirmed = receipt.lines.filter((l) => l.conversionConfirmed).length;
  return (
    <li className={`adjust-row${receipt.syncState === 'attention' ? ' adjust-row-attn' : ''}`}>
      <span className="stock-row-head">
        <span className="report-loc-name">
          {receipt.lines.length === 1
            ? nameOf(receipt.lines[0]!.productId)
            : `${String(receipt.lines.length)} lines`}
        </span>
        <span className="report-loc-code tabular">
          {receipt.supplierDeliveryNoteRef ?? receipt.businessDate}
        </span>
      </span>
      <span className="adjust-meta">
        <span>{receipt.purchaseOrderId === null ? 'No order' : 'Against an order'}</span>
        {confirmed === 0 ? null : (
          <span>
            {String(confirmed)} line{confirmed === 1 ? '' : 's'} signed for against the invoice
          </span>
        )}
        <span className="tabular">{receipt.businessDate}</span>
      </span>
      <span className={`sync-badge badge-${receipt.syncState}`}>
        <Icon
          name={
            receipt.syncState === 'synced'
              ? 'check'
              : receipt.syncState === 'pending'
                ? 'clock'
                : 'alert'
          }
          size={14}
        />
        {recordBadgeLabel(receipt.syncState)}
      </span>
      {/* A definitive refusal is WORK, not a toast that disappears. The goods
          are in the yard and the ledger does not know: the row stays here,
          named, with the server's own sentence on it. */}
      {receipt.syncState === 'attention' ? (
        <p className="adjust-rejected" role="status">
          <Icon name="alert" size={18} />
          <span>
            The office refused this delivery, so the stock there has not gone up. The goods are
            still in the yard. Tell your manager before the invoice is paid.
            {receipt.rejectReason === null ? null : (
              <>
                {' '}
                <span className="server-answer-detail-label">They will want to know:</span>{' '}
                <span className="tabular">{receipt.rejectReason}</span>
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

export interface ReceivingProps {
  readonly db: LocalDb;
  readonly permissions: PermissionsState;
  readonly apiOptions?: ApiCallOptions;
}

export function Receiving({ db, permissions, apiOptions }: ReceivingProps): ReactNode {
  const location = useLiveQuery(db, readDeviceLocation, []);

  if (location === undefined) {
    // A local read: a frame or two, not a spinner. Nothing on this screen ever
    // waits on a network.
    return <div className="receiving-screen" />;
  }
  if (location === null) {
    return (
      <div className="empty-state">
        <Icon name="pin" size={40} />
        <span className="empty-title">This device does not know where it is</span>
        <p className="empty-body">
          Goods land somewhere, so a delivery cannot be signed for until this device is bound to a
          yard.
        </p>
      </div>
    );
  }

  return (
    <ReceivingAt
      db={db}
      permissions={permissions}
      apiOptions={apiOptions ?? EMPTY_OPTIONS}
      locationId={location.id}
      locationCode={location.code}
    />
  );
}

function ReceivingAt({
  db,
  permissions,
  apiOptions,
  locationId,
  locationCode,
}: {
  readonly db: LocalDb;
  readonly permissions: PermissionsState;
  readonly apiOptions: ApiCallOptions;
  readonly locationId: string;
  readonly locationCode: string;
}): ReactNode {
  const products = useLiveQuery(db, loadPurchasableProducts, []);
  const receipts = useLiveQuery(db, (d) => recentReceipts(d, 20), []);
  const takeDown = useLiveQuery(db, (d) => readTakeDown(d, locationId), [locationId]);
  const [units, setUnits] = useState<ReadonlyMap<string, readonly PurchaseUnit[]>>(new Map());
  const [hlc, setHlc] = useState<ClaimedHlcClock | null>(null);
  const [target, setTarget] = useState<ReceiptTarget | null>(null);
  const [signed, setSigned] = useState<{ lines: number; confirmed: number } | null>(null);
  const [takingDown, setTakingDown] = useState(false);
  const [takeDownProblem, setTakeDownProblem] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void getOrCreateDeviceNode(db).then((node) => {
      if (alive) setHlc(createClaimedHlcClock(node));
    });
    return () => {
      alive = false;
    };
  }, [db]);

  // Every buyable unit this device holds, for every product it can buy. A
  // LOCAL read of synced rows, so it is available in a partition — which is
  // the whole reason a receipt can be built with the radio off.
  useEffect(() => {
    let alive = true;
    const list = products ?? [];
    void Promise.all(list.map((p) => loadPurchaseUnits(db, p.id))).then((all) => {
      if (!alive) return;
      const map = new Map<string, readonly PurchaseUnit[]>();
      list.forEach((p, i) => map.set(p.id, all[i] ?? []));
      setUnits(map);
    });
    return () => {
      alive = false;
    };
  }, [db, products]);

  const expectedInput = useMemo(
    () => ({ locationIds: [locationId], statuses: [...RECEIVABLE] }),
    [locationId],
  );
  const { state, refresh } = useApiQuery(
    () => fetchPurchaseOrders(expectedInput, apiOptions),
    [expectedInput, apiOptions],
  );

  const canReceive = holdsCapabilityAt(permissions, CAPABILITY.goodsReceive, locationId);

  /**
   * Take a copy for the gate: every order that may still be received here,
   * with its lines, plus supplier identity so an unordered delivery can name
   * who brought it. Written whole, stamped with the minute it was taken.
   */
  const takeCopy = useCallback(() => {
    if (state.status !== 'ready') return;
    setTakingDown(true);
    setTakeDownProblem(null);
    const ids = state.data.orders.map((o) => o.purchaseOrderId);
    void Promise.all([
      Promise.all(ids.map((id) => fetchPurchaseOrder(id, apiOptions))),
      fetchSuppliers({}, apiOptions),
    ]).then(([orders, suppliers]) => {
      const failed = orders.find((o) => !o.ok);
      if (failed !== undefined && !failed.ok) {
        setTakingDown(false);
        setTakeDownProblem(
          `Nothing was taken down. ${failed.failure.detail ?? failed.failure.message}`,
        );
        return;
      }
      if (!suppliers.ok) {
        setTakingDown(false);
        setTakeDownProblem(
          `Nothing was taken down. ${suppliers.failure.detail ?? suppliers.failure.message}`,
        );
        return;
      }
      const next: TakeDown = {
        takenDownAtMs: Date.now(),
        locationId,
        suppliers: suppliers.data.suppliers.filter((s) => s.isActive).map(supplierToTakeDown),
        orders: orders.flatMap((o) => (o.ok ? [orderToTakeDown(o.data)] : [])),
      };
      void writeTakeDown(db, next).then(() => setTakingDown(false));
    });
  }, [apiOptions, db, locationId, state]);

  /**
   * THROW THIS DEVICE'S COPY AWAY.
   *
   * A take-down is a document, stamped with the minute it was taken. When the
   * yard learns it is wrong — the order was cancelled, the load was diverted,
   * the copy predates a receipt posted at another gate — the copy has to be
   * removable, and it has to be removable WITH NO CONNECTION. Taking a fresh
   * one needs the server; a partitioned device that could only overwrite would
   * be stuck showing a document it knows is false, beside a "Take a copy"
   * button that cannot run. Discarding is local, so it always works.
   *
   * Nothing that was signed for is touched: receipts are in the outbox, and
   * the outbox is not this.
   */
  const discardCopy = useCallback(() => {
    setTakeDownProblem(null);
    void clearTakeDown(db);
  }, [db]);

  const onSigned = useCallback((lines: number, confirmed: number) => {
    setTarget(null);
    setSigned({ lines, confirmed });
  }, []);

  if (!canReceive) {
    return (
      <div className="receiving-screen">
        <section className="server-answer server-answer-calm" role="status">
          <Icon name="alert" size={28} />
          <div className="server-answer-body">
            <h3 className="server-answer-title">Signing for goods is not part of what you do.</h3>
            <p className="server-answer-text">
              Signing for a delivery and authorising the order it came from are deliberately held
              by different people. Somebody who holds that capability at this yard has to receive
              it.
            </p>
          </div>
        </section>
      </div>
    );
  }

  if (target !== null && hlc !== null) {
    return (
      <div className="receiving-screen">
        <header className="report-panel-head">
          <h2>Sign for a delivery · {locationCode}</h2>
        </header>
        <ReceiptForm
          db={db}
          target={target}
          units={units}
          products={products ?? []}
          hlc={hlc}
          onSigned={onSigned}
          onCancel={() => setTarget(null)}
        />
      </div>
    );
  }

  const copy: TakeDown | null = takeDown ?? null;
  const suppliers: readonly TakenDownSupplier[] = copy?.suppliers ?? [];

  return (
    <div className="receiving-screen">
      <header className="report-panel-head">
        <h2>Receive · {locationCode}</h2>
      </header>

      {signed === null ? null : (
        <p className="adjust-saved" role="status">
          <Icon name="check" size={20} />
          <span>
            Recorded on this device: {String(signed.lines)} line
            {signed.lines === 1 ? '' : 's'}
            {signed.confirmed === 0
              ? ''
              : `, ${String(signed.confirmed)} of them signed for against the invoice`}
            . It is waiting to send — it has not reached the office yet.
          </span>
        </p>
      )}

      <section className="report-panel">
        <header className="report-panel-head">
          <h3>Expected here</h3>
          {state.status === 'ready' ? <FetchedAt atMs={state.fetchedAtMs} /> : null}
        </header>

        {state.status === 'loading' ? (
          <ServerPending what={WHAT_EXPECTED} slow={state.slow} rows={3} />
        ) : null}

        {/* OFFLINE. The server's list is not available, and it says so — never
            an empty list that reads as "nothing is coming". What IS available
            is the copy this yard took, and it is offered as a copy. */}
        {state.status === 'failed' ? (
          <>
            <ServerUnavailable what={WHAT_EXPECTED} failure={state.failure} onRetry={refresh} />
            {copy === null ? (
              <div className="empty-state empty-state-attention">
                <Icon name="cloud-off" size={40} />
                <span className="empty-title">No copy was taken for this yard</span>
                <p className="empty-body">
                  Orders live on the server, and this device has no copy of them. A delivery that
                  arrives now can still be signed for without one — record it below as a delivery
                  with no order and the office will match it up.
                </p>
              </div>
            ) : (
              <>
                <div className="takedown-note" role="status">
                  <Icon name="download" size={20} />
                  <span>
                    Showing the copy taken at <span className="tabular">{clockTime(copy.takenDownAtMs)}</span>.
                    This is what the orders said then, not what the office knows now — anything
                    received elsewhere since will not be in it.
                  </span>
                </div>
                <button
                  type="button"
                  className="secondary-action pressable"
                  onClick={discardCopy}
                >
                  <Icon name="trash" size={20} />
                  Throw this copy away
                </button>
                <p className="adjust-kind-note">
                  Use this when the copy is known to be wrong. It removes the copy from this
                  device and nothing else — a delivery can still be signed for with no order
                  against it, and nothing already recorded is affected.
                </p>
              </>
            )}
          </>
        ) : null}

        {state.status === 'ready' ? (
          <>
            <button
              type="button"
              className="secondary-action pressable"
              disabled={takingDown || state.data.orders.length === 0}
              onClick={takeCopy}
            >
              <Icon name="download" size={20} />
              {takingDown ? 'Taking a copy…' : 'Take a copy for the gate'}
            </button>
            {copy === null ? null : (
              <button type="button" className="secondary-action pressable" onClick={discardCopy}>
                <Icon name="trash" size={20} />
                Throw this copy away
              </button>
            )}
            <p className="adjust-kind-note">
              A copy lets this yard sign for these deliveries with no connection at all. It is a
              copy of the orders, stamped with the time it was taken — not a live figure.
              {copy === null
                ? ''
                : ` The last one was taken at ${clockTime(copy.takenDownAtMs)}.`}
            </p>
            {takeDownProblem === null ? null : (
              <p className="device-gate-error" role="alert">
                <Icon name="alert" size={20} />
                <span>{takeDownProblem}</span>
              </p>
            )}
            {state.data.orders.length === 0 ? (
              <div className="empty-state">
                <Icon name="check" size={40} />
                <span className="empty-title">Nothing is expected here</span>
                <p className="empty-body">
                  No approved order is outstanding for this yard. A delivery that turns up anyway
                  can still be signed for below.
                </p>
              </div>
            ) : null}
          </>
        ) : null}

        {/* The list itself: the server's when it answered, the copy's when it
            could not. Both are rendered the same way and labelled differently
            — one carries `As at`, the other says it is a copy and when. */}
        <ul className="order-list" aria-label="Deliveries expected">
          {(state.status === 'ready'
            ? state.data.orders.map((o) => ({
                purchaseOrderId: o.purchaseOrderId,
                supplierId: o.supplierId,
                supplierName: o.supplierName,
                orderDate: o.orderDate,
                status: o.status,
                fromCopy: false,
              }))
            : (copy?.orders ?? []).map((o) => ({
                purchaseOrderId: o.purchaseOrderId,
                supplierId: o.supplierId,
                supplierName: o.supplierName,
                orderDate: o.orderDate,
                status: o.statusAtTakeDown,
                fromCopy: true,
              }))
          ).map((row) => (
            <li key={row.purchaseOrderId} className="order-row">
              <button
                type="button"
                className="order-row-open pressable"
                onClick={() => {
                  const fromCopy = (copy?.orders ?? []).find(
                    (o) => o.purchaseOrderId === row.purchaseOrderId,
                  );
                  if (fromCopy !== undefined) {
                    setTarget({
                      order: fromCopy,
                      supplierId: fromCopy.supplierId,
                      supplierName: fromCopy.supplierName,
                    });
                    return;
                  }
                  // No copy of this order on the device. Rather than sign
                  // against lines it does not hold, take one now.
                  setTakeDownProblem(
                    'Take a copy for the gate first — this device does not hold the lines of that order yet.',
                  );
                }}
              >
                <span className="stock-row-head">
                  <span className="report-loc-name">{row.supplierName}</span>
                  <span className="report-loc-code tabular">{row.orderDate}</span>
                </span>
                <span className="order-row-status">
                  {row.fromCopy ? 'From the copy taken at the gate' : 'Waiting to arrive'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="report-panel">
        <header className="report-panel-head">
          <h3>A delivery with no order</h3>
        </header>
        <p className="report-note">
          An emergency collection, or goods that arrived ahead of their paperwork. Recording it
          honestly beats inventing an order to satisfy a field.
        </p>
        {suppliers.length === 0 ? (
          <p className="adjust-kind-note">
            This device has no copy of the supplier list, so it cannot name who brought them. Take
            a copy for the gate while there is a connection.
          </p>
        ) : (
          <UnorderedPicker suppliers={suppliers} onPick={setTarget} />
        )}
      </section>

      <section className="report-panel">
        <header className="report-panel-head">
          <h3>Recorded on this device</h3>
        </header>
        {(receipts ?? []).length === 0 ? (
          <p className="adjust-kind-note">Nothing has been signed for on this device yet.</p>
        ) : (
          <ul className="adjust-list" aria-label="Deliveries recorded here">
            {(receipts ?? []).map((r) => (
              <QueuedReceiptRow key={r.id} receipt={r} products={products ?? []} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function UnorderedPicker({
  suppliers,
  onPick,
}: {
  readonly suppliers: readonly TakenDownSupplier[];
  readonly onPick: (target: ReceiptTarget) => void;
}): ReactNode {
  const [supplierId, setSupplierId] = useState('');
  return (
    <form
      className="threshold-form"
      onSubmit={(e) => {
        e.preventDefault();
        const supplier = suppliers.find((s) => s.supplierId === supplierId);
        if (supplier === undefined) return;
        onPick({ order: null, supplierId: supplier.supplierId, supplierName: supplier.name });
      }}
    >
      <label className="threshold-form-field">
        <span>Who brought them</span>
        <select
          value={supplierId}
          aria-label="Supplier who delivered"
          onChange={(e) => setSupplierId(e.currentTarget.value)}
        >
          <option value="">Choose a supplier…</option>
          {suppliers.map((s) => (
            <option key={s.supplierId} value={s.supplierId}>
              {s.name} · {s.code}
            </option>
          ))}
        </select>
      </label>
      <div className="threshold-form-actions">
        <button type="submit" className="secondary-action pressable" disabled={supplierId === ''}>
          Record what turned up
        </button>
      </div>
    </form>
  );
}
