# 6. Customer Credit and the Facility Fee

**Owner:** `credit-engineer` · **Status:** Phase 0 draft for approval, revised after adversarial
review · **Depends on:** `ADR-0002` (effective-dated statutory rates), `ADR-0004` (integer minor
units), `ADR-0005` (shared schema, RLS, tenant-scoped sync), `ADR-0006` (templates, not branches),
`ADR-0007` (jurisdiction packs), and the authoritative rulings in **§3** (offline sync), **§4**
(data model) and **§5** (general ledger).

> **Revision note.** This section was adversarially reviewed on 2026-08-21. **Ten findings were
> blocking**, eighteen major, eleven minor. Four of the blocking findings were the same defect:
> this section was written before §3, §4 and §5 were revised, and it re-invented machinery those
> sections had already settled — the device credit snapshot, the write registry, the review queue,
> the interim rule for a forked limit. Two more were arithmetic: the fee basis silently refunded
> already-earned fees on a partial payment, and the day-count invariant the section was proudest of
> was false at month end. Corrections are applied inline. The full disposition of every finding, the
> cross-section amendments this revision requires of §3/§4/§5, and the open questions promoted are
> in **§6.12**. **Where §6.12 and the body differ, §6.12 governs.**

Credit is the product's highest-value feature and its most concentrated risk. It is also the only
subsystem where the offline constraint and a business invariant are in direct, unresolvable
conflict. A credit limit is a **global** invariant — it is a statement about the sum of activity at
every location at once — and a device that cannot reach the server cannot enforce a global
invariant. No protocol fixes this. This section designs for detection and recovery instead of
pretending prevention is possible, and is explicit about where the truth has to be told to the
person standing at the counter.

Everything here is **per-tenant configuration**. Tenant #1's 30–60 day terms and 2–3%/month
facility fee are values in the *Construction materials distribution — Ghana* template, not platform
behaviour (`ADR-0006`). The customer type is **credit customer**; tenant #1's own vocabulary for
that type, and its product names, appear only in its template's labels and never in this section's
prose. Where a worked example needs a number it uses a neutral one.

---

## 6.1 Three layers: policy, account, entry

The single most consequential structural choice here is *what lives at which level*. Getting it
wrong produces either a platform that hard-codes one tenant's credit terms, or a free-for-all in
which every account has its own accrual mechanics and no one can write a revenue recognition note.

| Layer | Scope | Holds | Why it lives here |
|---|---|---|---|
| `credit_policy` | one row in force per tenant, effective-dated | fee basis, compounding, day-count, posting cadence, ageing bucket boundaries, offline controls, GL account mapping, defaults for new accounts | **Accounting policy.** A tenant files one set of accounts. It cannot have account A accruing on overdue balance and account B on outstanding balance and still produce a coherent revenue recognition note. |
| `credit_account` | **one per customer, enforced** | security deposit, lifecycle status, and **server-maintained projections** of the accepted limit version | **Commercial relationship.** The account is the thing exposure is measured against. |
| `credit_limit_version` | append-only decision log, one row per decision | limit, terms days, fee rate — **the sole authority for all three** | **Risk judgement.** §6.6 is the reason. |
| `credit_entry` | append-only, one row per event | every movement of the balance | **Fact.** The balance is derived from these, never stored as a mutable counter. |

This is a refinement of `ADR-0006`, not a departure from it: that ADR says "per-tenant credit
policy; per-account terms and rate", and this splits *which* knobs are which. Rate and terms are per
account — but they live on the account's **limit version log**, not as free-standing mutable columns
(§6.6, and the reason is in `M-14` of §6.12). **Basis, compounding and day-count are per tenant and
are not overridable per account.**

*Deleted on review:* the previous text offered "if a tenant genuinely needs two fee structures, that
is two policies with an effective-dated cut-over". Effective-dating gives **sequential** policies;
the need it purported to answer — account A on overdue balance while account B is on outstanding
balance — is **concurrent**. The escape hatch did not exist and saying it did was a false comfort.
The underlying decision stands: one accrual basis per tenant, because a tenant files one set of
accounts. A tenant that genuinely needs two is a tenant that needs two ledgers.

```sql
create type fee_basis        as enum ('overdue_balance','outstanding_balance','drawn_amount');
create type fee_day_count    as enum ('thirty_e_360_isda','actual_365','whole_calendar_month');
create type fee_post_cadence as enum ('daily','monthly_close','on_settlement');
create type sub_limit_mode   as enum ('off','fixed','share_of_limit');

-- Created through app.new_tenant_table (§4.2.3), which supplies tenant_id, id,
-- write_id, hlc, created_at, updated_at, deleted_at, the (tenant_id, id) primary
-- key, the composite FK to app.write_log, ENABLE/FORCE ROW LEVEL SECURITY and the
-- tenant-isolation policy. None of the five tables in this section opts out of it.
select app.new_tenant_table('credit_policy', $$
  effective_from       date not null,
  effective_to         date,                          -- null = in force

  -- accrual mechanics (tenant-wide, see 6.4)
  fee_basis            fee_basis        not null,
  fee_compounds        boolean          not null,
  fee_on_fee           boolean          not null,     -- do unpaid accruals enter the basis?
  fee_day_count        fee_day_count    not null,
  fee_grace_days       smallint         not null default 0 check (fee_grace_days >= 0),
  fee_post_cadence     fee_post_cadence not null,
  fee_accrual_stop_days integer         not null,     -- accrual ceases past this age (m-1)

  -- rounding / threshold controls. NEITHER of these adds money. See M-6.
  fee_min_post_minor   app.money_minor  not null default 0
      check (fee_min_post_minor >= 0),                -- SUPPRESS-ONLY threshold
  fee_minimum_charge_minor app.money_minor not null default 0
      check (fee_minimum_charge_minor >= 0),          -- a commercial FLOOR. D-6. Gated.

  -- defaults stamped onto new accounts
  default_terms_days   smallint not null check (default_terms_days >= 0),
  default_limit_minor  app.money_minor not null check (default_limit_minor >= 0),
  default_fee_rate_bp  app.bp   not null check (default_fee_rate_bp >= 0),

  -- ageing (see 6.3)
  ageing_bucket_days   smallint[] not null
      check (cardinality(ageing_bucket_days) >= 1
             and ageing_bucket_days[1] > 0
             and ageing_bucket_days = (select array_agg(x order by x)
                                         from unnest(ageing_bucket_days) x)
             and cardinality(ageing_bucket_days)
                 = (select count(distinct x) from unnest(ageing_bucket_days) x)),

  -- offline controls (see 6.7)
  offline_ceiling_minor        app.money_minor,       -- null = no per-sale ceiling
  offline_auth_threshold_minor app.money_minor,       -- above this, manager authorisation offline
  location_sub_limit_mode      sub_limit_mode not null,
  cap_lease_days               smallint not null default 7 check (cap_lease_days > 0),

  -- the human gate (see 6.4.5)
  fee_confirmed_at     timestamptz,
  fee_confirmed_by     uuid,
  fee_confirmed_hash   bytea,                         -- sha256 over the confirmed values
  fee_confirmation_note text,
  fee_attestation      text,                          -- the attesting professional's qualification
  foreign key (tenant_id, fee_confirmed_by) references app.user_account (tenant_id, id),
  check ((fee_confirmed_at is null) = (fee_confirmed_hash is null)),
  check (fee_confirmed_at is null
         or (fee_confirmed_by is not null and fee_attestation is not null)),
  check (effective_to is null or effective_to > effective_from)
$$);

-- One policy in force at a time, as a constraint rather than as a hope (m-5).
alter table app.credit_policy add constraint credit_policy_no_overlap
  exclude using gist (
    tenant_id with =,
    daterange(effective_from, effective_to, '[)') with &&
  );
```

**The ageing bucket array is constrained, and the report renders from it.** `{60,30,90}` produced an
empty middle bucket and `{}` produced undefined behaviour; both are now rejected by the CHECK. The
bucket **count** is `cardinality(ageing_bucket_days) + 2` — `current`, one per boundary, and one
beyond the last — and the ageing report renders that many columns dynamically. The template's
`{30,60,90}` gives five; a tenant on weekly terms using `{7,14,21}` gets five with different edges;
a tenant using `{30}` gets three. Nothing in the report body is fixed at four.

**Accrual uses the policy in force on the accrual date, not today's policy.** `ADR-0002`'s principle
is quoted rather than paraphrased: *"A historical transaction always reprices against the table row
that was in effect on its transaction date, never today's row."* A fee segment dated in March
accrues on March's policy even if the policy changed in April.

`credit_account` carries **no `location_id`.** That omission is the whole of §6.5.

```sql
create type credit_account_status as enum ('active','suspended','closed');

select app.new_tenant_table('credit_account', $$
  customer_id            uuid     not null,
  status                 credit_account_status not null,   -- 'active'|'suspended'|'closed'
  security_deposit_minor app.money_minor not null default 0
                         check (security_deposit_minor >= 0),
  opened_on              date     not null,

  -- SERVER-MAINTAINED PROJECTIONS of the accepted head of credit_limit_version.
  -- Not independently writable: no GRANT UPDATE on these columns to the application
  -- role; only the version-apply trigger writes them. §4.9's credit_limit_minor,
  -- limit_set_by, limit_set_hlc and limit_write_id are these columns and this rule.
  credit_limit_minor     app.money_minor not null default 0 check (credit_limit_minor >= 0),
  terms_days             smallint not null check (terms_days >= 0),
  fee_rate_bp            app.bp   not null check (fee_rate_bp >= 0),
  limit_version_id       uuid,                    -- the accepted head; null before the first version
  limit_set_by           uuid,
  limit_set_hlc          app.hlc,
  limit_write_id         uuid,

  foreign key (tenant_id, customer_id) references app.customer (tenant_id, id),
  unique (tenant_id, customer_id)                 -- M-8: one account per customer, as a constraint
$$);
```

**`status` no longer carries `'on_hold'`.** A hold is not a lifecycle state; it is a fast, safe,
reversible switch, and §3.6 conflict class #8 already governs it as `customer.credit_hold` with
hold-wins semantics. Three flags meaning "on hold" is how a customer placed on hold by Accounts
keeps transacting because the till read a different one. **`customer.credit_hold` is the single
authority**; `credit_allowance.credit_hold` is a projection of it into the till's allowance row; and
`credit_account.status` covers lifecycle only. See `M-14`.

---

## 6.2 Exposure is derived — and what that does and does not settle

```sql
create type credit_entry_type as enum
  ('sale','payment','credit_note','fee_accrual','fee_waiver','write_off','adjustment');

select app.new_tenant_table('credit_entry', $$
  credit_account_id uuid    not null,
  entry_type        credit_entry_type not null,
  amount_minor      app.money_minor not null,
  invoice_id        uuid,               -- the invoice this attaches to; drives ageing and fee
  reverses_entry_id uuid,               -- a reversal is a new row, never an edit
  location_id       uuid    not null,   -- ATTRIBUTION ONLY. Never scopes a balance query and
                                        -- never scopes a sync rule (§6.5). See m-2.
  business_date     date    not null,   -- §3.4.2's human-asserted trading day. Drives ageing.
  reason_code       text,
  archived_at       timestamptz,        -- §3.2.4 windowing; the one whitelisted mutation
  created_by        uuid,

  foreign key (tenant_id, credit_account_id) references app.credit_account (tenant_id, id),
  foreign key (tenant_id, reverses_entry_id) references app.credit_entry (tenant_id, id),
  foreign key (tenant_id, location_id)      references app.location (tenant_id, id),

  check (deleted_at is null),           -- §4.2.4: ledgers forbid soft delete
  check (amount_minor <> 0),            -- §4.9

  -- M-9: the sign convention is a constraint, not a comment. §4.17.5 finding 8:
  -- outflow is negative; debit-to-customer is positive. A reversal carries the
  -- original's entry_type with the opposite sign, which is why the CHECK branches.
  check (
    case when reverses_entry_id is null then 1 else -1 end
    * case entry_type
        when 'sale'        then  1  when 'fee_accrual' then  1
        when 'payment'     then -1  when 'credit_note' then -1
        when 'fee_waiver'  then -1  when 'write_off'   then -1
        else 0 end
    * sign(amount_minor) >= 0
  ),
  check (entry_type <> 'adjustment' or reason_code is not null)
$$);
create index on app.credit_entry (tenant_id, credit_account_id, business_date);
create index on app.credit_entry (tenant_id, invoice_id) where invoice_id is not null;
```

**There is no `idempotency_key` on this table, and that is a correction.** §3.3.2 and §4.2.2 both
record it as a fixed defect: there is one write registry, `app.write_log`, and `write_log.id` **is**
the key. A second key on a business row is the shape that swallows the `write_log` row under
`ON CONFLICT DO NOTHING` and leaves every composite FK pointing at a parent that was never inserted
— *"a tendered, printed, cash-collected sale in a poison table."* `credit_entry` carries `write_id`
with the composite FK that `app.new_tenant_table` emits, and nothing else.

**`hlc` is `app.hlc` and is server-stamped at ingest** (§3.4.1). The device's assertion lives in
`write_log.claimed_hlc` and is untrusted. The previous `hlc text` with no such statement invited a
client-supplied ordering key on the table that determines a customer's balance.

**`occurred_on` is renamed `business_date`, and it is not a free date field.** It was the single
most abusable column in this section: it drives both the ageing bucket and the fee, and nothing
bounded it, so a device with a mis-set clock — or a manager who typed a date — could move both. §3's
±24h wall-clock refusal is a control on the *transport*, not a validation of a business-date column.
The rule, aligned to §3.4.2 and §4.8a:

- For an entry originating from a sale or a counter payment, `business_date` **is the open cash
  session's `business_date`**. There is no other path: `sale.cash_session_id` is `NOT NULL`, the
  session is capped at one calendar day, auto-closes at the location's local midnight, is validated
  against server time whenever the device is online at open, and is refused into a closed period.
- For a server-originated entry (accrual, waiver, write-off, adjustment), `business_date` is the
  **tenant business date** derived per `M-17` below.
