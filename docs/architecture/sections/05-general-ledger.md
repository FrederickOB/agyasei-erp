# 5. General Ledger and Chart of Accounts

**Phase:** 3 (schema and constraints land in the Phase 0 data model; posting begins in Phase 1)
**Owner:** `ledger-engineer` · **Gate:** `compliance-gatekeeper` holds §5.12
**Depends on:** `ADR-0002`, `ADR-0004`, `ADR-0005`, `ADR-0006`, `ADR-0007`

There is no accounting SaaS behind this platform. For every tenant, this ledger *is* the book of
account. That single fact sets the engineering standard for this section: everywhere else a bug
loses a feature; here a bug misstates a company's books, and the misstatement is discovered by
someone else, months later, at a filing deadline.

> **Revision note.** Reviewed adversarially on 2026-08-20 and revised. Six findings were blocking,
> and the sharpest of them proved the point above: **as first written, reversing an entry moved
> the original out of every statement query, so a reversal changed the P&L by −X rather than 0, and
> retroactively restated a period already shown to a lender — while every listed invariant stayed
> green.** That is exactly the class of defect this section exists to prevent, in this section.
> Corrections are inline where short; the full disposition and the new mechanisms
> (`posting_exception`, control-account ties, the attestation gate, `posting_role_catalog`) are in
> **§5.14**. **Where §5.14 and the body differ, §5.14 governs.**

---

## 5.1 What is decided here, in one page

| # | Decision | Cost accepted |
|---|---|---|
| 1 | A journal entry is a **header plus ≥2 lines**. No signed-amount table. `debit_minor` and `credit_minor` are separate non-negative `bigint` columns. | Slightly wider rows; one extra CHECK to forbid a line with both sides set. |
| 2 | Balance is enforced **in Postgres, twice**: a non-deferrable CHECK on trigger-maintained header aggregates (fast path), plus a **deferred constraint trigger** that recomputes from the lines at COMMIT (backstop). | Two mechanisms to understand. The backstop fires per row. |
| 3 | Entries balance **per location**, not merely per entry. Cross-location postings carry inter-location clearing lines. | Extra lines on transfers and HQ allocations. Buys real per-location balance sheets. |
| 4 | Posted entries are immutable — enforced by **privilege, policy and trigger**. Corrections are reversing entries. | No "fix the typo". Every correction is two entries in the audit trail. |
| 5 | The chart of accounts is a **per-tenant template applied once at onboarding**. No live inheritance, no runtime template lookup. | Template improvements do not reach existing tenants automatically; they arrive as a reviewed diff. |
| 6 | **Location is a dimension on the posting line**, never an account per location. | Every report must remember to group by it. Every posting must supply it. |
| 7 | **The GL is server-side only.** Devices sync business documents; the server posts them. No journal table is in any sync rule. | An outlet manager cannot read the ledger offline. Mitigated by a syncable read-only report snapshot (§5.9). |
| 8 | Posting rules are **platform code**; what a tenant configures is the **account mapping**. | No tenant-editable rule engine — deliberately. |
| 9 | Inventory is **perpetual**, costed at **moving weighted average per (SKU, location)**, computed server-side at posting time. | Late-arriving documents do not retro-restate posted COGS. **Revised:** the difference no longer sits in an unexplainable variance account — the subledger's replayed valuation is canonical and the GL is tied to it by a **period-close inventory revaluation entry** per location, with a nightly `Σ(qty × WAC) = GL INVENTORY` assertion (§4.7.4, §5.14.5). Method remains `GL-Q2`. |
| 11 | **A GL posting failure never rejects a settled document.** Acceptance and posting are separate; a failure opens a `posting_exception` and blocks the close. | An unposted settled document is a visible, blocking exception rather than an invisible gap — or, as first drafted, a quarantined sale. §5.14.4. |
| 10 | Corporate income tax is a **manual journal from the accountant's computation**, never derived from a rate. | The 25% in tenant #1's model is a planning figure, not a posting input. |

---

## 5.2 The journal schema

### 5.2.1 Why not a signed amount

The shortcut every home-grown ledger reaches for is one row per transaction with a signed
`amount`. It is not double-entry, and it fails in three specific ways:

- **Sign convention is implicit.** `-500` on an income account and `-500` on an expense account
  mean opposite things. Every reader — every report, every future maintainer — has to carry the
  convention in their head, and one of them will get it wrong.
- **It cannot express a three-sided transaction.** A cash sale with tax and a levy is four lines
  before COGS. A signed-amount table degrades this into "the amount, plus some other columns",
  and the other columns are not constrained to sum to anything.
- **There is nothing to balance.** "Unbalanced" stops being a state the database can detect.

So: two non-negative columns, exactly one of them non-zero per line.

### 5.2.2 Tables

Every table carries `tenant_id` as the leading column of its primary key, and every foreign key
is **composite on `tenant_id`** — a journal line physically cannot reference another tenant's
account, independently of RLS (`ADR-0005`, "enforce this structurally").

```sql
-- Fiscal calendar is tenant configuration. Tenant #1's year runs 1 Aug – 31 Jul;
-- nothing in the platform assumes January.
create table fiscal_year (
  tenant_id   uuid not null,
  fy_code     text not null,             -- 'FY1', '2026/27' — tenant's label
  starts_on   date not null,
  ends_on     date not null,
  primary key (tenant_id, fy_code)
);

create table accounting_period (
  tenant_id   uuid not null,
  period_id   uuid not null,
  fy_code     text not null,
  seq         int  not null,             -- 1..n within the fiscal year
  starts_on   date not null,
  ends_on     date not null,
  status      text not null,             -- 'open' | 'closed' | 'locked'
  closed_at   timestamptz,
  closed_by   uuid,
  reopened_at timestamptz,               -- the "recorded reason" had nowhere to live
  reopened_by uuid,
  reopen_reason text,
  primary key (tenant_id, period_id),
  unique (tenant_id, fy_code, seq),
  foreign key (tenant_id, fy_code) references fiscal_year (tenant_id, fy_code),
  constraint ap_status check (status in ('open','closed','locked')),
  constraint ap_range  check (starts_on <= ends_on),
  constraint ap_reopen check (reopened_at is null
                              or (reopened_by is not null and reopen_reason is not null)),
  -- periods within a fiscal year must TILE it: no gaps, no overlaps. Without this a
  -- document_date can fall in a gap and period resolution is undefined.
  exclude using gist (tenant_id with =, fy_code with =,
                      daterange(starts_on, ends_on, '[]') with &&)
);
-- plus a deferred assertion at fiscal-year close: Σ period ranges = the fiscal year's range.

create table journal_entry (
  tenant_id            uuid   not null,
  journal_entry_id     uuid   not null,
  entry_no             bigint not null,      -- gapless per (tenant, fiscal year); see §5.2.5
  period_id            uuid   not null,
  fy_code              text   not null,      -- entry_no is gapless WITHIN a fiscal year
  document_date        date   not null,      -- business date from the source document
  posted_at            timestamptz,          -- server clock, set once, at posting
  status               text   not null,      -- 'draft' | 'posted'  — see below
  source_kind          text   not null,      -- 'cash_sale','credit_sale','receipt',
                                             -- 'stock_transfer','payroll','manual', ...
  source_id            uuid,                 -- the originating document
  idempotency_key      text   not null,      -- document key, or a DETERMINISTIC server key
  posting_rule_version int    not null,      -- which rule set produced this entry
  mapping_set_version  int    not null,      -- which account mapping produced it (§5.6.1)
  is_late_arrival      boolean not null default false,
  memo                 text,
  created_by           uuid   not null,
  reverses_entry_id    uuid,                 -- set on a reversing entry
  reversed_by_entry_id uuid,                 -- set on the original when reversed

  -- derived, maintained by trigger from journal_line; see §5.2.4
  debit_total_minor    bigint not null default 0,
  credit_total_minor   bigint not null default 0,
  line_count           int    not null default 0,

  primary key (tenant_id, journal_entry_id),
  unique (tenant_id, source_kind, idempotency_key),
  unique (tenant_id, fy_code, entry_no),     -- was unique(tenant_id, entry_no), which
                                             -- collides on FY2's entry 1 if the counter
                                             -- resets annually as §5.2.5 implies
  foreign key (tenant_id, period_id) references accounting_period (tenant_id, period_id),
  constraint je_status check (status in ('draft','posted')),
  constraint je_posted_balanced check (
    status = 'draft'
    or (line_count >= 2
        and debit_total_minor = credit_total_minor
        and debit_total_minor > 0)
  ),
  constraint je_posted_has_time check ((status = 'draft') = (posted_at is null))
);

-- One reversal per entry, ever.
create unique index je_one_reversal
  on journal_entry (tenant_id, reverses_entry_id)
  where reverses_entry_id is not null;

-- One entry per source document, ever. Without this two entries may reference the same
-- document under different idempotency keys and both post — which is precisely the
-- double-posting §5.2.4 claims to prevent.
create unique index je_one_per_source
  on journal_entry (tenant_id, source_kind, source_id)
  where source_id is not null and reverses_entry_id is null;

-- The gapless counter, which §5.2.5 referenced and never defined.
create table gl_counter (
  tenant_id uuid not null,
  fy_code   text not null,
  next_no   bigint not null default 1,
  primary key (tenant_id, fy_code),
  foreign key (tenant_id, fy_code) references fiscal_year (tenant_id, fy_code)
);

create table journal_line (
  tenant_id         uuid    not null,
  journal_entry_id  uuid    not null,
  line_no           int     not null,
  account_id        uuid    not null,
  account_postable  boolean not null default true,   -- see §5.4.2
  location_id       uuid    not null,                -- the dimension; NOT NULL, see §5.5
  debit_minor       bigint  not null default 0,
  credit_minor      bigint  not null default 0,
  currency_code     char(3) not null,
  counterparty_kind text,                            -- 'customer'|'supplier'|'employee'|null
  counterparty_id   uuid,
  product_id        uuid,                            -- for COGS / inventory analysis only
  source_line_id    uuid,
  memo              text,

  primary key (tenant_id, journal_entry_id, line_no),
  foreign key (tenant_id, journal_entry_id)
    references journal_entry (tenant_id, journal_entry_id) on delete cascade,
  foreign key (tenant_id, account_id, account_postable)
    references gl_account (tenant_id, account_id, is_postable),
  foreign key (tenant_id, location_id)
    references location (tenant_id, location_id),

  constraint jl_one_side     check ((debit_minor = 0) <> (credit_minor = 0)),
  constraint jl_non_negative check (debit_minor >= 0 and credit_minor >= 0),
  constraint jl_postable     check (account_postable)
);

create index jl_by_account on journal_line (tenant_id, account_id, journal_entry_id);
create index jl_by_location on journal_line (tenant_id, location_id, account_id);
```

Notes on specific columns:

- **`jl_one_side`** — `(debit = 0) <> (credit = 0)` rejects both-zero *and* both-non-zero. A
  zero-value line carries no information; if a tax component computes to nil, the rule emits no
  line rather than a zero one. This keeps `sum(debit) - sum(credit)` meaningful without a
  `filter` clause anywhere.
- **`currency_code`** — redundant today. `ADR-0007` gives a tenant exactly one jurisdiction and
  puts FX out of scope, so a trigger asserts every line equals the tenant's pack currency. It is
  carried anyway because retrofitting a currency column into a populated ledger is far worse than
  carrying a constrained one. Note that a genuine multi-currency ledger needs
  `transaction_amount` + `functional_amount` + a rate row per line, plus revaluation entries —
  that is a different schema, not a nullable extra column, and it is deliberately not built.
- **Amounts are minor units, and the scale is a pack value** (`ADR-0004`, `ADR-0007`). Nothing in
  the ledger divides by 100. Presentation reads `jurisdiction.minor_unit_scale` once, at the
  formatting boundary.
- **`posting_rule_version`** — an auditor asking "why did this sale post like that in March?"
  needs the rule set as it stood in March, not as it stands today. One integer buys that.

### 5.2.3 Balance enforcement, mechanism by mechanism

The brief's instruction is "a deferred constraint, a trigger, or a check on a derived aggregate".
Here is what each actually gives you in Postgres, and what is being built.

**A deferred CHECK constraint does not exist.** Postgres CHECK constraints are never deferrable —
only `UNIQUE`, `PRIMARY KEY`, `FOREIGN KEY` and `EXCLUDE` accept `DEFERRABLE`. This matters,
because "defer the balance check to end-of-transaction" is the first thing everyone reaches for
and it is simply not available. What *is* available is a **`CREATE CONSTRAINT TRIGGER … DEFERRABLE
INITIALLY DEFERRED`**, which is a different object with different ergonomics.

**Mechanism A — CHECK on a trigger-maintained aggregate (the fast path).**
`journal_entry.debit_total_minor / credit_total_minor / line_count` are maintained by an
`AFTER INSERT OR UPDATE OR DELETE` row trigger on `journal_line`. The header CHECK
`je_posted_balanced` then gates the `draft → posted` transition. Because lines are written while
the entry is `draft` and posting is a single `UPDATE … SET status='posted'`, no deferral is
needed: the constraint is evaluated at exactly the moment it becomes meaningful.

