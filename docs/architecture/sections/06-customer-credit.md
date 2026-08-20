# 6. Customer Credit and the Facility Fee

Credit is the product's highest-value feature and its most concentrated risk. It is also the only
subsystem where the offline constraint and a business invariant are in direct, unresolvable
conflict. A credit limit is a **global** invariant — it is a statement about the sum of activity
at every location at once — and a device that cannot reach the server cannot enforce a global
invariant. No protocol fixes this. This section designs for detection and recovery instead of
pretending prevention is possible, and is explicit about where the truth has to be told to the
person standing at the counter.

Everything here is **per-tenant configuration**. Tenant #1's 30–60 day terms and 2–3%/month
facility fee are values in the *Construction materials distribution — Ghana* template, not
platform behaviour (`ADR-0006`). The customer type is **credit customer**; "contractor" is
tenant #1's vocabulary and appears only in their template's labels.

---

## 6.1 Three layers: policy, account, entry

The single most consequential structural choice here is *what lives at which level*. Getting it
wrong produces either a platform that hard-codes one tenant's credit terms, or a free-for-all in
which every account has its own accrual mechanics and no one can write a revenue recognition note.

| Layer | Scope | Holds | Why it lives here |
|---|---|---|---|
| `credit_policy` | one active row per tenant, effective-dated | fee basis, compounding, day-count, posting cadence, ageing bucket boundaries, offline controls, GL account mapping, defaults for new accounts | **Accounting policy.** A tenant files one set of accounts. It cannot have account A accruing on overdue balance and account B on outstanding balance and still produce a coherent revenue recognition note. |
| `credit_account` | one per customer | limit, terms days, fee rate, security deposit, status | **Commercial negotiation.** Terms and rate are what a salesperson agrees with a specific customer. They vary by design. |
| `credit_entry` | append-only, one row per event | every movement of the balance | **Fact.** The balance is derived from these, never stored as a mutable counter. |

This is a refinement of `ADR-0006`, not a departure from it: that ADR says "per-tenant credit
policy; per-account terms and rate", and this splits *which* knobs are which. Rate and terms are
per account. **Basis, compounding and day-count are per tenant and are not overridable per
account.** If a tenant genuinely needs two fee structures, that is two policies with an
effective-dated cut-over, not two accounts drifting apart.

```sql
create type fee_basis      as enum ('overdue_balance','outstanding_balance','drawn_amount');
create type fee_day_count  as enum ('thirty_e_360','actual_365','whole_calendar_month');
create type fee_post_cadence as enum ('daily','monthly_close','on_settlement');

create table credit_policy (
  tenant_id            uuid     not null references tenant(id),
  id                   uuid     not null,
  effective_from       date     not null,
  effective_to         date,                      -- null = current

  -- accrual mechanics (tenant-wide, see 6.4)
  fee_basis            fee_basis        not null,
  fee_compounds        boolean          not null,
  fee_on_fee           boolean          not null, -- do unpaid accruals enter the basis?
  fee_day_count        fee_day_count    not null,
  fee_grace_days       smallint         not null default 0,
  fee_post_cadence     fee_post_cadence not null,
  fee_min_post_minor   bigint           not null default 0,

  -- defaults stamped onto new accounts
  default_terms_days   smallint not null,         -- template: 30
  default_limit_minor  bigint   not null,
  default_fee_rate_bp  integer  not null,         -- template: 200 bp/month (2.00%)

  -- ageing (see 6.3)
  ageing_bucket_days   smallint[] not null,       -- template: {30,60,90}

  -- offline controls (see 6.7)
  offline_ceiling_minor           bigint,         -- null = no per-sale ceiling
  offline_auth_threshold_minor    bigint,         -- above this, manager authorisation offline
  location_sub_limit_mode         text not null,  -- 'off' | 'fixed' | 'share_of_limit'

  -- the human gate (see 6.4.5)
  fee_confirmed_at     timestamptz,
  fee_confirmed_by     uuid,
  fee_confirmation_note text,

  primary key (tenant_id, id)
);
```

`credit_account` carries **no `location_id`.** That omission is the whole of §6.5.

```sql
create table credit_account (
  tenant_id              uuid     not null,
  id                     uuid     not null,
  customer_id            uuid     not null,
  status                 text     not null,   -- 'active'|'on_hold'|'suspended'|'closed'
  terms_days             smallint not null,
  fee_rate_bp            integer  not null check (fee_rate_bp >= 0),
  security_deposit_minor bigint   not null default 0,
  opened_on              date     not null,
  primary key (tenant_id, id)
);
create index on credit_account (tenant_id, customer_id);
```