- For an entry back-dated by Accounts — the only remaining path — the server accepts
  `business_date` within the **currently open accounting period** and refuses anything outside it.
  A back-date into a closed period is not a validation error to be flagged; it is refused, because
  §5.3 forbids the retro-restatement it would cause. The refusal names the period.

**Exposure is `sum(amount_minor)` over the account, split two ways.**

```
trade_exposure(a) = Σ amount_minor where entry_type NOT IN ('fee_accrual','fee_waiver')
fee_exposure(a)   = Σ amount_minor where entry_type     IN ('fee_accrual','fee_waiver')
total_balance(a)  = trade_exposure(a) + fee_exposure(a)
```

**The limit is checked against `trade_exposure`, never against `total_balance`.** This is `B-6` and
it is not a detail. §6.9 requires trade AR to exclude accrued fees so the fee — which grows
precisely when customers are slow — does not inflate the number that measures how slow they are. If
the same undifferentiated sum also drove the limit check, an unpaid fee would consume a customer's
purchasing headroom and refuse a sale. Both statements cannot hold against one sum, so there are
two, and the one that gates a sale is the trade one. **A fee should never refuse a sale.** The
customer statement shows both, separately labelled, and the sum.

**Exposure is never a counter that gets incremented.** A mutable `balance_minor` column is a
read-modify-write, and two devices doing a read-modify-write against the same row while partitioned
is the textbook lost update. An **append-only log of signed integers is commutative**: two offline
batches arriving in either order produce the same sum.

**And here is what that argument does *not* buy, which the previous draft claimed and should not
have.** The previous text said *"Credit transactions therefore have no conflict case at all."*
That sentence is withdrawn. Commutativity holds for **the sum**. It does not hold for **payment
allocation**, which is a resource assignment against a bounded quantity:

> A customer owes on invoices A (oldest, 5,000) and B (5,000). Two locations each take a 5,000 cash
> payment while both offline. Both devices FIFO-allocate to invoice A. The **balance** converges
> correctly — 10,000 of credits against 10,000 of charges. The **allocations** do not: invoice A is
> allocated 10,000 against a 5,000 value and invoice B is allocated nothing. Ageing is wrong, B's
> fee basis is wrong so it keeps accruing on a customer who has paid in full, the statement is
> wrong, and because §6.3 forbids silently netting on-account credit, the over-allocation is not
> even visible as on-account credit. The customer is chased for an invoice they paid — the exact
> outcome §6.3's design exists to prevent.

**Ruling: allocation is a server-side operation only.** A device never allocates. An offline payment
is captured as a `payment` entry with `invoice_id IS NULL` — **unallocated on-account credit** — and
the server allocates it once, deterministically, at ingest. This is the same posture as *"accrual
runs server-side only. A device never accrues"*, for the same reason: allocation depends on the
global set of open invoices, which no offline device has. Its cost is that a receipt printed offline
cannot say which invoice was settled; it says *"received on account — allocation confirmed on
sync"*, which is true, and §6.8's rule is that the till says only what it knows.

The invariant is also a constraint, because a server-side-only rule enforced only in application
code is a rule until someone writes a second code path:

```sql
-- deferred constraint trigger, the shape §4 uses for header-vs-lines (§4.17.5 finding 3)
--   for every invoice: Σ credit_allocation.amount_minor <= invoice.gross_minor
--   for every payment: Σ credit_allocation.amount_minor <= |payment.amount_minor|
-- Violation raises an `over_allocation` posting exception, never a silent truncation.
```

`sync-architect` handoff, restated: `credit_entry` is **insert-only** for every client role, with
`archived_at` as the single whitelisted mutation per §3.2.4 (column-level `GRANT UPDATE
(archived_at)` to the archival role, trigger permitting `NULL → timestamp` and nothing else). No
client issues an `UPDATE` or `DELETE`. A reversal is a new entry with `reverses_entry_id` set.

For read speed a `credit_account_rollup` materialises `trade_exposure`, `fee_exposure`, bucket
totals and the last accrual point. It is a cache with one rule: a nightly reconciliation recomputes
from the log and raises an exception on any mismatch. The sum is the truth; the rollup is
convenience.

---

## 6.3 Ageing, and where allocation happens

**An invoice ages against the terms in force when it was issued.** The invoice carries
`terms_days_snapshot` and `fee_rate_bp_snapshot`, copied at issue **from the accepted head of
`credit_limit_version`** — which is the sole authority for both (§6.1, `M-14`). Changing an
account's terms changes future invoices only. This is the same principle as `ADR-0002`'s rule that a
historical transaction reprices against the tax row in effect on its date, and it exists for the
same reason: history must reproduce.

```
due_date               = invoice.business_date + terms_days_snapshot     -- calendar days
days_past_due(as_of)   = as_of - due_date                                -- calendar days, may be negative
```

**Buckets are days past due, not invoice age.** The classic ageing report buckets by invoice age,
and that convention breaks the moment one report contains both 30-day and 60-day accounts: a
"31–60" column would hold a 30-day invoice that is one day late *next to* a 60-day invoice that is
perfectly current. The bucket would mean two different things in the same column, and collections
would chase the wrong customer. Bucketing by days past due makes every column mean the same thing
for every account and matches what a collections clerk actually acts on.

| Bucket | Condition (with `b = ageing_bucket_days`) |
|---|---|
| `current` | `days_past_due <= 0` |
| `overdue_1` | `1 .. b[1]` |
| `overdue_i` | `b[i-1]+1 .. b[i]` |
| `overdue_last` | `> b[n]` |

There are `n + 2` columns, rendered from the array. Nothing is fixed at four.

**Cost, stated:** an accountant arriving from a system that ages by invoice date will read a smaller
oldest-bucket number here and think the book is healthier than it is. The report is labelled *"aged
by days past due"* on screen and in every export, and the customer statement shows both invoice date
and due date on each line so the two can be reconciled by eye. `compliance-gatekeeper` puts the
label in front of the reviewing accountant at the §2.8 gate — not because the convention is in
doubt, but because the receivables note in the financial statements has to say which one it uses.

### 6.3.1 Dates: the tenant business date, and the servers are in Europe

`days_past_due(as_of) = as_of − due_date`, both `date`, and the previous draft never said which
clock produces `as_of`. `ADR-0003` puts Postgres in `eu-west`, and the host observes DST. A
jurisdiction at UTC+0 with no DST — tenant #1's, and many others — is therefore one or two hours
behind the server for part of the year and level with it for the rest. **A nightly ageing or accrual job scheduled at 00:30
server time runs at 22:30 or 23:30 the previous local day.** Every invoice would age a day early or
late depending on the season, bucket boundaries would shift twice a year, and `elapsed` in the fee
formula would move with them — landing on exactly the boundary cases §6.10 sets out to test, and
passing on a developer's machine while failing in `eu-west`.

The rule, and it is a `ADR-0007` pack value rather than a constant:

- **Every credit date is a tenant business date in the tenant's jurisdiction timezone.**
  `jurisdiction_pack.timezone` supplies it; nothing in this section reads the server clock.
- **`as_of` for an ageing or accrual run is that tenant business date**, not `current_date` on the
  server. A run is idempotent by `(invoice, as_of_date)` (§6.4.4), so a job that fires twice around
  a boundary does nothing the second time — but it must not fire once *on the wrong date*, which is
  what an unqualified `current_date` guarantees twice a year.
- **`credit_entry.business_date` is validated against it server-side**, per §6.2's three paths.
- **No code branches on the timezone.** A jurisdiction with DST is a pack that says so; there is no
  `if (country === …)` anywhere, per `ADR-0007`.

A test pins the server TZ to `Europe/Dublin` and asserts identical bucketing and identical accrual
across both DST transitions (§6.10).

### 6.3.2 Allocation — server-side, deterministic, and superseding

Allocation drives ageing, so it is part of the design, not an afterthought. Per `B-8` it is a
server-side operation, never a device one.

```sql
select app.new_tenant_table('credit_allocation', $$
  payment_entry_id  uuid not null,
  invoice_id        uuid not null,
  amount_minor      app.money_minor not null check (amount_minor > 0),
  allocation_set_id uuid not null,        -- one set per allocation decision
  supersedes_set_id uuid,                 -- reallocation writes a new set, supersedes the old
  superseded_at     timestamptz,          -- null = live
  allocated_by      uuid,                 -- null for the automatic FIFO pass
  reason_code       text,                 -- required when supersedes_set_id is not null
  foreign key (tenant_id, payment_entry_id) references app.credit_entry (tenant_id, id),
  check (deleted_at is null),
  check (supersedes_set_id is null or (allocated_by is not null and reason_code is not null))
$$);
create unique index credit_allocation_one_live_set
  on app.credit_allocation (tenant_id, payment_entry_id, invoice_id)
  where superseded_at is null;
```

- **Default is oldest-due-first (FIFO)**, applied by the server at ingest against the invoice set as
  it stands at that moment. Ties — two invoices with the same `due_date` — break on
  `(business_date, invoice_no, id)` so the result is reproducible across environments, not merely
  deterministic.
- **Accounts can reallocate.** That writes a new `allocation_set_id` with `supersedes_set_id` set,
  an authoriser and a reason code, and marks the old set `superseded_at`. Nothing is edited.
  A reallocation that moves cash off an already-charged invoice changes that invoice's fee history;
  the consequence is handled explicitly in §6.4.3 and never posts a silent refund.
- Allocations must sum to the payment; an unallocated remainder sits as **on-account credit**, which
  reduces `trade_exposure` but belongs to no bucket. The ageing report shows on-account credit as a
  separate line and **never nets it silently** against the oldest bucket — netting it invisibly is
  how a customer ends up chased for an invoice they paid.
- Per §5.14.3, **every allocation handed to the GL carries the location at which the obligation was
  created** — the invoice's selling location, not the location that took the cash. Without it §5's
  rule 4 posts to the wrong control account and per-location balance sheets become fiction within a
  year with every constraint still green.

---

## 6.4 The facility fee

The financial model treats this fee as **zero** — deliberate unmodelled upside. The brief's
instruction is to stop burying it. That makes the fee a revenue recognition matter, and revenue
recognition decisions do not get made by inference from a business plan sentence.

### 6.4.1 Settled here (engineering)

1. **The rate is stored as basis points per accrual period** (`fee_rate_bp`, `app.bp`). 2%/month is
   `200`. Never a float, never a percentage string, never an annualised figure converted at runtime
   — store what is charged (`ADR-0004`).
2. **Accrual is an event, not a computed display value.** Every accrual writes a `credit_entry` of
   type `fee_accrual` plus a `fee_accrual_detail` row recording every segment's basis, rate, dates,
   day count and contribution. A customer *will* argue about this charge at a counter. The system
   must be able to show the arithmetic that produced it, months later, without recomputation.
3. **Accrual runs server-side only. A device never accrues.** The fee depends on the global account
   position, which no offline device has. Devices display the last server-computed figure with an
   explicit *as of* stamp. This removes an entire class of duplicate-accrual bugs before it exists.
4. **Cumulative computation, delta posting, over time-weighted balance segments.** Each run computes
   the fee owed *to date* per invoice from the invoice's balance history and posts the difference
   against what has already been posted. §6.4.3 is the arithmetic and the correction.
5. **The fee is computed at invoice grain, so its location attribution is exact.** An invoice has
   exactly one selling location, so the per-location split of a period's fee is
   `Σ(fees on invoices issued at L)` with **no pro-rata and no remainder**. This satisfies §5.14.3's
   contract — the subledger returns the obligation's location with each allocation — and it is
   strictly better than an account-grain pro-rata, which coincides with the exact answer only when
   every invoice has the same elapsed time. §5.6.5's largest-remainder pro-rata remains the
   specified rule for any fee raised at account grain, and needs a one-line amendment to say that
   invoice-grain attribution supersedes it where available (§6.12.2). **This section does not ship a
   second, different split**; it hands the GL the exact one and asks §5 to record that it does.

### 6.4.2 Not settled here — six decisions that need a human

These are marked, not guessed. Each has a provisional template default so the mechanism is testable,
and each is blocked from the GL until confirmed (§6.4.5). They sit under `open-questions.md` **Q4**,
which already says no agent answers it.

| # | Decision | Options | Template default (provisional) | Why it is not mine |
|---|---|---|---|---|
| **D-1** | What the fee accrues **on** | (a) outstanding balance from invoice date · (b) **overdue balance only**, after terms lapse · (c) drawn amount / peak exposure | **(b) overdue only** | Changes revenue by a multiple and changes what the charge *is*. Accruing from invoice date makes it interest on a loan — the reading most likely to attract lending regulation. Accruing on overdue balance makes it a late-payment charge. Q4 asks exactly this. |
| **D-2** | Simple or compounding; does an unpaid fee itself accrue fee | simple / compounding; `fee_on_fee` on or off | **simple, `fee_on_fee = false`** | 2–3%/month is already 26.8–42.6% effective annually (Q4). Compounding pushes it higher and sharpens the regulatory question. It is also unexplainable at a counter. |
| **D-3** | Day-count basis, and what a "month" means for a mid-month invoice | 30E/360 ISDA · actual/365 · whole calendar month with no pro-rating | **30E/360 ISDA** | Whole-month charging means a one-day-late invoice pays a full month. That is a commercial and possibly legal posture, not an engineering preference. |
| **D-4** | Posting cadence | daily · monthly at close · on settlement | **accrue daily in the sub-ledger, post monthly at close**, plus a final accrual on settlement date | Daily GL postings produce thousands of journals a month and an unreadable ledger; monthly means the GL trails the sub-ledger intra-month. Which trade the accountant wants is theirs. |
| **D-5** | Which GL account, and whether the fee sits inside revenue | facility fee income within revenue · other income (finance) · offset to finance cost | **separate income account, outside the revenue line used for gross margin** (§5.6.5 maps it to `PL_OTHER_INCOME`) | See below — this one silently moves a number the whole financial model is built on. |
| **D-6** | **Is there a minimum charge**, and if so what | none · a floor per invoice per period (`fee_minimum_charge_minor`) | **none — `0`** | **New, and it was previously smuggled in as a rounding knob.** A floor fee raises the effective rate on a small balance without limit — a 5.00 floor on a 100.00 balance is 5%/month, not 2% — which is precisely what Q4's *"attracts lending/moneylending regulation"* question turns on. It is a commercial term, not a threshold, and it is now gated with the other five instead of shipping unconfirmed. |

