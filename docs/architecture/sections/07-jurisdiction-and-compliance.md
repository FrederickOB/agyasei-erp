# 7. Jurisdiction Packs and the Compliance Boundary

**Owner:** `compliance-gatekeeper` · **Phase:** 0 (design) · **Implements:** `ADR-0002`, `ADR-0007`
· **Constrained by:** `CLAUDE.md` §2.3 (money), §2.4 (payroll), §2.5 (jurisdiction packs), §2.8 (gates)

> **Nothing in this section is professional advice or sign-off.** Every Ghanaian figure below is
> marked `[UNCONFIRMED]` and is my reading of public sources on **20 August 2026**. It exists so a
> qualified professional has something specific to correct, not so engineering can proceed without
> one. §7.7 lists exactly what to ask and whom.

This section decides four things:

1. **What a jurisdiction pack is** — a two-layer data structure, not a code module (§7.1, §7.2).
2. **How a historical transaction reprices** — and why a reprint reads stored tax lines rather
   than re-running the rate lookup (§7.3).
3. **What the Ghana pack contains**, and the one thing about it that is a live schedule risk
   nobody has priced yet: Ghana's e-invoicing regime is a *clearance* regime, and this product's
   premise is trading offline for days (§7.4).
4. **Where the line is** — no branch on jurisdiction (§7.5), no withholding logic in any pack,
   ever (§7.6), and a gate list with names against it (§7.7).

It also proposes one refinement to `ADR-0002`. That ADR specifies the rate tuple as
`(tax_code, rate, effective_from, effective_to)`. **That tuple cannot represent what Ghana
actually did on 1 January 2026**, which was change the *base* the levies are computed on, not the
rates. The rates are unchanged. §7.2 and §7.4 explain. This is a refinement, not a relitigation:
the principle in `ADR-0002` — rates are effective-dated data, never constants — is what surfaced
the gap.

---

## 7.1 A pack is applied, not consulted

The obvious design is one global table of jurisdictions that every tenant reads through a foreign
key. It is wrong for the same reason `ADR-0006` gives for templates: it makes platform data a
runtime dependency of tenant behaviour, so a platform edit silently changes a tenant's books.

Packs therefore work exactly like the chart-of-accounts template. **Two layers:**

**Layer 1 — the published pack version.** Platform-owned reference data. *No `tenant_id`.* No
tenant can write it, and it never syncs to a device. It is immutable once published; a correction
is a new version, never an in-place edit. It is the platform's best reading of one jurisdiction's
rules at a point in time.

**Layer 2 — the tenant's applied rows.** At onboarding, the pack version is *applied*, seeding
ordinary tenant-owned rows carrying `tenant_id`, subject to RLS, editable by the Accounts role,
and synced to devices like any other tenant data (`ADR-0005`). **The POS reads only Layer 2.**

Consequences worth stating, because they are the point:

- **The platform never silently changes a tenant's tax rows.** When Ghana amends a rate, the
  platform publishes pack version *N+1*; each affected tenant gets a **proposed change** in the
  review queue (`CLAUDE.md` §2.2), which an Accounts-role user applies, creating new effective-dated
  rows with an audit trail and a named approver. A tenant in dispute with the revenue authority,
  or on a special regime, is not overwritten by a deployment.
- **Sync rules need no special case.** Devices only ever receive `tenant_id`-scoped rows. A
  "global table that everyone can read" is exactly the shape that turns into a tenant-isolation
  incident, and it does not exist here.
- **The `[UNCONFIRMED]`/`confirmed_by` distinction lives on the tenant row**, because confirmation
  is per-tenant: the professional confirms *this tenant's* registration status and rate set
  (§2.8), not the platform's reading of the statute in the abstract.

---

## 7.2 The shape of a pack

DDL sketches, not migrations. Types are load-bearing; names are not.

### 7.2.1 The version envelope

```sql
-- Platform-owned reference data. Deliberately has no tenant_id (see §7.1).
create table pack_version (
  pack_version_id   uuid primary key,
  jurisdiction_code text        not null,   -- ISO 3166-1 alpha-2: 'GH'
  version           integer     not null,
  published_at      timestamptz not null,
  supersedes        uuid references pack_version,
  source_notes      text        not null,   -- the legal instruments this version encodes,
                                            -- cited well enough for a professional to check
  unique (jurisdiction_code, version)
);
```

### 7.2.2 Currency — and the scale trap

```sql
create table pack_currency (
  pack_version_id       uuid    primary key references pack_version,
  currency_code         char(3) not null,   -- ISO 4217: 'GHS'
  display_symbol        text    not null,   -- 'GH₵' — presentation only (ADR-0004)
  minor_units_per_major bigint  not null,   -- GHS: 100. NOT an exponent. NOT assumed.
  cash_rounding_unit_minor bigint not null default 1
);
```

