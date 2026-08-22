/**
 * THE SALE PATH, AUTHORISED — every template role against cash and credit,
 * and the BOUND that makes "credit sales up to a set limit" real.
 *
 * This file exists because the bound used to be data nothing read. The
 * permission model has always carried it — the template grants counter staff
 * `sale.record.credit` at `max_order_value_minor: "0"` and an outlet manager
 * the same capability at `"500000"` — but `sales.createSale` was a bare
 * `tenantProcedure`, so any valid tenant bearer could open unbounded credit
 * exposure through the till (docs/phase1-status.md §6 item 1). A bound that
 * nothing enforces is a comment with a primary key.
 *
 * What makes these tests worth anything, in the same terms as
 * `test/rbac.test.ts`:
 *
 *  - REAL POSTGRES (PGlite) with the REAL migrations, as `app_user` with the
 *    tenant GUC set, so RLS genuinely applies to the permission resolution
 *    itself. The grants are rows an onboarding flow would write.
 *  - THE REAL ROUTER. Nothing here calls the guard and asserts on the guard;
 *    every assertion is on what `sales.createSale` did or refused to do.
 *  - EVERY DENY HAS A POSITIVE CONTROL — same route, same location, same
 *    payload, a principal who may. A suite where everything is forbidden
 *    passes just as well when the router is broken or the fixture is empty.
 *  - THE FIXTURE IS SELF-VERIFYING. The quantities that straddle the bound
 *    are asserted against the SERVER's own repriced totals in `beforeAll`, so
 *    a change to the Ghana pack's rates fails loudly here instead of quietly
 *    turning "above the bound" into "below it".
 *  - NOT ONE ASSERTION MENTIONS A ROLE NAME. Roles are identified by template
 *    provenance (`origin_ref`); `app.role.name` is the tenant's word for the
 *    tenant's job and nothing may key off it (CLAUDE.md §2.9).
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PERMISSION_CODES, uuidv7 } from '@erp/db';
import { signDevToken, type VerifiedIdentity } from '../src/auth.js';
import { SALE_PERMISSION, salePermission } from '../src/routers/sales.js';
import { buildServer } from '../src/server.js';
import {
  createCallerFactory,
  requiresPermission,
  router,
  tenantProcedure,
  type Context,
} from '../src/trpc.js';
import { createApiHarness, JWT_SECRET, type ApiHarness } from './util.js';

let h: ApiHarness;
let tenantId: string;

let root: string;
let outletA: string;
let outletB: string;
let regionOfA: string;
let productId: string;
/** A contractor with an ACTIVE credit account — the customer of a CREDIT sale. */
let creditCustomerId: string;

type Caller = ReturnType<ApiHarness['callerFor']>;

interface Principal {
  /** Template provenance ref. NOT a name, and never branched on in src/. */
  ref: string;
  identity: VerifiedIdentity;
  caller: Caller;
}

const principals = new Map<string, Principal>();

function p(ref: string): Principal {
  const found = principals.get(ref);
  if (!found) throw new Error(`no principal ${ref}`);
  return found;
}

/** Every principal's TOKEN can name either outlet; only the grant differs. */
async function makePrincipal(ref: string, scopeLocationId: string): Promise<Principal> {
  const identity = await h.principal(tenantId, {
    roleRef: ref,
    scopeLocationId,
    // Deliberately WIDER than the grant, so a refusal at outlet B is the
    // DATABASE-resolved grant doing it and never assertLocationInScope.
    locs: [root, regionOfA, outletA, outletB],
  });
  const principal: Principal = { ref, identity, caller: h.callerFor(identity) };
  principals.set(ref, principal);
  return principal;
}

const ALL_ROLES = [
  'counter_staff',
  'outlet_manager',
  'regional_manager',
  'head_of_operations',
  'accounts',
] as const;

/** GH₵5,000 in pesewas — the outlet manager's bound in the template. */
const MANAGER_BOUND = 500_000n;
/** GH₵20,000 — the regional manager's. Two tiers prove it is data, not a constant. */
const REGIONAL_BOUND = 2_000_000n;

/**
 * Quantities chosen to straddle the two bounds once the server has priced
 * them. The straddle is ASSERTED below, never assumed.
 */
