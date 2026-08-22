# 7. Jurisdiction Packs and the Compliance Boundary

**Owner:** `compliance-gatekeeper` · **Phase:** 0 (design) · **Implements:** `ADR-0002`, `ADR-0007`
· **Constrained by:** `CLAUDE.md` §2.3 (money), §2.4 (payroll), §2.5 (jurisdiction packs), §2.7
(tests), §2.8 (gates)

> **Nothing in this section is professional advice or sign-off.** Every Ghanaian figure below is
> marked `[UNCONFIRMED]` and is my reading of public sources on **20 August 2026**. It exists so a
> qualified professional has something specific to correct, not so engineering can proceed without
> one. §7.7 lists exactly what to ask and whom.

> **Revised 2026-08-22 after adversarial review.** Five blocking findings, thirteen major, nine
> minor. §7.11 is the full disposition and **where §7.11 and the body differ, §7.11 governs.**
> Sections §3, §4 and §5 are authoritative on the tables and timestamps they own; this section
> contributes the *pack side* and references theirs by name rather than redefining them.

This section decides five things:

1. **What a jurisdiction pack is** — a two-layer data structure, not a code module (§7.1, §7.2).
2. **How a historical transaction reprices** — the tax point, why a reprint reads stored tax lines
   rather than re-running the rate lookup, and why a credit note reads the *invoice's* tax lines
   rather than either (§7.3).
3. **What the Ghana pack contains**, and the one thing about it that is a live schedule risk
   nobody has priced yet: Ghana's e-invoicing regime is a *clearance* regime, and this product's
   premise is trading offline for days (§7.4).
4. **Where the line is** — no branch on jurisdiction (§7.5), no withholding logic in any pack,
   ever (§7.6), a gate list with names against it (§7.7), and the tests that make all three
   assertions rather than aspirations (§7.8).
5. **What the pack cannot yet express** — named, so the first engineer to hit one reaches for the
   pack instead of the conditional (§7.9).

It also proposes one refinement to `ADR-0002`. That ADR specifies the rate tuple as
`(tax_code, rate, effective_from, effective_to)`. **That tuple cannot represent what Ghana
actually did on 1 January 2026** `[UNCONFIRMED]`, which was change the *base* the levies are
computed on, not the rates. The rates are unchanged. §7.2 and §7.4 explain. This is a refinement,
not a relitigation: the principle in `ADR-0002` — rates are effective-dated data, never constants —
is what surfaced the gap.

---

## 7.1 A pack is applied, not consulted

The obvious design is one global table of jurisdictions that every tenant reads through a foreign
key. It is wrong for the same reason `ADR-0006` gives for templates: it makes platform data a
runtime dependency of tenant behaviour, so a platform edit silently changes a tenant's books.

Packs therefore work exactly like the chart-of-accounts template. **Two layers:**

**Layer 1 — the published pack version.** Platform-owned reference data in the `platform` schema.
*No `tenant_id`.* No tenant can write it, and it never syncs to a device. It is immutable once
published; a correction is a new version, never an in-place edit. It is the platform's best reading
of one jurisdiction's rules at a point in time.

**Layer 2 — the tenant's applied rows.** At onboarding, the pack version is *applied*, seeding
ordinary tenant-owned rows in the `app` schema carrying `tenant_id`, subject to RLS, editable by
the Accounts role, and synced to devices like any other tenant data (`ADR-0005`).

### 7.1.1 The rule that makes the two layers mean something

> **Nothing in Layer 1 is ever read at transaction time, at document-render time, at posting time,
> or by any report a tenant sees. Every read on any of those paths goes to Layer 2.**

The first draft stated this only for the POS and only for rates, and that was a hole big enough to
stop a till. `pack_currency`, `pack_tax_code`, `pack_document_field` and `pack_payroll_boundary` had
no applied counterpart, so a tablet three days offline in Techiman held the rates it needed and none
of the statutory print label, required-field list, currency symbol or minor-unit divisor it needs to
put a compliant document on paper. The counter could price the sale and could not print it.

The same hole was also a silent behaviour change in the other direction:
`pack_document_field.threshold_minor` and a component's recoverability flag are *behavioural* values,
so publishing pack *N+1* would have changed what a tenant's invoices require and what their VAT
return does **on deployment** — the exact failure this section opens by rejecting.

So: **every Layer-1 table has a Layer-2 twin, created by the same apply transaction.** There is no
exception list. The only thing that varies between twins is which sync bucket carries them, and one
twin is deliberately carried by none:

| Layer 1 (`platform`) | Layer 2 (`app`) | Sync bucket |
|---|---|---|
| `pack_currency` | `currency_setting` | `tenant_reference` |
| `pack_tax_component` | `tax_component` | `tenant_reference` |
| `pack_tax_code` | `tax_code` | `tenant_reference` |
| `pack_tax_code_component` | `tax_code_component` | `tenant_reference` |
| `pack_tax_rate` | `tax_rate` | `tenant_reference` |
| `pack_tax_rate_base_include` | `tax_rate_base_include` | `tenant_reference` |
| `pack_document_field` | `document_field_requirement` | `tenant_reference` |
| `pack_payroll_figure` | `payroll_figure_definition` | *(none — server-only)* |
| `pack_statutory_report` | `statutory_report_definition` | *(none — server-only)* |

The two server-only twins still exist as tenant rows, because the "changes on deployment" argument
applies to them identically: a statutory report format and a payroll figure set are tenant
behaviour, and a platform publish must not alter either without a named human applying it. They are
simply never in a bucket, because no device renders a VAT return or imports a bureau file. That
exclusion is asserted in CI (§7.8), not assumed.

`tenant_reference` is §3.2.3's existing tenant-wide bucket, which already carries the catalogue,
price lists and the two tax tables under their old names. Adding the rest of the applied pack to it
costs a few hundred rows per tenant.

### 7.1.2 Consequences worth stating, because they are the point

- **The platform never silently changes a tenant's tax rows.** When Ghana amends a rate, the
  platform publishes pack version *N+1* and each affected tenant gets a **proposed change** in the
  review queue, which an Accounts-role user applies. §7.2.10 specifies that flow, because "a
  proposal appears in a queue" with no deadline and no default is not a mechanism — it is a hope.
- **Sync rules need no special case.** Devices only ever receive `tenant_id`-scoped rows. A
  "global table that everyone can read" is exactly the shape that turns into a tenant-isolation
  incident, and it does not exist here.
- **The `[UNCONFIRMED]`/`confirmed_by` distinction lives on the tenant row**, because confirmation
  is per-tenant: the professional confirms *this tenant's* registration status and rate set
  (§2.8), not the platform's reading of the statute in the abstract.
- **The write path is asymmetric and that is deliberate.** A tenant admin may write Layer 2 and may
  never write Layer 1; a platform operator may write Layer 1 and may never write a tenant's Layer 2.
  §4.17.5 finding 21 records the same ruling from the data-model side.

---

## 7.2 The shape of a pack

DDL sketches, not migrations. Types are load-bearing; names are not, and where a name here differs
from §4's, **§4's name wins** (§3.11.9 is the canonical naming reconciliation).

**Every Layer-2 table below is created through `app.new_tenant_table` (§4.2.3).** That helper emits
`tenant_id`, `id` (UUIDv7), `write_id` with the composite FK to `write_log`, `hlc`, the timestamps,
the `(tenant_id, id)` primary key, `ENABLE`/`FORCE ROW LEVEL SECURITY` and the canonical isolation
policy. The DDL below therefore shows **only the pack-specific columns**. This is not a stylistic
choice: it is what puts every table in this section inside §4.2.5's `has_tenant_id` / `has_write_id`
/ `rls_forced` / `pk_leads_tenant` harness. The first draft hand-rolled its tables and so was
covered by none of it, in the section that invokes §2.1's structural-enforcement standard by name.

Money columns are `app.money_minor`; basis points are `app.bp`; quantities are `app.qty`
(§4.2.1). No column in this section is `numeric`, `float` or `number`.

### 7.2.1 The version envelope

```sql
-- Platform-owned reference data. Deliberately has no tenant_id (see §7.1).
create table platform.pack_version (
  pack_version_id   uuid primary key,
  jurisdiction_id   uuid        not null references platform.jurisdiction,
  version           integer     not null,
  published_at      timestamptz not null,
  supersedes        uuid references platform.pack_version,
  source_notes      text        not null,   -- the legal instruments this version encodes,
                                            -- cited well enough for a professional to check
  unique (jurisdiction_id, version)
);
```

`jurisdiction_id` is a foreign key, not an ISO string, because §7.5's enforcement rule is that a
jurisdiction-bearing value is never compared against a literal. `platform.jurisdiction` (§4.1) holds
the ISO code, and the only code that reads it is the pack loader and the display layer.

### 7.2.2 Currency — and the scale trap

```sql
create table platform.pack_currency (
  pack_version_id       uuid    primary key references platform.pack_version,
  currency_code         char(3) not null,   -- ISO 4217: 'GHS'
  display_symbol        text    not null,   -- 'GH₵' — presentation only (ADR-0004)
  minor_units_per_major bigint  not null    -- GHS: 100. The DIVISOR. NOT an exponent.
                        check (minor_units_per_major > 0),
  display_decimals      smallint not null   -- how many places the formatter prints
                        check (display_decimals between 0 and 6)
);
-- Applied twin: app.currency_setting, one row per tenant, same columns.
```

**The divisor is canonical for arithmetic; `display_decimals` is for the formatter and nothing
else.** Two columns rather than one, and the reason is that they are genuinely two facts. The
exponent form alone is more compact and is what ISO 4217 publishes, and it cannot represent the
Mauritanian ouguiya (5 khoums to the ouguiya) or the Malagasy ariary (5 iraimbilanja). The divisor
alone cannot tell a formatter what to print for those same currencies. For every currency this
product will plausibly meet, `minor_units_per_major = 10 ^ display_decimals`, and a CHECK asserts
exactly that for power-of-ten divisors; the two-column form exists so the non-power-of-ten case is a
row of data rather than a discovery.

**This resolves a three-way naming conflict, and the resolution costs edits in two other sections.**
§4.3 has `tenant.money_scale smallint`, §4.8 snapshots it onto documents as `money_scale`, and
§5.2.2 reads `jurisdiction.minor_unit_scale` at the formatting boundary. Three names for one value,
under two incompatible semantics. **Ruling, as the section that owns the pack:** the pack's names
and the divisor semantics are canonical; `tenant.money_scale` becomes
`tenant.minor_units_per_major bigint` + `tenant.display_decimals smallint`, derived from the applied
`currency_setting` row; the document snapshot follows; §5.2.2's `jurisdiction.minor_unit_scale`
resolves to the same pair. Recorded as a cross-section finding against §4 and §5 in §7.11.3, not
enacted here.

*Correcting the review on one point:* the finding claims the divisor form "breaks §4.13's
arithmetic", citing rows 3 and 6 and §4.4's worked conversion. It does not. Every `10^` in those
expressions is a **quantity** scale (`10^qty_scale`) or a **rate** scale (`10^4` for `rate_e4`), and
`10000` in row 6 is basis points. The money scale appears nowhere in §4.13's arithmetic — money is
already in minor units by the time any of it runs — and appears only in §4.13's closing note that
"conversion to a decimal string happens once, at the presentation boundary." That note is the only
consumer, and it consumes `display_decimals`. The naming conflict is real and is fixed above; the
arithmetic breakage is not.

`CLAUDE.md` §2.3 says the scale is a pack value and no code may assume 100. §7.5 explains how that
is enforced rather than merely asserted.

**Cash rounding is not in this table and not in Phase 1.** The first draft carried
`cash_rounding_unit_minor` with no posting rule, no account and no tender treatment — and §4.8's
deferred constraint trigger asserts `total_minor = Σ sale_tender.amount_minor` *exactly*, so a
cash-rounding adjustment could not have committed. A pack column with no consumer is worse than a
gap, because it reads as implemented. It is removed and recorded as a known pack gap in §7.9.

### 7.2.3 Tax codes and tax components — two things, not one

