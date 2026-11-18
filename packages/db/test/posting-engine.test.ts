/**
 * THE ENGINE — a settled document becoming a journal entry, and what happens
 * when it cannot.
 *
 * 05 §5.6.1's ruling is the thing under test here, and it is a ruling about
 * FAILURE rather than success: **acceptance and posting are separate, and a
 * posting failure never rejects a settled document.** So roughly half of these
 * tests are about documents that do not post, and about the row that makes
 * that visible instead of silent.
 *
 * Every account and every mapping below is invented by the test that needs it.
 * The product still seeds none.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/ids.js';
import { POSTING_ERROR, postDocument } from '../src/posting/engine.js';
import { paymentEntry, type ProposedEntry } from '../src/posting/rules.js';
import type { Queryable, TestDb } from '../src/testing/harness.js';
import { makeLocation } from './rbac-fixtures.js';
import { saleWith, setupDb, setupTwoTenants, TENANT_A, TENANT_B, type OneTenderSale } from './util.js';

let db: TestDb;
let techiman: string;
let sunyani: string;
const POSTER = '018f0000-0000-8000-8000-0000000000ff';
const CUSTOMER = '018f0000-0000-8000-8000-00000000c0de';
const FY = 'FY27';

const OPTS = { tenantId: TENANT_A, postedBy: POSTER, postingRuleVersion: 1 };

async function account(
  tx: Queryable, tenantId: string,
  spec: { code: string; type: string; control?: string | null },
): Promise<string> {
  const id = uuidv7();
  await tx.query(
    `insert into app.gl_account
       (tenant_id, id, code, name, account_type, normal_balance, is_postable,
        control_account_kind, report_line_key)
     values ($1,$2,$3,$4,$5,$6,true,$7,$8)`,
    [tenantId, id, spec.code, `Test ${spec.code}`, spec.type,
     spec.type === 'ASSET' || spec.type === 'EXPENSE' ? 'D' : 'C',
     spec.control ?? null, `line:${spec.code}`],
  );
  return id;
}

async function mapRole(tx: Queryable, tenantId: string, role: string, accountId: string): Promise<void> {
  await tx.query(
    `insert into app.gl_account_mapping
       (tenant_id, id, posting_role, scope_kind, account_id, mapping_set_version, effective_from)
     values ($1,$2,$3,'tenant',$4,1,'2026-01-01')`,
    [tenantId, uuidv7(), role, accountId],
  );
}

async function calendar(tx: Queryable, tenantId: string, periodStatus = 'open'): Promise<void> {
  await tx.query(
    `insert into app.fiscal_year (tenant_id, fy_code, starts_on, ends_on)
     values ($1,$2,'2026-08-01','2027-07-31')`, [tenantId, FY]);
  await tx.query(`insert into app.gl_counter (tenant_id, fy_code) values ($1,$2)`, [tenantId, FY]);
  await tx.query(
    `insert into app.accounting_period (tenant_id, id, fy_code, seq, starts_on, ends_on, status, closed_at, closed_by)
     values ($1,$2,$3,1,'2026-08-01','2026-08-31',$4,$5,$6)`,
    [tenantId, uuidv7(), FY, periodStatus,
     periodStatus === 'open' ? null : new Date('2026-09-01T00:00:00Z').toISOString(),
     periodStatus === 'open' ? null : POSTER],
  );
}

function aSale(over: Partial<OneTenderSale> = {}): ProposedEntry {
  return saleWith({
    saleId: uuidv7(), locationId: techiman, businessDate: '2026-08-15', tender: 'CASH',
    revenueMinor: 15_000n, discountMinor: 0n,
    taxes: [{ taxCode: 'GH.VAT.STD', taxMinor: 3_000n }], costMinor: 9_000n,
    ...over,
  });
}

async function entryLines(entryId: string) {
  return db.withTenant(TENANT_A, async (tx) => {
    const r = await tx.query<{
      code: string; location_id: string; debit_minor: string; credit_minor: string;
      counterparty_id: string | null; memo: string | null;
    }>(
      `select a.code, l.location_id, l.debit_minor::text, l.credit_minor::text,
              l.counterparty_id, l.memo
         from app.journal_line l
         join app.gl_account a on a.tenant_id = l.tenant_id and a.id = l.account_id
        where l.journal_entry_id = $1 order by l.line_no`,
      [entryId],
    );
    return r.rows;
  });
}

beforeAll(async () => {
  db = await setupDb();
  await setupTwoTenants(db);
  await db.withTenant(TENANT_A, async (tx) => {
    techiman = await makeLocation(tx, TENANT_A, { code: 'ENG-01' });
    sunyani = await makeLocation(tx, TENANT_A, { code: 'ENG-02' });
    await calendar(tx, TENANT_A);
    await mapRole(tx, TENANT_A, 'TILL_CASH', await account(tx, TENANT_A, { code: '1000', type: 'ASSET', control: 'TILL' }));
    await mapRole(tx, TENANT_A, 'SALES_REVENUE', await account(tx, TENANT_A, { code: '4100', type: 'INCOME' }));
    await mapRole(tx, TENANT_A, 'OUTPUT_TAX', await account(tx, TENANT_A, { code: '2200', type: 'LIABILITY' }));
  });
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe('a document that CANNOT post does not vanish — it becomes an exception', () => {
  it('a missing mapping opens an exception and writes NO journal entry', async () => {
    // COGS and INVENTORY are deliberately unmapped at this point.
    const doc = aSale();
    const result = await postDocument(db, doc, OPTS);

    expect(result.status).toBe('exception');
    if (result.status !== 'exception') throw new Error('unreachable');
    expect(result.errorCode).toBe(POSTING_ERROR.mappingMissing);
    // It names EVERY missing role, not just the first — an operator fixing
    // them one at a time round a retry loop is the failure this avoids.
    expect(result.detail).toContain('COGS');
    expect(result.detail).toContain('INVENTORY');

    const entries = await db.withTenant(TENANT_A, async (tx) => {
      const r = await tx.query<{ n: string }>(
        `select count(*)::text n from app.journal_entry where source_id = $1`, [doc.sourceId]);
      return Number(r.rows[0]!.n);
    });
    expect(entries).toBe(0);
  });

  it('the exception row carries what an operator needs to act', async () => {
    const doc = aSale();
    await postDocument(db, doc, OPTS);
    const row = await db.withTenant(TENANT_A, async (tx) => {
      const r = await tx.query<{
        error_code: string; posting_role: string; location_id: string;
        document_date: string; resolved_at: string | null; severity: number;
      }>(
        `select error_code, posting_role, location_id, document_date::text, resolved_at, severity
           from app.posting_exception where source_id = $1`, [doc.sourceId]);
      return r.rows[0]!;
    });
    expect(row.error_code).toBe(POSTING_ERROR.mappingMissing);
    expect(row.location_id).toBe(techiman);
    expect(row.document_date).toBe('2026-08-15');
    expect(row.resolved_at).toBeNull();
    expect(row.severity).toBe(1);
  });

  it('a RETRY that fails the same way updates the row rather than piling up', async () => {
    // Otherwise the close gate counts attempts instead of problems, and a
    // background worker draining 300 offline sales writes 300 rows about one
    // missing mapping.
    const doc = aSale();
    await postDocument(db, doc, OPTS);
    await postDocument(db, doc, OPTS);
    await postDocument(db, doc, OPTS);
    const n = await db.withTenant(TENANT_A, async (tx) => {
      const r = await tx.query<{ n: string }>(
        `select count(*)::text n from app.posting_exception where source_id = $1`, [doc.sourceId]);
      return Number(r.rows[0]!.n);
    });
    expect(n).toBe(1);
  });

  it('a document dated outside every period is refused, never moved to today', async () => {
    const doc = aSale({ businessDate: '2027-11-30' });
    const result = await postDocument(db, doc, OPTS);
    expect(result.status).toBe('exception');
    if (result.status !== 'exception') throw new Error('unreachable');
    // Falling back to "the current period" would silently move a document
    // into a period it did not happen in.
    expect(result.errorCode).toBe(POSTING_ERROR.noPeriod);
  });
});

describe('…and once the mapping exists, the SAME document posts', () => {
  let doc: ProposedEntry;

  beforeAll(async () => {
    await db.withTenant(TENANT_A, async (tx) => {
      await mapRole(tx, TENANT_A, 'COGS', await account(tx, TENANT_A, { code: '5000', type: 'EXPENSE' }));
      await mapRole(tx, TENANT_A, 'INVENTORY', await account(tx, TENANT_A, { code: '1300', type: 'ASSET', control: 'INVENTORY' }));
      await mapRole(tx, TENANT_A, 'SALES_DISCOUNT', await account(tx, TENANT_A, { code: '4900', type: 'INCOME' }));
      await mapRole(tx, TENANT_A, 'AR_TRADE', await account(tx, TENANT_A, { code: '1400', type: 'ASSET', control: 'AR' }));
      await mapRole(tx, TENANT_A, 'INTERLOC_CLEARING', await account(tx, TENANT_A, { code: '1900', type: 'ASSET' }));
      await mapRole(tx, TENANT_A, 'BANK_CHARGES', await account(tx, TENANT_A, { code: '6100', type: 'EXPENSE' }));
    });
    doc = aSale();
  }, 60_000);

  it('posts, and the entry is balanced and numbered', async () => {
    const result = await postDocument(db, doc, OPTS);
    expect(result.status).toBe('posted');
    if (result.status !== 'posted') throw new Error('unreachable');
    expect(result.entryNo).toBeGreaterThan(0n);

    const header = await db.withTenant(TENANT_A, async (tx) => {
      const r = await tx.query<{
        status: string; debit_total_minor: string; credit_total_minor: string;
        line_count: number; posting_rule_version: number; mapping_set_version: number;
      }>(
        `select status, debit_total_minor::text, credit_total_minor::text, line_count,
                posting_rule_version, mapping_set_version
           from app.journal_entry where id = $1`, [result.journalEntryId]);
      return r.rows[0]!;
    });
    expect(header.status).toBe('posted');
    expect(header.debit_total_minor).toBe(header.credit_total_minor);
    expect(header.line_count).toBe(5); // cash, revenue, tax, COGS, inventory
    // Both halves of the auditor's question — which rules, and which mapping.
    expect(header.posting_rule_version).toBe(1);
    expect(header.mapping_set_version).toBe(1);
  });

  it('the lines land on the tenant’s OWN accounts, with the right amounts', async () => {
    const lines = await entryLines(
      (await db.withTenant(TENANT_A, async (tx) => {
        const r = await tx.query<{ id: string }>(
          `select id from app.journal_entry where source_id = $1`, [doc.sourceId]);
        return r.rows[0]!.id;
      })),
    );
    const by = new Map(lines.map((l) => [l.code, l]));
    expect(by.get('1000')?.debit_minor).toBe('18000'); // till: 15,000 + 3,000 tax
    expect(by.get('4100')?.credit_minor).toBe('15000'); // revenue
    expect(by.get('2200')?.credit_minor).toBe('3000'); // OUTPUT TAX — a liability
    expect(by.get('5000')?.debit_minor).toBe('9000'); // COGS
    expect(by.get('1300')?.credit_minor).toBe('9000'); // inventory
    // The component's own code survives onto the line, so a tax return can be
    // built from the ledger rather than from the sale.
    expect(by.get('2200')?.memo).toBe('GH.VAT.STD');
  });

  it('posting the same document twice is a DUPLICATE, not a second entry', async () => {
    const again = await postDocument(db, doc, OPTS);
    expect(again.status).toBe('duplicate');
    const n = await db.withTenant(TENANT_A, async (tx) => {
      const r = await tx.query<{ n: string }>(
        `select count(*)::text n from app.journal_entry where source_id = $1`, [doc.sourceId]);
      return Number(r.rows[0]!.n);
    });
    expect(n).toBe(1);
  });

  it('a RETRY after the mapping is fixed posts AND resolves the open exception', async () => {
    // The close gate must not hold a period open over a problem that has been
    // fixed and retried.
    const late = aSale({ saleId: uuidv7() });
    // Break it first: an unmapped category-scoped role is not needed here, so
    // use a date with no period, then move it into one.
    const broken = { ...late, documentDate: '2027-11-30' };
    const first = await postDocument(db, broken, OPTS);
    expect(first.status).toBe('exception');

    const fixed = { ...late, documentDate: '2026-08-15' };
    const second = await postDocument(db, fixed, OPTS);
    expect(second.status).toBe('posted');

    const open = await db.withTenant(TENANT_A, async (tx) => {
      const r = await tx.query<{ n: string; note: string | null }>(
        `select count(*)::text n, max(resolution_note) note
           from app.posting_exception
          where source_id = $1 and resolved_at is null`, [late.sourceId]);
      return r.rows[0]!;
    });
    expect(Number(open.n)).toBe(0);
  });
});

describe('rule 4 through the engine — the AR clears where the obligation lives', () => {
  it('a payment taken at one outlet against another’s invoice posts four lines', async () => {
    const doc = paymentEntry({
      paymentId: uuidv7(), businessDate: '2026-08-20',
      receivingLocationId: sunyani, obligationLocationId: techiman,
      customerId: CUSTOMER, amountMinor: 500_000n, instrument: 'CASH',
    });
    const result = await postDocument(db, doc, OPTS);
    expect(result.status).toBe('posted');
    if (result.status !== 'posted') throw new Error('unreachable');

    const lines = await entryLines(result.journalEntryId);
    expect(lines).toHaveLength(4);

    const ar = lines.filter((l) => l.code === '1400');
    expect(ar).toHaveLength(1);
    // In the DATABASE, not merely in the rule's output: the receivable is
    // credited at Techiman, where the contractor actually bought.
    expect(ar[0]!.location_id).toBe(techiman);
    expect(ar[0]!.credit_minor).toBe('500000');
    expect(ar[0]!.counterparty_id).toBe(CUSTOMER);

    const till = lines.filter((l) => l.code === '1000');
    expect(till[0]!.location_id).toBe(sunyani);

    // Σ INTERLOC_CLEARING is zero across the entry, read back from Postgres.
    const clearing = lines.filter((l) => l.code === '1900');
    const net = clearing.reduce(
      (a, l) => a + BigInt(l.debit_minor) - BigInt(l.credit_minor), 0n);
    expect(net).toBe(0n);
  });
});

describe('tenant isolation on the posting path — §2.7 category 3', () => {
  it('posting for tenant B writes nothing into tenant A, and cannot see A’s accounts', async () => {
    // B has no calendar and no mappings, so its document cannot post — which
    // is itself the assertion: A's mappings are invisible to it. If mappings
    // leaked, B would post against A's accounts.
    const bLocation = await db.withTenant(TENANT_B, (tx) => makeLocation(tx, TENANT_B, { code: 'ENG-B1' }));
    const doc = saleWith({
      saleId: uuidv7(), locationId: bLocation, businessDate: '2026-08-15', tender: 'CASH',
      revenueMinor: 1_000n, discountMinor: 0n, taxes: [], costMinor: 0n,
    });
    const result = await postDocument(db, doc, {
      tenantId: TENANT_B, postedBy: POSTER, postingRuleVersion: 1,
    });
    expect(result.status).toBe('exception');
    if (result.status !== 'exception') throw new Error('unreachable');
    expect(result.errorCode).toBe(POSTING_ERROR.noPeriod);

    // Positive control: give B its OWN calendar and mappings and it posts —
    // proving the refusal above was isolation, not a broken fixture.
    await db.withTenant(TENANT_B, async (tx) => {
      await calendar(tx, TENANT_B);
      await mapRole(tx, TENANT_B, 'TILL_CASH', await account(tx, TENANT_B, { code: '1000', type: 'ASSET', control: 'TILL' }));
      await mapRole(tx, TENANT_B, 'SALES_REVENUE', await account(tx, TENANT_B, { code: '4100', type: 'INCOME' }));
    });
    const retry = await postDocument(db, doc, {
      tenantId: TENANT_B, postedBy: POSTER, postingRuleVersion: 1,
    });
    expect(retry.status).toBe('posted');

    // And A's ledger is untouched by any of it.
    const aHasB = await db.withTenant(TENANT_A, async (tx) => {
      const r = await tx.query<{ n: string }>(
        `select count(*)::text n from app.journal_entry where source_id = $1`, [doc.sourceId]);
      return Number(r.rows[0]!.n);
    });
    expect(aHasB).toBe(0);
  });
});