const QTY_TINY = '1'; // any positive total at all — enough to break a "0" bound
const QTY_UNDER_MANAGER = '70';
const QTY_OVER_MANAGER = '90';
const QTY_OVER_REGIONAL = '400';

/** Server-repriced totals for those quantities, discovered in beforeAll. */
const serverTotal = new Map<string, bigint>();

/**
 * Edit one template role's `max_order_value_minor`, as an administrator
 * would: ordinary tenant-owned data, under the tenant's own RLS context.
 * Roles are found by template PROVENANCE (`origin_ref`), never by name.
 */
async function setBound(roleRef: string, maxOrderValueMinor: string): Promise<void> {
  await h.db.withTenant(tenantId, async (tx) => {
    await tx.query(
      `update app.role_permission rp
          set bound = jsonb_build_object('max_order_value_minor', $2::text)
         from app.role r
        where r.id = rp.role_id and r.origin_ref = $1
          and rp.permission_code = 'sale.record.credit' and rp.deleted_at is null`,
      [`role:${roleRef}`, maxOrderValueMinor],
    );
  });
}

let receiptSeq = 0;
function receiptNo(tag: string): string {
  receiptSeq += 1;
  return `SR-${tag}-${String(receiptSeq).padStart(5, '0')}`;
}

interface SaleOpts {
  qty?: string;
  at?: string;
  clientTotalMinor?: string;
  tag?: string;
}

function cashSale(opts: SaleOpts = {}) {
  return {
    idempotencyKey: uuidv7(),
    locationId: opts.at ?? outletA,
    priceListCode: 'WHOLESALE',
    receiptNo: receiptNo(opts.tag ?? 'CASH'),
    businessDate: '2026-08-21',
    tender: 'CASH' as const,
    lines: [{ productId, qty: opts.qty ?? QTY_TINY }],
    ...(opts.clientTotalMinor === undefined ? {} : { clientTotalMinor: opts.clientTotalMinor }),
  };
}

function creditSale(opts: SaleOpts = {}) {
  return {
    ...cashSale({ ...opts, tag: opts.tag ?? 'CRED' }),
    tender: 'CREDIT' as const,
    customerId: creditCustomerId,
  };
}

beforeAll(async () => {
  h = await createApiHarness();
  tenantId = await h.provisionTenant('sales-rbac');
  await h.applyTemplate(tenantId, true);

  root = await h.locationByCode(tenantId, 'ROOT');
  const outs = await h.outlets(tenantId, 2);
  outletA = outs[0]!.id;
  outletB = outs[1]!.id;
  regionOfA = await h.db.withTenant(tenantId, async (tx) => {
    const res = await tx.query<{ parent_id: string }>(
      `select parent_id from app.location where id = $1`,
      [outletA],
    );
    const parent = res.rows[0]?.parent_id;
    if (!parent) throw new Error('outlet has no parent node');
    return parent;
  });

  productId = (await h.pickProduct(tenantId)).id;
  await h.seedWholesalePrice(tenantId, productId, 55_000_000n); // GH₵55.00/unit

  // Setup runs as an owner: this file is about the SALE path's authorisation,
  // and an authorisation refusal while building the fixture would be noise.
  const setup = h.callerFor(await h.identityFor(tenantId, { locs: [root, outletA, outletB] }));
  const account = await setup.credit.openAccount({
    idempotencyKey: uuidv7(),
    newCustomer: { code: 'SR-CONTRACTOR', name: 'Bound Test Contractor' },
    termsDays: 30,
    feeRateBpPerMonth: 200,
    // Deliberately enormous. The ACCOUNT's credit limit and the OPERATOR's
    // `max_order_value_minor` are different controls answering different
    // questions ("may this customer owe this much?" vs "may this person
    // commit that much of the tenant's capital?"). This one is set out of the
    // way so every refusal below is unambiguously the operator bound.
    creditLimitMinor: '99999999999',
  });
  creditCustomerId = account.customerId;

  // The five template roles, each at the node its job actually sits at.
  await makePrincipal('counter_staff', outletA);
  await makePrincipal('outlet_manager', outletA);
  await makePrincipal('regional_manager', regionOfA);
  await makePrincipal('head_of_operations', root);
  await makePrincipal('accounts', root);

  // ── Discover what the SERVER prices each quantity at, and prove the
  // fixture straddles both bounds. Cash sales, by the owner, through the real
  // router: the same arithmetic the credit path will be measured against.
  for (const qty of [QTY_TINY, QTY_UNDER_MANAGER, QTY_OVER_MANAGER, QTY_OVER_REGIONAL]) {
    const sale = await setup.sales.createSale(cashSale({ qty, tag: 'PROBE' }));
    serverTotal.set(qty, BigInt(sale.totalMinor));
  }
  expect(serverTotal.get(QTY_TINY)!).toBeGreaterThan(0n);
  expect(serverTotal.get(QTY_UNDER_MANAGER)!).toBeLessThanOrEqual(MANAGER_BOUND);
  expect(serverTotal.get(QTY_OVER_MANAGER)!).toBeGreaterThan(MANAGER_BOUND);
  expect(serverTotal.get(QTY_OVER_MANAGER)!).toBeLessThanOrEqual(REGIONAL_BOUND);
  expect(serverTotal.get(QTY_OVER_REGIONAL)!).toBeGreaterThan(REGIONAL_BOUND);
}, 180_000);