The first draft collapsed these into one table and thereby failed to define the central pack entity.
§4.5 gives `app.product` a single `tax_code_id`; §5.6.2 rule 3 says *"the pack defines n components
per tax code"*; §4.8's `sale_line_tax` carries `tax_component_id` and a `seq`; §4.13 rule 5 iterates
components *"in the pack's order"*. All four assume an entity meaning **"a standard-rated supply
attracts these components, in this order"**. It did not exist. With `GH.VAT.STD`, `GH.NHIL` and
`GH.GETFUND` as three sibling `tax_code` rows, a bag of cement could point at exactly one of them.

Three tables, using §4's and §5's vocabulary rather than inventing a third:

```sql
-- A CHARGE. VAT, NHIL, GETFund are components.
create table platform.pack_tax_component (
  pack_version_id  uuid    not null references platform.pack_version,
  component_code   text    not null,      -- 'VAT', 'NHIL', 'GETFUND', 'COVID'
  print_label      text    not null,      -- printed on the document verbatim; statutory wording
  component_kind   text    not null       -- what kind of charge it is
                   check (component_kind in ('output_tax','levy')),
  is_recoverable   boolean not null,      -- input-recoverable against output tax at remittance
  gl_account_role  text    not null,      -- a *role*, resolved to a real account by the CoA
                                          -- template — never an account number
  primary key (pack_version_id, component_code)
);

-- A TREATMENT. This is what app.product.tax_code_id resolves to.
create table platform.pack_tax_code (
  pack_version_id  uuid    not null references platform.pack_version,
  tax_code         text    not null,      -- 'GH.STANDARD', 'GH.ZERO', 'GH.EXEMPT'
  name             text    not null,      -- shown to whoever classifies a SKU
  supply_kind      text    not null       -- a property of the SUPPLY, not of any charge
                   check (supply_kind in ('taxable','zero_rated','exempt','out_of_scope')),
  primary key (pack_version_id, tax_code)
);

-- The ORDER is in the key, because §4.13 rule 5 and rule 6's residual allocation
-- both depend on it and the first draft had no order column anywhere.
create table platform.pack_tax_code_component (
  pack_version_id  uuid     not null,
  tax_code         text     not null,
  seq              smallint not null,
  component_code   text     not null,
  primary key (pack_version_id, tax_code, seq),
  unique (pack_version_id, tax_code, component_code),
  foreign key (pack_version_id, tax_code)       references platform.pack_tax_code,
  foreign key (pack_version_id, component_code) references platform.pack_tax_component
);
-- Applied twins: app.tax_component, app.tax_code, app.tax_code_component.
```

**Splitting `kind` into two columns fixes a second latent defect.** The first draft's single `kind`
mixed two independent axes — what sort of charge this is (`output_tax` / `levy`) and how the supply
is treated (`zero_rated` / `exempt`) — so `zero_rated` and `exempt` were modelled as *charges*,
which they are not. The distinction between them matters only for input recoverability, and that now
lives on the component where §5.6.2 rule 3 expects it, under §4's own name (`is_recoverable`, which
`sale_line_tax.is_recoverable_snapshot` snapshots).

`print_label` exists because the statutory wording on an invoice is itself a compliance
requirement, and it is not derivable from the code. `gl_account_role` is a role rather than an
account number so that a tenant who edits their chart of accounts (`ADR-0006`) does not break tax
posting; `ledger-engineer` owns that resolution through `gl_account_mapping` (§5.6.1).

`is_recoverable` is a real behavioural field, not documentation: on 1 January 2026 Ghana's NHIL
and GETFund levies reportedly became input-deductible `[UNCONFIRMED]`, which changes the VAT return,
not the receipt. A design that modelled levies as "things you add to the price" and nothing more
would have had to grow a code path to absorb that. **That claim is unconfirmed and is gate G2b.**

### 7.2.4 Rates — effective-dated, base-aware, and append-only

```sql
create extension if not exists btree_gist;

create table platform.pack_tax_rate (
  pack_tax_rate_id uuid      primary key,
  pack_version_id  uuid      not null,
  tax_code         text      not null,     -- rate is per (treatment, component), so a
  component_code   text      not null,     -- reduced-rate treatment is data, not a branch
  rate_bp          integer   not null,     -- basis points. 15% = 1500. Integer (ADR-0004).
  base_kind        text      not null      -- 'net' | 'net_plus'
                   check (base_kind in ('net','net_plus')),
  rounding_level   text      not null check (rounding_level in ('line','document')),
  rounding_mode    text      not null check (rounding_mode in ('half_up','half_even','down')),
  effective        daterange not null,     -- [from, to) — half-open, upper bound may be unbounded
  legal_reference  text      not null,     -- the instrument and the pin cite. See §7.2.9.
  foreign key (pack_version_id, tax_code, component_code)
              references platform.pack_tax_code_component (pack_version_id, tax_code, component_code),
  exclude using gist (pack_version_id with =, tax_code with =,
                      component_code with =, effective with &&)
);

-- base_includes was a bare text[] with no FK, no order, no acyclicity check and no
-- guarantee its members were even components of the same pack version. It is a child table.
create table platform.pack_tax_rate_base_include (
  pack_tax_rate_id  uuid     not null references platform.pack_tax_rate,
  seq               smallint not null,
  includes_component_code text not null,
  primary key (pack_tax_rate_id, seq),
  unique (pack_tax_rate_id, includes_component_code)
  -- plus a trigger asserting includes_component_code is a component of the SAME
  -- (pack_version_id, tax_code) as the including rate row.
);
```

Five things here are not in `ADR-0002`'s tuple, and each earns its place:

**`base_includes` as a child table with a `seq`.** Until 31 December 2025 Ghana computed VAT at 15%
on a base that *already included* the NHIL, GETFund and COVID-19 levies — a cascade producing an
effective 21.9%. From 1 January 2026 all three apply to the same base, giving 15 + 2.5 + 2.5 = 20%
`[UNCONFIRMED]`. **No rate changed.** A `(tax_code, rate, effective_from, effective_to)` table cannot
express that transition at all, and the code that consumed it would have had to learn the cascade —
at which point the cascade is in the platform and Ghana's 2026 reform is a deployment. This is the
concrete, dated proof that base composition is pack data. It is a child table rather than an array
because §4.13 rule 5 requires an evaluation order, because a member must be constrained to be a real
component of the same treatment in the same pack version, and because `A includes B` while
`B includes A` is undefined behaviour at a counter — see the publish-time assertions below.

**`rounding_level` and `rounding_mode`.** With three charges on one base, where you round decides
whether the printed lines foot. The rule is §4.13's, not a new one: compute each
`(line, component)` amount as `base_minor * rate_bp / 10000` per §4.13 rule 5, round **once** there
under `rounding_mode`, and derive the document tax total as the **sum of the rounded line amounts** —
never by recomputing against the document base. Where a jurisdiction requires document-level rounding
instead, `rounding_level = 'document'` selects the other implementation. Both are platform code; the
pack chooses. `ADR-0004` requires rounding to be explicit at every boundary, and §4.13 is the
**register** of those boundaries — twelve of them. The pack supplies the mode and level for rows 5
(tax per line, per component) and 6 (de-grossing, multi-component residual) and constrains row 10
(discount on a tax-inclusive list). It does not own the other nine.

**`effective` as a `daterange` with an exclusion constraint.** Two overlapping rows for one
`(treatment, component)` is silent mispricing, not an error anyone notices. `daterange` +
`exclude using gist` makes it a write failure. Half-open `[from, to)` removes the off-by-one-day
argument permanently.

**`legal_reference`.** A reviewing accountant cannot confirm a number without knowing what it
claims to encode. Not optional. §7.2.9 states what may and may not be seeded into it.

**A surrogate `pack_tax_rate_id`, and its Layer-2 counterpart.** §4.8's `sale_line_tax.tax_rate_id
uuid NOT NULL` is "the effective-dated row actually used". The first draft's rate table had no id
column at all, so §4's foreign key had nothing to resolve against and the snapshot that this whole
section depends on could not be made. It exists now on both layers.

#### Coverage: gaps fail closed, loudly, and are caught before they ship

The exclusion constraint prevents *overlap*. It permits *gaps*, and a gap is a counter that cannot
sell — offline, with no server to ask. Three controls, in order of when they fire:

1. **Publish time.** A pack version cannot be published unless, for every `tax_code`, every
   component in `pack_tax_code_component` has **gap-free** `effective` coverage across the pack's
   declared validity window; and unless the `base_includes` graph is **acyclic** and every member
   resolves within the same treatment and version. Both are assertions in the publish transaction,
   not review comments.
2. **Apply time.** The apply is one transaction. A partial pack cannot reach Layer 2, and therefore
   cannot reach a device.
3. **Transaction time.** If a lookup still returns no row for a `(tax_code, component, business_date)`
   — a tenant-authored edit that opened a gap is the realistic path — the line **cannot be priced and
   the sale cannot be completed.** The till shows the SKU, the date and the missing treatment, and
   the sale is held. It never prices at zero, never falls back to "today's rate", and never guesses.
   A blocked counter is a bad afternoon; a receipt with no VAT on it is a statutory filing error and
   an unrecoverable one once the customer has walked away with it.

#### Rate rows are append-only, with a supersession chain

The first draft celebrated the exclusion constraint and then, three subsections later, wrote that
*"rates are sometimes enacted retroactively — a statute passed in March with effect from January is
normal."* Those two statements are incompatible: inserting a January-effective row while a
January-covering row exists **is** an overlap and the write fails. With no stated amendment
procedure, someone would have closed the incumbent's upper bound in place and inserted the new one —
destroying the record of what the table said when February's sales were priced, which is exactly the
evidence §7.3's audit job needs to tell a retroactive enactment from a tenant editing history. Both
would then look identical.

So the rate facts are immutable and amendment is supersession:

```sql
-- on pack_tax_rate and on app.tax_rate alike
  superseded_by     uuid,           -- the row that replaced this one
  superseded_at     timestamptz,    -- when the supersession was recorded (not when it took effect)
  superseded_reason text,           -- 'retroactive_enactment' | 'correction' | 'tenant_amendment'
  check ((superseded_by is null) = (superseded_at is null)),
  check ((superseded_at is null) or (superseded_reason is not null))
```

and the exclusion constraint becomes partial, so only **live** rows must tile without overlap:

```sql
  exclude using gist (tenant_id with =, tax_code with =, component_code with =,
                      effective with &&)
  where (superseded_at is null)