`minor_units_per_major` is stored as the **divisor itself**, not as a power-of-ten exponent. The
exponent form is more compact and is what ISO 4217 publishes, and it is still wrong: the
Mauritanian ouguiya divides into 5 khoums and the Malagasy ariary into 5 iraimbilanja. Storing the
divisor costs one `bigint` and removes an assumption that would otherwise be discovered by a
customer. Zero-decimal (JPY: 1) and three-decimal (KWD, BHD: 1000) currencies are the common cases
and are handled by the same column.

`CLAUDE.md` §2.3 says the scale is a pack value and no code may assume 100. §7.5 explains how that
is enforced rather than merely asserted.

`cash_rounding_unit_minor` handles jurisdictions where cash tender rounds to a coin larger than the
minor unit. It is **not** the same as tax rounding (§7.2.4) and must not be conflated with it: one
changes what the customer hands over, the other changes what is remitted.

### 7.2.3 Tax codes

```sql
create table pack_tax_code (
  pack_version_id  uuid    not null references pack_version,
  tax_code         text    not null,      -- 'GH.VAT.STD', 'GH.NHIL', 'GH.GETFUND'
  print_label      text    not null,      -- printed on the invoice verbatim; statutory wording
  kind             text    not null,      -- 'output_tax' | 'levy' | 'zero_rated' | 'exempt'
  input_deductible boolean not null,      -- Ghana 2026: NHIL and GETFund became true
  gl_account_role  text    not null,      -- a *role*, resolved to a real account by the CoA
                                          -- template — never an account number
  primary key (pack_version_id, tax_code)
);
```

`print_label` exists because the statutory wording on an invoice is itself a compliance
requirement, and it is not derivable from the code. `gl_account_role` is a role rather than an
account number so that a tenant who edits their chart of accounts (`ADR-0006`) does not break tax
posting; `ledger-engineer` owns that resolution.

`input_deductible` is a real behavioural field, not documentation: on 1 January 2026 Ghana's NHIL
and GETFund levies became input-deductible `[UNCONFIRMED]`, which changes the VAT return, not the
receipt. A design that modelled levies as "things you add to the price" and nothing more would
have had to grow a code path to absorb that.

### 7.2.4 Rates — effective-dated, and base-aware

```sql
create extension if not exists btree_gist;

create table pack_tax_rate (
  pack_version_id uuid      not null,
  tax_code        text      not null,
  rate_bp         integer   not null,     -- basis points. 15% = 1500. Integer (ADR-0004).
  base_kind       text      not null,     -- 'net' | 'net_plus'
  base_includes   text[]    not null default '{}',  -- tax_codes folded into this code's base
                                                    -- when base_kind = 'net_plus'
  rounding_level  text      not null,     -- 'line' | 'document'
  rounding_mode   text      not null,     -- 'half_up' | 'half_even' | 'down'
  effective       daterange not null,     -- [from, to) — half-open, upper bound may be unbounded
  legal_reference text      not null,     -- 'Value Added Tax Act, 2025 (Act 1151), s.3'
  foreign key (pack_version_id, tax_code) references pack_tax_code,
  exclude using gist (pack_version_id with =, tax_code with =, effective with &&)
);
```

Four things here are not in `ADR-0002`'s tuple, and each earns its place:

**`base_includes` / `base_kind`.** Until 31 December 2025 Ghana computed VAT at 15% on a base that
*already included* the NHIL, GETFund and COVID-19 levies — a cascade producing an effective 21.9%.
From 1 January 2026 all three apply to the same base, giving 15 + 2.5 + 2.5 = 20% `[UNCONFIRMED]`.
**No rate changed.** A `(tax_code, rate, effective_from, effective_to)` table cannot express that
transition at all, and the code that consumed it would have had to learn the cascade — at which
point the cascade is in the platform and Ghana's 2026 reform is a deployment. This is the
concrete, dated proof that base composition is pack data.

**`rounding_level` and `rounding_mode`.** With three taxes on one base, where you round decides
whether the printed lines foot. The platform rule: compute each `(line, tax_code)` amount as
`base_minor * rate_bp / 10000`, round **once** there under `rounding_mode`, and derive the document
tax total as the **sum of the rounded line amounts** — never by recomputing against the document
base. Where a jurisdiction requires document-level rounding instead, `rounding_level = 'document'`
selects the other implementation. Both are platform code; the pack chooses. `ADR-0004` requires
rounding to be explicit at every boundary — this is that boundary, named.

**`effective` as a `daterange` with an exclusion constraint.** Two overlapping rows for one tax
code is silent mispricing, not an error anyone notices. `daterange` + `exclude using gist` makes it
a write failure. Half-open `[from, to)` removes the off-by-one-day argument permanently.

**`legal_reference`.** A reviewing accountant cannot confirm a number without knowing what it
claims to encode. Not optional.

### 7.2.5 The tenant's applied rates

