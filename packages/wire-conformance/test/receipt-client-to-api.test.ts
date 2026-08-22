/**
 * THE FOURTH UPLOADABLE KIND, PROVEN THE SAME WAY THE FIRST THREE ARE.
 *
 * `goods.record_receipt` was registered in `DEVICE_OP_KINDS` and dispatched by
 * `apps/api/src/sync.ts` before any client could emit it —
 * `outbox-surface.test.ts` ran one hand-written contract-shaped payload
 * through the live route and said, in its own header, that this proves nothing
 * about a builder that does not exist. A builder now exists
 * (`apps/web/src/data/mutations/recordGoodsReceipt.ts`) and `WIRE_KINDS`
 * carries the kind, which turned the pin in `outbox-surface.test.ts` red on
 * purpose. This file is the answer to that tripwire, and nothing about the
 * tripwire was relaxed.
 *
 * Nothing stands in for either side:
 *   client  apps/web's real local SQLite on the device's own schema, the real
 *           `loadPurchasableProducts` / `loadPurchaseUnits` read paths, the
 *           real `recordGoodsReceipt` → outbox → `readPendingOps` →
 *           `drainOutbox` → `httpUploadTransport`.
 *   wire    a real fetch-shaped call carrying a browser `Origin` at a real
 *           Fastify server with CORS configured; `app.inject()` is the socket.
 *   server  apps/api's real `/sync/upload` route, the real
 *           `receiving.recordReceipt` router, the real idempotent pipeline,
 *           real Postgres (PGlite) with RLS on and 0008's triggers live.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PARTITION IS THE POINT, NOT DECORATION
 * ---------------------------------------------------------------------------
 * A goods receipt is TRADE. The truck is at the gate and the bags are on the
 * ground whether or not the tower is up, and CLAUDE.md §2.2 says the location
 * must be able to record that and sync it cleanly later. So the sequence
 * below is: radio OFF → sign for it → the write is complete locally and ABSENT
 * from the server → radio ON → drain → acked `applied` → the receipt, its
 * lines AND its stock movements are in Postgres, once. A test that recorded
 * and drained in one breath would pass against a client that awaited a socket,
 * which is the one thing this op must never do.
 *
 * ---------------------------------------------------------------------------
 * THE CONVERSION IS CHECKED AGAINST THE SERVER'S OWN, NOT AGAINST A LITERAL
 * ---------------------------------------------------------------------------
 * The device computes what the conversion says entered the yard with
 * `toStockQty` (`apps/web/src/data/queries/purchase-units.ts`); the server
 * computes `qty_stock_computed` with its own expression and stores it. The
 * assertions below compare THOSE TWO, rather than each against a number
 * written here — which is the one root cause `docs/phase1-status.md` §0 names:
 * both sides tested against a third thing that agreed with neither.
 *
 * If they disagreed, every honest line would arrive looking like a variance
 * and every yard would learn to override the figure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deviceOpContracts, recordGoodsReceiptInput } from '@erp/contracts';
import { uuidv7 } from '@erp/db';

// ---- the server, from apps/api's own sources -------------------------------
import { signDevToken } from '../../../apps/api/src/auth.js';
import { appRouter } from '../../../apps/api/src/routers/index.js';
import { buildServer } from '../../../apps/api/src/server.js';
import { createApiHarness, JWT_SECRET, type ApiHarness } from '../../../apps/api/test/util.js';

// ---- the client, from apps/web's own sources -------------------------------
import {
  RECEIPT_OUTBOX_KIND,
  recordGoodsReceipt,
} from '../../../apps/web/src/data/mutations/recordGoodsReceipt';
import {
  loadPurchasableProducts,
  loadPurchaseUnits,
  toStockQty,
} from '../../../apps/web/src/data/queries/purchase-units';
import type { FetchLike, HttpResponseLike } from '../../../apps/web/src/data/sync/credentials';
import { WIRE_KINDS, httpUploadTransport } from '../../../apps/web/src/data/sync/transport';
import { drainOutbox, readPendingOps } from '../../../apps/web/src/data/sync/upload';
import type { LocalDb } from '../../../apps/web/src/data/db';
import { openTestDb } from '../../../apps/web/tests/helpers/node-db';
import {
  fixedHlc,
  provisionDevice,
  seedProduct,
  seedPurchaseUnit,
} from '../../../apps/web/tests/helpers/fixtures';

const PWA_ORIGIN = 'http://localhost:5173';

/**
 * The device's wall clock, derived from NOW: `apps/api/src/pipeline.ts` clamps
 * a claimed HLC at ±24h of the server's clock and refuses beyond it BEFORE the
 * payload is parsed, so a hard-coded instant here is a test with a one-day
 * shelf life (docs/phase1-status.md §0, the EXPIRED-suite row).
 */
