/**
 * THE LEDGER'S READ SURFACE — wired, guarded, and honest when empty.
 *
 * Phase 3 built the journal and the statements in `packages/db` and nothing
 * could call them: no router, no client, no screen — the §0 defect class,
 * one short of its nineteenth entry. These tests hold the wiring.
 *
 * The fixture posts documents through the REAL engine (rules -> mapping ->
 * postDocument -> Postgres), so a statement that agrees with it proves the
 * whole chain over the router, not a SQL query against hand-written rows.
 * Accounts and mappings are invented here, per the Track A boundary — the
 * product still seeds none, and the FIRST describe block asserts exactly
 * that emptiness as the answer a fresh tenant gets.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@erp/db';
import { postDocument, saleEntry, paymentEntry } from '@erp/db';
import type { VerifiedIdentity } from '../src/auth.js';
import { createApiHarness, type ApiHarness } from './util.js';

let h: ApiHarness;
let tenantId: string;
let tenantB: string;
let techiman: string;
let sunyani: string;
const CUSTOMER = '018f0000-0000-8000-8000-00000000c0de';
const FY = 'FY27';

type Caller = ReturnType<ApiHarness['callerFor']>;
const principals = new Map<string, { identity: VerifiedIdentity; caller: Caller }>();
function p(ref: string) {
  const found = principals.get(ref);
  if (!found) throw new Error(`no principal ${ref}`);
  return found;
}

async function account(
  tenant: string,
  spec: { code: string; type: string; control?: string | null },
): Promise<string> {
  return h.db.withTenant(tenant, async (tx) => {
    const id = uuidv7();
    await tx.query(
      `insert into app.gl_account (tenant_id, id, code, name, account_type, normal_balance,
                                   is_postable, control_account_kind, report_line_key)
       values ($1,$2,$3,$4,$5,$6,true,$7,$8)`,
      [tenant, id, spec.code, `Test ${spec.code}`, spec.type,
       spec.type === 'ASSET' || spec.type === 'EXPENSE' ? 'D' : 'C',
       spec.control ?? null, `line:${spec.code}`],
    );
    return id;
  });
}

async function mapRole(tenant: string, role: string, accountId: string): Promise<void> {
  await h.db.withTenant(tenant, (tx) =>
    tx.query(
      `insert into app.gl_account_mapping
         (tenant_id, id, posting_role, scope_kind, account_id, mapping_set_version, effective_from)
       values ($1,$2,$3,'tenant',$4,1,'2026-01-01')`,
      [tenant, uuidv7(), role, accountId],
    ));
}

beforeAll(async () => {
  h = await createApiHarness();
  tenantId = await h.provisionTenant('ledger-a');
  await h.applyTemplate(tenantId, true);
  tenantB = await h.provisionTenant('ledger-b');
  await h.applyTemplate(tenantB, true);

  const root = await h.locationByCode(tenantId, 'ROOT');
  const outs = await h.outlets(tenantId, 2);
  techiman = outs[0]!.id;
  sunyani = outs[1]!.id;

  for (const ref of ['accounts', 'counter_staff', 'outlet_manager', 'regional_manager'] as const) {
    const identity = await h.principal(tenantId, { roleRef: ref, scopeLocationId: root });
    principals.set(ref, { identity, caller: h.callerFor(identity) });
  }
}, 240_000);

afterAll(async () => {
  await h?.close();
});

describe('a fresh tenant answers EMPTY, not an error — the pre-Track-B truth', () => {
  it('the trial balance says zero accounts, zero rows, balanced', async () => {
    const tb = await p('accounts').caller.ledger.trialBalance({});
    expect(tb.accountCount).toBe(0);
    expect(tb.rows).toEqual([]);
    expect(tb.balanced).toBe(true);
    expect(tb.debitMinor).toBe('0');
  });

  it('so do the P&L, the balance sheet, and the exception list', async () => {
    const pl = await p('accounts').caller.ledger.profitAndLoss({});
    const bs = await p('accounts').caller.ledger.balanceSheet({});
    const ex = await p('accounts').caller.ledger.postingExceptions({});
    expect(pl.revenueMinor).toBe('0');
    expect(bs.rows).toEqual([]);
    expect(bs.reconciles).toBe(true); // 0 === 0, honestly
    expect(ex.openCount).toBe(0);
  });
});

describe('gl.view is the accounts capability, and nobody else’s', () => {
  it('counter staff and the outlet manager are refused every ledger read', async () => {
    for (const ref of ['counter_staff', 'outlet_manager'] as const) {
      await expect(p(ref).caller.ledger.trialBalance({})).rejects.toThrow(
        /PERMISSION_DENIED.*gl\.view/s,
      );
      await expect(p(ref).caller.ledger.postingExceptions({})).rejects.toThrow(/gl\.view/);
    }
  });

  it('…and the refusal names the capability an administrator must grant', async () => {
    await expect(p('counter_staff').caller.ledger.balanceSheet({})).rejects.toThrow(/gl\.view/);
  });

  it('holding report.view.margin does NOT open the books — the discriminator', async () => {
    // The regional manager here is scoped at the ROOT, so they hold
    // report.view.margin tenant-wide — the strongest reporting grant short of
    // Accounts. If the ledger were guarded by any report code instead of
    // gl.view, this principal would read the books, and every other refusal
    // in this file would still pass. This is the one test that can tell the
    // difference, which is what makes the guard mutation-testable at all.
    await expect(p('regional_manager').caller.ledger.trialBalance({})).rejects.toThrow(
      /gl\.view/,
    );
  });
});

describe('with a ledger built by the real engine, the router reports it', () => {
  beforeAll(async () => {
    await h.db.withTenant(tenantId, async (tx) => {
      await tx.query(
        `insert into app.fiscal_year (tenant_id, fy_code, starts_on, ends_on)
         values ($1,$2,'2026-08-01','2027-07-31')`, [tenantId, FY]);
      await tx.query(`insert into app.gl_counter (tenant_id, fy_code) values ($1,$2)`, [tenantId, FY]);
      await tx.query(
        `insert into app.accounting_period (tenant_id, id, fy_code, seq, starts_on, ends_on)
         values ($1,$2,$3,1,'2026-08-01','2026-08-31')`, [tenantId, uuidv7(), FY]);
    });
    await mapRole(tenantId, 'TILL_CASH', await account(tenantId, { code: '1000', type: 'ASSET', control: 'TILL' }));
    await mapRole(tenantId, 'SALES_REVENUE', await account(tenantId, { code: '4100', type: 'INCOME' }));
    await mapRole(tenantId, 'OUTPUT_TAX', await account(tenantId, { code: '2200', type: 'LIABILITY' }));
    await mapRole(tenantId, 'COGS', await account(tenantId, { code: '5000', type: 'EXPENSE' }));
    await mapRole(tenantId, 'INVENTORY', await account(tenantId, { code: '1300', type: 'ASSET', control: 'INVENTORY' }));
    await mapRole(tenantId, 'AR_TRADE', await account(tenantId, { code: '1400', type: 'ASSET', control: 'AR' }));
    await mapRole(tenantId, 'INTERLOC_CLEARING', await account(tenantId, { code: '1900', type: 'ASSET' }));

    const opts = { tenantId, postedBy: uuidv7(), postingRuleVersion: 1 };
    for (const doc of [
      saleEntry({
        saleId: uuidv7(), locationId: techiman, businessDate: '2026-08-15',
        tenders: [{ role: 'TILL_CASH', amountMinor: 18_000n }],
        revenueMinor: 15_000n, discountMinor: 0n,
        taxes: [{ taxCode: 'GH.VAT.STD', taxMinor: 3_000n }], costMinor: 9_000n,
      }),
      saleEntry({
        saleId: uuidv7(), locationId: techiman, businessDate: '2026-08-15',
        tenders: [{ role: 'AR_TRADE', amountMinor: 600_000n }],
        customerId: CUSTOMER, revenueMinor: 500_000n, discountMinor: 0n,
        taxes: [{ taxCode: 'GH.VAT.STD', taxMinor: 100_000n }], costMinor: 300_000n,
      }),
      paymentEntry({
        paymentId: uuidv7(), businessDate: '2026-08-20',
        receivingLocationId: sunyani, obligationLocationId: techiman,
        customerId: CUSTOMER, amountMinor: 600_000n, instrument: 'CASH',
      }),
    ]) {
      const r = await postDocument(h.db, doc, opts);
      if (r.status !== 'posted') throw new Error(`fixture: ${JSON.stringify(r)}`);
    }
  }, 120_000);

  it('the trial balance is balanced per tenant AND per location, over HTTP shape', async () => {
    const tb = await p('accounts').caller.ledger.trialBalance({});
    expect(tb.accountCount).toBe(7);
    expect(tb.balanced).toBe(true);
    expect(tb.debitMinor).toBe(tb.creditMinor);
    expect(BigInt(tb.debitMinor)).toBeGreaterThan(0n);
    expect(tb.byLocation.length).toBe(2);
    for (const loc of tb.byLocation) expect(loc.balanced).toBe(true);
    // Every money figure is a decimal STRING — no JSON number ever carries a
    // magnitude (ADR-0004), and no field is a superjson-annotated Date.
    expect(typeof tb.debitMinor).toBe('string');
  });

  it('the P&L carries the engine’s own figures', async () => {
    const pl = await p('accounts').caller.ledger.profitAndLoss({});
    expect(pl.revenueMinor).toBe('515000'); // 15,000 + 500,000
    expect(pl.expenseMinor).toBe('309000'); // 9,000 + 300,000
    expect(pl.resultMinor).toBe('206000');
  });

  it('the balance sheet does NOT balance mid-year, and says the statements still agree', async () => {
    const bs = await p('accounts').caller.ledger.balanceSheet({});
    expect(bs.gapMinor).toBe('206000'); // the unclosed profit
    expect(bs.reconciles).toBe(true); // gap === P&L result: the identity that holds every day
    expect(bs.resultMinor).toBe('206000');
  });

  it('a location filter narrows honestly — one outlet is not the network', async () => {
    const one = await p('accounts').caller.ledger.profitAndLoss({ locationIds: [sunyani] });
    expect(one.revenueMinor).toBe('0'); // Sunyani only took a payment — settlement is not revenue
    const both = await p('accounts').caller.ledger.profitAndLoss({});
    expect(both.revenueMinor).toBe('515000');
  });

  it('…on EVERY statement, not just the P&L', async () => {
    // Added because a mutation dropping trialBalance's location filter
    // survived the suite: the filter test above only exercised profitAndLoss,
    // so each statement's own path needs its own narrow-vs-network pair.
    const narrowTb = await p('accounts').caller.ledger.trialBalance({ locationIds: [sunyani] });
    const fullTb = await p('accounts').caller.ledger.trialBalance({});
    expect(narrowTb.byLocation).toHaveLength(1);
    expect(narrowTb.byLocation[0]!.locationId).toBe(sunyani);
    expect(fullTb.byLocation).toHaveLength(2);
    expect(BigInt(narrowTb.debitMinor)).toBeLessThan(BigInt(fullTb.debitMinor));

    const narrowBs = await p('accounts').caller.ledger.balanceSheet({ locationIds: [sunyani] });
    const fullBs = await p('accounts').caller.ledger.balanceSheet({});
    expect(BigInt(narrowBs.assetMinor)).toBeLessThan(BigInt(fullBs.assetMinor));
  });

  it('a posting exception reaches the surface with string timestamps', async () => {
    const opts = { tenantId, postedBy: uuidv7(), postingRuleVersion: 1 };
    const orphan = saleEntry({
      saleId: uuidv7(), locationId: techiman, businessDate: '2027-12-01',
      tenders: [{ role: 'TILL_CASH', amountMinor: 1_000n }],
      revenueMinor: 1_000n, discountMinor: 0n, taxes: [], costMinor: 0n,
    });
    const r = await postDocument(h.db, orphan, opts);
    expect(r.status).toBe('exception');

    const list = await p('accounts').caller.ledger.postingExceptions({});
    expect(list.openCount).toBe(1);
    const ex = list.exceptions[0]!;
    expect(ex.errorCode).toBe('GL_NO_PERIOD');
    expect(ex.openedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(ex.resolvedAt).toBeNull();
  });
});

describe('tenant isolation on every ledger read — §2.7 category 3', () => {
  it('tenant B sees an empty ledger while A’s is populated, and A’s locations resolve to nothing', async () => {
    const rootB = await h.locationByCode(tenantB, 'ROOT');
    const bIdentity = await h.principal(tenantB, { roleRef: 'accounts', scopeLocationId: rootB });
    const bCaller = h.callerFor(bIdentity);

    const bTb = await bCaller.ledger.trialBalance({});
    expect(bTb.accountCount).toBe(0);
    expect(bTb.rows).toEqual([]);

    // Naming tenant A's location id from B returns NOTHING — RLS scopes the
    // read, so a guessed uuid is indistinguishable from an empty ledger.
    const leaked = await bCaller.ledger.profitAndLoss({ locationIds: [techiman] });
    expect(leaked.rows).toEqual([]);
    expect(leaked.revenueMinor).toBe('0');

    // Positive control: A still answers with real figures in the same run.
    const aTb = await p('accounts').caller.ledger.trialBalance({});
    expect(aTb.rows.length).toBeGreaterThan(0);
  });
});