```sql
create table tax_rate (
  tenant_id         uuid      not null,          -- ADR-0005: on every tenant-owned row
  tax_code          text      not null,
  rate_bp           integer   not null,
  base_kind         text      not null,
  base_includes     text[]    not null default '{}',
  rounding_level    text      not null,
  rounding_mode     text      not null,
  effective         daterange not null,
  legal_reference   text      not null,
  applied_from_pack uuid,                        -- null ⇒ tenant-authored, needs closer review
  confirmed_by      text,                        -- the professional's name (§2.8 gate)
  confirmed_at      timestamptz,
  primary key (tenant_id, tax_code, effective),
  exclude using gist (tenant_id with =, tax_code with =, effective with &&)
);
-- RLS enabled; policy scopes on tenant_id. Every index leads with tenant_id.
```

**`confirmed_by` is the gate, in the schema.** Phase 1 go-live for a tenant is blocked on every
`tax_rate` row that tenant will actually use having a non-null `confirmed_by`. That converts §2.8
from a paragraph someone remembers into a query someone runs. It is not enforced as a `not null`
constraint, because rows must be insertable before they are confirmed — but the go-live check is
mechanical and `qa-engineer` should own it.

### 7.2.6 Document field requirements

```sql
create table pack_document_field (
  pack_version_id uuid   not null references pack_version,
  document_type   text   not null,   -- 'tax_invoice' | 'sales_receipt' | 'credit_note'
  field_key       text   not null,   -- 'supplier_tin', 'customer_tin', 'clearance_code', ...
  requirement     text   not null,   -- 'required' | 'conditional' | 'optional' | 'forbidden'
  condition_kind  text,              -- closed set, e.g. 'if_customer_registered',
                                     -- 'if_total_at_or_above_threshold'
  threshold_minor bigint,            -- operand for the threshold conditions
  source          text   not null,   -- the instrument or prescription imposing it
  primary key (pack_version_id, document_type, field_key)
);
```

`condition_kind` is drawn from a **closed set the platform implements**, not an expression string.
The temptation to make it a small expression language should be resisted: a DSL evaluated at
invoice-print time is `if (country === 'GH')` with extra steps and a parser to maintain. When a
jurisdiction needs a condition the set does not contain, the platform gains one enumerated
condition — a reviewable, testable change — and every pack can use it.

`'forbidden'` is a real requirement level. Some jurisdictions prohibit printing certain identifiers
on a consumer receipt. Modelling only "required/optional" means that arrives as a code change.

### 7.2.7 Statutory report formats

```sql
create table pack_statutory_report (
  pack_version_id uuid     not null references pack_version,
  report_key      text     not null,   -- 'GH.VAT_RETURN'
  cadence         text     not null,   -- 'monthly' | 'quarterly' | 'annual'
  due_rule        text     not null,   -- closed set: 'day_of_following_period'
  due_day         smallint,
  export_format   text     not null,   -- 'csv' | 'xml' | 'json'
  column_spec     jsonb    not null,   -- ordered columns, each naming the ledger aggregate
                                       -- it draws from; the mapping is data, the aggregates
                                       -- are platform code
  primary key (pack_version_id, report_key)
);
```

**The platform renders a statutory report. It never files one.** Filing is an act with legal
consequence performed by a person who is accountable for its contents. An automated submission
path is not in scope and should be argued for explicitly if anyone wants it, because it moves the
compliance boundary — it does not merely automate work on this side of it.

### 7.2.8 The payroll boundary — declared, not configured

```sql
create table pack_payroll_boundary (
  pack_version_id         uuid   primary key references pack_version,
  register_export_columns text[] not null,  -- what the platform sends OUT to the bureau
  import_field_labels     text[] not null,  -- labels for figures that come BACK, e.g.
                                            -- 'PAYE', 'Employee SSNIT', 'Employer SSNIT'
  filing_authorities      text[] not null   -- 'GRA', 'SSNIT' — named for the UI and for the
                                            -- export header. Named, never called.
);
-- There is deliberately NO rate, bracket, threshold, band, relief or formula column in this
-- table, and there is no such column anywhere else in the payroll schema. Adding one is a
-- violation of CLAUDE.md §2.4, not a schema change. See §7.6.
```

That comment is the entire table. The pack declares *what the platform may not compute* and gives
the UI enough vocabulary to label the fields a human fills in. It contains labels and column
names. It contains no arithmetic.

---

## 7.3 Repricing: the rule, and why a reprint does not use it

### The lookup rule

A transaction dated `d` is priced against the row whose range contains `d`:

```sql
select rate_bp, base_kind, base_includes, rounding_level, rounding_mode
from   tax_rate
where  tenant_id = $1
  and  tax_code  = $2
  and  effective @> $3::date   -- $3 is the transaction date. Never current_date.
```

`current_date` must not appear in any tax lookup. `money-test-engineer` should treat its presence
in a pricing path as a failing test, not a review comment.

### The rule a reprint follows instead

**Tax lines are computed once, at the moment the document is finalised, and persisted.**