const CLOCK_BASE_MS = Date.now();

function tillClock(offsetSeconds = 0): string {
  const iso = new Date(CLOCK_BASE_MS + offsetSeconds * 1_000).toISOString();
  if (Math.abs(Date.parse(iso) - Date.now()) > 24 * 60 * 60 * 1000) {
    throw new Error('this test derives its clock from Date.now(); it must never be hard-coded');
  }
  return iso;
}

const NODE_YARD = 'd1'.repeat(16);

type Server = Awaited<ReturnType<typeof buildServer>>;

let h: ApiHarness;
let app: Server;
let tenantId: string;
let outlet: { id: string; code: string };
let bearer: string;
let supplierId: string;
let approverUserId: string;

/** The SERVER's own catalogue ids, mirrored onto the device below. */
let productId: string;
let skuCode: string;
let stockingUomId: string;
let purchaseUomId: string;
let purchaseUomCode: string;

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

/** The real transport, connected. */
function online() {
  return httpUploadTransport({ apiUrl: 'http://api.local', apiToken: bearer, fetchFn: browserFetch });
}

/**
 * The real transport with the radio OFF. The `fetch` REJECTS, exactly as it
 * does for a dead link — not a stubbed transport that returns `{ok:false}`,
 * because the code under test is the transport's own failure handling.
 */
function partitioned() {
  const dead: FetchLike = () => Promise.reject(new Error('network unreachable'));
  return httpUploadTransport({ apiUrl: 'http://api.local', apiToken: bearer, fetchFn: dead });
}

// ---------------------------------------------------------------------------
// Server fixtures, written the way a real caller would write them
// ---------------------------------------------------------------------------

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
 * A product stocked in a DISCRETE unit and bought in a CONTINUOUS one, at
 * exactly 13500/144 of one per the other — 04 §4.4.1's hard case, and the
 * only place a receipt's two quantities stop being the same number.
 */
async function seedServerCatalogue(): Promise<void> {
  const writeId = await newWrite('test.catalogue');
  await h.db.withTenant(tenantId, async (tx) => {
    const categoryId = uuidv7();
    await tx.query(
      `insert into app.product_category (tenant_id, id, write_id, hlc, code, name)
       values ($1,$2,$3,$4,$5,$5)`,
      [tenantId, categoryId, writeId, h.deps.clock.next(), `CAT-${categoryId.slice(-6)}`],
    );
    stockingUomId = uuidv7();
    purchaseUomId = uuidv7();
    purchaseUomCode = `TON-${categoryId.slice(-4)}`;
    await tx.query(
      `insert into app.unit_of_measure (tenant_id, id, write_id, hlc, code, name, dimension, qty_scale)
       values ($1,$2,$3,$4,$5,$5,'COUNT',0)`,
      [tenantId, stockingUomId, writeId, h.deps.clock.next(), `BAR-${categoryId.slice(-4)}`],
    );
    await tx.query(
      `insert into app.unit_of_measure (tenant_id, id, write_id, hlc, code, name, dimension, qty_scale)
       values ($1,$2,$3,$4,$5,$5,'MASS',3)`,
      [tenantId, purchaseUomId, writeId, h.deps.clock.next(), purchaseUomCode],
    );
    productId = uuidv7();
    skuCode = `SKU-${productId.slice(-6)}`;
    await tx.query(
      `insert into app.product
         (tenant_id, id, write_id, hlc, sku_code, name, category_id, stocking_uom_id, tax_code)
       values ($1,$2,$3,$4,$5,$5,$6,$7,'GH.VAT.STD')`,
      [tenantId, productId, writeId, h.deps.clock.next(), skuCode, categoryId, stockingUomId],
    );
    await tx.query(
      `insert into app.product_uom
         (tenant_id, id, write_id, hlc, product_id, uom_id, factor_num, factor_den,
          can_sell, can_buy, is_default_sell, tolerance_bp, sort_order)
       values ($1,$2,$3,$4,$5,$6,1,1,true,true,true,0,0)`,
      [tenantId, uuidv7(), writeId, h.deps.clock.next(), productId, stockingUomId],
    );
    // 43 bp is one bar of slack on a 234-bar line (04 §4.4.4). It has no
    // default and must be stated.
    await tx.query(
      `insert into app.product_uom
         (tenant_id, id, write_id, hlc, product_id, uom_id, factor_num, factor_den,
          can_sell, can_buy, is_default_sell, tolerance_bp, sort_order)
       values ($1,$2,$3,$4,$5,$6,13500,144,false,true,false,43,1)`,
      [tenantId, uuidv7(), writeId, h.deps.clock.next(), productId, purchaseUomId],
    );
  });
}

