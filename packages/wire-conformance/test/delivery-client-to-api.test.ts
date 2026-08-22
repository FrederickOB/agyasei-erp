/**
 * THE FIFTH UPLOADABLE KIND — and the one place a duplicated table is closed.
 *
 * `logistics.update_delivery_status` is device-uploadable because a delivery
 * status is recorded by whoever hears from the driver, wherever they are. The
 * PWA now has a builder for it
 * (`apps/web/src/data/mutations/updateDeliveryStatus.ts`) and `WIRE_KINDS`
 * carries the kind, which turned the pin in `outbox-surface.test.ts` red on
 * purpose. This file is the answer to that tripwire.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TRANSITION TABLE, COMPARED AGAINST THE DATABASE'S OWN
 * ═══════════════════════════════════════════════════════════════════════════
 * A purchase-order client reads its legal next steps from the SERVER. A
 * delivery's cannot: the move is recorded in a partition, and a device has
 * nobody to ask. So `@erp/contracts` carries `DELIVERY_TRANSITIONS` as data,
 * and the screens offer only what it names — because a device that offered an
 * illegal move would queue a write the server answers CONFLICT to, which the
 * outbox classes RETRYABLE and would therefore retry for ever, surfacing only
 * as a queue that stopped draining in a district town.
 *
 * That duplication is closed the only way duplication can be: the two are
 * compared against EACH OTHER, never each against its own idea of the truth
 * (docs/phase1-status.md §0's one root cause). The first test below reads
 * `app.delivery_legal_transitions()` out of a real Postgres and asserts it
 * equals the contract's table exactly, so a migration that changes one and not
 * the other is a red test rather than a wedged outbox.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ADR-0001: NOT ONE LINE OF THIS FILE NAMES A VEHICLE
 * ═══════════════════════════════════════════════════════════════════════════
 * A carrier is a SUPPLIER holding a capability whose PLATFORM kind is HAULAGE.
 * There is no driver, no registration and no fuel figure here, because no such
 * entity exists anywhere in the product.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DELIVERY_STATUSES,
  DELIVERY_TRANSITIONS,
  deviceOpContracts,
  legalDeliveryNextStatuses,
  updateDeliveryStatusInput,
  type DeliveryStatus,
} from '@erp/contracts';
import { uuidv7 } from '@erp/db';

// ---- the server, from apps/api's own sources -------------------------------
import { signDevToken } from '../../../apps/api/src/auth.js';
import { appRouter } from '../../../apps/api/src/routers/index.js';
import { buildServer } from '../../../apps/api/src/server.js';
import { createApiHarness, JWT_SECRET, type ApiHarness } from '../../../apps/api/test/util.js';

// ---- the client, from apps/web's own sources -------------------------------
import {
  DELIVERY_STATUS_OUTBOX_KIND,
  recordDeliveryStatus,
} from '../../../apps/web/src/data/mutations/updateDeliveryStatus';
import { pendingDeliveryStatuses } from '../../../apps/web/src/data/queries/procurement-outbox';
import type { FetchLike, HttpResponseLike } from '../../../apps/web/src/data/sync/credentials';
import { WIRE_KINDS, httpUploadTransport } from '../../../apps/web/src/data/sync/transport';
import { drainOutbox, readPendingOps } from '../../../apps/web/src/data/sync/upload';
import type { LocalDb } from '../../../apps/web/src/data/db';
import { openTestDb } from '../../../apps/web/tests/helpers/node-db';
import { fixedHlc, provisionDevice } from '../../../apps/web/tests/helpers/fixtures';

const PWA_ORIGIN = 'http://localhost:5173';
const CLOCK_BASE_MS = Date.now();
const NODE_ROAD = 'e1'.repeat(16);

function tillClock(offsetSeconds = 0): string {
  return new Date(CLOCK_BASE_MS + offsetSeconds * 1_000).toISOString();
}

type Server = Awaited<ReturnType<typeof buildServer>>;

let h: ApiHarness;
let app: Server;
let tenantId: string;
let outlet: { id: string; code: string };
let bearer: string;
let carrierSupplierId: string;
let approverUserId: string;
let productId: string;

const browserFetch: FetchLike = async (url, init) => {
  const path = new URL(url, 'http://api.local').pathname;
  const res = await app.inject({
    method: (init.method as 'GET' | 'POST') ?? 'GET',
    url: path,
    headers: { ...init.headers, origin: PWA_ORIGIN },
    ...(init.body === undefined ? {} : { payload: init.body }),
  });
  const response: HttpResponseLike = {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    json: () => Promise.resolve(res.json<unknown>()),
  };
  return response;
};

function online() {
  return httpUploadTransport({ apiUrl: 'http://api.local', apiToken: bearer, fetchFn: browserFetch });
}

function partitioned() {
  const dead: FetchLike = () => Promise.reject(new Error('network unreachable'));
  return httpUploadTransport({ apiUrl: 'http://api.local', apiToken: bearer, fetchFn: dead });
}

async function newWrite(op: string): Promise<string> {
  return h.db.withTenant(tenantId, async (tx) => {
    const id = uuidv7();
    await tx.query(
      `insert into app.write_log (tenant_id, id, origin, hlc, op, schema_version, request_hash)
       values ($1,$2,'SERVER',$3,$4,1,decode('00','hex'))`,
      [tenantId, id, h.deps.clock.next(), op],
    );
    return id;
  });
}

/**
 * A haulier: a supplier holding a capability whose PLATFORM kind is HAULAGE.
 * The tenant's own word for it is deliberately not "haulage", so a guard that
 * read the tenant's code instead of the platform kind would fail here.
 */
