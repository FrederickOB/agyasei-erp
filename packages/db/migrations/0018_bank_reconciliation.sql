-- ============================================================================
-- 0018 — BANK AND MOBILE MONEY RECONCILIATION
--
-- CLAUDE.md §2.8 makes this REQUIRED, and the reason is worth repeating: it is
-- where undetected errors in a home-grown GL surface first, because it is the
-- only routine control that compares the ledger against a document THIS SYSTEM
-- DID NOT PRODUCE. Every other check in this schema is the ledger agreeing
-- with itself.
--
-- ── MOBILE MONEY IS A CASH ACCOUNT, NOT A PAYMENT METHOD (05 §5.7.1) ───────
-- A momo wallet is a gl_account with control_account_kind = 'MOMO' and a
-- cash_account row, and it runs the identical workflow as a bank account.
-- Three reasons this is not over-engineering for this market:
--
--   1. The wallet holds a REAL FLOAT — an asset with a balance that belongs on
--      the balance sheet, not a routing label on a cash line.
--   2. It has its OWN CHARGES. Provider fees mean the amount received is not
--      the amount paid (rule 4b). Treated as "cash", those fees have nowhere
--      to go and become an unexplained difference that grows every month.
--   3. It has its OWN STATEMENT, with its own timing and its own float delay
--      between wallet and bank. A cash-out is a real transfer between two
--      asset accounts and both sides need reconciling.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- app.cash_account — the detail behind a cash-like GL account.
--
-- One row per (account, location): the same bank account used by two locations
-- reconciles separately, because the GL balance being compared is per location.
-- ----------------------------------------------------------------------------
create table app.cash_account (
  tenant_id             uuid        not null references platform.tenant (id),
  id                    uuid        not null,
  account_id            uuid        not null,
  kind                  text        not null,
  -- Bank name or mobile network. Tenant vocabulary; nothing branches on it.
  provider              text,
  -- Account or wallet identifier. MASKED in every UI — it is stored so a
  -- statement can be matched to an account, not so it can be displayed.
  external_ref          text,
  location_id           uuid        not null,
  opening_balance_minor bigint      not null default 0,
  opening_as_of         date        not null,
  statement_format      text,
  -- How stale an unmatched statement line may get before it blocks the close.
  -- TENANT CONFIGURATION with a stated default, never a constant in code.
  stale_after_days      integer     not null default 30 check (stale_after_days between 1 and 365),
  is_active             boolean     not null default true,
  created_at            timestamptz not null default transaction_timestamp(),
  updated_at            timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, id),
  unique (tenant_id, account_id, location_id),
  foreign key (tenant_id, account_id) references app.gl_account (tenant_id, id),
  foreign key (tenant_id, location_id) references app.location (tenant_id, id),
  constraint ca_kind check (kind in ('BANK','MOMO','TILL'))
);
select app.apply_tenant_rls('app.cash_account');


-- ----------------------------------------------------------------------------
-- app.bank_statement — one statement, as received.
-- ----------------------------------------------------------------------------
create table app.bank_statement (
  tenant_id             uuid        not null references platform.tenant (id),
  id                    uuid        not null,
  cash_account_id       uuid        not null,
  period_start          date        not null,
  period_end            date        not null,
  opening_balance_minor bigint      not null,
  closing_balance_minor bigint      not null,
  source                text        not null,
  file_digest           text,
  imported_at           timestamptz not null default transaction_timestamp(),
  imported_by           uuid        not null,
  created_at            timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, id),
  foreign key (tenant_id, cash_account_id) references app.cash_account (tenant_id, id),
  constraint bs_source check (source in ('csv','manual_entry','api')),
  constraint bs_range check (period_start <= period_end)
);
select app.apply_tenant_rls('app.bank_statement');