/**
 * A FRESH APPROVED ORDER PER TEST, and that is not tidiness.
 *
 * A receipt advances its order's status: ten tonnes against ten ordered leaves
 * it RECEIVED, and 0008 then refuses any further receipt against it. Sharing
 * one order between tests would make the second one fail for a reason that has
 * nothing to do with what it is testing — and, worse, would make it pass again
 * the day somebody weakened that refusal.
 */
async function approvedOrder(approverUserId: string): Promise<{ orderId: string; lineId: string }> {
  const writeId = await newWrite('test.purchase_order');
  return h.db.withTenant(tenantId, async (tx) => {
    const pack = await tx.query<{ currency_code: string; minor_units_per_major: string }>(
      `select j.currency_code, j.minor_units_per_major::text
         from platform.tenant t
         join platform.jurisdiction j on j.code = t.jurisdiction_code
        where t.id = app.current_tenant()`,
    );
    // DRAFT first — 0008 refuses an insert at any other status, which is the
    // structural half of "approving is a separate act".
    const purchaseOrderId = uuidv7();
    await tx.query(
      `insert into app.purchase_order
         (tenant_id, id, write_id, hlc, supplier_id, deliver_to_location_id, status,
          order_date, currency_code, money_scale)
       values ($1,$2,$3,$4,$5,$6,'DRAFT','2026-08-20',$7,$8)`,
      [
        tenantId,
        purchaseOrderId,
        writeId,
        h.deps.clock.next(),
        supplierId,
        outlet.id,
        pack.rows[0]!.currency_code,
        pack.rows[0]!.minor_units_per_major,
      ],
    );
    const purchaseOrderLineId = uuidv7();
    // 10.000 t at 13500/144 bars per tonne. The stock figure on the ORDER is
    // the server's own; nothing in this test asserts a literal against it.
    await tx.query(
      `insert into app.purchase_order_line
         (tenant_id, id, write_id, hlc, purchase_order_id, line_no, product_id,
          uom_id, qty_scale, qty_ordered, unit_price_e4,
          stocking_uom_id, qty_stock_scale, qty_ordered_stock, factor_num, factor_den,
          line_net_minor)
       values ($1,$2,$3,$4,$5,1,$6,$7,3,'10000','45000000',$8,0,'938',13500,144,'4500000')`,
      [
        tenantId,
        purchaseOrderLineId,
        writeId,
        h.deps.clock.next(),
        purchaseOrderId,
        productId,
        purchaseUomId,
        stockingUomId,
      ],
    );
    await tx.query(
      `update app.purchase_order set status='SUBMITTED', submitted_at=transaction_timestamp()
        where id=$1`,
      [purchaseOrderId],
    );
    // 0008 refuses an APPROVED order with nobody's name on it: an approval
    // with no approver is not an approval.
    await tx.query(
      `update app.purchase_order
          set status='APPROVED', approved_at=transaction_timestamp(), approved_by_user_id=$2
        where id=$1`,
      [purchaseOrderId, approverUserId],
    );
    return { orderId: purchaseOrderId, lineId: purchaseOrderLineId };
  });
}