async function seedCarrier(): Promise<void> {
  const writeId = await newWrite('test.carrier');
  await h.db.withTenant(tenantId, async (tx) => {
    const capTypeId = uuidv7();
    await tx.query(
      `insert into app.supplier_capability_type (tenant_id, id, write_id, hlc, code, name, kind)
       values ($1,$2,$3,$4,'ROAD-TRUCKS','Trucking','HAULAGE')`,
      [tenantId, capTypeId, writeId, h.deps.clock.next()],
    );
    carrierSupplierId = uuidv7();
    const pack = await tx.query<{ currency_code: string }>(
      `select j.currency_code from platform.tenant t
         join platform.jurisdiction j on j.code = t.jurisdiction_code
        where t.id = app.current_tenant()`,
    );
    await tx.query(
      `insert into app.supplier
         (tenant_id, id, write_id, hlc, code, name, payment_terms_days, currency_code)
       values ($1,$2,$3,$4,'ROAD-1','Road Partners',14,$5)`,
      [tenantId, carrierSupplierId, writeId, h.deps.clock.next(), pack.rows[0]!.currency_code],
    );
    await tx.query(
      `insert into app.supplier_capability (tenant_id, id, write_id, hlc, supplier_id, capability_type_id)
       values ($1,$2,$3,$4,$5,$6)`,
      [tenantId, uuidv7(), writeId, h.deps.clock.next(), carrierSupplierId, capTypeId],
    );
  });
}