- *Cost:* the constraint tests a **derived** column, and derived columns can lie. A direct
  `UPDATE journal_entry SET debit_total_minor = …` by a superuser, a migration run with
  `session_replication_role = replica`, or a bug in the maintaining trigger all produce a header
  that satisfies the CHECK while the lines beneath it do not balance.

**Mechanism B — deferred constraint trigger recomputing from the lines (the backstop).**
Fires at COMMIT, re-aggregates the actual lines, and asserts both that they balance
**per location** and that the header aggregates equal the recomputed sums.

```sql
create or replace function gl_assert_entry_balanced() returns trigger
language plpgsql as $$
declare
  v_tenant uuid;
  v_entry  uuid;
  v_status text;
  v_bad    record;
begin
  if tg_op = 'DELETE' then
    v_tenant := old.tenant_id; v_entry := old.journal_entry_id;
  else
    v_tenant := new.tenant_id; v_entry := new.journal_entry_id;
  end if;

  -- Draft entries are not the ledger; they are allowed to be in-progress.
  -- FAILS CLOSED: on a cascading DELETE of a posted entry the parent is gone by COMMIT,
  -- so the original "if not exists (... status <> 'draft') then return null" passed
  -- silently in exactly the session_replication_role / migration scenario this
  -- mechanism exists to survive. Absence of the parent is now an error, not a pass.
  select e.status into v_status
    from journal_entry e
   where e.tenant_id = v_tenant and e.journal_entry_id = v_entry;
  if not found then
    raise exception 'GL0003: journal_line references entry % which no longer exists', v_entry
      using errcode = 'integrity_constraint_violation';
  end if;
  if v_status = 'draft' then
    return null;
  end if;

  -- (1) balance within every location touched by the entry
  for v_bad in
    select l.location_id,
           sum(l.debit_minor)  as dr,
           sum(l.credit_minor) as cr
      from journal_line l
     where l.tenant_id = v_tenant and l.journal_entry_id = v_entry
     group by l.location_id
    having sum(l.debit_minor) <> sum(l.credit_minor)
  loop
    raise exception
      'GL0001: entry % unbalanced at location % (Dr % / Cr %)',
      v_entry, v_bad.location_id, v_bad.dr, v_bad.cr
      using errcode = 'integrity_constraint_violation';
  end loop;

  -- (2) the header aggregates must equal the lines they claim to summarise
  perform 1
     from journal_entry e
     join (select sum(debit_minor)  d, sum(credit_minor) c, count(*) n
             from journal_line
            where tenant_id = v_tenant and journal_entry_id = v_entry) s on true
    where e.tenant_id = v_tenant and e.journal_entry_id = v_entry
      and (e.debit_total_minor, e.credit_total_minor, e.line_count)
          is distinct from (s.d, s.c, s.n::int);
  if found then
    raise exception 'GL0002: entry % header totals do not match its lines', v_entry
      using errcode = 'integrity_constraint_violation';
  end if;

  return null;
end $$;

create constraint trigger jl_balanced
  after insert or update or delete on journal_line
  deferrable initially deferred
  for each row execute function gl_assert_entry_balanced();

-- SECOND TRIGGER, and without it the per-location rule is unenforced for exactly the
-- entries a human keys. §5.2.3 itself describes the manual-journal flow as "lines are
-- written while the entry is draft, and posting is a single UPDATE ... SET
-- status='posted'". In that flow the lines are inserted in transaction 1, where the
-- function short-circuits on draft, and transaction 2 touches ONLY journal_entry — so
-- no journal_line row is modified and jl_balanced never fires at all. The sole
-- surviving check is the header CHECK, which tests entry-level totals and knows nothing
-- about location. An Accounts user keying a depreciation journal that debits HQ and
-- credits Sunyani balances in total, posts, and breaks §5.5.3 on the first manual
-- journal — with §5.9.2's diagnostic silent, because it is the trial balance that goes
-- out, not the entry.
create constraint trigger je_balanced_on_post
  after insert or update on journal_entry
  deferrable initially deferred
  for each row when (new.status = 'posted')
  execute function gl_assert_entry_balanced_hdr();
```

- *Cost 1:* `CREATE CONSTRAINT TRIGGER` **must** be `FOR EACH ROW` — there is no statement-level
  form. A 12-line entry runs the aggregate twelve times. At tenant #1's volumes this is
  irrelevant (see §5.2.5), but a bulk opening-balance load of 10,000 lines is 10,000 aggregates.
  Mitigation for that one path: the loader records already-checked entry ids in a guard table and
  the function short-circuits on a hit. **The guard is gated, not a `pg_temp` table** — any session
  can `CREATE TEMP TABLE` of a known name and thereby disable this section's only per-location
  check for its own transaction. The short-circuit requires a GUC that only a maintenance role may
  `SET`, and the bulk loader must run one **full verification pass inside the same transaction**
  before it commits. A performance mitigation that doubles as an off switch is not a mitigation.
  Note also that this cost is **not** confined to opening balances: a 500-customer facility-fee
  accrual is 1,000 lines and 1,000 re-aggregations at COMMIT, every month, and the same at every
  payroll run — which is one more reason the fee is **one entry per credit account** rather than
  one shared entry (§5.6.5).
- *Cost 2:* it raises at `COMMIT`, not at the offending statement. The error message therefore
  has to name the entry and location itself — a bare "constraint violated" at commit time is
  close to undebuggable. Hence the explicit `GL0001` / `GL0002` codes.
- *Cost 3:* a superuser can `ALTER TABLE … DISABLE TRIGGER`. Nothing in the database defends
  against its own superuser; that is an operational control (§5.11), not a schema one.

**Why both.** This is the same belt-and-braces shape `ADR-0005` uses for tenant isolation:
application scoping *and* RLS, so a mistake fails closed. Mechanism A gives an immediate, cheap,
well-located error on the hot path. Mechanism B guarantees that the thing Mechanism A tests is
actually true. Neither alone is sufficient: A can be lied to, B alone is slow and reports late.

**Rejected: enforce it in application code.** Named only to close it off. A service-layer
`assert(debits === credits)` is bypassed by the next code path — a data migration, an admin
script, a support fix, an import — and every one of those is written under time pressure by
someone who does not know the invariant exists. The requirement is explicit that this lives in
the database, and it is right.

### 5.2.4 One document, one entry

Every source document produces **exactly one journal entry**, containing all of its lines —
a cash sale's entry carries the cash, revenue, tax and COGS/inventory lines together. One
document, one `idempotency_key`, one audit trail, one thing to reverse. The alternative (a
separate "COGS entry") doubles the reversal surface and lets half a sale exist.

`unique (tenant_id, source_kind, idempotency_key)` makes a replayed sync a no-op rather than a
double posting. Per `ADR-0005`, the uniqueness is **scoped to the tenant, never global**.

### 5.2.5 Numbering, and why it can be gapless

`entry_no` is gapless within `(tenant_id, fiscal_year)`, allocated from a counter row with
`UPDATE gl_counter SET next_no = next_no + 1 … RETURNING` inside the posting transaction.
A Postgres `sequence` will not do: it is non-transactional by design and leaves gaps on rollback,
and "why is journal 4471 missing" is a question an auditor is entitled to ask.

The cost is that posting serialises per tenant per fiscal year. The arithmetic says that is fine:
tenant #1 at FY10 does GH₵41,184,000 across 25 outlets; even at an implausibly low GH₵100 average
basket that is ~411,000 documents a year, under 1/second network-wide, and the counter update
holds a row lock for microseconds. If a future tenant outgrows it, the escape hatch is
per-location sub-sequences (`entry_no` becomes `(location_prefix, n)`) — not abandoning
gaplessness.

### 5.2.6 The GL does not sync to devices

**No GL table appears in any sync rule.** Devices sync business documents — sales, receipts,
stock movements, till counts — with an idempotency key and a logical timestamp (§2.2). The server
posts them on arrival. Three reasons:

1. A device cannot see tenant-wide state it needs: period open/closed status, the gapless
   counter, the current moving-average cost at another location, the posting rule version.
2. A posting rule change must take effect for the whole tenant at once. Rules living on 200
   tablets at 200 different versions is a books-level inconsistency, not a stale cache.
3. It removes the tenant's single most sensitive dataset from every device, which is the
   cheapest possible contribution to `ADR-0005`'s unrecoverable-leak problem.

**This is a real deviation from "offline-first is the architecture" and it is named as such.** The
cost: an outlet manager cannot open their outlet's P&L with the connection down. The mitigation is
a **read-only, per-location report snapshot table** — refreshed server-side after each close and
on demand, scoped by the manager's location, and syncable *because it is a report, not the
ledger*. Nothing on a device is a source of accounting truth.

**Late arrivals.** `document_date` is the business date; a sale made offline on the 29th may
arrive on the 3rd. On posting, the server resolves the period:

- period `open` → post normally;
- period `closed` or `locked` → post into the **earliest open period**, retain `document_date`,
  set `is_late_arrival = true`, and list it on the late-arrivals report at the next close.

**Period status is enforced in the database, not in application logic.** A `BEFORE INSERT OR
UPDATE` trigger on `journal_entry` refuses a `posted` entry whose `period_id` is not `open`, with
one audited exception for the closing entry itself. §5.2.3's own argument for putting balance in the
database — *"a service-layer assert is bypassed by the next data migration, admin script or
import"* — applies with full force to the rule that protects already-published statements, and
period resolution was the one place this section left it in application code.

**The reopen rule, stated once.** The earlier text said in adjacent sentences that reopening is
"prohibited" and that "a `closed` period may be reopened by the Accounts role with a recorded
reason". The second is the rule: **`closed` may be reopened by the Accounts role, with
`reopened_at`, `reopened_by` and `reopen_reason` recorded and the reopen listed on the next close;
`locked` never can.** What is prohibited is reopening *silently*, and what is discouraged is
reopening at all — the late-arrival path exists so that the ordinary case does not require it.

**The close gate is device attestation, not a data watermark — `GL-Q4`, restated and answered.**
The requirement is right: a period cannot be locked while any location has an unsynced document
dated on or before the period end. The mechanism first asked for was wrong. **A high-water mark
computed from received data cannot prove absence**: a tablet that is powered off, stolen or on a
dead SIM sends nothing, so the server cannot distinguish "nothing pending" from "400 sales
pending", and the gate is either vacuous or permanently blocking. §3.11.4 therefore delivers
`device_sync_state` with an explicit **queue-drained acknowledgement**: a location is attested
through date *T* only when **every active enrolled device at that location has reported an empty
queue after *T***. A device that has not attested **blocks the close and is named**; excluding it is
an explicit, audited Accounts action recorded on the close record with the device's last-reported
outstanding count. That closes the contradiction between this paragraph and §5.7.4 too — close is
gated on attestation, and the late-arrival path is for documents from devices that were
*deliberately excluded*, not for documents nobody knew were missing.

---

## 5.3 Immutability and reversal

A posted entry is immutable. This is enforced at three levels, deliberately redundant:

1. **Privilege.** The application role has `INSERT` on `journal_line` and `journal_entry` and
   **no `UPDATE` or `DELETE` on `journal_line` at all**. On `journal_entry` it holds column-level
   update only: `GRANT UPDATE (status, posted_at, debit_total_minor, credit_total_minor,
   line_count, reversed_by_entry_id) ON journal_entry TO app_writer;`. Amounts, dates, accounts
   and source references are not grantable targets — a `SET document_date = …` fails on privilege
   before any trigger runs.
2. **Policy.** RLS on every GL table, `FORCE ROW LEVEL SECURITY` so the owner is subject too.
   `UPDATE`/`DELETE` policies carry `USING (status = 'draft')`.
3. **Trigger.** A `BEFORE UPDATE OR DELETE` trigger raises on any posted row, except the single
   whitelisted transition `reversed_by_entry_id: null → <uuid>` and the terminal
   `status: 'posted' → 'reversed'`. `status` may never move backwards from `posted`.

Three layers because each fails differently: privileges are dropped by a careless migration,
policies are bypassed by `BYPASSRLS`, triggers are disabled by `session_replication_role`. The
combination has no single point of failure short of a superuser.

**Corrections are reversing entries.** A reversal is a new entry with the same lines, debits and
credits swapped, same accounts, same locations, same amounts, `reverses_entry_id` set, dated into
the earliest open period at or after the original's `document_date`. The corrected version then
posts as a fresh entry.

**The original's status does not change, and `'reversed'` is no longer a status at all.** As first
written the original moved to `status = 'reversed'` while every statement query filtered
`status = 'posted'` — so the original **dropped out of the statements entirely** and only the
reversing entry remained. A GH₵100,000 March credit sale reversed in May changed revenue by
**−100,000, not 0**, and re-rendered March's P&L 100,000 lower than when it was signed: the exact
retroactive restatement §5.4.3 reason 2 says must never happen as a side effect. Neither listed
invariant caught it — the trial balance still summed to zero because a reversal is self-balancing,
and "reversal fully unwinds" was asserted over `journal_line`, not through the statement query.
Both were green while the P&L was wrong by 2×.