The **limit is not a column on this table.** It is an append-only decision log — see §6.6, which
is the reason.

---

## 6.2 Exposure is derived, and that is a sync decision

```sql
create type credit_entry_type as enum
  ('sale','payment','credit_note','fee_accrual','fee_waiver','write_off','adjustment');

create table credit_entry (
  tenant_id         uuid    not null,
  id                uuid    not null,
  credit_account_id uuid    not null,
  entry_type        credit_entry_type not null,
  amount_minor      bigint  not null,   -- signed; positive increases exposure
  invoice_id        uuid,               -- the invoice this attaches to; drives ageing and fee
  location_id       uuid    not null,   -- where it originated: attribution only, never scoping
  occurred_on       date    not null,   -- business date; drives ageing
  recorded_at       timestamptz not null,
  hlc               text    not null,   -- logical timestamp (CLAUDE.md §2.2)
  idempotency_key   uuid    not null,
  created_by        uuid    not null,
  primary key (tenant_id, id),
  unique (tenant_id, idempotency_key)   -- per-tenant, never global (ADR-0005)
);
create index on credit_entry (tenant_id, credit_account_id, occurred_on);
```

**Exposure is `sum(amount_minor)` over the account.** It is never a counter that gets incremented.

This is not fastidiousness — it is the one decision that makes credit survive offline sync at all.
A mutable `balance_minor` column is a read-modify-write, and two devices doing a read-modify-write
against the same row while partitioned is the textbook lost update; the sync layer would have to
resolve it and no resolution is correct. An **append-only log of signed integers is commutative**:
two offline batches arriving in either order produce the same sum, so there is nothing for the
sync layer to resolve and nothing for a human to review. Credit *transactions* therefore have no
conflict case at all. Only the *limit* does (§6.6), and only the *invariant* is breachable (§6.7).

For read speed a `credit_account_rollup` materialises the balance, bucket totals and last accrual
point. It is a cache with one rule: a nightly reconciliation job recomputes from the log and
raises an exception on any mismatch. The sum is the truth; the rollup is convenience.

Handoff to `sync-architect`: `credit_entry` is insert-only for every client role. No client
issues an `UPDATE` or `DELETE` against it. A reversal is a new entry with a negative amount and a
`reverses_entry_id`, never an edit — the ledger reason, and the same reason `ledger-engineer`
gives for GL postings.

---

## 6.3 Ageing

**An invoice ages against the terms in force when it was issued.** The invoice carries
`terms_days_snapshot` and `fee_rate_bp_snapshot`, copied at issue. Changing an account's terms
changes future invoices only. This is the same principle as `ADR-0002`'s rule that a historical
transaction reprices against the tax row in effect on its date, and it exists for the same
reason: history must reproduce.

```
due_date = invoice.occurred_on + terms_days_snapshot     -- calendar days
days_past_due(as_of) = as_of - due_date                  -- calendar days, may be negative
```

**Buckets are days past due, not invoice age.** The classic ageing report buckets by invoice age,
and that convention breaks the moment one report contains both 30-day and 60-day accounts: a
"31–60" column would hold a 30-day invoice that is one day late *next to* a 60-day invoice that is
perfectly current. The bucket would mean two different things in the same column, and collections
would chase the wrong customer. Bucketing by days past due makes every column mean the same thing
for every account and matches what a collections clerk actually acts on.

| Bucket | Condition | Template boundary |
|---|---|---|
| `current` | `days_past_due <= 0` | — |
| `overdue_1` | `1 .. 30` | `ageing_bucket_days[1]` |
| `overdue_2` | `31 .. 60` | `ageing_bucket_days[2]` |
| `overdue_3` | `61 .. 90` | `ageing_bucket_days[3]` |
| `overdue_4` | `> 90` | — |

Boundaries come from `credit_policy.ageing_bucket_days`, so a tenant on weekly terms can use
`{7,14,21}` without a code change.

**Cost, stated:** an accountant arriving from a system that ages by invoice date will read a
smaller "90+" number here and think the book is healthier than it is. The report is labelled
*"aged by days past due"* on screen and in every export, and the customer statement shows both
invoice date and due date on each line so the two can be reconciled by eye.
`compliance-gatekeeper` puts the label in front of the reviewing accountant at the §2.8 gate — not
because the convention is in doubt, but because the receivables note in the financial statements
has to say which one it uses.

