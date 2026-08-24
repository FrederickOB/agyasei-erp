/**
 * THE LEDGER'S MECHANISM — what the DATABASE refuses.
 *
 * Phase 3 Track A (docs/phase2-gate.md §4.3): the journal, exercised against
 * accounts **invented by these tests**. There are no seeded accounts anywhere
 * in the product and there must not be until §2.8's accountant review has
 * happened — so every account below is created here, by name, for one test.
 *
 * §2.7 puts this in two mandatory categories at once: it touches money, and
 * `journal_line` is a read path that could cross a tenant boundary.
 *
 * What makes these worth anything: **not one assertion trusts the application
 * layer.** Every insert below is raw SQL against real Postgres with the real
 * migrations, and every refusal is Postgres refusing. A ledger whose balance
 * rule lives in TypeScript is a ledger that is balanced until somebody opens
 * psql.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/ids.js';
import type { Queryable, TestDb } from '../src/testing/harness.js';
import { makeLocation } from './rbac-fixtures.js';
import { setupDb, setupTwoTenants, TENANT_A, TENANT_B } from './util.js';

let db: TestDb;
let locA1: string;
let locA2: string;
let locB1: string;
/** Accounts invented for these tests. Never a chart of accounts. */
let cash: string;
let revenue: string;
let rollup: string;
const FY = 'FY-TEST';
let periodA: string;
let periodB: string;

