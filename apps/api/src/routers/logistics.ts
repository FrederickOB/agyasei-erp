/**
 * Logistics — third-party haulier dispatch and delivery status.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * SCOPE: `app.delivery` — planning a delivery against a purchase order or a
 *        sale, naming the carrier, moving it along its status, and adding up
 *        what carrying cost.
 * ═════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ADR-0001 IS ABSOLUTE: DISPATCH AND TRACKING ONLY. THERE IS NO FLEET.
 * ─────────────────────────────────────────────────────────────────────────
 * There is no vehicle, driver, fuel or maintenance entity in this system and
 * there must never be one. A carrier is a SUPPLIER holding a capability whose
 * `kind` is HAULAGE — it invoices and is paid on terms, which is a supplier in
 * every way the books care about, and it puts haulage spend in AP where
 * distribution cost as a percentage of revenue can actually be measured (which
 * is what ADR-0001 promises and what `docs/open-questions.md` Q1 depends on,
 * Lever 3's owned-fleet mechanism having been removed).
 *
 * `delivery.carrier_supplier_id` is the attachment point ADR-0001 names if
 * owned vehicles ever appear. Nothing in this file names a truck.
 *
 * The HAULAGE check reads `supplier_capability_type.kind`, NEVER the tenant's
 * own `code` for it: a tenant may rename HAULAGE to "Trucking" tomorrow and
 * everything must keep working (ADR-0006, CLAUDE.md §2.9). The database
 * enforces it by trigger; this router pre-checks so the refusal is a
 * comprehensible message rather than a 500.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHERE A DELIVERY'S LOCATION COMES FROM, AND WHY IT IS NOT ON THE REQUEST
 * ─────────────────────────────────────────────────────────────────────────
 * A delivery's endpoints may not be places we own — a cement plant is not a
 * location and neither is a building site — so `from_location_id` and
 * `to_location_id` are both nullable and neither is a reliable authority
 * anchor. The location that BEARS the cost is the document's:
 *
 *   PURCHASE_ORDER → `purchase_order.deliver_to_location_id` (goods inbound)
 *   SALE           → `sale.location_id`                      (goods outbound)
 *
 * That location cannot be known before a read, so these procedures declare
 * their capability `at: 'any'` and then assert `requireAt` against the
 * resolved location — the same two-step `sales.get` uses, for the same reason.
 * It is not a weaker check: a caller who holds the capability only at Techiman
 * is still refused a Wenchi delivery, and the answer still comes from
 * `app.effective_permission` on this request rather than from the token.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * OFFLINE
 * ─────────────────────────────────────────────────────────────────────────
 * `logistics.update_delivery_status` is registered in `DEVICE_OP_KINDS`: a
 * status is updated by whoever hears from the driver, wherever they are, and
 * that phone call does not wait for a radio. Planning a delivery is NOT
 * uploadable — it commits the business to a carrier at an agreed freight rate,
 * and a device may hold a stale copy of who is contracted; it stays online
 * until somebody has a concrete reason it must not (this is the split
 * `PROCUREMENT_UPLOADABLE_OPS` declares, and it is honoured, not re-decided).
 *
 * The state machine is the DATABASE's — `app.delivery_legal_transitions()`,
 * enforced by trigger. It is CALLED here so an illegal move is a clean
 * CONFLICT instead of a constraint violation; it is not re-implemented, and
 * there is no second copy of the table in TypeScript to drift.
 */
import { TRPCError } from '@trpc/server';
import {
  deliveryInput,
  listDeliveriesInput,
  planDeliveryInput,
  updateDeliveryStatusInput,
} from '@erp/contracts';
import { deterministicUuid } from '@erp/db';
import type { Queryable } from '../db.js';
import { runIdempotent } from '../pipeline.js';
import { permissionProcedure, router } from '../trpc.js';
import { wire } from '../wire.js';
import { resolveGroupRollup, resolveLocationScope } from './scope.js';

/** Locations that can bear a distribution cost: they hold or sell stock. */
const COSTED_KINDS = ['OUTLET', 'WAREHOUSE'] as const;

/**
 * A delivery that was CANCELLED carried nothing, so it is excluded from spend.
 * A FAILED one is NOT excluded: a haulier that turned up and could not deliver
 * usually still invoices, and pretending otherwise understates the very ratio
 * this data exists to measure.
 */
const NON_CARRYING_STATUS = 'CANCELLED';

/**
 * The tenant's currency and minor-unit scale, from its jurisdiction pack.
 * Snapshotted onto the delivery exactly as `app.sale` snapshots them, so a
 * historical document reads correctly years later. NEVER assumed to be 100
 * (CLAUDE.md §2.3).
 */
async function loadPackMoney(tx: Queryable): Promise<{ currencyCode: string; moneyScale: bigint }> {
  const res = await tx.query<{ currency_code: string; minor_units_per_major: string }>(
    `select j.currency_code, j.minor_units_per_major::text
       from platform.tenant t
       join platform.jurisdiction j on j.code = t.jurisdiction_code
      where t.id = app.current_tenant()`,
  );
  const row = res.rows[0];
  if (!row) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'tenant jurisdiction unresolved' });
  }
  return { currencyCode: row.currency_code, moneyScale: BigInt(row.minor_units_per_major) };
}

