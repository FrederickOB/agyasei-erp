/**
 * ROLES, MAPPINGS, AND THE REFUSALS THAT KEEP THEM HONEST.
 *
 * 05 §5.6.1 rejects a tenant-editable posting-rule engine because it "is the
 * fastest way to let a non-accountant book revenue to a liability" — and then
 * specified a mapping table that permitted exactly that. These tests hold the
 * correction: a role names an ACCOUNT TYPE, the database checks it, and a
 * mapping that would put revenue on a payable is refused at configuration time
 * rather than discovered in a P&L.
 *
 * Every account and every mapping below is invented by the test that needs it.
 * There are no seeded accounts and no seeded mappings in this product, and
 * there must not be until the §2.8 accountant review has happened (Q6).
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/ids.js';
import { MissingMappingError, mappingGaps, resolveAccount } from '../src/posting/mapping.js';
import type { Queryable, TestDb } from '../src/testing/harness.js';
import { makeLocation } from './rbac-fixtures.js';
import { setupDb, setupTwoTenants, TENANT_A, TENANT_B } from './util.js';

let db: TestDb;
let outlet: string;
let other: string;
let till: string;
let revenue: string;
let payable: string;
let bank: string;
let rollupIncome: string;
const CATEGORY = '018f0000-0000-8000-8000-0000000000c1';

async function account(
  tx: Queryable,
  tenantId: string,
  spec: { code: string; type: string; control?: string | null; postable?: boolean },
): Promise<string> {
  const id = uuidv7();
  await tx.query(
    `insert into app.gl_account
       (tenant_id, id, code, name, account_type, normal_balance, is_postable,
        control_account_kind, report_line_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [tenantId, id, spec.code, `Test ${spec.code}`, spec.type,
     spec.type === 'ASSET' || spec.type === 'EXPENSE' ? 'D' : 'C',
     spec.postable ?? true, spec.control ?? null, `line:${spec.code}`],
  );
  return id;
}

async function map(
  tx: Queryable,
  tenantId: string,
  spec: {
    role: string; account: string; scopeKind?: string; scopeId?: string | null;
    from?: string; to?: string | null; version?: number;
  },
): Promise<string> {
  const id = uuidv7();
  await tx.query(
    `insert into app.gl_account_mapping
       (tenant_id, id, posting_role, scope_kind, scope_id, account_id,
        mapping_set_version, effective_from, effective_to)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [tenantId, id, spec.role, spec.scopeKind ?? 'tenant', spec.scopeId ?? null,
     spec.account, spec.version ?? 1, spec.from ?? '2026-01-01', spec.to ?? null],
  );
  return id;
}

beforeAll(async () => {
  db = await setupDb();
  await setupTwoTenants(db);
  await db.withTenant(TENANT_A, async (tx) => {
    outlet = await makeLocation(tx, TENANT_A, { code: 'PM-01' });
    other = await makeLocation(tx, TENANT_A, { code: 'PM-02' });
    rollupIncome = await account(tx, TENANT_A, { code: '4000', type: 'INCOME', postable: false });
    till = await account(tx, TENANT_A, { code: '1000', type: 'ASSET', control: 'TILL' });
    revenue = await account(tx, TENANT_A, { code: '4100', type: 'INCOME' });
    payable = await account(tx, TENANT_A, { code: '2100', type: 'LIABILITY', control: 'AP' });
    bank = await account(tx, TENANT_A, { code: '1200', type: 'ASSET', control: 'BANK' });
  });
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe('the role catalogue is platform vocabulary, and it carries no tenant', () => {
  it('has no tenant_id column at all — a role is not configuration', async () => {
    const cols = await db.asAdmin(async (tx) => {
      const r = await tx.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'platform' and table_name = 'posting_role_catalog'`,
      );
      return r.rows.map((x) => x.column_name);
    });
    expect(cols).not.toContain('tenant_id');
    expect(cols).toContain('required_account_type');
  });

  it('every role a rule emits declares the account type it must resolve to', async () => {
    const roles = await db.asAdmin(async (tx) => {
      const r = await tx.query<{ posting_role: string; required_account_type: string }>(
        `select posting_role, required_account_type from platform.posting_role_catalog`,
      );
      return r.rows;
    });
    expect(roles.length).toBeGreaterThan(30);
    // Spot-check the four that decide whether a P&L is a P&L.
    const byRole = new Map(roles.map((r) => [r.posting_role, r.required_account_type]));
    expect(byRole.get('SALES_REVENUE')).toBe('INCOME');
    expect(byRole.get('OUTPUT_TAX')).toBe('LIABILITY'); // tax is never revenue
    expect(byRole.get('COGS')).toBe('EXPENSE');
    expect(byRole.get('INVENTORY')).toBe('ASSET');
  });

  it('payroll roles exist for CAPTURE and none of them computes anything', async () => {
    // CLAUDE.md §2.4. The employer contribution has its own expense AND its
    // own payable, because recording the bureau's figure is not calculating.
    const roles = await db.asAdmin(async (tx) => {
      const r = await tx.query<{ posting_role: string; required_account_type: string }>(
        `select posting_role, required_account_type from platform.posting_role_catalog
          where required_when_feature = 'PAYROLL' order by posting_role`,
      );
      return r.rows;
    });
    const names = roles.map((r) => r.posting_role);
    expect(names).toContain('STAFF_COST_EMPLOYER_SOCIAL');
    expect(names).toContain('EMPLOYER_SOCIAL_PAYABLE');
    expect(names).toContain('NET_PAY_PAYABLE');
    // Nothing that implies a computed rate. A role called anything like this
    // would be the §2.4 violation arriving through the back door.
    for (const n of names) {
      expect(n).not.toMatch(/RATE|BRACKET|PAYE|SSNIT|WITHHOLD/i);
    }
  });
});

describe('a mapping cannot book revenue to a liability', () => {
  it('SALES_REVENUE mapped to a payable is REFUSED', async () => {
    await expect(
      db.withTenant(TENANT_A, (tx) => map(tx, TENANT_A, { role: 'SALES_REVENUE', account: payable })),
    ).rejects.toThrow(/GL0031.*must map to a INCOME account/s);
  });

  it('…and mapped to an income account is accepted — the positive control', async () => {
    const id = await db.withTenant(TENANT_A, (tx) =>
      map(tx, TENANT_A, { role: 'SALES_REVENUE', account: revenue }));
    expect(id).toBeTruthy();
  });

  it('a role that requires a CONTROL kind refuses an account of the right type but wrong kind', async () => {
    // TILL_CASH must be an ASSET *and* a TILL control account. `bank` is an
    // asset with control kind BANK — the right type, the wrong role.
    await expect(
      db.withTenant(TENANT_A, (tx) => map(tx, TENANT_A, { role: 'TILL_CASH', account: bank })),
    ).rejects.toThrow(/GL0032.*requires a TILL control account/s);
  });

  it('…and the same role accepts the till account — the positive control', async () => {
    const id = await db.withTenant(TENANT_A, (tx) =>
      map(tx, TENANT_A, { role: 'TILL_CASH', account: till }));
    expect(id).toBeTruthy();
  });

  it('a mapping to a ROLLUP account is refused at configuration time, not mid-posting', async () => {
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        map(tx, TENANT_A, { role: 'SALES_DISCOUNT', account: rollupIncome })),
    ).rejects.toThrow(/GL0033.*may not map to a rollup account/s);
  });

  it('a mapping naming an account that does not exist is refused', async () => {
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        map(tx, TENANT_A, { role: 'BANK', account: '018f0000-0000-8000-8000-00000000dead' })),
    ).rejects.toThrow(/GL0030|foreign key/i);
  });
});

describe('resolution is most-specific-first, and dated by the DOCUMENT', () => {
  let categoryRevenue: string;
  let outletRevenue: string;

  beforeAll(async () => {
    await db.withTenant(TENANT_A, async (tx) => {
      categoryRevenue = await account(tx, TENANT_A, { code: '4110', type: 'INCOME' });
      outletRevenue = await account(tx, TENANT_A, { code: '4120', type: 'INCOME' });
    });
  }, 60_000);

  it('the tenant default answers when nothing narrower is mapped', async () => {
    const r = await db.withTenant(TENANT_A, (tx) =>
      resolveAccount(tx, 'SALES_REVENUE', { locationId: outlet }, '2026-08-15'));
    expect(r.accountId).toBe(revenue);
    expect(r.scopeKind).toBe('tenant');
  });

  it('a LOCATION mapping beats the tenant default', async () => {
    // `effective_from` is deliberately EARLIER than the tenant default's.
    // With an equal date this test passed under a mutation that dropped the
    // specificity ordering entirely and sorted by date alone — it was holding
    // the insert order, not the rule. Dated behind the default, only
    // most-specific-first can produce the expected answer.
    await db.withTenant(TENANT_A, (tx) =>
      map(tx, TENANT_A, {
        role: 'SALES_REVENUE', account: outletRevenue, scopeKind: 'location', scopeId: outlet,
        from: '2025-01-01',
      }));
    const r = await db.withTenant(TENANT_A, (tx) =>
      resolveAccount(tx, 'SALES_REVENUE', { locationId: outlet }, '2026-08-15'));
    expect(r.accountId).toBe(outletRevenue);
    expect(r.scopeKind).toBe('location');

    // …and a DIFFERENT location still gets the tenant default. Without this
    // the test above would pass just as well if scope were ignored entirely.
    const elsewhere = await db.withTenant(TENANT_A, (tx) =>
      resolveAccount(tx, 'SALES_REVENUE', { locationId: other }, '2026-08-15'));
    expect(elsewhere.accountId).toBe(revenue);
  });

  it('a PRODUCT CATEGORY mapping beats both', async () => {
    await db.withTenant(TENANT_A, (tx) =>
      map(tx, TENANT_A, {
        role: 'SALES_REVENUE', account: categoryRevenue,
        scopeKind: 'product_category', scopeId: CATEGORY,
      }));
    const r = await db.withTenant(TENANT_A, (tx) =>
      resolveAccount(tx, 'SALES_REVENUE',
        { locationId: outlet, productCategoryId: CATEGORY }, '2026-08-15'));
    expect(r.accountId).toBe(categoryRevenue);
    expect(r.scopeKind).toBe('product_category');

    // A different category at the same outlet falls back to the location.
    const otherCategory = await db.withTenant(TENANT_A, (tx) =>
      resolveAccount(tx, 'SALES_REVENUE',
        { locationId: outlet, productCategoryId: uuidv7() }, '2026-08-15'));
    expect(otherCategory.accountId).toBe(outletRevenue);
  });

  it('a document from BEFORE a mapping took effect resolves against the older one', async () => {
    // The eight-days-offline case, and the same rule the tax pack follows: a
    // sale reprices against the configuration in force when it happened, never
    // against today's. Resolving history against current config silently
    // restates the past.
    const laterRevenue = await db.withTenant(TENANT_A, (tx) =>
      account(tx, TENANT_A, { code: '4130', type: 'INCOME' }));
    await db.withTenant(TENANT_A, async (tx) => {
      // Close the open location mapping, and open a new one after it.
      await tx.query(
        `update app.gl_account_mapping set effective_to = '2026-09-01'
          where posting_role = 'SALES_REVENUE' and scope_kind = 'location' and scope_id = $1
            and effective_from = '2025-01-01'`,
        [outlet],
      );
      await map(tx, TENANT_A, {
        role: 'SALES_REVENUE', account: laterRevenue, scopeKind: 'location', scopeId: outlet,
        from: '2026-09-01', version: 2,
      });
    });

    const before = await db.withTenant(TENANT_A, (tx) =>
      resolveAccount(tx, 'SALES_REVENUE', { locationId: outlet }, '2026-08-15'));
    const after = await db.withTenant(TENANT_A, (tx) =>
      resolveAccount(tx, 'SALES_REVENUE', { locationId: outlet }, '2026-09-15'));

    expect(before.accountId).toBe(outletRevenue);
    expect(before.mappingSetVersion).toBe(1);
    expect(after.accountId).toBe(laterRevenue);
    expect(after.mappingSetVersion).toBe(2);
  });

  it('an UNMAPPED role throws rather than reaching for a suspense account', async () => {
    // A suspense fallback turns a configuration error somebody can fix in a
    // minute into a balance nobody can explain in a year.
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        resolveAccount(tx, 'INVENTORY', { locationId: outlet }, '2026-08-15')),
    ).rejects.toThrow(MissingMappingError);
  });

  it('the error carries everything a posting exception needs', async () => {
    let caught: unknown;
    try {
      await db.withTenant(TENANT_A, (tx) =>
        resolveAccount(tx, 'COGS', { locationId: outlet }, '2026-08-15'));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MissingMappingError);
    const err = caught as MissingMappingError;
    expect(err.code).toBe('GL_MAPPING_MISSING');
    expect(err.postingRole).toBe('COGS');
    expect(err.scope.locationId).toBe(outlet);
    expect(err.businessDate).toBe('2026-08-15');
    // The message names the role, the place and the date — an exception row
    // built from this needs no second lookup to be actionable.
    expect(err.message).toContain('COGS');
    expect(err.message).toContain('2026-08-15');
  });
});

describe('the onboarding completeness gate', () => {
  it('names the roles this tenant has not mapped, and only the ones it needs', async () => {
    const gaps = await db.withTenant(TENANT_A, (tx) => mappingGaps(tx, [], '2026-08-15'));
    const roles = gaps.map((g) => g.postingRole);

    expect(roles).toContain('INVENTORY'); // required always, not mapped
    expect(roles).not.toContain('SALES_REVENUE'); // mapped above
    expect(roles).not.toContain('TILL_CASH'); // mapped above

    // A tenant with no credit product is NEVER asked to map AR or the
    // facility fee. An unconditional check demanded both, which is what
    // `required_when_feature` exists to fix.
    expect(roles).not.toContain('AR_TRADE');
    expect(roles).not.toContain('FACILITY_FEE_INCOME');
    expect(roles).not.toContain('NET_PAY_PAYABLE');
  });

  it('…and DOES ask for them once that feature is enabled — the positive control', async () => {
    const gaps = await db.withTenant(TENANT_A, (tx) =>
      mappingGaps(tx, ['CREDIT_SALES', 'FACILITY_FEE', 'PAYROLL'], '2026-08-15'));
    const roles = gaps.map((g) => g.postingRole);
    expect(roles).toContain('AR_TRADE');
    expect(roles).toContain('FACILITY_FEE_INCOME');
    expect(roles).toContain('NET_PAY_PAYABLE');
  });

  it('a fresh tenant has mapped NOTHING — no template seeds a mapping', async () => {
    // The Track A boundary, asserted rather than assumed: if a chart of
    // accounts or a mapping ever appears in the template, this fails.
    const gaps = await db.withTenant(TENANT_B, (tx) => mappingGaps(tx, [], '2026-08-15'));
    const mapped = await db.withTenant(TENANT_B, async (tx) => {
      const r = await tx.query<{ n: string }>(
        `select count(*)::text n from app.gl_account_mapping`);
      const a = await tx.query<{ n: string }>(`select count(*)::text n from app.gl_account`);
      return { mappings: Number(r.rows[0]!.n), accounts: Number(a.rows[0]!.n) };
    });
    expect(mapped.mappings).toBe(0);
    expect(mapped.accounts).toBe(0);
    expect(gaps.length).toBeGreaterThan(0);
  });
});

describe('tenant isolation on the mapping path — §2.7 category 3', () => {
  it('tenant B cannot map to tenant A’s account, and resolves none of A’s mappings', async () => {
    const bRevenue = await db.withTenant(TENANT_B, (tx) =>
      account(tx, TENANT_B, { code: '4100', type: 'INCOME' }));

    // Naming A's account id from B's session does not resolve at all.
    await expect(
      db.withTenant(TENANT_B, (tx) => map(tx, TENANT_B, { role: 'SALES_REVENUE', account: revenue })),
    ).rejects.toThrow(/GL0030|foreign key/i);

    // Positive control: B can map its OWN account, and then resolves to it —
    // never to A's, which is mapped for the same role.
    await db.withTenant(TENANT_B, (tx) => map(tx, TENANT_B, { role: 'SALES_REVENUE', account: bRevenue }));
    const bLocation = await db.withTenant(TENANT_B, (tx) => makeLocation(tx, TENANT_B, { code: 'PM-B1' }));
    const r = await db.withTenant(TENANT_B, (tx) =>
      resolveAccount(tx, 'SALES_REVENUE', { locationId: bLocation }, '2026-08-15'));
    expect(r.accountId).toBe(bRevenue);
    expect(r.accountId).not.toBe(revenue);
  });
});