**Payment allocation drives ageing, so it is part of the design, not an afterthought.** A payment
entry allocates to invoices through `credit_allocation (payment_entry_id, invoice_id,
amount_minor)`. Default is oldest-due-first (FIFO); Accounts can reallocate, which writes a new
allocation set and supersedes the old one rather than editing it. Allocations must sum to the
payment; an unallocated remainder sits as **on-account credit**, which reduces total exposure but
belongs to no bucket. The ageing report shows on-account credit as a separate line and never
nets it silently against the oldest bucket — netting it invisibly is how a customer ends up
chased for an invoice they paid.

---

## 6.4 The facility fee

The financial model treats this fee as **zero** — deliberate unmodelled upside. The brief's
instruction is to stop burying it. That makes the fee a revenue recognition matter, and revenue
recognition decisions do not get made by inference from a business plan sentence.

### 6.4.1 Settled here (engineering)

1. **The rate is stored as basis points per accrual period** (`fee_rate_bp`, `integer`). 2%/month
   is `200`. Never a float, never a percentage string, never an annualised figure converted at
   runtime — store what is charged (`ADR-0004`).
2. **Accrual is an event, not a computed display value.** Every accrual writes a
   `credit_entry` of type `fee_accrual` plus a `fee_accrual_detail` row recording basis amount,
   rate, period start and end, day count and the resulting figure. A customer *will* argue about
   this charge at a counter. The system must be able to show the arithmetic that produced it,
   months later, without recomputation.
3. **Accrual runs server-side only. A device never accrues.** The fee depends on the global
   account balance, which no offline device has. Devices display the last server-computed accrual
   with an explicit *as of* timestamp. This also removes an entire class of duplicate-accrual bugs
   before it exists.
4. **Cumulative computation, delta posting.** Each run computes the fee owed *to date* per
   invoice and posts the difference against what has already been posted. Truncation error is
   then bounded at under one minor unit **per invoice for all time**, rather than per period
   compounding across hundreds of runs.
5. **Per-invoice, therefore no allocation and no remainder.** Because the fee is computed per
   invoice, the per-invoice figures sum to the account figure by construction. There is no
   proportional allocation across buckets and so no remainder minor unit to place. That is
   precisely why it is computed at invoice grain rather than at account grain. The one exception:
   if a tenant sets an account-level `fee_min_post_minor` that forces a top-up, the top-up is
   allocated largest-remainder and **ties go to the oldest invoice.**

### 6.4.2 Not settled here — five decisions that need a human

These are marked, not guessed. Each has a provisional template default so the mechanism is
testable, and each is blocked from the GL until confirmed (§6.4.5). They all sit under
`open-questions.md` **Q4**, which already says no agent answers it.

| # | Decision | Options | Template default (provisional) | Why it is not mine |
|---|---|---|---|---|
| **D-1** | What the fee accrues **on** | (a) outstanding balance from invoice date · (b) **overdue balance only**, after terms lapse · (c) drawn amount / peak exposure | **(b) overdue only** | Changes revenue by a multiple and changes what the charge *is*. Accruing from invoice date makes it interest on a loan — the reading most likely to attract lending regulation in Ghana. Accruing on overdue balance makes it a late-payment charge. Q4 asks exactly this. |
| **D-2** | Simple or compounding; does an unpaid fee itself accrue fee | simple / compounding; `fee_on_fee` on or off | **simple, `fee_on_fee = false`** | 2–3%/month is already 26.8–42.6% effective annually (Q4). Compounding pushes it higher and sharpens the regulatory question. It is also unexplainable at a counter. |
| **D-3** | Day-count basis, and what a "month" means for a mid-month invoice | 30E/360 pro-rata · actual/365 · whole calendar month with no pro-rating | **30E/360 pro-rata** | Whole-month charging means a one-day-late invoice pays a full month. That is a commercial and possibly legal posture, not an engineering preference. |
| **D-4** | Posting cadence | daily · monthly at close · on settlement | **accrue daily in the sub-ledger, post monthly at close**, plus a final accrual on settlement date | Daily GL postings produce thousands of journals a month and an unreadable ledger; monthly means the GL trails the sub-ledger intra-month. Which trade the accountant wants is theirs. |
| **D-5** | Which GL account, and whether the fee sits inside revenue | facility fee income within revenue · other income (finance) · offset to finance cost | **separate income account, outside the revenue line used for gross margin** | See below — this one silently moves a number the whole financial model is built on. |

**On D-5, specifically.** The financial model tracks blended gross margin to three decimal places
(19.325% → 24.500%) and the ERP is required to report actuals against that curve. Facility fee
income has no cost of goods behind it. Post it inside revenue and it lifts reported gross margin
without a single extra bag of cement being sold — the margin bridge would look like it was working
when it was not. So whatever the accountant decides about presentation, **the margin report's
revenue denominator excludes facility fee income, and says so on its face.** Co-owned with
`ledger-engineer`; confirmed at the `CLAUDE.md` §2.8 gate.