/**
 * The location the cost of this delivery belongs to, resolved from the
 * DOCUMENT it carries. Returns undefined when the document is not visible in
 * this tenant — which, under RLS, is also the answer for another tenant's id.
 */
async function documentLocation(
  tx: Queryable,
  sourceKind: string,
  sourceId: string,
): Promise<string | undefined> {
  if (sourceKind === 'PURCHASE_ORDER') {
    const res = await tx.query<{ deliver_to_location_id: string }>(
      `select deliver_to_location_id from app.purchase_order where id = $1`,
      [sourceId],
    );
    return res.rows[0]?.deliver_to_location_id;
  }
  if (sourceKind === 'SALE') {
    const res = await tx.query<{ location_id: string }>(
      `select location_id from app.sale where id = $1`,
      [sourceId],
    );
    return res.rows[0]?.location_id;
  }
  return undefined;
}

/**
 * Is this a supplier we can hand a load to today?
 *
 * Three separate facts, kept separate because they fail differently: the
 * supplier exists in this tenant, it is still active, and it holds a
 * capability whose PLATFORM kind is HAULAGE. Planning a delivery is a
 * COMMITMENT — the same class of act as raising a purchase order, which
 * refuses a deactivated supplier for the same reason — so a deactivated
 * haulier is refused here. (Receiving does the opposite and deliberately:
 * there the truck has already arrived, and refusing the record does not send
 * it back.)
 */
async function loadCarrier(
  tx: Queryable,
  carrierSupplierId: string,
): Promise<{ exists: boolean; isActive: boolean; hauls: boolean }> {
  const res = await tx.query<{ is_active: boolean; hauls: boolean }>(
    `select s.is_active,
            exists (
              select 1 from app.supplier_capability sc
                join app.supplier_capability_type sct
                  on sct.tenant_id = sc.tenant_id and sct.id = sc.capability_type_id
               where sc.tenant_id = s.tenant_id and sc.supplier_id = s.id
                 and sc.deleted_at is null and sct.deleted_at is null
                 -- kind is PLATFORM structure. The tenant's own code for it is
                 -- its vocabulary and is never read here (ADR-0006, §2.9).
                 and sct.kind = 'HAULAGE'
            ) as hauls
       from app.supplier s
      where s.id = $1 and s.deleted_at is null`,
    [carrierSupplierId],
  );
  const row = res.rows[0];
  if (!row) return { exists: false, isActive: false, hauls: false };
  return { exists: true, isActive: row.is_active, hauls: row.hauls };
}

/**
 * One delivery row, with the document location joined on. `security_invoker`
 * is not needed because these are plain tables read inside the tenant's own
 * RLS context — another tenant's delivery id simply resolves to nothing.
 */
const DELIVERY_SELECT = `
  select d.id, d.source_kind, d.source_id, d.carrier_supplier_id, s.name as carrier_name,
         d.carrier_reference, d.from_location_id, d.to_location_id, d.to_address_text,
         d.status, d.business_date::text as business_date, d.business_date_derived_from,
         d.planned_for::text as planned_for, d.dispatched_at, d.delivered_at,
         d.failed_reason, d.freight_cost_minor::text as freight_cost_minor,
         d.currency_code, d.money_scale::text as money_scale, d.notes,
         coalesce(po.deliver_to_location_id, sa.location_id,
                  d.from_location_id, d.to_location_id) as cost_location_id
    from app.delivery d
    join app.supplier s on s.tenant_id = d.tenant_id and s.id = d.carrier_supplier_id
    left join app.purchase_order po
      on d.source_kind = 'PURCHASE_ORDER' and po.tenant_id = d.tenant_id and po.id = d.source_id
    left join app.sale sa
      on d.source_kind = 'SALE' and sa.tenant_id = d.tenant_id and sa.id = d.source_id
   where d.deleted_at is null
`;

interface DeliveryRow {
  id: string;
  source_kind: string;
  source_id: string;
  carrier_supplier_id: string;
  carrier_name: string;
  carrier_reference: string | null;
  from_location_id: string | null;
  to_location_id: string | null;
  to_address_text: string | null;
  status: string;
  business_date: string;
  business_date_derived_from: string | null;
  planned_for: string | null;
  dispatched_at: string | null;
  delivered_at: string | null;
  failed_reason: string | null;
  freight_cost_minor: string | null;
  currency_code: string;
  money_scale: string;
  notes: string | null;
  cost_location_id: string | null;
}

// ---------------------------------------------------------------------------
// THE NUMERATOR, AS ONE FUNCTION
// ---------------------------------------------------------------------------

/** Freight for one bucket. `withoutFreight` is the honesty: null is not zero. */
export interface HaulageBucket {
  freightMinor: bigint;
  deliveries: number;
  withoutFreight: number;
}

/** How each row in the period got its trading day. Only one arm is untrusted. */
export interface HaulagePeriodBasis {
  asserted: number;
  plannedFor: number;
  dispatchClock: number;
  rowCreated: number;
}

export interface HaulageSpend {
  byLocation: Map<string, HaulageBucket>;
  byCarrier: Map<string, HaulageBucket & { name: string }>;
  total: HaulageBucket;
  periodBasis: HaulagePeriodBasis;
  /** The rows' own pack snapshot. Null only when the period is empty. */
  currencyCode: string | null;
  moneyScale: string | null;
}