```sql
create table sale_tax_line (
  tenant_id         uuid    not null,
  sale_id           uuid    not null,
  sale_line_id      uuid    not null,
  tax_code          text    not null,
  print_label       text    not null,   -- snapshot: the statutory wording as it was
  rate_bp           integer not null,   -- snapshot: the rate as applied
  taxable_base_minor bigint not null,   -- snapshot: the base after base_includes was resolved
  tax_amount_minor  bigint  not null,
  rate_source       jsonb   not null,   -- {tax_rate row identity, effective range, legal_reference}
  primary key (tenant_id, sale_id, sale_line_id, tax_code)
);
```

**A reprinted receipt reproduces the original tax lines exactly because it reads these rows. It
does not re-run the lookup.** This is the part that is easy to get subtly wrong, so it is worth
being blunt about why the effective-dated table alone is not enough:

- **Rates are sometimes enacted retroactively.** A statute passed in March with effect from
  January is normal. When that row is inserted, the correct behaviour for a receipt already handed
  to a customer in February is to *stay the same* — and for the discrepancy to be *surfaced*, not
  silently absorbed. If reprints recomputed, the document would change under the customer's copy.
- **A tenant may legitimately edit their own rows.** Accounts-role users can. A typo corrected on
  Tuesday must not restate Monday's receipts.
- **Devices go offline for days** (§2.2). A tablet holding last week's synced `tax_rate` rows
  prices a sale on the rates it holds. That is the *correct* commercial outcome — the customer was
  charged what the receipt says — and it is *also* possibly a compliance discrepancy.

The effective-dated table's job is therefore **audit, not print**. A scheduled recompute job walks
finalised documents, re-derives each tax line from the table as of the transaction date, and
compares against the stored snapshot. Divergence goes to the **human review queue** (§2.2) with
both figures and the legal references, categorised:

| Divergence cause | Detection | Resolution |
|---|---|---|
| Retroactive rate enactment | Recompute job | Accountant decides: credit note, voluntary disclosure, or no action |
| Device priced on a stale synced rate | Recompute job + sync logical timestamp | Same, plus a sync-lag review if it recurs |
| Tenant edited a historical row | Row audit trail | Usually a data error; the snapshot is authoritative |
| Platform bug | Recompute job | Defect |

Silently repricing history is the failure mode this design exists to prevent. Flagging it is the
feature.

---

## 7.4 The Ghana pack

> **Every figure in this subsection is `[UNCONFIRMED]`** and requires the reviewing accountant's
> written confirmation before Phase 1 go-live (§7.7, gates G2a–G2d). I am not a tax adviser; I am
> specifying the mechanism and naming what a professional must confirm.

### 7.4.1 Rates, current regime

Sourced from the Ghana Revenue Authority's published VAT rates page and its notice to VAT-registered
taxpayers, both read 2026-08-20, and attributed there to the **Value Added Tax Act, 2025 (Act 1151)**,
effective **1 January 2026**.

| `tax_code` | Rate | `base_kind` | `input_deductible` | Effective from | `[status]` |
|---|---|---|---|---|---|
| `GH.VAT.STD` | 15% (`rate_bp` 1500) | `net` | — | 2026-01-01 | `[UNCONFIRMED]` |
| `GH.NHIL` | 2.5% (`rate_bp` 250) | `net` | true | 2026-01-01 | `[UNCONFIRMED]` |
| `GH.GETFUND` | 2.5% (`rate_bp` 250) | `net` | true | 2026-01-01 | `[UNCONFIRMED]` |

All three on the same base ⇒ **effective 20% of net** `[UNCONFIRMED]`.

The **COVID-19 Health Recovery Levy** (Act 1068) is reported repealed with effect from the same
date `[UNCONFIRMED]`. In the pack it is not deleted — it is a `GH.COVID` code whose `effective`
range closes at `2026-01-01`, because deleting it would make pre-2026 documents unauditable.

### 7.4.2 Rates, prior regime — and why they must exist

| `tax_code` | Rate | `base_kind` / `base_includes` | Effective to | `[status]` |
|---|---|---|---|---|
| `GH.VAT.STD` | 15% | `net_plus` {`GH.NHIL`, `GH.GETFUND`, `GH.COVID`} | 2026-01-01 | `[UNCONFIRMED]` |
| `GH.NHIL` | 2.5% | `net` | 2026-01-01 | `[UNCONFIRMED]` |
| `GH.GETFUND` | 2.5% | `net` | 2026-01-01 | `[UNCONFIRMED]` |
| `GH.COVID` | 1% | `net` | 2026-01-01 | `[UNCONFIRMED]` |

Cascade ⇒ 6% levies + 15% × 1.06 = 15.9% ⇒ **effective 21.9%** `[UNCONFIRMED]`.

**Tenant #1 does not need these rows.** Agyasei launches 1 August 2026, so it has no Ghanaian sales
under the prior regime. They are here because *the product* needs them: the second Ghanaian tenant
will be an existing business with history, credit notes against pre-2026 invoices, and opening
balances. The exact commencement dates of the prior-regime rows are `[UNCONFIRMED]` and should be
confirmed **when a tenant that needs them onboards**, not now — this is a good example of a
confirmation that can be deferred without blocking anything, and the gate list should not be
padded with it.