**One more, unlisted anywhere and worth raising now:** is the facility fee a taxable supply?
Financial services have their own VAT treatment. The fee line carries a tax code like any other
line, and the correct code is a **jurisdiction-pack value** (`ADR-0007`) settled by the local
professional at that pack's review gate — not a default the template picks. Recorded here so it
does not surface a week before go-live.

### 6.4.3 The arithmetic

Under the provisional template settings (D-1 overdue-only, D-2 simple, D-3 30E/360):

```
-- 30E/360 day count between two dates, day-of-month clamped to 30
days30(d1, d2) = 360*(y2 - y1) + 30*(m2 - m1) + (min(day2,30) - min(day1,30))

-- cumulative fee owed on one invoice, as of a date
basis_minor    = invoice.outstanding_minor                        -- bigint
elapsed        = days30(due_date + grace_days, as_of)             -- 0 if negative
cumulative_fee = (basis_minor * rate_bp * elapsed) / (10000 * 30) -- integer, truncating

-- what this run posts
delta = cumulative_fee - sum(prior fee_accrual entries for this invoice)
```

Three rules that are not optional:

- **Every operand is `bigint` and the division is last.** Dividing early loses the fraction on
  every term. The intermediate for a GH₵10,000,000 balance at 300 bp over 30 days is ~9×10¹³,
  four orders of magnitude inside `int64`.
- **The formula contains no currency scale.** No literal `100` appears. It works unchanged for a
  zero-decimal or three-decimal currency, which is what `ADR-0007` requires of anything that
  touches money.
- **Truncation always favours the customer.** Each invoice loses under one pesewa per run, and
  because the computation is cumulative that loss does not accumulate over time. For a charge that
  gets argued about across a counter, erring in the customer's favour is the right direction.

**Worked example — the mid-month case D-3 exists to answer.**
Invoice dated 12 Feb 2027, GH₵12,000.00 (`1,200,000` pesewas), 30-day terms, 200 bp/month, no
grace. Due `12 Feb + 30 calendar days = 14 Mar 2027`. Paid 2 Apr 2027.

```
days30(2027-03-14, 2027-04-02) = 30*(4-3) + (2 - 14) = 18
fee = (1_200_000 * 200 * 18) / (10_000 * 30) = 4_320_000_000 / 300_000 = 14_400 pesewas
    = GH₵144.00
```

Cross-check: 2% of GH₵12,000 is GH₵240 for a full month; 18/30 of that is GH₵144. ✓

Note the two conventions doing different jobs. The **due date uses calendar days** — terms are a
promise made to a customer in real days. The **fee uses 30E/360** — so that "2% per month" costs
the same money in February as in March. Someone will eventually try to unify these. They must
not; unifying them either makes February cheaper than March or makes a "30-day" invoice fall due
on a date the customer was never told.

### 6.4.4 Posting

Under D-4's provisional default, at each period close, one journal per account:

```
Dr  Accounts receivable — facility fees      (sub-account, distinct from trade AR)
  Cr  Facility fee income                     (per D-5)
```

Two structural points:

- **Fee receivable is a separate AR sub-account from trade receivable.** Otherwise accrued fees
  inflate the receivables balance that DSO is computed from (§6.9), and DSO stops measuring how
  fast customers pay for goods.
- **A waived fee is a contra entry, never a deleted accrual.** `fee_waiver` posts against the
  same invoice, with a reason code and the authorising user. Deleting a posted accrual would
  break the sub-ledger-to-GL reconciliation, and "who waived GH₵4,000 of fees and why" is exactly
  the question an audit asks.
- Posting is idempotent by construction: `unique (tenant_id, credit_account_id, period_id)` on
  posted accruals. Re-running a closed period posts nothing rather than doubling the charge.

### 6.4.5 The gate, enforced in code rather than in a document

D-1 through D-5 are `NEEDS-HUMAN` and they block Phase 1 credit go-live. The failure mode is
obvious: the mechanism ships, the template defaults are sitting right there, and the business
starts charging on values no accountant ever confirmed because the software made it easy.

So the gate is a precondition, not a note:

- `credit_policy.fee_confirmed_at` is null until a human with the Accounts role confirms the five
  values, with their identity and a free-text note recorded.
- **The accrual job refuses to post to the GL while it is null. It fails loudly; it does not skip
  quietly.**
