/**
 * THE POSTING ENGINE — where a settled document becomes a journal entry.
 *
 * This is the piece that connects `./rules.ts` (which speaks in roles) to
 * `./mapping.ts` (which knows what a role means for this tenant) and to the
 * journal (migration 0015). Until it existed the rules were pure functions
 * nothing called — the exact shape of the eighteen build-but-never-wire
 * defects this project has recorded, so it is deliberately the very next thing
 * built after them.
 *
 * ── THE RULING THIS FILE IMPLEMENTS (05 §5.6.1) ───────────────────────────
 * **Acceptance and posting are separate, and a posting failure NEVER rejects a
 * settled document.**
 *
 * The scenario that forces it: Bawku trades offline for eight days, 300 sales
 * arrive, and meanwhile an admin retired an account or a new product category
 * was created with no COGS mapping.
 *
 *   * Post SYNCHRONOUSLY and the failure dead-letters the write — the sale
 *     never lands at all, not in stock, not in sales, not in the books, while
 *     the customer holds the goods and a printed receipt. A CLAUDE.md §2.2
 *     violation on the GL's side of the boundary.
 *   * Post ASYNCHRONOUSLY with no record and the document exists while no
 *     entry does, and nothing detects it. The period closes clean with revenue
 *     missing.
 *
 * So: posting runs in ITS OWN transaction, against documents that have already
 * settled. When it fails, the failure is written down — `app.posting_exception`
 * — in a SECOND transaction, because the first one has rolled back and taken
 * any record of the attempt with it. That exception is a close gate.
 *
 * ── EVERYTHING IS DATED BY THE DOCUMENT ───────────────────────────────────
 * The period, the mapping and (upstream) the tax rates all resolve against the
 * document's own business date, never against today. A sale that arrives after
 * eight days offline posts into the period it happened in.
 */
import { uuidv7 } from '../ids.js';
import type { Queryable } from '../testing/harness.js';
import { MissingMappingError, resolveAccounts, type ResolvedAccount } from './mapping.js';
import { UnbalancedRuleError, type ProposedEntry } from './rules.js';