afterAll(async () => {
  await h?.close();
});

// ---------------------------------------------------------------------------
// The template's own numbers, read back from the database
// ---------------------------------------------------------------------------

describe('the bound is TEMPLATE DATA, and these tests use the tenant’s own copy', () => {
  it('counter staff hold the credit capability bounded at "0"; the manager at "500000"', async () => {
    const counter = await p('counter_staff').caller.session.permissions();
    const counterCredit = counter.grants.find(
      (g) => g.code === 'sale.record.credit' && g.locationId === outletA,
    );
    // The capability IS held — it exists so a manager can raise it for one
    // person without inventing a role. Bounded at zero, it authorises nothing.
    expect(counterCredit).toBeDefined();
    expect(counterCredit?.bound?.['max_order_value_minor']).toBe('0');

    const manager = await p('outlet_manager').caller.session.permissions();
    const managerCredit = manager.grants.find(
      (g) => g.code === 'sale.record.credit' && g.locationId === outletA,
    );
    expect(managerCredit?.bound?.['max_order_value_minor']).toBe(MANAGER_BOUND.toString(10));
    // A decimal STRING, never a JSON number: a bigint inside jsonb becomes a
    // float64 the instant JSON.parse touches it (ADR-0004).
    expect(typeof managerCredit?.bound?.['max_order_value_minor']).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// The matrix: five template roles × the two tenders
// ---------------------------------------------------------------------------

describe('every template role against a CASH sale [sale.record]', () => {
  // Accounts is the interesting row: it reads the whole tenant and records
  // nothing at the counter. Segregation of duties is the reason it is a
  // separate role at all.
  const allowed = new Set(['counter_staff', 'outlet_manager', 'regional_manager', 'head_of_operations']);

  for (const ref of ALL_ROLES) {
    const may = allowed.has(ref);
    it(`${ref} ${may ? 'MAY' : 'may NOT'} record a cash sale`, async () => {
      const attempt = p(ref).caller.sales.createSale(cashSale({ tag: `M-${ref.slice(0, 4)}` }));
      if (may) await expect(attempt).resolves.toMatchObject({ tender: 'CASH' });
      else await expect(attempt).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  }

  it('the refusal names the CASH capability — an administrator must know which row to grant', async () => {
    await expect(
      p('accounts').caller.sales.createSale(cashSale({ tag: 'M-NAME' })),
    ).rejects.toThrow(/sale\.record\b/);
  });
});

describe('every template role against a CREDIT sale [sale.record.credit]', () => {
  /**
   * Three tiers, and the same payload each time. The only thing that changes
   * is the amount — which is exactly what "credit sales up to a set limit"
   * means and exactly what nothing enforced before.
   */
  const TIERS: { name: string; qty: string; allowed: readonly string[] }[] = [
    {
      name: 'a token amount (any positive total at all)',
      qty: QTY_TINY,
      allowed: ['outlet_manager', 'regional_manager', 'head_of_operations'],
    },
    {
      name: `above GH₵5,000 (${MANAGER_BOUND} minor units)`,
      qty: QTY_OVER_MANAGER,
      allowed: ['regional_manager', 'head_of_operations'],
    },
    {
      name: `above GH₵20,000 (${REGIONAL_BOUND} minor units)`,
      qty: QTY_OVER_REGIONAL,
      allowed: ['head_of_operations'],
    },
  ];

  for (const tier of TIERS) {
    for (const ref of ALL_ROLES) {
      const may = tier.allowed.includes(ref);
      it(`${ref} ${may ? 'MAY' : 'may NOT'} sell on credit — ${tier.name}`, async () => {
        const attempt = p(ref).caller.sales.createSale(
          creditSale({ qty: tier.qty, tag: `T-${ref.slice(0, 4)}` }),
        );
        if (may) {
          await expect(attempt).resolves.toMatchObject({ tender: 'CREDIT' });
        } else {
          await expect(attempt).rejects.toMatchObject({ code: 'FORBIDDEN' });
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// THE BOUND — measured against the SERVER's figure, never the till's
// ---------------------------------------------------------------------------

describe('THE BOUND: "credit sales up to a set limit" (02 §2.4; the brief)', () => {
  it('counter staff are refused a credit sale of ANY amount — their bound is "0"', async () => {
    await expect(
      p('counter_staff').caller.sales.createSale(creditSale({ qty: QTY_TINY, tag: 'B-ZERO' })),
    ).rejects.toThrow(/PERMISSION_BOUND_EXCEEDED/);
  });

  it('…and the SAME payload from an outlet manager is recorded — the positive control', async () => {
    const sale = await p('outlet_manager').caller.sales.createSale(
      creditSale({ qty: QTY_TINY, tag: 'B-OK' }),
    );
    expect(sale.tender).toBe('CREDIT');
    expect(BigInt(sale.totalMinor)).toBe(serverTotal.get(QTY_TINY));
    // A credit sale is a credit charge: the exposure the bound is about.
    expect(sale.credit).toMatchObject({ chargeMinor: sale.totalMinor });
  });

  it('the refusal names the credit capability and the bound, not the cash one', async () => {
    // An administrator reading this message must be sent to the right row.
    // `sale.record` is not what counter staff lack here — they hold it.
    const attempt = p('counter_staff').caller.sales.createSale(
      creditSale({ qty: QTY_TINY, tag: 'B-MSG' }),
    );
    await expect(attempt).rejects.toThrow(/sale\.record\.credit/);
    await expect(attempt).rejects.toThrow(new RegExp(`bounded at 0 `));
  });

  it('an outlet manager is ALLOWED below GH₵5,000 and REFUSED above it', async () => {
    const under = await p('outlet_manager').caller.sales.createSale(
      creditSale({ qty: QTY_UNDER_MANAGER, tag: 'B-UND' }),
    );
    expect(BigInt(under.totalMinor)).toBeLessThanOrEqual(MANAGER_BOUND);

    // Same principal, same location, same customer, same route. Only the
    // amount differs — which is the whole claim this file makes.
    await expect(
      p('outlet_manager').caller.sales.createSale(
        creditSale({ qty: QTY_OVER_MANAGER, tag: 'B-OVR' }),
      ),
    ).rejects.toThrow(/PERMISSION_BOUND_EXCEEDED/);
  });

  it('the bound is measured against the SERVER total, not the till’s claim', async () => {
    // The sharp case. The device asserts a total comfortably inside the
    // manager's bound; the server reprices it to something well outside.
    // If the claim were the measure, a till could authorise any credit sale
    // by lying about what it came to — and the claim is optional, so it could
    // also authorise one by saying nothing.
    const overTotal = serverTotal.get(QTY_OVER_MANAGER)!;
    expect(overTotal).toBeGreaterThan(MANAGER_BOUND);

    const attempt = p('outlet_manager').caller.sales.createSale(
      creditSale({ qty: QTY_OVER_MANAGER, clientTotalMinor: '1', tag: 'B-LIE' }),
    );
    await expect(attempt).rejects.toThrow(/PERMISSION_BOUND_EXCEEDED/);
    // And the refusal quotes the SERVER's figure, so the message cannot be
    // mistaken for a comment on what the till believed.
    await expect(attempt).rejects.toThrow(new RegExp(`this act is ${overTotal.toString(10)}`));
  });

  it('…and in the other direction too: a wild claim does not refuse a sale inside the bound', async () => {
    // The same rule read the other way. A test that only proved "a low claim
    // cannot buy an allow" would still pass if the code simply took the
    // MAXIMUM of the two figures.
    const sale = await p('outlet_manager').caller.sales.createSale(
      creditSale({ qty: QTY_UNDER_MANAGER, clientTotalMinor: '99999999', tag: 'B-WILD' }),
    );
    expect(BigInt(sale.totalMinor)).toBe(serverTotal.get(QTY_UNDER_MANAGER));
    expect(sale.priceCheck).toMatchObject({ clientTotalMinor: '99999999', matches: false });
  });

  it('a refused credit sale leaves NOTHING behind — no sale, no charge, no marker', async () => {
    const input = creditSale({ qty: QTY_OVER_MANAGER, tag: 'B-ROLL' });
    await expect(p('outlet_manager').caller.sales.createSale(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    const left = await h.db.withTenant(tenantId, async (tx) => {
      const sale = await tx.query<{ n: string }>(
        `select count(*)::text as n from app.sale where receipt_no = $1`,
        [input.receiptNo],
      );
      const marker = await tx.query<{ n: string }>(
        `select count(*)::text as n from app.write_log where id = $1`,
        [input.idempotencyKey],
      );
      const entry = await tx.query<{ n: string }>(
        `select count(*)::text as n from app.credit_entry where write_id = $1`,
        [input.idempotencyKey],
      );
      const movement = await tx.query<{ n: string }>(
        `select count(*)::text as n from app.stock_movement where write_id = $1`,
        [input.idempotencyKey],
      );
      return [sale, marker, entry, movement].map((r) => Number(r.rows[0]!.n));
    });
    expect(left).toEqual([0, 0, 0, 0]);

    // Because the key was never consumed, the identical payload succeeds the
    // moment someone with the authority sends it. A refusal is not a
    // dead-letter.
    await expect(
      p('regional_manager').caller.sales.createSale(input),
    ).resolves.toMatchObject({ tender: 'CREDIT' });
  });

  it('a bound is a capability AT A PLACE: the manager’s authority stops at outlet B', async () => {
    // Well inside the bound, and still refused — because the grant was made
    // at outlet A. The token names outlet B perfectly well.
    expect(p('outlet_manager').identity.locationIds).toContain(outletB);
    await expect(
      p('outlet_manager').caller.sales.createSale(
        creditSale({ qty: QTY_TINY, at: outletB, tag: 'B-PLACE' }),
      ),
    ).rejects.toThrow(/PERMISSION_OUT_OF_SCOPE/);

    // The regional manager, granted ONCE at the region node, reaches both.
    await expect(
      p('regional_manager').caller.sales.createSale(
        creditSale({ qty: QTY_TINY, at: outletB, tag: 'B-REG' }),
      ),
    ).resolves.toMatchObject({ tender: 'CREDIT' });
  });

  it('a tenant raising its own bound takes effect on the next request', async () => {
    // Not a deploy and not a platform action: an administrator editing one
    // jsonb value in their own tenant. The counter clerk who could sell no
    // credit at all can now sell a little — with no new role, no re-issued
    // token, and no restart.
    const before = p('counter_staff').caller.sales.createSale(
      creditSale({ qty: QTY_TINY, tag: 'B-RAISE1' }),
    );
    await expect(before).rejects.toThrow(/PERMISSION_BOUND_EXCEEDED/);

    await setBound('counter_staff', MANAGER_BOUND.toString(10));

    await expect(
      p('counter_staff').caller.sales.createSale(creditSale({ qty: QTY_TINY, tag: 'B-RAISE2' })),
    ).resolves.toMatchObject({ tender: 'CREDIT' });

    // Raised, not removed: the bound still bounds.
    await expect(
      p('counter_staff').caller.sales.createSale(
        creditSale({ qty: QTY_OVER_MANAGER, tag: 'B-RAISE3' }),
      ),
    ).rejects.toThrow(/PERMISSION_BOUND_EXCEEDED/);

    // Put it back where the template had it, and prove the LOWERING lands on
    // the next request too. Two things ride on this: an administrator must be
    // able to take authority back as easily as they gave it, and the rest of
    // this file (and the upload suite below) must see the template's own "0"
    // rather than a figure some earlier test left behind.
    await setBound('counter_staff', '0');
    await expect(
      p('counter_staff').caller.sales.createSale(creditSale({ qty: QTY_TINY, tag: 'B-RAISE4' })),
    ).rejects.toThrow(/PERMISSION_BOUND_EXCEEDED/);
  });
});

// ---------------------------------------------------------------------------
// Fail closed on the tender
// ---------------------------------------------------------------------------

describe('an unrecognised tender REFUSES — it never falls through to a default', () => {
  it('the map is total over the contract’s union, and every code is catalogued', () => {
    // If a third tender is ever added to `createSaleInput`, TypeScript fails
    // the build at SALE_PERMISSION rather than letting the new tender inherit
    // the cash capability. This asserts the other half: the codes it names are
    // real ones, not strings that can never match a grant.
    const codes = new Set<string>(PERMISSION_CODES);
    for (const [tender, code] of Object.entries(SALE_PERMISSION)) {
      expect(codes.has(code), `${tender} maps to an uncatalogued code`).toBe(true);
    }
    expect(SALE_PERMISSION.CASH).not.toBe(SALE_PERMISSION.CREDIT);
  });

  it('the derivation returns undefined for anything else — never the weaker code', () => {
    for (const bad of ['GIFT_CARD', 'MOBILE_MONEY', 'cash', 'CREDIT ', '', 'CASH,CREDIT']) {
      expect(salePermission({ tender: bad })).toBeUndefined();
    }
    expect(salePermission({})).toBeUndefined();
    expect(salePermission({ tender: 42 })).toBeUndefined();
    expect(salePermission({ tender: null })).toBeUndefined();
  });

  it('and the middleware turns that undefined into a REFUSAL, for the owner too', async () => {
    // The first line of defence is zod: `tender` is a closed enum, so an
    // unknown one is a BAD_REQUEST before this middleware ever runs (asserted
    // below). That makes the fail-closed branch unreachable through the real
    // router — which is exactly why it is worth proving here, on the SAME
    // composition sales.ts uses, with a payload zod would have rejected. A
    // guard whose failure mode is never exercised is a guard nobody knows the
    // behaviour of.
    const probeRouter = router({
      probe: tenantProcedure
        .input(z.object({ tender: z.string(), locationId: z.string().uuid() }).strict())
        .use(requiresPermission({ code: salePermission, at: 'input' }))
        .mutation(async () => 'allowed' as const),
    });
    const caller = createCallerFactory(probeRouter)({
      deps: h.deps,
      identity: p('head_of_operations').identity,
    } satisfies Context);

    // The owner holds the WHOLE catalogue and is still refused: there is no
    // capability to check, so there is nothing that could authorise it.
    await expect(caller.probe({ tender: 'GIFT_CARD', locationId: outletA })).rejects.toThrow(
      /UNKNOWN_PERMISSION_CODE/,
    );
    await expect(caller.probe({ tender: 'CASH', locationId: outletA })).resolves.toBe('allowed');
  });

  it('through the real router an unknown tender is a BAD_REQUEST, and nothing lands', async () => {
    const input = { ...cashSale({ tag: 'FT' }), tender: 'GIFT_CARD' };
    await expect(
      p('head_of_operations').caller.sales.createSale(input as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const landed = await h.db.withTenant(tenantId, async (tx) => {
      const r = await tx.query<{ n: string }>(
        `select count(*)::text as n from app.sale where receipt_no = $1`,
        [input.receiptNo],
      );
      return Number(r.rows[0]!.n);
    });
    expect(landed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The read paths
// ---------------------------------------------------------------------------

describe('sales.get and sales.recomputeCheck require sale.view, AT THE SALE’S LOCATION', () => {
  let saleAtA: string;
  let saleAtB: string;

  beforeAll(async () => {
    const a = await p('outlet_manager').caller.sales.createSale(cashSale({ tag: 'V-A' }));
    saleAtA = a.saleId;
    const b = await p('head_of_operations').caller.sales.createSale(
      cashSale({ at: outletB, tag: 'V-B' }),
    );
    saleAtB = b.saleId;
  });

  it('a principal holding no grant at all cannot read a sale', async () => {
    // A signed, verified token for a user with no role assignment. The
    // refusal happens before a single row is read.
    const ghost = await h.identityFor(tenantId, { locs: [outletA], grant: 'none' });
    await expect(h.callerFor(ghost).sales.get({ saleId: saleAtA })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      h.callerFor(ghost).sales.recomputeCheck({ saleId: saleAtA }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('every template role holds sale.view — including the one that may not sell', async () => {
    // Accounts records nothing at the counter and reads the whole tenant.
    // That asymmetry is the point of the separate capability: `sale.view` is
    // not a weaker `sale.record`, it is a different question.
    for (const ref of ALL_ROLES) {
      await expect(p(ref).caller.sales.get({ saleId: saleAtA })).resolves.toMatchObject({
        saleId: saleAtA,
      });
    }
    await expect(
      p('accounts').caller.sales.createSale(cashSale({ tag: 'V-NO' })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a counter clerk cannot read another outlet’s takings by guessing a sale id', async () => {
    // The grant was made at outlet A. The token names outlet B, and the sale
    // is in the same tenant, so RLS does not hide it — the location-precise
    // half of the check is the only thing standing here.
    expect(p('counter_staff').identity.locationIds).toContain(outletB);
    await expect(p('counter_staff').caller.sales.get({ saleId: saleAtB })).rejects.toThrow(
      /PERMISSION_OUT_OF_SCOPE/,
    );
    await expect(
      p('counter_staff').caller.sales.recomputeCheck({ saleId: saleAtB }),
    ).rejects.toThrow(/PERMISSION_OUT_OF_SCOPE/);

    // The positive control: the same clerk reads their OWN counter's sale,
    // and the recompute still answers.
    await expect(p('counter_staff').caller.sales.get({ saleId: saleAtA })).resolves.toMatchObject({
      locationId: outletA,
    });
    await expect(
      p('counter_staff').caller.sales.recomputeCheck({ saleId: saleAtA }),
    ).resolves.toMatchObject({ matches: true });
  });

  it('a grant at the REGION node reads both outlets; a root grant reads either', async () => {
    for (const saleId of [saleAtA, saleAtB]) {
      await expect(p('regional_manager').caller.sales.get({ saleId })).resolves.toMatchObject({
        saleId,
      });
      await expect(p('accounts').caller.sales.get({ saleId })).resolves.toMatchObject({ saleId });
    }
  });

  it('removing sale.view from a tenant’s own role stops the next read', async () => {
    const uid = uuidv7();
    await h.grantRole(tenantId, uid, 'counter_staff', outletA);
    const identity = await h.identityFor(tenantId, { uid, locs: [outletA], grant: 'none' });
    const caller = h.callerFor(identity);
    await expect(caller.sales.get({ saleId: saleAtA })).resolves.toBeDefined();

    await h.revokePermissionFromRole(tenantId, 'counter_staff', 'sale.view');
    await expect(caller.sales.get({ saleId: saleAtA })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Surgical: losing the read did not lose the right to sell.
    await expect(
      caller.sales.createSale(cashSale({ tag: 'V-STILL' })),
    ).resolves.toMatchObject({ tender: 'CASH' });
  });
});

// ---------------------------------------------------------------------------
// The same bound, over the real transport
// ---------------------------------------------------------------------------

/**
 * `POST /sync/upload` is how a till actually arrives: an ordered batch of
 * outbox ops, dispatched to the same tRPC mutations, one transaction each.
 * Everything above proves the guard through the router; this proves it
 * through the shore, because that is the surface an offline device meets and
 * the ack is what the device acts on.
 *
 * §6 item 1 names this pairing exactly: counter staff DENIED a credit sale
 * above their "0" bound, the outlet manager ALLOWED one below "500000" and
 * DENIED one above it.
 */
describe('the bound, through POST /sync/upload — the surface a till meets', () => {
  let app: FastifyInstance;
  const bearers = new Map<string, string>();

  beforeAll(async () => {
    app = await buildServer({ deps: h.deps, jwtSecret: JWT_SECRET });
    for (const ref of ['counter_staff', 'outlet_manager'] as const) {
      bearers.set(
        ref,
        // The SAME principal the callers above use — the uid is what carries
        // authority, and it is resolved from the database on every request.
        // `locs` is one location, the way dev-token.mjs mints one: a device
        // scope, deliberately narrower than the grant.
        await signDevToken(JWT_SECRET, {
          tid: tenantId,
          uid: p(ref).identity.userId,
          role: 'opaque-label-nothing-branches-on',
          locs: [outletA],
          dev: uuidv7(),
        }),
      );
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  async function uploadSale(ref: string, qty: string, tag: string) {
    const sale = creditSale({ qty, tag });
    const res = await app.inject({
      method: 'POST',
      url: '/sync/upload',
      headers: { authorization: `Bearer ${bearers.get(ref)!}` },
      payload: {
        ops: [
          {
            idempotency_key: sale.idempotencyKey,
            kind: 'sale.create',
            payload: {
              locationId: sale.locationId,
              priceListCode: sale.priceListCode,
              receiptNo: sale.receiptNo,
              businessDate: sale.businessDate,
              tender: sale.tender,
              customerId: sale.customerId,
              lines: sale.lines,
            },
          },
        ],
      },
    });
    const body = res.json() as { acks: { key: string; status: string; reason?: string }[] };
    return { ack: body.acks[0]!, receiptNo: sale.receiptNo };
  }

  async function landed(receiptNo: string): Promise<number> {
    return h.db.withTenant(tenantId, async (tx) => {
      const r = await tx.query<{ n: string }>(
        `select count(*)::text as n from app.sale where receipt_no = $1`,
        [receiptNo],
      );
      return Number(r.rows[0]!.n);
    });
  }

  it('counter staff: a credit sale of any size is REJECTED, and nothing lands', async () => {
    const { ack, receiptNo } = await uploadSale('counter_staff', QTY_TINY, 'U-CS');
    expect(ack.status).toBe('rejected');
    expect(ack.reason).toMatch(/FORBIDDEN.*PERMISSION_BOUND_EXCEEDED/);
    expect(ack.reason).toMatch(/sale\.record\.credit/);
    expect(await landed(receiptNo)).toBe(0);
    // NOTE FOR THE CLIENT (apps/web, not this package): `classifyRejection()`
    // treats a FORBIDDEN reason as RETRYABLE, so this op would sit in the
    // outbox and be re-sent rather than moving to the visible attention
    // state. That is a client-side decision and it is recorded as a follow-up;
    // the server's answer — refuse, apply nothing, say why — is the right one
    // either way.
  });

  it('outlet manager: BELOW the bound is applied', async () => {
    const { ack, receiptNo } = await uploadSale('outlet_manager', QTY_UNDER_MANAGER, 'U-OK');
    expect(ack.status).toBe('applied');
    expect(await landed(receiptNo)).toBe(1);
  });

  it('outlet manager: ABOVE the bound is rejected, on the identical route and payload shape', async () => {
    const { ack, receiptNo } = await uploadSale('outlet_manager', QTY_OVER_MANAGER, 'U-OVR');
    expect(ack.status).toBe('rejected');
    expect(ack.reason).toMatch(/PERMISSION_BOUND_EXCEEDED/);
    // The message quotes the server's own repriced figure, not the till's.
    expect(ack.reason).toMatch(
      new RegExp(`this act is ${serverTotal.get(QTY_OVER_MANAGER)!.toString(10)}`),
    );
    expect(await landed(receiptNo)).toBe(0);
  });

  it('a CASH sale of the same size from the same principal is applied — it is the tender that is bounded', async () => {
    const sale = cashSale({ qty: QTY_OVER_MANAGER, tag: 'U-CASH' });
    const res = await app.inject({
      method: 'POST',
      url: '/sync/upload',
      headers: { authorization: `Bearer ${bearers.get('outlet_manager')!}` },
      payload: {
        ops: [
          {
            idempotency_key: sale.idempotencyKey,
            kind: 'sale.create',
            payload: {
              locationId: sale.locationId,
              priceListCode: sale.priceListCode,
              receiptNo: sale.receiptNo,
              businessDate: sale.businessDate,
              tender: sale.tender,
              lines: sale.lines,
            },
          },
        ],
      },
    });
    const body = res.json() as { acks: { status: string; reason?: string }[] };
    expect(body.acks[0]!.status).toBe('applied');
    expect(await landed(sale.receiptNo)).toBe(1);
  });
});