Also reported: the **VAT Flat Rate Scheme** is abolished under Act 1151 `[UNCONFIRMED]`, and the
registration threshold for suppliers of goods rose from GH₵200,000 to GH₵750,000 `[UNCONFIRMED]`.
The threshold does not change tenant #1's answer — FY1 revenue is **GH₵2,640,000** (canonical, per
`financial-model-targets.md` and §2.10), an order of magnitude above either figure, which is the
whole basis of `ADR-0002` and open question Q5. What still requires confirmation is the tenant's
**registration status and registration date**, not the threshold.

### 7.4.3 What a compliant invoice must carry

Act 1151 does **not** enumerate the fields. It requires a tax invoice "in the form and with the
particulars prescribed by the Commissioner-General", issued through a **Certified Invoicing
System** integrated with the Commissioner-General's system `[UNCONFIRMED]`. **The field list is
therefore a Commissioner-General prescription and the GRA's E-VAT guidelines, not statute** — which
is precisely why §7.2.6 stores it as data with a `source` column: it changes on an administrative
timescale, without an Act of Parliament to notice.

Working list for `pack_document_field`, **every row `[UNCONFIRMED]`**:

*Tenant-generated:* supplier legal name, address and TIN · supplier VAT registration number ·
customer name and TIN (`conditional` — the condition needs confirming) · unique sequential invoice
number · date and time of supply · per line: description, quantity with unit, unit price, taxable
value · **each of `GH.VAT.STD`, `GH.NHIL`, `GH.GETFUND` shown separately with its rate and amount**
· document totals · currency.

*GRA-returned, and this is the part that matters:* clearance/SDC code · validation timestamp ·
invoice hash · QR code · digital signature/stamp. Retention reportedly six years `[UNCONFIRMED]`.

### 7.4.4 The collision nobody has priced: clearance versus offline-first

Ghana operates a **clearance** model. On the sources read, an invoice generated by a taxpayer's own
system **is not a valid VAT invoice until the GRA has cleared it and returned a clearance code, QR
code and digital signature** `[UNCONFIRMED]`.

`CLAUDE.md` §2.2 says every location must trade **fully offline for hours or days**. `ADR-0002`
says receipts "carry the fields the Ghana Revenue Authority requires." Under a clearance regime,
**carrying the fields is not sufficient** — some of the required fields can only be produced by a
server the tablet cannot reach. These two requirements are in direct tension and the ADRs do not
acknowledge it.

This is not a detail to resolve during Phase 1 implementation. It determines the POS document model.
The candidate resolutions, to be put to the professional and to the GRA:

1. **Two document types.** Offline, the counter issues a *provisional sales document* that is
   explicitly not a tax invoice; on reconnect it is submitted for clearance and the cleared tax
   invoice is issued (printed on collection, or delivered by SMS/WhatsApp/email). This is the
   honest model and it has a real customer-experience cost at a builder's merchant counter.
2. **Documented offline provision.** Secondary sources describe an offline mode with provisional
   QR issuance and an obligation to notify the GRA of outages within 24 hours `[UNCONFIRMED]`. If
   the Certified Invoicing System specification genuinely permits deferred transmission with a
   locally generated provisional code, most of the problem disappears — and the permitted offline
   *window* becomes a hard architectural parameter, because "days" may not be within it.
3. **Certification lead time.** Onboarding a taxpayer's own system reportedly involves application
   to the GRA, API integration and **Joint User Acceptance Testing** before the system is certified
   `[UNCONFIRMED]`. That is a lead time measured in months, not days, and it currently sits nowhere
   on the plan.

And one that would be structurally serious if true: sources state that **any change to a taxpayer's
invoicing software must be pre-approved by the Commissioner-General** `[UNCONFIRMED]`. For a
continuously deployed PWA that is a fundamental constraint on the release process, not a compliance
checkbox. It must be confirmed early — before the deployment pipeline is designed, not after.

**Recommendation:** amend `ADR-0002` once §7.7 gate **G2d** returns, and treat G2d as the
longest-lead item in Phase 1. It is the one thing in this section that can move the 1 August 2026
launch date.

### 7.4.5 What to ask, and whom

- **A Ghana-qualified chartered accountant in practice (ICAG member) or a GRA-registered tax
  practitioner** — G2a, G2b, G2c: registration status and date; the rate set, base composition and
  rounding level in §7.2.4 as encoded; the invoice and receipt field list; input-deductibility of
  NHIL/GETFund and its effect on the VAT return; the GL treatment of output tax and of the levies.
  Give them §7.4.1–§7.4.3 to mark up. Ask for the answer **in writing, with the instrument cited**,
  so `legal_reference` and `confirmed_by` can be populated.