```

`rate_bp`, `base_kind`, `effective`, the base-include children and `legal_reference` are never
updated on either layer. A retroactive enactment inserts a new row and marks the incumbent
superseded. The table therefore answers both "what is the rate for 12 February 2026?" and "what did
this table say about 12 February 2026 on 12 February 2026?" — and §7.3's audit job needs both.

### 7.2.5 The tenant's applied rates

```sql
-- via app.new_tenant_table (§4.2.3): tenant_id, id, write_id, hlc, timestamps,
-- composite FK to write_log, FORCED RLS and the canonical policy come free.
select app.new_tenant_table('tax_rate', $$
  tax_code          text      not null,
  component_code    text      not null,
  rate_bp           app.bp    not null,
  base_kind         text      not null,
  rounding_level    text      not null,
  rounding_mode     text      not null,
  effective         daterange not null,
  legal_reference   text      not null,
  applied_from_pack uuid,                      -- null ⇒ tenant-authored, needs closer review
  confirmed_by      text,                      -- the professional's name (§2.8 gate)
  confirmed_at      timestamptz,
  superseded_by     uuid,
  superseded_at     timestamptz,
  superseded_reason text,
  row_hlc           app.hlc   not null         -- §3.5: mutable row ⇒ CAS token
$$);
```

**`confirmed_by` is the gate, in the schema.** Phase 1 go-live for a tenant is blocked on every
`tax_rate` row that tenant will actually use having a non-null `confirmed_by`. That converts §2.8
from a paragraph someone remembers into a query someone runs. It is not enforced as a `not null`
constraint, because rows must be insertable before they are confirmed — but the go-live check is
mechanical and `qa-engineer` owns it (§7.8).

**`row_hlc`, compare-and-set, and a declared conflict class.** §7.1 says Layer-2 rows are editable
by the Accounts role and synced to devices like any other tenant data — which makes `tax_rate` a
**mutable, device-synced row**, and §3.5 requires exactly two things of those: `row_hlc` on the row
and `base_row_hlc` on every mutation, so the server's `UPDATE … WHERE row_hlc = :base_row_hlc`
detects a concurrent edit. The first draft had neither, on the one table that determines what every
customer in the network is charged. Two Accounts users amending the same rate row from two locations
while both offline is `CLAUDE.md` §2.2's canonical hard case applied to tax.

The mutable surface is small by construction — only the supersession columns and `confirmed_by` are
ever updated — but small is not zero, and §3.6's taxonomy takes rows, not intentions:

| `conflict_class` | Severity | Resolution | Required permission | Expiry policy |
|---|---|---|---|---|
| `TAX_RATE_SUPERSEDE` | **1** | **REVIEW.** Never auto-resolves, never merges. Both proposed successor rows are shown with their `legal_reference` and `superseded_reason`. | `tax.manage` (the credit tier — the same tier §3.6.2 uses for credit limits) | `escalate_only`. At the final step the pending state hardens to the safe state: **the incumbent row stays live and unamended**, and the tenant is told in writing that a proposed amendment expired unapplied. |
| `TAX_RATE_CONFIRMATION` | 4 | Two professionals' confirmations against one row. Latest HLC after 14 days with an audit note. | `tax.manage` | `lww_after(14)` |

`escalate_only` is the right policy and `safe_default_after` is not: there is no safe automatic
answer to "which of these two people is right about the law", and the safe *state* is the status
quo, which is what hardening to the incumbent gives you.

**Every other applied table follows the same pattern** and is omitted for length: pack-specific
columns only, `new_tenant_table`, `applied_from_pack`, and `row_hlc` wherever the row is mutable.
`tax_code`, `tax_component` and `tax_code_component` are structurally mutable (a tenant may add a
treatment) and take `row_hlc`; `tax_rate_base_include` is a child of an append-only parent and does
not.

### 7.2.6 Document field requirements

```sql
create table platform.pack_document_field (
  pack_version_id uuid   not null references platform.pack_version,
  document_type   text   not null,   -- 'tax_invoice' | 'sales_receipt' | 'credit_note'
                                     --   | 'proforma' | 'debit_note'
  field_key       text   not null,   -- 'supplier_tin', 'customer_tin', 'clearance_code', ...
  requirement     text   not null    -- 'required' | 'conditional' | 'optional' | 'forbidden'
                  check (requirement in ('required','conditional','optional','forbidden')),
  condition_kind  text,              -- closed set, e.g. 'if_customer_registered',
                                     -- 'if_total_at_or_above_threshold'
  threshold_minor app.money_minor,   -- operand for the threshold conditions
  source          text   not null,   -- the instrument or prescription imposing it
  check ((requirement = 'conditional') = (condition_kind is not null)),
  check ((condition_kind = 'if_total_at_or_above_threshold') = (threshold_minor is not null)),
  primary key (pack_version_id, document_type, field_key)
);
-- Applied twin: app.document_field_requirement. It is in tenant_reference, because
-- an offline till must know what its own document has to carry.
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
create table platform.pack_statutory_report (
  pack_version_id uuid     not null references platform.pack_version,
  report_key      text     not null,   -- 'GH.VAT_RETURN'
  cadence         text     not null check (cadence in ('monthly','quarterly','annual')),
  due_rule        text     not null    -- see below: this set WILL grow
                  check (due_rule in ('day_of_following_period',
                                      'day_of_month_after_period_end',
                                      'days_after_period_end')),
  due_operand     smallint not null,   -- day-of-month, or a day count, per due_rule
  export_format   text     not null check (export_format in ('csv','xml','json')),
  column_spec     jsonb    not null,   -- ordered columns, each naming the ledger aggregate
                                       -- it draws from; the mapping is data, the aggregates
                                       -- are platform code
  primary key (pack_version_id, report_key)
);
-- Applied twin: app.statutory_report_definition. Tenant-owned, RLS-forced, in NO bucket.
```

`due_rule` was a "closed set" with one member and a separate nullable `due_day` that nothing tied to
it. A closed set of one is an enum-shaped placeholder, not a design. Three members are stated
because three are already foreseeable, `due_operand` is `not null` and its meaning is fixed by
`due_rule`, and **this set will grow at the first real second jurisdiction** — that is §7.5 case 3
working as intended, not a defect.

**The platform renders a statutory report. It never files one.** Filing is an act with legal
consequence performed by a person who is accountable for its contents. An automated submission
path is not in scope and should be argued for explicitly if anyone wants it, because it moves the
compliance boundary — it does not merely automate work on this side of it.

### 7.2.8 The payroll boundary — declared, not configured

```sql
create table platform.pack_payroll_figure (
  pack_version_id       uuid    not null references platform.pack_version,
  figure_code           text    not null,   -- 'GH.PAYE', 'GH.SSNIT_EE', 'GH.SSNIT_ER'
  display_label         text    not null,   -- what the import screen calls the field
  is_employer_cost      boolean not null,   -- §4.11's columns, and the reason they exist:
  is_employee_deduction boolean not null,   -- §5.6.2 rule 9 posts WITHOUT knowing what SSNIT is
  gl_account_role       text    not null,   -- the payable role; the expense role for an
  expense_account_role  text,               -- employer cost, null otherwise
  filing_authority      text    not null,   -- 'GRA', 'SSNIT' — named for the UI and the
                                            -- export header. Named, never called.
  check (is_employer_cost <> is_employee_deduction),
  check ((expense_account_role is not null) = is_employer_cost),
  primary key (pack_version_id, figure_code)
);

create table platform.pack_payroll_boundary (
  pack_version_id         uuid   primary key references platform.pack_version,
  register_export_columns text[] not null   -- what the platform sends OUT to the bureau
);
-- Applied twins: app.payroll_figure_definition (server-only), and the boundary row.
--
-- There is deliberately NO rate, bracket, threshold, band, relief, multiplier, factor
-- or formula column in either table, and no such column anywhere else in the payroll
-- schema. Adding one is a violation of CLAUDE.md §2.4, not a schema change. See §7.6.
```

**`is_employer_cost` and `is_employee_deduction` are the whole point of this table, and the first
draft did not have them.** It gave the pack a `text[]` of labels — `'PAYE'`, `'Employee SSNIT'`,
`'Employer SSNIT'` — and keyed the deduction row on the free-text label. §5.6.2 rule 9 must debit
`STAFF_COST_EMPLOYER_SOCIAL` *and* credit `EMPLOYER_SOCIAL_PAYABLE` for the employer contribution,
and merely credit `EMPLOYEE_SOCIAL_PAYABLE` for the employee one. From the string `'Employer SSNIT'`
the only way to tell those apart is `if (label.startsWith('Employer'))`, which is
`if (country === 'GH')` with extra steps, in the payroll schema, in the section that forbids it.
§4.11 had already solved this correctly and this section regressed it. It now matches §4.11 exactly,
and `figure_code` is the pack-defined code §4.11 says it is.

The pack declares *what the platform may not compute* and gives the UI enough vocabulary to label
the fields a human fills in, and the GL enough structure to post them without knowing what any of
them is. It contains labels, codes, two booleans and two account roles. It contains no arithmetic.

### 7.2.9 What may be seeded into a pack, and what must be marked

Three `[UNCONFIRMED]` leaks in the first draft, all in places people copy:

- **A DDL comment must not assert an unconfirmed statutory fact as bare fact.** The old
  `-- Ghana 2026: NHIL and GETFund became true` reads as settled and travels straight into a
  migration. Rule: any statutory claim in a comment carries the marker inline, or is not in the
  comment.
- **`legal_reference` is never seeded with an unverified pin cite.** The old draft seeded
  `'Value Added Tax Act, 2025 (Act 1151), s.3'`; the section number was never sourced. The column's
  entire justification is that a reviewer needs to check the citation, so a wrong-looking-plausible
  cite is the specific hazard the column creates. Seed the instrument, mark the pin cite as absent
  (`Act 1151, section [TO BE CONFIRMED — G2b]`), and let the practitioner supply it. A blank the
  reviewer must fill is safe; a plausible cite the reviewer skims past is not.
- **Load-bearing arguments carry their own markers.** §7.5's strongest argument rests on the
  1 January 2026 base change, which is `[UNCONFIRMED]` everywhere else in this section and was
  asserted flatly there. It is marked. If G2b returns saying the change did not happen as described,
  §7.5's dated argument goes with it — the portability argument and the smoke pack survive
  regardless, which is worth knowing in advance.

### 7.2.10 Publishing pack N+1, and how a rate change actually reaches a till

§7.1 says a platform publish never overwrites a tenant. That is correct and it is only half a
mechanism. The other half — what happens when nobody applies the proposal — was missing, and it is
the *common* case, not the exotic one.

Concretely: Ghana amends the rate effective 1 January. The platform publishes on 20 December. The
Accounts user is on leave over the holiday. On 1 January every till in that tenant charges the old
rate and issues documents that are not compliant, and the only detector is an audit job that flags
after the fact. The first draft presented non-imposition purely as a feature — *"a tenant in dispute
is not overwritten by a deployment"* — and never priced the default.

**The proposal is a review-queue item with a deadline derived from the law, not from a preference.**

- **Class:** `PACK_VERSION_PROPOSED`, a `conflict_class` row per §3.6.2. **Severity 1.** Permission
  `tax.manage`. Expiry policy `escalate_only`.
- **Deadline:** `min(lower(effective))` across every changed rate row in the proposal, minus one
  day. Derived, never typed.
- **Escalation:** from D−14, a **hard, non-dismissable banner** on every Accounts and tenant-admin
  surface, naming the date and what changes. At D−7 it escalates to tenant admin. At D−1, and every
  day after until applied, it escalates to **the platform operator**, who contacts the tenant. This
  is the one escalation step that leaves the tenant, and it is justified because an unapplied
  statutory change is a compliance exposure we can see and they cannot.
- **What the POS does in the window, stated explicitly:** it prices against **the tenant's current
  applied rows, unchanged**. It does not pre-apply, does not blend, and does not refuse to sell. A
  banner appears on the till from the effective date onward stating that a statutory change is
  pending application and naming who can apply it. **Trading continues.** Refusing to sell would
  convert a paperwork problem into a revenue problem, and a distributor's counter that stops on
  1 January because head office is on leave is a worse outcome than a flagged document.
- **What the audit job does:** every document priced on or after the effective date while a proposal
  is unapplied is flagged in the same pass as §7.3's divergence categories, under its own cause
  (`unapplied_pack_proposal`) — which is a *known* cause with a *known* remedy, unlike the others.

**Applying is per-row, not all-or-nothing.** An Accounts user may accept the whole proposal or
accept it row by row, and a rejected row records a reason. A tenant genuinely in dispute with the
revenue authority declines the rows in dispute and applies the rest, and the queue item stays open
against the declined rows with the reason attached. That is the case §7.1's design exists for, and
it is now expressible rather than merely gestured at.

---

## 7.3 Repricing: the tax point, the lookup, and the two rules that override it

### 7.3.1 The tax point is `business_date`, and nothing else

The first draft parameterised this and three sections then used three different names for it: §7.3
said "the transaction date", §5.6.2 rule 1 said `document_date`, §3.4.2 ruled — authoritatively —
that the VAT tax point is **`business_date`**, human-asserted from the open cash session, and listed
`device_wall_at` as *"never used for … tax point"*. A tablet that opens a session on 31 December and
syncs on 3 January has three candidate dates and two different tax totals across the 1 January base
change. This section owns the definition and left it as a `$3`.

> **The tax point is `sale.business_date`, sourced from `app.cash_session` per §3.4.2 and §4.8a.**
> `document_date`, `occurred_at`, `device_wall_at`, `server_received_at`, `hlc`, `claimed_hlc` and
> `current_date` are **never** the tax point. A device holds no authority over it: `business_date`
> comes from a session a named human opened, bounded to one calendar day, validated against server
> time when online, and refused into a closed period.

That is what makes effective-dated rates work offline at all. A sale made on 30 June and synced on
3 July has `business_date = 2026-06-30` and prices against June's rates — which is the correct
commercial *and* statutory answer, not a convenient one.

### 7.3.2 The lookup rule

```sql
-- $1 tenant, $2 tax_code (the TREATMENT the SKU carries), $3 sale.business_date.
-- Never current_date. Never document_date. Never server_received_at.
select c.seq,
       r.id            as tax_rate_id,
       c.component_code,
       r.rate_bp, r.base_kind, r.rounding_level, r.rounding_mode