**On D-5, specifically.** The financial model tracks blended gross margin to three decimal places
(19.325% → 24.500%) and the ERP is required to report actuals against that curve. Facility fee
income has no cost of goods behind it. Post it inside revenue and it lifts reported gross margin
without a single extra unit being sold — the margin bridge would look like it was working when it
was not. So whatever the accountant decides about presentation, **the margin report's revenue
denominator excludes facility fee income, and says so on its face.** Co-owned with
`ledger-engineer`; confirmed at the `CLAUDE.md` §2.8 gate.

**And the tax question, which now has its own number.** Is the facility fee a taxable supply?
Financial services have their own treatment. The fee line carries a tax code like any other line and
the correct code is a **jurisdiction-pack value** (`ADR-0007`) settled by the local professional at
that pack's review gate. This is `open-questions.md` **Q18**; §5.6.5 ships the fee account's tax
code **unset** and the rule fails loudly if a fee is raised before someone sets it.

### 6.4.3 The arithmetic

#### The day count, corrected

The previous draft claimed 30E/360 makes *"'2% per month' cost the same money in February as in
March"*, and §6.10 specified a test asserting a 28-day and a 31-day month produce **identical**
charges. **The claim was false and the test would have certified it.** Under plain 30E/360,
`days30(d1,d2) = 360Δy + 30Δm + (min(d2,30) − min(d1,30))`:

| Period | plain 30E/360 | reading |
|---|---|---|
| 31 Jan 2027 → 28 Feb 2027 | `30 + (28−30)` = **28** | 6.7% cheap |
| 31 Jan 2028 → 29 Feb 2028 | `30 + (29−30)` = **29** | 3.3% cheap, and different from the non-leap year |
| 28 Feb 2027 → 31 Mar 2027 | `30 + (30−28)` = **32** | 6.7% dear |

Worse than the reviewer's month-end examples, and more common: our `d2` is usually a **period end**,
because D-4 posts monthly at close. With any mid-month anchor, plain 30E/360 makes **every February
two days short for every account** — `10 Feb → 28 Feb` is 18 days where `10 Mar → 31 Mar` is 20.
That is a systematic February discount across the whole book, not an edge case.

**Adopted: 30E/360 ISDA**, which clamps the last day of a month — February included — to 30 at both
ends:

```
last_day(d)  := d is the final calendar day of its month
D1 := 30 if last_day(d1) else min(day(d1), 30)
D2 := 30 if last_day(d2) else min(day(d2), 30)
days30_isda(d1,d2) = 360*(y2-y1) + 30*(m2-m1) + (D2 - D1)
```

This restores the invariant for the cases that actually occur: `31 Jan → 28 Feb` = 30,
`31 Jan 2028 → 29 Feb 2028` = 30, `28 Feb → 31 Mar` = 30, `10 Feb → 28 Feb` = 20 = `10 Mar → 31 Mar`.
We do **not** adopt the ISDA carve-out that exempts a February end date when it is the maturity date;
we have no maturity leg, and the carve-out would reintroduce exactly the asymmetry we are removing.

**The residual anomaly, stated rather than hidden.** A `d1` that is the last day of February against
a `d2` that is not a month end gives 28 or 29 days: `28 Feb 2027 → 28 Mar 2027` = `30 + (28−30)` =
**28**. It requires the anchor — `due_date + grace_days` — to land on the last day of February
specifically, it is rare, and it errs in the customer's favour. It is documented here, it is in the
test sweep, and the ageing report's footnote names the convention.

#### One expression, three day-counts

The previous formula hard-coded `30` as the period length, so **two of the three `fee_day_count`
values had no formula anywhere in the document** while D-3 offered all three as live options. The
day-count is now a data row supplying a numerator function and a denominator, and the accrual engine
has one expression:

```
cumulative_fee = ( Σ_i  basis_i * rate_bp * numerator(seg_i) ) / (10000 * denominator)
```

| `fee_day_count` | `numerator(a,b)` | `denominator` | what `fee_rate_bp` means |
|---|---|---|---|
| `thirty_e_360_isda` | `days30_isda(a,b)` | `30` | per 30-day month, pro-rated |
| `actual_365` | `12 * (b - a)` calendar days | `365` | per month, annualised at ×12 |
| `whole_calendar_month` | `whole_months(a,b)` | `1` | per whole month, **no pro-rating** |

Under `whole_calendar_month` the segments are the whole-month intervals from the anchor, each
charging on the balance at the interval's **start**; a trailing partial interval contributes
nothing. That is the commercially standard reading of "no pro-rating" and it has a consequence the
accountant must see stated rather than discover: **a one-day-late invoice pays a full month, and a
mid-month payment does not reduce that month's charge.** D-3 exists to have that said out loud.

The scale-free property survives intact: **no currency scale appears in the expression.** No literal
`100`. It works unchanged for a zero-decimal or three-decimal currency, which is what `ADR-0007`
requires of anything that touches money. What broke it before was the day-count constant, and that
is now a value carried by the day-count row rather than a literal — which is also why there is no
`switch (fee_day_count)` in the accrual job.

#### The basis, and the bug that was in it

The previous formula was:

```
basis_minor    = invoice.outstanding_minor          -- the CURRENT balance
elapsed        = days30(due_date + grace, as_of)    -- the TOTAL elapsed time
cumulative_fee = (basis_minor * rate_bp * elapsed) / (10000 * 30)
```

**Current balance × total elapsed time is wrong, and it fails in the direction that silently gives
money back.** Worked, with the section's own shape:

> Invoice 12,000.00, overdue 60 days, 200 bp/month. Two monthly accruals of 240.00 posted and
> invoiced. On day 61 the customer pays 10,000.00. `outstanding` drops to 2,000.00.
> Next run: `cumulative = (200_000 × 200 × 60)/300_000 = 8_000` = 80.00.
> `delta = 8_000 − 48_000 = −40_000` — the job posts a **negative accrual of 400.00**: a refund of
> fees legitimately earned on a 12,000.00 balance, with no reason code, no authorising user, and
> bypassing the `fee_waiver` control §6.4.4 insists on. It lands in the current open period against
> an already-closed period's charge, which is exactly what §5.3's *"the GL never retro-restates a
> posted entry"* exists to prevent.

The section's headline safety claim — *"truncation error is bounded at under one minor unit per
invoice for all time"* — was true of truncation and irrelevant, because truncation was not the
dominant error.

**Corrected: the accrual is time-weighted over balance segments.**

```
t0 = due_date + fee_grace_days                       -- 0 contribution before this (D-1(b))
B  = { t0, as_of } ∪ { business_date of every entry that changed this invoice's basis,
                       clipped to (t0, as_of) }
for each consecutive pair (a, b) in sorted(B):
    basis_i = the invoice's basis as at a, after all entries dated <= a
    num_i   = numerator(a, b)                        -- per the day-count row
cumulative_fee = ( Σ_i basis_i * rate_bp * num_i ) / (10000 * denominator)

delta = cumulative_fee - Σ(posted fee_accrual + fee_waiver entries for this invoice)
```

Three rules that are not optional:

- **Every operand is `bigint` and there is exactly one division, at the end.** Dividing per segment
  would lose a fraction on every segment; dividing once bounds truncation at under one minor unit
  per invoice for all time — which is what the previous draft claimed and now earns.
- **The basis is an explicit predicate, not "the outstanding".** `B-6`: with `fee_on_fee = false` —
  D-2's default — the basis is the invoice's **trade** outstanding, `excluding entry_type IN
  ('fee_accrual','fee_waiver')`. Nothing in the previous draft excluded them, so month 2's basis
  included month 1's fee and **the fee compounded** — the exact behaviour D-2 defaults *off*. With
  `fee_on_fee = true` the fee entries enter the basis and the compounding is deliberate.
- **`delta < 0` never posts silently.** A negative delta is a refund, and refunds have authorisers.
  It raises a `fee_recomputation_variance` review item to Accounts with the segment table attached;
  if the reduction is agreed, the resolution posts a **`fee_waiver`** — a contra entry with a reason
  code and an authorising user, per §6.4.4 — and never a negative `fee_accrual`. Under
  time-weighting a partial payment no longer produces a negative delta at all; what remains are
  genuinely human cases: a superseding **reallocation** that moves cash off an old invoice, a
  back-dated credit note, or a policy correction. Each of those is a decision somebody made, so each
  gets a person's name on the reversal.
- **A delta arising from a change to a closed period posts into the current open period**, carrying
  a reference to the period it relates to. §5 never retro-restates.

**Truncation always favours the customer**, and because the computation is cumulative that loss does
not accumulate over time. For a charge argued about across a counter, erring in the customer's
favour is the right direction.

#### Overflow, with the arithmetic corrected

The previous paragraph got its own numbers wrong by 10× and its conclusion wrong by two orders of
magnitude, in the one place whose purpose was arithmetic rigour. Restated:

- A 10,000,000.00 balance is `1e9` minor units. `1e9 × 300 × 30 = 9×10¹²`. Against `int64` max
  `9.22×10¹⁸` that is **six** orders of magnitude of headroom, not four.
- The *worst realistic* case is not a 30-day segment. A three-year-overdue invoice under a single
  segment gives `elapsed ≈ 1080` and a product of `3.24×10¹⁴` — still four and a half orders inside
  `int64`, and time-weighting makes each segment's product **smaller** than the single-segment
  figure, never larger.
- `elapsed` is bounded server-side regardless: `credit_policy.fee_accrual_stop_days` ends accrual on
  an invoice past that age. That is a real control, not an overflow guard — an invoice accruing a
  fee forever is a collections failure being papered over by a growing receivable — and it needs a
  value from the accountant alongside D-1…D-6.

#### Worked example — the mid-month case D-3 exists to answer

Invoice dated 12 Feb 2027, 12,000.00 (`1,200,000` minor units), 30-day terms, 200 bp/month, no
grace, no intervening payment (so one segment). Due `12 Feb + 30 calendar days = 14 Mar 2027`.
Paid 2 Apr 2027.

```
days30_isda(2027-03-14, 2027-04-02):  D1 = 14 (not a month end), D2 = 2 (not a month end)
                                    = 30*(4-3) + (2 - 14) = 18
fee = (1_200_000 * 200 * 18) / (10_000 * 30) = 4_320_000_000 / 300_000 = 14_400 minor units
    = 144.00
```

Cross-check: 2% of 12,000.00 is 240.00 for a full month; 18/30 of that is 144.00. ✓

**Now the same invoice with a part payment on 24 Mar of 8,000.00**, which is the case the previous
formula got wrong:

```
segments:  [14 Mar → 24 Mar)  basis 1_200_000  num = 30*0 + (24-14) = 10
           [24 Mar →  2 Apr)  basis   400_000  num = 30*1 + (2-24)  =  8
cumulative = (1_200_000*200*10 + 400_000*200*8) / (10_000*30)
           = (2_400_000_000 + 640_000_000) / 300_000 = 3_040_000_000/300_000 = 10_133 minor units
           = 101.33
```

The old formula would have returned `(400_000 × 200 × 18)/300_000 = 4_800` = 48.00 — under half,
and if 144.00 had already been posted it would have booked a **−96.00 refund**.

Note the two conventions doing different jobs. The **due date uses calendar days** — terms are a
promise made to a customer in real days. The **fee uses 30E/360 ISDA**. Someone will eventually try
to unify these. They must not; unifying them either makes February cheap or makes a "30-day" invoice
fall due on a date the customer was never told.

### 6.4.4 Posting

Under D-4's provisional default, at each period close, **one journal per credit account** (§5.6.2
rule 8):

```
Dr  Accounts receivable — facility fees      (sub-account, distinct from trade AR)
  Cr  Facility fee income                     (per D-5; §5.6.5 maps it to PL_OTHER_INCOME)
```

- **Fee receivable is a separate AR sub-account from trade receivable.** Otherwise accrued fees
  inflate the receivables balance DSO is computed from (§6.9), and DSO stops measuring how fast
  customers pay for goods. This is the same split as `trade_exposure` / `fee_exposure` in §6.2 and
  it has to hold in both places or neither.
- **A waived fee is a contra entry, never a deleted accrual.** `fee_waiver` posts against the same
  invoice with a reason code and the authorising user (§5.6.2 rule 8b: a contra entry, because §5.3
  makes a reversal line-for-line, whole-entry and once ever). Deleting a posted accrual would break
  the sub-ledger-to-GL reconciliation, and "who waived 4,000.00 of fees and why" is exactly the
  question an audit asks.
- **Two idempotency keys, because there are two cadences.** The previous text specified
  `unique (tenant_id, credit_account_id, period_id)` on posted accruals — correct for the GL journal
  and wrong for the sub-ledger, which under D-4 writes a delta **per invoice per day**. Against a
  per-period key a daily run collides and silently accrues nothing after day 1; without a key it
  double-posts on a retried job. Per §3.11.7 both are deterministic `write_id`s:

  | Layer | Key | Grain |
  |---|---|---|
  | Sub-ledger `credit_entry` | `uuidv5(ns, 'fee_accrual:'‖invoice_id‖':'‖as_of_date)` | invoice × day |
  | GL journal | `uuidv5(ns, 'fee_accrual_je:'‖credit_account_id‖':'‖period_id)` | account × period |

  §3.11.7's worked example uses the account-and-period form for the sub-ledger and needs amending
  (§6.12.2). Re-running a closed period posts nothing rather than doubling the charge; re-running a
  day's sub-ledger pass is an insert conflict, not a duplicate.