Removing the status value is better than widening the filter to `status in ('posted','reversed')`,
because there is then **no status value that can accidentally be excluded** by the next report
someone writes. Reversal is recorded by `reverses_entry_id` / `reversed_by_entry_id` alone. The
invariant that actually bites is now in §5.11: *reverse an entry and assert every statement line for
the original period is byte-identical to what it was before.*

- Reversal is **once, ever** — the partial unique index `je_one_reversal` makes a double reversal
  a constraint violation, not a support incident.
- A reversal is generated, never hand-keyed: the same code path, run with the sides swapped, so a
  reversal cannot introduce a new error while fixing an old one.
- Because the reversal is line-for-line, `Σ(original + reversal) = 0` on every
  (account × location) pair. That is the test `money-test-engineer` asserts (§5.11).
- **Voiding a sale is not deleting a sale.** A void produces a reversing entry like everything
  else. There is no code path that removes a posted line.

**Drafts** exist only for manual journals raised by the Accounts role — accruals, depreciation,
the payroll import, the corporate tax journal — which need a prepare-then-review step. Drafts are
freely editable and deletable because they are not the ledger. Machine-generated postings never
pass through `draft`: the header, the lines and the `status='posted'` update happen in one
transaction.

---

## 5.4 The chart of accounts as a per-tenant template

### 5.4.1 Structure

```sql
create table gl_account (
  tenant_id            uuid    not null,
  account_id           uuid    not null,
  code                 text    not null,     -- tenant-editable label, e.g. '4100'
  name                 text    not null,
  account_type         text    not null,     -- ASSET|LIABILITY|EQUITY|INCOME|EXPENSE
  normal_balance       char(1) not null,     -- 'D'|'C'; derived from type, stored for reporting
  parent_account_id    uuid,                 -- presentation rollup only; never posted to
  is_postable          boolean not null,     -- only leaves accept lines
  requires_counterparty text,                -- null|'customer'|'supplier'|'employee'
  control_account_kind text,                 -- 'AR'|'AP'|'INVENTORY'|'BANK'|'MOMO'|'TILL'|null
  report_line_key      text    not null,     -- maps into statement layout; tenant-editable
  is_active            boolean not null default true,
  closed_at            date,
  template_ref         text,                 -- provenance only. No code reads this to decide anything.
  primary key (tenant_id, account_id),
  unique  (tenant_id, code),
  unique  (tenant_id, account_id, is_postable),        -- backs the journal_line FK
  foreign key (tenant_id, parent_account_id)
    references gl_account (tenant_id, account_id),
  constraint ga_type check (account_type in ('ASSET','LIABILITY','EQUITY','INCOME','EXPENSE')),
  constraint ga_normal check (
    normal_balance = case when account_type in ('ASSET','EXPENSE') then 'D' else 'C' end)
);
```

### 5.4.2 Postable accounts, enforced by foreign key

Rollup accounts (`4000 Revenue`) must never receive a posting; only leaves do. The usual
implementation is a trigger. It can be done with a plain foreign key instead, which is both
cheaper and harder to switch off:

`journal_line` carries `account_postable boolean not null default true` with
`CHECK (account_postable)`, and a composite FK to `gl_account (tenant_id, account_id,
is_postable)`. A line can therefore only reference an account whose `is_postable` is `true`.
The pleasing side-effect: flipping a populated account to non-postable fails on the FK, because
the referenced key would no longer exist. You cannot turn a posted-to account into a header.

An account with any posted line can never be deleted — the FK from `journal_line` sees to that.
Retirement is `is_active = false` + `closed_at`, which removes it from pickers while leaving
history intact. Renaming and renumbering are permitted: identity is `account_id`, and `code` is a
label. Changing a code does not restate history.

### 5.4.3 Adoption, and why there is no live inheritance

A CoA template is a versioned platform artefact: an ordered list of account rows plus a default
`posting_role → account` mapping (§5.6.1). Onboarding runs:

```
create tenant → select jurisdiction pack → select CoA template →
apply: INSERT ordinary gl_account rows + gl_account_mapping rows →
tenant edits freely → accountant reviews (§5.12) → first posting
```

After that write, **the template is gone from the runtime**. `template_ref` survives as a support
breadcrumb ("this account arrived from `construction-gh@v3`"); no code path reads it to decide
behaviour, which is exactly what §2.9 requires.

Four reasons live inheritance is rejected:

1. **A tenant edit must be permanent.** A tenant who renames "Cost of goods sold" to "Cost of
   sales", or splits cement COGS from steel COGS, has made a deliberate decision about their own
   books. An inherited default that silently reasserts itself on a template upgrade is a bug with
   no error message.
2. **Books are historical, and restating them is not a deployment.** Changing an account's type
   or `report_line_key` upstream would retroactively move published figures — a prior-year P&L
   would render differently than when it was signed. Restatement is an accountant's decision with
   disclosure consequences, not a side-effect of shipping template v4.
3. **§2.9 forbids the code path.** Live inheritance means resolving "what does this tenant's
   template say" at runtime, i.e. branching on which template a tenant is on — at the hottest
   point in the system, on every posting.
4. **Blast radius.** A runtime template lookup makes one platform row a single point of failure
   for every tenant's ledger simultaneously.

**Template upgrades arrive as a diff, not a migration.** When the platform publishes
`construction-gh@v4`, existing tenants get a report: *"v4 adds 5250 Haulier charges; v4 splits
6300 Admin into 6310/6320."* An accountant applies the items they want, one at a time, as ordinary
inserts. Nothing is applied automatically. Slow on purpose.

### 5.4.4 Tenant #1's template — illustrative extract

**This is template data, not platform behaviour.** It ships as
`"Construction materials distribution — Ghana"` and every row below is editable the moment it is
adopted. Code ranges are the template's convention, not the platform's.

| Code | Name | Type | `report_line_key` | Notes |
|---|---|---|---|---|
| 1100 | Cash — till | ASSET | `BS_CASH` | `control_account_kind = 'TILL'`, one per trading location via the dimension |
| 1110 | Bank — current account | ASSET | `BS_CASH` | `BANK`; reconciled monthly |
| 1120 | Mobile money wallet | ASSET | `BS_CASH` | `MOMO`; reconciled monthly (§5.7) |
| 1200 | Accounts receivable — trade | ASSET | `BS_AR` | `AR`, `requires_counterparty='customer'` |
| 1210 | Accounts receivable — facility fees | ASSET | `BS_AR` | separated so fee exposure is visible |
| 1300 | Inventory — goods for resale | ASSET | `BS_INVENTORY` | `INVENTORY`; per location by dimension |
| 1310 | Inventory in transit | ASSET | `BS_INVENTORY` | §5.6.3 |
| 1400 | Input tax recoverable | ASSET | `BS_TAX_RECOVERABLE` | one per recoverable component |
| 1500 | Property, plant & equipment — cost | ASSET | `BS_PPE` | |
| 1590 | Accumulated depreciation | ASSET | `BS_PPE` | contra |
| 2100 | Accounts payable — trade | LIABILITY | `BS_AP` | `AP`, `requires_counterparty='supplier'` |
| 2110 | Goods received not invoiced | LIABILITY | `BS_AP` | §5.6.3 |
| 2200 | Output tax payable — VAT | LIABILITY | `BS_TAX_PAYABLE` | one account per component, per §5.6.2 |
| 2210 | Output levy payable — NHIL | LIABILITY | `BS_TAX_PAYABLE` | |
| 2220 | Output levy payable — GETFund | LIABILITY | `BS_TAX_PAYABLE` | |
| 2230 | Output levy payable — COVID-19 HRL | LIABILITY | `BS_TAX_PAYABLE` | |
| 2300 | Net pay payable | LIABILITY | `BS_PAYROLL` | bureau figure |
| 2310 | Employee income tax withheld — payable | LIABILITY | `BS_PAYROLL` | bureau figure |
| 2320 | Employee social security withheld — payable | LIABILITY | `BS_PAYROLL` | bureau figure |
| 2330 | **Employer social security contribution — payable** | LIABILITY | `BS_PAYROLL` | bureau figure; §5.8 |
| 2400 | Inter-location clearing | LIABILITY | `BS_INTERLOC` | nets to zero on consolidation (§5.5) |
| 2500 | Bank loan — principal | LIABILITY | `BS_DEBT` | |
| 2600 | Corporate tax payable | LIABILITY | `BS_TAX_PAYABLE` | manual journal only |
| 3100 | Owner's capital | EQUITY | `BS_EQUITY` | |
| 3200 | Retained earnings | EQUITY | `BS_EQUITY` | per location; §5.9.4 |
| 4100 | Revenue — retail | INCOME | `PL_REVENUE` | |
| 4110 | Revenue — wholesale | INCOME | `PL_REVENUE` | |
| 4190 | Sales returns and allowances | INCOME | `PL_REVENUE` | contra |
| 4300 | Credit facility fee income | INCOME | `PL_OTHER_INCOME` | **not** `PL_REVENUE` — see §5.10 |
| 5100 | Cost of goods sold | EXPENSE | `PL_COGS` | |
| 5190 | COGS — cost variance | EXPENSE | `PL_COGS` | `GL-Q2` |
| 5200 | Purchase price variance | EXPENSE | `PL_COGS` | |
| 5300 | Stock adjustment — damage/breakage | EXPENSE | `PL_SHRINKAGE` | separated from COGS; §5.6.4 |
| 5310 | Stock adjustment — count variance | EXPENSE | `PL_SHRINKAGE` | |
| 5320 | Stock adjustment — theft | EXPENSE | `PL_SHRINKAGE` | |
| 6100 | Staff costs — gross pay | EXPENSE | `PL_STAFF` | bureau-independent (captured) |
| 6110 | Staff costs — commissions | EXPENSE | `PL_STAFF` | system-computed business rule |
| 6120 | **Staff costs — employer social security** | EXPENSE | `PL_STAFF` | bureau figure; §5.8 |
| 6200 | Rent | EXPENSE | `PL_RENT` | |
| 6300 | Admin, utilities and insurance | EXPENSE | `PL_ADMIN` | model ratio 3.0% |
| 6400 | Marketing and advertising | EXPENSE | `PL_MARKETING` | model ratio 2.0% |
| 6500 | Distribution and logistics — haulier charges | EXPENSE | `PL_DISTRIBUTION` | `ADR-0001` |
| 6600 | Bank and mobile money charges | EXPENSE | `PL_ADMIN` | §5.7 |
| 6700 | Cash over/short | EXPENSE | `PL_ADMIN` | till counts |
| 6800 | Depreciation | EXPENSE | `PL_DEPRECIATION` | computed from the asset register |
| 7100 | Interest expense | EXPENSE | `PL_INTEREST` | |
| 8100 | Corporate tax expense | EXPENSE | `PL_TAX` | manual journal only |

---

## 5.5 The location dimension

### 5.5.1 Dimension, not account-per-location

`journal_line.location_id` is `NOT NULL` and references the tenant's location table. There is no
`1300-01 Inventory — Techiman`.

Why the account-per-location alternative is rejected — with tenant #1's numbers, because they make
it concrete:

- **Multiplication.** 25 locations × ~48 postable accounts is ~1,200 accounts, and that is a
  deliberately small chart. Opening outlet 26 becomes "create 48 accounts and re-point every
  posting rule". Closing one leaves 48 dead accounts that must never be deleted.
- **Consolidation becomes string parsing.** Consolidated revenue turns into "sum every account
  whose code ends `-07`". Any account created without the suffix — by a hurried accountant on a
  Friday — silently vanishes from the consolidated statement. Nothing errors.
- **It does not compose.** Tenant #1 already needs region (six of them) as well as location. A
  second dimension in the code squares the chart: 25 × 6 × 48. A third kills it.
- **Both reports come from one query.** With a dimension, by-location is `GROUP BY location_id`
  and consolidated is the same query with that clause removed. With accounts, they are two
  different queries that can disagree — and will.

The cost of the dimension is real and should be stated: **every posting must supply a location,
and every report must remember to group by it.** The first is handled by `NOT NULL`. The second
is handled by making location-aware the default in the reporting layer and by the invariant test
`consolidated = Σ locations` (§5.11), which fails loudly if a report drops the dimension.

### 5.5.2 Why `location_id` is NOT NULL, and what HQ is

Entity-level items — the GH₵1,000,000 bank loan, owner's capital, corporate tax payable — do not
belong to a trading outlet. The tempting answer is a nullable `location_id`. It is rejected:
a nullable dimension means `Σ(by location) ≠ consolidated`, and a reader who notices that once
stops trusting every report in the system.