- **The GRA directly, via the practitioner** — G2d: the Certified Invoicing System onboarding
  process and timeline; the offline provision and its permitted window; whether software changes
  require pre-approval and what that process is. Ask this **first**; it has the longest lead time.

---

## 7.5 Why there is no `if (country === 'GH')`, and what to do when tempted

The usual argument for the rule is portability — you would have to find every branch when Nigeria
arrives. That argument is true and it is not the strongest one.

**The strongest one is dated.** Any engineer writing this platform in 2025 would have written the
Ghana cascade — VAT on a base that includes the levies — as Ghanaian behaviour, because it *was*
Ghanaian behaviour, uncontroversially, for years. On 1 January 2026 it stopped being true. The
branch would have been wrong **within a single jurisdiction**, with no second country involved at
all. Jurisdiction is not a place. It is a place *and a date*, and only the second axis is the one
that moves under you.

### The decision procedure

When you find yourself wanting the branch, the behaviour that differs is one of four things. Work
down the list; stop at the first that fits.

1. **A value.** → A column on a pack table. (Rate. Minor-unit divisor. Retention period.)
2. **A list.** → A child table. (Tax codes. Required invoice fields. Report columns.)
3. **A rule from a closed set the platform implements.** → An enumerated strategy column whose
   values are all implemented generically, and which every pack may use. (`base_kind`,
   `rounding_level`, `rounding_mode`, `due_rule`, `condition_kind`.) **This is where most real
   cases land, and it is the one people skip.** Adding a value to a closed set is a reviewable,
   testable platform change; adding a country test is not.
4. **Genuinely new platform capability.** → The platform gains a capability, declared by a pack
   flag and implemented once. Clearance-based e-invoicing (§7.4.4) is this case: it is not a Ghana
   feature, it is a *capability* that Ghana, Kenya, Rwanda and a dozen Latin American regimes all
   require in variants.

**If it fits none of the four, stop and write it down.** That is a platform capability gap, and it
escalates to `software-engineer` and `compliance-gatekeeper`. It is never resolved by branching
"just for now", because "just for now" is how a jurisdiction becomes load-bearing in code that
nobody remembers to look at when the law changes.

### Enforcement, structurally

`CLAUDE.md` §2.1 requires tenant isolation be enforced structurally rather than by convention. The
same standard applies here, and asserting the rule in a document is not enforcement.

- **A lint rule** rejecting the literals `'GH'`, `'GHS'`, `'Ghana'`, `'GH₵'` and any comparison
  against a `country` / `jurisdiction_code` variable, outside `packs/` seed data, migrations and
  tests. `100` as a money divisor is caught by the same rule set (`ADR-0004`).
- **A second jurisdiction in CI — the "smoke pack".** A fictional jurisdiction, provisioned in the
  test suite alongside Ghana, deliberately chosen to break every lazy assumption: **1000 minor
  units** per major unit, a **single** tax code, `base_kind = 'net'`, `rounding_level = 'document'`,
  a different invoice field set, and **no clearance requirement**. Phase 1 acceptance criterion 5
  already requires a second tenant from a different template to be invisible to tenant #1
  (`CLAUDE.md` §3); the smoke pack tenant should *be* that second tenant. Then the isolation test
  and the jurisdiction test are the same test, and both are demonstrated rather than asserted.

If a code path branches on Ghana, the smoke pack fails. That is the enforcement. `qa-engineer`
owns it; it must exist before Phase 1 acceptance, not after.

---

## 7.6 The payroll boundary — universal, categorical, and not the VAT case

**No jurisdiction pack ever contains payroll withholding logic.** Not Ghana's. Not any future
pack's. Not as a convenience, an estimate, a preview, behind a feature flag, or temporarily.

The permitted flow is unchanged (`CLAUDE.md` §2.4): **capture** hours, roles, gross pay and
commissions → **export** a payroll register → the accountant, bookkeeper or bureau computes
deductions and files with the relevant authorities → **their figures are re-imported** into clearly
marked fields → net pay is **entered, not calculated**.

### The analogy someone will draw, and why it fails

The proposal arrives in good faith and sounds like consistency: *"§7.2.4 already has an
effective-dated table with legal references and a confirmation gate. Put the PAYE bands in it. That
solves the maintenance objection — it's data, not code, and it's dated."*

**Reject it.** §2.4 prohibits statutory payroll calculation **categorically**. It is not a rule
against hard-coding, and the VAT table is not a precedent. Two independent reasons:

**Reason one — the failure modes are not comparable.**

| | Stale VAT rate | Stale PAYE band |
|---|---|---|
| **Who sees the error** | The customer, on a receipt, at the counter | Nobody |
| **When** | Immediately | At a filing deadline, or at audit, years later |
| **What it is** | An overcharge or undercharge on one sale | A statutory under-remittance |
| **What follows** | A correction, a credit note | Penalties and interest, accruing from the original date |
| **Who is liable** | Commercially awkward | The company's officers |
| **How it self-corrects** | Loudly, within a day | It does not |