- It *does* still compute, in **shadow mode** — accruals are written to the sub-ledger flagged
  `provisional = true`, visible in reports and never posted. This is genuinely useful: the business
  gets to see what the fee would earn before deciding how to structure it, which is the input Q4
  actually needs.
- Every shadow figure carries a **"provisional — not chargeable"** label in every screen and every
  export. It is not enough that it is a boolean in the database; someone will quote a number off a
  report to a customer.

---

## 6.5 Network-wide exposure

A credit customer buys at Techiman on Monday and at Sunyani on Wednesday. **The limit is against
the account.** `credit_account` has no `location_id`; `credit_entry.location_id` exists for
attribution and reporting only and never scopes a balance query.

```
exposure(account)          = sum(credit_entry.amount_minor)
available(account)         = current_limit_minor - exposure(account)
exposure_by_location(acct) = sum(...) group by location_id     -- reporting only
```

This collides head-on with the location-scoped sync model, and the collision must be resolved
deliberately rather than by whichever rule happens to be written first.

**Stock is location-scoped; credit is not.** A device must be able to sell on credit to a customer
it has never served, so it needs that account's limit and balance. But shipping the full entry log
for every credit account to every tablet means a Tier 3 micro-outlet device in a district town
holds the complete credit history of the tenant's entire customer base. That is not a tenant leak
— `ADR-0005` holds — but it is a real blast radius on a lost or stolen low-end Android tablet.

**Sync rule (handoff to `sync-architect` and `rbac-security-engineer`):**

| Synced to a device | Not synced |
|---|---|
| `credit_account_snapshot` — account id, customer, status, current limit, current balance, bucket totals, `as_of_hlc`, `as_of_time` — for **all active accounts** in the tenant | Full `credit_entry` history for other locations |
| Full `credit_entry` rows **originating at that location** | Fee accrual detail for other locations |
| The account's `credit_limit_version` head | Superseded limit versions and review-queue payloads |

A snapshot plus locally-originated entries is sufficient to sell:

```
displayed_available = snapshot.limit - (snapshot.balance + sum(local unsynced entries))
```

and it is honest about being stale, which §6.8 requires anyway. Reducing the tablet to a balance
rather than a history costs a feature — staff cannot answer "what did I buy in March?" at a
disconnected counter — and that is the right trade for a device that lives in a shop.

---

## 6.6 Conflict case (a) — concurrent credit **limit** edits

The canonical hard case named in `CLAUDE.md` §2.2. A credit limit is a **risk judgement**. Two
people, both offline, each raise the same customer's limit — one to GH₵15,000 having seen a
deposit arrive, one to GH₵9,000 having heard the customer is slow paying. Last-write-wins does
not resolve this. It silently discards one person's judgement, and which one it discards depends
on clock skew.

**Make the limit an append-only decision log, and make the conflict structurally visible.**

```sql
create type limit_state as enum ('accepted','pending_review','superseded','rejected');

create table credit_limit_version (
  tenant_id         uuid     not null,
  id                uuid     not null,
  credit_account_id uuid     not null,
  limit_minor       bigint   not null check (limit_minor >= 0),
  terms_days        smallint not null,
  fee_rate_bp       integer  not null,
  reason_code       text     not null,
  note              text,
  supersedes_id     uuid,                  -- the version the author believed was current
  state             limit_state not null,
  decided_by        uuid     not null,
  decided_at_location uuid,
  effective_from    date     not null,
  hlc               text     not null,
  idempotency_key   uuid     not null,
  primary key (tenant_id, id),
  unique (tenant_id, idempotency_key)
);

-- at most one accepted child per parent: the fork detector, as a constraint
create unique index credit_limit_one_accepted_child
  on credit_limit_version (tenant_id, credit_account_id, supersedes_id)
  where state = 'accepted';
```

`supersedes_id` is a compare-and-set expressed as data. An author records not just the new limit
but **which version they believed they were replacing.** When two devices both write a version
claiming to supersede `V7`, the log has two children of `V7` — a fork, detectable by a plain query,
with no dependence on the sync layer understanding credit semantics. The server write path detects
it and routes; the partial unique index is the backstop that fails closed if the write path is ever
bypassed. Same belt-and-braces posture as RLS in `ADR-0005`, for the same reason: the failure is
expensive and silent.

**On fork, neither version is accepted.** Both go to the review queue with everything a human
needs to actually decide:

