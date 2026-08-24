/**
 * BANK AND MOBILE MONEY RECONCILIATION — the control that must be able to
 * disagree with the ledger.
 *
 * §2.8 makes this required because it is the only routine check that compares
 * the books against a document this system did not produce. Everything else in
 * this repository is the ledger agreeing with itself, which it will do
 * flawlessly while being wrong.
 *
 * Two things are therefore under test that are easy to skip:
 *   1. auto-matching REFUSES when it is not sure — a confident wrong match
 *      closes the very difference that was the evidence;
 *   2. the close gate NAMES what is blocking it, and cannot be talked round.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/ids.js';
import {
  closeBlockers, monthlyView, proposeMatches,
  type BookLine, type StatementLine,
} from '../src/reconciliation/reconcile.js';
import type { Queryable, TestDb } from '../src/testing/harness.js';
import { makeLocation } from './rbac-fixtures.js';
import { setupDb, setupTwoTenants, TENANT_A, TENANT_B } from './util.js';

let db: TestDb;
let outlet: string;
let bankAccountId: string;
let cashAccountId: string;
let periodId: string;
const IMPORTER = '018f0000-0000-8000-8000-0000000000ee';
const FY = 'FY27';

function line(over: Partial<StatementLine> = {}): StatementLine {
  return {
    id: uuidv7(), lineNo: 1, valueDate: '2026-08-15',
    description: 'DEPOSIT', reference: 'DEP-004312',
    amountMinor: 250_000n, direction: 'I', ...over,
  };
}

function book(over: Partial<BookLine> = {}): BookLine {
  return {
    journalEntryId: uuidv7(), lineNo: 1, documentDate: '2026-08-15',
    memo: null, netDebitMinor: 250_000n, reference: 'DEP-004312', ...over,
  };
}

beforeAll(async () => {
  db = await setupDb();
  await setupTwoTenants(db);
  await db.withTenant(TENANT_A, async (tx) => {
    outlet = await makeLocation(tx, TENANT_A, { code: 'REC-01' });
    bankAccountId = uuidv7();
    await tx.query(
      `insert into app.gl_account (tenant_id, id, code, name, account_type, normal_balance,
                                   is_postable, control_account_kind, report_line_key)
       values ($1,$2,'1200','Bank','ASSET','D',true,'BANK','line:1200')`,
      [TENANT_A, bankAccountId],
    );
    cashAccountId = uuidv7();
    await tx.query(
      `insert into app.cash_account (tenant_id, id, account_id, kind, provider, location_id,
                                     opening_balance_minor, opening_as_of)
       values ($1,$2,$3,'BANK','A Bank',$4,0,'2026-08-01')`,
      [TENANT_A, cashAccountId, bankAccountId, outlet],
    );
    periodId = uuidv7();
    await tx.query(
      `insert into app.fiscal_year (tenant_id, fy_code, starts_on, ends_on)
       values ($1,$2,'2026-08-01','2027-07-31')`, [TENANT_A, FY]);
    await tx.query(
      `insert into app.accounting_period (tenant_id, id, fy_code, seq, starts_on, ends_on)
       values ($1,$2,$3,1,'2026-08-01','2026-08-31')`, [TENANT_A, periodId, FY]);
  });
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe('a momo wallet is a cash account, not a payment method', () => {
  it('reconciles through the identical workflow as a bank account', async () => {
    const wallet = await db.withTenant(TENANT_A, async (tx) => {
      const gl = uuidv7();
      await tx.query(
        `insert into app.gl_account (tenant_id, id, code, name, account_type, normal_balance,
                                     is_postable, control_account_kind, report_line_key)
         values ($1,$2,'1250','Momo float','ASSET','D',true,'MOMO','line:1250')`,
        [TENANT_A, gl],
      );
      const id = uuidv7();
      await tx.query(
        `insert into app.cash_account (tenant_id, id, account_id, kind, provider, location_id,
                                       opening_balance_minor, opening_as_of)
         values ($1,$2,$3,'MOMO','An MNO',$4,0,'2026-08-01')`,
        [TENANT_A, id, gl, outlet],
      );
      return id;
    });
    // Same function, same shape, no special case anywhere.
    const view = await db.withTenant(TENANT_A, (tx) => monthlyView(tx, wallet, '2026-08-31'));
    expect(view.cashAccountId).toBe(wallet);
    expect(view.unexplainedMinor).toBe(0n);
  });
});

describe('auto-matching refuses when it is not sure', () => {
  it('matches on amount AND date AND reference — the positive control', () => {
    const s = line();
    const b = book();
    const proposals = proposeMatches([s], [b]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.statementLineId).toBe(s.id);
    expect(proposals[0]!.journalEntryId).toBe(b.journalEntryId);
  });

  it('AMOUNT ALONE NEVER MATCHES — the rule this business needs most', () => {
    // Bagged cement at a fixed price means identical amounts on the same day
    // are routine. A confident wrong match closes the difference that was the
    // only evidence anything was wrong.
    const s = line({ reference: null });
    const b = book({ reference: null });
    expect(proposeMatches([s], [b])).toHaveLength(0);
  });

  it('…and neither does amount + date with a DIFFERENT reference', () => {
    expect(proposeMatches([line()], [book({ reference: 'DEP-999999' })])).toHaveLength(0);
  });

  it('an AMBIGUOUS match is no match — two candidates means the reference is not discriminating', () => {
    const s = line();
    const twins = [book(), book()]; // same amount, same date, same reference
    expect(proposeMatches([s], twins)).toHaveLength(0);
  });

  it('a date outside the window does not match', () => {
    expect(proposeMatches([line()], [book({ documentDate: '2026-08-25' })], { dateWindowDays: 3 }))
      .toHaveLength(0);
  });

  it('DIRECTION IS NOT INTERCHANGEABLE — the classic reconciliation error', () => {
    // The bank says "credit" for money arriving; our ledger DEBITS the cash
    // account for the same event. They are opposites from the account
    // holder's side, and treating them as the same word is the mistake this
    // signature exists to make impossible.
    const inbound = line({ direction: 'I' });
    const bookCredit = book({ netDebitMinor: -250_000n });
    expect(proposeMatches([inbound], [bookCredit])).toHaveLength(0);

    // …and the correct pairing does match.
    const outbound = line({ direction: 'O' });
    expect(proposeMatches([outbound], [bookCredit])).toHaveLength(1);
  });

  it('one book line is never proposed against two statement lines', () => {
    const b = book();
    const two = [line({ id: uuidv7() }), line({ id: uuidv7(), lineNo: 2 })];
    expect(proposeMatches(two, [b])).toHaveLength(1);
  });
});

describe('the monthly view names what sits between the bank and the books', () => {
  it('an unmatched statement line shows up, and shows up as unexplained', async () => {
    const statementId = await db.withTenant(TENANT_A, async (tx) => {
      const id = uuidv7();
      await tx.query(
        `insert into app.bank_statement (tenant_id, id, cash_account_id, period_start, period_end,
                                         opening_balance_minor, closing_balance_minor, source, imported_by)
         values ($1,$2,$3,'2026-08-01','2026-08-31',0,40000,'csv',$4)`,
        [TENANT_A, id, cashAccountId, IMPORTER],
      );
      // A bank charge nobody has booked yet: on the statement, not in the books.
      await tx.query(
        `insert into app.bank_statement_line (tenant_id, id, statement_id, line_no, value_date,
                                              description, reference, amount_minor, direction)
         values ($1,$2,$3,1,'2026-08-20','SERVICE CHARGE','CHG-1',40000,'I')`,
        [TENANT_A, uuidv7(), id],
      );
      return id;
    });
    expect(statementId).toBeTruthy();

    const view = await db.withTenant(TENANT_A, (tx) => monthlyView(tx, cashAccountId, '2026-08-31'));
    expect(view.statementClosingMinor).toBe(40_000n);
    expect(view.unmatchedStatementLines).toBe(1);
    expect(view.statementItemsNotInBooksMinor).toBe(40_000n);
    // Nothing is in the books at all, so the difference is the whole charge —
    // which is exactly the signal: 40,000 the bank knows about and we do not.
    expect(view.ledgerBalanceMinor).toBe(0n);
    expect(view.unexplainedMinor).toBe(80_000n);
  });
});

describe('the close gate refuses, and says why', () => {
  it('blocks on the unexplained difference and names the account', async () => {
    const blockers = await db.withTenant(TENANT_A, (tx) =>
      closeBlockers(tx, periodId, '2026-08-31'));
    const unexplained = blockers.find((b) => b.code === 'UNEXPLAINED_DIFFERENCE');
    expect(unexplained).toBeDefined();
    expect(unexplained!.detail).toContain(cashAccountId);
  });

  it('blocks on an open posting exception — a settled document with no entry', async () => {
    await db.withTenant(TENANT_A, (tx) =>
      tx.query(
        `insert into app.posting_exception (tenant_id, id, source_kind, source_id, location_id,
                                            document_date, error_code, severity)
         values ($1,$2,'cash_sale',$3,$4,'2026-08-15','GL_MAPPING_MISSING',1)`,
        [TENANT_A, uuidv7(), uuidv7(), outlet],
      ));
    const blockers = await db.withTenant(TENANT_A, (tx) =>
      closeBlockers(tx, periodId, '2026-08-31'));
    expect(blockers.some((b) => b.code === 'OPEN_POSTING_EXCEPTION')).toBe(true);
  });

  it('returns EVERY blocker, not the first — a month-end is not a queue', async () => {
    const blockers = await db.withTenant(TENANT_A, (tx) =>
      closeBlockers(tx, periodId, '2026-08-31'));
    expect(blockers.length).toBeGreaterThan(1);
    expect(new Set(blockers.map((b) => b.code)).size).toBeGreaterThan(1);
  });

  it('a clean tenant has NO blockers — the control that makes the rest meaningful', async () => {
    // Without this, every assertion above would pass on a function that
    // returned a blocker unconditionally.
    const blockers = await db.withTenant(TENANT_B, (tx) =>
      closeBlockers(tx, periodId, '2026-08-31'));
    expect(blockers).toEqual([]);
  });
});

describe('reconciliation cannot edit the ledger — §5.7.2, the whole point', () => {
  it('exports no function that writes to a journal table', async () => {
    // Read the module's own source. A "no write path" claim asserted in a
    // comment is a claim; asserted against the file, it is a check that fails
    // the day somebody adds one.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../src/reconciliation/reconcile.ts', import.meta.url)),
      'utf8',
    );
    expect(src).not.toMatch(/update\s+app\.journal_/i);
    expect(src).not.toMatch(/insert\s+into\s+app\.journal_/i);
    expect(src).not.toMatch(/delete\s+from\s+app\.journal_/i);
  });

  it('…and the database refuses the edit anyway, if anything ever tried', async () => {
    // Belt and braces: the GL's immutability guard (migration 0015) is what
    // actually stops it, and it is ENABLE ALWAYS.
    const entryId = await db.withTenant(TENANT_A, async (tx) => {
      const id = uuidv7();
      await tx.query(`insert into app.gl_counter (tenant_id, fy_code) values ($1,$2)
                      on conflict do nothing`, [TENANT_A, FY]);
      await tx.query(
        `insert into app.journal_entry (tenant_id, id, entry_no, period_id, fy_code, document_date,
                                        status, source_kind, idempotency_key, posting_rule_version,
                                        mapping_set_version, created_by)
         values ($1,$2,900,$3,$4,'2026-08-15','draft','manual',$5,1,1,$6)`,
        [TENANT_A, id, periodId, FY, id, IMPORTER],
      );
      for (const [n, dr, cr] of [[1, 500, 0], [2, 0, 500]] as const) {
        await tx.query(
          `insert into app.journal_line (tenant_id, journal_entry_id, line_no, account_id,
                                         location_id, debit_minor, credit_minor, currency_code)
           values ($1,$2,$3,$4,$5,$6,$7,'GHS')`,
          [TENANT_A, id, n, bankAccountId, outlet, dr, cr],
        );
      }
      await tx.query(
        `update app.journal_entry set status='posted', posted_at=transaction_timestamp() where id=$1`,
        [id]);
      return id;
    });

    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(`update app.journal_line set debit_minor = 1 where journal_entry_id = $1 and line_no = 1`,
          [entryId])),
    ).rejects.toThrow(/GL0024/);
  });
});

describe('tenant isolation on reconciliation — §2.7 category 3', () => {
  it('tenant B sees none of A’s cash accounts, statements or matches', async () => {
    const seen = await db.withTenant(TENANT_B, async (tx) => {
      const a = await tx.query<{ n: string }>(`select count(*)::text n from app.cash_account`);
      const s = await tx.query<{ n: string }>(`select count(*)::text n from app.bank_statement`);
      const l = await tx.query<{ n: string }>(`select count(*)::text n from app.bank_statement_line`);
      return [a, s, l].map((r) => Number(r.rows[0]!.n));
    });
    expect(seen).toEqual([0, 0, 0]);

    const aSeen = await db.withTenant(TENANT_A, async (tx) => {
      const r = await tx.query<{ n: string }>(`select count(*)::text n from app.cash_account`);
      return Number(r.rows[0]!.n);
    });
    expect(aSeen).toBeGreaterThan(0);
  });
});
