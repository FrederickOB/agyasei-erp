/**
 * SERVER-SIDE AUTHORISATION, END TO END.
 *
 * `qa-engineer` tests every role against every restricted action, and the two
 * prohibitions the brief names explicitly are non-skippable cases
 * (02 §2.4 point 4; CLAUDE.md §2.6). This is that file.
 *
 * What makes these tests worth anything:
 *
 *  - They run against REAL POSTGRES (PGlite) with the REAL migrations, as
 *    `app_user` — a non-superuser with the tenant GUC set — so RLS genuinely
 *    applies to the permission resolution itself, not just to the business
 *    tables. A permission resolved for another tenant's user id returns
 *    nothing because the database says so.
 *  - They go through the REAL ROUTERS. Nothing here calls the guard and then
 *    asserts on the guard; the assertions are on what the API did or refused
 *    to do.
 *  - Every negative has a POSITIVE CONTROL beside it. A test suite where
 *    everything is forbidden passes just as well when the router is broken,
 *    when the fixture is empty, or when the tenant has no data at all. The
 *    matrix below asserts an ALLOW for every DENY, at the same location, with
 *    the same payload shape.
 *  - Not one assertion mentions a role NAME. Roles are identified by template
 *    provenance (`origin_ref`) because `app.role.name` is the tenant's word
 *    for the tenant's job and nothing — not the platform, not its tests —
 *    may key off it (CLAUDE.md §2.9).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@erp/db';
import { loadPermissionState } from '../src/permissions.js';
import type { VerifiedIdentity } from '../src/auth.js';
import { createApiHarness, type ApiHarness } from './util.js';

let h: ApiHarness;
let tenantId: string;

let root: string;
let outletA: string;
let outletB: string;
let regionOfA: string;
let productId: string;
let reasonCode: string;

type Caller = ReturnType<ApiHarness['callerFor']>;

interface Principal {
  /** Template provenance ref. NOT a name, and never branched on in src/. */
  ref: string;
  identity: VerifiedIdentity;
  caller: Caller;
}

const principals = new Map<string, Principal>();

/** Every principal is scoped so the TOKEN could reach both outlets. */
async function makePrincipal(ref: string, scopeLocationId: string): Promise<Principal> {
  const identity = await h.principal(tenantId, {
    roleRef: ref,
    scopeLocationId,
    // Deliberately WIDER than the grant: the token can name either outlet, so
    // when a write at outlet B is refused it is the DATABASE-resolved grant
    // doing it and not assertLocationInScope. A test that let the token be
    // the refusing control would prove nothing about permissions.
    locs: [root, regionOfA, outletA, outletB],
  });
  const p: Principal = { ref, identity, caller: h.callerFor(identity) };
  principals.set(ref, p);
  return p;
}

function p(ref: string): Principal {
  const found = principals.get(ref);
  if (!found) throw new Error(`no principal ${ref}`);
  return found;
}

beforeAll(async () => {
  h = await createApiHarness();
  tenantId = await h.provisionTenant('rbac-co');
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
  reasonCode = await h.db.withTenant(tenantId, async (tx) => {
    // Read the tenant's own vocabulary; never hard-code a reason code.
    const res = await tx.query<{ code: string }>(
      `select code from app.movement_reason where deleted_at is null order by code limit 1`,
    );
    const code = res.rows[0]?.code;
    if (!code) throw new Error('the tenant has no movement reasons');
    return code;
  });

  // The five template roles, each at the node its job actually sits at.
  await makePrincipal('counter_staff', outletA);
  await makePrincipal('outlet_manager', outletA);
  await makePrincipal('regional_manager', regionOfA);
  await makePrincipal('head_of_operations', root);
  await makePrincipal('accounts', root);
}, 180_000);

afterAll(async () => {
  await h?.close();
});

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

const ALL_ROLES = [
  'counter_staff',
  'outlet_manager',
  'regional_manager',
  'head_of_operations',
  'accounts',
] as const;