```sql
create table credit_review_item (
  tenant_id       uuid not null,
  id              uuid not null,
  kind            text not null,        -- 'limit_fork'
  credit_account_id uuid not null,
  version_a_id    uuid not null,
  version_b_id    uuid not null,
  -- context, captured at detection because it is unreconstructable later
  exposure_at_a_minor bigint not null,
  exposure_at_b_minor bigint not null,
  sales_under_a   jsonb not null,        -- credit sales made under each proposal before sync
  sales_under_b   jsonb not null,
  opened_at       timestamptz not null,
  resolved_at     timestamptz,
  resolved_by     uuid,
  resolution_version_id uuid
);
```

**Interim behaviour while the fork is open** — the question that gets forgotten and then discovered
at a counter. Between detection and human resolution, the effective limit is
`min(version_a.limit_minor, version_b.limit_minor)`. Not the parent, not the maximum, not the
newest HLC. The reasoning is asymmetric risk: under-extending credit is recoverable — the customer
waits, or a manager escalates — while over-extending is not, because the goods have left the yard.
The cost is real and staff must not be left guessing about it: a customer can be refused credit
they are entitled to, so the POS shows *"limit under review — reduced pending Accounts decision"*
rather than a bare number, and the review item names who has to act.

Two rules that fall out of this and are easy to get wrong:

- **A limit decrease below current exposure is legal and must be accepted.** It means "no further
  credit", not "reverse the sales". Any check that rejects `new_limit < exposure` is a bug.
- **`credit_limit_version` is Accounts-and-above only** (`CLAUDE.md` §2.6). Outlet staff and outlet
  managers cannot write it. This narrows how often case (a) occurs — but it does not eliminate it,
  because Accounts and head-of-operations users work from RDCs that go offline too. Restricting the
  permission is a frequency reduction, not a solution, and should never be presented as one.

---

## 6.7 Conflict case (b) — concurrent credit **sales** against the same limit

**Do not confuse this with case (a).** Two locations, both offline. The account's limit is
GH₵8,000 and it is unused. Techiman sells GH₵5,000 on credit; Sunyani sells GH₵5,000 on credit.
Neither device can see the other. Exposure lands at GH₵10,000 against an GH₵8,000 limit.

**No protocol prevents this.** Enforcing a global invariant requires either a quorum or a
partition-tolerant reservation, and both need connectivity — which is the one thing the product
cannot assume. Choosing availability here is not an oversight; it is `CLAUDE.md` §2.2 read
correctly: **a sale must never be lost.** The alternative — refusing all credit sales while
offline — would delete the feature in the exact market the product exists to serve.

So:

**1. Both sales are valid and both are recorded.** Never discard a real sale to make a limit hold.
The goods are gone; the customer owes the money; deleting the record does not un-sell the cement,
it just loses the receivable. And because the entry log is append-only (§6.2), there is no
data-layer conflict at all. The **invariant** breaks. The **data** does not.

**2. The breach is detected server-side on sync** and raised as an exception:

```sql
create table credit_exposure_exception (
  tenant_id           uuid   not null,
  id                  uuid   not null,
  credit_account_id   uuid   not null,
  limit_in_force_minor bigint not null,   -- the accepted limit version at the entries' business date
  exposure_before_minor bigint not null,
  exposure_after_minor  bigint not null,
  contributing_entry_ids uuid[] not null,
  detected_at         timestamptz not null,
  status              text not null,      -- 'open'|'accepted'|'collecting'|'resolved'
  resolution          text,
  resolved_by         uuid
);
```

**3. Each contributing sale carries what the device thought it knew.** This is the field that makes
the exception reviewable rather than merely alarming:

```sql
alter table sale add column credit_limit_check text not null;
  -- 'verified_online' | 'unverified_offline' | 'sub_limit_only' | 'manager_override'
alter table sale add column believed_available_minor bigint;
alter table sale add column snapshot_as_of timestamptz;
alter table sale add column offline_authorised_by uuid;
```

Without these, every breach looks the same. With them, Accounts can distinguish *"the device was
blind and did the best it could"* from *"a manager overrode a limit they could see"* — and those
two get different conversations.

**4. Resolution is a human decision, and none of the options delete a sale.** Accounts may raise
the limit (writing a new `credit_limit_version` with reason code `breach_ratified`), hold the
account so no further credit sales are possible until exposure is brought under, demand immediate
payment, or apply the security deposit. The system never auto-raises a limit to make a breach
disappear.

### Soft controls that degrade honestly

Prevention is impossible; **bounding the damage is not.** Two controls, both per-tenant policy:

