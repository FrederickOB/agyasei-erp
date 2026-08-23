/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DELIVERIES — hand a load to a haulier, and say where it got to
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ADR-0001: THERE IS NO VEHICLE ON THIS SCREEN, AND THERE MUST NEVER BE ONE
 * ═══════════════════════════════════════════════════════════════════════════
 * A carrier is a SUPPLIER holding a capability whose platform kind is HAULAGE.
 * It invoices and is paid on terms, which is a supplier in every way the books
 * care about, and it puts haulage spend in AP where distribution cost as a
 * percentage of revenue can actually be measured — which is what ADR-0001
 * promised in exchange for removing the owned fleet.
 *
 * There is no registration number, no driver, no odometer, no fuel and no
 * servicing anywhere in this file. `carrierSupplierId` is the single
 * attachment point if owned vehicles are ever introduced. A field describing a
 * truck rather than a counterparty means the scope has been left.
 *
 * ---------------------------------------------------------------------------
 * ONE OF THE TWO WRITES HERE IS QUEUED, AND THE OTHER IS REFUSED OFFLINE
 * ---------------------------------------------------------------------------
 * **Planning** a delivery commits the business to a carrier: the server checks
 * that the named supplier really holds a haulage capability and is still
 * active, and a partitioned device cannot know either. It goes over HTTP and a
 * failure is a failure, with nothing queued.
 *
 * **A status move** is recorded by whoever hears from the driver, wherever
 * they are, and rides the outbox — client idempotency key, completion only on
 * the server's own per-key ack, rejections visible as work
 * (`data/mutations/updateDeliveryStatus.ts`). While one is queued the row says
 * so and shows the queued status, because rendering the server's older status
 * as current is how the same move gets recorded twice.
 *
 * ---------------------------------------------------------------------------
 * WHY THE MOVES OFFERED COME FROM THE SHARED CONTRACT
 * ---------------------------------------------------------------------------
 * `app.delivery_legal_transitions()` is canonical and a trigger enforces it.
 * A device recording a move in a partition has nobody to ask, and offering an
 * illegal one would queue a write the server answers CONFLICT to — retryable,
 * so retried for ever and visible only as a queue that stopped draining. So
 * the moves come from `legalDeliveryNextStatuses` in `@erp/contracts`, and the
 * conformance suite reads the database's own table and asserts the two are
 * equal (see that export's own header). One declaration; two parties compared
 * against each other, never each against its own idea of the truth.
 *
 * ---------------------------------------------------------------------------
 * A FREIGHT FIGURE THAT IS NOT KNOWN IS AN ABSENCE, NEVER A ZERO
 * ---------------------------------------------------------------------------
 * `freightCostMinor` is nullable. A zero would read as a free delivery and
 * would drag the distribution-cost figure ADR-0001 exists to make measurable
 * towards a number nobody agreed. The absence is rendered as an absence.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MoneyError, parse } from '@erp/money';
import { legalDeliveryNextStatuses, type DeliveryStatus } from '@erp/contracts';
import type { ApiCallOptions, ApiFailure } from '../../data/api/client';
import {
  HAULAGE,
  fetchPurchaseOrders,
  fetchSuppliers,
  type PurchaseOrderHeader,
  type Supplier,
} from '../../data/api/procurement';
import {
  fetchDeliveries,
  fetchDelivery,
  planDelivery,
  type Delivery,
} from '../../data/api/logistics';
import { CAPABILITY, holdsCapabilityAt, type PermissionsState } from '../../data/api/session';
import { useApiQuery } from '../../data/api/use-api-query';
import type { LocalDb } from '../../data/db';
import { recordDeliveryStatus } from '../../data/mutations/updateDeliveryStatus';
import { getOrCreateDeviceNode } from '../../data/queries/config';
import {
  pendingDeliveryStatuses,
  recentDeliveryUpdates,
  type QueuedDeliveryUpdate,
} from '../../data/queries/procurement-outbox';
import { readDeviceLocation } from '../../data/queries/session';
import { useLiveQuery } from '../../data/use-live-query';
import { recordBadgeLabel } from '../../lib/badges';
import { businessDateFor } from '../../lib/business-date';
import { createClaimedHlcClock, type ClaimedHlcClock } from '../../lib/hlc';
import { uuidv7 } from '../../lib/uuidv7';
import { useCurrencySpec } from '../../money/CurrencyContext';
import { Money } from '../../money/Money';
import { Icon } from '../../ui/Icon';
import { FetchedAt, ServerPending, ServerUnavailable } from '../shell/ServerAnswer';