/** An APPROVED order for the delivery to carry, and its own delivery. */
async function plannedDelivery(): Promise<string> {
  const writeId = await newWrite('test.delivery');
  return h.db.withTenant(tenantId, async (tx) => {
    const pack = await tx.query<{ currency_code: string; minor_units_per_major: string }>(
      `select j.currency_code, j.minor_units_per_major::text
         from platform.tenant t
         join platform.jurisdiction j on j.code = t.jurisdiction_code
        where t.id = app.current_tenant()`,
    );
    const orderId = uuidv7();
    await tx.query(
      `insert into app.purchase_order
         (tenant_id, id, write_id, hlc, supplier_id, deliver_to_location_id, status,
          order_date, currency_code, money_scale)
       values ($1,$2,$3,$4,$5,$6,'DRAFT','2026-08-20',$7,$8)`,
      [
        tenantId,
        orderId,
        writeId,
        h.deps.clock.next(),
        carrierSupplierId,
        outlet.id,
        pack.rows[0]!.currency_code,
        pack.rows[0]!.minor_units_per_major,
      ],
    );
    const meta = await tx.query<{
      stocking_uom_id: string;
      stocking_scale: number;
      factor_num: string;
      factor_den: string;
    }>(
      `select p.stocking_uom_id, u.qty_scale as stocking_scale,
              pu.factor_num::text, pu.factor_den::text
         from app.product p
         join app.unit_of_measure u on u.tenant_id = p.tenant_id and u.id = p.stocking_uom_id
         join app.product_uom pu
           on pu.tenant_id = p.tenant_id and pu.product_id = p.id
          and pu.uom_id = p.stocking_uom_id and pu.deleted_at is null and pu.can_buy
        where p.id = $1 and p.deleted_at is null`,
      [productId],
    );
    const m = meta.rows[0]!;
    await tx.query(
      `insert into app.purchase_order_line
         (tenant_id, id, write_id, hlc, purchase_order_id, line_no, product_id,
          uom_id, qty_scale, qty_ordered, unit_price_e4,
          stocking_uom_id, qty_stock_scale, qty_ordered_stock, factor_num, factor_den,
          line_net_minor)
       values ($1,$2,$3,$4,$5,1,$6,$7,$8,'20','250000',$7,$8,'20',$9,$10,'5000')`,
      [
        tenantId,
        uuidv7(),
        writeId,
        h.deps.clock.next(),
        orderId,
        productId,
        m.stocking_uom_id,
        m.stocking_scale,
        m.factor_num,
        m.factor_den,
      ],
    );
    await tx.query(
      `update app.purchase_order set status='SUBMITTED', submitted_at=transaction_timestamp()
        where id=$1`,
      [orderId],
    );
    await tx.query(
      `update app.purchase_order
          set status='APPROVED', approved_at=transaction_timestamp(), approved_by_user_id=$2
        where id=$1`,
      [orderId, approverUserId],
    );

    const deliveryId = uuidv7();
    await tx.query(
      `insert into app.delivery
         (tenant_id, id, write_id, hlc, source_kind, source_id, carrier_supplier_id,
          status, planned_for, freight_cost_minor, business_date, currency_code, money_scale)
       values ($1,$2,$3,$4,'PURCHASE_ORDER',$5,$6,'PLANNED','2026-08-24','120000','2026-08-24',$7,$8)`,
      [
        tenantId,
        deliveryId,
        writeId,
        h.deps.clock.next(),
        orderId,
        carrierSupplierId,
        pack.rows[0]!.currency_code,
        pack.rows[0]!.minor_units_per_major,
      ],
    );
    return deliveryId;
  });
}

async function statusOf(deliveryId: string): Promise<string> {
  return h.db.asAdmin(async (tx) => {
    const res = await tx.query<{ status: string }>(
      `select status from app.delivery where tenant_id = $1 and id = $2`,
      [tenantId, deliveryId],
    );
    return res.rows[0]?.status ?? '(missing)';
  });
}

async function device(): Promise<LocalDb> {
  const db = openTestDb();
  await provisionDevice(db, { locationId: outlet.id, locationCode: outlet.code });
  return db;
}

beforeAll(async () => {
  h = await createApiHarness();
  tenantId = await h.provisionTenant('road-co');
  await h.applyTemplate(tenantId, true);
  outlet = await h.firstOutlet(tenantId);
  productId = (await h.pickProduct(tenantId)).id;
  const uid = '018f3a1e-0000-7000-8000-0000000000e7';
  await h.grantOwner(tenantId, uid);
  approverUserId = uid;
  await seedCarrier();
  bearer = await signDevToken(JWT_SECRET, {
    tid: tenantId,
    uid,
    role: 'outlet-manager',
    locs: [outlet.id],
  });
  app = await buildServer({
    deps: h.deps,
    jwtSecret: JWT_SECRET,
    sync: { powersyncUrl: 'http://localhost:8080' },
    corsOrigins: [PWA_ORIGIN],
  });
});

afterAll(async () => {
  await app?.close();
  await h?.close();
});

// ---------------------------------------------------------------------------
// 1. The duplicated table, closed
// ---------------------------------------------------------------------------