async function makeAccount(
  tx: Queryable,
  tenantId: string,
  spec: { code: string; type: string; postable?: boolean; parent?: string | null },
): Promise<string> {
  const id = uuidv7();
  const normal = spec.type === 'ASSET' || spec.type === 'EXPENSE' ? 'D' : 'C';
  await tx.query(
    `insert into app.gl_account
       (tenant_id, id, code, name, account_type, normal_balance, parent_account_id,
        is_postable, report_line_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [tenantId, id, spec.code, `Test ${spec.code}`, spec.type, normal,
     spec.parent ?? null, spec.postable ?? true, `line:${spec.code}`],
  );
  return id;
}

async function makeCalendar(tx: Queryable, tenantId: string): Promise<string> {
  await tx.query(
    `insert into app.fiscal_year (tenant_id, fy_code, starts_on, ends_on)
     values ($1, $2, '2026-08-01', '2027-07-31')`,
    [tenantId, FY],
  );
  await tx.query(
    `insert into app.gl_counter (tenant_id, fy_code) values ($1, $2)`,
    [tenantId, FY],
  );
  const periodId = uuidv7();
  await tx.query(
    `insert into app.accounting_period (tenant_id, id, fy_code, seq, starts_on, ends_on)
     values ($1, $2, $3, 1, '2026-08-01', '2026-08-31')`,
    [tenantId, periodId, FY],
  );
  return periodId;
}

interface LineSpec {
  account: string;
  location: string;
  debit?: bigint;
  credit?: bigint;
}

/** Write a DRAFT entry with its lines. Posting is a separate, explicit step. */
async function draft(
  tx: Queryable,
  tenantId: string,
  periodId: string,
  lines: readonly LineSpec[],
  opts: { sourceKind?: string; sourceId?: string | null; key?: string } = {},
): Promise<string> {
  const id = uuidv7();
  await tx.query(
    `insert into app.journal_entry
       (tenant_id, id, entry_no, period_id, fy_code, document_date, status,
        source_kind, source_id, idempotency_key, posting_rule_version,
        mapping_set_version, created_by)
     values ($1, $2, nextval_stub(), $3, $4, '2026-08-15', 'draft', $5, $6, $7, 1, 1, $8)`
      .replace('nextval_stub()', `(select next_no from app.gl_counter where tenant_id = $1 and fy_code = $4)`),
    [tenantId, id, periodId, FY, opts.sourceKind ?? 'manual', opts.sourceId ?? null,
     opts.key ?? id, uuidv7()],
  );
  await tx.query(
    `update app.gl_counter set next_no = next_no + 1 where tenant_id = $1 and fy_code = $2`,
    [tenantId, FY],
  );
  let n = 0;
  for (const l of lines) {
    n += 1;
    await tx.query(
      `insert into app.journal_line
         (tenant_id, journal_entry_id, line_no, account_id, location_id,
          debit_minor, credit_minor, currency_code)
       values ($1, $2, $3, $4, $5, $6, $7, 'GHS')`,
      [tenantId, id, n, l.account, l.location,
       (l.debit ?? 0n).toString(10), (l.credit ?? 0n).toString(10)],
    );
  }
  return id;
}

async function post(tx: Queryable, tenantId: string, entryId: string): Promise<void> {
  await tx.query(
    `update app.journal_entry
        set status = 'posted', posted_at = transaction_timestamp()
      where tenant_id = $1 and id = $2`,
    [tenantId, entryId],
  );
}

beforeAll(async () => {
  db = await setupDb();
  await setupTwoTenants(db);
  await db.withTenant(TENANT_A, async (tx) => {
    locA1 = await makeLocation(tx, TENANT_A, { code: 'GL-A1' });
    locA2 = await makeLocation(tx, TENANT_A, { code: 'GL-A2' });
    periodA = await makeCalendar(tx, TENANT_A);
    rollup = await makeAccount(tx, TENANT_A, { code: '4000', type: 'INCOME', postable: false });
    cash = await makeAccount(tx, TENANT_A, { code: '1100', type: 'ASSET' });
    revenue = await makeAccount(tx, TENANT_A, { code: '4100', type: 'INCOME', parent: rollup });
  });
  await db.withTenant(TENANT_B, async (tx) => {
    locB1 = await makeLocation(tx, TENANT_B, { code: 'GL-B1' });
    periodB = await makeCalendar(tx, TENANT_B);
  });
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe('a balanced entry posts, and that is the positive control for everything below', () => {
  it('two lines, equal debit and credit, at one location', async () => {
    const id = await db.withTenant(TENANT_A, async (tx) => {
      const e = await draft(tx, TENANT_A, periodA, [
        { account: cash, location: locA1, debit: 18_000n },
        { account: revenue, location: locA1, credit: 18_000n },
      ]);
      await post(tx, TENANT_A, e);
      return e;
    });

    const row = await db.withTenant(TENANT_A, async (tx) => {
      const r = await tx.query<{
        status: string; debit_total_minor: string; credit_total_minor: string; line_count: number;
      }>(
        `select status, debit_total_minor::text, credit_total_minor::text, line_count
           from app.journal_entry where id = $1`,
        [id],
      );
      return r.rows[0]!;
    });
    // The header aggregates were maintained by trigger, not by the caller.
    expect(row.status).toBe('posted');
    expect(row.debit_total_minor).toBe('18000');
    expect(row.credit_total_minor).toBe('18000');
    expect(row.line_count).toBe(2);
  });
});

describe('balance, enforced twice and failing differently', () => {
  it('an UNBALANCED entry cannot be posted — the header CHECK refuses it', async () => {
    await expect(
      db.withTenant(TENANT_A, async (tx) => {
        const e = await draft(tx, TENANT_A, periodA, [
          { account: cash, location: locA1, debit: 18_000n },
          { account: revenue, location: locA1, credit: 17_999n },
        ]);
        await post(tx, TENANT_A, e);
      }),
    ).rejects.toThrow(/je_posted_balanced/);
  });

  it('a ONE-LINE entry cannot be posted — double entry needs two sides', async () => {
    await expect(
      db.withTenant(TENANT_A, async (tx) => {
        const e = await draft(tx, TENANT_A, periodA, [
          { account: cash, location: locA1, debit: 500n },
        ]);
        await post(tx, TENANT_A, e);
      }),
    ).rejects.toThrow(/je_posted_balanced/);
  });

  it('an entry balanced IN TOTAL but not PER LOCATION is refused at COMMIT', async () => {
    // The one the header cannot see. Debits and credits agree across the
    // entry, so `je_posted_balanced` is satisfied — and a consolidated balance
    // sheet would balance while both per-location ones did not, which is
    // precisely what the location dimension exists to prevent (05 §5.5.3).
    await expect(
      db.withTenant(TENANT_A, async (tx) => {
        const e = await draft(tx, TENANT_A, periodA, [
          { account: cash, location: locA1, debit: 18_000n },
          { account: revenue, location: locA2, credit: 18_000n },
        ]);
        await post(tx, TENANT_A, e);
      }),
    ).rejects.toThrow(/GL0001.*unbalanced at location/s);
  });

  it('…and the SAME entry with inter-location lines added DOES post — the control', async () => {
    // Proves the refusal above is about balance per location, not about an
    // entry touching two locations at all.
    const clearing = await db.withTenant(TENANT_A, (tx) =>
      makeAccount(tx, TENANT_A, { code: '1900', type: 'ASSET' }),
    );
    const id = await db.withTenant(TENANT_A, async (tx) => {
      const e = await draft(tx, TENANT_A, periodA, [
        { account: cash, location: locA1, debit: 18_000n },
        { account: clearing, location: locA1, credit: 18_000n },
        { account: clearing, location: locA2, debit: 18_000n },
        { account: revenue, location: locA2, credit: 18_000n },
      ]);
      await post(tx, TENANT_A, e);
      return e;
    });
    expect(id).toBeTruthy();
  });

  it('TAMPERED header totals are caught at COMMIT even though the CHECK passes', async () => {
    // Mechanism A's CHECK tests a DERIVED column, and derived columns can lie.
    // Here the header is edited directly WHILE THE ENTRY IS STILL A DRAFT —
    // which immutability permits, because a draft is not the ledger — to claim
    // totals its lines do not support. `je_posted_balanced` is then satisfied
    // on posting (999 = 999, two lines, non-zero) and the entry would post
    // with a header that does not describe itself.
    //
    // Mechanism B recomputes from the lines at COMMIT and refuses.
    await expect(
      db.withTenant(TENANT_A, async (tx) => {
        const e = await draft(tx, TENANT_A, periodA, [
          { account: cash, location: locA1, debit: 500n },
          { account: revenue, location: locA1, credit: 500n },
        ]);
        await tx.query(
          `update app.journal_entry
              set debit_total_minor = 999, credit_total_minor = 999, line_count = 2
            where id = $1`,
          [e],
        );
        await post(tx, TENANT_A, e);
      }),
    ).rejects.toThrow(/GL0002/);
  });

  it('…and the same entry with an HONEST header posts — the control', async () => {
    const id = await db.withTenant(TENANT_A, async (tx) => {
      const e = await draft(tx, TENANT_A, periodA, [
        { account: cash, location: locA1, debit: 500n },
        { account: revenue, location: locA1, credit: 500n },
      ]);
      await post(tx, TENANT_A, e);
      return e;
    });
    expect(id).toBeTruthy();
  });
});

describe('a line is one side of an entry, and the database says so', () => {
  it('a line with BOTH debit and credit is refused', async () => {
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        draft(tx, TENANT_A, periodA, [
          { account: cash, location: locA1, debit: 100n, credit: 100n },
          { account: revenue, location: locA1, credit: 100n },
        ]),
      ),
    ).rejects.toThrow(/jl_one_side/);
  });

  it('a line with NEITHER is refused — a zero line carries no information', async () => {
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        draft(tx, TENANT_A, periodA, [{ account: cash, location: locA1 }]),
      ),
    ).rejects.toThrow(/jl_one_side/);
  });

  it('a ROLLUP account cannot receive a line — enforced by foreign key, not a trigger', async () => {
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        draft(tx, TENANT_A, periodA, [
          { account: rollup, location: locA1, debit: 100n },
          { account: cash, location: locA1, credit: 100n },
        ]),
      ),
    ).rejects.toThrow(/journal_line_tenant_id_account_id_account_postable_fkey|foreign key/i);
  });

  it('an account WITH POSTED LINES cannot be turned into a rollup', async () => {
    // The pleasing side-effect of doing this with a composite FK: flipping
    // is_postable removes the referenced key, so the FK refuses.
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(`update app.gl_account set is_postable = false where id = $1`, [cash]),
      ),
    ).rejects.toThrow(/foreign key|still referenced/i);
  });

  it('a line must carry the TENANT’S ledger currency, not one it names itself', async () => {
    await expect(
      db.withTenant(TENANT_A, async (tx) => {
        const e = uuidv7();
        await tx.query(
          `insert into app.journal_entry
             (tenant_id, id, entry_no, period_id, fy_code, document_date, status,
              source_kind, idempotency_key, posting_rule_version, mapping_set_version, created_by)
           values ($1, $2, 8001, $3, $4, '2026-08-15', 'draft', 'manual', $5, 1, 1, $6)`,
          [TENANT_A, e, periodA, FY, e, uuidv7()],
        );
        await tx.query(
          `insert into app.journal_line
             (tenant_id, journal_entry_id, line_no, account_id, location_id,
              debit_minor, credit_minor, currency_code)
           values ($1, $2, 1, $3, $4, 100, 0, 'USD')`,
          [TENANT_A, e, cash, locA1],
        );
      }),
    ).rejects.toThrow(/GL0005/);
  });
});

describe('immutability — corrections are reversing entries, never edits', () => {
  let posted: string;

  beforeAll(async () => {
    posted = await db.withTenant(TENANT_A, async (tx) => {
      const e = await draft(tx, TENANT_A, periodA, [
        { account: cash, location: locA1, debit: 4_200n },
        { account: revenue, location: locA1, credit: 4_200n },
      ]);
      await post(tx, TENANT_A, e);
      return e;
    });
  }, 60_000);

  it('a posted entry cannot be edited', async () => {
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(`update app.journal_entry set memo = 'fixing a typo' where id = $1`, [posted]),
      ),
    ).rejects.toThrow(/GL0022/);
  });

  it('a posted entry cannot be deleted', async () => {
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(`delete from app.journal_entry where id = $1`, [posted]),
      ),
    ).rejects.toThrow(/GL0020/);
  });

  it('a posted LINE cannot be edited or deleted', async () => {
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(`update app.journal_line set debit_minor = 1 where journal_entry_id = $1 and line_no = 1`, [posted]),
      ),
    ).rejects.toThrow(/GL0024/);
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(`delete from app.journal_line where journal_entry_id = $1`, [posted]),
      ),
    ).rejects.toThrow(/GL0024/);
  });

  it('a DRAFT entry and its lines can still be discarded — the positive control', async () => {
    const gone = await db.withTenant(TENANT_A, async (tx) => {
      const e = await draft(tx, TENANT_A, periodA, [
        { account: cash, location: locA1, debit: 7n },
        { account: revenue, location: locA1, credit: 7n },
      ]);
      await tx.query(`delete from app.journal_entry where id = $1`, [e]);
      const r = await tx.query<{ n: string }>(
        `select count(*)::text n from app.journal_line where journal_entry_id = $1`, [e]);
      return r.rows[0]!.n;
    });
    expect(gone).toBe('0');
  });

  it('recording a reversal on the original is permitted — once', async () => {
    const reversal = await db.withTenant(TENANT_A, async (tx) => {
      const r = await draft(tx, TENANT_A, periodA, [
        { account: revenue, location: locA1, debit: 4_200n },
        { account: cash, location: locA1, credit: 4_200n },
      ]);
      await tx.query(`update app.journal_entry set reverses_entry_id = $2 where id = $1`, [r, posted]);
      await post(tx, TENANT_A, r);
      await tx.query(`update app.journal_entry set reversed_by_entry_id = $2 where id = $1`, [posted, r]);
      return r;
    });
    expect(reversal).toBeTruthy();

    // A SECOND reversal of the same entry is refused by the partial unique index.
    await expect(
      db.withTenant(TENANT_A, async (tx) => {
        const r2 = await draft(tx, TENANT_A, periodA, [
          { account: revenue, location: locA1, debit: 4_200n },
          { account: cash, location: locA1, credit: 4_200n },
        ]);
        await tx.query(`update app.journal_entry set reverses_entry_id = $2 where id = $1`, [r2, posted]);
      }),
    ).rejects.toThrow(/je_one_reversal|duplicate key/i);
  });
});

describe('one entry per document, and a counter that only moves forward', () => {
  it('a second entry for the SAME source document is refused', async () => {
    const sourceId = uuidv7();
    await db.withTenant(TENANT_A, async (tx) => {
      const e = await draft(tx, TENANT_A, periodA,
        [{ account: cash, location: locA1, debit: 10n },
         { account: revenue, location: locA1, credit: 10n }],
        { sourceKind: 'cash_sale', sourceId });
      await post(tx, TENANT_A, e);
    });
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        draft(tx, TENANT_A, periodA,
          [{ account: cash, location: locA1, debit: 10n },
           { account: revenue, location: locA1, credit: 10n }],
          { sourceKind: 'cash_sale', sourceId }),
      ),
    ).rejects.toThrow(/je_one_per_source|duplicate key/i);
  });

  it('the entry-number counter cannot rewind', async () => {
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(`update app.gl_counter set next_no = 1 where tenant_id = $1 and fy_code = $2`,
          [TENANT_A, FY]),
      ),
    ).rejects.toThrow(/GL0013/);
  });
});

describe('the calendar cannot be ambiguous', () => {
  it('two periods covering the same day are refused', async () => {
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(
          `insert into app.accounting_period (tenant_id, id, fy_code, seq, starts_on, ends_on)
           values ($1, $2, $3, 2, '2026-08-15', '2026-09-15')`,
          [TENANT_A, uuidv7(), FY],
        ),
      ),
    ).rejects.toThrow(/GL0011/);
  });

  it('a period outside its own fiscal year is refused', async () => {
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(
          `insert into app.accounting_period (tenant_id, id, fy_code, seq, starts_on, ends_on)
           values ($1, $2, $3, 3, '2027-08-01', '2027-08-31')`,
          [TENANT_A, uuidv7(), FY],
        ),
      ),
    ).rejects.toThrow(/GL0012/);
  });

  it('a period that fits, and does not overlap, is accepted — the control', async () => {
    const ok = await db.withTenant(TENANT_A, async (tx) => {
      const id = uuidv7();
      await tx.query(
        `insert into app.accounting_period (tenant_id, id, fy_code, seq, starts_on, ends_on)
         values ($1, $2, $3, 4, '2026-09-01', '2026-09-30')`,
        [TENANT_A, id, FY],
      );
      return id;
    });
    expect(ok).toBeTruthy();
  });
});

describe('tenant isolation — §2.7 category 3, on every ledger read path', () => {
  it('tenant B sees none of tenant A’s entries or lines, and has its own', async () => {
    const bEntry = await db.withTenant(TENANT_B, async (tx) => {
      const bCash = await makeAccount(tx, TENANT_B, { code: '1100', type: 'ASSET' });
      const bRev = await makeAccount(tx, TENANT_B, { code: '4100', type: 'INCOME' });
      const e = await draft(tx, TENANT_B, periodB, [
        { account: bCash, location: locB1, debit: 999n },
        { account: bRev, location: locB1, credit: 999n },
      ]);
      await post(tx, TENANT_B, e);
      return e;
    });

    const seen = await db.withTenant(TENANT_B, async (tx) => {
      const entries = await tx.query<{ id: string }>(`select id from app.journal_entry`);
      const lines = await tx.query<{ n: string }>(`select count(*)::text n from app.journal_line`);
      const accounts = await tx.query<{ n: string }>(`select count(*)::text n from app.gl_account`);
      return {
        ids: entries.rows.map((r) => r.id),
        lines: Number(lines.rows[0]!.n),
        accounts: Number(accounts.rows[0]!.n),
      };
    });

    // Positive control first: B's own ledger is non-empty, so an absence of
    // A's rows below is isolation and not an empty database.
    expect(seen.ids).toContain(bEntry);
    expect(seen.lines).toBe(2);
    expect(seen.accounts).toBe(2);

    // Tenant A's real entry ids, read as admin so the comparison is against
    // rows that genuinely exist rather than against an empty list.
    const aIds = await db.asAdmin(async (tx) => {
      const r = await tx.query<{ id: string }>(
        `select id from app.journal_entry where tenant_id = $1`, [TENANT_A]);
      return r.rows.map((x) => x.id);
    });
    expect(aIds.length).toBeGreaterThan(0);
    for (const id of aIds) expect(seen.ids).not.toContain(id);
  });

  it('a journal line cannot reference ANOTHER tenant’s account, FK before RLS', async () => {
    // The composite FK is on (tenant_id, account_id, is_postable), so tenant
    // B naming tenant A's account id does not resolve — independently of RLS
    // (ADR-0005: "enforce this structurally").
    await expect(
      db.withTenant(TENANT_B, async (tx) => {
        const e = uuidv7();
        await tx.query(
          `insert into app.journal_entry
             (tenant_id, id, entry_no, period_id, fy_code, document_date, status,
              source_kind, idempotency_key, posting_rule_version, mapping_set_version, created_by)
           values ($1, $2, 7001, $3, $4, '2026-08-15', 'draft', 'manual', $5, 1, 1, $6)`,
          [TENANT_B, e, periodB, FY, e, uuidv7()],
        );
        await tx.query(
          `insert into app.journal_line
             (tenant_id, journal_entry_id, line_no, account_id, location_id,
              debit_minor, credit_minor, currency_code)
           values ($1, $2, 1, $3, $4, 100, 0, 'GHS')`,
          [TENANT_B, e, cash, locB1],
        );
      }),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it('a journal line cannot reference another tenant’s LOCATION either', async () => {
    await expect(
      db.withTenant(TENANT_B, async (tx) => {
        const bCash = await makeAccount(tx, TENANT_B, { code: '1101', type: 'ASSET' });
        const e = uuidv7();
        await tx.query(
          `insert into app.journal_entry
             (tenant_id, id, entry_no, period_id, fy_code, document_date, status,
              source_kind, idempotency_key, posting_rule_version, mapping_set_version, created_by)
           values ($1, $2, 7002, $3, $4, '2026-08-15', 'draft', 'manual', $5, 1, 1, $6)`,
          [TENANT_B, e, periodB, FY, e, uuidv7()],
        );
        await tx.query(
          `insert into app.journal_line
             (tenant_id, journal_entry_id, line_no, account_id, location_id,
              debit_minor, credit_minor, currency_code)
           values ($1, $2, 1, $3, $4, 100, 0, 'GHS')`,
          [TENANT_B, e, bCash, locA1],
        );
      }),
    ).rejects.toThrow(/foreign key|violates/i);
  });
});