from   app.tax_code_component c
join   app.tax_rate r
       on  r.tenant_id      = c.tenant_id          -- repeated deliberately, per §3.2.3 rule 2
       and r.tax_code       = c.tax_code
       and r.component_code = c.component_code
where  c.tenant_id = $1
  and  c.tax_code  = $2
  and  r.effective @> $3::date
  and  r.superseded_at is null                     -- the version currently in force
order  by c.seq;                                   -- the pack's order. §4.13 rule 5 depends on it.
```

`current_date` must not appear in any pricing path. `money-test-engineer` treats its presence there
as a failing test, not a review comment (§7.8).

**The base is net of discount.** §4.13 rule 5 says `base_c = net_after_discount + Σ(tax_j : j ∈
base_includes_c)` and §5.6.2 rule 1b makes the ruling gross-revenue-plus-a-`SALES_DISCOUNT`-contra.
Those two are not in tension and the distinction is load-bearing: **the revenue figure is gross of
discount and the tax base is net of it.** Stated here because the first draft documented
`taxable_base_minor` as "the base after `base_includes` was resolved" and left the discount to be
inferred. On a tax-inclusive price list the order is §4.13 row 10's: discount the gross, then
de-gross.

### 7.3.3 First override — a reprint reads the snapshot

**Tax lines are computed once, at the moment the document is finalised, and persisted** in
**`app.sale_line_tax`** (§4.8). This section does **not** define that table; §4 does, and §4's
version is strictly better than the one drafted here — it carries `seq` (so component order
survives), `base_kind`, `base_includes`, `rounding_level`, `rounding_mode`, `is_recoverable_snapshot`
and the denormalised `location_id` the sync bucket needs, and it keys on
`(tenant_id, sale_id, line_no, seq)` to match `sale_line`. The competing `sale_tax_line` defined in
the first draft is **deleted**.

What §7 contributes to it is the pack side of the snapshot, and one column change:

| Column | Contributed by | Note |
|---|---|---|
| `tax_component_id` | §7.2.3 | the applied component, not a free-text code |
| `rate_bp`, `base_kind`, `base_includes`, `rounding_level`, `rounding_mode` | §7.2.4 | the full basis, not just the rate |
| `is_recoverable_snapshot` | §7.2.3 | drives the VAT return years later |
| `tax_rate_id` | §7.2.4/§7.2.5 | **a foreign key**, composite on `tenant_id` |
| `print_label` | §7.2.3 | **added by §7.** The statutory wording as it was printed. Not derivable later, and a reprint must reproduce the paper. |

**`rate_source jsonb` is deleted in favour of `tax_rate_id`.** An unstructured blob cannot be joined
by the audit job at scale, cannot be constrained, and lets a tax line reference a rate row that no
longer exists — in the one table whose entire purpose is to make that reference permanent. The
`legal_reference` and effective range it was carrying are reachable by the join, and because rate
rows are now append-only (§7.2.4) the join target cannot disappear.

**A reprinted receipt reproduces the original tax lines exactly because it reads these rows. It
does not re-run §7.3.2.** Three reasons, and they are the right three:

- **Rates are sometimes enacted retroactively.** A statute passed in March with effect from
  January is normal. When that row is inserted, the correct behaviour for a receipt already handed
  to a customer in February is to *stay the same* — and for the discrepancy to be *surfaced*, not
  silently absorbed. If reprints recomputed, the document would change under the customer's copy.
- **A tenant may legitimately edit their own rows.** Accounts-role users can. A typo corrected on
  Tuesday must not restate Monday's receipts.
- **Devices go offline for days** (§2.2). A tablet holding last week's synced `tax_rate` rows
  prices a sale on the rates it holds. That is the *correct* commercial outcome — the customer was
  charged what the receipt says — and it is *also* possibly a compliance discrepancy.

### 7.3.4 Second override — a relieving document inherits the original's tax lines

This is a separate rule, not a corollary of the first, and its absence was a money-drift with no
detector.

> **A document that relieves another document inherits that document's tax lines.**

Concretely: an invoice is issued on 20 December 2025 under the cascade (effective 21.9%). The goods
come back on 10 January 2026. The credit note is a transaction with `business_date = 2026-01-10`, so
§7.3.2 alone would price it at 20%. §5.6.2 rule 10 then reverses `OUTPUT_TAX_{c}` by amounts that
were never charged: the output-tax liability accounts carry a permanent residue, the VAT return is
wrong in both periods, and the customer's credit note does not agree with their invoice. Neither
document fails §7.3.5's job, because it checks each against the table *as of its own date* and both
are individually correct.

The rule, stated fully:

- **Which documents.** Credit note, sales return, price adjustment against an issued invoice,
  post-issue discount, and any Phase 2 goods-received-note reversal. Anything carrying a reference
  to an original document that has already posted output or input tax.
- **What is inherited.** For each relieved line: `tax_rate_id`, `tax_component_id`, `seq`, `rate_bp`,
  `base_kind`, `base_includes`, `rounding_level`, `rounding_mode`, `is_recoverable_snapshot` and
  `print_label` — copied from the original's `sale_line_tax` rows, never looked up.
- **What is recomputed.** Only the amounts, and only for a partial relief: `base_minor` pro-rata on
  the relieved quantity or value, `tax_minor` derived from it under the *inherited* mode and level,
  with largest-remainder allocation across components so that a complete set of partial reliefs sums
  **exactly** to the original's per-component tax. A full reversal copies the amounts; it does not
  recompute them.
- **What is constrained.** `Σ relieved tax per (original line, component) ≤ original tax`, asserted
  by the same deferred constraint trigger family as §4.8's document identities.
- **Where this was already ruled.** §5.14.6 finding 23 says the same thing from the ledger side —
  a return *"re-prices tax against the original sale's `tax_rate_id`, never the return's
  `document_date`"*. §7 is the section that owns the rule and did not state it. It does now, and the
  two sections agree.

### 7.3.5 The audit job — what the effective-dated table is actually for

The effective-dated table's job is **audit, not print**. A scheduled recompute job walks finalised
documents, re-derives each tax line from the table, and compares against the stored snapshot.
Divergence goes to the **human review queue** (§3.6.2) with both figures and the legal references.
**It flags. It never mutates a posted document.** That is asserted by test (§7.8), not by intent.

Three properties the first draft did not state and needed to:

**It is tenant-scoped, per tenant, one tenant at a time.** It runs inside a transaction with the
`app.tenant_id` GUC set to that tenant, under §4.2.5's RLS, as a `SERVER`-origin write per §3.11.7
with a deterministic `write_id` so a re-run is a no-op. It never opens a cursor across tenants. This
is a `CLAUDE.md` §2.7 category-3 read path and it gets the isolation test every other read path gets.

**It resolves twice.** For each document it resolves the rate set (a) **as of the version chain in
force at the sale's `business_date` when the sale happened**, and (b) **as of today**, and reports
both. That is what §7.2.4's supersession chain exists to make possible, and it is what distinguishes
the four causes below from each other rather than lumping three of them together.

**The stale-device detector is the snapshot, not a timestamp.** The first draft attributed it to
"sync logical timestamp". §3.4.1 rules that the client HLC is stored as `claimed_hlc` and is
**untrusted — display and forensics only** — and that the authoritative HLC is server-stamped *at
ingest*, recording when the write arrived, not what the device held. Neither value can tell you which
`tax_rate` version the tablet had. **`sale_line_tax.tax_rate_id` can, exactly**: it names the row.
Using `claimed_hlc` for a compliance determination is precisely the trust inversion §3 spent its
longest passage closing.

| Divergence cause | Detection | Resolution |
|---|---|---|
| Retroactive rate enactment | Job resolution (a) ≠ (b), and the row used was live at `business_date` and superseded later with `superseded_reason = 'retroactive_enactment'` | Accountant decides: credit note, voluntary disclosure, or no action |
| Device priced on a stale synced rate | `sale_line_tax.tax_rate_id` names a row that was **already superseded** at the sale's `business_date`. `claimed_hlc` and `clock_skew_ms` are attached as corroborating forensics only, and are labelled untrusted where shown. | Same, plus a sync-lag review if it recurs |
| Tenant edited a historical row | A live row exists covering `business_date` with `superseded_reason = 'tenant_amendment'` in its chain | Usually a data error; **the snapshot is authoritative** |
| Unapplied pack proposal | An open `PACK_VERSION_PROPOSED` item whose deadline has passed (§7.2.10) | Apply, then decide on the documents priced in the window |
| Platform bug | Snapshot and both resolutions name the same row, and the amounts still differ | Defect |

Silently repricing history is the failure mode this design exists to prevent. Flagging it is the
feature.

---

## 7.4 The Ghana pack

> **Every figure in this subsection is `[UNCONFIRMED]`** and requires the reviewing accountant's
> written confirmation before Phase 1 go-live (§7.7, gates G2a–G2e). I am not a tax adviser; I am
> specifying the mechanism and naming what a professional must confirm.

### 7.4.1 Components and the standard treatment, current regime

Sourced from the Ghana Revenue Authority's published VAT rates page and its notice to VAT-registered
taxpayers, both read 2026-08-20, and attributed there to the **Value Added Tax Act, 2025 (Act 1151)**,
effective **1 January 2026** `[UNCONFIRMED]`.

Treatment `GH.STANDARD`, `supply_kind = 'taxable'`, components in `seq` order:

| `seq` | `component_code` | `component_kind` | Rate | `base_kind` | `is_recoverable` | Effective from | `[status]` |
|---|---|---|---|---|---|---|---|
| 1 | `NHIL` | `levy` | 2.5% (`rate_bp` 250) | `net` | **true** | 2026-01-01 | `[UNCONFIRMED]` |
| 2 | `GETFUND` | `levy` | 2.5% (`rate_bp` 250) | `net` | **true** | 2026-01-01 | `[UNCONFIRMED]` |
| 3 | `VAT` | `output_tax` | 15% (`rate_bp` 1500) | `net` | **true** | 2026-01-01 | `[UNCONFIRMED]` |

All three on the same base ⇒ **effective 20% of net** `[UNCONFIRMED]`.

**`VAT` is `is_recoverable = true`, explicitly.** The first draft showed an em-dash on this row,
which reads as "not applicable" on the one line the accountant most needs to confirm — the input
recoverability of standard-rated VAT is the base case the entire VAT return turns on. It is
`[UNCONFIRMED]` like everything else here and it is stated.

Levies are sequenced before VAT because under the prior regime VAT's base included them, and keeping
one order across both regimes means the transition is a rate-row change and not a resequencing.

Other treatments the pack ships: `GH.ZERO` (`supply_kind = 'zero_rated'`, components at 0 bp, still
recoverable) and `GH.EXEMPT` (`supply_kind = 'exempt'`, no components, **not** recoverable). The
difference between the two matters only for input recoverability, and §7.9 records that the input
*apportionment* that a partly-exempt trader needs does not exist anywhere in this design.

The **COVID-19 Health Recovery Levy** (Act 1068) is reported repealed with effect from the same
date `[UNCONFIRMED]`. In the pack it is not deleted — it is a `COVID` component whose rate rows'
`effective` ranges close at `2026-01-01`, because deleting it would make pre-2026 documents
unauditable.

### 7.4.2 Prior regime — and why it must exist

Treatment `GH.STANDARD`, effective to 2026-01-01:

| `seq` | `component_code` | Rate | `base_kind` / `base_includes` | `[status]` |
|---|---|---|---|---|
| 1 | `NHIL` | 2.5% | `net` | `[UNCONFIRMED]` |
| 2 | `GETFUND` | 2.5% | `net` | `[UNCONFIRMED]` |
| 3 | `COVID` | 1% | `net` | `[UNCONFIRMED]` |
| 4 | `VAT` | 15% | `net_plus` {`NHIL`, `GETFUND`, `COVID`} | `[UNCONFIRMED]` |

Cascade ⇒ 6% levies + 15% × 1.06 = 15.9% ⇒ **effective 21.9%** `[UNCONFIRMED]`.

**Tenant #1 does not need these rows.** Agyasei launches 1 August 2026, so it has no Ghanaian sales
under the prior regime. They are here because *the product* needs them: the second Ghanaian tenant
will be an existing business with history, credit notes against pre-2026 invoices (§7.3.4), and
opening balances (Q20). The exact commencement dates of the prior-regime rows are `[UNCONFIRMED]`
and should be confirmed **when a tenant that needs them onboards**, not now — a good example of a
confirmation that can be deferred without blocking anything, and the gate list should not be padded
with it.

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
value · **each of `VAT`, `NHIL`, `GETFUND` shown separately with its rate and amount** ·
document totals · currency.

*GRA-returned, and this is the part that matters:* clearance/SDC code · validation timestamp ·
invoice hash · QR code · digital signature/stamp. Retention reportedly six years `[UNCONFIRMED]`.

Every one of these is in the **applied** `document_field_requirement` table and therefore on the
tablet, per §7.1.1. A till that cannot reach a server still knows what its document must carry — it
simply cannot obtain the five GRA-returned fields, which is §7.4.4's problem and not a data one.

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
   invoice is issued. **Delivery of the cleared invoice is an unbuilt capability, not a detail.**
   Printing on collection works only for customers who come back. Anything else — SMS, WhatsApp,
   email — is a messaging channel with a provider, a per-message cost, a consent model, a delivery
   failure path and a phone number this system does not currently require a walk-in customer to
   give. None of that appears anywhere in the architecture. If this resolution is chosen, that
   capability is scoped and costed as part of it, and it lands on `frontend-engineer` and
   `devops-engineer`, not on a footnote here. This is the honest model and it has a real
   customer-experience cost at a builder's merchant counter.
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
  practitioner** — G2a, G2b, G2c, G2e:
  - registration status and registration date (G2a);
  - the component set, rates, base composition, input recoverability of each component and the
    rounding level in §7.2.4 as encoded, **and the pin cite for each** (G2b);
  - the invoice and receipt field list, and whether any identifier is *prohibited* on a consumer
    receipt — the `'forbidden'` level exists and nobody has confirmed whether Ghana uses it (G2c);
  - **is the credit facility fee a taxable supply, and if so under which treatment?** (G2e —
    `open-questions.md` Q18, raised by §6.11 and attributed to this section, and which the first
    draft did not actually ask);
  - the GL treatment of output tax and of the levies, and whether Ghana imposes **supply-side
    withholding tax** on payments to this tenant by institutional or government customers — see
    §7.9, this is a receivable and a document field, not payroll.

  Give them §7.4.1–§7.4.3 to mark up. Ask for the answer **in writing, with the instrument cited**,
  so `legal_reference` and `confirmed_by` can be populated.
- **The GRA directly, via the practitioner** — G2d: the Certified Invoicing System onboarding
  process and timeline; the offline provision and its permitted window; whether software changes
  require pre-approval and what that process is. Ask this **first**; it has the longest lead time.
- **Ghanaian counsel** — G7: data residency (`open-questions.md` Q13). Not a tax question and not
  the practitioner's; it is the single input that could invalidate `ADR-0003`'s hosting decision
  outright, it blocks Phase 1 go-live, and `open-questions.md` names `compliance-gatekeeper` as its
  owner. It belongs on this list and was missing from it.

---

## 7.5 Why there is no `if (country === 'GH')`, and what to do when tempted

The usual argument for the rule is portability — you would have to find every branch when Nigeria
arrives. That argument is true and it is not the strongest one.

**The strongest one is dated.** Any engineer writing this platform in 2025 would have written the
Ghana cascade — VAT on a base that includes the levies — as Ghanaian behaviour, because it *was*
Ghanaian behaviour, uncontroversially, for years. On 1 January 2026 it stopped being true
`[UNCONFIRMED]`. The branch would have been wrong **within a single jurisdiction**, with no second
country involved at all. Jurisdiction is not a place. It is a place *and a date*, and only the second
axis is the one that moves under you.

*(The marker matters: this argument's force depends on the base change having happened as described,
which is gate G2b. If G2b comes back otherwise, the portability argument and the smoke pack below
still carry the rule on their own.)*

### The decision procedure

When you find yourself wanting the branch, the behaviour that differs is one of four things. Work
down the list; stop at the first that fits.

1. **A value.** → A column on a pack table. (Rate. Minor-unit divisor. Retention period.)
2. **A list.** → A child table. (Components. Required invoice fields. Report columns.)
3. **A rule from a closed set the platform implements.** → An enumerated strategy column whose
   values are all implemented generically, and which every pack may use. (`base_kind`,
   `rounding_level`, `rounding_mode`, `due_rule`, `condition_kind`, `supply_kind`.) **This is where
   most real cases land, and it is the one people skip.** Adding a value to a closed set is a
   reviewable, testable platform change; adding a country test is not.
4. **Genuinely new platform capability.** → The platform gains a capability, declared by a pack
   flag and implemented once. Clearance-based e-invoicing (§7.4.4) is this case: it is not a Ghana
   feature, it is a *capability* that Ghana, Kenya, Rwanda and a dozen Latin American regimes all
   require in variants.

**If it fits none of the four, stop and write it down.** That is a platform capability gap, and it
escalates to `software-engineer` and `compliance-gatekeeper`. It is never resolved by branching
"just for now", because "just for now" is how a jurisdiction becomes load-bearing in code that
nobody remembers to look at when the law changes. §7.9 is where the ones found so far are written
down, per this instruction.

### Enforcement, structurally

`CLAUDE.md` §2.1 requires tenant isolation be enforced structurally rather than by convention. The
same standard applies here, and asserting the rule in a document is not enforcement.

**The rule is a type rule, not a string denylist.** The first draft's primary control was a lint
rejecting the literals `'GH'`, `'GHS'`, `'Ghana'`, `'GH₵'` and `100` as a divisor. That is a
denylist of *tenant #1's* jurisdiction, and it therefore legalises the branch for jurisdiction #2:
when Nigeria's pack arrives, `'NG'`, `'NGN'`, `'₦'` and `/ 100` for a two-decimal naira are all
permitted — which is the exact case the rule exists to prevent. `10 ** money_scale` slips past it
too. Inverted:

- **No jurisdiction-, currency- or tax-bearing value is ever compared against a literal, anywhere
  outside `packs/`, migrations and tests.** Enforced by *type*: `JurisdictionCode`, `CurrencyCode`,
  `TaxCodeRef` and `TaxComponentRef` are branded (nominal) types with no equality against a string
  literal and no implicit widening. Comparing two of them is legal; comparing one to `'GH'` does not
  typecheck. Unbranding is a single named function that exists in the pack loader and the display
  formatter and is import-restricted to those two modules by an ESLint boundary rule.
- **Money division goes through the pack.** `MoneyMinor` is a branded `bigint` with no division
  operator exposed. The only path from minor units to a displayable decimal is a formatter that
  takes the tenant's `currency_setting` row. There is no expression in which a numeric literal can
  be the divisor of a money value, so `/ 100` and `10 ** scale` are both unwritable rather than
  merely disallowed.
- **The literal denylist survives as a backstop**, demoted and labelled as one. It catches sloppy
  strings in log messages and comments. It is not the guarantee.

- **A second jurisdiction in CI — the "smoke pack".** A fictional jurisdiction, provisioned in the
  test suite alongside Ghana, deliberately chosen to break every lazy assumption: **1000 minor
  units** per major unit with `display_decimals = 3`, a **single** component, `base_kind = 'net'`,
  `rounding_level = 'document'`, `rounding_mode = 'half_even'`, a different invoice field set
  including one `'forbidden'` row, a `due_rule` the Ghana pack does not use, and **no clearance
  requirement**. If a code path branches on Ghana, the smoke pack fails. That is the enforcement.
  `qa-engineer` owns it; it must exist **before Phase 1 acceptance, not after.**

**The smoke-pack tenant and the isolation tenant share a fixture and do not share assertions.** The
first draft said *"then the isolation test and the jurisdiction test are the same test"* and offered
that as a virtue. It is a weakening. Phase 1 acceptance criterion 5 requires isolation *"demonstrated
at every read path"*; one fixture failing for either of two independent reasons gives one signal for
two invariants, and a change that fixes the jurisdiction failure can mask the isolation one.
Corrected: the second tenant is **provisioned once**, from the smoke pack, and is the fixture for
both — but the jurisdiction assertions and the isolation assertions are separate test cases with
separate names that fail independently.

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

### Recording is not calculating — and the test is statutory versus contractual

`CLAUDE.md` §2.4 is explicit and it matters for the GL: the employer social-security contribution
is a **company expense** and needs an account and a posting line. Posting the figure the bureau
returns is **recording**. Deriving it from a rate is **calculating**.

**The first draft's mechanical test was wrong and would have been discarded on first use.** It said:
*"does any code path multiply a rate by a pay figure? If yes, it is calculation."* Sales commission
is a tenant-set rate multiplied by a sales figure and §5.8.4 puts it explicitly on the **permitted**
side. Book depreciation (§5.6.2 rule 13) is a rate times a figure and is also permitted. A test that
returns the wrong answer on two cases everyone already knows are permitted gets discarded the first
time it is invoked, and takes the rule with it.

**The real discriminator is statutory versus contractual.**

| Question | If yes | If no |
|---|---|---|
| Is the amount fixed by legislation, or by a statutory instrument, or by a rate a revenue or social-security authority publishes? | **Statutory.** The platform may never compute it. It arrives as an amount, from a bureau import, attributable to a named source document. | Continue. |
| Is it fixed by a contract the tenant is a party to — an employment contract, a commission scheme the tenant designed, a salary advance the tenant granted, a court-ordered deduction with a figure stated in the order? | **Contractual.** The platform may compute it, and does. This is ordinary business arithmetic and it is category-1 money code under §2.7. | Stop. It is neither, and it goes to `compliance-gatekeeper` before a line is written. |

**And the boundary is a table boundary, so the test rarely has to be applied by hand.** The set of
statutory figures for a jurisdiction is exactly `payroll_figure_definition` — the applied pack rows —
and every one of them lands in `app.payroll_bureau_figure`, whose `bureau_import_id` is
**`NOT NULL`, unconditionally** (§4.11). A statutory figure cannot exist without a bureau import that
produced it, because there is nothing for it to arrive from. Commission lives on
`payroll_register_line.commission_minor` and depreciation on the fixed-asset schedule; neither is in
`payroll_bureau_figure` and neither is a `figure_code`. **The schema draws the line the prose
describes.**

`app.payroll_deduction`, defined in the first draft, is **deleted**. It duplicated
`app.payroll_bureau_figure` more weakly — keyed on a free-text `label` from a `text[]` of Ghanaian
label strings, with no `is_employer_cost` / `is_employee_deduction`, which is the regression §7.2.8
describes. §4.11's table is canonical. §7 contributes `figure_code` and the two booleans through the
pack, and nothing else.

### What the CI assertion actually guarantees, and what it does not

The name lint — *"no column in the payroll schema is named like a rate, band, bracket, threshold or
percentage"* — is a **backstop, not the guarantee**, and the first draft over-claimed it. It is
defeated by `contribution_factor_e4`, by `employer_multiplier`, by a key-value `tenant_setting` row,
or by putting the number inside a `text[]`, which has no column name to lint at all. Stated honestly:

| Control | Strength | What it actually stops |
|---|---|---|
| `payroll_bureau_figure.bureau_import_id NOT NULL`, unconditional | **Structural** | A statutory figure existing without a source document. This is the guarantee. |
| `figure_code` is pack-defined, and the pack has no rate column anywhere | **Structural** | A jurisdiction pack acquiring a withholding table. There is no slot. |
| Type-level: no `payroll_bureau_figure.amount_minor` is ever the *output* of an expression | **Structural**, by a lint over the payroll module's write paths | Deriving a bureau figure server-side |
| Column-name denylist over the payroll schema | **Backstop** | Careless naming. Nothing determined. |

**The evasion the first draft left completely open: a client-side estimate.** Every structural control
above guards a *persisted row*. A "estimated net pay" panel on the PWA payslip screen multiplies a
rate by a pay figure, persists nothing, and leaves no schema trace — and it is the single most likely
request, because it is the one an employee asks for directly.

> **The prohibition is client-side too. No screen, component, worker or offline routine in the PWA
> computes, previews, projects or estimates a statutory deduction, a net pay figure, or an
> employer contribution. A payslip screen renders imported figures or renders "awaiting bureau
> figures". There is no third state.**

Recorded as a cross-section finding against §8 (client architecture) in §7.11.3, because a rule that
lives only in the compliance section is a rule the client team never reads.

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
**Status reflects `docs/open-questions.md` as at 2026-08-22, and this list sweeps Q1–Q20 in full.**
The first version swept Q1–Q8 and closed with a "not gates" paragraph that read as a completed
sweep while omitting two Phase-1-blocking items this section owns.

| # | Gate | What it blocks | Who must sign | Status |
|---|---|---|---|---|
| **G1a** | **Chart of accounts, account-type constraints, the §5.6.2 posting-rule table with a worked GH₵ example per rule, the tax `gl_account_role` resolution, and the opening-balance postings (Q20)** | **Phase 1 posting — i.e. the pilot itself** | A Ghana-qualified chartered accountant in practice (ICAG member) — **not yet named** | **OPEN, and mis-phased in the first draft.** `CLAUDE.md` §2.8 says *before a tenant's ledger goes live*; §5's header says *posting begins in Phase 1*; §5.6.2 rule 1 posts revenue, COGS and `OUTPUT_TAX_{c}` on the **first cash sale**; Q20 says opening balances are *"Phase 1 work, not Phase 3"*. Under the old single G1, Techiman would have traded from 1 Aug 2026 posting real books to an unreviewed chart of accounts. **The reviewer must be named before Phase 1 go-live.** |
| **G1b** | One full month of trial balance, P&L and balance sheet per location and consolidated against manual expectation · a completed bank and momo reconciliation with zero unexplained difference · one payroll cycle end to end · a demonstrated reversal (§5.12 items 3–6) | **Phase 3 go-live** | The G1a accountant | **OPEN** — Q6. This half genuinely cannot be done before a month of live data exists, which is why splitting the gate is not weakening it. |
| **G2a** | VAT registration status and registration date for the tenant | **Phase 1 POS go-live** | Same accountant / a GRA-registered tax practitioner | **OPEN** — Q5. `ADR-0002` decided the mechanism; this confirms the facts. |
| **G2b** | Ghana component set as encoded: rates, **base composition**, input recoverability **per component**, rounding level and mode, **and a pin cite for each row** (§7.4.1, §7.2.4, §7.2.9) | **Phase 1 POS go-live** | Same | **OPEN** — new in this section. Was one line ("the correct rate set"); the 2026 base change makes it five distinct confirmations. |
| **G2c** | Mandatory invoice/receipt field list per the Commissioner-General's prescription, **including whether any identifier is `forbidden` on a consumer receipt** (§7.4.3) | **Phase 1 POS go-live** | Same | **OPEN** — new. Not in statute; comes from a prescription that changes administratively. |
| **G2d** | **E-VAT clearance model**: Certified Invoicing System onboarding, JUAT timeline, the offline provision and its permitted window, whether software changes need pre-approval (§7.4.4) | **Phase 1 POS go-live** — and the POS **document model**, so effectively Phase 1 design | The GRA, engaged via the practitioner | **OPEN, NOT STARTED** — Q8, and the **longest lead time in Phase 1**. This is the item most likely to move the 1 Aug 2026 launch. Start now. |
| **G2e** | **Is the credit facility fee a taxable supply, and under which treatment?** The CoA template ships the fee account's tax code unset and the accrual refuses to post until it is set | **Phase 1 credit go-live** | The G3/G1a accountant | **OPEN** — **Q18**, which `open-questions.md` attributes to *"§6.11, §7.4.5"* — and §7.4.5 did not ask it. Now asked. Distinct from G3: G3 is how the fee is *structured*, G2e is how it is *taxed*. |
| **G3** | How the **2–3%/month credit facility fee** is structured — facility fee, cash/credit price differential, or something attracting lending regulation | **Phase 1 credit go-live** | The G1a accountant **and** a Ghana-qualified lawyer | **OPEN** — Q4. **Flagged, not answered.** 2–3%/month is an effective **26.8%–42.6% annually**; that arithmetic is the reason it needs a professional, and stating it is the limit of what an agent may contribute. `credit-engineer` builds the mechanism with the rate and the GL treatment configurable either way, so this gates go-live, not the build. |
| **G4** | Fleet→haulier financial consequence: the mechanism behind the **5.0% → 2.5%** distribution-cost decline (Lever 3), and the split of the **GH₵300,000** FY1 "fleet + ERP/HQ systems" capex line | **Phase 2 planning** | The G1a accountant + the founder | **OPEN** — Q1. `ADR-0001` settled the engineering question (hauliers only); the margin bridge and the capex split are unresolved and are not an engineer's call. |
| **G5** | Jurisdiction pack confirmed by a locally qualified professional | **First tenant go-live in any new jurisdiction** | A professional qualified in *that* jurisdiction | **N/A — and the smoke pack does not open it.** The CI smoke pack (§7.5) is a **test fixture for a fictional jurisdiction** and may never be applied to a production tenant; a CI assertion enforces that. G5 opens automatically the moment a real second jurisdiction is provisioned, without anyone deciding to open it. |
| **G6** | Payroll **register export and import field set** agreed with whoever will actually run payroll | **Phase 3 go-live** | The bureau, bookkeeper or accountant who will consume the export | **OPEN** — new, not previously raised. Building an export before agreeing its shape with its only consumer is how the §2.4 flow ends up bypassed in practice. Ask early; it costs one conversation. |
| **G7** | **Ghana data residency**: whether hosting a Ghanaian company's books in `eu-west` carries registration or cross-border transfer conditions under the Data Protection Act 2012 (Act 843), and what EU hosting implies for the operator | **Phase 1 go-live** | **Ghanaian counsel**, instructed by the founder | **OPEN** — **Q13**, which `open-questions.md` marks `NEEDS-HUMAN`, names **`compliance-gatekeeper`** as co-owner, and calls *"the single input that could invalidate `ADR-0003`'s hosting decision outright"*. It is a Phase-1-blocking compliance gate owned by this section's author and the first draft omitted it entirely. |

**Cross-referenced, owned elsewhere, not gates of mine:** **Q15 / `GL-Q1`** — whether the model's
revenue is VAT-inclusive or VAT-exclusive — is a tax question with a >GH₵300,000 FY1 consequence,
owned by `ledger-engineer` and the founder at §5.10.2. It should be asked in the same conversation
as G2a and G2b, and this section notes it rather than claims it.

**Not gates**, recorded so they are not escalated into one: **Q2** (receivables days) — the ERP
measures real DSO from day one and `business-data-analyst` surfaces it against the 15-day
assumption; that is monitoring, not sign-off. **Q7** (fractional quantities and dual units of sale),
**Q9** (trip-load capacity), **Q10** (cement shelf life), **Q12** (pilot dry-run window) — founder
confirmations of counter practice and operational judgement, not a professional's sign-off. **Q3**
is decided. **Q11**, **Q14**, **Q16**, **Q17**, **Q19** are owned by §5, §6, §9 and the founder and
are outside the compliance boundary.

---

## 7.8 Test obligations

`CLAUDE.md` §2.7 makes tests a condition of "done" for any function that touches money and for any
read path that could cross a tenant boundary. **This section defines the arithmetic that produces
every tax figure in the product** — base composition, evaluation order, rounding level, rounding
mode, the de-grossing residual — and it defines two read paths (the rate lookup, and the audit job
that walks finalised documents). The first draft named `money-test-engineer` and `qa-engineer` four
times between them, always as owners and never as obligations, and specified no test at all. §5 has
a full invariant table and §4 has a DDL assertion harness; §7 had neither.

Built with `money-test-engineer` (category 1) and `tenant-isolation-test-engineer` (category 3).

| Invariant | Assertion | Category |
|---|---|---|
| **Line components foot to the document total** | Property-based over generated baskets, component sets, base compositions and both `rounding_level` values: `Σ` line component amounts `=` the document tax total, and `line.tax_minor = Σ sale_line_tax.tax_minor`, exactly. The document total is never recomputed from the document net. | 1 |
| **De-grossing is exact** | Property test on §4.13 rule 6's identity: `net + Σ tax_c = gross`, **exactly**, across component sets, base compositions, residual allocations and both rounding modes. Includes the multi-component residual placement in pack order. | 1 |
| **Discount order on a tax-inclusive list** | §4.13 row 10: discount the gross, then de-gross. Asserted against the alternative order, which must produce a different and rejected result. | 1 |
| **The dated golden test** | One fixed basket priced on `business_date = 2025-12-31` and on `2026-01-01`: **21.9%** and **20%** respectively, to the pesewa, with the component breakdown shown. This is the test that fails if anyone flattens the cascade. | 1 |
| **`current_date` is unreachable from pricing** | Static assertion over the pricing and document-render modules: no `current_date`, `now()`, `Date.now()`, `document_date`, `server_received_at`, `device_wall_at` or `claimed_hlc` appears in any path that resolves a rate. The only date input is `sale.business_date`. | 1 |
| **A reprint is byte-identical** | Finalise a sale; change the rate; supersede rows; re-render the document. Assert byte-identical output including `print_label`. (§5.11's "rate history" invariant, asserted here at the document layer.) | 1 |
| **A credit note inherits** | Invoice on 2025-12-20 under the cascade; full credit note on 2026-01-10. Assert the credit note's per-component tax equals the invoice's **exactly**, and that `OUTPUT_TAX_{c}` nets to zero per component. Then the partial case: three partial returns summing to the whole must sum **exactly** to the original per component, with no residue. | 1 |
| **A gap fails closed** | Delete a tenant's rate row covering a date; attempt a sale on that date. Assert the sale cannot be completed, the message names the SKU and the treatment, and **no line prices at zero and none falls back to another date's row**. | 1 |
| **Publish-time assertions hold** | A pack with a `base_includes` cycle, a `base_includes` member from another treatment, or a coverage gap cannot be published. Three separate tests, three separate failures. | 1 |
| **The audit job flags and never mutates** | Run the job against a corpus with all five divergence causes present. Assert: the correct cause on each, one review item per divergence, and **zero writes to `sale`, `sale_line`, `sale_line_tax` or `journal_line`** — verified by row-hash comparison before and after, not by inspection. | 1 |
| **The stale-device detector uses the snapshot** | Construct a sale whose `tax_rate_id` names an already-superseded row, with `claimed_hlc` deliberately set to a value implying the opposite. Assert the job classifies it correctly from `tax_rate_id` alone, and that removing `claimed_hlc` from the corpus changes no classification. | 1 |
| **Rate CAS detects the concurrent edit** | Two offline Accounts users supersede the same `tax_rate` row against the same `base_row_hlc`. Assert one succeeds, the second raises `TAX_RATE_SUPERSEDE` at severity 1, neither is silently overwritten, and expiry hardens to the incumbent. | 2 |
| **An unapplied proposal is loud and does not stop the till** | Publish a proposal with an effective date; do not apply it. Assert the banner from D−14, the escalations at D−7 and D−1, that the POS still completes sales at the tenant's current rows, and that documents priced after the effective date are flagged `unapplied_pack_proposal`. | 2 |
| **Tenant isolation on every §7 read path** | Category 3, with a second tenant's data present and proven invisible: the rate lookup, the treatment→component resolution, the document-field lookup, the currency setting, the applied-pack listing, the confirmation-status go-live query, **and the audit job** — which is a batch path and the one most likely to be written with an unscoped cursor. Plus: a `tax_rate` insert referencing another tenant's `tax_code` must fail on the **foreign key**, not on RLS alone. | 3 |
| **Layer 1 is unreachable at transaction time** | Static assertion: no module on a pricing, document-render, posting or tenant-facing report path imports or queries anything in the `platform` schema. Plus a runtime test with the `platform` schema's grants revoked from the application role: every POS and reporting path still passes. | 1, 3 |
| **The server-only twins are in no bucket** | Assert `payroll_figure_definition` and `statutory_report_definition` appear in no sync rule, by parsing the sync-rules file — which is §3's isolation boundary and is CI-gated there. | 3 |
| **Go-live confirmation query** | Every `tax_rate` row reachable from any `product.tax_code_id` the tenant can sell has a non-null `confirmed_by`. Runs as a release gate, not only as a test. | — |
| **The smoke pack passes, separately** | The fictional-jurisdiction tenant (§7.5) exercises 1000 minor units, one component, document-level rounding, half-even, a `'forbidden'` field and an unused `due_rule`. **Its jurisdiction assertions and its isolation assertions are separate named cases** that fail independently. | 1, 3 |
| **No floats, no `number`, no literal divisors** | Extends §5.11's lint to this section: `float`/`double`/`real`/`numeric`/`money` on any column here, `number` on any money value, and any division of a `MoneyMinor` by a numeric literal, are build failures (`ADR-0004`). | 1 |
| **Payroll boundary holds** | No expression anywhere derives an `app.payroll_bureau_figure.amount_minor`. No pack table has a rate-like column. **And: no client bundle contains an expression multiplying a rate by a pay figure** — asserted over the built PWA, not the source. | 1 |

---

## 7.9 Known pack gaps

§7.5's own instruction is *"if it fits none of the four, stop and write it down."* Four cases fit
none of the four, and tenant #1 hits none of them today. They are written down here so that the
first engineer to meet one reaches for the pack rather than the conditional — and so that nobody
reads §7.2 as a claim of completeness.

| Gap | What it is | §7.5 category | Consequence if unanticipated |
|---|---|---|---|
| **Specific / per-unit duties** | A tax expressed as an amount per litre, per kilogram, per unit — not as a percentage of value. `pack_tax_rate` has `rate_bp` and nothing else. Ghana applies these to other supply classes; a dozen jurisdictions apply them to construction inputs. | **3** if anticipated: `tax_basis ∈ {'ad_valorem','specific'}`, plus `amount_per_unit_minor` and a UoM reference. | A schema migration on a live, append-only tax table, or a branch. |
| **Supply-side withholding tax** | Ghana's WHT on payments to suppliers: an institutional or government customer withholds a percentage on payment and issues a credit certificate. For a distributor selling to contractors and government agencies this is a **real receivable**, not payroll, and §7 does not mention it — no component kind, no GL account role, no document field for the certificate, no settlement path. | **4** — a platform capability: a tax that reduces cash received against an invoice already issued at full value, and creates an asset. | A cash receipt that does not match the invoice, reconciled by hand, or an unexplained AR residue per customer. **Added to G2b's ask list** and recorded for `open-questions.md`. |
| **Partial exemption / input apportionment** | `supply_kind` distinguishes `zero_rated` from `exempt`, and that distinction matters *only* for input recoverability — yet no input apportionment exists in §7 or §5. A trader making both taxable and exempt supplies must apportion input tax. | **4** — a capability, with a pack-declared apportionment method. | An over-claimed input credit, which is a filing error. Tenant #1 is not partly exempt on current reading `[UNCONFIRMED]`. |
| **Cash rounding** | Rounding the cash tendered to a coin larger than the minor unit, as distinct from tax rounding. Removed from `pack_currency` in this revision because it had no consumer: §4.8's trigger asserts `total_minor = Σ sale_tender.amount_minor` **exactly**, and §5's chart of accounts has no `CASH_ROUNDING` role. | **4** — needs a tender-line treatment, a CoA role, and an amendment to §4.8's identity. | Either it cannot post or it cannot commit. Explicitly **out of Phase 1 scope**. |

Also out of scope by decision rather than by gap: **multi-jurisdiction tenants and FX in the ledger**
(`ADR-0007`), and **automated filing** (§7.2.7).

---

## 7.10 Concerns

Recorded rather than designed around, per instruction.

1. **`ADR-0002`'s rate tuple is under-specified, and Ghana proved it eight months ago.**
   `(tax_code, rate, effective_from, effective_to)` cannot represent the 1 January 2026 change,
   which altered the base rather than any rate `[UNCONFIRMED]`. §7.2.4 adds the treatment/component
   split, `base_kind`, an ordered `base_includes` child table, `rounding_level`, `rounding_mode` and
   a supersession chain. I am treating this as a refinement the ADR's own principle produced, but it
   should be written into the ADR rather than left in this section.

2. **`ADR-0002` predates the clearance problem and now says something that may not be
   achievable as written.** "Receipts carry the fields the Ghana Revenue Authority requires" is
   satisfiable offline only if the required fields are all locally derivable. Under a clearance
   regime some are not (§7.4.4). This is the largest unpriced risk I found in the whole compliance
   surface, and it sits at the intersection of the two constraints the project treats as
   non-negotiable — offline-first and statutory compliance. It needs a decision from **G2d**
   before the POS document model is fixed, and I would not start Phase 1 POS work without at least
   an answer on the permitted offline window. **Resolution 1 additionally requires a customer
   messaging capability that does not exist anywhere in this architecture** (§7.4.4).

3. **"Accountant confirms the Ghana pack" was one line and is really six.** Registration status,
   component set and base, invoice fields, e-invoicing model, facility-fee tax treatment, GL
   treatment — different questions, partly different owners, and wildly different lead times (days
   for the first, months for the fourth). Left as one line it gets one meeting and the slow item
   surfaces late. That is why §7.7 splits it — and the same defect was left in place for G1, which
   this revision splits into G1a and G1b for the same reason.

4. **The chart-of-accounts gate was mis-phased and I wrote it that way.** G1 said "Phase 3
   go-live" while §5 posts from the first cash sale in Phase 1 and Q20 says opening balances are
   Phase 1 work. I had the evidence in front of me — §5's own header says so — and carried the
   phase from the agent brief instead of from the sections. The general lesson for this role: **the
   phase a gate blocks is determined by when the thing it guards first runs, not by which phase the
   feature is nominally in.**

5. **Section-number drift.** `ADR-0002` cites "the §2.7 human-review gate"; in `CLAUDE.md` §2.7 is
   the testing rule and §2.8 is human review gates. The `compliance-gatekeeper` agent definition
   cites "§2.3" for the payroll prohibition, which is §2.4 in `CLAUDE.md`, and "§2.6" for the third
   test category, which is §2.7. `CLAUDE.md` outranks both (`CLAUDE.md` preamble) and this section
   follows its numbering, but the cross-references should be corrected before anyone resolves them
   the wrong way.

6. **The audit-and-flag job in §7.3.5 still has no owner.** It is the only thing that detects a
   device pricing on stale rates, a retroactive enactment, or an unapplied pack proposal, and jobs
   without an owner do not get built. It should be assigned — probably `ledger-engineer` with
   `money-test-engineer` on the assertions — during Phase 1, not deferred to Phase 3 with the rest
   of the accounting work.

7. **The pack is complete for one jurisdiction on a good reading of it, and §7.9 is the honest
   list of what that sentence excludes.** Three of the four gaps there are things a competent
   engineer under schedule pressure would resolve with a branch. Naming them is cheap insurance and
   is not a substitute for building them when a tenant needs one.

8. **I have verified nothing.** I read the GRA's published pages and several advisory summaries on
   20 August 2026 and encoded them faithfully. Reading a website is not sign-off, my knowledge of
   what changed in the last three months is incomplete, and rates and e-invoicing rules in Ghana
   have changed materially twice in the recent past. Treat every figure in §7.4 as a draft for a
   professional to correct.

---

## 7.11 Revisions from adversarial review

Reviewed 2026-08-22. **Five blocking findings, thirteen major, nine minor.** Where this subsection
and the body differ, this subsection governs.

### 7.11.1 The pattern behind the blocking findings

Four of the five came from one cause: **this section specified a pack and did not specify how a pack
is consumed.** The central `tax_code → component` mapping that §4 and §5 both assume was never
defined (B1). The applied layer existed only for rates, so an offline till held no label, no field
list and no currency (B2). The lookup rule was stated and the two rules that *override* it were
stated once between them (B3 half-present, §7.3.4 absent). And the section that owns the arithmetic
specified no test of it (B5). The corrective discipline: **for every table here, name the reader,
the read path, the date it reads on, and the test that proves it.** Where a table already exists in
§4 or §5, contribute columns to it and delete the local copy.

### 7.11.2 Mechanisms added

| Mechanism | Purpose | Where |
|---|---|---|
| `pack_tax_code` (treatment) + `pack_tax_code_component` (ordered) + `pack_tax_component` (charge) | the entity §4.5, §4.8, §4.13 and §5.6.2 all assume and §7 never defined | §7.2.3 |
| Layer-2 twin for **every** Layer-1 table, with the bucket named | an offline till can print a compliant document; a publish cannot change tenant behaviour | §7.1.1 |
| `pack_tax_rate_id` / `app.tax_rate.id` | §4's `sale_line_tax.tax_rate_id uuid NOT NULL` had no referent | §7.2.4 |
| Append-only rates + `superseded_by`/`_at`/`_reason`, partial exclusion constraint | a retroactive enactment is insertable, and history is not destroyed by the amendment | §7.2.4 |
| `pack_tax_rate_base_include` child table, publish-time acyclicity + coverage assertions, fail-closed at the till | `base_includes` had no FK, no order, no cycle check and no coverage guarantee | §7.2.4 |
| `row_hlc` + CAS + `TAX_RATE_SUPERSEDE` conflict class (sev 1, `escalate_only`) | §3.5/§3.6.2 machinery on the one mutable synced row that prices the network | §7.2.5 |
| `PACK_VERSION_PROPOSED` class, law-derived deadline, D−14/D−7/D−1 escalation, stated POS behaviour | the default case — nobody applies the proposal — was unpriced | §7.2.10 |
| Tax point ruled to `business_date`, named in prose and in SQL | three sections used three names for one thing | §7.3.1 |
| **Relieving documents inherit tax lines** | a credit note repriced at the new rate; no detector existed | §7.3.4 |
| Audit job: tenant-scoped, resolves twice, detects via `tax_rate_id` not `claimed_hlc` | a compliance determination rested on an untrusted value | §7.3.5 |
| `payroll_figure_definition` with `is_employer_cost` / `is_employee_deduction`; `payroll_deduction` deleted | §5.6.2 rule 9 posts without `label.startsWith('Employer')` | §7.2.8, §7.6 |
| Statutory-vs-contractual test replacing "rate × pay figure" | the old test misclassified commission and depreciation, both permitted | §7.6 |
| Client-side estimate prohibition | every structural control guarded a persisted row | §7.6 |
| Branded `JurisdictionCode` / `CurrencyCode` / `MoneyMinor`; denylist demoted | the old lint legalised the branch for jurisdiction #2 | §7.5 |
| §7.8 test obligations table (20 invariants) | §2.7 categories 1 and 3, in the section where both bite hardest | §7.8 |
| §7.9 known pack gaps | §7.5's own "stop and write it down" instruction, applied to this section | §7.9 |
| G1a/G1b split; G2e (Q18); G7 (Q13); Q15 cross-reference; full Q1–Q20 sweep | a Phase-1 gate labelled Phase 3, and two Phase-1 gates omitted | §7.7 |

### 7.11.3 Cross-section findings raised here, not enacted here

Each is a change in a section this one does not own. Recorded so they are made deliberately rather
than discovered as a contradiction.

| Against | Finding | Proposed change |
|---|---|---|
| **§4.3, §4.8** | `tenant.money_scale smallint` and the document snapshot `money_scale` carry exponent semantics; the pack carries a divisor. Three names, two semantics. | `tenant.minor_units_per_major bigint` + `tenant.display_decimals smallint`, derived from `app.currency_setting`; the snapshot follows. §4.13's `10^` expressions are quantity and rate scales and are **unaffected**. |
| **§5.2.2** | `jurisdiction.minor_unit_scale` is a third name for the same value. | Resolve to the pack's pair; the formatting boundary reads `display_decimals`. |
| **§5.12** | The gate is stated as Phase 3 while §5's own header says posting begins in Phase 1 and Q20 says opening balances are Phase 1. | Split as §7.7's G1a/G1b. §5.12's items 1–2 and the tax `gl_account_role` resolution move to G1a. |
| **§5.6.2 rule 1** | "priced from the rate row in effect on `document_date`". | `business_date` (§7.3.1, §3.4.2). Rule 10 already says the right thing via §5.14.6 finding 23. |
| **§4.1** | The Platform group lists `tax_code` and `tax_rate` as platform tables; §7.1 puts the *applied* rows in `app`. | Platform holds `pack_*`; `app` holds the applied twins. §4.17.5 finding 21 already records half of this. |
| **§8 (client architecture)** | Nothing in §8 forbids a client-side statutory estimate, and every server-side control guards a persisted row. | The §7.6 prohibition is restated in §8 as a client rule, with the built-bundle assertion from §7.8. |
| **§9 / `ADR-0003`** | Q13 (data residency) is a Phase-1-blocking gate owned by `compliance-gatekeeper` and appeared in no gate list. | It is now G7. §9's C6 should reference it. |

### 7.11.4 Promoted to `docs/open-questions.md`

Four items for `product-manager` to carry into the file:

1. **Q6 — amend the blocking phase.** Currently *"Blocks: Phase 3 go-live"*. The chart of accounts,
   the posting rules and the opening-balance postings block **Phase 1 posting** (gate G1a); one
   month of statements, the reconciliation, a payroll cycle and a demonstrated reversal block
   Phase 3 (G1b). The reviewing accountant must be **named before Phase 1 go-live**, not before
   Phase 3 design. Consistent with Q20, which already says opening balances are Phase 1 work.
2. **Q13 — record that it is now gate G7 (§7.7)**, owned by `compliance-gatekeeper` + Ghanaian
   counsel, blocking Phase 1 go-live. No change to the question; it simply had no gate.
3. **Q18 — record that it is now gate G2e (§7.7)**, and that §7.4.5 now asks it. `open-questions.md`
   attributes the question to *"§6.11, §7.4.5"* and §7.4.5 did not contain it.
4. **NEW — Q21: does Ghana impose supply-side withholding tax on payments to this tenant, and must
   Phase 1 record a WHT credit receivable?** `NEEDS-HUMAN` · **Blocks:** Phase 1 credit and cash
   application · **Owner:** the G2b practitioner · **Raised by:** §7.9. Institutional and government
   customers withholding on payment and issuing a credit certificate is normal for a distributor
   selling to contractors, it is **not** payroll withholding, and nothing in §4, §5, §6 or §7 models
   it. Left unasked, it surfaces as a cash receipt that does not match its invoice and an AR residue
   per customer that reconciles by hand.

### 7.11.5 Full disposition

| # | Sev | Finding | Disposition |
|---|---|---|---|
| **B1** | Blocking | No `tax_code → component` mapping; no order column | **Accepted.** `pack_tax_code` (treatment), `pack_tax_code_component` (with `seq` in the key), `pack_tax_component` (charge). §7.2.3. *Names differ from the review's suggestion* (`pack_tax_treatment`): §4.5's `product.tax_code_id` and §5.6.2 rule 3's *"n components per tax code"* already fix "tax code" as the treatment and "component" as the charge, and matching the authoritative sections beats a better name. |
| **B2** | Blocking | Layer 2 exists only for rates; an offline till cannot print | **Accepted.** Every Layer-1 table gets a twin, in the same apply transaction, created by `app.new_tenant_table`, with the bucket named in a table. Two twins are deliberately in no bucket and that exclusion is CI-asserted. Rule stated once: *nothing in Layer 1 is ever read at transaction time.* §7.1.1. |
| **B3** | Blocking | A credit note reprices under the lookup rule | **Accepted, and it was worse than stated** — it applies to partial returns, price adjustments and Phase 2 GRN reversals too. §7.3.4 states the inheritance rule, what is copied, what is recomputed pro-rata, the largest-remainder allocation so partials sum exactly, and the `Σ relieved ≤ original` constraint. Agrees with §5.14.6 finding 23, which had already ruled it from the ledger side. |
| **B4** | Blocking | G1 mis-phased; the ledger goes live in Phase 1 | **Accepted.** Split into G1a (blocks Phase 1 posting — CoA, account-type constraints, posting rules with worked examples, tax `gl_account_role` resolution, opening balances) and G1b (blocks Phase 3). Reviewer named before **Phase 1** go-live. Q6's blocking phase promoted for amendment (§7.11.4). Recorded as a cross-section finding against §5.12. |
| **B5** | Blocking | No tests specified | **Accepted.** §7.8: 20 invariants across §2.7 categories 1, 2 and 3, including the property tests on footing and the de-grossing identity, the dated 21.9%/20% golden test, the `current_date` static assertion, isolation on every read path **including the audit job**, and a flags-never-mutates assertion verified by row hash. |
| **M1** | Major | Tax point never named; three sections, three names | **Accepted.** §7.3.1 rules it to `sale.business_date` per §3.4.2, in prose and in the SQL comment, and lists every value that is never the tax point. Cross-section finding raised against §5.6.2 rule 1. |
| **M2** | Major | Competing DDL for three tables §4/§5 own | **Accepted in full.** `sale_tax_line` deleted in favour of `app.sale_line_tax`; `payroll_deduction` deleted in favour of `app.payroll_bureau_figure`; `tax_rate` gains an `id`. Every Layer-2 table now goes through `app.new_tenant_table`, so §4.2.5's harness covers all of them — which it previously covered none of, in the section invoking §2.1's standard. |
| **M3** | Major | Payroll boundary leaks in four ways | **Accepted, all four.** (a) `payroll_figure_definition` carries `is_employer_cost` / `is_employee_deduction`, matching §4.11 — the regression is reverted. (b) The mechanical test is replaced: **statutory vs contractual**, with the table boundary as the structural version, and commission and depreciation explicitly on the permitted side. (c) The name lint is demoted to a backstop in a table that states what each control actually guarantees; `bureau_import_id NOT NULL` is named as the guarantee. (d) The client-side estimate is named and prohibited, with a built-bundle assertion in §7.8 and a cross-section finding against §8. |
| **M4** | Major | `minor_units_per_major` contradicts §4/§5 | **Accepted in part; one premise rejected.** Accepted: three names and two semantics is a real conflict, and this section must rule it. Ruling: divisor canonical for arithmetic, `display_decimals` for the formatter, consequential edits to §4.3/§4.8/§5.2.2 raised as cross-section findings (§7.11.3). **Rejected:** the claim that the divisor form breaks §4.13's arithmetic. Every `10^` in §4.13 rows 3 and 6 and §4.4 is a *quantity* or *rate* scale; money scale appears nowhere in that arithmetic and only in the presentation note. Stated in §7.2.2. |
| **M5** | Major | `tax_rate` mutable and synced with no §3 machinery | **Accepted.** `row_hlc`, CAS via `base_row_hlc`, `TAX_RATE_SUPERSEDE` at severity 1 with `tax.manage` and `escalate_only` hardening to the incumbent, plus `TAX_RATE_CONFIRMATION` at severity 4. "Row audit trail" replaced by §3's mechanism by name. §7.2.5. |
| **M6** | Major | Retroactive amendment rejected by the exclusion constraint | **Accepted.** Rate rows are append-only with `superseded_by`/`superseded_at`/`superseded_reason`; the exclusion constraint is partial on live rows; the lookup filters the chain; the audit job resolves both as-of-then and as-of-now and reports both. §7.2.4, §7.3.5. |
| **M7** | Major | Proposal flow has no schema, deadline or default | **Accepted.** §7.2.10: a `PACK_VERSION_PROPOSED` conflict class, severity 1, deadline derived from `min(lower(effective))`, non-dismissable banner from D−14, escalation to tenant admin at D−7 and to the platform operator at D−1, per-row accept/decline with a reason, and an explicit statement that the POS keeps trading on the tenant's current rows with a banner. |
| **M8** | Major | Stale-rate detection attributed to an untrusted signal | **Accepted.** The detector is `sale_line_tax.tax_rate_id` against the supersession chain. `claimed_hlc` is demoted to corroborating forensics, labelled untrusted where shown, and §7.8 has a test asserting that removing it changes no classification. |
| **M9** | Major | `cash_rounding_unit_minor` has no consumer and breaks §4.8's identity | **Accepted.** Column removed from `pack_currency`. Declared **out of Phase 1 scope** and recorded in §7.9 with its §7.5 category and the three things it would need (tender treatment, `CASH_ROUNDING` CoA role, §4.8 identity amendment). No pack column ships without a consumer. |
| **M10** | Major | The lint is a Ghana denylist and legalises jurisdiction #2 | **Accepted.** Inverted to a type rule: branded `JurisdictionCode` / `CurrencyCode` / `TaxCodeRef` / `TaxComponentRef` with no literal comparison, import-restricted unbranding, and `MoneyMinor` with no exposed division so `/ 100` and `10 ** scale` are both unwritable. The denylist survives as a labelled backstop. §7.5. |
| **M11** | Major | Gate list stale; claims a completeness it lacks | **Accepted.** G2e (Q18) and G7 (Q13) added; Q15/`GL-Q1` cross-referenced as owned elsewhere; the "not gates" paragraph replaced with an as-of date and a full Q1–Q20 sweep. Both omissions were this section's own responsibility and both block Phase 1. |
| **M12** | Major | `base_includes` has no integrity, order, acyclicity or coverage | **Accepted.** Normalised to `pack_tax_rate_base_include` with an FK, a `seq` and a same-treatment trigger; publish-time acyclicity and gap-free-coverage assertions; and an explicit, tested **fail-closed** behaviour at the till with an operator-visible message naming the SKU, the date and the treatment. §7.2.4. |
| **M13** | Major | Rates are ad-valorem only; three real shapes force a branch | **Accepted.** §7.9 "Known pack gaps" names specific/per-unit duties, supply-side withholding tax and partial exemption, each with its §7.5 category and its failure mode. WHT is additionally added to G2b's ask list and promoted as new open question **Q21**, because it is a receivable a distributor selling to government will meet in Phase 1. |
| m1 | Minor | `[UNCONFIRMED]` leaks in three copyable places | **Accepted.** §7.2.9 states the rule: no bare statutory claim in a DDL comment, no seeded pin cite (`Act 1151, section [TO BE CONFIRMED — G2b]`), and §7.5's dated argument now carries the marker with a note on what survives if G2b contradicts it. |
| m2 | Minor | "This is that boundary, named" is a singular overclaim | **Accepted.** §4.13 is cited as the register of twelve boundaries; §7 states that it supplies mode and level for rows 5 and 6 and constrains row 10, and owns none of the other nine. |
| m3 | Minor | The tax base is silent on discount | **Accepted.** §7.3.2 states that the tax base is net **after** discount per §4.13 rule 5 while revenue is gross per §5.6.2 rule 1b, and that on a tax-inclusive list the order is §4.13 row 10's. |
| m4 | Minor | G5's status contradicts §7.5 | **Accepted.** G5 now states that the smoke pack is a **test fixture for a fictional jurisdiction**, may never be applied to a production tenant (CI-asserted), and that G5 opens automatically when a real second jurisdiction is provisioned. |
| m5 | Minor | Merging the isolation and jurisdiction tests is a weakening | **Accepted.** Share the tenant fixture; keep the assertions as separate named cases that fail independently. §7.5, §7.8. |
| m6 | Minor | `rate_source jsonb` should be a foreign key | **Accepted.** Deleted in favour of `tax_rate_id`, composite on `tenant_id`, per §4.8. The blob's contents are reachable by join, and append-only rate rows mean the target cannot disappear. |
| m7 | Minor | `due_rule` is a closed set of one with an untied `due_day` | **Accepted.** Three members stated, `due_operand` is `not null` with its meaning fixed by `due_rule`, and the set is declared as one that will grow — §7.5 case 3 working as intended. |
| m8 | Minor | `input_deductible` shown as `—` on the base case | **Accepted.** §7.4.1 gives `VAT` an explicit `is_recoverable = true` with an `[UNCONFIRMED]` marker, and the column is renamed to §5's `is_recoverable`. |
| m9 | Minor | §7.4.4 resolution 1 assumes delivery infrastructure that does not exist | **Accepted.** Resolution 1 now states that cleared-invoice delivery is an unbuilt capability with a provider, a per-message cost, a consent model, a failure path and a phone number this system does not collect — scoped and costed as part of that resolution, and owned by `frontend-engineer` and `devops-engineer`. Also added to §7.10 Concern 2. |
