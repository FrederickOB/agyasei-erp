/**
 * THE AUDIT, AS A TEST — the whole device write surface, not just sales.
 *
 * Two bugs of this class have now reached the running app, so the question
 * this file answers is not "is the sale payload fixed" but "which OTHER
 * client→server payload has never been checked against the server that
 * receives it". The answer, on the day this was written:
 *
 *   POST /sync/upload   sale.create             ← the bug. Now covered by
 *                                                 sale-client-to-api.test.ts
 *                                                 and drill D6.
 *                       stock.record_movement   ← NO PWA builder exists. The
 *                       credit.open_account        schemas were private to
 *                       credit.record_entry        apps/api until this change;
 *                                                 only the drills' own
 *                                                 hand-written JSON had ever
 *                                                 exercised them.
 *   GET  /sync/token    the response             ← hand-built server-side,
 *                                                 hand-parsed client-side, no
 *                                                 shared declaration. Covered
 *                                                 in sale-client-to-api.test.ts.
 *
 * So the tests below do three things. They pin the CLIENT's write surface, so
 * the PWA cannot grow a second uploadable kind without this file going red and
 * saying "write a conformance test for it". They prove every kind in the
 * shared registry is really dispatched by the server and really validated with
 * the registered schema. And they run one contract-shaped payload per kind
 * through the live route, so the three ops with no client yet are at least
 * known to work against the shape a client would have to build.
 *
 * What this file does NOT claim: that a PWA builder for those three ops would
 * be correct. There is no such builder to test. When one is written, its own
 * conformance test goes in `sale-client-to-api.test.ts`'s shape — the real
 * builder, the real parser — and the pin below is what forces the question.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEVICE_OP_KINDS,
  MAX_UPLOAD_BATCH,
  deviceOpContracts,
  uploadBodySchema,
  type DeviceOpKind,
  type UploadAck,
} from '@erp/contracts';

import { signDevToken } from '../../../apps/api/src/auth.js';
import { buildServer } from '../../../apps/api/src/server.js';
import { createApiHarness, JWT_SECRET, type ApiHarness } from '../../../apps/api/test/util.js';
import { WIRE_KINDS } from '../../../apps/web/src/data/sync/transport';

type Server = Awaited<ReturnType<typeof buildServer>>;

let h: ApiHarness;
let app: Server;
let tenantId: string;
let outlet: { id: string; code: string };
let productId: string;
let bearer: string;
/**
 * A reason code READ from the tenant's own `movement_reason` rows, never
 * spelled out here. Reason codes are tenant vocabulary (CLAUDE.md §2.9); a
 * test that hard-codes one is testing tenant #1's template, not the platform.
 */
let reasonCode: string;
let keySeq = 0;

/** A fresh UUIDv7-shaped idempotency key per op. */
function nextKey(): string {
  keySeq += 1;
  return `018f3a1e-0000-7000-8000-${String(keySeq).padStart(12, '0')}`;
}

async function upload(ops: unknown[]): Promise<{ status: number; acks: UploadAck[] }> {
  const res = await app.inject({
    method: 'POST',
    url: '/sync/upload',
    headers: { authorization: `Bearer ${bearer}`, origin: 'http://localhost:5173' },
    payload: { ops },
  });
  const body = res.statusCode === 200 ? res.json<{ acks: UploadAck[] }>() : { acks: [] };
  return { status: res.statusCode, acks: body.acks };
}

