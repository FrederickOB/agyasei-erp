# 1. Tenancy Model and Isolation

**Implements:** `ADR-0005` (shared schema, RLS, tenant-scoped sync) · `ADR-0006` (Agyasei is a
template) · `ADR-0007` (one jurisdiction per tenant) · `CLAUDE.md` §2.1, §2.9

> **Revision note.** This section was adversarially reviewed on 2026-08-21 and revised. Seven
> blocking findings, thirteen major and eight minor were raised. Twenty-five are accepted as
> written, two are accepted with a different mechanism than the reviewer proposed because the
> proposed one could not be built (B3, M6), and one is accepted with a single sub-item rejected and
> the reason given (B4). The pattern behind the blocking findings was one thing: **this section was drafted
> before §3, §4 and §5 were revised, and it had not been re-read against them.** Its §1.3 codegen
> exemplar — the normative template every table in the system is generated from — emitted the exact
> schema §4.17 exists to eliminate, and its suspension lifecycle destroyed unsynced sales on the two
> most ordinary offline paths in the product. Corrections are inline; the full disposition is in
> **§1.12**. **Where §1.12 and the body differ, §1.12 governs.**

This section defines what a tenant *is*, how one comes into existence and leaves, and the
machinery that makes `tenant_id` structurally unforgettable rather than a thing reviewers catch.
It does **not** define the role model or the sync rules — `rbac-security-engineer` and
`sync-architect` own those, and the boundary between us is named in §1.9.

Two schemas, one bounded exception list, and the split is load-bearing:

- **`platform`** — tenant-agnostic registries only: `jurisdiction`, `permission`, `db_cluster`,
  `template_catalogue`, `pack_version` (§7). No business data, ever. Exempt from the `app` rules in
  §1.3 because there is no tenant to scope by.
- **`app`** — every tenant-owned table. No exceptions, no discretion. This now includes the
  provisioning, gate and template-provenance tables, which used to live in `platform` and are
  tenant data by any honest definition (§1.12 M8).
- **`platform` — three named exceptions.** `platform.tenant`, `platform.tenant_placement` and
  `platform.tenant_state_transition` are keyed by tenant and live in `platform` anyway, because
  they must survive the deletion of everything in `app` and must be readable before a tenant's
  `app` rows exist. They carry no business data — id, slug, legal name, state, cluster, dates — and each
  takes an individually justified entry in the checked-in exemption file (§4.2.5). Three rows in
  that file, not a schema-wide waiver.

Anything in `app` without a `tenant_id` is a bug that fails CI. Anything in `platform` is
reviewed by a human on every migration, because that is where a mistake does not fail CI.

---

## 1.1 The tenant entity

There were two definitions of `platform.tenant` in this document set — this section's and §4.3's —
differing in the jurisdiction key type, the name columns, enum-versus-text state, and whether the
row carried the currency and minor-unit scale at all. §4.1 assigns `platform.tenant` to this
section, so **this is the single definition and §4.3 cross-references it.**

```sql
create schema platform;
create schema app;

create table platform.jurisdiction (
  code    char(2) primary key,          -- ISO 3166-1 alpha-2; 'GH'
  name    text    not null,
  status  text    not null check (status in ('supported','preview','withdrawn'))
);
-- Currency and minor-unit scale are NOT here. They belong to the jurisdiction PACK version
-- (§7.2.1), because a jurisdiction can redenominate and a pack is effective-dated. Putting them
-- here would be the third copy §4.17.5 #22 rules against.

create type platform.tenant_state as enum (
  'provisioning',   -- registry row exists; no user can sign in, no device can sync
  'pilot',          -- trading for real, but the ledger cannot be locked and no statutory
                    -- output may be filed; this is where §2.8's month of statements is generated
  'active',         -- trading, ledger live
  'suspended',      -- non-payment or dispute; see §1.2
  'migrating',      -- write-frozen while being moved between clusters (§1.4)
  'offboarding',    -- devices draining, export being produced, deletion scheduled
  'offboarded',     -- tombstone; app data gone
  'abandoned'       -- provisioning never completed; deleted by the same machinery
);

create table platform.tenant (
  id                      uuid        primary key,          -- uuidv7, server-generated
  slug                    text        not null unique,       -- 'agyasei-jnr'; URLs, export filenames
  legal_name              text        not null,              -- §4.3's `name` is this column
  state                   platform.tenant_state not null default 'provisioning',
  jurisdiction_code       char(2)     not null references platform.jurisdiction (code),

  -- Derived from the applied jurisdiction pack at onboarding (§7.1 layer 2), never authored and
  -- never a third copy: the pack is the source, the tenant row is the derivation, and every
  -- document snapshots its own (§4.17.5 #22). NEVER assume 100 (CLAUDE.md §2.3, ADR-0004).
  currency_code           char(3),
  money_scale             smallint,

  write_frozen            boolean     not null default false,  -- §1.4; the migration freeze
  created_at              timestamptz not null default now(),
  piloted_at              timestamptz,
  activated_at            timestamptz,
  suspended_at            timestamptz,
  suspension_reason       text,
  offboarding_started_at  timestamptz,
  drain_deadline          timestamptz,   -- how long we wait for dark devices before exporting
  export_completed_at     timestamptz,
  deletion_completed_at   timestamptz,

  constraint tenant_trading_has_money_unit
    check (state not in ('pilot','active','suspended')
           or (currency_code is not null and money_scale is not null)),
  constraint tenant_active_has_activation
    check (state <> 'active' or activated_at is not null),
  constraint tenant_offboarding_has_drain
    check (state <> 'offboarding'
           or (offboarding_started_at is not null and drain_deadline is not null))
);

create table platform.tenant_state_transition (
  tenant_id   uuid not null references platform.tenant (id),
  changed_at  timestamptz not null default now(),
  from_state  platform.tenant_state not null,
  to_state    platform.tenant_state not null,
  actor       text not null,            -- operator identity; 'system' for automatic transitions
  reason      text not null,
  primary key (tenant_id, changed_at)
);
```

**There is no `template_id` column on the tenant row.** §4.3 proposed one. It is a live pointer
from a tenant to a template, which is precisely the handle someone eventually dereferences at
runtime — and it cannot express the truth anyway, since modules from more than one template may be
applied and at different versions. Provenance lives in `app.tenant_template_application` (§1.6),
which is the single provenance record. The column is deleted from §4.3.

`jurisdiction_code` is set at provisioning and is **not editable afterwards**. Changing it would
reprice history against a different tax table (`ADR-0002`), and a tenant that has posted a single
transaction cannot do that safely. A tenant that genuinely relocates is a new tenant plus a
migration project, and we should say so rather than pretend a dropdown handles it.

State transitions go through one function that writes `platform.tenant_state_transition` in the
same transaction as the `UPDATE`. There is no path that sets `state` directly; the history table
is the audit trail for "who suspended us and why", which is a question that gets asked under
pressure.

Legal transitions:

```
provisioning → pilot | abandoned
pilot        → active | suspended | offboarding | abandoned*
active       → suspended | migrating | offboarding
suspended    → pilot | active | offboarding
migrating    → active                       (both on success and on abort — see §1.4)
offboarding  → offboarded
abandoned    → (deleted, tombstone retained)

* pilot → abandoned is legal only while the tenant has no write_log row with origin='DEVICE'.
  Once a device has recorded a single sale, the exit is offboarding, which exports first.
```

**Why `pilot` exists.** `CLAUDE.md` §2.8 requires an accountant to review *"at least one full month
of generated statements against manual expectations"* **before the ledger goes live**. In the
previous lifecycle those statements could not exist: there was no state between `provisioning` and
`active` in which trading happens, so the gate could only be satisfied by a lie. `pilot` is a
tenant that trades for real — real sales, real receipts, real sync — while **period close and
locking are refused (§5.2.6) and no statutory output may be filed (§7)**, and every statutory
document renders with the pack's provisional marking. That makes §2.8's month of statements real
data. It also splits §2.8's gate into the two things it actually asks for, which is the honest
reading: the **structural** review (chart of accounts and double-entry logic) blocks entry to
`pilot`; the **statements** review blocks entry to `active`. See §1.8 and open question **Q-TEN-2**.

Note what is missing: nothing returns from `offboarded`, and `suspended` cannot go straight to
`provisioning`. Re-onboarding a returning customer is a new tenant id. Reusing an id after
deletion means a device holding stale local data for that id could rejoin a different company's
tenant — which is precisely the unrecoverable failure `ADR-0005` exists to prevent.

**The slug is reserved by the surviving row, and that is deliberate.** `platform.tenant` survives
offboarding as a tombstone carrying its `slug`, and `slug` is `unique` across all states. So a
slug can never be reused either — same reasoning as the id, one level up: export filenames, URLs
and support tickets all key on it, and a second `agyasei-jnr` two years later makes every archived
artefact ambiguous. The survival of the row *is* the reservation; there is no separate mechanism.

### The user↔tenant relationship

This section defines what a tenant is and had not said what a *user* is, while §3's sync-rule
parameter queries join `tenant_membership(user_id, tenant_id, status, revoked_at)` and §1.5 shows
`app.user_role(tenant_id, user_id, …)`. Whether one human identity can span two tenants is a
tenancy question with a direct isolation consequence, so it is answered here.

**Decision: user identity is tenant-owned. There is no `platform.user`.**

- `app.user_account` is an ordinary tenant-owned table: `(tenant_id, id, email, display_name,
  status, revoked_at, …)`, with email unique **per tenant**, not globally.
- §3's `tenant_membership` is the projection of `app.user_account` used by sync-rule parameter
  queries — `(tenant_id, user_id = id, status, revoked_at)` — not a second table. Named in §1.11.
- Sign-in is `slug` + email + credential. A human who works for two tenants has two accounts and
  signs in twice.
- **Platform operators are not users.** They live in `platform.operator` and reach a tenant only
  through §2.8's `platform_support_grant`, which is what sets the GUC for that session.

The reasoning is the same one that refuses to reuse a tenant id. A global identity is a permanent
cross-tenant join surface — every "which tenants can this person see" query is one forgotten
predicate away from an enumeration, and account recovery on a globally unique email is a
cross-tenant path that runs *outside* the RLS boundary, in the mail system. The cost is real and
worth naming: a consultant serving three customers has three logins, and a future group customer
that wants one sign-on across subsidiary tenants cannot have it without adding a federation layer
we have not built. That is a feature request with a known shape, not a boundary we should soften
now — the failure mode on the other side is unrecoverable and this one is annoying.

---

## 1.2 Suspension, offboarding, and data already on devices

This needs a stated answer because the obvious ones are all wrong.

**"Wipe the tablets immediately"** makes the platform the cause of data loss. A suspended tenant's
tablets are holding sales that have not uploaded yet. Those sales are the tenant's property and
their statutory records. Destroying them over a billing dispute is a worse outcome than the
dispute.

**"Leave the devices alone"** means a tenant who stops paying keeps a full copy of their books —
including every contractor's credit position — on tablets we no longer control, indefinitely.

**"Send a remote wipe command"** is the one that sounds right and isn't. A device we can reach is
a device that is online; the devices we most want to seal are the ones that never come back. A
control that requires connectivity to fire cannot be the control.

### The correction that produced this version

The first version of this subsection invented a fourth wrong answer and did not notice. It said
sealing *"discards the local encryption key"*, that a sealed device *"re-syncs from the server"*,
and that this was *"fine, because stage 2 already drained the writes"*. That sentence is true only
of devices that were **online** during the drain window, and the product exists for the ones that
were not. A Wenchi micro-outlet dark for three weeks, suspended on day 2 over a billing dispute
resolved on day 5, reconnecting on day 32, would have had twelve trading days of sales destroyed —
for a tenant that is currently active and paying. It also contradicted §2.7 outright, which rules
that on seal *"data is not wiped … the outbox survives encrypted until a successful server
authentication reopens it"*, and §3.1.7, which rules that *"a sealed device still uploads its queue
on reconnect; sealing stops new writes, it never discards old ones."*

It also invented a `not_after` field stamped into the sync token and asserted that *"the same TTL
governs how long a genuinely offline outlet can trade"*. That is false. §2.7 owns the offline
lease and it is a separate mechanism from the token TTL: `full_until` (72 h default) →
`hard_stop_at` (+24 h restricted) → sealed, tenant-configurable to a **14-day platform ceiling**,
enforced against monotonic elapsed time with a backwards-jump check because the device clock is
not trustworthy. `not_after` is deleted. There is no client-side clock owned by this section.

### The decision

**Suspension and offboarding introduce no new device mechanism at all.** They change three
server-side facts, and §2.7's existing lease decay does the rest.