| Control | Mechanism | What it costs |
|---|---|---|
| **Per-location sub-limit** | `credit_account_location_cap (credit_account_id, location_id, cap_minor)`. While a device's snapshot is stale, it may only sell up to its own cap. Caps may sum to more than the account limit — that is expected, and the point is that each device bounds *its own* contribution. | A customer with real headroom can be refused at one outlet while it sits unused at another. Needs a manager override path or it will be resented. |
| **Offline single-sale ceiling** | `credit_policy.offline_ceiling_minor`. A credit sale above this cannot complete offline at all. | The strongest control, because worst-case breach becomes `ceiling × offline locations` rather than unbounded. It also refuses exactly the large contractor sale the business most wants — so the ceiling is a commercial decision, set per tenant, not an engineering default. |
| **Manager authorisation above a threshold** | `offline_auth_threshold_minor`; the authorising user is recorded in `offline_authorised_by` on the sale. | Does not prevent anything. It attaches a name to the risk, which is what makes the exception review a conversation instead of a mystery. |

**Rejected: staleness-decayed headroom** — offering, say, full headroom on a fresh snapshot, 50% at
a day old, sub-limit beyond. It models the risk more finely and it is the kind of thing that looks
clever in a design document. It fails the counter test: staff have to explain the number to a
customer standing in front of them. *"Your limit is GH₵8,000 but we can only do GH₵4,000 today
because we're offline"* is explainable. A decaying function is not. Sub-limit plus ceiling plus
override, all of which are fixed numbers a person can state out loud.

---

## 6.8 What the counter is allowed to claim

**The UI must never claim a limit was checked when it could not be.** This is not a wording
preference. It is the difference between a staff member who knows they are taking a risk and one
who has been told by the software that everything is fine.

The data obligations are mine; `pos-ux-specialist` owns how it reads:

- Available credit is **never shown without provenance.** Every display of `available` is
  accompanied by its `snapshot_as_of` and its online/offline state. *"Available GH₵3,200 — checked
  just now"* and *"Available GH₵3,200 — last synced 2 days ago; other outlets may have sold since"*
  are different claims and must look different.
- **No green tick, no "limit check passed", no unqualified approval on a stale snapshot.** A tick
  means verified. If it could not be verified, the affordance has to say so.
- `credit_limit_check` is a **persisted column on the sale**, not a UI state. A warning banner that
  exists only on a screen is not evidence. When the exception is reviewed three weeks later, the
  question "did the device know?" must be answerable from the row.
- The same flag surfaces on the customer statement line and in the exception queue, so a breach
  investigation does not require reconstructing what a tablet was displaying at 15:40 on a Tuesday.

---

## 6.9 Measuring DSO — and the 15-day gap

`open-questions.md` **Q2** flags that the financial model assumes **15 days** receivables while
terms are **30–60**. The ERP measures the real figure from day one. Two things matter about *how*.

**Report two different numbers, and never let them be confused.**

| Metric | Formula | What it is for |
|---|---|---|
| **Credit DSO** | countback against **credit sales only** | How fast credit customers actually pay. The collections number. |
| **Blended receivables days** | `trade AR / total revenue × days` | The figure that maps to the financial model's working-capital line. **This is the only one comparable to the 15-day assumption.** |

Dividing trade AR by *total* revenue when most of tenant #1's turnover is cash retail produces a
flatteringly small number that measures nothing. Dividing by credit sales alone produces the true
collections figure — but that figure is not what the model assumed, and reporting it against the
15-day line would be comparing two different quantities and calling it a variance.

**Use countback, not the simple average.** Walking the AR balance back through the most recent
months' credit sales until it is exhausted. On a book growing 2.64M → 6.29M → 12.52M, the simple
`AR / average revenue × days` formula lags the ramp badly and *understates* DSO exactly when the
cash position is tightening. Cost: countback needs three months of history and is harder to
explain. Both are reported; countback is the headline and the simple figure is shown beside it.

Trade AR excludes accrued facility fees (§6.4.4) — otherwise the fee, which grows precisely when
customers are slow, inflates the number that measures how slow they are.

### What the ERP should surface about Q2 that nobody has written down

**The 15-day assumption is not obviously wrong. It is unstated.** Fifteen blended days is
arithmetically consistent with 30-day terms *if* credit is roughly half of revenue and everyone
pays on time — or with 45-day average collection if credit is a third of revenue. The assumption
encodes a **credit-mix** belief that appears nowhere in the model. So the credit-sales share of
revenue is a first-class reported metric from day one, per location and network-wide. It is the
hidden variable in Q2, and it is measurable from the first week of trading, long before DSO has
enough history to mean anything.