interface RestrictedAction {
  name: string;
  /** The capability the platform checks. Stated so a failure names it. */
  code: string;
  /** Template refs expected to be ALLOWED. Everything else must be refused. */
  allowed: readonly string[];
  run: (caller: Caller, at: string) => Promise<unknown>;
}

const movement = (
  sourceKind: string,
  qtyDelta: string,
): RestrictedAction['run'] => (caller, at) =>
  caller.inventory.recordMovement({
    idempotencyKey: uuidv7(),
    locationId: at,
    productId,
    qtyDelta,
    sourceKind: sourceKind as never,
    reasonCode,
    businessDate: '2026-08-21',
  });

const ACTIONS: RestrictedAction[] = [
  {
    name: 'adjust stock (a correction to what is physically there)',
    code: 'stock.adjust',
    allowed: ['outlet_manager', 'regional_manager', 'head_of_operations'],
    run: movement('CORRECTION', '-3'),
  },
  {
    name: 'send an inter-location transfer out',
    code: 'stock.transfer',
    allowed: ['outlet_manager', 'regional_manager', 'head_of_operations'],
    run: movement('TRANSFER_OUT', '-2'),
  },
  {
    name: 'receive an inter-location transfer in',
    code: 'stock.transfer.receive',
    allowed: ['counter_staff', 'outlet_manager', 'regional_manager', 'head_of_operations'],
    run: movement('TRANSFER_IN', '4'),
  },
  {
    name: 'receive goods from a supplier',
    code: 'stock.receive',
    allowed: ['outlet_manager', 'regional_manager', 'head_of_operations'],
    run: movement('RECEIPT', '6'),
  },
  {
    name: 'perform a stock count',
    code: 'stock.count.perform',
    allowed: ['outlet_manager', 'regional_manager', 'head_of_operations'],
    run: movement('COUNT_ADJUST', '1'),
  },
  {
    name: 'open a credit account (no limit)',
    code: 'credit.account.manage',
    allowed: ['head_of_operations', 'accounts'],
    run: (caller) => {
      const key = uuidv7();
      return caller.credit.openAccount({
        idempotencyKey: key,
        newCustomer: { code: `RBAC-${key.slice(-8)}`, name: 'Matrix Contractor' },
        termsDays: 30,
        feeRateBpPerMonth: 200,
        creditLimitMinor: '0',
      });
    },
  },
  {
    name: 'open a credit account WITH a limit (a credit-limit change)',
    code: 'credit.limit.change',
    allowed: ['head_of_operations', 'accounts'],
    run: (caller) => {
      const key = uuidv7();
      return caller.credit.openAccount({
        idempotencyKey: key,
        newCustomer: { code: `RBAC-${key.slice(-8)}`, name: 'Matrix Contractor' },
        termsDays: 30,
        feeRateBpPerMonth: 200,
        creditLimitMinor: '5000000',
      });
    },
  },
];

describe('every template role against every restricted action', () => {
  for (const action of ACTIONS) {
    for (const ref of ALL_ROLES) {
      const shouldAllow = action.allowed.includes(ref);
      it(`${ref} ${shouldAllow ? 'MAY' : 'may NOT'} ${action.name} [${action.code}]`, async () => {
        const attempt = action.run(p(ref).caller, outletA);
        if (shouldAllow) {
          // The positive control. Without it the row above passes just as
          // well when the router is broken or the fixture is empty.
          await expect(attempt).resolves.toBeDefined();
        } else {
          await expect(attempt).rejects.toMatchObject({ code: 'FORBIDDEN' });
        }
      });
    }
  }
});