beforeAll(async () => {
  h = await createApiHarness();
  tenantId = await h.provisionTenant('surface-co');
  await h.applyTemplate(tenantId, true);
  outlet = await h.firstOutlet(tenantId);
  const picked = await h.pickProduct(tenantId);
  productId = picked.id;
  await h.seedWholesalePrice(tenantId, productId, 25_000_000n);
  reasonCode = await h.db.withTenant(tenantId, async (tx) => {
    const res = await tx.query<{ code: string }>(
      `select code from app.movement_reason where deleted_at is null order by code limit 1`,
    );
    const code = res.rows[0]?.code;
    if (code === undefined) throw new Error('the tenant has no movement reasons');
    return code;
  });
  // The uploader is a PROVISIONED principal, not merely a signed token.
  // Permissions are resolved server-side from app.user_role_assignment on
  // every write (apps/api/src/permissions.ts), so a bearer alone authorises
  // nothing — this file is about payload shape, so it grants the breadth and
  // lets apps/api/test/rbac.test.ts be the file about who may do what.
  const uploaderUid = '018f3a1e-0000-7000-8000-0000000000bb';
  await h.grantOwner(tenantId, uploaderUid);
  bearer = await signDevToken(JWT_SECRET, {
    tid: tenantId,
    uid: uploaderUid,
    role: 'outlet-manager',
    locs: [outlet.id],
  });
  app = await buildServer({
    deps: h.deps,
    jwtSecret: JWT_SECRET,
    sync: { powersyncUrl: 'http://localhost:8080' },
    corsOrigins: ['http://localhost:5173'],
  });
});

afterAll(async () => {
  await app?.close();
  await h?.close();
});

// ---------------------------------------------------------------------------
// The client's write surface, pinned
// ---------------------------------------------------------------------------

/**
 * Kinds the PWA can emit that have an end-to-end conformance test proving the
 * CLIENT's real builder satisfies the SERVER's real parser. Adding a kind to
 * the PWA without adding it here is a failing test, on purpose.
 */
const COVERED_BY_A_REAL_CLIENT_TEST: ReadonlySet<string> = new Set<DeviceOpKind>([
  'sale.create',
  // sequence-client-to-api.test.ts — the PWA's own buildBlockReport →
  // enqueueBlockReport → drainOutbox → httpUploadTransport against the API's
  // own router and pipeline, including the wipe.
  'sequence.sync_block',
  // stock-client-to-api.test.ts — the PWA's own recordAdjustment →
  // buildMovementPayload → outbox → drainOutbox → httpUploadTransport against
  // the API's own router and pipeline, recorded under a REAL partition and
  // drained on reconnect. This entry was added only after that file existed:
  // the pin below went red the moment `WIRE_KINDS` grew the kind, which is
  // the tripwire working exactly as designed.
  'stock.record_movement',
  // receipt-client-to-api.test.ts — the PWA's own recordGoodsReceipt →
  // outbox → drainOutbox → httpUploadTransport against the API's own
  // receiving router and pipeline, recorded under a REAL partition, drained
  // on reconnect, and replayed BYTE-IDENTICALLY to prove no second stock
  // movement is appended. Added only after that file existed: the pin below
  // went red the moment `WIRE_KINDS` grew the kind.
  'goods.record_receipt',
  // delivery-client-to-api.test.ts — the PWA's own recordDeliveryStatus
  // through the same path, plus the check that closes the one duplicated
  // table in Phase 2: the contract's DELIVERY_TRANSITIONS against
  // app.delivery_legal_transitions() read out of a real Postgres.
  'logistics.update_delivery_status',
  // credit-client-to-api.test.ts — the PWA's own `recordRepayment`, recorded
  // under a REAL partition, drained on reconnect, and asserted against
  // Σ(credit_entry) read straight out of Postgres. It also proves the OTHER
  // half of the credit decision: `credit.open_account` is in DEVICE_OP_KINDS
  // and the client deliberately does NOT queue it, because opening an account
  // sets a credit LIMIT and 06 §6.6.3(7) rules that severity-1 credit
  // resolutions require connectivity.
  'credit.record_entry',
  // till-client-to-api.test.ts — the PWA's own openTill → checkout (split
  // tender) → closeTill, queued under a REAL partition and drained in order on
  // reconnect against the API's own cashSession and sales routers, then
  // replayed byte-identically. The till is TRADE: an outlet opens at seven
  // whether or not the tower is up, and every sale names the till it was rung
  // into, so the open must ride the same ordered queue ahead of those sales.
  'cash_session.open',
  'cash_session.close',
]);