**The order of magnitude, so the size of the question is visible.** FY3 revenue is GH₵12,518,000
and the FY3 cash trough is GH₵(1,393,958) — the plan's most important funding milestone.

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

**And the sharpest version of Q2, straight from the source documents:** the model already **books
the benefit** of contractor credit — business plan §11.4 credits faster inventory turnover with
easing the trough by roughly GH₵107,000 — while **assuming away its cost** at 15 days receivables.
The demand-pull benefit is modelled; the working-capital drag that pays for it is not. That
asymmetry, not the 15 itself, is what the accountant should be shown.

### Standing credit reports

Beyond DSO: ageing mix and % of AR past due (by location and network); fee accrued vs. fee
collected vs. fee waived; write-off rate; and **deposit coverage ratio** per account
(`security_deposit_minor / exposure`) — the business plan says credit is *"secured against
contractor deposits"*, so an account whose coverage falls below policy is a collections trigger,
not a footnote. See the Concerns below on whether that security actually exists yet.

---

## 6.10 Tests

Money, sync and tenant-boundary — this section is all three of `CLAUDE.md` §2.7. Written with the
code, with `money-test-engineer` and `sync-test-engineer` from the start. The bugs live at
boundaries and month ends:

- **Ageing boundaries** — due date exactly, due+1, 30/31, 60/61, 90/91; across a month end; across
  a year end; across 29 Feb 2028 (FY2 spans it).
- **Fee accrual** — invoice settled within terms accrues nothing under D-1(b); settlement exactly
  on the due date; a 28-day and a 31-day month produce **identical** monthly charges under 30E/360;
  cumulative-delta posting after a suppressed sub-minimum run; re-running a closed period posts
  nothing.
- **Allocation** — per-invoice fees sum to the account total; an account-level minimum top-up lands
  on the oldest invoice; a payment allocation always sums to the payment.
- **Exposure** — property test: `sum(credit_entry) == rollup` for randomly interleaved offline
  batches, in every arrival order.
- **Case (a)** — two devices supersede the same version: both `pending_review`, neither lost,
  `min()` applied in the interim, the accepted resolution supersedes both.
- **Case (b)** — two offline credit sales breach one limit: both recorded, exactly one exception
  raised, exposure exact, `believed_available_minor` captured on each sale.
- **Isolation** — every credit read path proves a second tenant's accounts, limits, entries and
  exceptions are invisible.

---

## 6.11 Concerns

Four, in order of how much they worry me.

**1. "Secured against contractor deposits" is designed nowhere.** The business plan names deposits
as the security behind credit limits (§10 risk table) and this section reports a deposit coverage
ratio against a `security_deposit_minor` column — **with nothing behind it.** There is no deposit
product in the brief, no ADR, and nothing in the Phase 1 scope list. A real deposit needs a held-
funds ledger, a GL liability account it cannot be swept out of, a claim procedure, and rules about
what happens when a customer with a deposit goes into default. If deposits genuinely secure the
credit book then that is a **Phase 1 dependency of credit**, not a Phase 3 nicety, and it should be
raised as a new open question. Proposed to `product-manager`, who owns that file. Until it exists,
every "secured" claim about this credit book is a column with a number typed into it.

**2. Shadow-mode accrual will be quoted to a customer.** The §6.4.5 gate blocks GL posting until
D-1…D-5 are confirmed, which is the right control. But provisional figures are visible in reports
by design — that visibility is the point, since Q4 needs the numbers to reach a decision. Someone
will read one to a contractor. Labelling helps and is required, but the residual risk is real and
the mitigation is partly procedural: Accounts should be told, in words, that the fee is not
chargeable until the policy row is confirmed.

**3. The honest expectation is that limit breaches will happen, and software does not collect
money.** §6.7 bounds the damage and surfaces every breach; it does not stop one. Tenant #1 will
have exposure exceptions in their first months of multi-outlet trading. What the business needs
alongside the exception queue is a **commercial** policy — who calls the customer, what happens to
the outlet manager who authorised an offline sale that went bad, at what exposure the account gets
held. That is a founder decision, and an exception queue nobody has been made accountable for is a
list that grows.

**4. Credit data is the first thing I would move off the shared schema.** No disagreement with
`ADR-0005` — shared schema with RLS is right for a product finding its first customers, and the
tenant → database mapping already exists as the upgrade path. But of everything in this system, a
competitor's credit positions and customer limits are the data whose leak would be most
commercially fatal, and §6.5 puts an account-level snapshot of the whole customer base on every
tablet in the network. When that mapping is first exercised for a large or regulated tenant, the
credit sub-ledger is the reason it will be.