describe('the contract’s transition table IS the database’s', () => {
  it('matches app.delivery_legal_transitions() exactly, both directions', async () => {
    const rows = await h.db.withTenant(tenantId, async (tx) => {
      const res = await tx.query<{ from_status: string; to_status: string }>(
        `select from_status, to_status from app.delivery_legal_transitions()
          order by from_status, to_status`,
      );
      return res.rows;
    });

    const fromDatabase = new Map<string, string[]>();
    for (const status of DELIVERY_STATUSES) fromDatabase.set(status, []);
    for (const r of rows) {
      const list = fromDatabase.get(r.from_status);
      // A status the database knows and the contract does not is itself a
      // failure: a device would render it as an unknown word.
      expect(list, `the database has a status the contract does not: ${r.from_status}`).toBeDefined();
      list?.push(r.to_status);
    }

    for (const status of DELIVERY_STATUSES) {
      expect(
        [...(fromDatabase.get(status) ?? [])].sort(),
        `${status}: the contract and the database disagree about the legal next steps. ` +
          'A device offering a move the database refuses queues a CONFLICT the outbox retries ' +
          'for ever. Fix the contract, or the migration, in the same change.',
      ).toEqual([...DELIVERY_TRANSITIONS[status]].sort());
    }
  });

  it('agrees that DELIVERED and CANCELLED are terminal', () => {
    expect(legalDeliveryNextStatuses('DELIVERED')).toEqual([]);
    expect(legalDeliveryNextStatuses('CANCELLED')).toEqual([]);
    // An unknown status offers nothing rather than everything.
    expect(legalDeliveryNextStatuses('INVENTED')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. The client's REAL payload, against the server's REAL parser
// ---------------------------------------------------------------------------

function routerInputOf(procedure: unknown): unknown {
  const def = (procedure as { _def?: { inputs?: unknown[] } })._def;
  const inputs = def?.inputs ?? [];
  if (inputs.length !== 1) throw new Error(`expected exactly one input schema, got ${inputs.length}`);
  return inputs[0];
}

describe("the status builder's own bytes satisfy the parser the router runs", () => {
  it('parses the bytes recordDeliveryStatus put in the outbox', async () => {
    const db = await device();
    const deliveryId = await plannedDelivery();

    await recordDeliveryStatus(db, {
      updateId: uuidv7(),
      deliveryId,
      fromStatus: 'PLANNED',
      toStatus: 'DISPATCHED',
      carrierReference: 'RP-4471',
      hlc: fixedHlc(CLOCK_BASE_MS, NODE_ROAD),
      nowIso: tillClock(),
    });

    const pending = await readPendingOps(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.kind).toBe(DELIVERY_STATUS_OUTBOX_KIND);
    expect(WIRE_KINDS[DELIVERY_STATUS_OUTBOX_KIND]).toBe('logistics.update_delivery_status');

    const parser = routerInputOf(appRouter.logistics.updateStatus) as typeof updateDeliveryStatusInput;
    const parsed = parser.safeParse(JSON.parse(pending[0]!.payloadJson));
    if (!parsed.success) {
      throw new Error(
        `the client's payload does not satisfy the API's schema: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
    }
    expect(deviceOpContracts['logistics.update_delivery_status']).toBe(updateDeliveryStatusInput);
  });
});

// ---------------------------------------------------------------------------
// 3. Recorded in a real partition, drained on reconnect
// ---------------------------------------------------------------------------

describe('a status heard from the driver with no signal', () => {
  it('is complete locally, ABSENT from the server, and lands on reconnect', async () => {
    const db = await device();
    const deliveryId = await plannedDelivery();

    await recordDeliveryStatus(db, {
      updateId: uuidv7(),
      deliveryId,
      fromStatus: 'PLANNED',
      toStatus: 'DISPATCHED',
      hlc: fixedHlc(CLOCK_BASE_MS, NODE_ROAD),
      nowIso: tillClock(1),
    });

    expect(await statusOf(deliveryId)).toBe('PLANNED');
    const dead = await drainOutbox(db, partitioned());
    expect(dead.completed).toBe(0);
    expect(dead.deferred).toBe(1);
    expect(await statusOf(deliveryId)).toBe('PLANNED');

    // While it is queued the CLIENT knows the status it will have, so a screen
    // never renders the server's older one beside a queued move — which is how
    // the same move gets recorded twice.
    const queued = await pendingDeliveryStatuses(db);
    expect(queued.get(deliveryId)?.toStatus).toBe('DISPATCHED');

    const drained = await drainOutbox(db, online());
    expect(drained.completed).toBe(1);
    expect(await statusOf(deliveryId)).toBe('DISPATCHED');
    expect((await pendingDeliveryStatuses(db)).size).toBe(0);
  });

  it('applies a queued sequence in order, so the last move is the one that stands', async () => {
    const db = await device();
    const deliveryId = await plannedDelivery();

    // Two moves recorded in one partition — dispatched at the gate, arrived an
    // hour later — and the outbox is ORDERED, so the server sees them that way.
    await recordDeliveryStatus(db, {
      updateId: uuidv7(),
      deliveryId,
      fromStatus: 'PLANNED',
      toStatus: 'DISPATCHED',
      hlc: fixedHlc(CLOCK_BASE_MS, NODE_ROAD),
      nowIso: tillClock(2),
    });
    await recordDeliveryStatus(db, {
      updateId: uuidv7(),
      deliveryId,
      fromStatus: 'DISPATCHED',
      toStatus: 'DELIVERED',
      hlc: fixedHlc(CLOCK_BASE_MS, NODE_ROAD),
      nowIso: tillClock(3),
    });

    const report = await drainOutbox(db, online());
    expect(report.completed).toBe(2);
    expect(report.rejected).toBe(0);
    expect(await statusOf(deliveryId)).toBe('DELIVERED');
  });

  it('records a FAILED delivery with the reason the contract insists on', async () => {
    const db = await device();
    const deliveryId = await plannedDelivery();

    await recordDeliveryStatus(db, {
      updateId: uuidv7(),
      deliveryId,
      fromStatus: 'PLANNED',
      toStatus: 'DISPATCHED',
      hlc: fixedHlc(CLOCK_BASE_MS, NODE_ROAD),
      nowIso: tillClock(4),
    });
    await recordDeliveryStatus(db, {
      updateId: uuidv7(),
      deliveryId,
      fromStatus: 'DISPATCHED',
      toStatus: 'FAILED',
      reason: 'The bridge at the junction was closed.',
      hlc: fixedHlc(CLOCK_BASE_MS, NODE_ROAD),
      nowIso: tillClock(5),
    });

    const report = await drainOutbox(db, online());
    expect(report.completed).toBe(2);
    expect(await statusOf(deliveryId)).toBe('FAILED');

    const reason = await h.db.asAdmin(async (tx) => {
      const res = await tx.query<{ failed_reason: string | null }>(
        `select failed_reason from app.delivery where tenant_id = $1 and id = $2`,
        [tenantId, deliveryId],
      );
      return res.rows[0]?.failed_reason;
    });
    expect(reason).toMatch(/bridge/);
  });

  it('never offers a move the database would refuse — checked against the machine itself', async () => {
    const db = await device();
    const deliveryId = await plannedDelivery();

    // What a screen would offer from PLANNED, taken from the shared contract…
    const offered = legalDeliveryNextStatuses('PLANNED');
    expect(offered.length).toBeGreaterThan(0);

    // …and every one of them really is accepted by the live route. This is the
    // half that makes the table comparison above worth having: a table that
    // agreed on paper and was refused in practice would still wedge a queue.
    for (const to of offered) {
      const fresh = await plannedDelivery();
      await recordDeliveryStatus(db, {
        updateId: uuidv7(),
        deliveryId: fresh,
        fromStatus: 'PLANNED',
        toStatus: to as DeliveryStatus,
        ...(to === 'FAILED' ? { reason: 'not reachable from PLANNED' } : {}),
        hlc: fixedHlc(CLOCK_BASE_MS, NODE_ROAD),
        nowIso: tillClock(6),
      });
      const report = await drainOutbox(db, online());
      expect(report.rejected, `${to} was refused by the live route`).toBe(0);
      expect(await statusOf(fresh)).toBe(to);
    }
    // The one queued for the original delivery is untouched by all that.
    expect(await statusOf(deliveryId)).toBe('PLANNED');
  });
});