export interface HaulageSpendQuery {
  locationIds: readonly string[];
  from?: string | undefined;
  to?: string | undefined;
  carrierSupplierId?: string | undefined;
  sourceKind?: string | undefined;
  sourceId?: string | undefined;
  statuses?: readonly string[] | undefined;
}

const emptyBucket = (): HaulageBucket => ({ freightMinor: 0n, deliveries: 0, withoutFreight: 0 });

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The distribution-cost NUMERATOR. Exported, and there is exactly one of it.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `logistics.haulageSpend` publishes it as a spend report; `reports.
 * distributionCostRatio` divides it by revenue. Both call THIS, because a
 * second implementation of "what did moving the goods cost" is how two
 * screens end up quoting different figures for the same month and nobody can
 * say which is wrong.
 *
 * Attribution rules, all three in one place:
 *
 *  · LOCATION — the location of the document carried: the purchase order's
 *    delivery destination inbound, the sale's outlet outbound, falling back
 *    to the delivery's own endpoints when the document names neither.
 *  · PERIOD — `d.business_date` (migration 0010), never a device clock.
 *  · STATUS — CANCELLED carried nothing and is excluded; FAILED is INCLUDED,
 *    because a haulier that turned up and could not deliver still invoices.
 *
 * Runs inside the caller's tenant transaction, so RLS is what stops another
 * tenant's delivery contributing a pesewa — not the predicate below.
 */
/**
 * The FROM and WHERE of the numerator, written ONCE.
 *
 * Two queries below share it and differ only in their select list: one
 * returns rows to be bucketed in TypeScript, the other asks Postgres for the
 * network total directly. The predicate is a single string precisely so the
 * two can never quietly diverge — and the totals are still compared, because
 * the failure this catches is in the ACCUMULATION (a row dropped from a map,
 * a bigint parsed as a number), not in the filter.
 */
const HAULAGE_FROM_WHERE = `
     from app.delivery d
     join app.supplier s on s.tenant_id = d.tenant_id and s.id = d.carrier_supplier_id
     left join app.purchase_order po
       on d.source_kind = 'PURCHASE_ORDER' and po.tenant_id = d.tenant_id and po.id = d.source_id
     left join app.sale sa
       on d.source_kind = 'SALE' and sa.tenant_id = d.tenant_id and sa.id = d.source_id
    where d.deleted_at is null
      and d.status <> $2
      and coalesce(po.deliver_to_location_id, sa.location_id,
                   d.from_location_id, d.to_location_id) = any($1::uuid[])
      and ($3::uuid is null or d.carrier_supplier_id = $3)
      and ($4::text is null or d.source_kind = $4)
      -- ONE period key: the row's own asserted trading day (0010).
      and ($5::date is null or d.business_date >= $5::date)
      and ($6::date is null or d.business_date <= $6::date)
      -- Every narrowing field the caller offers is HONOURED. A filter passed
      -- and quietly dropped is a figure read as one thing and computed as
      -- another.
      and ($7::uuid is null or d.source_id = $7)
      and ($8::text[] is null or d.status = any($8::text[]))
`;