const WHAT_DELIVERIES = 'The delivery list';
const WHAT_ONE_DELIVERY = 'What the office holds for this load';

/** Stable identity, so a screen with no test seam does not refetch on render. */
const EMPTY_OPTIONS: ApiCallOptions = {};

/**
 * Product chrome for the PLATFORM's own closed status vocabulary. Total over
 * the union, so a status added to the contract cannot arrive wordless.
 */
const STATUS_COPY: Record<DeliveryStatus, string> = {
  PLANNED: 'Booked with a haulier',
  DISPATCHED: 'Left with the haulier',
  IN_TRANSIT: 'On its way',
  DELIVERED: 'Delivered',
  FAILED: 'Did not arrive',
  CANCELLED: 'Cancelled',
};

const MOVE_LABEL: Record<DeliveryStatus, string> = {
  PLANNED: 'Back to booked',
  DISPATCHED: 'It has left',
  IN_TRANSIT: 'It is on the way',
  DELIVERED: 'It arrived',
  FAILED: 'It did not arrive',
  CANCELLED: 'Cancel it',
};

function statusLabel(value: string): string {
  return Object.prototype.hasOwnProperty.call(STATUS_COPY, value)
    ? STATUS_COPY[value as DeliveryStatus]
    : value;
}

// ---------------------------------------------------------------------------
// One delivery
// ---------------------------------------------------------------------------

/**
 * What the office currently holds for ONE load, re-read by id on demand.
 *
 * The list is a snapshot taken when the screen opened; a move recorded on
 * another device, or a refusal of this device's own queued move, is not in it.
 * Re-reading one delivery is also the cheapest thing a bad link can be asked
 * to do, which is why it is offered instead of a full list refresh.
 */
type OfficeRecord =
  | { readonly status: 'checking' }
  | { readonly status: 'answered'; readonly delivery: Delivery }
  | { readonly status: 'refused'; readonly failure: ApiFailure };