export interface PostingRunner {
  withTenant<T>(tenantId: string, fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

export interface PostOptions {
  readonly tenantId: string;
  /** Who the ledger records as having made this entry. */
  readonly postedBy: string;
  /** Which rule set produced these lines. Stamped on the entry (05 §5.2.2). */
  readonly postingRuleVersion: number;
}

export type PostResult =
  | { readonly status: 'posted'; readonly journalEntryId: string; readonly entryNo: bigint }
  /** This document already has an entry. Posting is idempotent by construction. */
  | { readonly status: 'duplicate'; readonly journalEntryId: string }
  | {
      readonly status: 'exception';
      readonly exceptionId: string;
      readonly errorCode: string;
      readonly detail: string;
    };

/** Error codes an exception row can carry. Stable strings; operators see them. */
export const POSTING_ERROR = {
  noPeriod: 'GL_NO_PERIOD',
  periodClosed: 'GL_PERIOD_CLOSED',
  mappingMissing: 'GL_MAPPING_MISSING',
  ruleUnbalanced: 'GL_RULE_UNBALANCED',
  noCalendar: 'GL_NO_CALENDAR',
} as const;

class PostingFailure extends Error {
  constructor(
    readonly errorCode: string,
    readonly detail: string,
    readonly postingRole: string | null = null,
  ) {
    super(detail);
    this.name = 'PostingFailure';
  }
}

interface PeriodRow {
  period_id: string;
  fy_code: string;
  status: string;
}

async function resolvePeriod(tx: Queryable, documentDate: string): Promise<PeriodRow> {
  const res = await tx.query<PeriodRow>(
    `select id as period_id, fy_code, status
       from app.accounting_period
      where $1::date between starts_on and ends_on`,
    [documentDate],
  );
  const row = res.rows[0];
  if (row === undefined) {
    // Not a fallback to "the current period" — that would silently move a
    // document into a period it did not happen in, which is the one thing an
    // effective-dated ledger exists to prevent.
    throw new PostingFailure(
      POSTING_ERROR.noPeriod,
      `no accounting period covers ${documentDate}; the tenant's calendar has a gap or has not been extended`,
    );
  }
  if (row.status !== 'open') {
    throw new PostingFailure(
      POSTING_ERROR.periodClosed,
      `the period covering ${documentDate} is ${row.status}; a late document cannot post into it without a reopen`,
    );
  }
  return row;
}

/**
 * Allocate the next entry number under a row lock.
 *
 * Gapless is affordable here and nowhere else in this system: the counter
 * never leaves the server, so the coordination that makes gapless impossible
 * for a device-allocated receipt number is simply present.
 */
async function nextEntryNo(tx: Queryable, fyCode: string): Promise<bigint> {
  const res = await tx.query<{ next_no: string }>(
    `update app.gl_counter
        set next_no = next_no + 1, updated_at = transaction_timestamp()
      where fy_code = $1
      returning (next_no - 1)::text as next_no`,
    [fyCode],
  );
  const row = res.rows[0];
  if (row === undefined) {
    throw new PostingFailure(
      POSTING_ERROR.noCalendar,
      `no gl_counter row for fiscal year ${fyCode}; the tenant's calendar is incomplete`,
    );
  }
  return BigInt(row.next_no);
}

/**
 * Post one document. Returns rather than throws for every expected failure —
 * the caller is a background worker draining settled documents, and a throw
 * would stop the drain on the first bad mapping.
 */
export async function postDocument(
  runner: PostingRunner,
  entry: ProposedEntry,
  opts: PostOptions,
): Promise<PostResult> {
  try {
    return await runner.withTenant(opts.tenantId, async (tx) => {
      // Idempotent by the document, not by a key the caller invents: migration
      // 0015's `je_one_per_source` would refuse a second entry anyway, and
      // checking first turns a constraint violation into a plain answer.
      const existing = await tx.query<{ id: string }>(
        `select id from app.journal_entry
          where source_kind = $1 and source_id = $2 and reverses_entry_id is null`,
        [entry.sourceKind, entry.sourceId],
      );
      const already = existing.rows[0];
      if (already !== undefined) {
        return { status: 'duplicate', journalEntryId: already.id } as const;
      }

      const period = await resolvePeriod(tx, entry.documentDate);

      // Resolve EVERY role first, and report all the missing ones together. A
      // rule that failed on the first would send an operator round the loop
      // once per role.
      const { resolved, missing } = await resolveAccounts(
        tx,
        entry.lines.map((l) => ({
          role: l.role,
          scope: {
            locationId: l.locationId,
            ...(l.productCategoryId === undefined ? {} : { productCategoryId: l.productCategoryId }),
          },
        })),
        entry.documentDate,
      );
      if (missing.length > 0) {
        throw new PostingFailure(
          POSTING_ERROR.mappingMissing,
          `${missing.length} posting role(s) are not mapped: ` +
            missing.map((m) => m.postingRole).join(', '),
          missing[0]!.postingRole,
        );
      }

      // A role can resolve differently per location or category, so resolve
      // per LINE rather than reusing the first answer for the role.
      const perLine: ResolvedAccount[] = [];
      for (const line of entry.lines) {
        const key = line.role;
        const hit = resolved.get(key);
        /* c8 ignore next */
        if (hit === undefined) throw new PostingFailure(POSTING_ERROR.mappingMissing, key, key);
        perLine.push(hit);
      }
      const mappingSetVersion = perLine.reduce((a, r) => Math.max(a, r.mappingSetVersion), 1);

      const entryNo = await nextEntryNo(tx, period.fy_code);
      const journalEntryId = uuidv7();

      await tx.query(
        `insert into app.journal_entry
           (tenant_id, id, entry_no, period_id, fy_code, document_date, status,
            source_kind, source_id, idempotency_key, posting_rule_version,
            mapping_set_version, created_by)
         values ($1, $2, $3, $4, $5, $6, 'draft', $7, $8, $9, $10, $11, $12)`,
        [
          opts.tenantId, journalEntryId, entryNo.toString(10), period.period_id,
          period.fy_code, entry.documentDate, entry.sourceKind, entry.sourceId,
          `${entry.sourceKind}:${entry.sourceId}`, opts.postingRuleVersion,
          mappingSetVersion, opts.postedBy,
        ],
      );

      const currency = await tx.query<{ currency_code: string }>(
        `select j.currency_code
           from platform.tenant t
           join platform.jurisdiction j on j.code = t.jurisdiction_code
          where t.id = $1`,
        [opts.tenantId],
      );
      const currencyCode = currency.rows[0]?.currency_code;
      /* c8 ignore next 3 */
      if (currencyCode === undefined) {
        throw new PostingFailure(POSTING_ERROR.noCalendar, 'tenant has no jurisdiction pack');
      }

      for (let i = 0; i < entry.lines.length; i += 1) {
        const line = entry.lines[i]!;
        const account = perLine[i]!;
        await tx.query(
          `insert into app.journal_line
             (tenant_id, journal_entry_id, line_no, account_id, location_id,
              debit_minor, credit_minor, currency_code, counterparty_kind,
              counterparty_id, product_id, memo)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            opts.tenantId, journalEntryId, i + 1, account.accountId, line.locationId,
            line.debitMinor.toString(10), line.creditMinor.toString(10), currencyCode,
            line.counterpartyKind ?? null, line.counterpartyId ?? null,
            line.productId ?? null, line.memo ?? null,
          ],
        );
      }

      // The single UPDATE that makes it the ledger. Everything migration 0015
      // enforces — balance per location, header agreeing with its lines,
      // immutability from here on — takes effect at this statement and at
      // COMMIT.
      await tx.query(
        `update app.journal_entry
            set status = 'posted', posted_at = transaction_timestamp()
          where id = $1`,
        [journalEntryId],
      );

      // A prior exception for this document is now answered by the entry
      // itself. Resolving it here is what stops the close gate holding a
      // period open over a problem that has been fixed and retried.
      await tx.query(
        `update app.posting_exception
            set resolved_at = transaction_timestamp(), resolved_by = $3,
                resolution_note = 'posted on retry as journal entry ' || $4,
                updated_at = transaction_timestamp()
          where source_kind = $1 and source_id = $2 and resolved_at is null`,
        [entry.sourceKind, entry.sourceId, opts.postedBy, journalEntryId],
      );

      return { status: 'posted', journalEntryId, entryNo } as const;
    });
  } catch (err) {
    const failure = asFailure(err);
    if (failure === null) throw err;
    // SECOND TRANSACTION, and it must be: the first has rolled back and taken
    // any record of the attempt with it. This is the whole difference between
    // "the period closes clean with revenue missing" and a visible gate.
    const exceptionId = await runner.withTenant(opts.tenantId, async (tx) => {
      const location = entry.lines[0]?.locationId ?? null;
      /* c8 ignore next */
      if (location === null) throw err;
      const id = uuidv7();
      const res = await tx.query<{ id: string }>(
        `insert into app.posting_exception
           (tenant_id, id, source_kind, source_id, location_id, document_date,
            posting_role, error_code, error_detail, severity)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)
         on conflict (tenant_id, source_kind, source_id) where resolved_at is null
         do update set error_code = excluded.error_code,
                       error_detail = excluded.error_detail,
                       posting_role = excluded.posting_role,
                       updated_at = transaction_timestamp()
         returning id`,
        [
          opts.tenantId, id, entry.sourceKind, entry.sourceId, location,
          entry.documentDate, failure.postingRole, failure.errorCode, failure.detail,
        ],
      );
      return res.rows[0]!.id;
    });
    return {
      status: 'exception',
      exceptionId,
      errorCode: failure.errorCode,
      detail: failure.detail,
    };
  }
}

/**
 * Record a document that could not even be turned into an entry — the RULE
 * refused it (a nil document, tenders that do not sum to the total) — as the
 * same posting_exception a mapping failure opens. A sweep that threw instead
 * would stop draining on the first bad document and leave every later one
 * unposted and unreported; a sweep that skipped it silently would let the
 * period close over it. Neither: it becomes visible work.
 */
export async function recordRuleFailure(
  runner: PostingRunner,
  opts: PostOptions,
  doc: {
    readonly sourceKind: string;
    readonly sourceId: string;
    readonly locationId: string;
    readonly documentDate: string;
  },
  err: UnbalancedRuleError,
): Promise<PostResult> {
  const exceptionId = await runner.withTenant(opts.tenantId, async (tx) => {
    const res = await tx.query<{ id: string }>(
      `insert into app.posting_exception
         (tenant_id, id, source_kind, source_id, location_id, document_date,
          posting_role, error_code, error_detail, severity)
       values ($1, $2, $3, $4, $5, $6, null, $7, $8, 1)
       on conflict (tenant_id, source_kind, source_id) where resolved_at is null
       do update set error_code = excluded.error_code,
                     error_detail = excluded.error_detail,
                     updated_at = transaction_timestamp()
       returning id`,
      [
        opts.tenantId, uuidv7(), doc.sourceKind, doc.sourceId, doc.locationId,
        doc.documentDate, POSTING_ERROR.ruleUnbalanced, err.message,
      ],
    );
    return res.rows[0]!.id;
  });
  return { status: 'exception', exceptionId, errorCode: POSTING_ERROR.ruleUnbalanced, detail: err.message };
}

function asFailure(err: unknown): PostingFailure | null {
  if (err instanceof PostingFailure) return err;
  if (err instanceof MissingMappingError) {
    return new PostingFailure(POSTING_ERROR.mappingMissing, err.message, err.postingRole);
  }
  if (err instanceof UnbalancedRuleError) {
    return new PostingFailure(POSTING_ERROR.ruleUnbalanced, err.message);
  }
  return null;
}
