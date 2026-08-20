# 1. Tenancy Model and Isolation

**Implements:** `ADR-0005` (shared schema, RLS, tenant-scoped sync) · `ADR-0006` (Agyasei is a
template) · `ADR-0007` (one jurisdiction per tenant) · `CLAUDE.md` §2.1, §2.9

This section defines what a tenant *is*, how one comes into existence and leaves, and the
machinery that makes `tenant_id` structurally unforgettable rather than a thing reviewers catch.
It does **not** define the role model or the sync rules — `rbac-security-engineer` and
`sync-architect` own those, and the boundary between us is named in §1.9.

Two schemas, and the split is load-bearing:

- **`platform`** — the tenant registry, database placement, jurisdictions, the permission
  vocabulary. Not tenant-owned. Exempt, by an explicit list in code, from every rule in §1.3.
- **`app`** — every tenant-owned table. No exceptions, no exempt list, no discretion.

Anything in `app` without a `tenant_id` is a bug that fails CI. Anything in `platform` is
reviewed by a human on every migration, because that is where a mistake does not fail CI.

---

## 1.1 The tenant entity

```sql
create schema platform;
create schema app;

create type platform.tenant_state as enum (
  'provisioning',   -- registry row exists; no user can sign in, no device can sync
  'active',         -- trading
  'suspended',      -- non-payment or dispute; see §1.2
  'migrating',      -- write-frozen while being moved between clusters (§1.4)
  'offboarding',    -- export produced, deletion scheduled
  'offboarded',     -- tombstone; app data gone
  'abandoned'       -- provisioning never completed; deleted by the same machinery
);

create table platform.tenant (
  id                      uuid        primary key,          -- uuidv7, server-generated
  slug                    text        not null unique,       -- 'agyasei-jnr'; URLs, export filenames
  legal_name              text        not null,
  state                   platform.tenant_state not null default 'provisioning',
  jurisdiction_code       text        not null references platform.jurisdiction (code),
  created_at              timestamptz not null default now(),
  activated_at            timestamptz,
  suspended_at            timestamptz,
  suspension_reason       text,
  upload_drain_until      timestamptz,   -- frozen onto the row at suspension (§1.2)
  device_seal_after       timestamptz,   -- frozen onto the row at suspension (§1.2)
  offboarding_started_at  timestamptz,
  offboarded_at           timestamptz,

  constraint tenant_active_has_activation
    check (state <> 'active' or activated_at is not null),
  constraint tenant_suspension_windows
    check (state <> 'suspended'
           or (suspended_at is not null
               and upload_drain_until is not null
               and device_seal_after is not null))
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
provisioning → active | abandoned
active       → suspended | migrating | offboarding
suspended    → active | offboarding
migrating    → active
offboarding  → offboarded
abandoned    → (deleted, tombstone retained)
```

Note what is missing: nothing returns from `offboarded`, and `suspended` cannot go straight to
`provisioning`. Re-onboarding a returning customer is a new tenant id. Reusing an id after
deletion means a device holding stale local data for that id could rejoin a different company's
tenant — which is precisely the unrecoverable failure `ADR-0005` exists to prevent.

---

## 1.2 Suspension, and what happens to data already on devices

This needs a stated answer because the obvious ones are both wrong.

**"Wipe the tablets immediately"** makes the platform the cause of data loss. A suspended tenant's
tablets are holding sales that have not uploaded yet. Those sales are the tenant's property and
their statutory records. Destroying them over a billing dispute is a worse outcome than the
dispute.

**"Leave the devices alone"** means a tenant who stops paying keeps a full copy of their books —
including every contractor's credit position — on tablets we no longer control, indefinitely.

**"Send a remote wipe command"** is the one that sounds right and isn't. A device we can reach is
a device that is online; the devices we most want to seal are the ones that never come back. A
control that requires connectivity to fire cannot be the control.

### The decision

Suspension is a **three-stage decay driven by timestamps stamped into the sync token**, so it
executes on the device with no connectivity required.

1. **Downloads stop at the next token refresh.** The token-issuing endpoint refuses a tenant whose
   state is not `active`. Existing tokens remain valid until they expire, so suspension propagates
   at the speed of token TTL — a bounded, stated lag (proposed 7 days; `rbac-security-engineer`
   owns the number, since the same TTL governs how long a genuinely offline outlet can trade).