-- ----------------------------------------------------------------------------
-- app.bank_statement_line — EXTERNAL DATA, and shaped like it.
--
-- `amount_minor` (always positive) plus a `direction` char, NOT the ledger's
-- debit/credit pair. That is a deliberate carve-out from the convention every
-- other money table here follows, and the reason is worth stating plainly:
--
--   A statement line is not a ledger row. Forcing it into the ledger's
--   convention invites a reader to think the bank's "credit" and the ledger's
--   "credit" are the same word. From the account holder's side they are
--   OPPOSITES, and that confusion is the classic reconciliation error.
--
-- So the column is named for what the bank said — money in, money out — and a
-- reader has to translate deliberately rather than by assumption.
-- ----------------------------------------------------------------------------
create table app.bank_statement_line (
  tenant_id     uuid        not null references platform.tenant (id),
  id            uuid        not null,
  statement_id  uuid        not null,
  line_no       integer     not null check (line_no >= 1),
  value_date    date        not null,
  description   text,
  reference     text,
  amount_minor  bigint      not null check (amount_minor > 0),
  direction     char(1)     not null,
  external_ref  text,
  created_at    timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, id),
  unique (tenant_id, statement_id, line_no),
  foreign key (tenant_id, statement_id) references app.bank_statement (tenant_id, id),
  -- 'I' inbound (money arrived) | 'O' outbound (money left). The account
  -- holder's view, stated as such.
  constraint bsl_direction check (direction in ('I','O'))
);
select app.apply_tenant_rls('app.bank_statement_line');
create index bank_statement_line_by_date
  on app.bank_statement_line (tenant_id, statement_id, value_date);


-- ----------------------------------------------------------------------------
-- app.reconciliation_match — MANY-TO-MANY, and it has to be.
--
-- A join table rather than a nullable FK on either side, because a day's
-- takings bank as ONE deposit against MANY receipt lines, and one bank line can
-- settle SEVERAL invoices. A nullable column on either table can express
-- neither.
--
-- Both sides are nullable so the table can also record what did NOT match: a
-- statement line with no book entry, or a book entry with no statement line.
-- Those are the two halves of the monthly view, and they are the whole reason
-- anyone runs this control.
-- ----------------------------------------------------------------------------
create table app.reconciliation_match (
  tenant_id         uuid        not null references platform.tenant (id),
  id                uuid        not null,
  cash_account_id   uuid        not null,
  statement_line_id uuid,
  journal_entry_id  uuid,
  journal_line_no   integer,
  matched_by        uuid        not null,
  matched_at        timestamptz not null default transaction_timestamp(),
  method            text        not null,
  -- Why a human matched these, when the machine would not have.
  note              text,
  created_at        timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, id),
  foreign key (tenant_id, cash_account_id) references app.cash_account (tenant_id, id),
  foreign key (tenant_id, statement_line_id) references app.bank_statement_line (tenant_id, id),
  foreign key (tenant_id, journal_entry_id) references app.journal_entry (tenant_id, id),
  constraint rm_method check (method in ('auto','manual')),
  -- A match with neither side is not a match.
  constraint rm_has_a_side check (statement_line_id is not null or journal_entry_id is not null),
  -- A journal side means a specific LINE of that entry.
  constraint rm_line_no check ((journal_entry_id is null) = (journal_line_no is null)),
  -- An AUTO match must have both sides. The machine never records a
  -- half-match: an unmatched item is an absence, not a row somebody has to
  -- reason about.
  constraint rm_auto_is_complete check (
    method <> 'auto' or (statement_line_id is not null and journal_entry_id is not null)),
  -- A MANUAL half-match must say why. "Explained" is a human's assertion and
  -- it needs an author and a reason, or the close gate is waved through by a
  -- row nobody can question.
  constraint rm_manual_half_needs_note check (
    statement_line_id is not null and journal_entry_id is not null
    or note is not null)
);
select app.apply_tenant_rls('app.reconciliation_match');

-- A statement line matches once, and a journal line matches once. Without
-- these, the same deposit reconciles twice and the unexplained difference
-- silently closes.
create unique index reconciliation_match_statement_uq
  on app.reconciliation_match (tenant_id, statement_line_id)
  where statement_line_id is not null;
create unique index reconciliation_match_journal_uq
  on app.reconciliation_match (tenant_id, journal_entry_id, journal_line_no)
  where journal_entry_id is not null;


-- ============================================================================
-- RECONCILIATION NEVER EDITS THE LEDGER (05 §5.7.2)
--
-- "There is no 'adjust the ledger to agree with the bank' action, and there is
-- no code path from the reconciliation module to an UPDATE on a posted line.
-- This is the whole point of the control: IT MUST BE ABLE TO DISAGREE WITH THE
-- LEDGER."
--
-- Nothing above can write to journal_entry or journal_line: this migration
-- adds no trigger on them and no function that touches them. The GL's own
-- immutability guards (migration 0015, GL0022/GL0024, ENABLE ALWAYS) refuse
-- the edit even if some future module tried.
--
-- An unmatched statement line that turns out to be genuine — a bank charge,
-- credit interest, a customer's direct transfer, a returned cheque — becomes a
-- NEW journal entry raised from the reconciliation screen and posted through
-- the ordinary path, with its own source document. It does not amend anything.
-- ============================================================================