```sql
select app.new_tenant_table('fee_accrual_detail', $$
  fee_entry_id      uuid not null,          -- the credit_entry this explains
  invoice_id        uuid not null,
  segment_no        smallint not null,
  segment_from      date not null,
  segment_to        date not null,
  basis_minor       app.money_minor not null,
  rate_bp           app.bp not null,
  day_count         fee_day_count not null,
  numerator         integer not null,
  denominator       integer not null,
  contribution_minor app.money_minor not null,   -- pre-division contribution, for audit
  foreign key (tenant_id, fee_entry_id) references app.credit_entry (tenant_id, id),
  check (deleted_at is null),
  check (segment_to > segment_from),
  unique (tenant_id, fee_entry_id, segment_no)
$$);
```

### 6.4.5 The gate, bound to content rather than to a timestamp

D-1 through **D-6** are `NEEDS-HUMAN` and they block Phase 1 credit go-live. The failure mode is
obvious: the mechanism ships, the template defaults are sitting right there, and the business starts
charging on values no accountant ever confirmed because the software made it easy.

The previous gate was `fee_confirmed_at timestamptz` set by *"a human with the Accounts role"*, and
it had three holes. All three are closed:

- **It required a permission, not a qualification.** `CLAUDE.md` §2.8 requires a *qualified
  accountant*; at tenant #1 the Accounts permission belongs to a bookkeeper. The gate now records
  `fee_attestation` — the attesting professional's qualification and body — alongside the identity,
  and the §2.8 reviewer is the same person who reviews the chart of accounts. **Who that is remains
  `open-questions.md` Q6, still unnamed.**
- **It was walk-around-able.** Confirmation was a timestamp on a mutable row: confirm on Monday with
  `fee_basis = overdue_balance`, edit `fee_basis` on Tuesday, and `fee_confirmed_at` was still set.
  **Confirmation is now bound to content.** `fee_confirmed_hash` is a SHA-256 over the canonical
  encoding (RFC 8785, per §3.11.6) of the confirmed values — basis, compounding, `fee_on_fee`,
  day-count, grace days, cadence, `fee_minimum_charge_minor`, `fee_accrual_stop_days` — and **the
  accrual job recomputes it against the live row on every run and refuses to post on any mismatch.**
  Changing a confirmed value therefore un-confirms the policy, loudly, at the next run. A confirmed
  policy row is additionally immutable on those columns: changing the mechanics means a **new
  effective-dated row**, which needs its own confirmation.
- **`fee_confirmed_by` had no FK.** It has one.

The rest of the gate stands:

- **The accrual job refuses to post to the GL while the policy is unconfirmed. It fails loudly; it
  does not skip quietly.**
- It *does* still compute, in **shadow mode**. This is genuinely useful: the business gets to see
  what the fee would earn before deciding how to structure it, which is the input Q4 actually needs.
- **Shadow accruals are not `credit_entry` rows, and that is a correction.** The previous text
  flagged them `provisional = true` on a column that did not exist in the DDL — and if they had been
  `credit_entry` rows of type `fee_accrual` they would, by §6.2's own definitions, have entered the
  balance, consumed headroom, raised exposure exceptions and **caused a till to refuse a credit
  sale** on the strength of a charge the section says is not chargeable. A gate whose purpose is to
  stop the business *charging* on unconfirmed values would instead have started it *enforcing* on
  them. Shadow accruals live in their own table with no path into any sum:

```sql
select app.new_tenant_table('fee_accrual_shadow', $$
  invoice_id        uuid not null,
  credit_account_id uuid not null,
  as_of_date        date not null,
  cumulative_minor  app.money_minor not null,
  delta_minor       app.money_minor not null,
  policy_id         uuid not null,             -- which unconfirmed policy produced it
  check (deleted_at is null),
  unique (tenant_id, invoice_id, as_of_date)
$$);
```

- Every shadow figure carries a **"provisional — not chargeable"** label in every screen and every
  export. It is not enough that it is a row in a separate table; someone will quote a number off a
  report to a customer.

---

## 6.5 Network-wide exposure, and what a till is allowed to hold

A credit customer buys at one location on Monday and at another on Wednesday. **The limit is against
the account.** `credit_account` has no `location_id`; `credit_entry.location_id` exists for
attribution and reporting only, and it **never** scopes a balance query and never scopes a sync
rule.

```
trade_exposure(account)  = Σ credit_entry.amount_minor  excluding fee entries        -- §6.2
available(account)       = credit_limit_minor - trade_exposure(account)
exposure_by_location(a)  = Σ ... group by location_id                                -- reporting only
```

**This collides head-on with the location-scoped sync model, and the previous draft resolved the
collision the wrong way.** It synced a `credit_account_snapshot` — *"account id, customer, status,
current limit, current balance, bucket totals"* — for **every active account in the tenant**, to
every device. §3.2.2 rules the opposite, in bold: *"The credit book never reaches an outlet device;
a bounded allowance does. `credit_account`, the limit, the balance, the ageing and the payment
history are not on a till, in any bucket, at any permission an outlet role holds."* §3 introduced
the `location_credit_allowance` bucket specifically to close this contradiction, reconciled it with
§6.7, and left §6.5 as written. §3 governs. §6.5 is rewritten against it.

The stakes are not abstract: under the old design a stolen micro-outlet tablet disclosed every
credit customer's limit, balance and ageing across the whole network. Under the new one it discloses
what one outlet may lend one customer today, for the customers who trade at that outlet.

**What a till holds.** One `credit_allowance` row per credit customer **for its own location**:

```sql
select app.new_tenant_table('credit_allowance', $$
  location_id           uuid not null,
  customer_id           uuid not null,
  cap_minor             app.money_minor not null check (cap_minor >= 0),
  headroom_minor        app.money_minor not null check (headroom_minor >= 0),
  offline_ceiling_minor app.money_minor,
  credit_hold           boolean not null default false,   -- projection of customer.credit_hold
  cap_valid_until       timestamptz not null,             -- the lease. §6.7.
  cap_version_id        uuid not null,
  snapshot_as_of        timestamptz not null,             -- for display
  snapshot_as_of_hlc    app.hlc not null,                 -- for arithmetic. B-4.
  unique (tenant_id, location_id, customer_id)
$$);
```

It is a **server-derived row** (§3.11.7, §4.17.3): recomputed server-side and pushed, never written
by a device. The server's derivation, stated so it is testable:

```
headroom_minor = max(0, min( cap_minor,
                             credit_limit_minor - trade_exposure(account) ))
snapshot_as_of_hlc = the server HLC through which trade_exposure was evaluated
```

**What the till computes, and the double-count bug that is now closed.** The previous formula was
`displayed_available = snapshot.limit - (snapshot.balance + sum(local unsynced entries))`. Beyond
needing `limit` and `balance` the device is not allowed to have, the `local unsynced` term is a
**client-side flag**, and a flag has a window in both directions:

> A credit sale is uploaded and acknowledged at 14:02; the refreshed allowance arrives at 14:07.
> Between those two moments the sale is neither `unsynced` (it was acked) nor in the server's
> headroom — headroom is overstated and the till over-lends. Flip the client to "count until the
> snapshot moves" and the window inverts: from 14:07 the sale is counted twice and the till refuses
> a real sale the customer is entitled to. Both failures are silent, both are at the counter, and
> both are in the two categories `CLAUDE.md` §2.2 names by name.

**The term is causal, not flag-based.** §3.3.4's upload response returns the **server-stamped HLC**
for each accepted write, so the device knows, for each of its own credit sales, the server HLC
assigned to it:

```
local_deduction = Σ |amount| over credit sales originated at THIS location where
                      ack_hlc IS NULL                              -- not yet uploaded
                   OR ack_hlc > allowance.snapshot_as_of_hlc       -- uploaded, not yet in this snapshot

sellable_now    = max(0, min( allowance.headroom_minor - local_deduction,
                              allowance.cap_minor ))
per_sale_cap    = allowance.offline_ceiling_minor        -- §6.7
```

Both windows close: an acked-but-not-yet-reflected sale is still deducted, and the moment a snapshot
arrives with `snapshot_as_of_hlc >= ack_hlc` it stops being deducted. The device is comparing two
server-generated HLCs, never a device clock against a server one.

**Sync rule (handoff to `sync-architect` and `rbac-security-engineer`), aligned to §3.2.2/§3.2.3:**

| Bucket | Audience | Contents |
|---|---|---|
| `location_credit_allowance` `(tenant_id, location_id)` | holders of **`credit.sell`** scoped to that location | `credit_allowance` for that location only |
| `tenant_customers` `(tenant_id)` | all POS users | `customer` identity, `credit_hold`, `has_open_conflict`. **No balances, no limits, no ageing.** |
| `tenant_credit` `(tenant_id)` | holders of **`credit.read`** | `credit_account`, `credit_limit_version`, `credit_entry` (`archived_at IS NULL`), ageing snapshots |
| `tenant_reviews` `(tenant_id, review_queue)` | reviewers, intersected with location scope | `conflict_review` summaries — **including credit limit forks and exposure breaches** (§6.6, §6.7) |
| `location_ops` `(tenant_id, location_id)` | users scoped to that location | `sale` and its children, and **`credit_refusal`** (§6.7) |

**Not synced to an outlet device, at any permission an outlet role holds:** `credit_account`, the
limit, `credit_entry`, ageing, payment history, `fee_accrual_detail`, `fee_accrual_shadow`,
`credit_allocation`, and the heavy `conflict_review_context` blob, which §3.6.2 fetches online when
a reviewer opens an item.

Costs, both real and both accepted:

- **Staff cannot answer "what did I buy in March?" at a disconnected counter.** That is the right
  trade for a device that lives in a shop and can be stolen.
- **The till cannot state the customer's limit**, only what it may lend here today. That is not a
  degradation — with the network down it does not *know* the network position, so it is the only
  sentence it is entitled to say. §6.8.

---

## 6.6 Conflict case (a) — concurrent credit **limit** edits

The canonical hard case named in `CLAUDE.md` §2.2, and the case §3.6.1 works end to end as conflict
class **#6, `REVIEW (sev 1) — always`**. A credit limit is a **risk judgement**. Two people, both
offline, each set the same customer's limit — one raising it having seen a deposit arrive, one
lowering it having heard the customer is slow paying. Last-write-wins does not resolve this. It
silently discards one person's judgement, and which one it discards depends on arrival order.

**Make the limit an append-only decision log, and make the conflict structurally visible.**

```sql
create type limit_state as enum ('accepted','pending_review','superseded','rejected');

select app.new_tenant_table('credit_limit_version', $$
  credit_account_id uuid     not null,
  limit_minor       app.money_minor not null check (limit_minor >= 0),
  terms_days        smallint not null check (terms_days >= 0),
  fee_rate_bp       app.bp   not null check (fee_rate_bp >= 0),
  reason_code       text     not null,
  note              text,
  supersedes_id     uuid,                  -- the version the author believed was current
  state             limit_state not null,
  decided_by        uuid     not null,
  decided_at_location uuid,
  effective_from    date     not null,
  foreign key (tenant_id, credit_account_id) references app.credit_account (tenant_id, id),
  foreign key (tenant_id, supersedes_id)     references app.credit_limit_version (tenant_id, id),
  check (deleted_at is null)
$$);

-- The fork detector as a constraint. NULLS NOT DISTINCT (PG15+) so that two devices
-- both writing the FIRST version of an account collide instead of both being accepted:
-- with default NULLS DISTINCT the root case failed OPEN. M-12.
create unique index credit_limit_one_accepted_child
  on app.credit_limit_version (tenant_id, credit_account_id, supersedes_id)
  nulls not distinct
  where state = 'accepted';
```

### 6.6.1 How this reconciles with §3 and §4, which is not optional

Three sections described the credit limit three different ways, and until this revision the
representation was genuinely unresolved rather than merely under-documented. §4.9 ships
`credit_account.credit_limit_minor` with `limit_set_by` / `limit_set_hlc` / `limit_write_id`;
§3.6.1 assumes a mutable row with `base_row_hlc` CAS and reconstructs the ancestor from
`app.row_version`; §6 had a version log and no column at all. The failure that produces: **a limit
that is not a mutable row writes no `row_version` entry, so §3.6.1's ancestor reconstruction has
nothing to read, and its stated fallback — *"a value whose ancestor cannot be reconstructed is never
auto-reverted"* — fires on every single edit.** Every limit change becomes a frozen severity-1
review.

They are reconciled, not chosen between, because the two mechanisms are isomorphic:

| §3's mechanism | §6's mechanism | Ruling |
|---|---|---|
| `base_row_hlc` on the mutation | `supersedes_id` on the version | **`supersedes_id` *is* the CAS.** Same detector, expressed as data rather than as a predicate. A write declares which version it believed it was replacing. |
| `app.row_version` supplies the ancestor | the parent version supplies the ancestor | **`credit_limit_version` is the version history for this field**, and a better one: it is permanently retained, where `row_version` ages out at the tenant's retention floor. §3.6.1's "unreconstructable ancestor" branch therefore never fires for a credit limit. |
| `credit_account.credit_limit_minor` is the row | the log is the authority | **The column is a server-maintained projection of the accepted head.** §4.9's DDL survives verbatim; what changes is that no application role holds `GRANT UPDATE` on it. Only the version-apply trigger writes it, so there is exactly one write path. |
| resolution via `conflict_review` (§3.6.2) | a parallel `credit_review_item` | **`conflict_review` only.** §6's parallel table is deleted; see `M-10`. |

`limit_set_by` / `limit_set_hlc` / `limit_write_id` project from the accepted head version and
answer §4.9's stated need — *"which of these was later, and who made each"* — without a second
source of truth. §4.9's sentence *"the account is frozen at the pre-conflict value"* is exactly
§3.6.1's revert-to-ancestor, and §4.9's reference to `sync_conflict` kind `CONCURRENT_FIELD_EDIT` is
already superseded by §4.12, which deleted `app.sync_conflict` in favour of `conflict_review`.

### 6.6.2 Ordering: which version is in force, and on what date