Instead: the tenant has a **non-trading location** (tenant #1's is "HQ — Techiman", which already
exists in their model as the `HQ_CAPEX` line). `location.is_trading = false` marks it. Outlet
P&L filters to trading locations; consolidated includes everything. The identity
`consolidated = Σ all locations` holds exactly, and is a test.

### 5.5.3 Entries balance per location — the decision that makes this real

**Every posted entry balances within each location it touches**, not merely in total. This is the
constraint implemented in `gl_assert_entry_balanced()` (§5.2.3), and it is the difference between
a per-location balance sheet that balances and one that does not.

Consider HQ paying a supplier for stock delivered to Sunyani. If the entry only balances in
total — `Dr Inventory (Sunyani) / Cr Bank (HQ)` — then Sunyani's lines are all debit and HQ's are
all credit. Sunyani's trial balance does not sum to zero. Its balance sheet needs a plug. So does
HQ's. Every cross-location transaction adds another plug, and within a month no location-level
balance sheet is defensible.

With per-location balancing, the same transaction is four lines:

```
Dr  1300 Inventory                Sunyani   250,000_00
    Cr  2400 Inter-location clearing  Sunyani   250,000_00
Dr  2400 Inter-location clearing  HQ        250,000_00
    Cr  1110 Bank                     HQ        250,000_00
```

Sunyani balances. HQ balances. `2400` reads as "due to/from other locations" on each location's
balance sheet, and **sums to exactly zero across all locations** — which is the consolidation
check, and the thing that proves nothing leaked.

*Cost, stated plainly:* two extra lines on every cross-location entry, and every posting rule must
be written location-aware rather than location-agnostic. This is the single largest complexity
addition in this section. It is worth it because the brief requires P&L **and balance sheet** by
location, and without it the balance sheet half is a fiction.

### 5.5.4 What a per-location balance sheet does and does not mean

Honest framing for the reviewing accountant: a location balance sheet is a **branch account**, not
a separate legal entity. Cash, inventory and (via the clearing account) intra-group position are
genuinely locational. The loan, share capital and corporate tax sit at HQ by policy. Location-level
retained earnings accumulate from that location's own P&L (§5.9.4), so the statement balances year
over year. It is a management report, and should be labelled as one.

---

## 5.6 Posting rules

### 5.6.1 Rules are code; mappings are configuration

Posting rules are **platform code**, versioned by `posting_rule_version`. What a tenant configures
is which account each **posting role** resolves to:

```sql
-- Platform-owned catalogue of posting roles, with the type each one MUST resolve to.
-- Without it the mapping table permits SALES_REVENUE -> 2100 Accounts payable: this
-- section rejects a tenant-editable rule engine because it "is the fastest way to let a
-- non-accountant book revenue to a liability", and then shipped a table that permits
-- exactly that.
create table posting_role_catalog (          -- PLATFORM. No tenant_id.
  posting_role          text primary key,
  required_account_type text not null,       -- ASSET|LIABILITY|EQUITY|INCOME|EXPENSE
  required_control_kind text,                -- 'AR'|'AP'|'INVENTORY'|'BANK'|... or null
  required_when_feature text                 -- null = always required; else only when
                                             -- that feature is enabled for the tenant.
                                             -- FACILITY_FEE_* must not force a tenant with
                                             -- no credit product to map accounts it will
                                             -- never use, which the completeness check did.
);

create table gl_account_mapping (
  tenant_id           uuid not null,
  posting_role        text not null references posting_role_catalog (posting_role),
  scope_kind          text not null,   -- 'tenant' | 'location' | 'product_category'
  scope_key           uuid not null generated always as
                        (coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)) stored,
  scope_id            uuid,            -- null when scope_kind = 'tenant'
  account_id          uuid not null,
  mapping_set_version int  not null,   -- effective-dated by version; history retained
  effective_from      date not null,
  effective_to        date,
  primary key (tenant_id, posting_role, scope_kind, scope_key, effective_from),
  foreign key (tenant_id, account_id) references gl_account (tenant_id, account_id)
);
-- a trigger asserts gl_account.account_type = posting_role_catalog.required_account_type
-- and, where declared, control_account_kind = required_control_kind.
```

Two mechanical notes. `primary key (..., coalesce(scope_id, uuid_nil()))` **is not valid Postgres**
— a primary key takes columns, not expressions, and `uuid_nil()` needs an extension — hence the
generated `scope_key` column above; the same correction applies to `target_line` in §5.10. And the
mapping is now **versioned and effective-dated**: `posting_rule_version` answered "which rules ran
in March" while the mapping, which is the other half of the answer, had no history at all, so the
auditor's question was unanswerable. `journal_entry.mapping_set_version` stamps both halves.

Resolution is most-specific-first: `product_category` → `location` → `tenant` default. That covers
"revenue split by product category" and "a different bank account per region" without a rule
editor.

**A tenant-editable posting-rule engine is deliberately not built.** It is the fastest way to let
a non-accountant produce a ledger that does not balance or that books revenue to a liability, and
the platform then owns the consequences. If a tenant genuinely needs a different rule, that is a
platform change with a version bump and a review — which is the correct amount of friction for
something that decides how money is recorded.

Every unmapped role required by a rule is a **hard failure at posting**, never a fallback to a
suspense account. A missing mapping is a configuration error to be fixed before trading, not
absorbed silently. Onboarding therefore includes a mapping-completeness check that must pass before
the tenant's first posting — scoped to the roles the tenant's **enabled features** require, per
`posting_role_catalog.required_when_feature`.

**But "hard failure at posting" needs a defined outcome, and it had none.** This is the largest
hole the review found in this section. Bawku trades offline for eight days; 300 sales arrive; in the
meantime an admin retired an account or a new product category was created without a `COGS`
mapping. The rule hard-fails. Then what?

- If posting is **synchronous** with the write API, §3.3.4 dead-letters the mutation and **the sale
  never lands at all** — not in stock, not in sales, not in the books — while the customer holds
  the goods and a printed receipt. That is a direct `CLAUDE.md` §2.2 violation on the GL's side of
  the boundary.
- If posting is **asynchronous**, the document exists and no entry does, and **nothing detects it**:
  §5.7.4's close gates cover unsynced documents, unmatched statement lines and clearing imbalance,
  but not *synced documents that failed to post*. The period closes clean with revenue missing.

**Ruling: acceptance and posting are separate, and a posting failure never rejects a settled
document.** Posting is asynchronous, and the gap is made visible rather than left implicit:

```sql
create table posting_exception (
  tenant_id uuid not null, exception_id uuid not null,
  source_kind text not null, source_id uuid not null,
  location_id uuid not null, document_date date not null,
  posting_role text, error_code text not null, error_detail text,
  severity smallint not null, opened_at timestamptz not null,
  resolved_at timestamptz, resolved_by uuid, resolution_note text,
  primary key (tenant_id, exception_id),
  unique (tenant_id, source_kind, source_id) where resolved_at is null
);
```

It feeds §3.6's review queue, it is a close gate (*zero unresolved posting exceptions dated in this
period*), and it is backed by the invariant §5.11 was missing: **every settled document of a
postable kind has exactly one non-reversed journal entry**, reconciled by count *and* by value, per
location, per day.

### 5.6.2 The rules

Amounts illustrative, GH₵, all in pesewas in storage. `Loc` shows which location each line
carries. `→role` is the mapping key.

> **The rule that governs every row below, and which the first version got wrong in five of
> them:** *the location of a control-account line is a property of the **obligation**, not of the
> person handling the money.*
>
> A contractor buys on credit at Techiman — `Dr AR(Techiman) / Cr Revenue(Techiman)` — and pays
> twenty days later at Sunyani. Rule 4 as first written posted `Dr TILL(Sunyani) / Cr
> AR(Sunyani)`. Both entries balance per location, so **no constraint fires and both trial
> balances still sum to zero.** But Techiman's AR carries a debit that will never clear and
> Sunyani's AR carries a permanent credit balance on an asset account; the customer subledger nets
> to zero, so credit control sees nothing. After a year of contractors buying at the RDC and paying
> at the outlet nearest the site, every location balance sheet is fiction — and §5.9.2, "the single
> most useful diagnostic in the system", is blind to it, because nothing is *unbalanced*, it is
> *mis-attributed*.
>
> Correct form: `Dr TILL(Sunyani) / Cr INTERLOC_CLEARING(Sunyani)` **plus** `Dr
> INTERLOC_CLEARING(Techiman) / Cr AR_TRADE(Techiman)`. Four lines, both locations balance,
> `Σ INTERLOC_CLEARING = 0` still holds, and Techiman's AR clears where the obligation was
> created. The same correction applies to rules **9b, 9c, 11 and 12** below.
>
> This requires the AR and AP subledgers to tell the GL **which location's balance each allocation
> settles**. That contract did not exist; it is now a named deliverable owned jointly by
> `credit-engineer` and `ledger-engineer` (§5.14.3). Rule 11 additionally needs a
> `CASH_IN_TRANSIT` account, because physical takings between the till and the bank had nowhere to
> be — the first version teleported them.