**1 — No further lease is issued.** The token endpoint issues leases only for `pilot`, `active`
and `migrating`, and refuses every other state. (`migrating` keeps issuing because a cluster move
is minutes and a device that happens to refresh inside the window should not start decaying over
it; what `migrating` refuses is *writes*, retryably — see §1.4.) The device's *current* lease continues to decay exactly as §2.7 describes: full
operation to `full_until`, restricted mode to `hard_stop_at`, then sealed — read-only, in-memory
data key dropped, **local database and outbox preserved on disk**, reopened by any successful
server authentication. So a suspended tenant's outlets stop trading within the tenant's configured
lease ceiling (default 72 h + 24 h, platform maximum 14 days) with no new code, no new clock and
no new field. This replaces the invented 30-day self-seal entirely.

**2 — Downloads stop at the next connection, not at the next token refresh.** §3.2.3 already added
a *user* liveness check to every parameter query for exactly this reason, with the right argument
attached: *"this one took the JWT claim alone, so a suspended user's device kept receiving the
catalogue and price lists for the life of its offline lease. Symmetry is the control."* The
identical argument applies to the tenant and was not made, so a suspended tenant's devices kept
downloading for the life of the token. Every parameter query gains a tenant-liveness join:

```sql
  SELECT m.tenant_id
  FROM   tenant_membership m
  JOIN   app.tenant_local_state t ON t.tenant_id = m.tenant_id
  WHERE  m.user_id   = request.user_id()
    AND  m.tenant_id = (request.jwt() ->> 'tenant_id')
    AND  m.revoked_at IS NULL
    AND  m.status = 'active'
    AND  t.state IN ('pilot','active','migrating')   -- ← added; symmetry with the user check
```

`app.tenant_local_state` is defined in §1.4: one RLS-scoped row per tenant on the tenant's own
cluster, projected from `platform.tenant` by the control plane. It exists so that the sync
service, the freeze trigger and the client can all read tenant state without a cross-database
lookup. Carrying this into §3's sync-rules file is a §3 change and is named in §1.11.

**3 — Uploads are never refused for a live tenant.** The upload path accepts writes for any tenant
whose row exists and whose `app` rows have not been deleted — through `pilot`, `active`,
`suspended`, `offboarding`, right up to the deletion transaction. The single exception is
`migrating`, where the write freeze (§1.4) rejects with a **retryable** error so devices queue
rather than dead-letter, per §3.3.4's response taxonomy. There is no upload drain
deadline for suspension, because refusing an upload is the one action that can lose a sale, and a
suspended tenant's unsynced sales are exactly what we most want on the server: it is where they can
be exported back to them (§1.7).

The previous version gated the drain on *"writes whose logical timestamp precedes `suspended_at`"*.
That cannot be built. §3.4/§3.11 and §4.2.2 rule that the HLC is **server-stamped at ingest** and
the device's assertion is stored as `claimed_hlc`, *untrusted, display and forensics only*. So the
gate either reads the server-stamped HLC — which is by construction later than `suspended_at` for
everything arriving during the drain, making the drain accept nothing — or it reads `claimed_hlc`,
which trusts the exact value the ruling forbids trusting and lets a suspended tenant back-date its
clock and trade forever.

*The reviewer's suggested repair — corroborating a write's creation time against the device's
pre-suspension `device_write_watermark` — does not work either, and I am not adopting it. A write
that has not yet been applied is by construction **above** that device's `contiguous_through`; the
watermark distinguishes replays from new writes, not old writes from recent ones. The server
genuinely cannot know when an offline write was created. Say so rather than build a gate that
looks like it knows.*

So the rule is: **accept, then mark.** A write is a suspended-period write iff
`write_log.received_at > tenant_local_state.suspended_at` — server-owned on both sides, derivable
on the tenant's own cluster, nothing asserted by a client and no new column. Suspended-period writes are reported to the commercial team
and invoiced or disputed. The commercial question "do we accept trade from a non-payer" is answered
by a flag and an invoice, not by discarding a sale.

### What happens to the local copy, honestly

A suspended or departing tenant keeps a **sealed but recoverable** copy of their data on their own
tablets for as long as those tablets exist. Sealed means the §2.7 seal: unreadable without a fresh
server authentication, not deleted. We are accepting that in exchange for never being the reason a
sale vanished.

**We deliberately do not build a `device_purge_after` in Phase 1.** If commercial or legal policy
later requires eventual destruction of a non-payer's local copy, it is a separate, explicitly named
mechanism, and it must be preceded by a server-side check that the device's
`device_write_watermark.contiguous_through` (§3.11.3) covers that device's last local write — that
is, proof that nothing unsynced is being destroyed. A purge that can fire on a device that has
never drained is the failure this whole subsection exists to avoid, wearing a policy label. See
open question **Q-TEN-1**.

**Re-activation** (`suspended → active`) restores lease issuance and downloads at the device's next
connection. Nothing needs reversing, because nothing was destroyed.

### Offboarding is the same machinery plus a deadline

A departing customer is not a suspended one and must not be routed through `suspended` to get
there — the transition log would then read "suspended for non-payment" about a customer who paid
and left, and that log is read under pressure. So `active → offboarding` and `pilot → offboarding`
stay legal. What the previous version got wrong is that they stamped nothing: `drain_deadline` was
only set on suspension, so a voluntarily departing tenant's devices never sealed and their books
sat readable on 25 tablets forever, while the certificate promised a seal date that no mechanism
produced. And the upload path checked `state in ('active','suspended')`, so from the instant the
operator clicked "offboard" on a Friday, every tablet in the network was refused — the week's sales
never reached the server, the export was short by a week of revenue and the corresponding credit
entries, and then deletion ran.

Corrected, in three parts:

- **Entering `offboarding` stamps `offboarding_started_at` and `drain_deadline`**, enforced by
  `tenant_offboarding_has_drain`. Lease issuance stops at the same instant, so devices seal under
  §2.7's decay exactly as in suspension. A customer with a planned last trading day is moved to
  `offboarding` the morning after it, not before it.
- **Uploads are accepted throughout `offboarding`**, right up to the deletion transaction. Same
  reasoning as suspension: refusing an upload loses a sale.
- **The export cannot run until the devices have drained or the deadline has passed** — the
  ordering gate in §1.7, which reuses §3.11.4's attestation rather than inventing a second
  completeness mechanism.

**Open:** the lease ceiling for a suspended tenant, the offboarding drain deadline, and whether
`device_purge_after` should exist at all are commercial and legal policy dressed as engineering.
See §1.10 C3 and **Q-TEN-1**.

---

## 1.3 Making `tenant_id` structurally unforgettable

`CLAUDE.md` §2.1 requires this be structural, not conventional. Three layers, and each catches
what the one above it misses.