`M-12`'s second half. Two orderings exist — the `supersedes_id` chain and `effective_from` — and
nothing forbade them disagreeing, which left `credit_exposure_exception.limit_in_force_minor` (*"the
accepted limit version at the entries' business date"*) undefined. The rules:

- **The chain is the authority for "which version is current."** Exactly one accepted version has no
  accepted descendant; that is the head. A trigger asserts it, because the partial unique index
  constrains children-per-parent and does not by itself forbid two accepted forks branching at
  different depths.
- **`effective_from` is the authority for "which version applied on business date D",** and it is
  constrained to be **non-decreasing along the chain**: a version may not carry an `effective_from`
  earlier than its parent's. With that, "the accepted version with the greatest `effective_from ≤ D`"
  is unique and the two orderings cannot disagree.
- A version may be future-dated; until `effective_from` arrives the projection on `credit_account`
  reads the previous version, and a scheduled server write advances it.

### 6.6.3 On fork: the interim rule, corrected

**The previous draft set the interim limit to `min(version_a, version_b)`. That is the rule §3.6
rules out by name.** §3.6 class #6 reads *"No auto rule. Not LWW. **Not 'lower wins'."*** and
§3.6.1 closes: *"There is no 'take the minimum' rule. It is superficially attractive and it is wrong
twice over"* — it silently discards a deliberate commercial decision, and it can strand a customer
mid-project with nobody accountable for the choice. §3 is the ruling section. The `min()` rule is
deleted.

The asymmetric-risk argument behind `min()` is not wrong in the abstract. It lost, and this section
says so rather than quietly shipping the losing side: under `min()` two engineers implement two
different numbers from two approved sections of the same document, and whichever ships, the other
section's tests fail.

**Adopted, per §3.6.1, on fork:**

1. **Neither forked version is accepted.** Both move to `pending_review`.
2. **Any already-applied fork member is reverted to the ancestor** — the target of `supersedes_id`,
   which §6.6.1 guarantees is always reconstructable for a limit. The revert is a **server-originated
   write** (`origin='SERVER'`, platform system actor, server-generated HLC, deterministic
   `write_id`), because a schema that forced a user id here would attribute an automatic reversion
   to a human.
3. **The author whose change was reverted is notified by name, with the reason.** Reverting silently
   would be as bad as overwriting silently.
4. **The interim limit is the ancestor.** Credit sales are permitted up to it and blocked above it,
   with an on-screen instruction to call Accounts. Head of operations can override with a mandatory
   note. In §3.6.1's worked numbers: a customer at an agreed 50,000 whose limit is concurrently
   raised to 80,000 and lowered to 30,000 can transact **up to 50,000** while Accounts decides — not
   30,000.
5. **The revert re-runs the exposure check** and raises a `credit_exposure_breach` if the reverted
   limit is now breached by sales that landed against the higher one (§3.6.1's step 2, the case the
   revert does not otherwise fix).
6. **Third parties join the open review; they do not open a second one.** A third location's version
   arriving later against the same base is appended to the existing review's proposals. An N-party
   merge is one decision, not N−1 pairwise ones.
7. **Severity-1 credit resolutions require connectivity.** §3.6.1's rule, imported: two offline
   reviewers each resolving one review is a resolution-of-a-resolution recursion that class #19's
   CAS does not close, because the loser's value write has already been applied locally. The queue
   says so on the device.

### 6.6.4 The review item is a `conflict_review` row, not a second queue

`credit_review_item` is **deleted**. §3.6.2 owns the review queue; it has the escalation chain, the
`escalate_only` policy that hardens to `credit_hold` at the final step, the dedupe, the notification
ceiling, the `tenant_reviews` bucket that actually reaches a reviewer's device, and the rule that
*"the review queue has no back door into the data."* A parallel table had none of those — no bucket,
so it never reached a device; no escalation, so it never hardened; no primary key, no `write_id`, no
FK and no RLS. It was §6.11's own Concern 3 (*"an exception queue nobody has been made accountable
for is a list that grows"*) made structural.

What this section contributes is **two `conflict_class` rows and two typed detail tables**:

| `conflict_class` | §3.6 class | Severity | Expiry policy | Detail table |
|---|---|---|---|---|
| `credit_limit_fork` | #6 | 1 | `escalate_only`, hardening to `credit_hold` | `credit_limit_fork_detail` |
| `credit_exposure_breach` | #10 | 2 | `escalate_only`, hardening to `credit_hold` | `credit_exposure_breach_detail` |

```sql
select app.new_tenant_table('credit_limit_fork_detail', $$
  conflict_review_id  uuid not null,
  credit_account_id   uuid not null,
  ancestor_version_id uuid,                       -- null only if the account has no ancestor
  forked_version_ids  uuid[] not null,
  -- captured at detection because it is unreconstructable later
  trade_exposure_at_detection_minor app.money_minor not null,
  sales_under_each    jsonb not null,             -- money as DECIMAL STRINGS (§3.11.10 #20)
  unique (tenant_id, conflict_review_id)
$$);
```

Money inside any `jsonb` is a decimal **string**, never a number: `JSON.parse` yields float64, which
`ADR-0004` calls fatal, and this is the path on which a human reads a credit limit and re-enters it.

### 6.6.5 `state` is mutable, and its mutations are whitelisted

`credit_limit_version` is described as append-only, and `state` transitions. §3.2.4 establishes the
pattern for exactly this: on an append-only table there is **one whitelisted mutation**, enforced by
column-level `GRANT UPDATE` plus a trigger that permits one set of transitions and no other. Applied
here:

```
pending_review -> accepted | rejected        (resolution, server-side, requires connectivity)
accepted       -> superseded                  (a later accepted version supersedes it)
accepted       -> pending_review              (fork detected after the fact; the revert path)
anything else                                 -> refused by trigger
```

`GRANT UPDATE (state)` goes to the resolution role only. Every transition writes through the normal
write path with its own `write_id` and audit row.

### 6.6.6 Two rules that fall out, and are easy to get wrong

- **A limit decrease below current exposure is legal and must be accepted.** It means "no further
  credit", not "reverse the sales". Any check that rejects `new_limit < trade_exposure` is a bug.
- **`credit_limit_version` is Accounts-and-above only** (`CLAUDE.md` §2.6). Outlet staff and outlet
  managers cannot write it. This narrows how often case (a) occurs — but it does not eliminate it,
  because Accounts and head-of-operations users also work from locations that go offline.
  Restricting the permission is a frequency reduction, not a solution, and should never be presented
  as one. **§3.6.1's worked example has an *outlet manager* lowering a limit, which this permission
  model forbids;** `CLAUDE.md` §2.6 sides with §6, so §3's example needs the actor corrected
  (§6.12.2).

---

## 6.7 Conflict case (b) — concurrent credit **sales** against the same limit

**Do not confuse this with case (a).** Two locations, both offline. The account's limit is 8,000 and
it is unused. One sells 5,000 on credit; the other sells 5,000 on credit. Neither device can see the
other. Exposure lands at 10,000 against an 8,000 limit.

**No protocol prevents this.** Enforcing a global invariant requires either a quorum or a
partition-tolerant reservation, and both need connectivity — the one thing the product cannot
assume. Choosing availability here is not an oversight; it is `CLAUDE.md` §2.2 read correctly: **a
sale must never be lost.** The alternative — refusing all credit sales while offline — would delete
the feature in the exact market the product exists to serve.

So:

**1. Both sales are valid and both are recorded.** Never discard a real sale to make a limit hold.
The goods are gone; the customer owes the money; deleting the record does not un-sell them, it just
loses the receivable. And because the entry log is append-only (§6.2), there is no data-layer
conflict. The **invariant** breaks. The **data** does not. This is §3.6 class #10, `AUTO+FLAG`.

**2. The breach is detected server-side on sync** and raised as a `conflict_review` of class
`credit_exposure_breach` (§6.6.4) with a typed detail row:

```sql
select app.new_tenant_table('credit_exposure_breach_detail', $$
  conflict_review_id     uuid not null,
  credit_account_id      uuid not null,
  limit_version_id       uuid not null,          -- the accepted version in force on the entries'
                                                 -- business date, per §6.6.2
  limit_in_force_minor   app.money_minor not null,
  exposure_before_minor  app.money_minor not null,
  exposure_after_minor   app.money_minor not null,
  contributing_entry_ids uuid[] not null,
  detection_key          bytea not null,         -- see below
  unique (tenant_id, conflict_review_id),
  unique (tenant_id, credit_account_id, detection_key)
$$);
```

**Re-detection is a no-op, by key.** The previous draft asserted in its own tests that *"exactly one
exception is raised"* with nothing enforcing it: a detection pass that ran twice on a sync retry
raised two, and Accounts worked a duplicate queue. The `write_id` is deterministic in the shape
§3.11.7 already uses:

```
detection_key = md5( sorted(contributing_entry_ids) )
write_id      = uuidv5(ns, 'credit_exposure_breach:'‖credit_account_id
                              ‖':'‖limit_version_id‖':'‖detection_key)
```

Re-running detection over the same entry set inserts nothing. A *new* breaching entry produces a
different set, a different key and a new item — correct, because it is a new breach.

**3. Each contributing sale carries what the device thought it knew.** This is what makes the
exception reviewable rather than merely alarming. These are columns on `app.sale` as defined in
§4.8, not an `ALTER` — the previous draft's `alter table sale add column credit_limit_check text not
null` with no `DEFAULT` would not run against an existing table:

```sql
create type credit_limit_check as enum
  ('verified_online','unverified_offline','sub_limit_only','manager_override');

-- on app.sale (§4.8):
--   credit_limit_check        credit_limit_check,        -- null for a cash sale
--   believed_available_minor  app.money_minor,
--   snapshot_as_of            timestamptz,
--   snapshot_as_of_hlc        app.hlc,
--   offline_authorised_by     uuid references app.user_account
--   check (credit_limit_check is null) = (tender has no credit component)
```

Without these, every breach looks the same. With them, Accounts can distinguish *"the device was
blind and did the best it could"* from *"a manager overrode a limit they could see"* — and those two
get different conversations.

**4. Resolution is a human decision, and none of the options delete a sale.** Accounts may raise the
limit (writing a new `credit_limit_version` with reason code `breach_ratified`), place the customer
on `credit_hold` so no further credit sales are possible until exposure is brought under, demand
immediate payment, or apply the security deposit. **The system never auto-raises a limit to make a
breach disappear.** At the final escalation step the `escalate_only` policy hardens to
`credit_hold` — inaction has a consequence that is safe, loud and attributable.

### 6.7.1 Soft controls that degrade honestly

Prevention is impossible; **bounding the damage is not.** Three controls, all per-tenant policy.

**Per-location cap — and it is a lease, not a static number.** §4.9 declares this section's
`credit_account_location_cap` canonical and then supplies the mechanism this section lacked, with a
worked failure the static version cannot survive:

> HQ cuts one location's slice from 120,000 to 40,000 on Tuesday and reassigns 80,000 to another;
> the first location is offline until Friday and is still enforcing 120,000. **The same 80,000 is
> lent twice**, both sales are valid, offline and irreversible — and it is a breach the system's own
> control action created.

§4 records this as accepted with the *"locally sound"* claim withdrawn. Imported here:

```sql
select app.new_tenant_table('credit_account_location_cap', $$
  credit_account_id uuid not null,
  location_id       uuid not null,
  cap_minor         app.money_minor not null check (cap_minor >= 0),
  valid_from        timestamptz not null,
  valid_until       timestamptz not null,     -- A LEASE.
  acknowledged_at   timestamptz,              -- reported by the holding location's device
  supersedes_id     uuid,                     -- append-only, like credit_limit_version
  foreign key (tenant_id, credit_account_id) references app.credit_account (tenant_id, id),
  foreign key (tenant_id, supersedes_id) references app.credit_account_location_cap (tenant_id, id),
  check (deleted_at is null),
  check (valid_until > valid_from),
  unique (tenant_id, credit_account_id, location_id, valid_from)
$$);
```

Two rules, stated explicitly because the asymmetry is the whole point:

- **An increase takes effect immediately.** It is the safe direction.
- **A decrease takes effect at the holding location only on acknowledgement or lease expiry, and the
  reassignment is not issued until then.** Headroom is either leased to one location or free; it is
  never both. `cap_lease_days` (default 7) bounds how long a dark device can hold a stale cap, and
  the device stops lending on credit entirely once `cap_valid_until` passes — which is a refusal,
  recorded as one (below).
- Cap edits route through the **same conflict class as the limit**. They are the same class of risk
  decision, and the first draft protected the limit and left the cap as an ordinary mutable row.

Caps may sum to more than the account limit — that is expected, and the point is that each device
bounds *its own* contribution. True maximum offline exposure is `Σ(live caps)`, which is a risk
number the tenant chooses, not a limit the system enforces.

| Control | Mechanism | What it costs |
|---|---|---|
| **Per-location cap (leased)** | above | A customer with real headroom can be refused at one location while it sits unused at another. Needs a manager override path or it will be resented. |
| **Offline single-sale ceiling** | `credit_policy.offline_ceiling_minor`, projected into `credit_allowance` | Worst-case breach becomes `ceiling × offline locations` rather than unbounded. It also refuses exactly the large credit sale the business most wants — so the ceiling is a commercial decision set per tenant, never an engineering default. §6.7.2. |
| **Manager authorisation above a threshold** | `offline_auth_threshold_minor`; the authorising user is recorded in `sale.offline_authorised_by` | Prevents nothing. It attaches a name to the risk, which is what makes the exception review a conversation instead of a mystery. |

`location_sub_limit_mode` has three defined values and none of them is a comment: `off` — no cap,
`headroom_minor = available(account)` clipped at nothing; `fixed` — the cap is the leased
`cap_minor`; `share_of_limit` — the cap is derived by the server as a tenant-configured percentage
of `credit_limit_minor`, re-derived on every limit change and re-leased. The previous draft named
`share_of_limit` and defined it nowhere.

**Rejected: staleness-decayed headroom** — full headroom on a fresh snapshot, 50% at a day old,
sub-limit beyond. It models the risk more finely and it is the kind of thing that looks clever in a
design document. It fails the counter test: staff have to explain the number to a customer standing
in front of them. *"Your limit is 8,000 but we can only do 4,000 today because we're offline"* is
explainable. A decaying function is not. Cap plus ceiling plus override, all fixed numbers a person
can say out loud.

### 6.7.2 Refusal: the path above the ceiling, and the record of every refusal

This section refuses valid business in five places — the ceiling, an exhausted cap, an expired cap
lease, the ancestor limit during a fork, and a hold. The previous draft acknowledged the cost of the
first and designed neither a path nor a record. Both are now specified, because **the cost of the
controls was unmeasurable and the tenant tuning `offline_ceiling_minor` was tuning blind.**

**The above-ceiling path.** A credit sale above `offline_ceiling_minor` cannot complete as a credit
sale offline. It is not, however, a dead end at the counter — that would be the one place this
section loses a sale outright, having invoked *"a sale must never be lost"* as the reason not to
block credit sales generally. The till offers, in order:

1. **Part-payment down to the ceiling** — take cash or mobile money for the excess and put the
   remainder on credit. Usually the right answer and the fastest.
2. **Cash or mobile money in full.**
3. **A proforma / delivery note, held for sync** — the goods are reserved, the credit sale is
   completed when the device reconnects and the server confirms the limit. This is the same document
   shape `open-questions.md` **Q8** already contemplates for Ghana's e-VAT clearance regime, so it is
   not a bespoke mechanism.
4. **Manager authorisation, if the tenant permits it.** Whether a manager may exceed the ceiling is a
   **tenant policy value**, not a platform rule — `offline_ceiling_override_permitted`, default
   **off**, because the ceiling exists precisely to bound the unbounded case. If it is on, the sale
   is stamped `manager_override` and the authoriser's name is on it.

**Every refusal is an event.** A `credit_refusal` row is written at the till, syncs through
`location_ops`, and is reported:

```sql
create type credit_refusal_reason as enum
  ('ceiling','cap','cap_lease_expired','limit','fork_interim','hold');
create type credit_refusal_outcome as enum
  ('part_paid','cash','proforma','overridden','abandoned');

select app.new_tenant_table('credit_refusal', $$
  location_id      uuid not null,
  customer_id      uuid not null,
  reason           credit_refusal_reason not null,   -- 'ceiling'|'cap'|'cap_lease_expired'
                                                     -- |'limit'|'fork_interim'|'hold'
  requested_minor  app.money_minor not null check (requested_minor > 0),
  sellable_minor   app.money_minor not null,         -- what the till could have done
  snapshot_as_of   timestamptz not null,
  snapshot_as_of_hlc app.hlc not null,
  outcome          credit_refusal_outcome not null,  -- 'part_paid'|'cash'|'proforma'
                                                     -- |'overridden'|'abandoned'
  business_date    date not null,
  check (deleted_at is null)
$$);
```

**Refusal rate by reason, by location, is a standing report** (§6.9). Without it, the three places
this design knowingly refuses valid business are invisible, and a tenant asking "should the ceiling
be higher?" has nothing to answer with. With it, the question is arithmetic.

---

## 6.8 What the counter is allowed to claim

**The UI must never claim a limit was checked when it could not be.** This is not a wording
preference. It is the difference between a staff member who knows they are taking a risk and one who
has been told by the software that everything is fine.

The data obligations are mine; `pos-ux-specialist` owns how it reads. The wording changes with §6.5:
**the till does not know the customer's limit or balance and must not appear to.**

- The till states **what it can do here, now**, with provenance: *"We can do up to 4,000 on credit at
  this counter today — checked just now"* versus *"…— last synced 2 days ago; other locations may
  have sold since."* It never renders a network `available` figure, because it does not have one.
- **No green tick, no "limit check passed", no unqualified approval on a stale allowance.** A tick
  means verified. If it could not be verified, the affordance has to say so.
- `credit_limit_check`, `believed_available_minor`, `snapshot_as_of` and `snapshot_as_of_hlc` are
  **persisted columns on the sale**, not UI state. A warning banner that exists only on a screen is
  not evidence. When the exception is reviewed three weeks later, "did the device know?" must be
  answerable from the row.
- **A refusal is also a record** (§6.7.2), for the same reason and with the same fields.
- The same flag surfaces on the customer statement line and in the exception queue, so a breach
  investigation does not require reconstructing what a tablet was displaying at 15:40 on a Tuesday.
- While a limit fork is open, the customer record shows *"credit limit under review"* as a
  **field-level** marker at every till, and it is not cosmetic: the till is gated at the ancestor
  (§6.6.3), and the marker names who has to act.

---

## 6.9 Measuring DSO — and the 15-day gap

`open-questions.md` **Q2** flags that the financial model assumes **15 days** receivables while terms
are **30–60**. The ERP measures the real figure from day one. Three things matter about *how*, and
the previous draft had the first of them backwards.

### 6.9.1 Two numbers, and the tax basis both of them need

| Metric | Definition | What it is for |
|---|---|---|
| **Credit DSO** | countback against **credit sales only**, tax-exclusive | How fast credit customers actually pay. The collections number. |
| **Blended receivables days** | `trade_AR_net / revenue_net × days_in_period`, tax-exclusive | The figure that maps to the financial model's working-capital line. **The only one comparable to the 15-day assumption.** |

Dividing trade AR by *total* revenue when most turnover is cash produces a flatteringly small number
that measures nothing about collections; dividing by credit sales alone produces the true collections
figure, which is not what the model assumed. Reporting either against the other's benchmark is
comparing two quantities and calling it a variance.

**Both are stated tax-exclusive, and that was missing.** `ADR-0002` puts tax components on every
invoice from day one and `open-questions.md` **Q5** confirms tenant #1 is above the registration
threshold. Trade AR is what the customer owes — **tax-inclusive**. Revenue in the GL (§5) is
**tax-exclusive**. Dividing one by the other inflates blended receivables days by roughly the
combined rate before any collections behaviour is measured — a systematic bias larger than the gap
between two of the three rows in the sensitivity table below, on the single number this subsection
exists to produce.

```
ar_net(invoice) = ROUND_HALF_UP( outstanding_gross_minor * net_minor / gross_minor )
```

computed **per invoice** from that invoice's own snapshotted net and gross, then summed — so there
is no allocation and no remainder to place, and the residual is under one minor unit per invoice on
a figure that is reported and never posted (§4.13 row 12). The tax-inclusive variant is shown beside
it, labelled, because the receivables *balance* on the balance sheet is gross and someone will
compare them.

**The period basis is on the formula, not inferred.** `days_in_period` is the actual day count of
the reporting period, `revenue_net` is that same period's, and any annualised variant is labelled
`(annualised, 365)` on its face. The FY3 table below is annual.

**Whether this is comparable to the model at all depends on `GL-Q1`/Q15** — is the model's revenue
VAT-inclusive or exclusive? Until that is answered the comparison carries a stated caveat rather
than a number pretending to be a variance.

### 6.9.2 Countback, for the right reason — and what it does when it runs out

**The previous draft's justification was factually inverted.** It said the simple
`AR / average revenue × days` formula *"understates DSO exactly when the cash position is
tightening."* It overstates. Counter-example, with true terms of 30 days and everyone paying on
time:

| Month | Credit sales |
|---|---|
| 1 | 100 |
| 2 | 200 |
| 3 | 400 |

At the end of month 3, AR = 400. Simple DSO over 90 days = `400/700 × 90 = 51.4 days`. True = 30.
Countback = 30. **The naive formula overstates by 71% on a growing book** — and understates on a
declining one. Someone comparing 51 days against the model's 15 would conclude the book is far worse
than it is, which is the opposite of the risk narrative the previous draft attached to it.

Countback is still the right choice; the honest argument is that **the naive formula is
dimensionally confused on a ramp in either direction and countback is not.** It walks the AR balance
back through the most recent months' credit sales until it is exhausted, so it measures the age of
the money actually outstanding rather than a ratio against an average that no longer applies.

```
remaining = trade_AR_net;  days = 0
for m in months, most recent first:
    s = credit_sales_net(m)
    if s >= remaining:
        days += ROUND_HALF_UP(days_in_month(m) * remaining * 100 / s) / 100   -- pro-rated BY DAYS
        remaining = 0; break
    days += days_in_month(m);  remaining -= s
if remaining > 0:  return CENSORED(days)
```

**Censoring is stated, because a silent cap biases toward comfort.** If AR is not exhausted within
the available history, countback returns the window length — so on a slow-paying book, the exact
case the metric exists to catch, a true DSO of 140 days reports as "90" and looks like it plateaued.
So: when the window is consumed the metric reports **`≥ N days`**, is flagged `censored`, and is
**never plotted as a point** on a trend line. The partial-month term is pro-rated **by days**, and
that is where countback's precision actually lives; it was not written down before.

Countback needs three months of history and is harder to explain. Both figures are reported;
countback is the headline and the simple figure is shown beside it, labelled.

**Trade AR excludes accrued facility fees** (§6.2, §6.4.4) — otherwise the fee, which grows precisely
when customers are slow, inflates the number that measures how slow they are.

### 6.9.3 What the ERP should surface about Q2 that nobody has written down

**The 15-day assumption is not obviously wrong. It is unstated.** Fifteen blended days is
arithmetically consistent with 30-day terms *if* credit is roughly half of revenue and everyone pays
on time — or with 45-day average collection if credit is a third of revenue. The assumption encodes
a **credit-mix** belief that appears nowhere in the model. So the credit-sales share of revenue is a
first-class reported metric from day one, per location and network-wide. It is the hidden variable
in Q2, and it is measurable from the first week of trading, long before DSO has enough history to
mean anything.

**The order of magnitude, so the size of the question is visible.** *The remainder of this subsection
is tenant #1 financial analysis, included in a platform document because it is what justifies
building the metric at all — not because any of it is platform behaviour.* FY3 revenue is
GH₵12,518,000 and the FY3 cash trough is GH₵(1,393,958) — the plan's most important funding
milestone.

| Blended receivables days | FY3 receivables | Additional cash tied up | Indicative FY3 trough |
|---|---|---|---|
| 15 (model) | 514,438 | — | (1,393,958) |
| 30 | 1,028,877 | 514,438 | ~(1,908,396) |
| 45 | 1,543,315 | 1,028,877 | ~(2,422,835) |

**First-order only** — this holds receivables days constant against model revenue and ignores the
year-end cash sweep, the inventory interaction and every second-order effect. It is not a restated
model and no agent should present it as one; the accountant restates the model. The point is the
magnitude: a bridge facility sized at ~GH₵1.4M could need to be GH₵1.9M–2.4M if credit scales the
way the strategy intends. That is a financing conversation with a lead time measured in months.

**And the sharpest version of Q2, straight from the source documents:** the model already **books the
benefit** of customer credit — business plan §11.4 credits faster inventory turnover with easing the
trough by roughly GH₵107,000 — while **assuming away its cost** at 15 days receivables. The
demand-pull benefit is modelled; the working-capital drag that pays for it is not. That asymmetry,
not the 15 itself, is what the accountant should be shown.

### 6.9.4 Standing credit reports

Beyond DSO: ageing mix and % of AR past due (by location and network); fee accrued vs. fee collected
vs. fee waived, with shadow-mode figures rendered separately and labelled *provisional — not
chargeable*; write-off rate; **refusal rate by reason and by location** (§6.7.2), which is the only
way anyone can tune the ceiling and the caps; and **deposit coverage ratio** per account
(`security_deposit_minor / trade_exposure`).

`trade_exposure` is zero on any new or fully-paid account, so the ratio divides by zero. Per §4.13
row 12 a zero denominator **yields NULL and renders "—", never zero, never `∞`, never a division
error.** The ratio is reported at two decimal places as a scaled integer (`coverage_x100`), like
every other metric division in the system.

The business plan says credit is *"secured against customer deposits"*, so an account whose coverage
falls below policy is a collections trigger, not a footnote — **subject to Concern 1 and
`open-questions.md` Q11**, which is that the security may not exist.

---

## 6.10 Tests

Money, sync and tenant-boundary — this section is all three of `CLAUDE.md` §2.7. Written with the
code, with `money-test-engineer` and `sync-test-engineer` from the start. The previous list tested
none of the ten blocking defects found in review, and one of its assertions would have **certified a
false invariant**. It is rewritten.

### 6.10.1 Day count and ageing boundaries

- **Parameterised sweep, not "identical".** Anchor days 1…31 × Feb 2027 (28d), Feb 2028 (29d, leap),
  Mar 2027 (31d), Apr 2027 (30d), asserting the **documented** `days30_isda` value for each pair.
  The previous test asserted a 28-day and a 31-day month produce identical charges; written against
  a mid-month anchor it would have passed and certified a property that does not hold. The month-end
  anomaly in §6.4.3 is asserted explicitly, by value, including `28 Feb 2027 → 28 Mar 2027 = 28`.
- **All three day-counts.** The same sweep against `actual_365` and `whole_calendar_month`,
  asserting the documented numerator/denominator pair for each. Two of the three previously had no
  formula and therefore no test.
- **Ageing boundaries** — due date exactly, due+1, and each configured boundary ±1; across a month
  end; across a year end; across a leap day. Run against `{30,60,90}`, `{7,14,21}` and `{30}`, so
  the dynamic bucket count (`n+2`) is exercised rather than assumed.
- **DST/business-date** — server TZ pinned to `Europe/Dublin`, tenant pack timezone UTC+0: identical
  bucketing and identical accrual across both transitions, and a nightly job firing at 00:30 server
  time stamps the correct tenant business date on both sides.

### 6.10.2 The fee

- **`B-5`, the one that silently refunds.** Invoice 12,000, overdue 60 days, two monthly accruals
  posted; a partial payment of 10,000 on day 61. Assert the next run's delta is **positive and
  time-weighted**, and that no negative `fee_accrual` is ever written. Property test: for any
  sequence of payments, `cumulative_fee` is **monotonically non-decreasing** in `as_of`.
- **Negative delta requires a human.** Force one via a superseding reallocation that moves cash off
  an old invoice: assert a `fee_recomputation_variance` review opens, nothing posts, and the agreed
  resolution posts a `fee_waiver` with an authoriser and a reason code — never a negative accrual.
- **`fee_on_fee = false` actually excludes fees.** Two months of accruals on one invoice: month 2's
  basis equals month 1's **trade** outstanding, not trade + accrued fee. Flip to `true` and assert
  the compounding appears — so the flag is proven to do something in both positions.
- **Shadow accruals do not enforce.** `B-7`: a tenant with `fee_confirmed_at IS NULL` and six months
  of shadow accruals has **identical `headroom_minor`, identical `credit_allowance`, and zero
  exposure exceptions** compared with a tenant that has no fee configured at all. Also: no
  `credit_entry` of type `fee_accrual` exists while unconfirmed.
- **The gate is content-bound.** Confirm a policy, then edit `fee_basis`: assert the next accrual run
  **fails loudly** on hash mismatch rather than posting. Assert a confirmed policy's mechanics
  columns cannot be updated at all.
- **Both idempotency keys.** A daily sub-ledger pass re-run for the same `(invoice, as_of_date)`
  inserts nothing; a monthly GL pass re-run for the same `(account, period)` posts nothing;
  and — the previously impossible case — **multiple deltas inside one period both post**, which the
  old single per-period key made unreachable.
- **Thresholds.** `fee_min_post_minor` suppresses a sub-threshold delta and the suppressed amount
  **reappears in a later run** rather than being lost. `fee_minimum_charge_minor` (D-6) is gated:
  with the policy unconfirmed it changes nothing.
- **Accrual stops.** An invoice past `fee_accrual_stop_days` accrues no further; the prior accruals
  stand.
- **Location attribution.** Per-invoice fees sum exactly to the account total and to the per-location
  split, with **no remainder to place** — asserted against §5.14.3's contract shape.

### 6.10.3 Allocation and exposure

- **`B-8`, concurrent FIFO.** Two locations each take a payment offline against the same two
  invoices. Assert: no device allocated anything; both payments land as on-account credit; the server
  allocates once, deterministically; `Σ allocations ≤ invoice value` holds for every invoice; and the
  deferred trigger fires if a test harness attempts to violate it.
- **Reallocation** supersedes rather than edits, requires an authoriser and a reason, and its fee
  consequence goes through §6.10.2's negative-delta path.
- **Exposure property test** — `Σ credit_entry == rollup` for randomly interleaved offline batches,
  in every arrival order, for both `trade_exposure` and `fee_exposure` separately.
- **Sign constraints** — every `entry_type` × sign combination, including that a reversal carries the
  opposite sign and that `amount_minor = 0` is rejected.

### 6.10.4 The two conflict cases

- **Case (a), the interim rule.** Two devices supersede the same version: both `pending_review`,
  neither lost, **the ancestor is in force** (not the minimum, not the newest HLC, not the first to
  arrive), the already-applied fork member is reverted by a server-originated write, its author is
  notified by name, and the revert **re-runs the exposure check**. A third late proposal joins the
  same review rather than opening a second.
- **Case (a), the root fork.** Two devices both write the *first* version of an account
  (`supersedes_id IS NULL`): assert the fork is detected. Under the previous index's default
  `NULLS DISTINCT` both were accepted and the backstop failed **open**.
- **Ordering.** A version with an `effective_from` earlier than its parent's is refused; the
  "accepted version in force on date D" is unique for every D across a chain of ten versions.
- **`state` transitions.** Every non-whitelisted transition is refused by trigger; a severity-1
  credit resolution attempted offline is refused with the reason.
- **Case (b), the breach.** Two offline credit sales breach one limit: both recorded, exposure exact,
  `believed_available_minor` and `snapshot_as_of_hlc` captured on each sale, and **exactly one**
  review item — proven by running detection three times and asserting the deterministic key makes
  runs 2 and 3 no-ops.
- **Case (b), the cap double-lend.** `B-10`: reduce a location's cap, reassign the headroom to
  another location, keep the holder offline past `valid_until`, and assert the **reassignment was
  withheld** until acknowledgement or expiry — and that the holder stops lending on lease expiry.
- **Ceiling refusal.** A sale above `offline_ceiling_minor` cannot complete as an offline credit
  sale; a `credit_refusal` row is written with the reason and outcome; the part-payment path
  completes; and with `offline_ceiling_override_permitted = false` no manager can override.
- **`B-4`, the allowance window.** Simulate the 14:02 ack / 14:07 snapshot sequence and assert
  `sellable_now` is correct at every instant — no over-lend in the gap, no double-count after.

### 6.10.5 Isolation — one test per read path, not one line

`CLAUDE.md` §2.7 requires *every* read path that could cross a tenant boundary to prove a second
tenant's data is invisible. The previous draft compressed that to one sentence. Enumerated:

| # | Read path | Asserted invisible |
|---|---|---|
| 1 | `trade_exposure` / `fee_exposure` / rollup | another tenant's entries never enter a sum |
| 2 | Ageing report and bucket totals | — |
| 3 | Customer statement | — |
| 4 | `credit_allowance` sync (`location_credit_allowance` bucket) | rows for another tenant's location or customer never appear on a device |
| 5 | `tenant_credit` bucket (`credit_account`, `credit_limit_version`, `credit_entry`) | — |
| 6 | `conflict_review` — limit forks and exposure breaches, and their detail tables | — |
| 7 | `credit_refusal` and the refusal-rate report | — |
| 8 | DSO, countback and credit-mix metrics | — |
| 9 | Deposit coverage ratio | — |
| 10 | `fee_accrual_detail` and `fee_accrual_shadow` | — |

Plus, per §4.2.5 and `M-11`: a schema assertion that **all twelve tables this section defines** carry
`tenant_id`, a `(tenant_id, id)` primary key, the composite FK to `app.write_log`, and
`ENABLE`/`FORCE ROW LEVEL SECURITY` — because they are created through `app.new_tenant_table` and
the CI guard enumerates them rather than trusting that they were.

---

## 6.11 Concerns

Three, in order of how much they worry me. The previous draft's fourth — that §6.5 put an
account-level snapshot of the whole customer base on every tablet — is **deleted rather than
reworded**, because §6.5 no longer does that. What remains true and worth keeping from it is the
underlying judgement, folded into Concern 3 below.

**1. "Secured against customer deposits" is designed nowhere.** The business plan names deposits as
the security behind credit limits (§10 risk table) and this section reports a deposit coverage ratio
against a `security_deposit_minor` column — **with nothing behind it.** There is no deposit product
in the brief, no ADR, and nothing in the Phase 1 scope list. A real deposit needs a held-funds
ledger, a GL liability account it cannot be swept out of, a claim procedure, and rules about what
happens when a customer with a deposit goes into default. If deposits genuinely secure the credit
book then that is a **Phase 1 dependency of credit**, not a Phase 3 nicety. This is now
`open-questions.md` **Q11**. Until it is answered, every "secured" claim about this credit book is a
column with a number typed into it, and §6.7's fourth resolution option — *"apply the security
deposit"* — has no mechanism behind it.

**2. Shadow-mode accrual will be quoted to a customer.** The §6.4.5 gate blocks GL posting until
D-1…D-6 are confirmed, and the shadow figures no longer enforce anything (`B-7`). But they are
visible in reports **by design** — that visibility is the point, since Q4 needs the numbers to reach
a decision. Someone will read one to a customer. Labelling helps and is required; the residual risk
is real and the mitigation is partly procedural: Accounts should be told, in words, that the fee is
not chargeable until the policy row is confirmed and the hash matches.

**3. The honest expectation is that limit breaches and refusals will both happen, and software does
not collect money or negotiate.** §6.7 bounds the damage and now measures the cost of bounding it;
it does not stop a breach. What the business needs alongside the exception queue is a **commercial**
policy: who calls the customer, what happens to the manager who authorised an offline sale that went
bad, at what exposure the account gets held — and, symmetrically, **what refusal rate is acceptable**
and therefore where `offline_ceiling_minor` and the caps should be set. Those are founder decisions
with money on both sides of them, and §3.6.2's escalation chain only hardens to `credit_hold`; it
does not decide anything. **Promoted as a new open question (§6.12.3).** An exception queue nobody
has been made accountable for is a list that grows.

**And one judgement carried over from the deleted Concern 4.** Of everything in this system, a
tenant's credit positions and customer limits are the data whose leak would be most commercially
fatal. §6.5 no longer puts the book on a till, which removes the acute version of the risk — but
`ADR-0005`'s tenant → database mapping remains the upgrade path, and when it is first exercised for
a large or regulated tenant, the credit sub-ledger is the reason it will be. That is a statement
about sequencing, not a disagreement with `ADR-0005`.

---

## 6.12 Revisions from adversarial review

Reviewed 2026-08-21 against `CLAUDE.md`, `ADR-0002/0004/0005/0006/0007`, `open-questions.md` and the
authoritative rulings in §3, §4 and §5. **Ten findings were blocking**, eighteen major, eleven
minor. **Where this subsection and the body differ, this subsection governs.**

### 6.12.1 The pattern behind the blocking findings

Four of the ten came from one cause, and it is the same cause §4.17.1 names: **this section was
drafted against earlier versions of §3, §4 and §5 and never re-read against the revised ones.** It
shipped a device credit snapshot that §3.2.2 had replaced with `credit_allowance`; a
`min(a,b)` interim limit rule that §3.6 forbids by name; a second write registry that §3.3.2 and
§4.2.2 had already unified into `write_log`; and a second review queue that §3.6.2 and §4.12 had
already ruled against. Each duplicate was weaker than the original. §3.11.1's diagnosis applies
verbatim: *stating a strong claim and not building the machinery underneath it.*

Two more were arithmetic, and they are the ones worth dwelling on, because they were in the part of
the section that argued most confidently:

- **The fee basis was `current outstanding × total elapsed`**, which means any partial payment
  retroactively rewrites months of fee history and posts a **negative accrual** — a silent refund,
  with no reason code and no authoriser, bypassing the one control (`fee_waiver`) the section
  insisted on two paragraphs later. The section's headline safety claim was about *truncation*,
  which was bounded and irrelevant, while the dominant error was two orders of magnitude larger.
- **The 30E/360 invariant was false**, and §6.10 specified a test asserting the false version.
  Written against a mid-month anchor it would have passed. A test that certifies a property the code
  does not have is worse than no test, for the same reason a Phase 0 document that overclaims is
  worse than one that admits a gap: the next reader stops checking.

The corrective discipline is §4.17.1's, and it now applies to this section too: **one table, one
owner, a cross-reference rather than a second definition** — and every numeric claim carries its
arithmetic, or it does not go in.

### 6.12.2 Cross-section amendments this revision requires

This section has been changed to agree with §3/§4/§5 wherever they ruled. Seven items remain where
the *other* section carries text that is now stale or under-specified. None is a licence for this
section to diverge; each is a one-line edit somebody else owns, and all seven are Phase 0 exit
conditions in the sense §3.11.9 uses.

| # | Section | Amendment |
|---|---|---|
| X-1 | §3.2.3 | The `credit_allowance` data query selects a fixed column list. Add **`cap_valid_until`**, **`cap_version_id`** and **`snapshot_as_of_hlc`** — the lease (`B-10`) and the causal watermark (`B-4`) are unimplementable without them. The query also selects `row_hlc`; `credit_allowance` is a mutable server-derived row, so it carries both the base row's `hlc` and §3.5's `row_hlc` — worth stating once so the two are not conflated. |
| X-2 | §3.2.3 | Add **`credit_refusal`** to the `location_ops` bucket (§6.7.2). It is a device-originated document. |
| X-3 | §3.6.1 | The worked example has *"the outlet manager"* at one location lowering a credit limit. `CLAUDE.md` §2.6 and §6.6.6 make `credit_limit_version` Accounts-and-above only. Correct the actor; the mechanics of the example are unaffected. |
| X-4 | §3.6 class #9 | *"`ar_transactions` … Append-only. Balance = Σ. Cannot conflict."* True of the **entries**; **not** true of payment **allocation**, which is a bounded resource assignment (`B-8`). Add the clause: allocation is server-derived and never device-originated. |
| X-5 | §3.11.7 | The worked deterministic key `uuidv5(ns,'fee_accrual:'‖credit_account_id‖':'‖period_id)` is the **GL journal** key. The sub-ledger key under a daily cadence must carry invoice and date (§6.4.4). Amend the example to show both. |
| X-6 | §4.9 | `credit_limit_minor`, `limit_set_by`, `limit_set_hlc`, `limit_write_id` are **server-maintained projections** of `credit_limit_version`'s accepted head, with no `GRANT UPDATE` to the application role (§6.6.1). Also: the block names `app.credit_transaction`; §3.11.9 makes `credit_entry` canonical. The reference to `sync_conflict` kind `CONCURRENT_FIELD_EDIT` is already dead per §4.12. |
| X-7 | §5.6.5 and §4.13 rows 7 & 11 | §5.6.5 specifies pro-rata-by-outstanding with a largest-remainder pesewa; §4.13 row 7 specifies largest-remainder across ageing buckets. At **invoice grain** (§6.4.1 #5) the attribution is exact and there is no remainder, and §5.14.3 already requires the subledger to return the obligation's location. Amend both to say invoice-grain attribution supersedes the pro-rata where available, and keep the pro-rata as the rule for any fee raised at account grain. **This section does not ship a second split**; it needs §5 to record that the exact one is the one it gets. |

### 6.12.3 Open questions promoted

Two new, plus riders on three existing ones. `product-manager` owns `open-questions.md`.

- **New — `Q21`: breach, refusal and offline-ceiling policy.** `OPEN` · Owner: **founder** · Blocks:
  Phase 1 credit go-live (soft: the mechanism ships without it, the business cannot operate it).
  Software bounds and measures; it does not collect money or negotiate. Needed: who calls a customer
  on an exposure breach, what happens to a manager who authorised an offline sale that went bad, at
  what exposure an account is held — and, symmetrically, **what refusal rate is acceptable**, which
  is what sets `offline_ceiling_minor`, the caps and `offline_ceiling_override_permitted`. §6.7.2's
  refusal reporting exists so this question can be answered with data after the first quarter rather
  than guessed now. From §6.11 Concern 3.
- **New — `D-6` under `Q4`: is there a minimum facility-fee charge?** `NEEDS-HUMAN` · Owner: the Q4
  accountant/legal. A floor fee raises the effective rate on a small balance without limit and is
  precisely what Q4's *"attracts lending/moneylending regulation"* question turns on. It was
  previously present in the schema as a rounding knob (`fee_min_post_minor`) with two different
  meanings at two different scopes and **no gate**, so it would have shipped unconfirmed while the
  2%/month it modifies was blocked. Q4's text should list six decisions, not five.
- **Rider on `Q2`:** the comparison to the model's 15 days is only meaningful once the **tax basis**
  is fixed (§6.9.1) and the **credit-mix** belief is stated (§6.9.3). Q2 should name both.
- **Rider on `Q15`/`GL-Q1`:** blended receivables days cannot be compared to the model until it is
  known whether the model's revenue is VAT-inclusive. §6.9.1 reports tax-exclusive and labels the
  caveat; the caveat comes off when Q15 is answered.
- **Rider on `Q6`:** §6.4.5's gate now requires a *qualified accountant's attestation*, not the
  Accounts permission. The person is still unnamed. This makes Q6 a Phase 1 blocker for the fee, not
  only a Phase 3 one.
- **Unchanged and still live:** `Q11` (deposits — §6.11 Concern 1) and `Q18` (is the fee a taxable
  supply — §6.4.2).

### 6.12.4 Full disposition

**Blocking**

| # | Finding | Disposition |
|---|---|---|
| B-1 | `min(a,b)` interim limit is the rule §3.6 forbids by name | **Accepted.** `min()` deleted. Interim is **the ancestor**, per §3.6.1: both forks to `pending_review`, applied member reverted by a server-originated write, author notified by name, exposure re-checked. §6.6.3. The asymmetric-risk argument is recorded as having lost rather than quietly shipped. |
| B-2 | Three incompatible representations of the credit limit | **Accepted, and reconciled rather than chosen between.** `supersedes_id` *is* §3's CAS; `credit_limit_version` *is* the version history and a permanently-retained one, so §3.6.1's "unreconstructable ancestor" branch never fires for a limit; §4.9's column survives as a **server-maintained projection** with no `GRANT UPDATE`. §6.6.1, amendment X-6. |
| B-3 | §6.5's device snapshot is the design §3.2.2 replaced; its formula is unimplementable | **Accepted.** §6.5 rewritten against `credit_allowance`. The till never receives limit, balance, ageing or history. §6.8's wording changed to match — the till states what it can lend here today, not a network `available`. §6.11 Concern 4 **deleted**, not reworded. |
| B-4 | The `local unsynced` term double-counts or under-counts | **Accepted.** The term is causal, not flag-based: deduct local credit sales where `ack_hlc IS NULL OR ack_hlc > snapshot_as_of_hlc`, comparing two server-stamped HLCs. Both windows close. Requires amendment X-1. |
| B-5 | Fee basis retroactively refunds posted fees; negative accrual | **Accepted — the most serious finding in the set.** Accrual is **time-weighted over balance segments**, one division at the end; cumulative-delta posting kept. `delta < 0` **never posts silently** — it raises for review and resolves as an authorised `fee_waiver`. Deltas from closed periods post to the current open period. §6.4.3, tests §6.10.2. |
| B-6 | `fee_on_fee = false` not implemented; fees consume headroom | **Accepted.** Basis stated as an explicit predicate excluding `fee_accrual`/`fee_waiver`. Exposure split into `trade_exposure` and `fee_exposure`; **the limit is checked against trade exposure.** A fee never refuses a sale. §6.2, §6.4.3. |
| B-7 | Shadow accruals enforce on values nobody confirmed | **Accepted.** Shadow figures move to `fee_accrual_shadow` with no path into any sum; they are not `credit_entry` rows. Test added asserting identical `credit_allowance` against a tenant with no fee configured. §6.4.5. |
| B-8 | "No conflict case at all" is false — allocation is not commutative | **Accepted, sentence retracted.** Allocation is **server-side only**; offline payments land as on-account credit; the server allocates once, deterministically, with a reproducible tie-break. `Σ allocations ≤ invoice value` enforced by deferred constraint trigger with an `over_allocation` exception. §6.2, §6.3. Requires amendment X-4. |
| B-9 | `credit_entry` re-invents the write registry; `hlc`/`occurred_on` unbounded | **Accepted.** `write_id` + composite FK; own `idempotency_key` deleted; `hlc` typed `app.hlc` and server-stamped; `occurred_on` → `business_date` with three stated paths and a server-side validity rule that **refuses** a back-date into a closed period. §6.2. |
| B-10 | Caps are static; §4.9 already ruled they are leases | **Accepted.** §4.9's lease columns imported. Increases immediate; **decreases effective only on acknowledgement or expiry, and the reassignment is withheld until then.** Drill added to §6.10.4. |

**Major**

| # | Finding | Disposition |
|---|---|---|
| M-1 | The 30E/360 invariant is false at month end and in leap years; the test asserts the false version | **Accepted.** Adopted **30E/360 ISDA**, with the reasoning shown — the reviewer's month-end cases are real, and the *more common* failure is that plain 30E/360 makes every February two days short for every mid-month anchor when `d2` is a period end. The ISDA maturity-date carve-out is explicitly **not** adopted. Residual anomaly documented by value. Test replaced with a parameterised sweep over anchor days 1…31 × four months. |
| M-2 | The formula works for only one of three `fee_day_count` values | **Accepted.** One expression parameterised on `(numerator, denominator)` carried by the day-count row; all three given, including what `whole_calendar_month` means for a mid-month payment. *Partly disputed:* the analogy to `if (country === 'GH')` is overstated — `ADR-0007` forbids branching on **jurisdiction**, and a day-count is a policy value — but the parameterised form is better regardless and is what shipped. |
| M-3 | The naive-DSO error direction is stated backwards | **Accepted.** The reviewer's counter-example is correct; the naive formula **overstates** by 71% on the stated ramp. Corrected, and the argument for countback restated honestly: the naive formula is dimensionally confused on a ramp in either direction. §6.9.2. |
| M-4 | Neither DSO metric states whether AR is gross of tax — and it is | **Accepted.** Both metrics are tax-exclusive, computed per invoice from its own snapshotted net and gross so there is no allocation; the tax-inclusive variant is shown beside it, labelled. Period basis added to the formula. Comparability bound to Q15. §6.9.1. |
| M-5 | Countback silently caps when AR exceeds the window | **Accepted.** Exhaustion reports `≥ N days`, flags `censored`, and is never plotted as a point. Partial-month pro-rating **by days** stated. §6.9.2. |
| M-6 | `fee_min_post_minor` is a minimum charge smuggled in as a rounding knob, at two scopes | **Accepted.** Split: `fee_min_post_minor` is suppress-only and never adds money; `fee_minimum_charge_minor` is a commercial floor, is **D-6**, and is gated. The account-level test is removed; there is no account-level column. §6.1, §6.4.2. |
| M-7 | The gate is a nullable timestamp any Accounts user can set, unbound to content | **Accepted, all three holes.** Content-bound `fee_confirmed_hash` recomputed on every run; confirmed policies immutable on the mechanics columns (a change needs a new effective-dated row and its own confirmation); FK added; **attestation** recorded, not permission. §6.4.5, rider on Q6. |
| M-8 | No uniqueness on `customer_id` | **Accepted.** `unique (tenant_id, customer_id)`, matching §4.9. |
| M-9 | Missing sign constraint — §4 required it explicitly | **Accepted.** Per-`entry_type` sign CHECK with a reversal branch, plus `amount_minor <> 0`. Convention stated as a constraint: outflow negative, debit-to-customer positive. |
| M-10 | `credit_review_item` is a second review registry | **Accepted.** Deleted. Two `conflict_class` rows (`credit_limit_fork`, `credit_exposure_breach`) with typed detail tables on `conflict_review`, inheriting the bucket, the escalation chain and the hardening-to-`credit_hold` rule. §6.6.4. |
| M-11 | No PK, FK, RLS or idempotency on the new tables | **Accepted.** All twelve tables route through §4.2.3's `app.new_tenant_table`. Deterministic `detection_key` + `uuidv5` write id makes re-detection a no-op. Schema assertion added to §6.10.5. |
| M-12 | The fork detector fails open for the first version | **Accepted.** `NULLS NOT DISTINCT`, plus a head assertion for forks branching at different depths, plus a monotonic `effective_from` rule along the chain that makes "the version in force on date D" unique. §6.6.2. |
| M-13 | `state` is a mutable column on an append-only table | **Accepted.** Whitelisted transitions named, column-level `GRANT UPDATE (state)` to the resolution role, trigger; §3.6.1's no-offline-severity-1-resolution rule imported. §6.6.5. |
| M-14 | Terms, rate and hold exist in two or three places | **Accepted.** `credit_limit_version` is the sole authority for limit/terms/rate; the `credit_account` columns are projections. **`customer.credit_hold` is the one authoritative hold flag**; `'on_hold'` is removed from `credit_account.status`, which now covers lifecycle only; `credit_allowance.credit_hold` is a projection. |
| M-15 | §6.4.1(5) contradicts §5.6.5's pro-rata allocation | **Accepted.** §6 keeps invoice-grain (it is exact, and §5.14.3 requires the subledger to return the obligation's location), states the conflict rather than staying silent, and raises **amendment X-7** for §5.6.5 and §4.13 rows 7 & 11. Silence was the one option that ships two implementations. |
| M-16 | The sub-ledger accrual has no key, and §3's collides on a daily cadence | **Accepted.** Two keys, both stated: sub-ledger per `(invoice, as_of_date)`, GL per `(account, period)`. Amendment X-5. |
| M-17 | `as_of` and `business_date` have no timezone rule, and the servers are in Europe | **Accepted.** All credit dates are **tenant business dates in the jurisdiction pack's timezone**; `as_of` derives from it; `business_date` validated server-side. DST test pinning `Europe/Dublin` added. §6.3.1. |
| M-18 | The offline ceiling hard-refuses with no fallback, and no refusal is recorded | **Accepted.** Four-step above-ceiling path (part-payment → cash → proforma held for sync → tenant-permitted override, default **off**). `credit_refusal` event added with reason and outcome; **refusal rate by reason is a standing report**, so the three places this design refuses valid business are measurable. §6.7.2. Requires amendment X-2. |

**Minor**

| # | Finding | Disposition |
|---|---|---|
| m-1 | The overflow figures are wrong by 10× and two orders of magnitude | **Accepted.** Recomputed: `9×10¹²`, six orders inside `int64`. Worst realistic case (3 years overdue, one segment) restated at `3.24×10¹⁴`; time-weighting makes each segment's product smaller, not larger. `fee_accrual_stop_days` added as the real bound. |
| m-2 | `location_id` declared attribution-only then used for scoping | **Accepted.** Moot once `B-3` is fixed; the comment is corrected and the rule stated twice (never scopes a balance query, never scopes a sync rule). |
| m-3 | Prose columns missing from the DDL | **Accepted.** `reverses_entry_id`, `reason_code`, `archived_at`, `CHECK (deleted_at IS NULL)` added; `fee_accrual_detail`, `credit_allocation`, `fee_accrual_shadow`, `credit_refusal`, `credit_allowance` and both detail tables given full DDL; the allocation-sum invariant given its deferred constraint trigger. `provisional` is not added — shadow rows left `credit_entry` entirely (`B-7`). |
| m-4 | Free text where enums were used; one unrunnable migration | **Accepted.** `credit_account_status`, `sub_limit_mode`, `credit_limit_check`, `credit_refusal_reason`, `credit_refusal_outcome` are enums; `conflict_review.conflict_class` stays text because §3.6 makes the class **data** by design. The `alter table sale` is replaced by column definitions on `app.sale` in §4.8, where they belong. `share_of_limit` is defined. |
| m-5 | No constraint making "one active policy per tenant" true | **Accepted.** `EXCLUDE USING gist` over `daterange(effective_from, effective_to)`. `ADR-0002`'s repricing principle quoted verbatim: accrual uses the policy in force on the accrual date. |
| m-6 | `ageing_bucket_days` unconstrained; bucket count fixed at four | **Accepted.** CHECK for non-empty, positive, strictly increasing; bucket count stated as `cardinality + 2` and the report renders dynamically; the table body no longer hard-codes four. |
| m-7 | The "two policies with a cut-over" escape hatch does not solve the stated problem | **Accepted — deleted.** Effective-dating gives sequential policies; the stated need was concurrent. The underlying decision (one accrual basis per tenant) stands on its own. |
| m-8 | Deposit coverage divides by zero | **Accepted.** NULL → "—" per §4.13 row 12; reported as `coverage_x100`. |
| m-9 | Tenant #1 vocabulary in platform prose, against the section's own promise | **Accepted.** "Contractor", the product names and the tier abbreviation are gone from platform prose; worked examples use neutral figures; the leap-year test is stated as a leap year rather than a tenant fiscal year; the FY3 sensitivity table is explicitly labelled tenant #1 analysis included to justify a platform metric. |
| m-10 | §6.6's permission claim and §3.6.1's worked example disagree | **Accepted.** `CLAUDE.md` §2.6 sides with §6; §6.6.6 states the rule and names the discrepancy, and it is **amendment X-3** for §3. |
| m-11 | §6.10 does not test the failures found here | **Accepted.** §6.10 rewritten into five groups; every blocking finding has a named test, including the negative-delta path, concurrent FIFO, shadow-mode headroom, the cap double-lend drill, DST boundaries, countback censoring, RLS on all twelve tables and a ceiling refusal. Isolation is **one test per read path**, enumerated as ten. |

**Nothing was rejected outright.** Two findings were accepted with a noted qualification (M-2's
`ADR-0007` analogy is overstated; M-1's proposed fix needed re-deriving before it was adopted,
because plain 30E/360's dominant failure is not the one the review named). Everything else was a
real defect. The reviewer's "sound" list — the append-only signed-integer log, days-past-due
bucketing, the trade/fee AR split, the refusal to auto-raise a limit, basis points as `integer` with
the division last, and Concerns 1 and 3 — is unchanged, and this revision has taken care not to
manufacture changes to any of it. The one correction inside that list is that the commutativity
argument was over-extended from the **sum** to **allocation** (`B-8`), which is exactly what the
reviewer said.