2. **Uploads keep working until `upload_drain_until`** (proposed `suspended_at + 14 days`). The
   upload path checks `state in ('active','suspended')` and, when suspended, accepts writes whose
   logical timestamp precedes `suspended_at` — i.e. work already done — and rejects new ones with
   a distinguishable error the client surfaces as "this outlet is suspended; contact your
   administrator". Draining is deliberate: we want their unsynced sales on the server, because
   that is where they can be exported to them (§1.7).

3. **The local database self-seals at `device_seal_after`** (proposed `suspended_at + 30 days`).
   Every sync token carries `not_after`; the client refuses to open the local SQLite database once
   the wall clock passes the newest `not_after` it has ever seen, and — because a device wall
   clock is not trustworthy (`sync-architect`'s rule) — also once its monotonic uptime counter
   plus last-known-good time crosses it. Sealing discards the local encryption key rather than
   deleting rows; the data becomes unreadable in one operation instead of a long delete that a
   power cut can interrupt.

Re-activation reverses stages 1 and 2 immediately and cannot reverse stage 3: a sealed device
re-syncs from the server. That is fine, because stage 2 already drained the writes.

**What this costs.** A suspended tenant keeps a readable copy of their data on their own tablets
for up to 30 days. We are accepting that in exchange for never being the reason a sale vanished.
A tenant in an actual security dispute (rather than a billing one) needs a shorter window, so the
two windows are per-tenant columns rather than platform constants — set from the commercial plan
at suspension time and frozen onto the row so that changing the default later cannot retroactively
extend a suspension already in flight.

**Open:** the 7 / 14 / 30 day defaults are commercial policy dressed as engineering. See §1.10.

---

## 1.3 Making `tenant_id` structurally unforgettable

`CLAUDE.md` §2.1 requires this be structural, not conventional. Three layers, and each catches
what the one above it misses.

### Layer 1 — tables are declared, not hand-written

There is no hand-written `CREATE TABLE` in `app`. Every tenant-owned table is declared once in a
TypeScript registry; the migration DDL, the TypeScript row type, the export set (§1.7) and the
deletion set are all generated from that single declaration.

```ts
export const sale = tenantTable('sale', {
  columns: {
    location_id:     ref('location'),                  // composite FK, see below
    customer_id:     ref('customer').nullable(),
    receipt_no:      text(),
    total_minor:     money(),                          // bigint — ADR-0004
    occurred_at:     hlc(),                            // logical clock — sync-architect
    recorded_wall_at: untrustedWallClock(),
    idempotency_key: text(),
  },
  uniques: [['location_id', 'receipt_no'], ['idempotency_key']],
  indexes: [['location_id', 'occurred_at']],
  lifecycle: 'carry',                                  // 'carry' | 'derived' — see §1.7
});
```

emits:

```sql
create table app.sale (
  tenant_id        uuid   not null references platform.tenant (id),
  id               uuid   not null,          -- uuidv7, client-generated offline
  location_id      uuid   not null,
  customer_id      uuid,
  receipt_no       text   not null,
  total_minor      bigint not null,
  occurred_at      text   not null,
  recorded_wall_at timestamptz not null,
  idempotency_key  text   not null,
  primary key (tenant_id, id),
  constraint sale_location_fk foreign key (tenant_id, location_id)
    references app.location (tenant_id, id) deferrable initially immediate,
  constraint sale_customer_fk foreign key (tenant_id, customer_id)
    references app.customer (tenant_id, id) deferrable initially immediate
);

create unique index sale_receipt_uq  on app.sale (tenant_id, location_id, receipt_no);
create unique index sale_idem_uq     on app.sale (tenant_id, idempotency_key);
create index        sale_by_location on app.sale (tenant_id, location_id, occurred_at);

alter table app.sale enable row level security;
alter table app.sale force  row level security;
create policy tenant_isolation on app.sale
  using      (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);
```

Four things in that output are doing real work:

- **Composite primary key `(tenant_id, id)`** — required so that foreign keys can be composite.
- **Composite foreign keys `(tenant_id, location_id) → location (tenant_id, id)`** — this is the
  cheapest structural guarantee in the whole design. A sale physically cannot reference another
  tenant's location, because the database will not let it. It costs one extra column in each FK
  index and buys a class of bug that RLS alone does not catch: a query running under tenant A's
  GUC that inserts a row referencing tenant B's id.
- **`force row level security`** — without it the table owner is exempt, and the table owner is
  whoever ran the migration. `enable` alone is a policy that looks present and isn't.
- **`current_setting('app.tenant_id')` without `missing_ok`** — the strict form. If the GUC is
  unset the query **errors**. The permissive form returns `NULL`, the predicate is `NULL`, and the
  query returns zero rows — which looks exactly like "this tenant has no sales" and gets rendered
  as an empty screen or, worse, exported as an empty book. Fail loudly.

Uniqueness is prefixed with `tenant_id` automatically, which is how `CLAUDE.md`'s
"idempotency-key uniqueness is scoped per tenant, never global" stops being something a developer
has to remember. `unique(['idempotency_key'])` in the declaration cannot produce a global unique
index; the emitter has no code path that does that.

### Layer 2 — the connection is never acquired without a tenant

The application database role is created `nosuperuser nobypassrls`. It cannot see through RLS
even if a predicate is forgotten.

There is no exported connection pool. The only way to reach `app` is:

```ts
await withTenant(tenantId, async (tx) => { ... });   // BEGIN; SET LOCAL app.tenant_id = $1; ...
```

`SET LOCAL`, never `SET` — a session-scoped GUC on a pooled connection leaks the previous
request's tenant into the next one, which is the exact failure mode this design exists to prevent.
`tenantId` is a parameter of `withTenant` and its only legitimate source is the verified token,
resolved in middleware. A lint rule rejects any expression that reads a tenant id out of a request
body, query string or header. `ADR-0005` rule 2 is not advice here; there is no function that
accepts one.

### Layer 3 — the catalogue assertion

Codegen makes the right thing easy. It does not make the wrong thing impossible — someone will
eventually write a migration by hand. So a CI test interrogates `pg_catalog` on the migrated
schema and fails the build on any of:

```sql
-- 1. a table in app. with no tenant_id column
-- 2. relrowsecurity = false or relforcerowsecurity = false
-- 3. a unique index whose first key column is not tenant_id
-- 4. a foreign key referencing app.* that does not include tenant_id on both sides
-- 5. a table in app. absent from the codegen registry (so it is in no export or deletion set)
-- 6. a column matching the money/quantity naming rule whose type is not bigint  (ADR-0004)
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
matters. See §1.10.

---

## 1.4 Tenant → database placement

Every tenant resolves to a database through a lookup, today and always, even though every row
currently points at the same cluster.

```sql
create table platform.db_cluster (
  id              text primary key,          -- 'eu-west-1-shared'
  region          text not null,             -- 'eu-west-1'  (ADR-0003)
  dsn_secret_ref  text not null,             -- pointer into the secret store, never a DSN
  sync_service_url text not null,
  accepts_new_tenants boolean not null default true
);

create table platform.tenant_placement (
  tenant_id   uuid primary key references platform.tenant (id),
  cluster_id  text not null references platform.db_cluster (id),
  moved_at    timestamptz not null default now()
);
```

The rule that gives this teeth: **no module imports a connection pool.** `withTenant(tenantId, …)`
resolves placement (cached, invalidated on `moved_at` change), picks the pool for that cluster,
and opens the transaction. A developer writing a query never sees which database they are on, so
there is no code to change when the answer stops being "the same one".

The same indirection carries the sync service URL, because a device on a promoted tenant must
connect to that cluster's sync service — the resolution has to happen at token issue, not just at
query time.

**Promotion, honestly.** `active → migrating` write-freezes the tenant (the token endpoint issues
read-only tokens; the upload path rejects with a retryable error, so devices queue rather than
fail). Copy the tenant's rows, verify counts per table from the registry, flip
`tenant_placement.cluster_id`, invalidate the cache, `migrating → active`. Devices reconnect to
the new sync service and re-key their buckets.

What the indirection buys is that this is a **scheduled migration with a write freeze**, not a
re-architecture. What it does not buy: `platform` stays central, so a promoted tenant still depends
on the shared registry for auth and placement; the copy job is bespoke work; and the devices
resync from zero, which over Ghanaian mobile data at 25 outlets is a real cost, not a footnote.
`ADR-0005` describes promotion as "a configuration change rather than a rewrite" — the second half
is right, the first is optimistic. See §1.10.

---

## 1.5 The configuration model (generalising `ADR-0006`)

Tenant #1's vocabulary appears nowhere in these tables. That is the whole point, and it is worth
being explicit about which platform concept each piece of Agyasei-specific language became.

### Locations, not tiers

```sql
create table app.location_type (
  tenant_id, id,                       -- (via tenantTable)
  code         text not null,          -- tenant's word: 'FLAGSHIP', 'BRANCH', 'DEPOT', anything
  name         text not null,
  holds_stock  boolean not null,       -- capability, not tier
  sells        boolean not null,
  unique (code)                        -- emitted as (tenant_id, code)
);

create table app.location (
  tenant_id, id,
  parent_id        uuid,               -- composite FK to app.location; null at the root
  location_type_id uuid not null,
  code             text not null,
  name             text not null,
  depth            int  not null,      -- maintained, not authored
  status           text not null       -- 'planned' | 'trading' | 'closed'
);

create table app.location_ancestor (   -- closure table, includes self at distance 0
  tenant_id, location_id, ancestor_id, distance int not null,
  primary key (tenant_id, location_id, ancestor_id)
);
```

Three deliberate choices:

- **The hierarchy is arbitrary-depth.** Tenant #1 has region → outlet. A tenant with country →
  region → city → branch → yard is the same schema. Nothing reads `depth = 2`.
- **`holds_stock` / `sells` are capabilities on the type, not a tier ranking.** Agyasei's RDC holds
  stock and sells; a pure warehouse holds and does not sell; a regional office does neither. There
  is no ordering between types, because "Tier 2 outranks Tier 3" is tenant #1's org chart, not a
  platform fact. Grouping nodes are just locations whose type has both flags false.
- **A closure table, not a recursive CTE.** Every scoping question is "is location L within scope
  S", and it is asked in sync rules and permission checks. Sync-rule DSLs do not do recursive CTEs,
  and neither should an RLS predicate evaluated per row. The closure table costs a trigger, write
  amplification on reparenting (rare), and a cycle check on `parent_id` updates; it buys a scoping
  predicate that is a single indexed join everywhere it appears. `sync-architect` needs to confirm
  the shape is expressible in the chosen layer's rule language — this is the one place where
  "arbitrary depth" and "the sync layer's query expressiveness" collide, and I would rather find
  that out in Phase 0.

### Catalogue

`app.product`, `app.product_category`, `app.uom`, `app.uom_conversion` — all tenant-owned, all
`app`. There is **no platform-global product table**. The temptation is a shared barcode/reference
catalogue so tenants in the same trade need not re-enter cement; if we ever build it, it is an
import *source* whose rows are copied into the tenant's own catalogue at import time, never a live
join. A live join means one tenant's correction changes another tenant's price list.

### Roles and permissions — where a platform enum is correct

`permission` lives in `platform` and is a static code list (`pos.sell`, `pricing.override`,
`credit.limit.change`, `stock.adjust`, `gl.review`, …). This is not a contradiction of "nothing
is hard-coded": a permission names a capability *the software has*, and the software's capabilities
are a platform fact. What is tenant-owned is how they are grouped:

```sql
create table app.role            (tenant_id, id, name, is_template_seeded boolean);
create table app.role_permission (tenant_id, role_id, permission_code);   -- FK to platform.permission
create table app.user_role       (tenant_id, user_id, role_id, scope_location_id);  -- null = whole tenant
```

Agyasei's five roles are five rows in `app.role`, editable on day one. `scope_location_id` resolves
through `location_ancestor`. Detail belongs to `rbac-security-engineer`; what matters here is that
the schema has no `role` enum for them to work around.

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
    title: Chart of accounts
    depends_on: []
    rows: coa.csv
  - key: location_types
    title: Location types
    depends_on: []
    optional: true
    rows: location_types.csv
  - key: roles
    title: Roles
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
- **Tax rates.** Those are the jurisdiction pack's (`ADR-0007`). A template may reference a
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
- Every seeded row carries `origin_template_id`, `origin_template_version`, `origin_ref`, with
  `unique (tenant_id, origin_template_id, origin_ref)` as a partial index where `origin_ref` is
  not null. That constraint **is** the idempotency: re-running a module is `on conflict do nothing`.
- **The applier never UPDATEs.** A re-run after a tenant has edited a seeded row changes nothing.
  This is the concrete expression of "no live inheritance" — there is no code path that can
  overwrite a tenant's edit with template content.
- A module may be applied later than onboarding. A tenant that skipped the catalogue and wants it
  in month three runs the same step through the same machinery.

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
create table platform.tenant_template_application (
  tenant_id, template_id, template_version, module_key,
  content_hash text not null, applied_at timestamptz not null, row_count int not null,
  primary key (tenant_id, template_id, module_key)
);
```

A template defect produces an **advisory**: query that table for affected tenants, generate a
per-tenant remediation script, and run it with the tenant's knowledge and consent. Slower than a
version bump. Also the only version that does not silently rewrite a live company's books.

`origin_ref` is retained for exactly this. It is provenance and support metadata. **No business
logic may read it** — a `WHERE origin_ref = 'coa:4010'` in a posting rule is `CLAUDE.md` §2.9
wearing a disguise, and the lint rule that bans tenant-identity branching bans this too, outside
the onboarding and support modules.

---

## 1.7 Export and deletion on a shared schema

`ADR-0005` names these as things that must be built deliberately. Both are driven by the same
codegen registry as the DDL, so a new table joins them automatically — and CI rule 5 in §1.3
fails a table that is in the registry but classified as neither `carry` nor `derived`.

- **`carry`** — the tenant's data. Exported and deleted.
- **`derived`** — reconstructible from `carry` rows: `location_ancestor`, materialised balances,
  sync bucket state. Deleted, not exported. Exporting a closure table to an accountant is noise.

### Export

Two artefacts, because they answer two different questions.

1. **Machine form** — one CSV per `carry` table plus a `manifest.json` (tenant slug, schema
   version, per-table row counts and a sha256, jurisdiction, export timestamp, the template
   applications from §1.6). This is what a competent successor system ingests.
2. **Accountant form** — trial balance, general ledger, customer statements and ageing, stock
   ledger by location, and invoices/receipts in the jurisdiction pack's required format. Because
   "here are 140 CSVs" is not "your books", and `ADR-0005` calls export a promise.

The export job runs under the tenant's GUC through `withTenant`, so RLS is an active check on it
rather than something bypassed for convenience. A cross-tenant row in an export is one of the two
worst bugs this system can have; the export path should be the *most* constrained path, not the
least.

### Deletion

Deletion runs as a distinct `platform_admin` role that has `bypassrls`, whose every use is audited,
and which exists for exactly two jobs: migrations and offboarding.

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
  for billing history and to prove the deletion happened, and the id must never be reused (§1.1).
- `platform.tenant_state_transition` and the deletion certificate.
- **Backups.** Point-in-time recovery retains the deleted rows until the backup window ages out.
  The certificate states the date, rather than claiming an erasure we have not performed.

The certificate reads, in effect: server-side deletion complete on *D*; backups age out by
*D + backup_retention*; enrolled devices self-seal by *D + 30* per §1.2. Three dates, because
there are three copies, and a customer asking "is my data gone" deserves the true answer.

---

## 1.8 Onboarding as a product feature

Provisioning is a durable run of declarative steps, not a script.

```sql
create table platform.provisioning_run (
  id uuid primary key, tenant_id uuid not null references platform.tenant (id),
  template_id text, template_version int, selected_modules text[] not null,
  state text not null,                    -- 'running' | 'blocked' | 'complete' | 'abandoned'
  created_at timestamptz not null default now()
);

create table platform.provisioning_step (
  run_id uuid not null references platform.provisioning_run (id),
  step_key text not null,                 -- 'apply_module:chart_of_accounts'
  state text not null,                    -- 'pending' | 'running' | 'complete' | 'failed'
  attempt int not null default 0,
  lease_expires_at timestamptz,           -- reclaims a crashed 'running' step
  started_at timestamptz, completed_at timestamptz,
  error text, result jsonb,
  primary key (run_id, step_key)
);
```

Steps, in dependency order:

```
create_tenant_record → assign_jurisdiction → create_placement
  → apply_module:*   (one step per selected module, ordered by manifest depends_on)
  → create_location_types → create_locations → create_roles
  → create_first_admin → seed_number_sequences → record_review_gates → activate
```

- **Idempotent by construction.** Template steps rely on the `(tenant_id, origin_template_id,
  origin_ref)` constraint from §1.6. Non-template steps upsert on a natural key. Re-running a
  completed step is a no-op, not an error, because the recovery procedure must not require
  anyone to reason about which steps already ran.
- **Resumable.** Resume skips `complete`, retries `failed`, and reclaims `running` steps whose
  lease has expired. A crash mid-run is an operational nuisance, not a corrupt tenant.
- **A tenant in `provisioning` cannot issue a sync token.** A half-built tenant never reaches a
  device. This is the property that makes retrying safe.
- **Abandonment is a first-class exit.** `provisioning → abandoned` runs the §1.7 deletion
  machinery. This is the direct answer to "partially-provisioned tenants are otherwise impossible
  to clean up": they are cleaned up by the same code that offboards a real customer, which means
  it is exercised regularly rather than being emergency-only code.
- **`activate` is gated.** `record_review_gates` writes a `platform.tenant_gate` row per required
  approval — the accountant's CoA and double-entry review, and the jurisdiction confirmation
  (`CLAUDE.md` §2.8). `activate` refuses while any required gate is unsatisfied, and the run sits
  in `blocked`. A human gate that the software can skip is not a gate.
- `seed_number_sequences` creates per-tenant, per-location receipt and invoice sequences, since
  jurisdiction packs impose numbering rules and offline allocation needs location-prefixed blocks.
  Shape belongs to `compliance-gatekeeper` and `sync-architect`; existence belongs here.

Tenant #1 is provisioned through this path with no manual step. If Agyasei needs one, the product
has a gap and customer two finds it.

---

## 1.9 Boundaries with other sections

| Concern | Owner |
|---|---|
| `tenant_id` propagation, RLS policy text, sync-rule tenant predicate | `rbac-security-engineer` (§1.3 is the mechanism we jointly hold) |
| Token TTL, device enrolment and revocation | `rbac-security-engineer` — §1.2's seal reuses that machinery |
| Sync-rule expressiveness for `location_ancestor`; bucket re-keying on placement change | `sync-architect` |
| CoA template contents and posting rules | `ledger-engineer` |
| Jurisdiction pack contents and the review gate | `compliance-gatekeeper` |
| Read-path isolation tests, fixture tenant pair | `tenant-isolation-test-engineer` |

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
CI on every sync-rule change. Without that, the sync rules are the only layer and they are
configuration. Owner: `sync-architect` + `rbac-security-engineer` + `tenant-isolation-test-engineer`.

**C2 — "A configuration change rather than a rewrite" oversells the placement indirection.**
`ADR-0005` is right that the lookup is nearly free and right that we should build it. But promotion
still means a write freeze, a bespoke copy-and-verify job, a sync-service cutover, and a full
device resync over Ghanaian mobile data. The indirection makes promotion a **scheduled migration**
instead of a re-architecture, which is worth the cost — the ADR's phrasing just sets an expectation
the mechanism will not meet on the day. Suggest amending the consequence.

**C3 — The suspension windows are a commercial decision.** 7-day token TTL, 14-day upload drain,
30-day device seal are engineering-plausible defaults with no commercial mandate. They determine
how long a non-paying customer keeps a readable copy of their books and how much unsynced trade we
guarantee to accept from someone we have suspended. `NEEDS-HUMAN` — founder plus whoever owns
contracts. The columns exist either way; the numbers need an owner.

**C4 — The deletion promise versus backup retention.** We can prove the primary database is clean.
We cannot expunge point-in-time backups without destroying every other tenant's recovery point.
The certificate states the aging-out date honestly, but whether that satisfies a customer's — or a
regulator's — expectation of deletion is a legal question, not an engineering one. `NEEDS-HUMAN`.

**C5 — Q7 blocks the catalogue template, not just the SKU schema.** Unit conversion factors
(kg per 12m length by rebar diameter; ton per trip load for sand and gravel) are template rows.
`open-questions.md` Q7 needs the founder's numbers before the catalogue module can ship, and a
template that ships wrong conversion factors is the §1.6 remediation case on day one.

**C6 — `origin_ref` is a loaded gun kept for good reasons.** Retaining it is what makes template
defect remediation possible at all. It is also exactly the handle someone will reach for when a
posting rule needs to know "is this the cement revenue account". The lint rule covers it; the risk
is that lint rules get exceptions. Worth a specific line in the review checklist rather than trust.