/** The supplier every order in this file is with. Created once. */
async function seedSupplier(): Promise<void> {
  const writeId = await newWrite('test.supplier');
  await h.db.withTenant(tenantId, async (tx) => {
    // The tenant's own capability vocabulary; the platform `kind` is what
    // anything may branch on (ADR-0006).
    const capTypeId = uuidv7();
    await tx.query(
      `insert into app.supplier_capability_type (tenant_id, id, write_id, hlc, code, name, kind)
       values ($1,$2,$3,$4,'YARD-SELLS','Sells things','GOODS')`,
      [tenantId, capTypeId, writeId, h.deps.clock.next()],
    );
    supplierId = uuidv7();
    const pack = await tx.query<{ currency_code: string }>(
      `select j.currency_code
         from platform.tenant t
         join platform.jurisdiction j on j.code = t.jurisdiction_code
        where t.id = app.current_tenant()`,
    );
    await tx.query(
      `insert into app.supplier
         (tenant_id, id, write_id, hlc, code, name, payment_terms_days, currency_code)
       values ($1,$2,$3,$4,'YARD-SUP','Yard Supply',30,$5)`,
      [tenantId, supplierId, writeId, h.deps.clock.next(), pack.rows[0]!.currency_code],
    );
    await tx.query(
      `insert into app.supplier_capability (tenant_id, id, write_id, hlc, supplier_id, capability_type_id)
       values ($1,$2,$3,$4,$5,$6)`,
      [tenantId, uuidv7(), writeId, h.deps.clock.next(), supplierId, capTypeId],
    );
  });
}

/**
 * A device holding the SERVER's real product id and the SERVER's real purchase
 * unit — i.e. the rows the `tenant_reference` sync bucket would have
 * delivered, and nothing the server has not heard of.
 */
async function provisionedDevice(): Promise<LocalDb> {
  const db = openTestDb();
  const device = await provisionDevice(db, { locationId: outlet.id, locationCode: outlet.code });
  await seedProduct(db, {
    id: productId,
    code: skuCode,
    name: 'Reinforcing bar 12mm',
    // The STOCKING unit, at the server's own scale.
    uomLabel: 'BAR',
    qtyScale: 0,
    unitPriceE4: 25_000_000n,
    priceListId: device.priceListId,
  });
  await seedPurchaseUnit(db, {
    productId,
    // THE SERVER'S OWN uom id: the payload names it, and a fresh one here
    // would be a unit the API has never heard of.
    uomId: purchaseUomId,
    code: purchaseUomCode,
    qtyScale: 3,
    factorNum: 13500n,
    factorDen: 144n,
    toleranceBp: 43n,
  });
  return db;
}

// ---------------------------------------------------------------------------

interface ReceiptRow {
  id: string;
  purchase_order_id: string | null;
  supplier_id: string;
  location_id: string;
  business_date: string;
}

async function receiptFor(writeKey: string): Promise<ReceiptRow[]> {
  return h.db.asAdmin(async (tx) => {
    const res = await tx.query<ReceiptRow>(
      `select id, purchase_order_id, supplier_id, location_id, business_date::text as business_date
         from app.goods_receipt where tenant_id = $1 and write_id = $2`,
      [tenantId, writeKey],
    );
    return res.rows;
  });
}

async function receiptLines(writeKey: string): Promise<
  { qty_received: string; qty_stock: string; qty_stock_computed: string; conversion_confirmed_by: string | null }[]
> {
  return h.db.asAdmin(async (tx) => {
    const res = await tx.query<{
      qty_received: string;
      qty_stock: string;
      qty_stock_computed: string;
      conversion_confirmed_by: string | null;
    }>(
      `select qty_received::text, qty_stock::text, qty_stock_computed::text, conversion_confirmed_by
         from app.goods_receipt_line where tenant_id = $1 and write_id = $2 order by line_no`,
      [tenantId, writeKey],
    );
    return res.rows;
  });
}