| # | Business event | Debits | Credits | Loc | Notes |
|---|---|---|---|---|---|
| 1 | **Cash sale** (till or momo) | `TILL_CASH` or `MOMO_WALLET` — gross · `COGS` — cost | `SALES_REVENUE` — net · `OUTPUT_TAX_{c}` — one line per tax component · `INVENTORY` — cost | selling location, all lines | One entry. Tax components per `ADR-0002`, priced from the rate row in effect on `document_date`. |
| 2 | **Credit sale** | `AR_TRADE` — gross (`counterparty = customer`) · `COGS` | `SALES_REVENUE` · `OUTPUT_TAX_{c}` · `INVENTORY` | selling location | Identical to #1 with the cash line swapped. Revenue is recognised here, not on payment. |
| 3 | **Tax on a sale** | *(within #1/#2)* | `OUTPUT_TAX_{c}` per component | selling location | **Tax is a liability, never revenue.** The pack defines *n* components per tax code, each with its own payable account and an `is_recoverable` flag — recoverable tax nets against input tax at remittance; a non-recoverable levy does not. Which Ghanaian components are recoverable is confirmed at the §5.12 gate, not assumed here. |
| 1b | **Discount on a sale** | `SALES_DISCOUNT` — contra-income, the discount amount | *(within #1/#2: `SALES_REVENUE` is credited **gross of discount**)* | selling location | **New.** §4.8 carries `sale.discount_minor` and `sale_line.line_discount_minor` and the ledger had no line for either — so gross sales were not recoverable from the books, §5.6.4's stated purpose ("preserves gross sales for the margin metric") failed, and a manager granting approved overrides all day produced books indistinguishable from lower list prices. Allocation across lines is §4.13 rounding point 4; the tax base is the discounted net (rounding point 10). |
| 4 | **Payment received** (against AR) | `TILL_CASH` / `BANK` / `MOMO_WALLET` at the **receiving** location · `INTERLOC_CLEARING` at the **obligation's** location | `INTERLOC_CLEARING` at the receiving location · `AR_TRADE` at the **obligation's** location (`counterparty = customer`) | two, per the rule above | Settlement, not revenue. When receipt and obligation share a location the clearing pair is omitted and it is two lines. Invoice-level allocation is `credit-engineer`'s subledger; **the subledger must return the obligation's location with each allocation.** |
| 4b | **Momo receipt with provider charge** | `MOMO_WALLET` — net received · `BANK_CHARGES` — fee | `AR_TRADE` or `SALES_REVENUE` + tax — **gross** | receiving location | The customer paid GH₵1,000; GH₵995 landed. Revenue is 1,000; the 5 is an expense, not a discount. Getting this wrong makes momo never reconcile. |
| 5 | **Inventory receipt** (goods in, no invoice yet) | `INVENTORY` — at PO cost · | `GRNI` | receiving location | Perpetual inventory. Moving average per (SKU, location) updates here. |
| 5b | **Supplier invoice matched** | `GRNI` — at PO cost · `INPUT_TAX_{c}` · `PPV` if the invoice differs | `AP_TRADE` (`counterparty = supplier`) | receiving location | Two-step because goods and invoice arrive apart and often differ. The difference is a named variance, never a silent inventory adjustment. |
| 6 | **Inter-location transfer — despatch** | `INTERLOC_CLEARING` — at cost | `INVENTORY` — at sending location's moving average | sending location | |
| 6b | **Inter-location transfer — receipt** | `INVENTORY_IN_TRANSIT` then `INVENTORY` on confirmation | `INTERLOC_CLEARING` | receiving location | **No income account is touched. Consolidated revenue is structurally unaffected** — see §5.6.3. |
| 6c | **Haulier charge on a transfer** | `DISTRIBUTION_COST` | `AP_TRADE` | receiving location (tenant policy) | Feeds the distribution-cost-%-of-revenue metric per location and region (§5.10). |
| 7 | **Stock adjustment — shortage** | `STOCK_ADJ_{reason}` | `INVENTORY` | counting location | Reason code selects the account via mapping. Reason list is tenant-editable (`ADR-0006`). |
| 7b | **Stock adjustment — overage** | `INVENTORY` | `STOCK_ADJ_{reason}` | counting location | |
| 8 | **Credit facility fee accrual** (monthly) | `FACILITY_FEE_AR` | `FACILITY_FEE_INCOME` | location of the underlying invoices, pro-rata | **One entry per credit account per period**, matching §6.4.4's `unique (tenant_id, credit_account_id, period_id)` — *not* one shared entry with a line per customer, which was this section's version and which produced a different audit trail and a different reversal surface from §6's. §5.6.5. Tax treatment **unset in the template** pending `open-questions.md` Q4. |
| 8b | **Facility fee waived** | `FACILITY_FEE_INCOME` | `FACILITY_FEE_AR` | as #8 | **A contra entry, not a reversal.** As first written ("a reversing entry of #8 for that customer") it had no valid posting path at all: under §5.3 a reversal is line-for-line, the whole entry, and **once ever** (`je_one_reversal`) — you cannot partially reverse a shared entry and you cannot reverse it twice for two customers. §6.4.4 gets this right and this rule now follows it. |
| 9 | **Payroll — bureau figures returned** | `STAFF_COST_GROSS` · `STAFF_COST_COMMISSION` · **`STAFF_COST_EMPLOYER_SOCIAL`** | `EMPLOYEE_TAX_PAYABLE` · `EMPLOYEE_SOCIAL_PAYABLE` · `OTHER_DEDUCTIONS_PAYABLE` · **`EMPLOYER_SOCIAL_PAYABLE`** · `NET_PAY_PAYABLE` | employee's assigned location | **Every credit amount is a bureau figure.** The employer contribution is a company expense with its own expense line *and* its own payable line — recording, not calculating (§5.8). |
| 9b | **Net pay disbursed** | `NET_PAY_PAYABLE` at the **employee's** location · `INTERLOC_CLEARING` at the paying location | `INTERLOC_CLEARING` at the employee's location · `BANK`/`MOMO_WALLET` at the paying location | two | Clearing pair added: the payable was raised at the employee's location and must clear there. |
| 9c | **Statutory remittance** | each bureau payable at the **location that raised it** · `INTERLOC_CLEARING` at HQ | `INTERLOC_CLEARING` at each raising location · `BANK` at HQ | many | Clearing pairs added. Payables raised at 25 locations and debited only at HQ left 25 permanent credit balances and one permanent debit, all balancing in total. Roles are `figure_code`-driven (§4.11), not four fixed Ghanaian columns. |
| 10 | **Sales return / credit note** | `SALES_RETURNS` · `OUTPUT_TAX_{c}` reversed · `INVENTORY` at original cost | `AR_TRADE` or cash · `COGS` | original selling location | Contra-revenue, not negative revenue. Preserves gross sales for the margin metric. |
| 11 | **Till banking — leg 1, cash leaves the till** | `CASH_IN_TRANSIT` | `TILL_CASH` | outlet | **New account.** Physical takings on their way to the bank are a real asset in a real place; the one-line version teleported them from an outlet till to an HQ bank account in a single entry, in which the outlet's lines were all credit and HQ's all debit. |
| 11a | **Till banking — leg 2, bank credits the account** | `BANK` at the banking location · `INTERLOC_CLEARING` at the outlet | `INTERLOC_CLEARING` at the banking location · `CASH_IN_TRANSIT` at the outlet | two | Confirmed against the bank statement (§5.7). A `CASH_IN_TRANSIT` balance older than *n* days is a close gate — it is either a delayed deposit or a theft. |
| 11b | **Till count variance** | `CASH_OVER_SHORT` (short) | `TILL_CASH` | counting location | Sign reverses for an overage. Till counts are an *outlet* activity and sync as documents; bank rec is an HQ activity (§5.7). |
| 12 | **Momo cash-out to bank** | `BANK` — net · `BANK_CHARGES` — fee, both at the bank's location · `INTERLOC_CLEARING` at the wallet's location | `INTERLOC_CLEARING` at the bank's location · `MOMO_WALLET` — gross, at the wallet's location | two | Clearing pair added where wallet and bank sit at different locations. |
| 13 | **Depreciation** (monthly) | `DEPRECIATION` | `ACCUM_DEPRECIATION` | asset's location | *Computed* from the fixed-asset register at the tenant's useful life. This is a management-accounting policy, not statutory withholding — see §5.8.4. Tax capital allowances are **not** computed. |
| 14 | **Loan interest and principal** | `INTEREST_EXPENSE` · `LOAN_PAYABLE` | `BANK` | HQ | Tenant #1: GH₵1,000,000 @ 7%, five-year equal principal. The schedule is tenant data. |
| 15 | **Corporate tax** | `TAX_EXPENSE` | `TAX_PAYABLE` | HQ | **Manual journal from the accountant's computation.** The model's 25% is a planning assumption; capital allowances and disallowables are the accountant's work. §5.8.4. |
| 16 | **Year-end close** | each `INCOME` account balance | `RETAINED_EARNINGS` (per location) | each location | Sign reverses for expenses. §5.9.4. |

### 5.6.3 Why an inter-location transfer cannot inflate consolidated revenue

Two independent guarantees, one structural and one at the report:

1. **The transfer document has no price field.** It moves quantity at the sending location's
   moving-average cost. There is no code path by which a transfer reaches a `SALES_REVENUE`
   account, because the rule that would map it does not exist. A report-level elimination — "sum
   revenue, then subtract inter-outlet sales" — is strictly weaker: it depends on someone
   remembering to write the elimination and on inter-outlet sales being reliably flagged.
2. **The clearing account nets to zero.** Every transfer creates equal and opposite
   `INTERLOC_CLEARING` entries at two locations. `Σ INTERLOC_CLEARING = 0` across all locations
   is an invariant, checked at every close. If it is non-zero, a transfer is half-posted — most
   likely a despatch whose receipt has not synced — and close blocks.

**In-transit ownership — reconciled with §4.7.3.** The two sections disagreed: this one put
`INVENTORY_IN_TRANSIT` at the *receiving* location while the stock ledger put the goods at a
`kind='TRANSIT'` location, so the GL and the stock ledger said in-transit stock was in two
different places and §5.5.4's per-location balance sheet could not be tied to stock-on-hand per
location. Worse, rule 7 posts stock adjustments at "the counting location", and for a transit
shortfall that was an ephemeral per-transfer node with no P&L and no manager.

**Ruling: the GL follows the stock ledger.** In-transit inventory posts at the **sending location's
durable TRANSIT node** (one per stock-holding location, §4.7.3), with the ordinary
`INTERLOC_CLEARING` pair. TRANSIT nodes are `is_trading = false`, `is_postable_location = true`:
excluded from outlet P&L, included in consolidation, so `consolidated = Σ locations` still holds and
the clearing lines are cheap because there are 25 nodes rather than thousands. §5's reason for
choosing the receiving location — the receiver investigates the shortfall — is satisfied by
**routing the exception to the receiving location's manager**, which is queue routing, not
accounting geography. The consequence still stands: TRANSIT stock is not physically held by any
trading outlet, so the **inventory-days metric excludes in-transit** or it flatters cover, and that
exclusion is in the metric definition rather than left to the reader.

**Transfer pricing is out of scope.** If a tenant ever wants an RDC to bill a micro-outlet at a
marked-up price, that requires genuine consolidation eliminations and unrealised-profit-in-stock
adjustments. Not built, and not a small addition.

### 5.6.4 Why shrinkage does not go to COGS

Damage, count variance and theft post to their own expense accounts (`5300`–`5320`), not to COGS.

Cement absorbs moisture and bags break; sand loses to wind and handling. If those losses land in
COGS, the blended gross margin the business tracks — 19.325% rising to 24.5% (§5.10) — moves for
reasons that have nothing to do with buying or pricing, and a margin miss reads as a purchasing
problem when it is a warehousing problem. Keeping them separate makes shrinkage a line an outlet
manager is accountable for.

The template maps `PL_SHRINKAGE` *within* the COGS block of the P&L so gross profit still ties to
the model's definition, but broken out. **Whether shrinkage sits above or below gross profit is a
question for the reviewing accountant** — it is a `report_line_key` edit either way, which is
precisely why the mapping is tenant data.

### 5.6.5 Facility fee: location allocation and rounding

The 2–3%/month facility fee (`open-questions.md` Q4) is computed by `credit-engineer` on the
customer's ageing balance and handed to the GL as an amount per customer per period. Two GL-side
decisions:

- **Location.** The fee is allocated to the location(s) that made the underlying credit sales,
  not to HQ. Otherwise every outlet's P&L understates the true return on the credit it extended,
  and the incentive to chase collections sits in the wrong place. Where a customer's balance spans
  locations, allocation is **pro-rata by outstanding balance**, and per `ADR-0004` the remainder
  pesewa lands on the location with the largest balance (ties broken by lowest `location_id`, so
  the result is deterministic and testable). The allocation must sum exactly to the fee charged.
- **Classification.** Mapped to `PL_OTHER_INCOME`, not `PL_REVENUE`. Tenant #1's financial model
  deliberately excludes the fee, so including it in `revenue` would make actual-vs-model variance
  unreadable and would distort the gross-margin denominator. This is a `report_line_key` value —
  the accountant can move it at the gate. Whether the fee is a taxable supply is **Q4 and is not
  answered here**; the template ships with the fee account's tax code **unset**, and the rule
  fails loudly if a fee is raised before someone sets it.

---

## 5.7 Bank and mobile money reconciliation

§2.8 makes this a required feature. The reason given in the brief is correct and worth repeating:
it is where undetected errors in a home-grown GL surface first, because it is the only routine
control that compares the ledger against a document the system did not produce.

### 5.7.1 Mobile money is a cash account, not a payment method

A momo wallet is a `gl_account` with `control_account_kind = 'MOMO'` and a `cash_account` detail
row, and it goes through the identical reconciliation workflow as a bank account. Three reasons
this is not over-engineering for this market:

1. **The wallet holds a real float.** It is an asset with a balance that belongs on the balance
   sheet, not a routing label on a cash line.
2. **It has its own charges.** Provider fees and any transfer levy mean the amount received is not
   the amount paid (rule 4b). Treated as "cash", those fees have nowhere to go and end up as an
   unexplained reconciling difference that grows every month.
3. **It has its own statement**, with its own timing and its own float delays between wallet and
   bank. A cash-out (rule 12) is a real transfer between two asset accounts, and both sides need
   reconciling.

```sql
create table cash_account (
  tenant_id       uuid not null,
  cash_account_id uuid not null,
  account_id      uuid not null,       -- the gl_account it reconciles
  kind            text not null,       -- 'BANK' | 'MOMO' | 'TILL'
  provider        text,                -- bank name / MNO
  external_ref    text,                -- account or wallet identifier (masked in UI)
  location_id     uuid not null,
  opening_balance_minor bigint not null,
  opening_as_of   date not null,
  statement_format text,               -- import profile
  primary key (tenant_id, cash_account_id),
  unique (tenant_id, account_id, location_id),
  foreign key (tenant_id, account_id) references gl_account (tenant_id, account_id)
);

create table bank_statement (
  tenant_id, statement_id, cash_account_id,
  period_start date, period_end date,
  opening_balance_minor bigint, closing_balance_minor bigint,
  source text,            -- 'csv' | 'manual_entry'
  imported_at timestamptz, imported_by uuid,
  primary key (tenant_id, statement_id)
);

create table bank_statement_line (
  tenant_id, statement_id, line_no,
  value_date date, description text, reference text,
  amount_minor bigint not null,      -- always positive
  direction char(1) not null,        -- 'I' inbound | 'O' outbound, from the bank's statement
  external_ref text,
  primary key (tenant_id, statement_id, line_no)
);

create table reconciliation_match (
  tenant_id, match_id, cash_account_id,
  statement_line_id uuid,            -- nullable: an unmatched book item
  journal_line_id   uuid,            -- nullable: an unmatched statement item
  matched_by uuid, matched_at timestamptz, method text,  -- 'auto' | 'manual'
  primary key (tenant_id, match_id)
);
```

A statement line uses `amount_minor` + `direction` rather than the debit/credit pair. That is a
deliberate carve-out and the reason is worth stating: a statement line is **external data**, not a
ledger row. Forcing it into the ledger's convention invites the reader to think the bank's "credit"
and the ledger's "credit" are the same word — they are opposites from the account holder's side,
and that confusion is the classic reconciliation error.

Matching is **many-to-many** (a join table, not a nullable FK on either side), because a day's
takings bank as one deposit against many receipt lines, and one bank line can settle several
invoices.

### 5.7.2 Reconciliation never edits the ledger

An unmatched statement line that turns out to be genuine — a bank charge, credit interest, a
customer's direct transfer, a returned cheque — becomes a **new journal entry raised from the
reconciliation screen**, proposed and posted through the normal path. There is no "adjust the
ledger to agree with the bank" action, and there is no code path from the reconciliation module
to an `UPDATE` on a posted line. This is the whole point of the control: it must be able to
disagree with the ledger.

### 5.7.3 The monthly view

For each cash account, for each period:

```
  Balance per statement (closing)                        X
+ Deposits in transit        (in books, not yet on statement)   X
− Outstanding payments       (in books, not yet on statement)   X
± Statement items not yet in books  (must be nil at close)      X
± Statement errors under query                                  X
= Adjusted balance                                              Y
  Balance per GL for this account and location                  Y
  ─────────────────────────────────────────────────────────
  Unexplained difference                                        0
```

Auto-matching is intentionally conservative: exact amount **and** a date within a configured
window **and** a reference match. Amount alone never auto-matches — in a business selling bagged
cement at a fixed price, identical amounts on the same day are routine, and a confident wrong
match is worse than no match.

### 5.7.4 Reconciliation gates the close

A period cannot move to `closed` while any of the following hold:

- a cash account has a non-zero **unexplained** difference;
- a statement line older than *n* days (tenant-configured, default 30) is unmatched and unexplained;
- `Σ INTERLOC_CLEARING ≠ 0` across locations;
- the trial balance does not sum to zero for the tenant, or for any single location;
- a location has unsynced documents dated on or before the period end (§5.2.6).

This is what makes reconciliation "required, not optional" in a way a user cannot skip on a busy
month-end: the close button refuses and names the reason.

---

## 5.8 The payroll boundary

**The system records. It does not calculate.** §2.4 and `ADR-0007` make this categorical, in every
jurisdiction, and it is not open to a "temporary" exception, an "estimate", or a "preview". What
follows is the schema that makes the boundary enforceable rather than merely stated.

### 5.8.1 Capture

```sql
create table pay_period (
  tenant_id, pay_period_id, starts_on date, ends_on date,
  status text not null,   -- 'open'|'exported'|'returned'|'posted'|'paid'
  exported_at timestamptz, returned_at timestamptz, journal_entry_id uuid,
  primary key (tenant_id, pay_period_id)
);

create table payroll_entry (
  tenant_id     uuid not null,
  pay_period_id uuid not null,
  employee_id   uuid not null,
  location_id   uuid not null,

  -- CAPTURED BY THE SYSTEM
  hours_worked_scaled       bigint not null,   -- scaled integer, scale documented (ADR-0004)
  base_pay_minor            bigint not null,
  overtime_minor            bigint not null default 0,
  commission_minor          bigint not null default 0,
  allowances_minor          bigint not null default 0,
  gross_pay_minor           bigint not null,

  -- RETURNED BY THE BUREAU. NULL until import. No default. No fallback. No estimate.
  bureau_employee_tax_minor       bigint,
  bureau_employee_social_minor    bigint,
  bureau_other_deductions_minor   bigint,
  bureau_employer_social_minor    bigint,
  bureau_net_pay_minor            bigint,
  bureau_import_id                uuid,

  primary key (tenant_id, pay_period_id, employee_id)
);
```

The `bureau_` prefix is not decoration — it is a **lint-enforceable naming rule**. A CI check
rejects any write to a `bureau_*` column outside the import module, and any expression that
computes one from a rate, a bracket, a percentage or another column. If a reviewer sees
`bureau_employee_tax_minor = gross * something`, the build fails.

Two database-level guards back it up:

```sql
-- A pay period cannot post until every bureau figure has been returned.
alter table payroll_entry add constraint pe_bureau_complete check (
  bureau_import_id is null
  or (bureau_employee_tax_minor     is not null
  and bureau_employee_social_minor  is not null
  and bureau_other_deductions_minor is not null
  and bureau_employer_social_minor  is not null
  and bureau_net_pay_minor          is not null)
);
-- and: a BEFORE UPDATE trigger rejects any change to a bureau_* column
-- unless bureau_import_id references a payroll_bureau_import row created in this transaction.
```

### 5.8.2 Export → bureau → re-import

**Export.** The register carries employee, location, pay period, hours, base pay, overtime,
commission, allowances, gross pay, and the tenant's employer reference. It carries **no deduction
columns at all** — not even blank ones, because a blank column labelled "PAYE" is an invitation to
fill it in from the wrong place.

**Re-import.** Matched on `(pay_period, employee)`. The import **validates and rejects**; it never
fills in:

- per employee: `gross_pay + adjustments − (employee tax + employee social + other deductions) =
  bureau_net_pay`;
- register totals tie to the sum of the lines;
- every employee in the period is present, and no employee is present twice;
- no employee appears who is not in the exported register.

If any check fails, the whole file is rejected with the failing rows named. Nothing is
part-imported and nothing is inferred.

**This validation is not a loophole.** Checking that figures the bureau supplied are internally
consistent is arithmetic on data the system was given. Supplying a missing figure — from a rate,
a bracket, a table, or last month's number — is calculation, and is prohibited. The line is:
**the system may verify an identity; it may never solve for an unknown.**

### 5.8.3 Employer social security — recording is not calculating

The employer contribution is a **company expense**, not an employee deduction, and it needs three
things the ledger must provide:

1. an **expense account** (`6120 Staff costs — employer social security`),
2. a **liability account** (`2330 Employer social security contribution — payable`),
3. a **posting line in the payroll journal** for each (rule 9).

All three exist in the template. The **amount** is `bureau_employer_social_minor` and arrives from
the bureau like every other figure. It is never derived from a rate, a percentage of gross, or a
prior period. Posting a number someone else computed is recording; that is exactly what a ledger
is for.

Anyone reading §2.4 as "so we don't need an employer social security account" has misread it. The
prohibition is on computing the figure, not on booking it — and omitting the account understates
staff costs against the model's per-outlet baselines (§5.10).

### 5.8.4 What the system may compute, and what it may not

| May compute | May not compute |
|---|---|
| Commission from its own sales data at a tenant-set rate | Employee income tax withholding, in any jurisdiction |
| Overtime at a tenant-set multiplier | Employee social security contributions |
| Allowances from a tenant-set schedule | Employer social security contributions |
| Gross pay as the sum of the above | Net pay |
| Book depreciation on a tenant-set useful life | Tax capital allowances |
| Sales tax per line from the effective-dated table (`ADR-0002`) | Corporate income tax liability |

The left column is **business policy the tenant owns and can restate at will**. The right column
is **statutory computation whose error surfaces at someone else's filing deadline**. Book
depreciation is on the left because it is a management estimate with no filing consequence;
capital allowances are on the right for exactly the opposite reason. Sales tax is on the left only
because `ADR-0002` puts every rate in an effective-dated table *and* because a stale VAT rate is
visibly wrong on a receipt handed over today.

**The `ADR-0002` carve-out is not a precedent for payroll, and this will be argued.** Someone will
propose an effective-dated PAYE band table by analogy. Reject it. §2.4 prohibits statutory payroll
calculation **categorically**, not merely in hard-coded form: a configurable withholding table is
still statutory withholding logic living unmaintained inside custom software, and its failure is
silent until a GRA under-remittance is discovered by a third party months later. Corporate income
tax (rule 15) is on the right side of the line for the same reason — the model's 25% is a planning
assumption, not a posting input.

---

## 5.9 Statements

### 5.9.1 Everything derives from the lines

Trial balance, P&L and balance sheet are all one shape:

```sql
select a.report_line_key,
       l.location_id,
       sum(l.debit_minor) - sum(l.credit_minor) as net_debit_minor
  from journal_line l
  join journal_entry e using (tenant_id, journal_entry_id)
  join gl_account   a using (tenant_id, account_id)
 where l.tenant_id = current_tenant()
   and e.status    = 'posted'
   and e.period_id = any($1)
 group by 1, 2;
```

Drop `l.location_id` from the projection and the `GROUP BY` and the same query is the consolidated
statement. That equivalence is the payoff of §5.5, and it is asserted as a test, not assumed.

Note `e.status = 'posted'` is now the *only* posted state (§5.3): there is no `'reversed'` value to
be accidentally excluded, and a reversal appears as its own posted entry alongside the original.

There is a materialised rollup `gl_balance (tenant_id, period_id, account_id, location_id,
debit_minor, credit_minor)` for report performance. It is **derived and rebuildable, never
authoritative** — but "never authoritative" was not true as designed, because reports read it and it
was refreshed nightly, so between a posting and the job every report was stale and the rollup *was*
authoritative in practice. Two corrections: it is **maintained inside the posting transaction** by
the same trigger that maintains the header aggregates, and the nightly full recompute becomes a
verification pass that alerts on any difference rather than the only thing that makes it correct.
It remains keyed by `period_id`, so **arbitrary date ranges read the lines directly** — a report
that needs 12 March to 4 April is not a rollup query and must not silently become one.

### 5.9.2 Trial balance

Sums to zero for `(tenant, period)` **and** for `(tenant, period, location)`. The second is only
possible because of §5.5.3, and it is the single most useful diagnostic in the system: an
out-of-balance location names the entry and the transaction that broke.

### 5.9.3 P&L and balance sheet, by location and consolidated

- **P&L by location** — `account_type in ('INCOME','EXPENSE')`, grouped by `report_line_key` and
  `location_id`, filtered to `is_trading` locations for outlet reporting.
- **Consolidated P&L** — same, no location grouping, all locations. **No elimination step is
  required for transfers**, because transfers never touched an income account (§5.6.3).
- **Balance sheet by location** — includes `2400 Inter-location clearing` as "due to/from other
  locations", which is what makes it balance.
- **Consolidated balance sheet** — `2400` sums to zero and drops out. If it does not, the books
  are wrong and close has already blocked.

### 5.9.4 Year-end close

Income and expense accounts close to retained earnings **at the location that carried them**, so
location-level equity accumulates and the location balance sheet keeps balancing year over year.
The closing journal is one entry per location, posted into the final period of the fiscal year,
and it is an ordinary immutable entry like any other. Closing HQ's P&L to HQ's retained earnings
and every outlet's to its own is the only variant that preserves `consolidated = Σ locations`
across the year boundary.

Tenant #1's fiscal year is **1 August – 31 July**. Nothing in the platform assumes a calendar year;
`fiscal_year` is tenant configuration.

---

## 5.10 Budget vs actual — the generic capability, with tenant #1 as the first target set

`ADR-0006` requires this explicitly: *"the specific targets from Agyasei's financial model become
one tenant's target set, not the platform's report definitions."* So the platform ships a
**metrics + targets** feature, and tenant #1's model loads as data.

```sql
create table target_set (
  tenant_id, target_set_id, name text, scenario text,   -- 'base'|'best'|'worst' — tenant's labels
  basis text,                                           -- 'fiscal_year' | 'period'
  source_note text, created_by, created_at,
  primary key (tenant_id, target_set_id)
);

create table target_line (
  tenant_id, target_set_id,
  metric_key   text not null,     -- platform-defined metric with a defined GL derivation
  period_key   text not null,     -- 'FY1' | '2026-08' — matches the tenant's calendar
  scope_kind   text not null,     -- 'tenant' | 'region' | 'location'
  scope_id     uuid,
  value_scaled bigint not null,   -- integer, always (ADR-0004)
  value_kind   text not null,     -- 'minor_units' | 'ppm' | 'days_x100' | 'count'
  primary key (tenant_id, target_set_id, metric_key, period_key, scope_kind,
               coalesce(scope_id, uuid_nil()))
);
```

**Percentages are parts per million, not basis points.** The model's FY1 blended gross margin is
19.325% — that is 1,932.5 basis points, which is not an integer, and `ADR-0004` does not permit
rounding a target just because the unit was chosen carelessly. In ppm it is exactly `193250`.
Inventory days are stored ×100 (`4500` = 45.00 days) so a target of 44.5 is expressible.

The model's scenario switch (Base / Best / Worst) maps to **three target sets**, not a column.

### 5.10.1 Model line item → metric → GL derivation

Tenant #1's model, reconciled line by line. Every row must be derivable from the ledger; a row
that is not is a gap in this design, not a nice-to-have.

> **Metrics derive from a platform-owned classification, not from `report_line_key`.** The first
> version derived every metric from `gl_account.report_line_key`, which is documented
> "tenant-editable" — so an accountant re-keying `6500 Haulier charges` from `PL_DISTRIBUTION` to
> `PL_ADMIN` (a perfectly reasonable presentation choice, and §5.6.4 explicitly invites exactly
> this kind of edit) would silently zero `distribution_cost_ppm`, and the variance report would
> announce that the 5.0% → 2.5% target was being smashed. No error, no test failure. So
> `gl_account` carries a platform-owned **`metric_role`** — set by the CoA template, editable only
> through a platform-validated picker — and `report_line_key` is reserved for statement **layout**
> only. A completeness check asserts every `metric_key` with a target line resolves to at least one
> account.

| Financial model line | `metric_key` | Derived from | Scope required |
|---|---|---|---|
| Revenue (FY1 2,640,000 → FY10 41,184,000) | `revenue` | `metric_role = REVENUE` **gross**, less contra `SALES_RETURNS` and `SALES_DISCOUNT` | location, region, tenant |
| Cost of goods sold | `cogs` | `PL_COGS` | location |
| Gross profit / **blended GM% 19.325% → 24.500%** | `gross_margin_ppm` | `(revenue − cogs) / revenue` | location, tenant |
| **Distribution & logistics 5.0% → 2.5%** | `distribution_cost_ppm` | `PL_DISTRIBUTION / revenue` | **location and region** (brief §7) |
| Marketing & advertising 2.0% | `marketing_ppm` | `PL_MARKETING / revenue` | location, tenant |
| Admin, utilities & insurance 3.0% | `admin_ppm` | `PL_ADMIN / revenue` | location, tenant |
| Staff costs (216k / 108k / 43.2k by tier) | `staff_cost` | `PL_STAFF` — includes commissions **and employer social security** | location |
| Rent (36k / 60k / 24k by tier) | `rent` | `PL_RENT` | location |
| EBITDA | `ebitda` | gross profit − `PL_STAFF/RENT/ADMIN/MARKETING/DISTRIBUTION/SHRINKAGE` | location, tenant |
| Depreciation (5-yr straight line) | `depreciation` | `PL_DEPRECIATION` from the asset register | location |
| Interest (7% on GH₵1,000,000) | `interest` | `PL_INTEREST` | tenant |
| Tax (25%) | `tax` | `PL_TAX` — manual journal | tenant |
| Net profit (positive from FY3) | `net_profit` | full P&L | location, tenant |
| **Inventory days 45 → 28** | `inventory_days_x100` | `(inventory balance excl. in-transit / COGS for the window) × days` | **per outlet** (brief §7) |
| Receivables days (assumed 15) | `dso_x100` | **trade AR only** (`control_account_kind='AR'` **excluding** the facility-fee AR account) ÷ **credit revenue** × days. Credit revenue requires a **settlement dimension**: `journal_line.settlement_kind ∈ {cash, credit}` stamped by the posting rule, because the CoA splits revenue by channel (retail/wholesale) and not by settlement, so credit-only revenue was **not derivable** as first specified. Scoping to trade AR also fixes the template mapping both `1200` and `1210` to `BS_AR`, which would have inflated DSO with accrued fees — the precise thing §6.4.4 says must not happen. | location, tenant |
| Payables days (assumed 30) | `dpo_x100` | `AP balance / purchases × days`, where **`purchases` ≡ Σ debits to `INVENTORY` + expensed purchase accounts for the window**. In a perpetual system nothing posts to a "purchases" account, so this was undefined; the definition is stated rather than assumed. | tenant |
| Cash position / FY3 trough (1,393,958) | `cash_balance` | Σ `BS_CASH` — bank + momo + till | location, tenant |
| Wage inflation 8%, rent escalation 5% | — | *assumptions, not measurements* | — |
| Terminal multiple, IRR, NPV | — | *valuation, outside the ledger* | — |

### 5.10.2 Reconciliation findings — where the ledger and the model will not agree

These are not defects. They are places where the model and the books are measuring different
things, and they must be known before the first variance report, not discovered in it.

1. **`GL-Q1` — is the model's revenue VAT-inclusive or VAT-exclusive?** The model marks VAT
   *"informational only, output-neutral"* at 15%, which reads as pass-through and therefore
   VAT-exclusive, but it does not say so. `ADR-0002` makes the ledger's `revenue` unambiguously
   **net of all tax components**, because output tax is a liability. If the model's GH₵2,640,000
   is gross, actual revenue will come in materially below target from month one and the gross
   margin denominator differs. **This needs the founder or the accountant, and it belongs in
   `docs/open-questions.md`.** `product-manager` owns adding it.
2. **`ADR-0001` changes the composition of `distribution_cost_ppm`.** With hauliers only, the line
   is haulier charges and nothing else — no fuel, no vehicle depreciation, no maintenance. The
   model's 5.0% → 2.5% target was built assuming an owned fleet absorbing volume (Q1). The metric
   is measurable per location and per region regardless; whether the target is still the right
   number is the accountant's call, already logged as Q1.
3. **FY1 depreciation of GH₵140,000 will not tie.** It assumes the GH₵300,000 "Initial Fleet +
   HQ/ERP Systems" capex, of which the fleet portion no longer exists (`ADR-0001`, Q1). The fixed
   asset register will carry only the ERP/POS portion, so actual depreciation comes in lower and
   EBITDA-to-net-profit does not bridge as modelled until that line is split.
4. **The credit facility fee is not in the model at all** (Q4 — deliberately excluded as unmodelled
   upside). Mapped to `PL_OTHER_INCOME` and excluded from `revenue` so it shows as a clean positive
   variance below the gross margin line rather than corrupting it (§5.6.5).
5. **DSO will exceed the assumed 15 days** if contractor credit scales as intended on 30–60 day
   terms (Q2). `dso_x100` is measured from day one specifically so this is caught in month two
   rather than at the FY3 cash trough, which is the plan's single most important funding milestone.
6. **`staff_cost` will exceed the per-tier baselines** if those baselines are gross pay only. The
   ledger's `PL_STAFF` includes the employer social security contribution (§5.8.3), which is a
   real company cost. Whether the model's 216,000 / 108,000 / 43,200 include it is unstated. Worth
   asking at the same time as `GL-Q1`.

---

## 5.11 Testing

Everything in this section is money-touching code — mandatory category 1 (§2.7). Built with
`money-test-engineer`. The invariants, stated so they can be asserted rather than admired:

| Invariant | Assertion |
|---|---|
| Every posting rule balances | Property-based over generated amounts, quantities and tax component sets: for every rule in §5.6.2, `Σdebit = Σcredit` **and** balanced per location. |
| Trial balance sums to zero | For every `(tenant, period)` and every `(tenant, period, location)`. |
| Reversal fully unwinds | `Σ(original + reversal) = 0` on every `(account, location)` pair, for every rule. |
| **Reversal does not restate a prior period** | Snapshot every statement line for the original's period; reverse the entry; re-render; assert **byte-identical**. This is the test that would have caught the `status='reversed'` defect, and neither of the two above it did. |
| **Manual journal, unbalanced across locations, is rejected at COMMIT** | Post a draft journal balanced in total but debiting HQ and crediting Sunyani; assert `GL0001` at COMMIT via `je_balanced_on_post`. The `journal_line` trigger alone never fires on this path. |
| **Control accounts tie to their subledgers** | Per location, per period: `Σ AR control = Σ customer subledger balances`; same for AP; `Σ INVENTORY = Σ(qty × WAC)`; each till account against its cash-session counts; each bank/momo account against its reconciliation. `control_account_kind` existed and nothing used it — every one of the blocking findings above would have been caught by one of these five ties. |
| **Document → entry completeness** | Every settled document of a postable kind has exactly one non-reversed entry; reconciled by count **and** by value, per location, per day. Zero unresolved `posting_exception` rows dated in the period. |
| **No negative inventory value** | No `(location, product)` carries a negative valuation at close, and no issue is costed at zero without a `COST_UNAVAILABLE` exception. |
| **Periodic jobs are idempotent** | Run the monthly accrual, depreciation and year-end close twice concurrently; assert exactly one entry each, by deterministic key. The earlier idempotency test covered only replayed source documents. |
| Consolidated = Σ locations | Exactly, for every report line, in every period. Catches a report that dropped the dimension. |
| Clearing nets to zero | `Σ INTERLOC_CLEARING = 0` across locations, always. |
| Transfers touch no income | Direct assertion: no `INCOME` account appears in any entry with `source_kind='stock_transfer'`. |
| Statements tie to the ledger | P&L net profit for the year equals the movement in retained earnings on the balance sheet. |
| Immutability holds | As `app_writer`: `UPDATE`/`DELETE` on a posted line must fail on **privilege**, not on trigger. Then again with triggers disabled, to prove the privilege layer is doing the work. |
| Balance cannot be forged | Directly `UPDATE journal_entry SET debit_total_minor = …` to make an unbalanced entry look balanced; the deferred trigger must reject at COMMIT (`GL0002`). |
| No floats anywhere | Lint rule over GL migrations and TypeScript: `float`/`double`/`real`/`numeric`/`money` on any monetary or quantity column, and `number` on any money-typed value, are build failures (`ADR-0004`). |
| Payroll boundary holds | No expression anywhere derives a `bureau_*` column. Import rejects a file with an inconsistent identity and imports nothing. A pay period with any `bureau_*` NULL cannot post. |
| Tenant isolation | Mandatory category 3: every GL read path — trial balance, P&L, balance sheet, reconciliation, payroll register, target variance — tested with a second tenant's data present and proven invisible. Plus: a `journal_line` insert referencing another tenant's `account_id` must fail on the **foreign key**. |
| Idempotency | Replaying the same source document ten times produces exactly one entry, per tenant. |
| Rate history | A sale posted before a rate change, re-rendered today, reproduces its original tax lines exactly (`ADR-0002`). |

---

## 5.12 The human review gate — blocking, and not mine to waive

Per §2.8, before a tenant's ledger becomes their real books, a **qualified accountant or
bookkeeper practising in that jurisdiction** reviews and signs off. Phase 3 is never "done" on an
agent's say-so. The design obligation is to make that review cheap; here is what the reviewer
receives:

1. **The adopted chart of accounts**, post-tenant-edit, with `report_line_key` mapping and account
   types shown.
2. **The posting rules table (§5.6.2)**, with a worked GH₵ example for every rule, showing every
   line, every account and every location.
3. **One full month** of trial balance, P&L and balance sheet — **per location and consolidated** —
   against their own manual expectation.
4. **A completed reconciliation for that month** on every bank account and every momo wallet, with
   an unexplained difference of zero.
5. **One payroll cycle end to end**: register exported, bureau figures returned, journal posted,
   net pay and statutory remittances disbursed — with the employer social security expense and
   payable visible on both sides.
6. **A demonstrated reversal**: an error posted, reversed, corrected, with the audit trail shown.

**Questions the reviewer must answer, which no agent may answer for them:**

- `GL-Q1` — is the model's revenue VAT-inclusive or exclusive? (§5.10.2)
- `GL-Q2` — moving weighted average or period weighted average, and is a reported COGS variance
  account acceptable for late-arriving offline documents? (§5.1 #9)
- Q4 (`open-questions.md`) — facility fee classification, and whether it is a taxable supply.
- Which tax components are input-recoverable, and the correct registration status (`ADR-0002`).
- Shrinkage above or below gross profit (§5.6.4).
- Who owns the corporate tax journal, and on what cadence (rule 15).
- Whether the per-tier staff cost baselines include the employer contribution (§5.10.2 item 6).

**Sign-off is an artefact**, committed to the repository: reviewer name, professional body and
registration, date, and the commit hash of the CoA template, the mapping and the posting rules as
reviewed. A posting rule change after sign-off bumps `posting_rule_version` and requires the
reviewer to be told — not necessarily to re-review everything, but never to find out later.

**This gate is currently blocked by `open-questions.md` Q6 — the reviewing accountant is not
named.** Q6 should be closed before Phase 3 *design* begins, not before Phase 3 ships. A chart of
accounts reviewed at design time costs a conversation; one reviewed after a month of live posting
costs a restatement.

---

## 5.13 Concerns

Three, offered per the brief's instruction to raise disagreement rather than design around it.

**1. The ledger does not sync, and that is a real narrowing of §2.2.** §5.2.6 is my decision and I
stand behind the reasoning, but it should be seen for what it is: the constitution says offline
operation is the architecture, and this section carves the GL out of it. The mitigation — a
read-only per-location report snapshot that *does* sync — is genuinely adequate for an outlet
manager checking yesterday's margin, and genuinely inadequate for an Accounts user who needs to
work through a multi-day outage at HQ. If HQ connectivity turns out to be worse than assumed, the
answer is redundancy at HQ (a second link, a mobile fallback), not a syncable ledger. Naming it
now so nobody discovers the constraint during a Phase 3 demo.

**2. `ADR-0005`'s tenant-promotion trigger should be defined now, and the GL is why.** The ADR
correctly keeps the tenant → database mapping as an indirection from day one and defers
promotion-to-dedicated-database to "at scale". The GL is the one dataset where a cross-tenant leak
is a regulatory event for the *victim*, not merely an embarrassment for us. I am not relitigating
shared-schema — it is right for a product with one customer. I am asking that the promotion
threshold be written down while it is cheap to agree: my proposal is that any tenant whose
accounts are statutorily audited, or who asks for it in writing, moves to a dedicated database
before their first close. That is a policy sentence, not a rearchitecture.

**3. Per-location balancing is the most expensive thing in this section, and it may get argued
away.** §5.5.3 adds two lines to every cross-location entry and forces every posting rule to be
location-aware. Someone under schedule pressure will propose relaxing it to entry-level balancing
with a plug on the location balance sheet, and the first month will look fine. It will not stay
fine: the plugs compound, the location balance sheets stop being defensible, and by the time
anyone cares there are six months of postings to unwind. If this constraint is dropped, it must be
dropped before the first posting, deliberately, with the reviewing accountant's agreement — not
quietly, and not later.

---

## Open questions raised by this section

| Ref | Question | Owner | Blocks |
|---|---|---|---|
| `GL-Q1` | Is tenant #1's model revenue VAT-inclusive or VAT-exclusive? At 15% plus levies this is a >GH₵300k FY1 difference and it changes the gross margin denominator. **Belongs in `docs/open-questions.md`.** | founder + accountant | first budget-vs-actual report |
| `GL-Q2` | Costing method — moving weighted average (with a reported COGS variance for late offline arrivals) or period weighted average with a close-time true-up? | accountant | Phase 1 POS (COGS posts from the first sale) |
| `GL-Q3` | Do the model's per-tier staff cost baselines (216k / 108k / 43.2k) include employer social security, or gross pay only? | founder + accountant | `staff_cost` variance reporting |
| `GL-Q4` | Sync contract: the close process needs a per-location "all documents up to date X have arrived" high-water mark from the sync service. Does the chosen sync layer expose one? | `sync-architect` | period close (Phase 3), designed in Phase 0 |
| Q6 *(existing)* | The reviewing accountant is still not named. §5.12 cannot complete without them, and the cheap time to involve them is now. | founder | Phase 3 go-live |

---

## 5.14 Revisions from adversarial review

Reviewed 2026-08-20. Six blocking findings, twenty-four lesser. **Where this subsection and the body
differ, this subsection governs.**

### 5.14.1 What the reversal defect says about this section's tests

The blocking finding worth dwelling on is not the hardest one, it is the most instructive. Reversing
an entry moved the original out of every statement query, so a reversal changed the P&L by −X rather
than 0. **Both of the section's own listed invariants stayed green**: the trial balance still summed
to zero, because a reversal is self-balancing; and "reversal fully unwinds" was asserted over
`journal_line`, not through the statement query that users actually read.

The lesson is a rule for §5.11 generally: **an invariant asserted over the storage layer does not
test the reporting layer.** Every invariant in this section that a reader would describe in terms of
a *statement* is now asserted by rendering the statement, not by summing the lines underneath it.
The five control-account ties added to §5.11 are the same idea applied to the subledgers: they are
the checks that would independently have caught findings 3, 4, 5 and 12.

### 5.14.2 Mechanisms added

| Mechanism | Purpose | Where |
|---|---|---|
| `'reversed'` removed from `je_status` | no status value can be accidentally excluded from a statement | §5.3 |
| `je_balanced_on_post` constraint trigger | per-location balance enforced on the manual-journal path | §5.2.3 |
| `posting_exception` + close gate + completeness invariant | a settled document that fails to post is visible and blocking | §5.6.1 |
| `CASH_IN_TRANSIT` account, rules 11/11a | physical takings exist somewhere between till and bank | §5.6.2 |
| `SALES_DISCOUNT` contra account, rule 1b | gross sales recoverable; margin metric means what §5.6.4 says | §5.6.2 |
| `posting_role_catalog` + type-assertion trigger | a mapping cannot book revenue to a liability | §5.6.1 |
| `mapping_set_version` + effective-dated mappings | "which rules ran in March" is fully answerable | §5.6.1 |
| `gl_counter` DDL; `unique (tenant_id, fy_code, entry_no)` | the counter existed only as a reference; FY2 entry 1 collided with FY1's | §5.2.2 |
| `je_one_per_source` | two entries per document could both post | §5.2.2 |
| Period tiling `EXCLUDE`, `ap_range`, reopen audit columns | undefined period resolution; the "recorded reason" had nowhere to live | §5.2.2 |
| Period-status trigger | a posting into a closed period was blocked only by application code | §5.2.6 |
| `metric_role` on `gl_account` | platform metrics no longer derive from a tenant-editable label | §5.10.1 |
| `settlement_kind` on `journal_line` | `dso_x100` was not derivable at all | §5.10.1 |
| Inventory revaluation entry + nightly value tie | the GL and the stock ledger no longer diverge by design | §5.14.5 |
| Attestation-based close gate | a watermark cannot prove absence | §5.2.6, §3.11.4 |

### 5.14.3 New cross-section contract: the subledger must return the obligation's location

Owned jointly by `credit-engineer` and `ledger-engineer`, needed before the first credit sale posts:
**every AR and AP allocation handed to the GL carries the location at which the obligation was
created.** Without it rule 4 cannot post correctly and per-location balance sheets become fiction
within a year while every constraint in the section stays green. This is the one finding that
produces wrong books with *no* detectable symptom until someone reads a branch balance sheet
carefully — which is exactly why the control-account ties in §5.11 are not optional.

### 5.14.4 Acceptance and posting are separate

Stated in §5.1 #11 and specified in §5.6.1. The rule in one line: **a GL failure never rejects a
settled document, and an unposted settled document is never silent.**

### 5.14.5 Costing, reconciled with §4.7.4

One model across both sections: the stock ledger's replayed valuation is canonical; the GL never
retro-restates a posted entry; a **period-close inventory revaluation entry** per location ties them;
a nightly `Σ(qty × WAC) = GL INVENTORY` assertion alerts on divergence. `5190 COGS — cost variance`
survives only for genuinely unrecoverable cases and is no longer the mechanism. Two consequences the
first draft did not state: the moving-average running state is **not** unwound by a GL reversal (a
reversed goods receipt must also reverse the cost effect in the subledger, or the average is
permanently polluted), and a sale arriving before the receipt that supplied it takes the
cost-of-issue rule in §4.7.4, never an implicit zero. **`GL-Q2` remains open** — the *method* is the
accountant's call; what is settled is the mechanism by which whichever method is chosen stays tied
to the books.

### 5.14.6 Full disposition

| # | Finding | Disposition |
|---|---|---|
| 1 | Reversal double-counts and retroactively restates | **Accepted.** `'reversed'` removed; statement-level invariant added. |
| 2 | Deferred backstop never fires on the manual-journal path; delete guard passes silently | **Accepted.** `je_balanced_on_post`; guard fails closed (`GL0003`); test added. |
| 3 | Cross-location settlement posts to the wrong control account | **Accepted.** Rule stated generally; rules 4, 9b, 9c, 11, 12 reissued with clearing lines; `CASH_IN_TRANSIT` added; subledger contract in §5.14.3. |
| 4 | No defined outcome for a settled document whose posting fails | **Accepted.** §5.14.4. |
| 5 | Costing contradicts §4.7.4 | **Accepted.** §5.14.5. |
| 6 | Control accounts never reconciled to subledgers | **Accepted.** Five ties added as invariants **and** as close gates. |
| 7 | Close gate unsatisfiable; `GL-Q4` asks the wrong question | **Accepted.** Attestation, not a watermark. `GL-Q4` closes as an engineering contract; the **exclusion policy** — who may exclude a dark device from a close, and on whose authority — needs a human owner and is carried to the README. |
| 8 | Platform metrics derive from a tenant-editable label | **Accepted.** `metric_role`. |
| 9 | `dso`/`dpo` not derivable; DSO includes accrued fees | **Accepted.** `settlement_kind`; `purchases` defined; DSO scoped to trade AR. |
| 10 | Mappings unconstrained, unversioned; `tender_method` a second channel | **Accepted.** `posting_role_catalog`, versioned mappings, `tender_method.posting_role` (§4.8). |
| 11 | Nothing stops a posting into a closed period; reopen self-contradiction | **Accepted.** Trigger; reopen rule stated once; audit columns; range and tiling constraints. |
| 12 | Transfer/in-transit contradicts §4.7.3; `is_trading` does not exist | **Accepted.** GL follows the stock ledger; `is_trading` and `is_postable_location` added to `app.location`; `journal_line.location_id` FK'd on postable kinds; `Σ locations` defined over posting-eligible nodes. |
| 13 | Discounts and overrides never reach the ledger | **Accepted.** Rule 1b, `SALES_DISCOUNT` contra; **gross revenue** is the decision. |
| 14 | Server-generated periodic entries have no idempotency; `source_id` not unique | **Accepted.** Deterministic keys (§3.11.7); `je_one_per_source`; periodic-job idempotency test. |
| 15 | Facility fee contradicts §6.4.4; rule 8b has no valid posting path | **Accepted.** One entry per credit account per period; waiver is a contra entry. Per-row COMMIT cost acknowledged as recurring, not one-off. |
| 16 | `entry_no` uniqueness vs per-FY gaplessness; `gl_counter` undefined | **Accepted.** `unique (tenant_id, fy_code, entry_no)`; `fy_code` on the entry; `gl_counter` DDL added. |
| 17 | "Row lock for microseconds" is false | **Accepted.** The lock is held to COMMIT, so throughput is 1/(transaction duration) per tenant per fiscal year, not 1/second of capacity — and the workload is bursty by construction (25 outlets draining after an outage), so annual averages were the wrong denominator. The mitigation stands (per-location sub-sequences) and the **backlog-drain** case is now the sizing case. |
| 18 | The `pg_temp` guard is an off switch | **Accepted.** GUC-gated, maintenance role only, plus a full in-transaction verification pass. |
| 19 | `pe_bureau_complete` does not do what §5.8 claims | **Accepted.** The constraint permitted any bureau column to be populated when `bureau_import_id IS NULL` — the exact case it existed to stop. Replaced by §4.11's child table, where `bureau_import_id NOT NULL` is unconditional. `gross_pay` identity CHECK added. |
| 20 | DDL that will not run | **Accepted.** `coalesce(...)` in a primary key replaced by a generated `scope_key` column (`gl_account_mapping` **and** `target_line`); `reconciliation_match` re-keyed on the real composite keys `(tenant_id, statement_id, line_no)` and `(tenant_id, journal_entry_id, line_no)`. |
| 21 | "Every FK is composite on `tenant_id`" is not true | **Accepted.** Composite FKs added for `counterparty_id`, `product_id`, `source_line_id`, `scope_id` and both `reconciliation_match` references. `requires_counterparty` is now enforced by trigger — without it an AR line with a NULL counterparty posts and no subledger tie is possible. |
| 22 | Zero-value entries cannot post | **Accepted.** A promotional transfer or a 100%-discounted line has no valid entry under `jl_one_side` + `debit_total > 0`, so the movement happened with no GL record. Ruling: **zero-value stock movements post a memo-only entry against `PROMOTIONAL_ISSUE` at cost**, so there is always an entry; a genuinely zero-cost item posts nothing and is listed on the close report. Never a silent gap. |
| 23 | Sales returns: cost, tax date, orphan returns | **Accepted.** Return posts COGS reversal at the **original sale's** snapshotted cost and re-prices tax against the **original sale's** `tax_rate_id`, never the return's `document_date` — a return after a rate change otherwise reverses the wrong VAT. A return without an original sale is a separate document type requiring a manager permission and its own reason code. |
| 24 | Metric divisions have no rounding rule or zero-denominator handling | **Accepted.** §4.13 rounding point 12; zero denominator yields NULL and renders "—". |
| 25 | Facility-fee remainder allocation understated | **Accepted.** Largest-remainder across *k* locations (up to *k*−1 remainder units, not one), tie-broken on `location.code` rather than a UUID so the result is reproducible across environments, not merely deterministic. |
| 26 | `gl_balance` is authoritative in practice | **Accepted.** Maintained in the posting transaction; nightly job becomes verification; arbitrary date ranges read the lines. |
| 27 | Opening balances are absent | **Accepted, and escalated.** Tenant #1 goes live 1 Aug 2026 with existing stock, debtors and creditors and there was no design: no `source_kind`, no rule, no equity plug, no gate that the opening trial balance ties to the subledgers per location. This is **Phase 1 work, not Phase 3** — it is the first thing that posts. Added to §5.12's gate list and to the README's Phase 1 dependencies. |
| 28 | Location lifecycle unaddressed | **Accepted.** Closing a location requires its clearing balance to be zero and its retained earnings transferred by an explicit entry; **re-parenting is effective-dated on the hierarchy**, because without that it silently restates every prior-period region-level metric in §5.10. |
| 29 | Residual tenant-#1 and market vocabulary in platform surfaces | **Accepted.** `'MOMO'` moves from a hard enum to a pack-defined **instrument type** (mobile money is a market concept, not a platform one); `FACILITY_FEE_*` roles become feature-scoped via `required_when_feature`; `target_line.period_key` gains an FK to the tenant's calendar so renaming 'FY1' cannot orphan every target silently. |
| 30 | No statement of cash flows | **Accepted as scope, and named.** The constitution asks for P&L and balance sheet, so this is not a violation — but the tenant's headline planning number is the FY3 cash trough and §5.10 tracks only a point-in-time `cash_balance`. Recorded as deliberate Phase 3 scope with an indirect cash-flow statement as the intended shape, rather than left unmentioned. |

**Still open after this pass, and needing a human:** `GL-Q1` (VAT-inclusive or exclusive revenue),
`GL-Q2` (costing method), `GL-Q3` (staff-cost baselines), the dark-device exclusion policy from
finding 7, and Q6 (the reviewing accountant is still not named). All five are in the README's
consolidated table.