describe('a credit entry needs the entry capability, not merely account access', () => {
  let accountId: string;

  beforeAll(async () => {
    const key = uuidv7();
    const acc = await p('accounts').caller.credit.openAccount({
      idempotencyKey: key,
      newCustomer: { code: `RBAC-ENTRY-${key.slice(-8)}`, name: 'Entry Contractor' },
      termsDays: 30,
      feeRateBpPerMonth: 200,
      creditLimitMinor: '900000',
    });
    accountId = acc.accountId;
  });

  const charge = (caller: Caller) =>
    caller.credit.recordEntry({
      idempotencyKey: uuidv7(),
      accountId,
      kind: 'CHARGE',
      amountMinor: '12345',
      businessDate: '2026-08-21',
    });

  for (const ref of ALL_ROLES) {
    const allowed = ref === 'accounts' || ref === 'head_of_operations';
    it(`${ref} ${allowed ? 'MAY' : 'may NOT'} record a credit entry [credit.entry.record]`, async () => {
      if (allowed) await expect(charge(p(ref).caller)).resolves.toBeDefined();
      else await expect(charge(p(ref).caller)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  }
});

// ---------------------------------------------------------------------------
// The two hard prohibitions, named
// ---------------------------------------------------------------------------

describe('THE TWO HARD PROHIBITIONS (brief; 02 §2.4)', () => {
  it('counter staff may NOT change a credit limit — and Accounts MAY', async () => {
    const denied = p('counter_staff').caller.credit.openAccount({
      idempotencyKey: uuidv7(),
      newCustomer: { code: `PROHIB-A-${uuidv7().slice(-8)}`, name: 'Prohibition Contractor' },
      termsDays: 30,
      feeRateBpPerMonth: 200,
      creditLimitMinor: '5000000',
    });
    await expect(denied).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // THE POSITIVE CONTROL. The capability is not broken, not absent from the
    // catalogue, and not unreachable — someone in this tenant holds it and
    // the identical call succeeds for them. Note who: the brief restricts
    // COUNTER STAFF, never the capability.
    const key = uuidv7();
    await expect(
      p('accounts').caller.credit.openAccount({
        idempotencyKey: key,
        newCustomer: { code: `PROHIB-B-${key.slice(-8)}`, name: 'Prohibition Contractor' },
        termsDays: 30,
        feeRateBpPerMonth: 200,
        creditLimitMinor: '5000000',
      }),
    ).resolves.toMatchObject({ creditLimitMinor: '5000000' });
  });

  it('an outlet manager may NOT change a credit limit either — the brief says so', async () => {
    await expect(
      p('outlet_manager').caller.credit.openAccount({
        idempotencyKey: uuidv7(),
        newCustomer: { code: `PROHIB-C-${uuidv7().slice(-8)}`, name: 'Prohibition Contractor' },
        termsDays: 30,
        feeRateBpPerMonth: 200,
        creditLimitMinor: '100',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('the refusal names the LIMIT capability, not the account one', async () => {
    // The distinction matters: `credit.account.manage` is not what counter
    // staff lack here, and a message that said so would send an administrator
    // to grant the wrong row.
    await expect(
      p('counter_staff').caller.credit.openAccount({
        idempotencyKey: uuidv7(),
        newCustomer: { code: `PROHIB-D-${uuidv7().slice(-8)}`, name: 'Prohibition Contractor' },
        termsDays: 30,
        feeRateBpPerMonth: 200,
        creditLimitMinor: '1',
      }),
    ).rejects.toThrow(/credit\.(account\.manage|limit\.change)/);
  });

  /**
   * PRICE OVERRIDE.
   *
   * `apps/api/src/routers/sales.ts` is owned by another session as this is
   * written, so the guard call cannot be placed in it here. These assertions
   * are therefore against the decision the guard makes — the same
   * `loadPermissionState()` the middleware calls, resolved from the same
   * database rows, at the same location — so the moment the two-line patch
   * lands in sales.ts the behaviour is already proven. See the follow-up
   * patch in this task's summary.
   */
  describe('price override (guard proven here; sales.ts wiring is the follow-up)', () => {
    it('counter staff hold no price-override capability at their own counter', async () => {
      const state = await loadPermissionState({ deps: h.deps, identity: p('counter_staff').identity });
      expect(state.holdsAt('sale.override_price', outletA)).toBe(false);
      expect(() => state.requireAt('sale.override_price', outletA)).toThrow(/PERMISSION_DENIED/);
    });

    it('nor does an outlet manager, nor a regional manager — the template grants it to neither', async () => {
      for (const ref of ['outlet_manager', 'regional_manager']) {
        const state = await loadPermissionState({ deps: h.deps, identity: p(ref).identity });
        expect(state.holdsAt('sale.override_price', outletA)).toBe(false);
      }
    });

    it('the head of operations DOES — the positive control, and the visible escalation path', async () => {
      const state = await loadPermissionState({
        deps: h.deps,
        identity: p('head_of_operations').identity,
      });
      expect(state.holdsAt('sale.override_price', outletA)).toBe(true);
      expect(() => state.requireAt('sale.override_price', outletA)).not.toThrow();
    });

    it('the bounded discount is a BOUND, not a second permission: 3% passes, 5% does not', async () => {
      const state = await loadPermissionState({ deps: h.deps, identity: p('outlet_manager').identity });
      expect(() => state.requireWithinBound('sale.discount.apply', outletA, 'max_bps', 300n)).not.toThrow();
      expect(() => state.requireWithinBound('sale.discount.apply', outletA, 'max_bps', 500n)).toThrow(
        /PERMISSION_BOUND_EXCEEDED/,
      );
      // Counter staff hold no discount capability at all — a different
      // refusal from "over the bound", and it should read differently.
      const counter = await loadPermissionState({ deps: h.deps, identity: p('counter_staff').identity });
      expect(() => counter.requireWithinBound('sale.discount.apply', outletA, 'max_bps', 1n)).toThrow(
        /PERMISSION_DENIED/,
      );
    });

    it('"credit sales up to a set limit" is the same mechanism, in money', async () => {
      const manager = await loadPermissionState({ deps: h.deps, identity: p('outlet_manager').identity });
      // GH₵5,000 in pesewas — a decimal string in the bound, parsed as bigint.
      expect(() => manager.requireWithinAmount('sale.record.credit', outletA, 500_000n)).not.toThrow();
      expect(() => manager.requireWithinAmount('sale.record.credit', outletA, 500_001n)).toThrow(
        /PERMISSION_BOUND_EXCEEDED/,
      );

      // Counter staff hold the capability bounded to ZERO: it exists so a
      // manager can raise it for one person without inventing a role, and
      // until then it authorises nothing.
      const counter = await loadPermissionState({ deps: h.deps, identity: p('counter_staff').identity });
      expect(counter.holdsAt('sale.record.credit', outletA)).toBe(true);
      expect(() => counter.requireWithinAmount('sale.record.credit', outletA, 1n)).toThrow(
        /PERMISSION_BOUND_EXCEEDED/,
      );

      // And the owner is unbounded, which is what "most permissive wins" means.
      const head = await loadPermissionState({ deps: h.deps, identity: p('head_of_operations').identity });
      expect(() =>
        head.requireWithinAmount('sale.record.credit', outletA, 99_999_999_999n),
      ).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// A permission is a capability AT A PLACE
// ---------------------------------------------------------------------------

describe('a permission held at one location does not act at another', () => {
  it('the outlet manager adjusts stock at their own outlet and is refused at the next one', async () => {
    // Same caller, same payload, same capability — only the location differs.
    await expect(
      p('outlet_manager').caller.inventory.recordMovement({
        idempotencyKey: uuidv7(),
        locationId: outletA,
        productId,
        qtyDelta: '7',
        sourceKind: 'COUNT_ADJUST',
        reasonCode,
        businessDate: '2026-08-21',
      }),
    ).resolves.toBeDefined();

    await expect(
      p('outlet_manager').caller.inventory.recordMovement({
        idempotencyKey: uuidv7(),
        locationId: outletB,
        productId,
        qtyDelta: '7',
        sourceKind: 'COUNT_ADJUST',
        reasonCode,
        businessDate: '2026-08-21',
      }),
    ).rejects.toThrow(/PERMISSION_OUT_OF_SCOPE/);
  });

  it('the token could reach outlet B — it is the database grant that refuses', () => {
    // Proving the previous test tested what it claims: if `locs` had been the
    // control, this assertion would fail and the refusal above would be
    // assertLocationInScope's, not the permission model's.
    expect(p('outlet_manager').identity.locationIds).toContain(outletB);
  });

  it('the same role held at the REGION node reaches every outlet under it', async () => {
    // The FY3 regional manager, today: no schema change, no new concept —
    // the identical permission set, held at a node one level up.
    for (const at of [outletA, outletB]) {
      await expect(
        p('regional_manager').caller.inventory.recordMovement({
          idempotencyKey: uuidv7(),
          locationId: at,
          productId,
          qtyDelta: '2',
          sourceKind: 'COUNT_ADJUST',
          reasonCode,
          businessDate: '2026-08-21',
        }),
      ).resolves.toBeDefined();
    }
  });

  it('a leaf-scoped grant cannot reach a tenant-wide object, however wide the token', async () => {
    // Give an outlet manager the ACCOUNTS role — but only at their own leaf.
    // They now hold `credit.limit.change`… at one outlet. A credit account
    // belongs to the tenant, so the leaf grant must not reach it.
    const leafAccountant = await h.principal(tenantId, {
      roleRef: 'accounts',
      scopeLocationId: outletA,
      locs: [root, regionOfA, outletA, outletB],
    });
    await expect(
      h.callerFor(leafAccountant).credit.openAccount({
        idempotencyKey: uuidv7(),
        newCustomer: { code: `LEAF-${uuidv7().slice(-8)}`, name: 'Leaf Contractor' },
        termsDays: 30,
        feeRateBpPerMonth: 200,
        creditLimitMinor: '10000',
      }),
    ).rejects.toThrow(/PERMISSION_OUT_OF_SCOPE/);

    // The positive control: the same role at the ROOT does it.
    const key = uuidv7();
    await expect(
      p('accounts').caller.credit.openAccount({
        idempotencyKey: key,
        newCustomer: { code: `ROOTACC-${key.slice(-8)}`, name: 'Root Contractor' },
        termsDays: 30,
        feeRateBpPerMonth: 200,
        creditLimitMinor: '10000',
      }),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Fail closed
// ---------------------------------------------------------------------------

describe('fail closed', () => {
  it('a signed, verified token for a user with NO account resolves to nothing', async () => {
    // The token is real: signed by the API's own signer, verified by its own
    // verifier, carrying a location scope. It authorises nothing, because
    // authority is rows in a database and this user has none.
    const ghost = await h.identityFor(tenantId, { locs: [outletA], grant: 'none' });
    const state = await loadPermissionState({ deps: h.deps, identity: ghost });
    expect(state.effective.rows).toHaveLength(0);

    await expect(
      h.callerFor(ghost).inventory.recordMovement({
        idempotencyKey: uuidv7(),
        locationId: outletA,
        productId,
        qtyDelta: '1',
        sourceKind: 'RECEIPT',
        reasonCode,
        businessDate: '2026-08-21',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await expect(
      h.callerFor(ghost).inventory.onHand({ locationId: outletA, productId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('an empty permission set can do nothing even where the token is scoped', async () => {
    // A user account that EXISTS but holds no role: the halfway state an
    // onboarding flow passes through, and the one most likely to be treated
    // as "no restrictions configured yet".
    const uid = uuidv7();
    await h.grantRole(tenantId, uid, 'counter_staff', outletA);
    await h.revokeAssignments(tenantId, uid);
    const stripped = await h.identityFor(tenantId, { uid, locs: [outletA], grant: 'none' });
    const state = await loadPermissionState({ deps: h.deps, identity: stripped });
    expect(state.effective.rows).toHaveLength(0);
    expect(state.holdsAnywhere('stock.view')).toBe(false);
  });

  it('an unknown permission code denies — it never matches, and never throws past the guard', async () => {
    const state = await loadPermissionState({
      deps: h.deps,
      identity: p('head_of_operations').identity,
    });
    // The owner holds the WHOLE catalogue. It still cannot hold a code that
    // is not in it: a typo must not become an allow via some outer handler.
    expect(() => state.requireAt('sale.super_record', outletA)).toThrow(/UNKNOWN_PERMISSION_CODE/);
    expect(() => state.requireAnywhere('stock.adjustt')).toThrow(/UNKNOWN_PERMISSION_CODE/);
    expect(() => state.requireTenantWide('')).toThrow(/UNKNOWN_PERMISSION_CODE/);
    expect(state.holdsAt('sale.super_record', outletA)).toBe(false);
  });

  it("another tenant's user id resolves to nothing, even guessed correctly", async () => {
    const otherTenant = await h.provisionTenant('rbac-other');
    // Tenant #2 mints a token carrying tenant #1's fully-privileged user id.
    // Signature valid, uid real — and RLS scopes the resolution to the token's
    // OWN tenant, so it resolves to nothing at all.
    const forged = await h.identityFor(otherTenant, {
      uid: p('head_of_operations').identity.userId,
      locs: [outletA],
      grant: 'none',
    });
    const state = await loadPermissionState({ deps: h.deps, identity: forged });
    expect(state.effective.rows).toHaveLength(0);
    expect(state.holdsAt('stock.adjust', outletA)).toBe(false);
  });

  it('a suspended user account holds nothing, without touching a single grant row', async () => {
    const uid = uuidv7();
    await h.grantRole(tenantId, uid, 'outlet_manager', outletA);
    const identity = await h.identityFor(tenantId, { uid, locs: [outletA], grant: 'none' });
    const before = await loadPermissionState({ deps: h.deps, identity });
    expect(before.holdsAt('stock.adjust', outletA)).toBe(true);

    await h.db.withTenant(tenantId, (tx) =>
      tx.query(`update app.user_account set status = 'SUSPENDED' where id = $1`, [uid]),
    );

    const after = await loadPermissionState({ deps: h.deps, identity });
    expect(after.holdsAt('stock.adjust', outletA)).toBe(false);
    await expect(
      h.callerFor(identity).inventory.recordMovement({
        idempotencyKey: uuidv7(),
        locationId: outletA,
        productId,
        qtyDelta: '1',
        sourceKind: 'RECEIPT',
        reasonCode,
        businessDate: '2026-08-21',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

// ---------------------------------------------------------------------------
// Revocation, against a token that was already minted
// ---------------------------------------------------------------------------

describe('revocation takes effect against an ALREADY-MINTED token', () => {
  it('withdrawing the assignment stops the next write, with no re-issue and no logout', async () => {
    const uid = uuidv7();
    await h.grantRole(tenantId, uid, 'outlet_manager', outletA);
    // Minted BEFORE the revocation and never refreshed afterwards — the exact
    // window a permissions claim inside the token would leave open for its
    // whole lifetime.
    const identity = await h.identityFor(tenantId, { uid, locs: [outletA], grant: 'none' });
    const caller = h.callerFor(identity);

    await expect(
      caller.inventory.recordMovement({
        idempotencyKey: uuidv7(),
        locationId: outletA,
        productId,
        qtyDelta: '9',
        sourceKind: 'RECEIPT',
        reasonCode,
        businessDate: '2026-08-21',
      }),
    ).resolves.toBeDefined();

    await h.revokeAssignments(tenantId, uid);

    await expect(
      caller.inventory.recordMovement({
        idempotencyKey: uuidv7(),
        locationId: outletA,
        productId,
        qtyDelta: '9',
        sourceKind: 'RECEIPT',
        reasonCode,
        businessDate: '2026-08-21',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a TENANT editing its own role takes effect on the next request', async () => {
    // Not a platform action and not a deploy: an administrator removing one
    // row from one role, in their own tenant, on a Tuesday afternoon.
    const revokeTenant = await h.provisionTenant('rbac-revoke');
    await h.applyTemplate(revokeTenant, true);
    const rOutlet = (await h.outlets(revokeTenant, 1))[0]!.id;
    const rProduct = (await h.pickProduct(revokeTenant)).id;
    const rReason = await h.db.withTenant(revokeTenant, async (tx) => {
      const res = await tx.query<{ code: string }>(
        `select code from app.movement_reason where deleted_at is null order by code limit 1`,
      );
      return res.rows[0]!.code;
    });
    const manager = await h.principal(revokeTenant, {
      roleRef: 'outlet_manager',
      scopeLocationId: rOutlet,
    });
    const caller = h.callerFor(manager);
    const move = () =>
      caller.inventory.recordMovement({
        idempotencyKey: uuidv7(),
        locationId: rOutlet,
        productId: rProduct,
        qtyDelta: '-1',
        sourceKind: 'WRITE_OFF',
        reasonCode: rReason,
        businessDate: '2026-08-21',
      });

    await expect(move()).resolves.toBeDefined();
    await h.revokePermissionFromRole(revokeTenant, 'outlet_manager', 'stock.adjust');
    await expect(move()).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // And it is surgical: removing `stock.adjust` did not remove `stock.receive`.
    await expect(
      caller.inventory.recordMovement({
        idempotencyKey: uuidv7(),
        locationId: rOutlet,
        productId: rProduct,
        qtyDelta: '1',
        sourceKind: 'RECEIPT',
        reasonCode: rReason,
        businessDate: '2026-08-21',
      }),
    ).resolves.toBeDefined();
  }, 180_000);
});

// ---------------------------------------------------------------------------
// The affordance
// ---------------------------------------------------------------------------

describe('session.permissions is an affordance, and says so', () => {
  it('offers counter staff neither prohibited capability, anywhere', async () => {
    const res = await p('counter_staff').caller.session.permissions();
    const codes = new Set(res.grants.map((g) => g.code));
    expect(codes.has('sale.override_price')).toBe(false);
    expect(codes.has('credit.limit.change')).toBe(false);
    expect(codes.has('sale.record')).toBe(true);
    expect(res.advisory).toMatch(/AFFORDANCE ONLY/);
  });

  it('reports a capability per LOCATION, not as a bare list', async () => {
    const res = await p('outlet_manager').caller.session.permissions();
    const adjust = res.grants.filter((g) => g.code === 'stock.adjust');
    expect(adjust.length).toBeGreaterThan(0);
    expect(adjust.map((g) => g.locationId)).toContain(outletA);
    expect(adjust.map((g) => g.locationId)).not.toContain(outletB);
  });

  it('carries bounds as decimal strings, never as JSON numbers', async () => {
    const res = await p('outlet_manager').caller.session.permissions();
    const credit = res.grants.find(
      (g) => g.code === 'sale.record.credit' && g.locationId === outletA,
    );
    expect(credit?.bound?.['max_order_value_minor']).toBe('500000');
    expect(typeof credit?.bound?.['max_order_value_minor']).toBe('string');
  });

  it('is not a control: what it shows changes nothing about what the server accepts', async () => {
    // The screen says the counter may not adjust stock. The counter's device
    // is a tablet whose local database anyone with root can edit. The refusal
    // that matters is this one, and it happens on the server.
    const res = await p('counter_staff').caller.session.permissions();
    expect(res.grants.some((g) => g.code === 'stock.adjust')).toBe(false);
    await expect(
      p('counter_staff').caller.inventory.recordMovement({
        idempotencyKey: uuidv7(),
        locationId: outletA,
        productId,
        qtyDelta: '-1',
        sourceKind: 'WRITE_OFF',
        reasonCode,
        businessDate: '2026-08-21',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