export async function loadHaulageSpend(
  tx: Queryable,
  q: HaulageSpendQuery,
): Promise<HaulageSpend> {
  const args = [
    [...q.locationIds],
    NON_CARRYING_STATUS,
    q.carrierSupplierId ?? null,
    q.sourceKind ?? null,
    q.from ?? null,
    q.to ?? null,
    q.sourceId ?? null,
    q.statuses ? [...q.statuses] : null,
  ];

  const res = await tx.query<{
    cost_location_id: string;
    carrier_supplier_id: string;
    carrier_name: string;
    freight_cost_minor: string | null;
    currency_code: string;
    money_scale: string;
    dated_by: string;
  }>(
    `select coalesce(po.deliver_to_location_id, sa.location_id,
                     d.from_location_id, d.to_location_id) as cost_location_id,
            d.carrier_supplier_id, s.name as carrier_name,
            d.freight_cost_minor::text as freight_cost_minor,
            d.currency_code, d.money_scale::text as money_scale,
            coalesce(d.business_date_derived_from, 'ASSERTED') as dated_by
     ${HAULAGE_FROM_WHERE}`,
    args,
  );

  /** The same predicate, aggregated by Postgres instead. Rule 1's other half. */
  const totalRes = await tx.query<{
    freight_minor: string;
    deliveries: string;
    without_freight: string;
  }>(
    `select coalesce(sum(d.freight_cost_minor), 0)::bigint::text        as freight_minor,
            count(*)::bigint::text                                      as deliveries,
            count(*) filter (where d.freight_cost_minor is null)::bigint::text
                                                                        as without_freight
     ${HAULAGE_FROM_WHERE}`,
    args,
  );
  const independent = totalRes.rows[0]!;

  const byLocation = new Map<string, HaulageBucket>();
  const byCarrier = new Map<string, HaulageBucket & { name: string }>();
  const total = emptyBucket();
  const periodBasis: HaulagePeriodBasis = {
    asserted: 0,
    plannedFor: 0,
    dispatchClock: 0,
    rowCreated: 0,
  };
  let currencyCode: string | null = null;
  let moneyScale: string | null = null;

  for (const r of res.rows) {
    const bucket = byLocation.get(r.cost_location_id) ?? emptyBucket();
    const carrier = byCarrier.get(r.carrier_supplier_id) ?? {
      ...emptyBucket(),
      name: r.carrier_name,
    };
    bucket.deliveries += 1;
    carrier.deliveries += 1;
    total.deliveries += 1;
    if (r.freight_cost_minor === null) {
      // A null is UNKNOWN and is never averaged into zero: it is counted, and
      // the caller is told the basis is incomplete.
      bucket.withoutFreight += 1;
      carrier.withoutFreight += 1;
      total.withoutFreight += 1;
    } else {
      const amount = BigInt(r.freight_cost_minor);
      bucket.freightMinor += amount;
      carrier.freightMinor += amount;
      total.freightMinor += amount;
    }
    if (r.dated_by === 'PLANNED_FOR') periodBasis.plannedFor += 1;
    else if (r.dated_by === 'DISPATCH_CLOCK') periodBasis.dispatchClock += 1;
    else if (r.dated_by === 'ROW_CREATED') periodBasis.rowCreated += 1;
    else periodBasis.asserted += 1;
    // The rows' own SNAPSHOT wins where there are rows — a historical document
    // reads in the money it was written in.
    currencyCode ??= r.currency_code;
    moneyScale ??= r.money_scale;
    byLocation.set(r.cost_location_id, bucket);
    byCarrier.set(r.carrier_supplier_id, carrier);
  }

  /**
   * RULE 1: the parts must equal the whole, as bigint, or nothing is answered.
   *
   * The rows were bucketed in TypeScript; the total came back from Postgres.
   * They are two different code paths over one predicate, and if they ever
   * disagree the honest response is a 500, not a plausible-looking number on
   * a report somebody will act on.
   */
  const independentTotal = BigInt(independent.freight_minor);
  if (total.freightMinor !== independentTotal) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message:
        `REPORT_IDENTITY_VIOLATION: haulage freight — the bucketed rows sum to ` +
        `${total.freightMinor.toString(10)} and the independently aggregated total is ` +
        `${independentTotal.toString(10)}. Refusing to answer with a figure that does not add up.`,
    });
  }
  if (
    total.deliveries !== Number(independent.deliveries) ||
    total.withoutFreight !== Number(independent.without_freight)
  ) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message:
        `REPORT_IDENTITY_VIOLATION: haulage delivery counts — bucketed ` +
        `${String(total.deliveries)}/${String(total.withoutFreight)} against independently ` +
        `aggregated ${independent.deliveries}/${independent.without_freight}.`,
    });
  }

  return { byLocation, byCarrier, total, periodBasis, currencyCode, moneyScale };
}

/**
 * How a period was dated, in one sentence, for whichever report is publishing
 * it. Written once so the spend report and the ratio cannot describe the same
 * rows differently.
 */
export const HAULAGE_PERIOD_NOTE =
  'A delivery is attributed to its own app.delivery.business_date (migration 0010) — the ' +
  'human-asserted trading day, never a device clock (03 §3.4.2). datedByDispatchClock counts ' +
  'rows written BEFORE 0010, whose date the migration derived from dispatched_at; every row ' +
  'written since carries an asserted date or one taken from the planned date or the server’s ' +
  'own transaction date, and says which.';

export const HAULAGE_METHOD_NOTE =
  'Freight agreed on third-party deliveries (ADR-0001: hauliers only, no fleet), attributed to ' +
  'the location of the document carried — the purchase order’s delivery destination for inbound, ' +
  'the sale’s outlet for outbound. CANCELLED deliveries are excluded; FAILED ones are not, ' +
  'because a haulier that turned up usually still invoices. This is the AGREED figure; the ' +
  'authoritative one is the haulier’s AP invoice in Phase 3.';