async function movements(writeKey: string): Promise<{ qty_delta: string; source_kind: string }[]> {
  return h.db.asAdmin(async (tx) => {
    const res = await tx.query<{ qty_delta: string; source_kind: string }>(
      `select qty_delta::text, source_kind from app.stock_movement
        where tenant_id = $1 and write_id = $2`,
      [tenantId, writeKey],
    );
    return res.rows;
  });
}

beforeAll(async () => {
  h = await createApiHarness();
  tenantId = await h.provisionTenant('gate-co');
  await h.applyTemplate(tenantId, true);
  outlet = await h.firstOutlet(tenantId);
  await seedServerCatalogue();

  // Payload shape, not authority: the uploader is granted breadth here, and
  // `apps/api/test/receiving.test.ts` plus the live RBAC drill are the files
  // about who may sign for goods where.
  const uid = '018f3a1e-0000-7000-8000-0000000000d7';
  await h.grantOwner(tenantId, uid);
  approverUserId = uid;
  await seedSupplier();
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
// 1. The client's REAL payload, against the server's REAL parser
// ---------------------------------------------------------------------------

/** The input object pulled back out of the LIVE procedure, not imported. */
function routerInputOf(procedure: unknown): unknown {
  const def = (procedure as { _def?: { inputs?: unknown[] } })._def;
  const inputs = def?.inputs ?? [];
  if (inputs.length !== 1) throw new Error(`expected exactly one input schema, got ${inputs.length}`);
  return inputs[0];
}

describe("the receipt builder's own bytes satisfy the parser the router runs", () => {
  it('parses the bytes recordGoodsReceipt put in the outbox — not a hand-written fixture', async () => {
    const db = await provisionedDevice();
    const { orderId: purchaseOrderId, lineId: purchaseOrderLineId } = await approvedOrder(
      approverUserId,
    );
    // The yard's REAL read paths. A hand-written SELECT here would prove the
    // wire against a catalogue the device does not have.
    const products = await loadPurchasableProducts(db);
    expect(products.map((p) => p.id)).toContain(productId);
    const units = await loadPurchaseUnits(db, productId);
    const tonne = units.find((u) => u.uomId === purchaseUomId);
    expect(tonne).toBeDefined();

    const receiptId = uuidv7();
    await recordGoodsReceipt(db, {
      goodsReceiptId: receiptId,
      supplierId,
      purchaseOrderId,
      lines: [
        {
          purchaseOrderLineId,
          productId,
          unit: tonne!,
          qtyReceived: 10_000n,
          unitCostE4: 45_000_000n,
        },
      ],
      hlc: fixedHlc(CLOCK_BASE_MS, NODE_YARD),
      nowIso: tillClock(),
    });

    const pending = await readPendingOps(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.kind).toBe(RECEIPT_OUTBOX_KIND);
    expect(pending[0]!.idempotencyKey).toBe(receiptId);

    // The exact bytes the transport would ship, through the exact parser the
    // procedure runs — the one pulled back out of the live router, not
    // `recordGoodsReceiptInput` imported here.
    const parser = routerInputOf(appRouter.receiving.recordReceipt) as typeof recordGoodsReceiptInput;
    const parsed = parser.safeParse(JSON.parse(pending[0]!.payloadJson));
    if (!parsed.success) {
      throw new Error(
        `the client's payload does not satisfy the API's schema: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
    }
    // And the registered schema for the kind is the same object.
    expect(deviceOpContracts['goods.record_receipt']).toBe(recordGoodsReceiptInput);
  });

  it('emits the kind the server dispatches, under its own wire discriminator', () => {
    expect(WIRE_KINDS[RECEIPT_OUTBOX_KIND]).toBe('goods.record_receipt');
  });
});

// ---------------------------------------------------------------------------
// 2. Recorded in a real partition, drained on reconnect
// ---------------------------------------------------------------------------

describe('a delivery signed for with the radio off', () => {
  it('is complete locally, ABSENT from the server, and lands once on reconnect', async () => {
    const db = await provisionedDevice();
    const { orderId: purchaseOrderId, lineId: purchaseOrderLineId } = await approvedOrder(
      approverUserId,
    );
    const units = await loadPurchaseUnits(db, productId);
    const tonne = units.find((u) => u.uomId === purchaseUomId)!;
    const receiptId = uuidv7();

    // ---- radio OFF -------------------------------------------------------
    const started = Date.now();
    await recordGoodsReceipt(db, {
      goodsReceiptId: receiptId,
      supplierId,
      purchaseOrderId,
      supplierDeliveryNoteRef: 'DN-0091',
      lines: [
        {
          purchaseOrderLineId,
          productId,
          unit: tonne,
          qtyReceived: 10_000n,
          unitCostE4: 45_000_000n,
        },
      ],
      hlc: fixedHlc(CLOCK_BASE_MS, NODE_YARD),
      nowIso: tillClock(1),
    });
    // Nothing awaited a socket: the whole write is a local transaction.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await receiptFor(receiptId)).toHaveLength(0);

    const dead = await drainOutbox(db, partitioned());
    // A dead radio is not a refusal: nothing completes, nothing is lost.
    expect(dead.completed).toBe(0);
    expect(dead.rejected).toBe(0);
    expect(dead.deferred).toBe(1);
    expect(await receiptFor(receiptId)).toHaveLength(0);

    // ---- radio ON --------------------------------------------------------
    const drained = await drainOutbox(db, online());
    expect(drained.transportOk).toBe(true);
    expect(drained.completed).toBe(1);
    expect(await readPendingOps(db)).toHaveLength(0);

    const rows = await receiptFor(receiptId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.purchase_order_id).toBe(purchaseOrderId);
    expect(rows[0]!.supplier_id).toBe(supplierId);
    expect(rows[0]!.location_id).toBe(outlet.id);

    // THE CONVERSION: the client's own figure against the SERVER's own, never
    // against a literal written in this file.
    const lines = await receiptLines(receiptId);
    expect(lines).toHaveLength(1);
    expect(BigInt(lines[0]!.qty_stock_computed)).toBe(toStockQty(10_000n, tonne));
    // Accepted as computed, so nobody signed for a difference.
    expect(lines[0]!.qty_stock).toBe(lines[0]!.qty_stock_computed);
    expect(lines[0]!.conversion_confirmed_by).toBeNull();

    // The receipt APPENDED a movement; it did not set a counter (§2.2).
    const moved = await movements(receiptId);
    expect(moved).toHaveLength(1);
    expect(moved[0]!.source_kind).toBe('RECEIPT');
    expect(BigInt(moved[0]!.qty_delta)).toBe(toStockQty(10_000n, tonne));
  });

  it('replays byte-identically without appending a second movement', async () => {
    const db = await provisionedDevice();
    const { orderId: purchaseOrderId, lineId: purchaseOrderLineId } = await approvedOrder(
      approverUserId,
    );
    const units = await loadPurchaseUnits(db, productId);
    const tonne = units.find((u) => u.uomId === purchaseUomId)!;
    const receiptId = uuidv7();

    await recordGoodsReceipt(db, {
      goodsReceiptId: receiptId,
      supplierId,
      purchaseOrderId,
      lines: [
        { purchaseOrderLineId, productId, unit: tonne, qtyReceived: 1_000n, unitCostE4: 45_000_000n },
      ],
      hlc: fixedHlc(CLOCK_BASE_MS, NODE_YARD),
      nowIso: tillClock(2),
    });

    // THE EXACT BYTES the client queued, captured before the drain. A
    // hand-written replay would be a third thing agreeing with neither side —
    // and would in fact be REFUSED, because the pipeline hashes the request
    // and a key reused with different bytes is an error, not a duplicate.
    const [op] = await readPendingOps(db);
    const replayBody = {
      ops: [
        {
          idempotency_key: op!.idempotencyKey,
          ...(op!.claimedHlc === null ? {} : { claimed_hlc: op!.claimedHlc }),
          client_wall_at: op!.createdAt,
          kind: WIRE_KINDS[op!.kind],
          payload: JSON.parse(op!.payloadJson) as Record<string, unknown>,
        },
      ],
    };

    const first = await drainOutbox(db, online());
    expect(first.completed).toBe(1);
    expect(await movements(receiptId)).toHaveLength(1);

    // The same op again, exactly as a device that never saw the ack would
    // re-send it. The pipeline replays the stored response and the ledger does
    // not move — the double-count CLAUDE.md §2.2 forbids, closed by the
    // pipeline rather than by a counter somebody remembers to check.
    const replay = await app.inject({
      method: 'POST',
      url: '/sync/upload',
      headers: { authorization: `Bearer ${bearer}`, origin: PWA_ORIGIN },
      payload: replayBody,
    });
    const acks = replay.json<{ acks: { status: string; reason?: string }[] }>().acks;
    expect(acks[0]!.reason).toBeUndefined();
    expect(acks[0]!.status).toBe('duplicate');
    expect(await movements(receiptId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. A short delivery, and a count the yard signed for
// ---------------------------------------------------------------------------

describe('short deliveries and signed-for counts are ordinary trade', () => {
  it('accepts a SHORT delivery against the order without complaint', async () => {
    const db = await provisionedDevice();
    const { orderId: purchaseOrderId, lineId: purchaseOrderLineId } = await approvedOrder(
      approverUserId,
    );
    const units = await loadPurchaseUnits(db, productId);
    const tonne = units.find((u) => u.uomId === purchaseUomId)!;
    const receiptId = uuidv7();

    await recordGoodsReceipt(db, {
      goodsReceiptId: receiptId,
      supplierId,
      purchaseOrderId,
      // Nine and a half tonnes against ten ordered.
      lines: [
        { purchaseOrderLineId, productId, unit: tonne, qtyReceived: 9_500n, unitCostE4: 45_000_000n },
      ],
      hlc: fixedHlc(CLOCK_BASE_MS, NODE_YARD),
      nowIso: tillClock(3),
    });
    const report = await drainOutbox(db, online());
    expect(report.completed).toBe(1);
    expect(report.rejected).toBe(0);
    const lines = await receiptLines(receiptId);
    expect(BigInt(lines[0]!.qty_received)).toBe(9_500n);
  });

  it('carries the signature when the yard counted something else, and the server records who', async () => {
    const db = await provisionedDevice();
    const { orderId: purchaseOrderId, lineId: purchaseOrderLineId } = await approvedOrder(
      approverUserId,
    );
    const units = await loadPurchaseUnits(db, productId);
    const tonne = units.find((u) => u.uomId === purchaseUomId)!;
    const computed = toStockQty(10_000n, tonne);
    const receiptId = uuidv7();

    await recordGoodsReceipt(db, {
      goodsReceiptId: receiptId,
      supplierId,
      purchaseOrderId,
      lines: [
        {
          purchaseOrderLineId,
          productId,
          unit: tonne,
          qtyReceived: 10_000n,
          // One bar fewer than the conversion says — inside the unit's own
          // 43bp of slack, so it is signed for and no review is opened.
          qtyStock: computed - 1n,
          unitCostE4: 45_000_000n,
        },
      ],
      hlc: fixedHlc(CLOCK_BASE_MS, NODE_YARD),
      nowIso: tillClock(4),
    });
    const report = await drainOutbox(db, online());
    // Without `confirmConversion` the server answers PRECONDITION_FAILED —
    // which `classifyRejection` classes RETRYABLE, so the op would sit in the
    // queue being retried for ever. The builder setting the flag from the
    // server's OWN conversion expression is what stops that.
    expect(report.rejected).toBe(0);
    expect(report.completed).toBe(1);

    const lines = await receiptLines(receiptId);
    expect(BigInt(lines[0]!.qty_stock)).toBe(computed - 1n);
    expect(BigInt(lines[0]!.qty_stock_computed)).toBe(computed);
    // The server stamped WHO signed for the difference (04 §4.4.4).
    expect(lines[0]!.conversion_confirmed_by).not.toBeNull();
  });
});