describe("the PWA's uploadable write surface", () => {
  it('is exactly what has a conformance test — a new kind fails here until it does', () => {
    // `apps/web` writes the outbox in exactly one place today
    // (`data/mutations/checkout.ts`), and `WIRE_KINDS` is the map from an
    // outbox row's local kind to the wire discriminator. It is the client's
    // whole write vocabulary.
    const emitted = new Set(Object.values(WIRE_KINDS));
    for (const kind of emitted) {
      expect(
        COVERED_BY_A_REAL_CLIENT_TEST.has(kind),
        `apps/web can upload '${kind}' but no test drives the client's own builder ` +
          `against the API's own parser for it. Add one (see sale-client-to-api.test.ts) ` +
          `before adding the kind here.`,
      ).toBe(true);
    }
    // And the pin itself: today the counter records sales, adjusts stock and
    // reports its receipt-number cursor on reconnect; the yard signs for
    // goods; whoever hears from the driver moves a delivery along; and the
    // credit desk takes a customer's repayment. Nothing else.
    //
    // `credit.record_entry` is here because a repayment is TRADE — the money
    // is in the drawer whether or not the tower is up, and exposure is Σ over
    // an append-only log of signed integers, so two offline batches commute
    // and there is no conflict case (06 §6.2). The client's builder narrows it
    // to PAYMENT: ADJUSTMENT and WRITE_OFF are accounting judgements, and an
    // ordered upload queue on a tablet is not where a write-off is authorised.
    //
    // `credit.open_account` is deliberately ABSENT even though the server
    // accepts it on this path, and `data/api/credit.ts` carries the reason:
    // opening an account SETS A CREDIT LIMIT, and whatever forbids an offline
    // limit edit forbids an offline limit at birth. So are raising, approving
    // and BOOKING, which are commitments made against terms and bounds a
    // partitioned device may hold a stale copy of
    // (packages/contracts/src/procurement.ts, data/api/procurement.ts).
    expect([...emitted].sort()).toEqual([
      'cash_session.close',
      'cash_session.open',
      'credit.record_entry',
      'goods.record_receipt',
      'logistics.update_delivery_status',
      'sale.create',
      'sequence.sync_block',
      'stock.record_movement',
    ]);
  });

  it('emits only kinds the shared contract knows about', () => {
    for (const kind of Object.values(WIRE_KINDS)) {
      expect(DEVICE_OP_KINDS).toContain(kind);
    }
  });
});

// ---------------------------------------------------------------------------
// The registry is complete, and the server really uses it
// ---------------------------------------------------------------------------

describe('every uploadable kind is declared once and dispatched', () => {
  it('the registry covers the vocabulary exactly', () => {
    expect(Object.keys(deviceOpContracts).sort()).toEqual([...DEVICE_OP_KINDS].sort());
  });

  it('every kind is routed by the server — an empty payload is VALIDATED, not unknown', async () => {
    for (const kind of DEVICE_OP_KINDS) {
      const { acks } = await upload([{ idempotency_key: nextKey(), kind, payload: {} }]);
      expect(acks[0]!.status).toBe('rejected');
      // The distinction that matters: BAD_REQUEST means the op reached its
      // mutation and failed the contract; UNKNOWN_KIND means the server has
      // no handler and the vocabularies have drifted.
      expect(acks[0]!.reason, `${kind} is not dispatched by the server`).toMatch(/^BAD_REQUEST/);
    }
  });

  it('an unrecognised kind is UNKNOWN_KIND, per-op, without failing the batch', async () => {
    const good = nextKey();
    const bad = nextKey();
    const { acks } = await upload([
      { idempotency_key: bad, kind: 'sale.invent', payload: {} },
      {
        idempotency_key: good,
        kind: 'stock.record_movement',
        payload: {
          locationId: outlet.id,
          productId,
          qtyDelta: '10',
          sourceKind: 'OPENING',
          reasonCode,
          businessDate: '2026-08-21',
        },
      },
    ]);
    expect(acks.find((a) => a.key === bad)!.reason).toMatch(/^UNKNOWN_KIND/);
    // The queue keeps moving: one poison op must not take the batch with it.
    expect(acks.find((a) => a.key === good)!.status).toBe('applied');
  });
});