Configurability does not touch the second column. Making a table editable does not make anyone edit
it. **Nothing in the system will ever tell you a PAYE table is out of date** — that is exactly the
property that makes it dangerous, and it is unchanged by where the numbers are stored. A wrong
VAT rate is a bug report. A wrong PAYE figure is a statutory filing error.

**Reason two — and this one is independent of staleness, so it survives every "but we'll maintain
it" answer.** VAT is a *transaction* tax, computed from data the system already owns — a line, a
base, a rate — and settled on a document handed over in the same minute. PAYE is computed on a
*cumulative annual* basis, against reliefs, allowances, personal circumstances, and income from
employments this system does not know about. **Even a perfectly maintained, correctly dated bracket
table returns a wrong number** without facts the ERP does not hold and has no business holding. The
maintenance argument is the weaker of the two objections; this is the one that closes the door.

### Recording is not calculating

`CLAUDE.md` §2.4 is explicit and it matters for the GL: the employer social-security contribution
is a **company expense** and needs an account and a posting line. Posting the figure the bureau
returns is **recording**. Deriving it from a rate is **calculating**.

**The distinguishing test is mechanical: does any code path multiply a rate by a pay figure?** If
yes, it is calculation, wherever the rate came from — a table, a config file, a spreadsheet import,
a constant, or a user's typed input reused as a rate. If the figure arrives as an *amount*
attributable to a named source document, it is recording.

Enforce it in the schema, so it is not a matter of anyone's judgement at review time:

```sql
create table payroll_deduction (
  tenant_id            uuid   not null,
  payroll_run_id       uuid   not null,
  employee_id          uuid   not null,
  label                text   not null,  -- from pack_payroll_boundary.import_field_labels
  amount_minor         bigint not null,
  source               text   not null default 'imported'
                       check (source = 'imported'),   -- there is no other legal value
  imported_from_doc_id uuid   not null,  -- the bureau's register. Not nullable, by design.
  imported_by          uuid   not null,
  imported_at          timestamptz not null,
  primary key (tenant_id, payroll_run_id, employee_id, label)
);
```

`imported_from_doc_id not null` means a deduction figure **cannot exist without a source document**.
There is no path that produces one from arithmetic, because there is nothing to arrive from. Add to
this a CI assertion that **no column in the payroll schema is named like a rate, band, bracket,
threshold or percentage**, and the prohibition is structural rather than cultural — which is the
standard §2.1 sets for tenant isolation and there is no reason to hold this line to a lower one.

### The refusal, and what to build instead

A bare "no" leaves the schedule pressure that produced the request unresolved and looking for a
loophole. The answer that holds is a refusal plus the path that still unblocks the week:

> I can't add withholding calculation — `CLAUDE.md` §2.4 prohibits it categorically, and a
> configurable table doesn't change that (§7.6). What I can have working this week: the register
> export with the columns your bureau actually wants, the import of their returned figures into
> labelled fields, the GL posting for the employer contribution from the figure they give us, and
> net pay entered rather than derived. That is a complete payroll cycle. The only thing it does not
> do is the one thing that would make us liable for someone else's filing.

If the requester's real problem is *"payroll takes too long each month"*, the fix is a better
export and a faster import round-trip — which is buildable, and which nobody has scoped. That is
gate **G6**.

---

## 7.7 The human gate list

These are **blocking**, and every one is cheaper to satisfy before the thing is built than after.
Status reflects `docs/open-questions.md` as at 2026-08-20.