function DeliveryRow({
  delivery,
  queued,
  office,
  canDispatch,
  onMove,
  onCheck,
}: {
  readonly delivery: Delivery;
  /** A move this device has queued and the server has not acked yet. */
  readonly queued: QueuedDeliveryUpdate | undefined;
  /** The office's own record for this load, if it has been asked for. */
  readonly office: OfficeRecord | undefined;
  readonly canDispatch: boolean;
  readonly onMove: (delivery: Delivery, to: DeliveryStatus, reason: string) => void;
  readonly onCheck: (deliveryId: string) => void;
}): ReactNode {
  const [reason, setReason] = useState('');
  // The status a person should act on is the one this device has queued, if it
  // has queued one — otherwise the server's. Showing the server's older status
  // beside a queued move is how the same move gets recorded twice.
  const effective = queued?.toStatus ?? delivery.status;
  const moves = canDispatch ? legalDeliveryNextStatuses(effective) : [];
  const failing = moves.includes('FAILED');

  return (
    <li className={`delivery-row${queued === undefined ? '' : ' delivery-row-pending'}`}>
      <span className="stock-row-head">
        {/* The carrier is a SUPPLIER. There is nothing here that names a truck. */}
        <span className="report-loc-name">{delivery.carrierName}</span>
        <span className="report-loc-code tabular">
          {delivery.carrierReference ?? delivery.sourceKind.replace('_', ' ').toLowerCase()}
        </span>
      </span>

      <span className="delivery-status">{statusLabel(effective)}</span>

      {queued === undefined ? null : (
        <span className={`sync-badge badge-${queued.syncState}`}>
          <Icon name={queued.syncState === 'attention' ? 'alert' : 'clock'} size={14} />
          {recordBadgeLabel(queued.syncState)}
        </span>
      )}

      <dl className="stock-figures">
        <div>
          <dt>Freight agreed</dt>
          <dd className="tabular">
            {delivery.freightCostMinor === null ? (
              <span className="figure-withheld">Not agreed</span>
            ) : (
              <Money amount={delivery.freightCostMinor} />
            )}
          </dd>
        </div>
        {delivery.plannedFor === null ? null : (
          <div>
            <dt>Planned for</dt>
            <dd className="tabular">{delivery.plannedFor}</dd>
          </div>
        )}
        {delivery.toAddressText === null ? null : (
          <div>
            <dt>Going to</dt>
            <dd>{delivery.toAddressText}</dd>
          </div>
        )}
        {delivery.failedReason === null ? null : (
          <div>
            <dt>What happened</dt>
            <dd>{delivery.failedReason}</dd>
          </div>
        )}
      </dl>

      {queued !== undefined && queued.syncState === 'attention' ? (
        <p className="adjust-rejected" role="status">
          <Icon name="alert" size={18} />
          <span>
            The office refused this update, so it still shows as {statusLabel(delivery.status)}{' '}
            there.
            {queued.rejectReason === null ? null : (
              <>
                {' '}
                <span className="server-answer-detail-label">They will want to know:</span>{' '}
                <span className="tabular">{queued.rejectReason}</span>
              </>
            )}
          </span>
        </p>
      ) : null}

      {failing ? (
        <label className="threshold-form-field">
          <span>Why, if it did not arrive</span>
          <input
            type="text"
            autoComplete="off"
            value={reason}
            aria-label={`Reason the load from ${delivery.carrierName} did not arrive`}
            onChange={(e) => setReason(e.currentTarget.value)}
          />
        </label>
      ) : null}

      {/* THE OFFICE'S OWN RECORD, on request. Never fetched on render: this is
          a load somebody is standing in front of, and a screen that quietly
          re-asked the server for every row would be unusable on a bad link. */}
      {office === undefined ? null : office.status === 'checking' ? (
        <ServerPending what={WHAT_ONE_DELIVERY} rows={1} />
      ) : office.status === 'refused' ? (
        <ServerUnavailable
          what={WHAT_ONE_DELIVERY}
          failure={office.failure}
          onRetry={() => onCheck(delivery.deliveryId)}
        />
      ) : (
        <dl
          className="stock-figures"
          // A labelled group so the office's answer is addressable on its own,
          // and never confused with the list row's older copy above it.
          role="group"
          aria-label={`What the office holds for ${delivery.carrierName}`}
        >
          <div>
            <dt>The office has it as</dt>
            <dd>{statusLabel(office.delivery.status)}</dd>
          </div>
          <div>
            <dt>Left</dt>
            <dd className="tabular">
              {office.delivery.dispatchedAt === null ? (
                <span className="figure-withheld">Not recorded</span>
              ) : (
                office.delivery.dispatchedAt
              )}
            </dd>
          </div>
          <div>
            <dt>Arrived</dt>
            <dd className="tabular">
              {office.delivery.deliveredAt === null ? (
                <span className="figure-withheld">Not recorded</span>
              ) : (
                office.delivery.deliveredAt
              )}
            </dd>
          </div>
          {office.delivery.notes === null ? null : (
            <div>
              <dt>Note on file</dt>
              <dd>{office.delivery.notes}</dd>
            </div>
          )}
        </dl>
      )}

      <div className="order-actions">
        {moves.map((to) => (
          <button
            key={to}
            type="button"
            className="secondary-action pressable"
            onClick={() => onMove(delivery, to, reason)}
          >
            {MOVE_LABEL[to]}
          </button>
        ))}
        <button
          type="button"
          className="secondary-action pressable"
          onClick={() => onCheck(delivery.deliveryId)}
        >
          <Icon name="sync" size={18} />
          Check with the office
        </button>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Handing a load over
// ---------------------------------------------------------------------------

function DispatchForm({
  carriers,
  orders,
  timeZone,
  apiOptions,
  onPlanned,
  onCancel,
}: {
  readonly carriers: readonly Supplier[];
  readonly orders: readonly PurchaseOrderHeader[];
  /** The LOCATION's zone — never the tablet's, which may have wandered. */
  readonly timeZone: string | null;
  readonly apiOptions: ApiCallOptions;
  readonly onPlanned: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const spec = useCurrencySpec();
  const [carrierSupplierId, setCarrierSupplierId] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [plannedFor, setPlannedFor] = useState('');
  const [freightText, setFreightText] = useState('');
  const [carrierReference, setCarrierReference] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Minted when the form opens (§8.2), so a double-tap books one load.
  const keyRef = useRef<string>(uuidv7());

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE TRADING DAY THIS LOAD'S FREIGHT COUNTS AGAINST
   * ═══════════════════════════════════════════════════════════════════════════
   * It is the period key `reports.distributionCostRatio` divides revenue by
   * and `logistics.haulageSpend` sums over. Until now no screen sent it, so
   * the server fell back to `plannedFor` and then to its own transaction date
   * — and a load recorded days late with no planned date booked silently to
   * the day it was TYPED, in the period it was typed in, with no route to
   * correct it afterwards (there is no `logistics.update`, and
   * `updateDeliveryStatusInput` carries no business date). A month-end figure
   * quietly gains freight that belongs to the month before.
   *
   * So it is asserted here, always, and a person can change it when they are
   * recording something that already happened.
   *
   * The DEFAULT deliberately mirrors the server's own precedence rather than
   * inventing a new one: a planned date, when there is one, is a human's
   * statement about when this load moves; otherwise today AT THE LOCATION —
   * the location's zone is synced tenant data, and a tablet that has wandered
   * onto the wrong timezone must not move a trading day (03 §3.4.2).
   */
  const [assertedDate, setAssertedDate] = useState<string | null>(null);
  const today = businessDateFor(new Date().toISOString(), timeZone);
  const businessDate = assertedDate ?? (plannedFor.length > 0 ? plannedFor : today);

  const submit = useCallback(() => {
    if (carrierSupplierId === '' || sourceId === '') {
      setProblem('Say which order is moving and who is carrying it.');
      return;
    }
    let freightMinor: bigint | null = null;
    if (freightText.trim().length > 0) {
      try {
        freightMinor = parse(freightText.trim(), spec);
      } catch (err) {
        setProblem(
          err instanceof MoneyError
            ? 'Enter the agreed freight using digits, and a dot for any decimals.'
            : 'That is not an amount.',
        );
        return;
      }
    }
    setProblem(null);
    setSaving(true);
    void planDelivery(
      {
        idempotencyKey: keyRef.current,
        clientWallAt: new Date().toISOString(),
        // PURCHASE_ORDER is PLATFORM vocabulary from the shared contract, not
        // a string typed here.
        sourceKind: 'PURCHASE_ORDER',
        sourceId,
        carrierSupplierId,
        ...(carrierReference.trim().length === 0
          ? {}
          : { carrierReference: carrierReference.trim() }),
        ...(plannedFor.length === 0 ? {} : { plannedFor }),
        // ALWAYS SENT, never left to a fallback. This is the period key the
        // distribution-cost ratio divides by, and no route amends it later.
        businessDate,
        // Omitted rather than zeroed when nobody has agreed a figure: a zero
        // reads as a free delivery.
        ...(freightMinor === null ? {} : { freightCostMinor: freightMinor.toString() }),
      },
      apiOptions,
    ).then((result) => {
      setSaving(false);
      if (result.ok) {
        keyRef.current = uuidv7();
        onPlanned();
        return;
      }
      setProblem(
        result.failure.kind === 'offline'
          ? 'Not booked. Deliveries are kept on the server and this device cannot reach it. Nothing was queued, so nothing has been promised to a haulier.'
          : `Not booked. ${result.failure.detail ?? result.failure.message}`,
      );
    });
  }, [
    apiOptions,
    businessDate,
    carrierReference,
    carrierSupplierId,
    freightText,
    onPlanned,
    plannedFor,
    sourceId,
    spec,
  ]);

  return (
    <form
      className="threshold-form"
      aria-label="Hand a load to a haulier"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="threshold-form-field">
        <span>Which order is moving</span>
        <select
          value={sourceId}
          aria-label="Order to move"
          onChange={(e) => setSourceId(e.currentTarget.value)}
        >
          <option value="">Choose an order…</option>
          {orders.map((o) => (
            <option key={o.purchaseOrderId} value={o.purchaseOrderId}>
              {o.supplierName} · {o.orderDate}
            </option>
          ))}
        </select>
      </label>

      <label className="threshold-form-field">
        <span>Who is carrying it</span>
        <select
          value={carrierSupplierId}
          aria-label="Haulier"
          onChange={(e) => setCarrierSupplierId(e.currentTarget.value)}
        >
          <option value="">Choose a haulier…</option>
          {carriers.map((c) => (
            <option key={c.supplierId} value={c.supplierId}>
              {c.name} · {c.code}
            </option>
          ))}
        </select>
      </label>
      {carriers.length === 0 ? (
        <p className="adjust-kind-note">
          No supplier is recorded as carrying loads. A haulier is a supplier with a haulage
          capability — give one that capability and it will appear here.
        </p>
      ) : null}

      <label className="threshold-form-field">
        <span>Their reference for the load (optional)</span>
        <input
          type="text"
          autoComplete="off"
          value={carrierReference}
          aria-label="Carrier reference"
          onChange={(e) => setCarrierReference(e.currentTarget.value)}
        />
      </label>

      <label className="threshold-form-field">
        <span>When (optional)</span>
        <input
          type="date"
          value={plannedFor}
          aria-label="Planned date"
          onChange={(e) => setPlannedFor(e.currentTarget.value)}
        />
      </label>

      {/* THE PERIOD KEY. Asserted, not inferred — and correctable HERE,
          because nothing corrects it afterwards. */}
      <label className="threshold-form-field">
        <span>Trading day this load counts against</span>
        <input
          type="date"
          value={businessDate}
          aria-label="Trading day this load counts against"
          onChange={(e) => setAssertedDate(e.currentTarget.value)}
        />
      </label>
      <p className="adjust-kind-note">
        {businessDate === today
          ? 'Today at this place. Change it if this load actually moved on another day — what it cost is counted against this day when the cost of moving goods is measured, and it cannot be changed once the load is booked.'
          : `Not today at this place (${today}). This load's freight will be counted against ${businessDate} when the cost of moving goods is measured, and it cannot be changed once the load is booked.`}
      </p>

      <label className="threshold-form-field">
        <span>Agreed freight (optional)</span>
        <span className="threshold-form-input">
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={freightText}
            aria-label="Agreed freight"
            onChange={(e) => setFreightText(e.currentTarget.value)}
          />
        </span>
      </label>
      <p className="adjust-kind-note">
        Leave the freight empty if nothing has been agreed. It is left blank rather than set to
        nothing, because nothing reads as a free delivery and would flatter what moving goods
        costs.
      </p>

      {problem === null ? null : (
        <p className="device-gate-error" role="alert">
          <Icon name="alert" size={20} />
          <span>{problem}</span>
        </p>
      )}

      <div className="threshold-form-actions">
        <button type="submit" className="primary-action pressable" disabled={saving}>
          {saving ? 'Booking…' : 'Book it with them'}
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

export interface DeliveriesProps {
  readonly db: LocalDb;
  readonly permissions: PermissionsState;
  readonly apiOptions?: ApiCallOptions;
}

export function Deliveries({ db, permissions, apiOptions }: DeliveriesProps): ReactNode {
  const location = useLiveQuery(db, readDeviceLocation, []);

  if (location === undefined) {
    return (
      <div className="buying-screen">
        <ServerPending what={WHAT_DELIVERIES} rows={3} />
      </div>
    );
  }
  if (location === null) {
    return (
      <div className="empty-state">
        <Icon name="pin" size={40} />
        <span className="empty-title">This device does not know where it is</span>
        <p className="empty-body">
          A delivery belongs to a place, so nothing can be tracked until this device is bound to
          one.
        </p>
      </div>
    );
  }

  return (
    <DeliveriesAt
      db={db}
      permissions={permissions}
      apiOptions={apiOptions ?? EMPTY_OPTIONS}
      locationId={location.id}
      locationCode={location.code}
      timeZone={location.timeZone}
    />
  );
}

/**
 * WHAT THIS DEVICE HAS SENT — the §8.5 attention surface for delivery moves.
 *
 * A LOCAL read of this device's own outbox, so it answers with the radio off.
 * It is the only place a DEFINITIVELY REFUSED update is visible once the
 * server's list loads: the list would show the old status with nothing to
 * suggest anybody had tried to change it, and the person who recorded it would
 * record it again. Acked rows stay on it too, because "it went" is the other
 * half of the question and a badge that only ever means trouble teaches
 * nobody anything.
 */
function SentUpdates({
  updates,
}: {
  readonly updates: readonly QueuedDeliveryUpdate[];
}): ReactNode {
  if (updates.length === 0) return null;
  return (
    <section className="report-panel">
      <header className="report-panel-head">
        <h3>What this device has sent</h3>
      </header>
      <p className="report-note">
        This device&rsquo;s own record of the moves recorded on it, newest first, in the order they
        will reach the office. It is kept here and needs no connection to read.
      </p>
      <ul className="adjust-list" aria-label="Updates recorded on this device">
        {updates.map((u) => (
          <li key={u.id} className="adjust-row">
            <span className="stock-row-head">
              <span className="report-loc-name">{statusLabel(u.toStatus)}</span>
              <span className="report-loc-code tabular">{u.createdAt.slice(0, 16).replace('T', ' ')}</span>
            </span>
            <span className={`sync-badge badge-${u.syncState}`}>
              <Icon name={u.syncState === 'attention' ? 'alert' : 'clock'} size={14} />
              {recordBadgeLabel(u.syncState)}
            </span>
            {u.syncState === 'attention' ? (
              <p className="adjust-rejected" role="status">
                <Icon name="alert" size={18} />
                <span>
                  The office refused this one, so nothing about that load changed there.
                  {u.rejectReason === null ? null : (
                    <>
                      {' '}
                      <span className="server-answer-detail-label">They will want to know:</span>{' '}
                      <span className="tabular">{u.rejectReason}</span>
                    </>
                  )}
                </span>
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function DeliveriesAt({
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
  /** The LOCATION's zone, synced tenant data — the trading day is derived from it. */
  readonly timeZone: string | null;
}): ReactNode {
  const listInput = useMemo(() => ({ locationIds: [locationId] }), [locationId]);
  const { state, refresh } = useApiQuery(
    () => fetchDeliveries(listInput, apiOptions),
    [listInput, apiOptions],
  );
  const carrierInput = useMemo(() => ({ kind: HAULAGE }), []);
  const carriers = useApiQuery(() => fetchSuppliers(carrierInput, apiOptions), [
    carrierInput,
    apiOptions,
  ]);
  const orderInput = useMemo(
    () => ({ locationIds: [locationId], statuses: ['APPROVED' as const] }),
    [locationId],
  );
  const orders = useApiQuery(() => fetchPurchaseOrders(orderInput, apiOptions), [
    orderInput,
    apiOptions,
  ]);
  const pending = useLiveQuery(db, pendingDeliveryStatuses, []);
  /**
   * EVERY status move this device has written, acked or not. `pending` above
   * drives the per-row badge and stops at the first unacked move per delivery;
   * this is the §8.5 attention surface — a REFUSED update has to stay visible
   * as work even when the server's list loads perfectly well and shows the old
   * status as though nothing had happened.
   */
  const sent = useLiveQuery(db, recentDeliveryUpdates, []);
  const [hlc, setHlc] = useState<ClaimedHlcClock | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [office, setOffice] = useState<ReadonlyMap<string, OfficeRecord>>(new Map());

  useEffect(() => {
    let alive = true;
    void getOrCreateDeviceNode(db).then((node) => {
      if (alive) setHlc(createClaimedHlcClock(node));
    });
    return () => {
      alive = false;
    };
  }, [db]);

  const canDispatch = holdsCapabilityAt(permissions, CAPABILITY.dispatchManage, locationId);

  /**
   * Ask the office about ONE load, by id. Offline this answers `offline` and
   * says so in the row — it never falls back to the list's older copy dressed
   * up as current, which is the whole reason the control exists.
   */
  const onCheck = useCallback(
    (deliveryId: string) => {
      setOffice((current) => new Map(current).set(deliveryId, { status: 'checking' }));
      void fetchDelivery(deliveryId, apiOptions).then((result) => {
        setOffice((current) =>
          new Map(current).set(
            deliveryId,
            result.ok
              ? { status: 'answered', delivery: result.data }
              : { status: 'refused', failure: result.failure },
          ),
        );
      });
    },
    [apiOptions],
  );

  const onMove = useCallback(
    (delivery: Delivery, to: DeliveryStatus, reason: string) => {
      if (hlc === null) return;
      const from = pending?.get(delivery.deliveryId)?.toStatus ?? delivery.status;
      setProblem(null);
      void recordDeliveryStatus(db, {
        // A fresh key per move: each one is its own write, and a resumed
        // screen must not silently replay the previous move.
        updateId: uuidv7(),
        deliveryId: delivery.deliveryId,
        fromStatus: from,
        toStatus: to,
        ...(reason.trim().length === 0 ? {} : { reason: reason.trim() }),
        hlc,
      }).catch((err: unknown) => {
        // Refused BEFORE anything was queued — nothing was dropped and nothing
        // was sent.
        setProblem(
          err instanceof Error ? err.message : 'That update was not recorded, and nothing queued.',
        );
      });
    },
    [db, hlc, pending],
  );

  if (dispatching) {
    return (
      <div className="buying-screen">
        <section className="report-panel">
          <header className="report-panel-head">
            <h2>Hand a load to a haulier · {locationCode}</h2>
          </header>
          {carriers.state.status === 'loading' || orders.state.status === 'loading' ? (
            <ServerPending what="Hauliers and orders" rows={2} />
          ) : null}
          {carriers.state.status === 'failed' ? (
            <ServerUnavailable
              what="The haulier list"
              failure={carriers.state.failure}
              onRetry={carriers.refresh}
            />
          ) : null}
          {orders.state.status === 'failed' ? (
            <ServerUnavailable
              what="The list of orders that could move"
              failure={orders.state.failure}
              onRetry={orders.refresh}
            />
          ) : null}
          {carriers.state.status === 'ready' && orders.state.status === 'ready' ? (
            <DispatchForm
              carriers={carriers.state.data.suppliers.filter((s) => s.isActive)}
              orders={orders.state.data.orders}
              timeZone={timeZone}
              apiOptions={apiOptions}
              onPlanned={() => {
                setDispatching(false);
                refresh();
              }}
              onCancel={() => setDispatching(false)}
            />
          ) : null}
        </section>
      </div>
    );
  }

  return (
    <div className="buying-screen">
      <section className="report-panel">
        <header className="report-panel-head">
          <h2>Deliveries · {locationCode}</h2>
          {state.status === 'ready' ? <FetchedAt atMs={state.fetchedAtMs} /> : null}
        </header>

        {canDispatch ? (
          <button
            type="button"
            className="primary-action pressable"
            onClick={() => setDispatching(true)}
          >
            <Icon name="plus" size={20} />
            Hand a load to a haulier
          </button>
        ) : null}

        {problem === null ? null : (
          <p className="device-gate-error" role="alert">
            <Icon name="alert" size={20} />
            <span>{problem}</span>
          </p>
        )}

        {state.status === 'loading' ? (
          <ServerPending what={WHAT_DELIVERIES} slow={state.slow} rows={3} />
        ) : null}

        {/* OFFLINE. The list lives on the server, so it says so — never an
            empty list that reads as "nothing is on the road". A status move
            already queued on this device is still shown below, because that
            one IS this device's own record and it is honest to show it. */}
        {state.status === 'failed' ? (
          <ServerUnavailable what={WHAT_DELIVERIES} failure={state.failure} onRetry={refresh} />
        ) : null}

        {state.status === 'ready' ? (
          state.data.deliveries.length === 0 ? (
            <div className="empty-state">
              <Icon name="download" size={40} />
              <span className="empty-title">Nothing is on the road for this place</span>
              <p className="empty-body">
                No delivery has been booked against an order here.
              </p>
            </div>
          ) : (
            <ul className="delivery-list" aria-label="Deliveries">
              {state.data.deliveries.map((d) => (
                <DeliveryRow
                  key={d.deliveryId}
                  delivery={d}
                  queued={pending?.get(d.deliveryId)}
                  office={office.get(d.deliveryId)}
                  canDispatch={canDispatch}
                  onMove={onMove}
                  onCheck={onCheck}
                />
              ))}
            </ul>
          )
        ) : null}
      </section>

      {/* Rendered whatever the server said. Offline this is the only honest
          thing on the screen, and online it is the half the server cannot
          tell you: what THIS device tried to do. */}
      <SentUpdates updates={sent ?? []} />
    </div>
  );
}