export const logisticsRouter = router({
  /**
   * Plan a delivery: attach a CARRIER to a document that has to move.
   *
   * `logistics.dispatch.manage` at the document's own location (see the header
   * on why the check is two-step). The carrier must be a supplier that hauls;
   * the document must exist in this tenant; the delivery is created PLANNED
   * and the database refuses anything else.
   */
  planDelivery: permissionProcedure({ code: 'logistics.dispatch.manage', at: 'any' })
    .input(planDeliveryInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.identity.tenantId;
      const key = input.idempotencyKey;
      const clock = ctx.deps.clock;

      const result = await runIdempotent(
        { runner: ctx.deps.runner, clock },
        ctx.identity,
        {
          op: 'logistics.plan_delivery',
          idempotencyKey: key,
          claimedHlc: input.claimedHlc,
          clientWallAt: input.clientWallAt,
          // NULL, and stated plainly rather than implied: the location this
          // delivery answers to is only knowable after a read INSIDE the plan
          // (it is the carried document's, not the payload's), and the
          // pipeline captures this marker before planning. Device and user —
          // the two that matter for provenance — are stamped by the pipeline
          // from the verified identity; the delivery row itself carries the
          // endpoints and the document carries the cost location, so nothing
          // is unattributable. The control is `requireAt` below, never this.
          locationId: null,
        },
        input,
        async (tx) => {
          const costLocationId = await documentLocation(tx, input.sourceKind, input.sourceId);
          if (costLocationId === undefined) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: `no ${input.sourceKind} with that id is visible in this tenant`,
            });
          }
          // THE control, resolved from app.effective_permission for THIS
          // request against the location the document actually belongs to.
          ctx.permissions.requireAt('logistics.dispatch.manage', costLocationId);

          const carrier = await loadCarrier(tx, input.carrierSupplierId);
          if (!carrier.exists) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'carrier supplier not found' });
          }
          if (!carrier.hauls) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message:
                'that supplier carries no capability of kind HAULAGE — a carrier is a supplier that hauls ' +
                '(ADR-0001). Give it a haulage capability, or name a carrier that has one.',
            });
          }
          if (!carrier.isActive) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message:
                'that haulier is deactivated — planning a delivery commits the business to a carrier, ' +
                'so it is refused for the same reason a purchase order to a deactivated supplier is. ' +
                'Reactivate it, or name another carrier.',
            });
          }

          for (const [label, id] of [
            ['fromLocationId', input.fromLocationId],
            ['toLocationId', input.toLocationId],
          ] as const) {
            if (id === undefined) continue;
            const res = await tx.query<{ id: string }>(
              `select id from app.location where id = $1 and deleted_at is null`,
              [id],
            );
            if (!res.rows[0]) {
              throw new TRPCError({ code: 'NOT_FOUND', message: `${label} is not a location in this tenant` });
            }
          }

          const pack = await loadPackMoney(tx);
          const deliveryId = deterministicUuid(key, 'delivery');

          /**
           * THE TRADING DAY, DECIDED ONCE AND RECORDED WITH ITS BASIS (0010).
           *
           * Preference order, best first, and the row says which one it got:
           *   1. what the writer asserted — `businessDate`;
           *   2. the human-asserted planned date — `plannedFor`;
           *   3. the SERVER's own transaction date.
           *
           * A device clock is not in that list and never will be (03 §3.4.2).
           * Arm 3 is safe here specifically because `planDelivery` is refused
           * offline — booking a load is a commitment against terms a
           * partitioned device may hold stale — so the server's date is the
           * date the booking actually happened, not the date a queue drained.
           */
          const serverDate = (
            await tx.query<{ d: string }>(
              `select (transaction_timestamp() at time zone 'UTC')::date::text as d`,
            )
          ).rows[0]!.d;
          const businessDate = input.businessDate ?? input.plannedFor ?? serverDate;
          const businessDateDerivedFrom =
            input.businessDate !== undefined
              ? null
              : input.plannedFor !== undefined
                ? 'PLANNED_FOR'
                : 'ROW_CREATED';

          const response = {
            deliveryId,
            sourceKind: input.sourceKind,
            sourceId: input.sourceId,
            carrierSupplierId: input.carrierSupplierId,
            carrierReference: input.carrierReference ?? null,
            /** The location this delivery's freight is attributable to. */
            costLocationId,
            fromLocationId: input.fromLocationId ?? null,
            toLocationId: input.toLocationId ?? null,
            toAddressText: input.toAddressText ?? null,
            status: 'PLANNED',
            /** The period key distribution cost is computed on (0010). */
            businessDate,
            businessDateDerivedFrom,
            plannedFor: input.plannedFor ?? null,
            /** The AGREED freight. Null is unknown, and never zero. */
            freightCostMinor:
              input.freightCostMinor === undefined ? null : wire(input.freightCostMinor),
            currencyCode: pack.currencyCode,
            moneyScale: wire(pack.moneyScale),
          };

          return {
            response,
            apply: async (atx) => {
              await atx.query(
                `insert into app.delivery
                   (tenant_id, id, write_id, hlc, source_kind, source_id, carrier_supplier_id,
                    carrier_reference, from_location_id, to_location_id, to_address_text,
                    status, business_date, business_date_derived_from,
                    planned_for, freight_cost_minor, currency_code, money_scale, notes)
                 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PLANNED',$12::date,$13,
                         $14::date,$15,$16,$17,$18)`,
                [
                  tenantId,
                  deliveryId,
                  key,
                  clock.next(),
                  input.sourceKind,
                  input.sourceId,
                  input.carrierSupplierId,
                  input.carrierReference ?? null,
                  input.fromLocationId ?? null,
                  input.toLocationId ?? null,
                  input.toAddressText ?? null,
                  businessDate,
                  businessDateDerivedFrom,
                  input.plannedFor ?? null,
                  input.freightCostMinor === undefined ? null : wire(input.freightCostMinor),
                  pack.currencyCode,
                  wire(pack.moneyScale),
                  input.notes ?? null,
                ],
              );
            },
          };
        },
      );
      return result.response;
    }),

  /**
   * Move a delivery along its state machine, stamping when it happened.
   *
   * ONE mutation rather than dispatch/arrive/fail verbs, because legality
   * lives in the database's transition table and four endpoints would be four
   * places to forget to consult it. DELIVERED and CANCELLED are TERMINAL: a
   * delivery that can be un-delivered is a status nobody can rely on when a
   * customer telephones.
   *
   * `occurredAt` is when the thing happened as observed by whoever recorded
   * it. It lands on `dispatched_at` / `delivered_at` and is DISPLAY
   * information, not an ordering key — causal order is the server-stamped HLC.
   */
  updateStatus: permissionProcedure({ code: 'logistics.dispatch.manage', at: 'any' })
    .input(updateDeliveryStatusInput)
    .mutation(async ({ ctx, input }) => {
      const key = input.idempotencyKey;
      const clock = ctx.deps.clock;
      const occurredAt = input.occurredAt ?? new Date().toISOString();

      const result = await runIdempotent(
        { runner: ctx.deps.runner, clock },
        ctx.identity,
        {
          op: 'logistics.update_delivery_status',
          idempotencyKey: key,
          claimedHlc: input.claimedHlc,
          clientWallAt: input.clientWallAt,
          // NULL for the same reason as planDelivery above: the delivery has
          // to be read before its location is known.
          locationId: null,
        },
        input,
        async (tx) => {
          const res = await tx.query<{
            id: string;
            source_kind: string;
            source_id: string;
            status: string;
            dispatched_at: string | null;
            delivered_at: string | null;
          }>(
            `select id, source_kind, source_id, status, dispatched_at, delivered_at
               from app.delivery where id = $1 and deleted_at is null`,
            [input.deliveryId],
          );
          const delivery = res.rows[0];
          if (!delivery) throw new TRPCError({ code: 'NOT_FOUND', message: 'delivery not found' });

          const costLocationId = await documentLocation(
            tx,
            delivery.source_kind,
            delivery.source_id,
          );
          if (costLocationId === undefined) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'the document this delivery carries is no longer visible in this tenant',
            });
          }
          ctx.permissions.requireAt('logistics.dispatch.manage', costLocationId);

          if (delivery.status === input.toStatus) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: `delivery is already ${input.toStatus}`,
            });
          }
          // THE canonical transition table is the database's. Asked, not
          // copied — a second list in TypeScript is a second list that drifts.
          const legal = await tx.query<{ allowed: boolean }>(
            `select app.delivery_transition_allowed($1, $2) as allowed`,
            [delivery.status, input.toStatus],
          );
          if (legal.rows[0]?.allowed !== true) {
            throw new TRPCError({
              code: 'CONFLICT',
              message:
                `${delivery.status} -> ${input.toStatus} is not a legal delivery transition ` +
                '(app.delivery_legal_transitions(); DELIVERED and CANCELLED are terminal)',
            });
          }

          const dispatchedAt =
            input.toStatus === 'DISPATCHED' ? occurredAt : delivery.dispatched_at;
          const deliveredAt = input.toStatus === 'DELIVERED' ? occurredAt : delivery.delivered_at;

          const response = {
            deliveryId: delivery.id,
            statusBefore: delivery.status,
            status: input.toStatus,
            costLocationId,
            occurredAt,
            dispatchedAt: dispatchedAt === null ? null : new Date(dispatchedAt).toISOString(),
            deliveredAt: deliveredAt === null ? null : new Date(deliveredAt).toISOString(),
            carrierReference: input.carrierReference ?? null,
            failedReason: input.toStatus === 'FAILED' ? (input.reason ?? null) : null,
          };

          return {
            response,
            apply: async (atx) => {
              await atx.query(
                `update app.delivery
                    set status = $1,
                        dispatched_at = $2,
                        delivered_at = $3,
                        failed_reason = case when $1 = 'FAILED' then $4 else failed_reason end,
                        carrier_reference = coalesce($5, carrier_reference),
                        notes = coalesce($6, notes),
                        write_id = $7, hlc = $8, updated_at = transaction_timestamp()
                  where id = $9`,
                [
                  input.toStatus,
                  dispatchedAt,
                  deliveredAt,
                  input.reason ?? null,
                  input.carrierReference ?? null,
                  input.notes ?? null,
                  key,
                  clock.next(),
                  input.deliveryId,
                ],
              );
            },
          };
        },
      );
      return result.response;
    }),

  /**
   * Read one delivery — "where is my cement?", which is a counter question,
   * so `logistics.delivery.view` is the wider grant and the counter holds it
   * in the template. It exposes no commercial terms beyond the freight figure
   * the caller's own scope already covers.
   */
  get: permissionProcedure({ code: 'logistics.delivery.view', at: 'any' })
    .input(deliveryInput)
    .query(async ({ ctx, input }) => {
      return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const res = await tx.query<DeliveryRow>(`${DELIVERY_SELECT} and d.id = $1`, [
          input.deliveryId,
        ]);
        const row = res.rows[0];
        if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'delivery not found' });
        // FAIL CLOSED. A delivery whose location cannot be resolved has no
        // place to check a capability AT, and a capability is always a
        // capability at a place (02 §2.4). Skipping the check for the awkward
        // row is how the awkward row becomes the way in; `list` and
        // `haulageSpend` exclude it by construction, so this matches them.
        if (row.cost_location_id === null) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message:
              'this delivery names neither a visible document nor a location, so there is nowhere ' +
              'to check authority — it cannot be read until one of them is restored',
          });
        }
        ctx.permissions.requireAt('logistics.delivery.view', row.cost_location_id);
        return toDelivery(row);
      });
    }),

  /**
   * List deliveries, narrowed. `locationIds` NARROWS and never widens: the
   * readable set is resolved per request from `app.effective_permission` and
   * the request can only intersect it (see `./scope.ts` rule 1).
   */
  list: permissionProcedure({ code: 'logistics.delivery.view', at: 'any' })
    .input(listDeliveriesInput)
    .query(async ({ ctx, input }) => {
      const scope = await resolveLocationScope(ctx, {
        code: 'logistics.delivery.view',
        requested: input.locationIds,
        kinds: COSTED_KINDS,
      });

      const rows = await ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const res = await tx.query<DeliveryRow>(
          `${DELIVERY_SELECT}
             and coalesce(po.deliver_to_location_id, sa.location_id,
                          d.from_location_id, d.to_location_id) = any($1::uuid[])
             and ($2::text is null or d.source_kind = $2)
             and ($3::uuid is null or d.source_id = $3)
             and ($4::uuid is null or d.carrier_supplier_id = $4)
             and ($5::text[] is null or d.status = any($5::text[]))
             -- ONE period key, and it is the row's own business_date (0010).
             -- The list and the spend report must never disagree about which
             -- period a delivery is in, which is what a read-time coalesce in
             -- two places eventually guarantees they will.
             and ($6::date is null or d.business_date >= $6::date)
             and ($7::date is null or d.business_date <= $7::date)
           order by d.business_date desc, d.id
           limit $8`,
          [
            [...scope.locationIds],
            input.sourceKind ?? null,
            input.sourceId ?? null,
            input.carrierSupplierId ?? null,
            input.statuses ? [...input.statuses] : null,
            input.from ?? null,
            input.to ?? null,
            input.limit ?? 200,
          ],
        );
        return res.rows;
      });

      return {
        scope: { locationCount: scope.locations.length },
        deliveryCount: rows.length,
        deliveries: rows.map(toDelivery),
      };
    }),

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * HAULAGE SPEND — the numerator ADR-0001 owes `open-questions.md` Q1.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * ADR-0001 removed the owned fleet and, with it, Lever 3's mechanism for the
   * financial model's 5.0% → 2.5% distribution-cost curve. What it promised in
   * exchange was that the ERP would MEASURE distribution cost as a percentage
   * of revenue per outlet and per region, so the real trajectory is visible.
   * `reports.distributionCostRatio` already computes the denominator exactly
   * and returns `distributionCostMinor: null` — never zero — because no table
   * recorded the numerator. This is that table, summed.
   *
   * Guarded by `report.view.margin`, NOT by `logistics.delivery.view`. What a
   * delivery costs is a cost figure, and cost figures are a strictly narrower
   * audience than takings — an outlet manager sees their own deliveries and
   * their own sales without seeing what moving the goods cost the business.
   * The same capability, and the same `report.view.tenant` widener, that
   * guards every other margin figure (see `./reports.ts`).
   *
   * THREE HONESTIES, because a spend figure that quietly reads zero is worse
   * than no figure at all:
   *
   *  1. `freight_cost_minor` is NULLABLE and a null is NOT a zero. Deliveries
   *     with no agreed freight are COUNTED separately and the location is
   *     flagged `INCOMPLETE_FREIGHT_BASIS`, so a partial basis can never be
   *     read as a complete one.
   *  2. This is the AGREED freight, not the invoiced one. The authoritative
   *     figure is the haulier's AP invoice, which is Phase 3. Stated on every
   *     response as `basis: 'AGREED_NOT_INVOICED'`.
   *  3. A PERIOD IS THE ROW'S OWN `business_date` (migration 0010), never a
   *     device clock. `periodBasis` still reports how each row in the answer
   *     got its date, because rows written before 0010 were backfilled from
   *     `dispatched_at` and a period that leans on them is not the same
   *     quality of figure as one that was asserted throughout.
   *
   * It also rolls up PER GROUPING NODE — the tenant's regions, in the tenant's
   * own tree — by calling the same `resolveGroupRollup` the sales report uses.
   * ADR-0001 promised distribution cost per outlet AND per region; a second
   * rollup written here, or summed on a client, would be a second answer.
   */
  haulageSpend: permissionProcedure({ code: 'report.view.margin', at: 'any' })
    .input(listDeliveriesInput)
    .query(async ({ ctx, input }) => {
      const scope = await resolveLocationScope(ctx, {
        code: 'report.view.margin',
        widenCode: 'report.view.tenant',
        requested: input.locationIds,
        kinds: COSTED_KINDS,
      });

      /** The tenant's own pack, so an empty period still reports its currency. */
      const { spend, pack } = await ctx.deps.runner.withTenant(
        ctx.identity.tenantId,
        async (tx) => {
          const packMoney = await loadPackMoney(tx);
          const loaded = await loadHaulageSpend(tx, {
            locationIds: scope.locationIds,
            from: input.from,
            to: input.to,
            carrierSupplierId: input.carrierSupplierId,
            sourceKind: input.sourceKind,
            sourceId: input.sourceId,
            statuses: input.statuses,
          });
          return { spend: loaded, pack: packMoney };
        },
      );

      /**
       * "Per region", answered with the tenant's OWN tree.
       *
       * ADR-0001 promised distribution cost per outlet AND per region. The
       * platform has no "region": it has GROUP nodes at whatever depth the
       * tenant chose (04 §4.3, CLAUDE.md §2.9), and `resolveGroupRollup`
       * already walks `app.location_closure` to find them for
       * `reports.salesByLocation`. It is REUSED here rather than re-derived,
       * so a region means the same thing on both sides of the ratio.
       *
       * These NEST: an outlet under Bono is also under the root, so the group
       * subtotals deliberately do NOT sum to the network total. Said out loud
       * as `groupsNest` rather than left for a reader to discover by adding
       * them up and finding double the answer.
       */
      const groups = await resolveGroupRollup(ctx, scope);
      const bucketOf = (id: string): HaulageBucket => spend.byLocation.get(id) ?? emptyBucket();
      const sumOver = (ids: readonly string[]): HaulageBucket =>
        ids.reduce<HaulageBucket>((acc, id) => {
          const b = bucketOf(id);
          return {
            freightMinor: acc.freightMinor + b.freightMinor,
            deliveries: acc.deliveries + b.deliveries,
            withoutFreight: acc.withoutFreight + b.withoutFreight,
          };
        }, emptyBucket());

      /**
       * Rule 1, asserted rather than assumed: the per-location rows must sum
       * to the independently accumulated total. They are built from the same
       * scan here, so this can only fire if a future change starts filtering
       * one and not the other — which is exactly when it should.
       */
      const partsSum = [...spend.byLocation.values()].reduce((a, b) => a + b.freightMinor, 0n);
      if (partsSum !== spend.total.freightMinor) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message:
            `REPORT_IDENTITY_VIOLATION: haulageSpend — Σ(per-location) (${partsSum.toString(10)}) ` +
            `does not equal the total (${spend.total.freightMinor.toString(10)}).`,
        });
      }

      const bucketWire = (b: HaulageBucket) => ({
        haulageSpendMinor: wire(b.freightMinor),
        deliveryCount: b.deliveries,
        deliveriesWithNoAgreedFreight: b.withoutFreight,
        unavailable: b.withoutFreight > 0 ? 'INCOMPLETE_FREIGHT_BASIS' : null,
      });

      return {
        from: input.from ?? null,
        to: input.to ?? null,
        scope: { network: scope.network, locationCount: scope.locations.length },
        currencyCode: spend.currencyCode ?? pack.currencyCode,
        moneyScale: spend.moneyScale ?? wire(pack.moneyScale),
        /** Per location, over the SAME resolved set the total is computed from. */
        locations: scope.locations.map((l) => ({
          locationId: l.id,
          locationCode: l.code,
          locationName: l.name,
          ...bucketWire(bucketOf(l.id)),
        })),
        /** Per grouping node — the tenant's regions, in the tenant's own tree. */
        groups: groups.map((g) => ({
          groupId: g.group.id,
          groupCode: g.group.code,
          groupName: g.group.name,
          locationCount: g.memberIds.length,
          ...bucketWire(sumOver(g.memberIds)),
        })),
        groupsNest: true,
        /** Per haulier — the negotiating view, and ordinary AP by supplier. */
        carriers: [...spend.byCarrier.entries()].map(([id, b]) => ({
          carrierSupplierId: id,
          carrierName: b.name,
          haulageSpendMinor: wire(b.freightMinor),
          deliveryCount: b.deliveries,
          deliveriesWithNoAgreedFreight: b.withoutFreight,
        })),
        total: bucketWire(spend.total),
        /** What this figure IS, said out loud so nobody has to infer it. */
        basis: 'AGREED_NOT_INVOICED',
        excludedStatus: NON_CARRYING_STATUS,
        /**
         * `limit` is part of the shared list input and CANNOT apply to a sum:
         * a capped aggregate is a wrong aggregate. Said out loud rather than
         * dropped silently, which is how a total gets quoted as complete.
         */
        limitApplies: false,
        periodBasis: {
          /** The writer stated the trading day outright. */
          datedByAssertion: spend.periodBasis.asserted,
          datedByPlannedFor: spend.periodBasis.plannedFor,
          /** Pre-0010 rows only. Nothing written since can land here. */
          datedByDispatchClock: spend.periodBasis.dispatchClock,
          datedByRowCreated: spend.periodBasis.rowCreated,
          note: HAULAGE_PERIOD_NOTE,
        },
        method: HAULAGE_METHOD_NOTE,
      };
    }),
});