| # | Gate | What it blocks | Who must sign | Status |
|---|---|---|---|---|
| **G1** | Chart of accounts, double-entry logic, and **one full month of generated statements** reviewed against manual expectations | **Phase 3 go-live** | A Ghana-qualified chartered accountant in practice (ICAG member) — **not yet named** | **OPEN** — Q6. Reviewer must be named **before Phase 3 design begins**, not before Phase 3 ships. Raise at the Phase 2 gate at the latest. |
| **G2a** | VAT registration status and registration date for the tenant | **Phase 1 POS go-live** | Same accountant / a GRA-registered tax practitioner | **OPEN** — Q5. `ADR-0002` decided the mechanism; this confirms the facts. |
| **G2b** | Ghana rate set as encoded: rates, **base composition**, input-deductibility, rounding level (§7.4.1, §7.2.4) | **Phase 1 POS go-live** | Same | **OPEN** — new in this section. Was one line ("the correct rate set"); the 2026 base change makes it four distinct confirmations. |
| **G2c** | Mandatory invoice/receipt field list per the Commissioner-General's prescription (§7.4.3) | **Phase 1 POS go-live** | Same | **OPEN** — new. Not in statute; comes from a prescription that changes administratively. |
| **G2d** | **E-VAT clearance model**: Certified Invoicing System onboarding, JUAT timeline, the offline provision and its permitted window, whether software changes need pre-approval (§7.4.4) | **Phase 1 POS go-live** — and the POS **document model**, so effectively Phase 1 design | The GRA, engaged via the practitioner | **OPEN, NOT STARTED** — new, and the **longest lead time in Phase 1**. This is the item most likely to move the 1 Aug 2026 launch. Start now. |
| **G3** | How the **2–3%/month credit facility fee** is structured — facility fee, cash/credit price differential, or something attracting lending regulation | **Phase 1 credit go-live** | The G1 accountant **and** a Ghana-qualified lawyer | **OPEN** — Q4. **Flagged, not answered.** 2–3%/month is an effective **26.8%–42.6% annually**; that arithmetic is the reason it needs a professional, and stating it is the limit of what an agent may contribute. `credit-engineer` builds the mechanism with the rate and the GL treatment configurable either way, so this gates go-live, not the build. |
| **G4** | Fleet→haulier financial consequence: the mechanism behind the **5.0% → 2.5%** distribution-cost decline (Lever 3), and the split of the **GH₵300,000** FY1 "fleet + ERP/HQ systems" capex line | **Phase 2 planning** | The G1 accountant + the founder | **OPEN** — Q1. `ADR-0001` settled the engineering question (hauliers only); the margin bridge and the capex split are unresolved and are not an engineer's call. |
| **G5** | Jurisdiction pack confirmed by a locally qualified professional | **First tenant go-live in any new jurisdiction** | A professional qualified in *that* jurisdiction | **N/A** — no second pack exists. The gate is standing: it applies per jurisdiction, automatically, without anyone deciding to open it. |
| **G6** | Payroll **register export and import field set** agreed with whoever will actually run payroll | **Phase 3 go-live** | The bureau, bookkeeper or accountant who will consume the export | **OPEN** — new, not previously raised. Building an export before agreeing its shape with its only consumer is how the §2.4 flow ends up bypassed in practice. Ask early; it costs one conversation. |

**Not gates**, recorded to prevent them being escalated into one: Q2 (receivables days) — the ERP
measures real DSO from day one and `business-data-analyst` surfaces it against the 15-day
assumption; that is monitoring, not sign-off. Q7 (fractional quantities and dual units of sale) —
a data-model decision for the architecture document needing the founder's confirmation of counter
practice and rebar conversion factors, not a professional's sign-off.

---

## 7.8 Concerns

Recorded rather than designed around, per instruction.

1. **`ADR-0002`'s rate tuple is under-specified, and Ghana proved it eight months ago.**
   `(tax_code, rate, effective_from, effective_to)` cannot represent the 1 January 2026 change,
   which altered the base rather than any rate. §7.2.4 adds `base_kind`, `base_includes`,
   `rounding_level` and `rounding_mode`. I am treating this as a refinement the ADR's own
   principle produced, but it should be written into the ADR rather than left in this section.

2. **`ADR-0002` predates the clearance problem and now says something that may not be
   achievable as written.** "Receipts carry the fields the Ghana Revenue Authority requires" is
   satisfiable offline only if the required fields are all locally derivable. Under a clearance
   regime some are not (§7.4.4). This is the largest unpriced risk I found in the whole compliance
   surface, and it sits at the intersection of the two constraints the project treats as
   non-negotiable — offline-first and statutory compliance. It needs a decision from **G2d**
   before the POS document model is fixed, and I would not start Phase 1 POS work without at least
   an answer on the permitted offline window.

3. **"Accountant confirms the Ghana pack" was one line and is really five.** Registration status,
   rate set and base, invoice fields, e-invoicing model, GL treatment — different questions, partly
   different owners, and wildly different lead times (days for the first, months for the fourth).
   Left as one line it gets one meeting and the slow item surfaces late. That is why §7.7 splits it.

4. **Section-number drift.** `ADR-0002` cites "the §2.7 human-review gate"; in `CLAUDE.md` §2.7 is
   the testing rule and §2.8 is human review gates. The `compliance-gatekeeper` agent definition
   cites "§2.3" for the payroll prohibition, which is §2.4 in `CLAUDE.md`, and "§2.6" for the third
   test category, which is §2.7. `CLAUDE.md` outranks both (`CLAUDE.md` preamble) and this section
   follows its numbering, but the cross-references should be corrected before anyone resolves them
   the wrong way.

5. **The recompute-and-flag job in §7.3 has no owner yet.** It is the only thing that detects a
   device pricing on stale rates or a retroactive enactment, and jobs without an owner do not get
   built. It should be assigned — probably `ledger-engineer` with `money-test-engineer` on the
   assertions — during Phase 1, not deferred to Phase 3 with the rest of the accounting work.

6. **I have verified nothing.** I read the GRA's published pages and several advisory summaries on
   20 August 2026 and encoded them faithfully. Reading a website is not sign-off, my knowledge of
   what changed in the last three months is incomplete, and rates and e-invoicing rules in Ghana
   have changed materially twice in the recent past. Treat every figure in §7.4 as a draft for a
   professional to correct.