**Correction from review, and it is the important one in this section.** The exemplar below is
normative — every tenant-owned table in the system is generated from this declaration — and the
first version of it emitted the schema §4.17 exists to eliminate: a per-table `idempotency_key`
(the specific defect §4.2.2 names, where the `write_log` row is swallowed by `ON CONFLICT` and the
business row's composite FK then fails on a tendered, printed, cash-collected sale), no `write_id`,
no `hlc`, no `created_at/updated_at/deleted_at`, a `text` HLC that sorts lexically rather than
causally, non-partial uniques over a soft-delete schema, and a policy expression that fails §4.2.5's
own CI assertion. Because it is codegen, each of those would have been replicated across every
table in the system. It has been regenerated against §4.

### Layer 1 — tables are declared, not hand-written

There is no hand-written `CREATE TABLE` in `app`. Every tenant-owned table is declared once in a
TypeScript registry; the migration DDL, the TypeScript row type, the export set (§1.7), the import
set and the deletion set are all generated from that single declaration.

The registry does **not** emit raw DDL. It emits calls to §4.2.3's `app.new_tenant_table` helper
into a checked-in migration file, so §4 owns the row shape and this section owns the catalogue of
which tables exist and what their lifecycle is. One row shape, one helper, one registry — not a
second DDL emitter that drifts.

```ts
export const sale = tenantTable('sale', {
  columns: {
    location_id:     ref('location'),                  // composite FK, see below
    customer_id:     ref('customer').nullable(),
    cash_session_id: ref('cash_session'),              // business_date comes from here (§4.8a)
    receipt_no:      text(),
    total_minor:     money(),                          // app.money_minor — bigint, ADR-0004
    currency_code:   char(3),                          // snapshotted, §4.17.5 #22
    money_scale:     smallint(),                       // snapshotted. NEVER assume 100.
  },
  uniques: [['location_id', 'receipt_no']],            // emitted tenant-prefixed AND partial
  indexes: [['location_id', 'hlc']],
  immutable: true,                                     // a GL-posting document: §4.2.4
  lifecycle: 'carry',                                  // default; 'derived' needs reconstructedBy
  seedable: false,                                     // no template seeds sales
});
```

emits:

```sql
select app.new_tenant_table('sale', $$
  location_id      uuid            not null,
  customer_id      uuid,
  cash_session_id  uuid            not null,
  receipt_no       text            not null,
  total_minor      app.money_minor not null,
  currency_code    char(3)         not null,
  money_scale      smallint        not null,

  constraint sale_immutable check (deleted_at is null),          -- §4.2.4: documents never soft-delete
  constraint sale_location_fk foreign key (tenant_id, location_id)
    references app.location (tenant_id, id) deferrable initially immediate,
  constraint sale_customer_fk foreign key (tenant_id, customer_id)
    references app.customer (tenant_id, id) deferrable initially immediate,
  constraint sale_session_fk  foreign key (tenant_id, cash_session_id)
    references app.cash_session (tenant_id, id) deferrable initially immediate
$$);

-- Uniques: tenant-prefixed AND partial on deleted_at (§4.2.4). The emitter has no other form.
create unique index sale_receipt_uq on app.sale (tenant_id, location_id, receipt_no)
  where deleted_at is null;
create index sale_by_location on app.sale (tenant_id, location_id, hlc);
```

`app.new_tenant_table` (§4.2.3) supplies, on every table and with no way to opt out:
`LIKE app.tenant_row_base INCLUDING DEFAULTS INCLUDING CONSTRAINTS` — which is `tenant_id`, `id`,
`write_id`, `hlc`, `created_at`, `updated_at`, `deleted_at` — the `(tenant_id, id)` primary key,
the composite foreign key `(tenant_id, write_id) → app.write_log (tenant_id, id)`,
`enable`/`force row level security`, and the canonical isolation policy.

What changed from the first version, and why each matters:

| Was | Now | Why |
|---|---|---|
| `idempotency_key text` + `unique (tenant_id, idempotency_key)` | **nothing** — `write_id` from the base row, and `app.write_log.id` *is* the key | §3.3.2 / §4.2.2 / §4.17.5 #2: one write registry. A per-table key is the three-registry defect, and its `ON CONFLICT` swallow-then-FK-violate path puts a collected sale in a poison table. |
| `occurred_at text` | `hlc app.hlc` from the base row, server-stamped | §4.2.1: a `text` HLC sorts lexically, not causally, and §4.7.4 replays the movement ledger *in `hlc` order* to compute cost of goods sold. §3.11.9 rules `occurred_at` is `device_wall_at`, untrusted. |
| no `write_id`, no timestamps | the whole base row | Every generated table would have failed §4.2.5's `has_write_id` assertion, and the audit backbone would have been absent from every table in the system. |
| non-partial unique | `where deleted_at is null` | §4.2.4. A non-partial unique over a soft-delete schema means a tenant can never re-create a code they deleted. |
| `current_setting('app.tenant_id')::uuid` in the policy | `app.current_tenant()` | §4.2.5 assertion (2) requires the policy expression to be **exactly** `(tenant_id = app.current_tenant())`. Every table the old exemplar generated failed §4's own CI guard. |
| hand-written `CREATE TABLE` output | `select app.new_tenant_table(...)` | One row shape, §4's, applied by §4's helper. |

Three things in that output are doing work that no other layer does:

- **Composite primary key `(tenant_id, id)`** — required so that foreign keys can be composite.
- **Composite foreign keys `(tenant_id, location_id) → location (tenant_id, id)`** — the cheapest
  structural guarantee in the whole design. A sale physically cannot reference another tenant's
  location, because the database will not let it. It costs one extra column in each FK index and
  buys a class of bug that RLS alone does not catch: a query running under tenant A's GUC that
  inserts a row referencing tenant B's id.
- **`force row level security`** — without it the table owner is exempt, and the table owner is
  whoever ran the migration. `enable` alone is a policy that looks present and isn't.

Uniqueness is prefixed with `tenant_id` automatically, which is how `CLAUDE.md`'s
"idempotency-key uniqueness is scoped per tenant, never global" stops being something a developer
has to remember. There is no declaration form that produces a global unique index; the emitter has
no code path that does that.

**One reconciliation to propose back to §4.** §4.2.5's `app.current_tenant()` uses the permissive
form, `nullif(current_setting('app.tenant_id', true), '')::uuid`, and describes returning zero rows
as failing closed. Zero rows is not closed, it is *quiet*: it looks exactly like "this tenant has no
sales", and §1.7's export runs under `withTenant`, so a GUC failure yields a complete, checksummed,
**empty export of a departing customer's books**. §4.2.5's CI assertion pins the *policy expression
text*, not the function body, so both can hold with a one-line change inside `app.current_tenant()`:
raise on unset rather than returning `NULL`. §4 is authoritative and this is a recommendation to it,
named in §1.11 — and because it is a recommendation and not a ruling, §1.7's export carries an
independent RLS-bypassed count check (§1.7) that catches the failure whichever way §4 decides.

### Layer 2 — the connection is never acquired without a tenant

The application database role is created `nosuperuser nobypassrls`. It cannot see through RLS
even if a predicate is forgotten.

There is no exported connection pool. The only way to reach `app` is `withTenant`. The first
version claimed *"`ADR-0005` rule 2 is not advice here; there is no function that accepts one"* —
immediately after showing a function that accepts a `string`, guarded by a lint rule. A lint rule is
a convention with a config file, which is what `CLAUDE.md` §2.1 says isolation may not rest on. Two
changes:

**A branded type with exactly one constructor.**

```ts
declare const brand: unique symbol;
export type TenantId = string & { readonly [brand]: 'TenantId' };

// The ONLY function in the codebase that produces a TenantId. It lives in the auth package,
// it takes a verified token, and there is no cast, no `as TenantId`, no parse-from-string.
export function tenantIdFromVerifiedToken(t: VerifiedToken): TenantId { … }

export async function withTenant<T>(t: TenantId, fn: (tx: Tx) => Promise<T>): Promise<T>;
```

A tenant id read out of a request body or a query string is now a `string`, and a `string` does not
type-check as a `TenantId`. The dependency-graph check in §1.6 (used there for `origin_ref`) also
forbids any package outside `auth` from importing the constructor's module. This is the same
control applied twice, which is the point: a package boundary is checkable, an eslint override is
negotiable.

**And the GUC is set once, by one function.** The unexamined hole was that **RLS trusts the GUC
absolutely**. Any path that can execute `SET LOCAL app.tenant_id` or
`select set_config('app.tenant_id', …)` inside the transaction — a SQL injection reaching a
statement boundary, a helper that takes a GUC name as a parameter, a support script — defeats every
policy in the schema at once.

```sql
create function app.set_tenant(p_tenant uuid) returns void
  language plpgsql security definer as $$
begin
  if coalesce(current_setting('app.tenant_id', true), '') <> '' then
    raise exception 'app.tenant_id is already set in this transaction' using errcode = '42501';
  end if;
  perform set_config('app.tenant_id', p_tenant::text, true);   -- true = LOCAL, never session
end $$;
revoke all on function app.set_tenant(uuid) from public;
grant execute on function app.set_tenant(uuid) to app_rw, platform_support;
```

Set-once, transaction-local, and a CI assertion (§1-E below) fails the build on any
`set_config('app.tenant_id'` or `SET LOCAL app.tenant_id` outside this function's definition.
`SET LOCAL`, never `SET` — a session-scoped GUC on a pooled connection leaks the previous request's
tenant into the next one, which is the exact failure mode this design exists to prevent. §2.8's
`platform_support_grant` is the only other caller, and it calls the same function.

### Layer 3 — the catalogue assertion

Codegen makes the right thing easy. It does not make the wrong thing impossible — someone will
eventually write a migration by hand. So a CI test interrogates `pg_catalog` on the migrated schema.

**The six rules listed here previously were, item for item, the version §4.2.5 dismantled.** They
checked the `relrowsecurity`/`relforcerowsecurity` booleans without ever inspecting the policy
expression, so a policy `USING (true)` passed and returned every tenant's rows; they did not name
`relkind`, so partitioned tables (`write_log` and `stock_movement` are the two obvious partitioning
candidates) and views and matviews were outside their scope; there was no `has_write_id`; and rule 6
was a **name-based** float guard, under which `double precision gross_margin`, `numeric
discount_rate`, `real average_cost` and a domain over `float8` all pass green — a direct
`CLAUDE.md` §2.3 hole in the layer this section called the one that holds.

**The guard is §4.2.5's assertion set, not a second list.** `has_tenant_id`, `rls_enabled`,
`rls_forced`, `pk_leads_tenant`, `has_write_id`, `security_invoker`, the policy-expression check,
and the **inverted** numeric rule (no `float4`/`float8`/`real`/`money` anywhere in `app`; `numeric`
only on a named versioned allowlist; domains resolved through `typbasetype`). Exemptions are per
assertion, live in a checked-in versioned file rather than a table inside `app`, and
**`has_tenant_id` and `rls_forced` are never exemptible** — a hard-coded refusal in the harness.

This section adds six assertions §4 does not have, because they guard tenancy machinery rather than
row shape:

```
§1-A  registry membership — every relation in app. appears in the codegen registry.
      (A table in no registry is in no export set and no deletion set.)
§1-B  lifecycle — every registry entry is 'carry' or 'derived'; every 'derived' entry names a
      reconstruction function that exists in pg_proc AND is exercised by the rebuild-and-diff
      test in §1.7. 'carry' is the default and cannot be omitted.
§1-C  composite FK — every foreign key between two app. relations includes tenant_id on both
      sides. (§4.2.5 does not assert this; it is the belt in "RLS is the backstop".)
§1-D  no cross-schema FK — no foreign key from app. to platform.  (§1.4: a promoted tenant's
      app schema is in a different database and a foreign key cannot cross databases.)
§1-E  one GUC minter — no source file outside app.set_tenant emits set_config('app.tenant_id'
      or SET LOCAL app.tenant_id.
§1-F  platform exemptions — the tenant-keyed platform tables on the exemption list are exactly
      {tenant, tenant_placement, tenant_state_transition}, each with a written reason.
```

This is the layer that actually holds, because it is the only one that does not depend on anyone
using the right tool. `tenant-isolation-test-engineer` owns the behavioural half — a fixture pair
of tenants and a read-path test per query — and this catalogue test is its structural complement:
it fails on a table that has no query yet.

### What none of this covers, and it matters

**RLS does not apply to logical replication.** The sync service reads the WAL as a replication
user; row-level security is not evaluated on that path. So on the one path where data actually
leaves the server for a device that can be stolen, there is no database backstop at all — the
tenant boundary is enforced entirely by the sync-rule definition. `ADR-0005` calls RLS "belt and
braces"; the braces are absent on exactly the path the ADR itself identifies as the one that
matters. §4.17.5 reaches the same conclusion independently. The compensating control is named in
§1.10 C1 and is a **blocking phase-gate item, not an open question**.

---

## 1.4 Tenant → database placement, and the local projection

Every tenant resolves to a database through a lookup, today and always, even though every row
currently points at the same cluster.

```sql
create table platform.db_cluster (
  id                  text primary key,      -- 'eu-west-1-shared'
  region              text not null,         -- 'eu-west-1'  (ADR-0003)
  dsn_secret_ref      text not null,         -- pointer into the secret store, never a DSN
  replica_dsn_secret_ref text,               -- §1.7: exports run here
  sync_service_url    text not null,
  accepts_new_tenants boolean not null default true
);

create table platform.tenant_placement (
  tenant_id   uuid primary key references platform.tenant (id),
  cluster_id  text not null references platform.db_cluster (id),
  moved_at    timestamptz not null default now()
);
```

This supersedes §4.3's `platform.tenant_database`, which inlined a DSN per tenant and had no
cluster registry — named in §1.11.

The rule that gives this teeth: **no module imports a connection pool.** `withTenant(tenantId, …)`
resolves placement (cached, invalidated on `moved_at` change), picks the pool for that cluster,
and opens the transaction. A developer writing a query never sees which database they are on, so
there is no code to change when the answer stops being "the same one".

The same indirection carries the sync service URL, because a device on a promoted tenant must
connect to that cluster's sync service — the resolution has to happen at token issue, not just at
query time.

### `app.tenant_local_state` — and why `app` may not reference `platform`

The first version emitted `tenant_id uuid not null references platform.tenant (id)` on **every**
`app` table (§4.2.2 does the same on `write_log`), and gave `app.role_permission.permission_code`
a foreign key to `platform.permission`. It then claimed promotion works because *"`platform` stays
central"*. Those two statements cannot both be true: **a promoted tenant's `app` schema is in a
different database, and a foreign key cannot cross databases.** The mechanism §1.4 exists to enable
was blocked by the DDL §1.3 emitted.

The FKs go. Their integrity value was near zero anyway — `tenant_id` is stamped server-side from
the verified token and never client-supplied, so there is no path by which a row acquires a
`tenant_id` that has no tenant. In their place, every cluster carries a **local projection**:

```sql
-- One row per tenant resident on this cluster. Written ONLY by the control plane, under
-- platform_admin; read by everything. This is what makes `app` self-sufficient on a promoted
-- cluster, and it is what the sync service, the freeze trigger and the client all read.
create table app.tenant_local_state (
  tenant_id         uuid        primary key,     -- also the RLS predicate column
  state             text        not null,        -- projection of platform.tenant.state
  write_frozen      boolean     not null default false,
  suspended_at      timestamptz,
  jurisdiction_code char(2)     not null,
  currency_code     char(3)     not null,
  money_scale       smallint    not null,        -- so the client knows the scale offline
  projected_at      timestamptz not null
);
-- lifecycle: 'derived', reconstructedBy: app.rebuild_tenant_local_state()
-- exemption: has_write_id (control-plane row, no originating device write) — named, with a reason
```

`app.role_permission.permission_code` loses its FK to `platform.permission` the same way, and gains
a `CHECK (permission_code = any (app.permission_codes()))` against a **generated, versioned**
immutable function emitted from the same permission registry, plus a CI assertion that every code
referenced anywhere resolves in that registry. A code list that ships with the release is exactly
as strong as an FK and does not pin the tenant to one database.

And the honest consequence, which the previous version's "promotion, honestly" paragraph omitted
while claiming to be honest: **a promoted cluster requires the projection to be replicated to it.**
The control plane pushes `app.tenant_local_state` and the generated permission function on every
change; both are tiny and change rarely. Auth still calls back to `platform` at token issue, which
is a network dependency a promoted tenant does not escape.

### Promotion, honestly

`active → migrating` freezes the tenant. The previous version froze the **token endpoint and the
upload path** and called that a freeze. It is not: nothing stopped **server-side writers** — the
nightly stock reconciliation (§4.17.5 #25), the facility-fee accrual (§5.6.2 rule 8), period-close
revaluation entries (§5.14.5), conflict resolutions, and every scheduled job in §3.11.7. Each of
those writes to the *old* cluster after the copy and before the flip, and the write is lost.

**The freeze is enforced in the database, at the one chokepoint the schema already forces every
write through.** §4.2.2's composite FK means no tenant-owned row can be inserted without first
inserting an `app.write_log` row. So:

```sql
create function app.assert_tenant_writable() returns trigger language plpgsql as $$
begin
  if (select write_frozen from app.tenant_local_state where tenant_id = new.tenant_id) then
    raise exception 'tenant is write-frozen (migration in progress)' using errcode = '55006';
  end if;
  return new;
end $$;
create trigger write_log_freeze before insert on app.write_log
  for each row execute function app.assert_tenant_writable();
```

Every writer fails closed — the API, the sync ingest, the accrual job, the close job, a support
script, a psql session. `new_tenant_table` emits the same guard as a `before update or delete`
trigger for the update-shaped mutations that reuse an existing `write_id`. I am **not** adopting the
reviewer's proposed mechanism of adding a `write_frozen` term to the RLS `WITH CHECK` expression:
§4.2.5's assertion (2) requires the policy expression to be *exactly*
`(tenant_id = app.current_tenant())`, so a second term would fail §4's own CI guard on every table.
The goal is right; the chokepoint is the right place for it.

**Verification is a checksum, not a count.** Counts are not content — an `UPDATE` landing after the
copy leaves counts identical and content divergent, and for a general ledger that is a corrupt book
with a green verification. Per table, per side:

```sql
select md5(string_agg(t.row_digest, '' order by t.row_digest)) from (
  select md5(id::text || write_id::text || hlc || updated_at::text || coalesce(deleted_at::text,''))
         as row_digest
  from   app.<table> where tenant_id = $1) t;
```

Digesting `(id, write_id, hlc, updated_at, deleted_at)` catches every mutation, because §4.2.3's
base row guarantees all five and `updated_at` moves on any change. A full-column digest is
available behind a flag for the first few promotions and is worth paying for until we trust it.

**And a migration has a deadline.** The previous version gave `migrating` no timeout, no alert and
no abort path, and the only legal exit was `migrating → active` — so an orchestrator crash left a
whole tenant write-frozen indefinitely while every device queued. Corrected: the migration run
holds a lease with an expiry; on expiry the orchestrator is presumed dead, an alert fires, and the
**automatic abort** returns the tenant to `active` against its *original* cluster (the flip is the
last step and is a single row, so abort is always safe before it and never needed after it). Both
success and abort exit through `migrating → active`; the difference is whether
`tenant_placement.cluster_id` moved.

What the indirection buys is that this is a **scheduled migration with a write freeze**, not a
re-architecture. What it does not buy: `platform` stays central for auth, so a promoted tenant
needs the local projection above plus a callback at token issue; the copy job is bespoke work; and
the devices resync from zero, which over Ghanaian mobile data at 25 outlets is a real cost, not a
footnote. `ADR-0005` describes promotion as "a configuration change rather than a rewrite" — the
second half is right, the first is optimistic. See §1.10 C2.

---

## 1.5 The configuration model (generalising `ADR-0006`)

Tenant #1's vocabulary appears nowhere in these tables. That is the whole point, and it is worth
being explicit about which platform concept each piece of Agyasei-specific language became.

### Locations: vocabulary and structure are two different columns

The first version put the capability on the **type** — `location_type(code, name, holds_stock,
sells)` — and argued that types are vocabulary with no ordering between them. The argument is right
and §4.3 agrees with it. The columns were wrong, in two ways that matter.

First, **there was no way to represent TRANSIT**, so in-transit stock had nowhere to live and the
corrected transfer and GL design (§4.7.3, §5.6.3, both of which depend on `kind='TRANSIT'` nodes,
one per sending location) had no schema to sit on.

Second, and worse, `holds_stock` was an **editable column on a tenant-owned row that platform code
branches on**. An outlet manager with `location_type` edit rights unticks `holds_stock` on the type
the transit nodes use, and the inventory subledger's replay silently stops seeing in-transit stock.
That is `CLAUDE.md` §2.9 in reverse — not platform code branching on tenant identity, but platform
*behaviour* driven by a tenant-editable field, which is the same failure arriving from the other
direction. §4.3 already had the right answer and this section had not been reconciled to it:

```sql
app.location_type (          -- TENANT VOCABULARY. No platform code ever reads location_type.code.
  code text not null,        -- tenant #1: FLAGSHIP / RDC / MICRO. Another tenant: BRANCH / DEPOT.
  name text not null,
  default_assortment_id uuid,
  default_headcount     smallint
  -- unique (code) → emitted (tenant_id, code) where deleted_at is null
);

app.location (
  code text not null, name text not null,
  location_type_id uuid,                  -- NULL for grouping nodes
  parent_id        uuid,                  -- arbitrary-depth tree; composite FK on tenant_id
  kind text not null check (kind in ('OUTLET','WAREHOUSE','GROUP','TRANSIT')),
  is_trading           boolean not null,  -- takes sales, is a sync target       (§5.6.2, §5.10)
  is_postable_location boolean not null,  -- may carry GL lines                  (§5.14.5)
  is_active boolean not null default true,
  opened_on date, closed_on date,
  timezone  text not null
);

app.location_closure (       -- closure table, includes self at depth 0
  ancestor_id uuid not null, descendant_id uuid not null, depth int not null,
  primary key (tenant_id, ancestor_id, descendant_id)
);
```

`SUPPLIER_GAP` is deleted per §4.17.5 #24. `status text 'planned'|'trading'|'closed'` is deleted:
it was free text where §4.3 has `is_active`/`opened_on`/`closed_on`, and "trading" was tenant #1's
word for a state the platform must reason about — which is exactly the disguise `ADR-0006` warns
about. `depth` on `app.location` is deleted; it is the closure table's column.

Four deliberate choices, and the first three are unchanged because they were right:

- **The hierarchy is arbitrary-depth.** Tenant #1 has region → outlet. A tenant with country →
  region → city → branch → yard is the same schema. Nothing reads `depth = 2`.
- **There is no ordering between types.** "Tier 2 outranks Tier 3" is tenant #1's org chart, not a
  platform fact. Grouping nodes are `kind = 'GROUP'`.
- **A closure table, not a recursive CTE.** Every scoping question is "is location L within scope
  S", and it is asked in sync rules and permission checks. §2.5 gives the same reason and the
  stronger form of it: sync-rule parameter queries do not support recursive CTEs, so *a hierarchy
  only the API can resolve is a hierarchy the sync boundary cannot enforce* — which puts it on the
  wrong side of the most important control. The closure table costs a trigger, write amplification
  on reparenting (rare, and effective-dated per §5.14.6 #28), and a cycle check on `parent_id`
  updates. `sync-architect` confirms expressibility in §3.11.8's capability gate.
- **`kind` is a closed platform enum and `location_type` is a tenant string.** The platform
  branches on `kind`; nothing anywhere branches on `location_type.code`. `if (type.code === 'RDC')`
  is the same defect as `if (tenant === 'agyasei')`, and the CI lint that bans the second bans the
  first.

### Catalogue

`app.product`, `app.product_category`, `app.unit_of_measure`, `app.product_uom` — all tenant-owned,
all `app`. There is **no platform-global product table**. The temptation is a shared
barcode/reference catalogue so tenants in the same trade need not re-enter cement; if we ever build
it, it is an import *source* whose rows are copied into the tenant's own catalogue at import time,
never a live join. A live join means one tenant's correction changes another tenant's price list.

### Roles and permissions — where a platform code list is correct

`permission` lives in `platform` and is a static code list (`pos.sell`, `pricing.override`,
`credit.limit.change`, `stock.adjust`, `gl.review`, …). This is not a contradiction of "nothing
is hard-coded": a permission names a capability *the software has*, and the software's capabilities
are a platform fact. It is the same argument §4.3 makes about `location.kind`, which is why §1.5
now resolves the location contradiction in that argument's favour. What is tenant-owned is how
permissions are grouped:

```sql
app.role            (name, is_template_seeded boolean)
app.role_permission (role_id, permission_code)   -- CHECK against app.permission_codes(), §1.4
app.user_role       (user_id, role_id, scope_location_id)   -- null = whole tenant
app.user_account    (email, display_name, status, revoked_at)  -- §1.1: identity is tenant-owned
```

Agyasei's five roles are five rows in `app.role`, editable on day one. `scope_location_id` resolves
through `app.location_closure` into §2.5's `user_location_scope`. Detail belongs to
`rbac-security-engineer`; what matters here is that the schema has no `role` enum for them to work
around.

### Credit, targets, chart of accounts

Per-tenant credit policy with per-account terms and rate; a generic targets/budget-vs-actual
feature; a CoA the tenant edits. `credit-engineer` and `ledger-engineer` own the interiors. All
three are ordinary `app` tables seeded by a template and owned by the tenant thereafter.

---

## 1.6 Templates

A template is a **versioned, content-addressed set of files shipped with the release**, not a
database-backed authoring product. There is no template CRUD screen, because no customer has asked
to author one and the machinery to let them is large. The cost of that choice: a partner-authored
vertical template is a service engagement (we write the files, we ship a release), not a feature.
Say that out loud before sales says otherwise.

**Every published version ships in every subsequent release.** Remediation of a defect in version 2
requires version 2's files, and "never re-published" only guarantees they are not *changed*, not
that they are still on disk. The template files are content-addressed and the remediation tooling
resolves a `(template_id, version)` to its content hash through `platform.template_catalogue`; a
release that drops a version its tenants still hold rows from fails CI.

### Manifest shape

```yaml
id: construction-materials-distribution-gh
version: 3                              # integer, monotonic; never re-published
title: Construction materials distribution — Ghana
jurisdiction: GH                        # applier refuses a tenant whose jurisdiction differs
modules:
  - key: units_of_measure
    title: Units and conversions
    depends_on: []
    rows: uom.csv
  - key: chart_of_accounts
    depends_on: []
    rows: coa.csv
  - key: location_types
    depends_on: []
    optional: true
    rows: location_types.csv
  - key: roles
    depends_on: []
    rows: roles.csv
  - key: catalogue
    title: 219-SKU construction catalogue
    depends_on: [units_of_measure, chart_of_accounts]
    optional: true
    rows: skus.csv
  - key: credit_policy
    depends_on: [chart_of_accounts]
    rows: credit_policy.csv
  - key: targets
    depends_on: []
    optional: true
    rows: targets.csv
```

Rows carry a stable intra-template `ref` and reference each other by it. The applier resolves refs
to real ids in one pass; nothing in a template file contains a uuid.

```json
{ "ref": "coa:4010", "code": "4010", "name": "Sales — cement",
  "type": "revenue", "parent": { "ref": "coa:4000" } }

{ "ref": "sku:CEM-OPC-50", "name": "Ordinary Portland Cement 50kg",
  "stocking_uom": { "ref": "uom:bag" },
  "selling_uoms": [ { "ref": "uom:bag", "factor_num": 1, "factor_den": 1 } ],
  "revenue_account": { "ref": "coa:4010" },
  "tax_code": "GH-VAT-STD" }
```

### What a template does **not** contain

- **Locations.** Another company's 25 outlets are not a starting point for anyone. Location *types*
  are template data; locations are onboarding input.
- **Prices.** SKUs, units and conversion factors, yes. Prices, no — they are commercially specific,
  and a wrong seeded price at a counter is worse than an empty one.
- **Users, opening balances, or any money amount.**
- **Tax rates.** Those are the jurisdiction pack's (`ADR-0007`, §7.1). A template may reference a
  `tax_code` the pack defines; it may not define the rate. The manifest's `jurisdiction: GH` is
  what makes those references resolvable, and why the applier refuses a mismatched tenant.

The rebar and aggregate conversion factors from `open-questions.md` Q7 are template data — which
means the founder's answer to Q7 blocks the catalogue module, not merely the SKU schema.

### Application semantics

```
apply(tenant, template@version, modules[]) -> provisioning steps
```

- Modules are selectable. `chart_of_accounts` without `catalogue` is a supported, expected choice.
- **Dependencies are declared and enforced.** `catalogue` without `chart_of_accounts` is refused
  by name — "catalogue requires chart_of_accounts" — rather than half-applied with dangling
  account references.
- **A module application is exactly one transaction.** A ref that does not resolve — because the
  tenant deleted seeded account `4010` in month one and applies `catalogue` in month three, which
  carries `{"ref": "coa:4010"}` — **aborts the whole module by name**, listing every unresolvable
  ref, and changes nothing. There is no partial application and no silent substitution. The
  operator's remedy is to re-create the account or to accept a variant of the module; both are
  explicit acts.
- **The applier never UPDATEs.** A re-run after a tenant has edited a seeded row changes nothing.
  This is the concrete expression of "no live inheritance" — there is no code path that can
  overwrite a tenant's edit with template content.
- A module may be applied later than onboarding. A tenant that skipped the catalogue and wants it
  in month three runs the same step through the same machinery.

### Idempotency that survives a tenant's deletions

The first version made idempotency a **partial** unique index —
`unique (tenant_id, origin_template_id, origin_ref) where origin_ref is not null` — and claimed
*"that constraint **is** the idempotency: re-running a module is `on conflict do nothing`."* It is
not, because §4.2.4 requires every uniqueness constraint in `app` to be partial on
`deleted_at IS NULL` as well. A tenant deletes twelve seeded accounts they do not use; support
re-runs `apply_module:chart_of_accounts` for an unrelated reason; the deleted rows no longer
participate in the index, `ON CONFLICT DO NOTHING` does not fire, and **twelve accounts the tenant
deliberately removed reappear in a live chart of accounts.** Making the index non-partial instead
violates §4.2.4 and means a tenant can never re-create a seeded code they deleted. Either way the
stated idempotency does not hold.

The claim is separated from the row it claims:

```sql
-- A permanent ledger of "this template row has already been materialised for this tenant".
-- Survives soft-deletion of the row it claimed, because it is not the row.
select app.new_tenant_table('template_row_claim', $$
  template_id      text    not null,
  template_version integer not null,
  module_key       text    not null,
  origin_ref       text    not null,
  claimed_table    text    not null,
  claimed_id       uuid    not null,        -- (tenant_id, claimed_id) — the row it created
  constraint trc_permanent check (deleted_at is null)   -- never soft-deleted, so the index is total
$$);

create unique index template_row_claim_uq
  on app.template_row_claim (tenant_id, template_id, origin_ref)
  where deleted_at is null;                 -- §4.2.4's form; total in practice by the CHECK above
```

Re-running a module is `insert … on conflict on constraint template_row_claim_uq do nothing` **on
the claim**, and a row is materialised only when its claim inserts. So a re-run is a genuine no-op
whether or not the tenant edited the seeded row, deleted it, or never touched it. The business row
keeps its own partial unique per §4.2.4 and keeps `origin_template_id`, `origin_template_version`,
`origin_ref` for provenance.

### Every seeded row is a server-derived write

The applier previously inserted rows directly and never mentioned `write_log`. That cannot work:
§4.2.3 makes `write_id` `NOT NULL` with a composite FK to `app.write_log`, §4.2.5 asserts
`has_write_id` on every `app` table with three named exemptions, and §4.17.3 rules that
**server-derived rows get a `write_log` row with `origin='SERVER'`** — *"without this … every
conflict resolution either fabricate[s] a device or sit[s] on the exempt list — which would remove
the audit backbone from the most sensitive rows in the system."* Seeding a chart of accounts is
exactly a server-derived write, and the chart of accounts is exactly a sensitive row.

So `apply_module` opens **one** `write_log` row per module application, with a deterministic id per
§3.11.7 so a retry is genuinely idempotent at the registry as well as at the claim:

```
write_id = uuidv5(ns_template, 'apply_module:' || tenant_id || ':' || template_id
                               || ':' || template_version || ':' || module_key)
origin   = 'SERVER',  device_id = NULL,  actor_user_id = <the operator running the run>,
op       = 'template.apply_module'
```

Every row the module materialises — the accounts, the SKUs, the claims — carries that `write_id`.
"Which write created this account" is answerable, and "re-run the module" collides on the
`write_log` primary key before it reaches any business table.

The registry declaration carries `seedable: true`, which is what emits `origin_template_id`,
`origin_template_version`, `origin_ref` and the claim relationship. A table that is not `seedable`
has no provenance columns and the applier has no path to write to it.

### Why there is no live inheritance, and what it costs

No runtime template lookup, no "reset to template", no inheritance chain. After application the
rows are ordinary rows and the template has no authority. The alternative is a
configuration-inheritance system with override layers, and every question in the product then
acquires a second form — "what is this tenant's value" and "what is it *because of*". Nobody asked
for that.

**The cost is real and I am not going to hide it:** a bug in a shipped template does not
self-heal. If version 2 of the Ghana CoA had a wrong account type, every tenant that applied it
still has it. What we do instead:

```sql
select app.new_tenant_table('tenant_template_application', $$
  template_id      text    not null,
  template_version integer not null,
  module_key       text    not null,
  content_hash     text    not null,
  applied_at       timestamptz not null,
  applied_by       uuid    not null,
  row_count        integer not null,
  last_verified_at timestamptz,
  verified_row_count integer
$$);

create unique index tta_uq on app.tenant_template_application
  (tenant_id, template_id, template_version, module_key) where deleted_at is null;
```

**The version is in the key**, which it was not. The old primary key was
`(tenant_id, template_id, module_key)` while the row carried `template_version` — so a tenant that
took the chart of accounts at v2 and then the catalogue at v4 either violated the key or overwrote
the first application. The remediation query for a v2 defect then returned the wrong tenant set,
which is the one thing this table exists to do. It is also now in `app`, not `platform`, so it is
RLS-scoped, exported and deleted with the tenant (§1.12 M8).

A template defect produces an **advisory**: query that table for affected tenants, generate a
per-tenant remediation script, and run it with the tenant's knowledge and consent. A **verification
pass** re-counts the live rows carrying each `(template_id, template_version, module_key)` and
writes `last_verified_at` / `verified_row_count`; drift from `row_count` is expected (tenants edit
and delete) and is reported as a per-tenant delta rather than an alarm, so the remediation script
is generated against what the tenant actually has rather than against what we seeded. Slower than a
version bump. Also the only version that does not silently rewrite a live company's books.

`origin_ref` is retained for exactly this. It is provenance and support metadata. **No business
logic may read it** — a `WHERE origin_ref = 'coa:4010'` in a posting rule is `CLAUDE.md` §2.9
wearing a disguise. The first version banned it with a lint rule *"outside the onboarding and
support modules"*, which is a lint config carve-out, and C6 anticipates exactly that weakness.
Corrected: `origin_ref` and the provenance columns are readable **only** through
`@platform/provenance`, which the dependency-graph check forbids every business-logic package from
importing. A package boundary is checkable in CI and cannot be waived in a file; an eslint override
can be added in a line.

---

## 1.7 Export, import and deletion on a shared schema

`ADR-0005` names export and deletion as things that must be built deliberately. Both are driven by
the same codegen registry as the DDL, so a new table joins them automatically — and CI assertions
§1-A and §1-B fail a table that is in no registry, or that is `derived` without a reconstruction
function.

### `carry` and `derived`, and the switch that used to be silent

- **`carry`** — the tenant's data. Exported and deleted. **This is the default and cannot be
  omitted**; the registry type has no way to express "unclassified".
- **`derived`** — reconstructible from `carry` rows. Deleted, not exported. Declaring it requires
  naming a reconstruction function, and a CI test truncates every `derived` table in a fixture
  tenant, runs its function, and diffs. A `derived` table with no working reconstruction fails the
  build.

The first version made `lifecycle` a hand-set field with no guard on the wrong value. Mark `sale`
as `derived` and it vanishes from every export while still being deleted, and no test fails. That
is a silent data-loss switch in the artefact `ADR-0005` calls a promise.

**And one classification was already wrong.** `derived` listed "sync bucket state", under which
`app.device_write_watermark` (§3.11.3) reads as a natural member. It is not. §3 rules it
**permanent** and makes it the structural replacement for temporal dedupe: *"a permanent, tiny
`device_write_watermark` row per device makes any write at or below the watermark a replay
regardless of age, so `write_log` bodies can be pruned freely and there is no cliff."* Restore a
tenant from a machine-form export that omitted it — a promotion, a disaster recovery, a migration
in — and: the watermarks are gone, `write_log` response bodies older than 90 days were pruned
(§3.3.3), a tablet that has been dark reconnects and replays its outbox, and **every one of those
sales posts a second time** — revenue, COGS, stock movements and credit entries — with no conflict
raised, because dedupe is precisely what was lost. That is `CLAUDE.md` §2.2's "silently
double-counted", reached through one word in a classification field.

So the rule is stated generally, not as a list of exceptions:

> **Anything whose absence changes whether a replayed write is applied is `carry`, however derived
> it looks.**

Named explicitly as `carry`, because each of them was previously unclassified or misclassified:
`app.write_log`, `app.device_write_watermark`, `app.device_sync_state`, `app.sequence_block`,
`app.conflict_review`, `app.row_version`, `app.template_row_claim`,
`app.tenant_template_application`, `app.tenant_pack_application`, `app.tenant_gate`,
`app.provisioning_run`, `app.provisioning_step`. A successor system that receives a tenant's
books without their write provenance has no audit trail; one that receives them without the
watermarks and sequence blocks will reissue receipt numbers and re-post sales.

`derived` is currently three tables: `app.location_closure`, `app.stock_balance_current` and
`app.tenant_local_state`. Each names its function.

### Export

Two artefacts, because they answer two different questions.

**1 — Machine form.** One **newline-delimited JSON** file per `carry` table, plus `manifest.json`.
Not CSV: `app.hlc` has internal structure, several columns are `jsonb` or arrays, CSV erases the
distinction between `NULL` and the empty string, and a `money_minor` value opened in Excel becomes
a float. Money and quantity values are emitted as **JSON strings of integers**, not JSON numbers,
because `bigint` exceeds the 2^53 a JSON number is safely parsed into — the same rule §3.11.6
already applies to mutation payloads.

**2 — Accountant form.** Trial balance, general ledger, customer statements and ageing, stock
ledger by location, and invoices/receipts in the jurisdiction pack's required format. This is the
only artefact intended for a spreadsheet, and it renders money as decimals with the currency named
on every page. Because "here are 140 files" is not "your books", and `ADR-0005` calls export a
promise.

**The manifest carries the unit dictionary, which it did not.** `total_minor = 452500` handed to a
successor system is meaningless without the scale, and `CLAUDE.md` §2.3 requires the scale be
stated and never assumed to be 100, with rounding *"explicit and stated at every boundary"*. An
export is a boundary.

```jsonc
{
  "tenant_slug": "agyasei-jnr",
  "export_id": "…", "exported_at": "2026-…", "snapshot_lsn": "0/1A2B3C4D",
  "schema_version": 41, "registry_version": "2026.08.1",
  "jurisdiction_code": "GH",

  "money": {
    "currency_code": "GHS", "money_scale": 2, "rate_scale": 4,
    "note": "Every column of type money_minor is an INTEGER count of minor units. 10^money_scale
             minor units = 1 GHS. Columns of type rate_e4 are minor units x 10^4. No amount in
             this export is a decimal. Do not assume 100."
  },
  "quantities": [ { "uom_code": "kg", "qty_scale": 3 }, { "uom_code": "bag", "qty_scale": 0 } ],
  "uom_conversions": [ { "product_uom": "…", "factor_num": 50, "factor_den": 1 } ],
  "rounding": [ /* §4.13's complete list, verbatim, with the mode and the scale at each point */ ],

  "format": { "type": "NDJSON", "encoding": "UTF-8", "null": "JSON null",
              "integers_as_strings": ["money_minor","rate_e4","qty"] },

  "tables": [
    { "name": "sale", "lifecycle": "carry", "rows": 184922, "sha256": "…",
      "columns": [ { "name": "total_minor", "type": "money_minor", "unit": "GHS minor" } ] }
  ],

  "template_applications": [ … ], "pack_applications": [ … ],
  "undrained_devices": [ … ],
  "verification": { "method": "platform_admin, RLS bypassed, count per registry table",
                    "result": "match" }
}
```

The per-column type and unit dictionary is generated from the same registry as the DDL, so it
cannot drift from what was actually exported.

**Export is verified, and it was not.** §1.7 was careful and correct that *deletion* must be
verified as `platform_admin` with RLS bypassed, and named the "verification that cannot fail" trap
explicitly — then applied no equivalent to export. A sha256 proves the *file* is intact, not that
the *query* was complete. An RLS predicate that returns zero rows, or a `withTenant` GUC failure,
produces a successful export of an empty book with a valid checksum, signed and handed to a
departing customer. The symmetric check: **per-table counts read under `platform_admin` with RLS
bypassed, compared against the export's counts, before the manifest is signed.** A mismatch is a
failed export, not a warning. This is also what makes the `app.current_tenant()` question in §1.3
non-load-bearing here: the export is verified from outside the tenant's own predicate either way.

**Export runs on a replica, at an exported snapshot.** A full-tenant export inside one long
`withTenant` transaction on a shared cluster holds `xmin` back and delays WAL cleanup, which on a
cluster whose sync depends on logical replication slots degrades **every other tenant's sync** —
the noisy-neighbour risk `ADR-0005` names. So: the export opens a repeatable-read transaction on
the cluster's replica (`db_cluster.replica_dsn_secret_ref`), exports the snapshot with
`pg_export_snapshot`, and parallel readers attach to it with `SET TRANSACTION SNAPSHOT`. The
manifest records the LSN so the export is a nameable point in time. RLS applies on a replica
exactly as on the primary, so the export path stays the *most* constrained path, not the least — a
cross-tenant row in an export is one of the two worst bugs this system can have. Where no replica
exists, the export runs on the primary and the noisy-neighbour cost is accepted and logged, not
hidden.

### The drain gate — export cannot run ahead of the devices

An export that silently omits an outlet's last week is worse than a refused one. The export step is
blocked until:

- **every enrolled `active` device of the tenant has attested** — `device_sync_state
  .last_queue_empty_at > tenant.offboarding_started_at` (§3.11.4's mechanism, reused rather than
  reinvented; it is the same question §5.2.6 asks before locking a period); **or**
- **`drain_deadline` has passed**, in which case the export proceeds and the manifest's
  `undrained_devices[]` names each device that did not drain, with its location, `last_seen_at` and
  last-reported `outstanding_estimate`.

The certificate and the customer-facing summary repeat that list. A departing customer is told which
tablets never came back and roughly what they were holding, because that is the true answer.

### Import — the arriving customer

§1.7 gave a departing customer a first-class export and gave an arriving one nothing, while every
customer after tenant #1 arrives from a spreadsheet or an incumbent system, and **tenant #1 itself
goes live on 1 August 2026 with stock on the floor and contractors already owing money.** The
opening trial balance is the first thing the §2.8 accountant gate reviews, so this is on the
critical path, not a Phase 2 nicety.

Import is the export in reverse and uses the same manifest contract: the same registry-generated
per-column type and unit dictionary, the same NDJSON form, the same money-as-strings rule. What it
adds is a **staging and reconciliation** step, because an arriving customer's data is not a previous
export of ours:

```
import_opening_state
  → stage        (load into app.import_batch / import_row; nothing touches live tables)
  → map          (their codes → the tenant's products, locations, customers, accounts)
  → validate     (units resolve; every money value is an integer in the stated scale;
                  the opening trial balance balances; AR per customer ties to the credit
                  subledger; stock quantities tie to the opening stock count per location)
  → post         (one write_log row, origin='SERVER', op='import.opening_state',
                  deterministic write_id; opening stock movements, opening credit entries,
                  and the opening journal entry with its equity plug, per §5.14.6 #27)
```

Validation failures block the batch and are listed by row. Nothing half-imports. The design of the
opening **journal entry** itself — `source_kind`, the equity plug, and the gate that the opening
trial balance ties to the subledgers per location — is `ledger-engineer`'s and is already recorded
as §5.14.6 finding 27 and `open-questions.md` **Q20**; this section owns the surrounding machinery
and the requirement that it exists in Phase 1. Q20 needs extending: it covers the GL half, and
opening **stock**, **customers** and **outstanding credit positions** are the same cut-over and the
same signature.

### Deletion

Deletion runs as a distinct `platform_admin` role that has `bypassrls`. **It is non-interactive and
job-only** — there is no login for a human, no psql session, and no path by which an operator
acquires it. That is what reconciles it with §2.8's *"no `BYPASSRLS` on any interactive role"*: the
support path for humans is §2.8's `platform_support_grant`, four-hour window, two-person approval
for writes, and the audit rows written into the tenant's own trail. `platform_admin` exists for
exactly two jobs, migrations and offboarding, and "every use is audited" means mechanically: each
invocation writes a `platform.privileged_job_run` row (job, tenant, approver, ticket, start, end,
per-table counts) **and** `audit_event` rows into the tenant's own trail per §2.6, where the tenant
can see them.

```
begin;
  set constraints all deferred;            -- FKs are emitted `deferrable`, §1.3
  -- delete from every registry table, order irrelevant under deferral
commit;
```

FKs must be declared `deferrable` at creation time for this to work. That is a decision that has
to be made now — retrofitting it onto a live schema is an `ALTER` per constraint under lock.

**Then prove it, and prove it correctly.** The verification pass runs `select count(*) from app.X
where tenant_id = $1` for every registry table — **as `platform_admin` with RLS bypassed**. Running
the check under the tenant's own GUC would return zero for every table whether or not the delete
worked, which is a verification that cannot fail. That trap is worth naming explicitly because it
looks like the careful option.

**What deliberately survives:**

- The `platform.tenant` row, `state = 'offboarded'`, with id, slug, legal name and dates. Needed
  for billing history, to prove the deletion happened, and to reserve the id and slug forever
  (§1.1).
- `platform.tenant_state_transition`, `platform.tenant_placement` and the deletion certificate.
- **Backups.** Point-in-time recovery retains the deleted rows until the backup window ages out.
  The certificate states the date, rather than claiming an erasure we have not performed.

The certificate reads, in effect: server-side deletion complete on *D*; backups age out by
*D + backup_retention*; enrolled devices sealed under §2.7's lease decay by *D − drain + lease
ceiling*, with the undrained devices named. Three dates and a device list, because there are three
copies and some of the third copy never reported in, and a customer asking "is my data gone"
deserves the true answer rather than a tidy one.

---

## 1.8 Onboarding as a product feature

Provisioning is a durable run of declarative steps, not a script. Both tables move from `platform`
into `app`: they carry `tenant_id`, so there is no reason they should not be RLS-scoped, in the
deletion registry, and covered by the same CI assertions as everything else. In `platform` they had
no database backstop at all — a missing `WHERE tenant_id = $1` in the provisioning console showed
one customer's onboarding errors to another.

```sql
select app.new_tenant_table('provisioning_run', $$
  template_id      text, template_version integer,
  selected_modules text[] not null,
  state            text   not null,      -- 'running' | 'blocked' | 'complete' | 'abandoned'
  started_by       uuid   not null
$$);

select app.new_tenant_table('provisioning_step', $$
  run_id           uuid   not null,
  step_key         text   not null,      -- 'apply_module:chart_of_accounts'
  state            text   not null,      -- 'pending' | 'running' | 'complete' | 'failed'
  attempt          integer not null default 0,
  lease_expires_at timestamptz,          -- reclaims a crashed 'running' step
  started_at timestamptz, completed_at timestamptz,
  error_code       text,                 -- STRUCTURED. Never free-form business data.
  error_count      integer,
  result_summary   jsonb                 -- counts and codes only; schema-validated on write
$$);
```

**`error text, result jsonb` is gone.** A failed catalogue import wrote the offending rows into
`result`; a failed `create_first_admin` wrote an email address. Free-form business data in an
operational table is how a provisioning console becomes a data-exposure surface. `error_code` is a
member of a closed set, `error_count` is a number, and `result_summary` is validated against a
schema that permits counts and codes and nothing else. The offending rows stay in the import
staging tables (§1.7), where they are tenant-scoped like everything else.

Steps, in dependency order:

```
create_tenant_record → assign_jurisdiction → apply_jurisdiction_pack → create_placement
  → apply_module:*     (one step per selected module, ordered by manifest depends_on)
  → create_location_types → create_locations → create_roles
  → create_first_admin → seed_number_sequences
  → record_review_gates → enter_pilot
  → import_opening_state            (optional; §1.7 — required for any tenant with existing books)
  → activate
```

- **`apply_jurisdiction_pack` is new and was a hole.** `assign_jurisdiction` set a code and nothing
  ever applied the pack, so a tenant reached its first taxed sale with no rate rows. Per §7.1 the
  tenant's *applied* rate rows are ordinary tenant-owned rows that someone must create; this step
  creates them from the pinned `pack_version`, records the application in
  `app.tenant_pack_application` (same shape and same reasoning as
  `tenant_template_application`), and derives `platform.tenant.currency_code` and `money_scale`
  from the pack. It runs before any module, because a template's `tax_code` references resolve
  against the applied pack.
- **Idempotent by construction.** Template steps rely on `app.template_row_claim` (§1.6).
  Non-template steps are **insert-or-skip on a natural key, never upsert**. The first version said
  "upsert", which means a resumed run after an operator renamed a location would overwrite the
  rename — the same failure the applier's never-UPDATE rule exists to prevent, arriving through a
  different door. Re-running a completed step is a no-op, not an error, because the recovery
  procedure must not require anyone to reason about which steps already ran.
- **Resumable.** Resume skips `complete`, retries `failed`, and reclaims `running` steps whose
  lease has expired. A crash mid-run is an operational nuisance, not a corrupt tenant.
- **A tenant in `provisioning` cannot issue a sync token.** A half-built tenant never reaches a
  device. This is the property that makes retrying safe.
- **Abandonment is a first-class exit.** `provisioning → abandoned` runs the §1.7 deletion
  machinery. This is the direct answer to "partially-provisioned tenants are otherwise impossible
  to clean up": they are cleaned up by the same code that offboards a real customer, which means
  it is exercised regularly rather than being emergency-only code.
- `seed_number_sequences` creates the per-tenant, per-location, per-device `app.sequence_block`
  allocations of §3.7.5, since jurisdiction packs impose numbering rules and offline allocation
  needs location-prefixed blocks. Shape belongs to `sync-architect` and `compliance-gatekeeper`;
  existence belongs here.

### The review gates, shown rather than asserted

The first version said *"`record_review_gates` writes a `platform.tenant_gate` row per required
approval… `activate` refuses while any required gate is unsatisfied… A human gate that the software
can skip is not a gate."* It gave no table shape, no definition of what satisfies a gate, no signer
identity, no artefact, and no separation between the person running the provisioning run and the
person approving it. A gate any operator can flip with an `UPDATE` is not a gate either, and this
is the one place the section stopped showing how.

```sql
select app.new_tenant_table('tenant_gate', $$
  gate_key       text        not null,     -- 'coa_structural_review', 'statements_review',
                                           -- 'jurisdiction_confirmation'
  blocks_state   text        not null,     -- the transition this gate blocks: 'pilot' | 'active'
  required       boolean     not null,
  approver_role  text        not null,     -- 'accountant' | 'tax_professional'
  evidence_ref   text,                     -- MANDATORY to satisfy: the signed artefact
  satisfied_at   timestamptz,
  satisfied_by   uuid,                     -- platform.operator or an external approver identity
  witnessed_by   uuid,                     -- second person; NOT the run's started_by
  notes          text,
  constraint gate_satisfied_is_complete check (
    satisfied_at is null
    or (evidence_ref is not null and satisfied_by is not null and witnessed_by is not null))
$$);

create unique index tenant_gate_uq on app.tenant_gate (tenant_id, gate_key)
  where deleted_at is null;
```

Rules, enforced in the transition function rather than in a screen:

- `satisfied_by` may not equal `provisioning_run.started_by`, and `witnessed_by` may equal neither.
  Two people, neither of them the operator driving the run.
- `evidence_ref` is mandatory and resolves to a stored, hashed artefact — the accountant's signed
  review, the tax professional's confirmation. A gate satisfied with no artefact is a gate that was
  not satisfied.
- The transition function refuses `→ pilot` or `→ active` while any `required` gate with the
  matching `blocks_state` is unsatisfied, and the run sits in `blocked`.

**The gates split in two, because `CLAUDE.md` §2.8 asks for two things.** It requires the
accountant to review *"the chart of accounts, the double-entry logic, and at least one full month of
generated statements"*. The first two can be reviewed before any trading; the third cannot exist
before trading. So:

| Gate | Blocks | What satisfies it |
|---|---|---|
| `coa_structural_review` | `→ pilot` | A qualified accountant's signed review of the applied chart of accounts and the posting rules, against manual expectations on worked examples. |
| `jurisdiction_confirmation` | `→ pilot` | A qualified local professional confirms the applied pack — §7's gate G2 series. |
| `statements_review` | `→ active` | A qualified accountant reconciles **one full month of statements generated from real `pilot` trading** against manual expectations. |

The residual risk is stated rather than engineered away: a tenant in `pilot` posts a month of real
transactions against a chart of accounts that has passed a structural review but not a statements
review. That is why the structural gate is first and why `pilot` refuses period close and statutory
filing — the month is reviewable and correctable before anything is locked or filed. Whether that
is an acceptable substitute for §2.8's literal reading, or whether the month should instead be
generated in a sandbox tenant on synthetic data (a weaker gate, because synthetic data does not
surprise anyone), is a question for the reviewing accountant, not for me. **Q-TEN-2**.

Tenant #1 is provisioned through this path with no manual step. If Agyasei needs one, the product
has a gap and customer two finds it.

---

## 1.9 Boundaries with other sections

| Concern | Owner |
|---|---|
| `tenant_id` propagation, RLS policy text, sync-rule tenant predicate | `rbac-security-engineer` (§1.3 is the mechanism we jointly hold) |
| Token TTL, device enrolment and revocation, **the offline lease and the seal** | `rbac-security-engineer` (§2.7) — §1.2 consumes it and defines nothing of its own |
| Sync-rule expressiveness for `location_closure`; bucket re-keying on placement change; the tenant-liveness join in every parameter query | `sync-architect` (§3.2.3, §3.11.8) |
| `write_log`, HLC stamping, `device_write_watermark`, attestation | `sync-architect` (§3.3, §3.4, §3.11) |
| The universal row, `new_tenant_table`, the CI assertion set | this section + §4.2 (§4 owns the row shape; §1 owns the registry and the tenancy assertions) |
| CoA template contents, posting rules, the opening journal entry | `ledger-engineer` (§5) |
| Jurisdiction pack contents, pack application, the confirmation gate | `compliance-gatekeeper` (§7) |
| Read-path isolation tests, fixture tenant pair, the two-tenant sync-rule fixture | `tenant-isolation-test-engineer` |

---

## 1.10 Concerns and open questions

**C1 — RLS does not cover the path that matters.** `ADR-0005` treats RLS as the backstop that makes
a forgotten predicate fail closed. It does, for application queries. It does **not** apply to
logical replication, which is how the sync service reads Postgres — so on the one path where data
leaves the server for a stealable device, tenant isolation rests entirely on sync-rule
configuration with no database-level backstop at all. I am not proposing we relitigate the shared
schema; I am proposing the ADR's "belt and braces" claim be narrowed in writing, and that sync
rules get a compensating control of equivalent rank: a two-tenant fixture and an automated test
asserting that tenant B's rows never appear in any bucket tenant A's device subscribes to, run in
CI on every sync-rule change. §4.17.5 reaches the same conclusion independently, and §2's Concern 1
is the same finding from the security side. **This is carried into the phase gate as a blocking
item, not an open question.** Owner: `sync-architect` + `rbac-security-engineer` +
`tenant-isolation-test-engineer`.

**C2 — "A configuration change rather than a rewrite" oversells the placement indirection.**
`ADR-0005` is right that the lookup is nearly free and right that we should build it. But promotion
still means a database-level write freeze, a bespoke copy-and-checksum job, a sync-service cutover,
a replicated `app.tenant_local_state` and permission function on the new cluster, an auth callback
that does not go away, and a full device resync over Ghanaian mobile data. The indirection makes
promotion a **scheduled migration** instead of a re-architecture, which is worth the cost — the
ADR's phrasing just sets an expectation the mechanism will not meet on the day. Suggest amending
the consequence.

**C3 — The suspension and offboarding windows are commercial and legal, not engineering.**
`NEEDS-HUMAN` — founder plus whoever owns contracts. Three numbers and one policy question, and the
shape has changed since the first draft: the invented 7 / 14 / 30 triple is gone, because §2.7's
offline lease now does the device-side work. What remains genuinely open is **(a)** the lease
ceiling applied to a suspended tenant (default 72 h + 24 h; platform maximum 14 days), **(b)** the
`drain_deadline` for offboarding — how long we hold a departing customer's export open waiting for
dark tablets, and **(c)** whether a `device_purge_after` should exist at all. Promoted as
**Q-TEN-1**, and `open-questions.md` **Q14** needs updating: its current text describes the
withdrawn 7/14/30 mechanism.

**C4 — The deletion promise versus backup retention.** We can prove the primary database is clean.
We cannot expunge point-in-time backups without destroying every other tenant's recovery point.
The certificate states the aging-out date honestly, but whether that satisfies a customer's — or a
regulator's — expectation of deletion is a legal question, not an engineering one. `NEEDS-HUMAN`;
already carried in **Q14**.

**C5 — Q7 blocks the catalogue template, not just the SKU schema.** Unit conversion factors
(kg per 12 m length by rebar diameter; ton per trip load for sand and gravel) are template rows.
`open-questions.md` Q7 needs the founder's numbers before the catalogue module can ship, and a
template that ships wrong conversion factors is the §1.6 remediation case on day one.

**C6 — `origin_ref` is a loaded gun kept for good reasons.** Retaining it is what makes template
defect remediation possible at all. It is also exactly the handle someone will reach for when a
posting rule needs to know "is this the cement revenue account". §1.6 now enforces it as a
**package boundary** checked by the dependency graph rather than a lint exception, which is the
form that cannot be waived in a file. Still worth a specific line in the review checklist.

**C7 — Tenant-owned user identity has a product cost, and it is the right trade.** §1.1 rules that
there is no `platform.user`: a human working for two tenants has two accounts and two logins, and a
future group customer wanting single sign-on across subsidiary tenants cannot have it without a
federation layer we have not built. I am confident this is right — a global identity is a permanent
cross-tenant join surface and account recovery on a global email runs *outside* the RLS boundary —
but it will be argued with by the first multi-entity customer, and the answer should be a designed
federation layer rather than a quiet global user table. Recorded so the argument starts from the
reasoning rather than from the inconvenience.

**Q-TEN-1 — Does a suspended or departed tenant's local device copy ever get destroyed?**
`NEEDS-HUMAN` · founder + contracts + legal · **promote to `open-questions.md`, and revise Q14,
whose current text describes the withdrawn 7/14/30 mechanism.** §1.2 builds no `device_purge_after`:
a suspended or departing tenant's tablets seal under §2.7 (unreadable, outbox preserved) and are
never wiped by us. That is deliberate — the alternative destroyed twelve trading days of a paying
customer's sales on an ordinary offline path. If commercial or legal policy requires eventual
destruction, it needs (i) a named window, (ii) an explicit rule that the purge is refused unless the
device's `device_write_watermark.contiguous_through` covers its last local write, and (iii) an
accepted answer for the device that never reconnects and therefore can never be safely purged.
Alongside it: the suspended-tenant lease ceiling and the offboarding `drain_deadline`.

**Q-TEN-2 — Is a month of real `pilot` trading an acceptable basis for §2.8's statements review?**
`NEEDS-HUMAN` · reviewing accountant (still unnamed — `open-questions.md` **Q6**) · **promote to
`open-questions.md`.** §1.1 adds a `pilot` state so that §2.8's "one full month of generated
statements" is satisfiable at all; §1.8 splits the gate so the structural review of the chart of
accounts blocks entry to `pilot` and the statements review blocks entry to `active`. The residual
risk is that a month of real transactions posts against a chart that has passed a structural review
but not a statements review. The alternative — generating the month in a sandbox tenant on synthetic
data — is a weaker gate, because synthetic data does not surprise anyone. Which one the accountant
will sign is their call, and it lands on tenant #1's 1 August 2026 go-live either way.

**Q20 needs extending.** `open-questions.md` Q20 (opening balances) covers the GL half, raised by
§5.14.6 #27. §1.7's `import_opening_state` shows the same cut-over also carries **opening stock per
location, existing customers, and their outstanding credit positions and ageing** — all of which
need the same cut-off date, the same preparer and the same signature.

---

## 1.11 Naming reconciliation and cross-section rulings

§4.17.5 #27 names naming divergence as a **Phase 0 exit condition**, and this section had added a
third set of names. §3.11.9's rule governs: **singular, as defined in §4.** Where this section held
a different name, §4's wins; where this section is the owner per §4.1, the ruling is made here and
the other section cross-references it.

| Was, in §1 | Canonical | Note |
|---|---|---|
| `app.location_ancestor` | **`app.location_closure`** `(tenant_id, ancestor_id, descendant_id, depth)` | §2.5's name and columns. §3's sync rules say `locations`; §3.11.9 already rules that plural to `app.location`. |
| `location.status text` | **`is_active`, `opened_on`, `closed_on`** | §4.3. |
| `location_type.holds_stock` / `sells` | **`location.kind`, `is_trading`, `is_postable_location`** | §4.3, §4.7.3, §5.6.3, §5.14.5. |
| `sale.occurred_at` | **`hlc`** on the base row; `device_wall_at` is the untrusted device time | §3.4.2, §3.11.9, §4.2.1. |
| `sale.idempotency_key` | **`write_id`** → `app.write_log.id` | §3.3.2, §4.2.2, §4.17.5 #2. |
| `platform.tenant_placement` vs §4.3's `platform.tenant_database` | **`platform.db_cluster` + `platform.tenant_placement`** | §1.4; §4.3's single table had no cluster registry and inlined a DSN per tenant. |
| §3's `tenant_membership` | a projection of **`app.user_account`**, not a table | §1.1. |

**Cross-section rulings made here** (this section is the owner per §4.1's owner column):

| Contested | Ruling | Consequence elsewhere |
|---|---|---|
| `platform.tenant` shape | §1.1 is the single definition: `slug`, `legal_name`, `platform.tenant_state` enum, `jurisdiction_code char(2)` → `platform.jurisdiction`, plus `currency_code` / `money_scale` derived from the pack | §4.3 cross-references §1.1; its `jurisdiction_id uuid`, `code`, `name`, `status text` are the same columns renamed |
| `platform.tenant.template_id` | **Deleted.** A live pointer from a tenant to a template, and unable to express multi-template, multi-version reality | §4.3 drops the column; `app.tenant_template_application` is the single provenance record |
| FK from `app` to `platform` | **Deleted everywhere**, including `write_log`'s `REFERENCES platform.tenant(id)` and `role_permission`'s to `platform.permission`. Replaced by `app.tenant_local_state` and a generated `app.permission_codes()` | §3.3.2 and §4.2.2 drop the `REFERENCES platform.tenant(id)` clause; a foreign key cannot cross databases and promotion requires that it can |
| Tenant-keyed `platform` tables | Provisioning, gates and template provenance **move to `app`**. `platform` keeps three named exceptions with written reasons | §4.1's Platform group loses them |
| Tenant liveness in sync rules | Every parameter query joins `app.tenant_local_state` and requires `state IN ('pilot','active','migrating')` | §3.2.3's rules file — the same symmetry argument §3 already made for user liveness |
| Migration write freeze | Enforced by a `before insert` trigger on `app.write_log`, not by a term in the RLS policy | §4.2.5's policy-expression assertion stays exactly as written |

**Recommended to §4, not ruled here:** `app.current_tenant()` should **raise** on an unset GUC
rather than return `NULL`. §4.2.5's CI assertion pins the policy expression text, not the function
body, so the change is one line and breaks nothing. The reason is §1.7: an unset GUC under the
permissive form yields zero rows, which is not "fails closed" but "fails quiet", and quiet is how
you sign a checksummed, complete, **empty** export of a departing customer's books. §4 is
authoritative; §1.7's RLS-bypassed count check makes the export safe whichever way §4 decides.

---

## 1.12 Revisions from adversarial review

Reviewed 2026-08-21 against `CLAUDE.md`, `ADR-0004`/`0005`/`0006`/`0007`, and the authoritative
rulings in §2.7/§2.8, §3, §4 and §5. Twenty-eight findings: seven blocking, thirteen major, eight
minor. **Where this subsection and the body above differ, this subsection governs.**

### 1.12.1 The pattern behind the blocking findings

Five of the seven came from one cause, and it is not subtle: **this section was written before §3,
§4 and §5 were revised, and was never re-read against them.** §1.3 — the normative codegen exemplar
that every table in the system is generated from — emitted a per-table `idempotency_key`, no
`write_id`, a `text` HLC, non-partial uniques and a policy expression that fails §4's own CI guard.
Because it is codegen, each of those defects would have been replicated across every table in the
schema, and the guard that was supposed to catch them was the pre-correction version §4.2.5 had
already dismantled.

The other two came from a different habit and it is the one worth watching: **arguing a position
well and then building a mechanism that contradicts the argument.** §1.2 opens by rejecting "wipe
the tablets immediately" because it *"makes the platform the cause of data loss"* — and then
specifies a seal that discards the local encryption key, which is that, with a slower fuse. The
prose was the strongest in the document set and the mechanism underneath it destroyed a paying
customer's sales on an ordinary offline path. A section that argues better than it builds is harder
to review than one that does neither, because the reviewer relaxes.

The corrective discipline is the same one §4.17.1 wrote down: **one table, one owner, a
cross-reference rather than a second definition** — and one addition of my own: *if a subsection
states a principle, the next paragraph must be checkable against it.*

### 1.12.2 Mechanisms added or replaced

| Mechanism | Purpose | Where |
|---|---|---|
| `pilot` lifecycle state | §2.8's month of statements was unsatisfiable; there was no state in which trading happened before `active` | §1.1, §1.8 |
| `app.tenant_local_state` | one local projection per cluster: sync-rule tenant liveness, the write freeze, the money scale offline, and the removal of every `app → platform` FK | §1.4 |
| `write_log` freeze trigger | freezes *every* writer including background jobs, at the chokepoint the composite FK already forces | §1.4 |
| Per-table content checksum over `(id, write_id, hlc, updated_at, deleted_at)` | counts are not content; an `UPDATE` after the copy left a green verification on a corrupt book | §1.4 |
| Migration lease, alert and automatic abort | `migrating` had no timeout and one exit, so an orchestrator crash froze a tenant indefinitely | §1.4 |
| `app.template_row_claim` | idempotency that survives the tenant deleting a seeded row, without violating §4.2.4 | §1.6 |
| Deterministic `write_log` row per module application | seeded rows were unattributable and violated §4.2.3's base contract | §1.6 |
| `seedable` in the registry | the provenance columns §1.6 leans on had no declared home | §1.3, §1.6 |
| Export drain gate on §3.11.4 attestation | an export could be produced and signed while 25 tablets held the week's sales | §1.7 |
| Export verification under `platform_admin`, RLS bypassed | deletion was verified correctly and export was not verified at all | §1.7 |
| Manifest unit dictionary + NDJSON + money-as-strings | `total_minor = 452500` is meaningless without the scale; CSV erases NULL and turns money into floats | §1.7 |
| `import_opening_state` | a departing customer had a first-class export; an arriving one had nothing | §1.7 |
| `apply_jurisdiction_pack` step | `assign_jurisdiction` set a code and nothing created the tenant's rate rows | §1.8 |
| `app.tenant_gate` with `evidence_ref`, `satisfied_by`, `witnessed_by` | a gate an operator could satisfy with an `UPDATE` is not a gate | §1.8 |
| Branded `TenantId`, `app.set_tenant()` set-once, CI assertion §1-E | RLS trusts the GUC absolutely, and a lint rule is a config file | §1.3 |
| CI assertions §1-A … §1-F | §4.2.5's set plus the six tenancy assertions §4 does not have | §1.3 |

### 1.12.3 Full disposition

| # | Finding | Sev | Disposition |
|---|---|---|---|
| B1 | Sealing discards the local encryption key; destroys unsynced sales; contradicts §2.7/§3.1.7 | Blocking | **Accepted.** §1.2 rewritten. Suspension defines no device mechanism at all; §2.7's lease decay does the work and its seal semantics are adopted verbatim — key dropped, database and outbox preserved, reopened by any successful server authentication. `device_purge_after` deliberately not built, and gated on a watermark check if it ever is. |
| B2 | `not_after` conflates token TTL with the seal date; the offline-lease premise is wrong | Blocking | **Accepted.** `not_after` deleted. §2.7 owns the lease (`full_until` → `hard_stop_at` → sealed, 14-day ceiling, monotonic + backwards-jump enforcement). Suspension is expressed as "no further lease is issued", not as a new client-side clock. |
| B3 | The drain gate cannot be built on a client-asserted logical timestamp | Blocking | **Accepted; different mechanism.** The reviewer's repair — corroborating against the device's pre-suspension `device_write_watermark` — does not work: an unapplied write is by construction *above* `contiguous_through`, so the watermark separates replays from new writes, not old from recent. The server cannot know when an offline write was created, and §1.2 now says so. Ruling: **never refuse an upload for a live tenant**; mark a write as suspended-period iff `write_log.received_at > tenant.suspended_at`, which is server-owned on both sides and needs no new column. The commercial question is answered by a flag and an invoice. |
| B4 | Offboarding from `active` rejects every unsynced write, exports before draining, seals nothing | Blocking | **Accepted, one sub-item rejected.** Entering `offboarding` now stamps `offboarding_started_at` and `drain_deadline` (CHECK-enforced) and stops lease issuance, so devices seal exactly as in suspension; uploads are accepted throughout; and §1.7 adds the ordering gate — export blocks on §3.11.4 attestation from every active device, or on `drain_deadline` with `undrained_devices[]` named in the manifest and the certificate. **Rejected:** routing `offboarding` only via `suspended`. A customer who paid and left would then have "suspended" in a transition log that gets read under pressure. |
| B5 | §1.3's codegen exemplar emits the schema §3 and §4 were revised to eliminate | Blocking | **Accepted, all six.** Regenerated against §4: `app.new_tenant_table` + `tenant_row_base` (so `write_id`, `hlc`, `created_at`/`updated_at`/`deleted_at` are unforgettable), `write_log` as the sole idempotency registry, `app.hlc` not `text`, partial uniques on `deleted_at IS NULL`, and the canonical `(tenant_id = app.current_tenant())` policy. The registry emits calls to §4's helper, not competing DDL. |
| B6 | Layer 3 is the pre-correction CI guard §4.2.5 already found broken | Blocking | **Accepted.** The six-rule list is replaced by a pointer to §4.2.5's assertion set (policy-expression check, `relkind IN ('r','p','v','m')`, `has_write_id`, inverted numeric rule, per-assertion exemptions in a checked-in versioned file, `has_tenant_id`/`rls_forced` never exemptible), plus six §1-specific assertions: registry membership, lifecycle-and-reconstruction, composite FK, no cross-schema FK, one GUC minter, and the three-entry `platform` exemption list. |
| B7 | The location model cannot represent TRANSIT and puts platform-branching capability on a tenant-editable row | Blocking | **Accepted.** `holds_stock`/`sells` deleted from `location_type`; §4.3's `location.kind` closed enum (`OUTLET`/`WAREHOUSE`/`GROUP`/`TRANSIT`) plus `is_trading` and `is_postable_location` adopted; `status text` replaced by `is_active`/`opened_on`/`closed_on`; `depth` moved to the closure table. The *argument* — types are vocabulary with no ordering — is kept, because §4.3 makes the same argument about `location.kind` and it is right. |
| M1 | Two conflicting `platform.tenant` definitions; §1's omits the money scale | Major | **Accepted.** One definition in §1.1 per §4.1's ownership column, carrying `currency_code`/`money_scale` derived from the pack (§4.17.5 #22), `jurisdiction_code char(2)` → a now-defined `platform.jurisdiction`, and the state enum + transition table. §4.3's `template_id` deleted as a live-inheritance handle. Naming in §1.11. |
| M2 | Template idempotency breaks against soft deletes; the provenance key omits the version | Major | **Accepted, both.** `app.template_row_claim` separates the claim from the row it claims and is never soft-deleted, so a re-run is a genuine no-op whether or not the tenant deleted the seeded row — without violating §4.2.4. `tenant_template_application` is re-keyed on `(tenant_id, template_id, template_version, module_key)` and gains a verification pass writing `last_verified_at`/`verified_row_count`. |
| M3 | The applier writes no `write_log` rows, so every seeded row violates the base contract | Major | **Accepted.** One `write_log` row per module application, `origin='SERVER'`, deterministic `write_id = uuidv5(ns, tenant:template:version:module)` per §3.11.7; every materialised row carries it. `seedable: true` in the registry emits the three provenance columns and the claim relationship. |
| M4 | Export under-specified: no unit dictionary, wrong format, never verified, `derived` unguarded | Major | **Accepted, all four.** Manifest carries currency, `money_scale`, `rate_scale`, per-UoM quantity scales, UoM conversion factors, §4.13's rounding list and a registry-generated per-column type/unit dictionary. Format is NDJSON with money and quantity as integer strings (2^53), the accountant form being the only spreadsheet artefact. Export counts verified under `platform_admin` with RLS bypassed before the manifest is signed. `carry` is the default and cannot be omitted; `derived` requires a named reconstruction function exercised by a rebuild-and-diff test. `write_log`, `conflict_review` and `sequence_block` explicitly classified. |
| M5 | `device_write_watermark` classified `derived` silently double-posts revenue | Major | **Accepted.** Classified `carry` by name, with `write_log`, `device_sync_state`, `sequence_block`, `conflict_review`, `row_version`, `template_row_claim`, `tenant_template_application` and `tenant_gate`. General rule stated: *anything whose absence changes whether a replayed write is applied is `carry`, however derived it looks.* |
| M6 | Promotion verifies by row count and freezes only the device upload path | Major | **Accepted; different mechanism for the freeze.** The reviewer's `write_frozen` term in the RLS `WITH CHECK` is **rejected** because §4.2.5 assertion (2) requires the policy expression to be *exactly* `(tenant_id = app.current_tenant())` — a second term fails §4's own guard on every table. Instead the freeze is a `before insert` trigger on `app.write_log`, the chokepoint §4.2.2's composite FK already forces every write through, so background jobs, accruals, close entries and support scripts all fail closed. Verification becomes a per-table digest over `(id, write_id, hlc, updated_at, deleted_at)`. Migration lease, alert and automatic abort added. |
| M7 | Cross-schema FKs to `platform` contradict the promotion story | Major | **Accepted.** All `app → platform` FKs deleted, including `write_log`'s; `role_permission` gains a CHECK against a generated versioned `app.permission_codes()` plus a CI assertion. CI assertion §1-D forbids the class. §1.4 states plainly that a promoted cluster requires `app.tenant_local_state` and the permission function to be replicated to it, and that auth still calls back to `platform` at token issue. |
| M8 | `platform` holds tenant business data with no `tenant_id` discipline and a blanket exemption | Major | **Accepted.** `provisioning_run`, `provisioning_step`, `tenant_template_application` and `tenant_gate` move to `app` — RLS, `write_id`, registry membership, export and deletion for free. The blanket exemption is replaced by three individually justified entries (`tenant`, `tenant_placement`, `tenant_state_transition`) in the checked-in exemption file, asserted at exactly three by CI (§1-F). `provisioning_step.error text, result jsonb` replaced by a closed `error_code`, an `error_count` and a schema-validated `result_summary`; offending rows stay in the tenant-scoped import staging tables. |
| M9 | `withTenant` takes a `uuid` guarded by a lint rule; RLS trusts the GUC absolutely | Major | **Accepted, both halves.** Branded `TenantId` with exactly one constructor in the `auth` package, enforced by the dependency-graph check as well as the type. `app.set_tenant()` is `SECURITY DEFINER`, raises if `app.tenant_id` is already set in the transaction (set-once), always `LOCAL`, and CI assertion §1-E fails the build on any other `set_config`/`SET LOCAL app.tenant_id`. §2.8's support grant calls the same function. |
| M10 | Review gates asserted, not shown; §2.8's month-of-statements gate unsatisfiable | Major | **Accepted, and the gate split.** `app.tenant_gate` given a full shape with mandatory `evidence_ref`, `satisfied_by` ≠ the run's `started_by`, and a distinct `witnessed_by`, enforced in the transition function. A `pilot` lifecycle state is added so the month of statements is real data; §2.8's single requirement becomes two sequenced gates — structural review of the CoA blocks `→ pilot`, statements review blocks `→ active`. Residual risk stated, not engineered away, and referred to the reviewing accountant as **Q-TEN-2**. |
| M11 | The section never defines the user↔tenant relationship | Major | **Accepted.** §1.1 rules that identity is tenant-owned: `app.user_account`, email unique per tenant, no `platform.user`, two accounts for a human serving two tenants, platform operators reached only through §2.8's grant. §3's `tenant_membership` named as the projection. The product cost is recorded as C7. |
| M12 | Suspension propagates at token TTL when it could propagate at connection time | Major | **Accepted.** Every sync-rule parameter query gains a join to `app.tenant_local_state` requiring `state IN ('pilot','active','migrating')` — §3's own symmetry argument, applied to the tenant as it already was to the user. Carried to §3.2.3 in §1.11. |
| M13 | No path for a tenant that already has books | Major | **Accepted.** `import_opening_state` added to §1.7 and to the step list, using the export's manifest contract in reverse with a staging-map-validate-post shape and one server-derived `write_log` row. `apply_jurisdiction_pack` added to the step list — `assign_jurisdiction` set a code and nothing ever created the tenant's applied rate rows. Q20 flagged for extension beyond the GL half. |
| N1 | A third naming convention, against a Phase 0 exit condition | Minor | **Accepted.** §1.11 reconciles seven names against §3.11.9's rule. |
| N2 | Late module application can half-apply | Minor | **Accepted.** A module application is exactly one transaction; unresolvable refs abort it with every offending ref named. |
| N3 | `create_locations` "upserts" while the applier never UPDATEs | Minor | **Accepted.** Non-template steps are insert-or-skip on a natural key; a resumed run cannot overwrite an operator's rename. |
| N4 | Template files must be retained across releases | Minor | **Accepted.** Every published version ships in every subsequent release, content-addressed and resolvable by the remediation tooling through `platform.template_catalogue`; dropping a version tenants still hold rows from fails CI. |
| N5 | A full-tenant export in one transaction is a noisy neighbour | Minor | **Accepted.** Repeatable-read snapshot on the cluster's replica, `pg_export_snapshot` to parallel readers, LSN recorded in the manifest. Where no replica exists the cost is accepted and logged, not hidden. |
| N6 | `platform_admin` with `bypassrls` needs reconciling with §2.8 | Minor | **Accepted.** Stated as non-interactive and job-only with no human login; humans use §2.8's `platform_support_grant`. "Audited" made mechanical: `platform.privileged_job_run` plus `audit_event` rows in the tenant's own trail. |
| N7 | The `origin_ref` lint exception is a config carve-out | Minor | **Accepted.** Replaced by a package boundary — `@platform/provenance`, which no business-logic package may import, enforced by the dependency-graph check. |
| N8 | Slug reuse | Minor | **Accepted.** One explicit sentence added in §1.1: the surviving tombstone row *is* the reservation, for both id and slug, and the reasoning is the same one level up. |
| — | `app.current_tenant()` should raise on unset rather than return `NULL` | Reconciliation | **Recommended to §4, not ruled here.** §4 is authoritative; §4.2.5's assertion pins the policy text, not the function body, so it is a one-line change. Independent of the outcome, §1.7's export now verifies its counts under `platform_admin` with RLS bypassed, so the empty-export failure is caught either way. |

### 1.12.4 Sound findings retained unchanged

The review confirmed and I have not touched: the composite `(tenant_id, id)` primary key and
composite foreign keys; `force row level security` and the `nosuperuser nobypassrls` application
role; the refusal to reuse a tenant id after offboarding and the reason given; `jurisdiction_code`
immutable after provisioning; the deletion-verification trap and its resolution; no live
inheritance, no "reset to template", the applier never UPDATEs, and the honest statement of the
cost; no platform-global product table; `permission` as a platform code list; and C1's compensating
control, which is now carried into the phase gate as a blocking item rather than an open question.

### 1.12.5 Still open after this pass

`Q-TEN-1` (does a sealed local copy ever get destroyed; the suspended-tenant lease ceiling; the
offboarding drain deadline) and `Q-TEN-2` (whether a month of real `pilot` trading satisfies §2.8's
statements review) are both `NEEDS-HUMAN` and are promoted to `open-questions.md`. `Q14` needs
rewriting — its text describes the withdrawn 7/14/30 mechanism. `Q20` needs extending beyond the GL
to opening stock, customers and outstanding credit positions. `Q6` (the reviewing accountant is
still not named) now blocks `Q-TEN-2` as well as everything it already blocked. `Q7` still blocks
the catalogue template module, not merely the SKU schema.