// ---------------------------------------------------------------------------
// One contract-shaped payload per kind, through the live route
// ---------------------------------------------------------------------------

describe('a payload built to the registered contract is accepted for every kind', () => {
  it('stock.record_movement', async () => {
    const key = nextKey();
    const payload = {
      locationId: outlet.id,
      productId,
      // Signed scaled integer in the STOCKING unit, as a decimal string.
      qtyDelta: '250',
      sourceKind: 'RECEIPT',
      reasonCode,
      businessDate: '2026-08-21',
    };
    // The registered schema is the same object the router parses with, so
    // this parse and the server's are the same check run twice.
    expect(deviceOpContracts['stock.record_movement'].safeParse({
      ...payload,
      idempotencyKey: key,
    }).success).toBe(true);

    const { acks } = await upload([{ idempotency_key: key, kind: 'stock.record_movement', payload }]);
    expect(acks[0]!.reason).toBeUndefined();
    expect(acks[0]!.status).toBe('applied');
  });

  it('credit.open_account then credit.record_entry', async () => {
    const openKey = nextKey();
    const openPayload = {
      newCustomer: { code: `SURFACE-${openKey.slice(-4)}`, name: 'Surface Contractor' },
      termsDays: 30,
      feeRateBpPerMonth: 200,
      creditLimitMinor: '1000000',
    };
    expect(
      deviceOpContracts['credit.open_account'].safeParse({ ...openPayload, idempotencyKey: openKey })
        .success,
    ).toBe(true);
    const opened = await upload([
      { idempotency_key: openKey, kind: 'credit.open_account', payload: openPayload },
    ]);
    expect(opened.acks[0]!.reason).toBeUndefined();
    expect(opened.acks[0]!.status).toBe('applied');

    const accountId = await h.db.asAdmin(async (tx) => {
      const res = await tx.query<{ id: string }>(
        `select id from app.customer_account where tenant_id = $1 and write_id = $2`,
        [tenantId, openKey],
      );
      return res.rows[0]?.id;
    });
    expect(accountId).toBeDefined();

    const entryKey = nextKey();
    const entryPayload = {
      accountId,
      kind: 'CHARGE',
      // SIGNED minor units as a decimal string, positive for a charge.
      amountMinor: '25000',
      businessDate: '2026-08-21',
    };
    expect(
      deviceOpContracts['credit.record_entry'].safeParse({ ...entryPayload, idempotencyKey: entryKey })
        .success,
    ).toBe(true);
    const entry = await upload([
      { idempotency_key: entryKey, kind: 'credit.record_entry', payload: entryPayload },
    ]);
    expect(entry.acks[0]!.reason).toBeUndefined();
    expect(entry.acks[0]!.status).toBe('applied');
  });
});

// ---------------------------------------------------------------------------
// The envelope: one constant, both sides
// ---------------------------------------------------------------------------

describe('the batch cap is one number, and the server enforces it', () => {
  it('the client-side envelope schema and the server agree on the limit', async () => {
    const op = (i: number) => ({
      idempotency_key: `018f3a1e-0000-7000-8000-${String(900000 + i).padStart(12, '0')}`,
      kind: 'sale.create',
      payload: {},
    });
    const overCap = Array.from({ length: MAX_UPLOAD_BATCH + 1 }, (_, i) => op(i));

    // The PWA refuses it locally, before a round trip…
    expect(uploadBodySchema.safeParse({ ops: overCap }).success).toBe(false);
    // …and the server refuses it too, applying nothing. Neither side is
    // relying on the other to hold the line.
    const res = await upload(overCap);
    expect(res.status).toBe(400);
  });
});