/** Row → wire DTO. Money and quantities are decimal strings, never numbers. */
function toDelivery(r: DeliveryRow) {
  return {
    deliveryId: r.id,
    sourceKind: r.source_kind,
    sourceId: r.source_id,
    carrierSupplierId: r.carrier_supplier_id,
    carrierName: r.carrier_name,
    carrierReference: r.carrier_reference,
    fromLocationId: r.from_location_id,
    toLocationId: r.to_location_id,
    toAddressText: r.to_address_text,
    /** The location this delivery's freight is attributable to. */
    costLocationId: r.cost_location_id,
    status: r.status,
    /** The trading day this delivery's haulage is attributed to (0010). */
    businessDate: r.business_date,
    /** Null = asserted by the writer. Otherwise the fallback the server used. */
    businessDateDerivedFrom: r.business_date_derived_from,
    plannedFor: r.planned_for,
    dispatchedAt: r.dispatched_at === null ? null : new Date(r.dispatched_at).toISOString(),
    deliveredAt: r.delivered_at === null ? null : new Date(r.delivered_at).toISOString(),
    failedReason: r.failed_reason,
    /** Null is UNKNOWN, never zero (ADR-0001, open-questions Q1). */
    freightCostMinor: r.freight_cost_minor,
    currencyCode: r.currency_code,
    moneyScale: r.money_scale,
    notes: r.notes,
  };
}
