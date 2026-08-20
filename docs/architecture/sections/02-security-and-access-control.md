# 2. Security, Access Control and the Isolation Boundary

Owner: `rbac-security-engineer`. Depends on `ADR-0005` (shared schema, RLS, tenant-scoped sync),
`ADR-0006` (Agyasei is a template), `ADR-0003` (PWA on low-end Android), `ADR-0004` (money is
`bigint` minor units). Written jointly with `sync-architect` — §2.4 below is not implementable
without the sync rule design, and the sync rule design is not safe without it.

---

## 2.1 Two boundaries, and why they are not the same control

This system enforces two access boundaries. They are routinely conflated, and conflating them
produces a design that is simultaneously too rigid and too weak.

| | **Tenant boundary** | **Role / location boundary** |
|---|---|---|
| Question it answers | Whose books are these? | What may this person do to them? |
| Number of legitimate crossings | **Zero** | Constant — every escalation, every transfer, every HQ report |
| Who may change it | Nobody. Not the tenant admin, not the founder, not us | The tenant, freely, at any time |
| Where it is defined | Platform code and schema | Tenant data (`role`, `role_permission`, `role_assignment`) |
| Failure mode | One distributor reads another's margins, credit book and customer list | An outlet clerk changes a price they shouldn't |
| Recoverable? | **No.** The data is on a tablet in a district town. There is no recall | Yes — revoke, correct, audit, discipline |
| Correct posture | Structural, uniform, untestable-by-configuration | Configurable, additive, auditable |

The consequences of that table run through everything below:

- **The tenant boundary is never a feature.** It has no settings page, no override, no "share with
  partner tenant" story. If a future requirement needs cross-tenant visibility (a franchise group
  wanting consolidated reporting), that is a new tenant with an explicit, server-side, audited
  aggregation job — never a widened predicate.
- **The role boundary is never structural.** `ADR-0006` is explicit: another distributor has a
  different org chart. There is no `role` enum, no `if (role === 'outlet_staff')`, and no platform
  code path that names one of tenant #1's five roles.
- **They fail differently, so they get different budgets.** The tenant boundary gets belt, braces
  and a CI guard that fails the build. The role boundary gets a clean evaluator, an audit row, and
  tests — but it is allowed to be wrong in a way a tenant can fix on a Tuesday afternoon.

One asymmetry drives the rest of this section: **the tenant boundary must hold against a device
that has been stolen, rooted and taken apart.** The role boundary only has to hold against the
server, because every write is re-authorized server-side before it becomes fact.

---

## 2.2 The token

### What it carries

Authentication issues an asymmetrically-signed JWT (EdDSA / Ed25519; JWKS published, keys rotated
quarterly with overlap). The claim set is deliberately small:

```jsonc
{
  "iss": "https://auth.<platform>/",
  "aud": ["erp-api", "erp-sync"],
  "sub": "0192f4c1-...",   // user_id      — who
  "tid": "0192a007-...",   // tenant_id    — THE isolation claim
  "did": "0192b13e-...",   // device_id    — which enrolled device
  "sid": "0192b13e-...",   // session id, for revocation
  "iat": 1787000000,
  "exp": 1787000900        // +15 minutes
}
```

Four things are conspicuously **absent**, each for a reason:

- **No permissions.** They are resolved server-side per request from `role_assignment`. A fat token
  means revocation lag measured in token lifetime; a thin token means a lookup. We take the lookup,
  cached in-process for 10 s keyed on `(tenant_id, user_id)` and invalidated eagerly by
  `LISTEN`/`NOTIFY` on `role_assignment`. Cost: a demotion can be up to 10 s stale on an online
  request. Accepted — the alternative is 15 minutes.
- **No location scope.** Same reason, plus the token stays a fixed size regardless of whether the
  bearer is a Micro-Outlet clerk (1 location) or the founder (25). Scope is resolved from
  `user_location_scope` (§2.5).
- **No role name.** A role name is tenant data. Nothing on the platform ever branches on it.
- **No tenant name, region, or jurisdiction.** All of it is derivable from `tid` server-side, and
  every claim that is derivable is a claim that can go stale.

### How it is verified

Verified at the edge on every request: signature against the JWKS, `iss`, `aud`, `exp`, `nbf`, and
then `did`/`sid` against the revocation set (§2.7). Verification produces one object, and it is the
only thing downstream code may read identity from:

```ts
/** The ONLY source of tenant identity in the process. Constructed by the verifier, frozen. */
export interface AuthContext {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly deviceId: DeviceId;
  readonly sessionId: SessionId;
}
```

Request handlers receive `AuthContext`; they never receive the raw token, and there is no accessor
that returns a tenant id from a request body. The request-body schemas are generated, and the
generator refuses to emit a field named `tenant_id`, `tenantId`, `tenant`, or `org_id` on any input
type. A lint rule fails the build on `req.body.tenant_id` and equivalents.

### Why `tenant_id` never comes from the client

Because a client-supplied tenant id is not a value with a validation rule attached — it is an
attack with a validation rule attached. Any design that accepts it and then checks it has a
non-zero number of code paths where the check is forgotten, and the failure mode of a forgotten
check is the unrecoverable one. Removing the input removes the class.

The practical trap is subtler than the obvious one. Nobody writes
`INSERT ... VALUES (req.body.tenantId)`. What people write is a bulk import, a webhook handler, a
report parameter, or a "re-post this failed job" admin endpoint that takes an opaque payload
serialised from an earlier request — and that payload has a tenant id in it. **Every deserialised
payload is a client payload**, including one this system wrote itself an hour ago. Queued jobs
carry `tenant_id` only inside a signed envelope produced by the same verifier, and the job runner
re-establishes the tenant context from the envelope, never from the job body.

---

## 2.3 Defence in depth — and where the depth actually runs out

Three layers. Layer 3 is not a security control and is listed only so nobody mistakes it for one.

| Layer | Control | Protects | Fails how |
|---|---|---|---|
| 1 | **Sync rules** | The device never receives what it may not see | Silently, catastrophically — bytes leave |
| 2 | **Server-side authorization + RLS** | Every write and every API read | Closed |
| 3 | UI affordances | Nothing. Usability only | Trivially, via devtools |

### Layer 2: the schema makes the mistake unavailable

Two structural devices do most of the work, before any policy is written.

**Composite keys and composite foreign keys.** Every tenant-owned table is keyed
`(tenant_id, id)`, and every reference between tenant-owned tables carries `tenant_id` through the
foreign key. This makes a cross-tenant *reference* a constraint violation rather than a bug:

```sql
CREATE TABLE stock_adjustment (
  tenant_id       uuid        NOT NULL,
  id              uuid        NOT NULL,              -- UUIDv7, device-generated
  location_id     uuid        NOT NULL,
  sku_id          uuid        NOT NULL,
  qty_delta       bigint      NOT NULL,              -- scaled integer, ADR-0004
  reason_code     text        NOT NULL,
  idempotency_key text        NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES location_node (tenant_id, id),
  FOREIGN KEY (tenant_id, sku_id)      REFERENCES sku           (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key)                -- per tenant, never global
);

CREATE INDEX ON stock_adjustment (tenant_id, location_id, id);   -- tenant_id leads
```

You cannot attach tenant A's adjustment to tenant B's location. Not "you shouldn't" — the database
rejects it. This costs a wider key on every table and a compound index on every join; it buys an
entire class of bug that no amount of review reliably catches.

**A single table factory.** Tables are declared through one shared builder that emits the
`tenant_id` column, the composite PK, `ENABLE`/`FORCE ROW LEVEL SECURITY`, the two policies and
the leading index together. Hand-written `CREATE TABLE` in a migration is a review failure and a
CI failure. `CLAUDE.md` §2.1 says "structurally, not by convention"; this is what that means.

### The RLS policy shape

```sql
CREATE FUNCTION app.current_tenant() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

ALTER TABLE stock_adjustment ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_adjustment FORCE  ROW LEVEL SECURITY;   -- the owner is not exempt

CREATE POLICY tenant_isolation ON stock_adjustment
  FOR ALL TO app_rw
  USING      (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());
```

**How a forgotten predicate fails closed, precisely.** `current_setting('app.tenant_id', true)`
returns `NULL` when the GUC was never set (the `true` is `missing_ok` — without it, an unset GUC
raises, which is also fail-closed but turns every unauthenticated code path into a 500 rather than
an empty result). `nullif` maps the empty string to `NULL` as well. The policy predicate then
evaluates to `tenant_id = NULL`, which is `NULL`, and RLS admits a row only on `true`. So:

- A `SELECT` that forgot its `WHERE tenant_id = $1` returns **zero rows**, not another tenant's rows.
- An `INSERT` that forgot to set `tenant_id` fails the `WITH CHECK` with
  `new row violates row-level security policy`.
- A query run without a tenant context returns nothing, loudly, and the integration tests that
  expect data fail immediately.

Three operational details make the difference between this working and this being decoration:

1. **`FORCE ROW LEVEL SECURITY` is mandatory.** Without it, the table owner bypasses every policy.
   If migrations run as the same role the app uses, RLS is silently off. Migrations run as
   `app_migrate` (owns the tables, has `BYPASSRLS`); the application connects as `app_rw`, which
   owns nothing, is not superuser, and does not have `BYPASSRLS`.
2. **`SET LOCAL`, never `SET`.** The tenant GUC is set inside the transaction:
   ```ts
   await db.transaction(async (tx) => {
     await tx.raw('SET LOCAL app.tenant_id = ?', [ctx.tenantId]);   // from AuthContext, only
     return work(tx);
   });
   ```
   Under a transaction-pooling connection pooler (PgBouncer in `transaction` mode, or a managed
   equivalent), a session-scoped `SET` survives into the next borrower's transaction — which means
   a plain `SET` does not merely fail to isolate, it actively hands one tenant's context to another
   tenant's query. This is the single most likely way this design fails in production. There is one
   `withTenant()` wrapper; acquiring a raw pool connection outside it is a lint error.
3. **A CI guard, both directions.**
   ```sql
   -- (a) every table with a tenant_id column must have RLS enabled AND forced
   SELECT c.relname FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'app'
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
    WHERE c.relkind = 'r' AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
   -- (b) every table WITHOUT a tenant_id column must be on the explicit platform allow-list
   ```
   Both must return zero rows. The allow-list for (b) is short and each entry is justified in the
   migration: `tenant`, `permission`, `jurisdiction_pack`, `jurisdiction_tax_rate`,
   `template_definition`, `schema_migrations`, `platform_operator`, `platform_support_grant`.
   Adding to it requires review by this role.

### Layer 1: sync rules — and the honest limit of "RLS is the backstop"

`CLAUDE.md` §2.1 says RLS is the backstop so a forgotten predicate fails closed. **That is true of
the API path and false of the sync path, and the difference matters more than anything else in this
section.**

A PowerSync-style sync service consumes the Postgres **logical replication stream**. Logical
replication is not subject to row-level security. The replication slot sees every row change on
every published table, for every tenant, and hands it to the sync service to be routed by the sync
rules. There is no policy behind the sync rule. If the tenant predicate is missing from a sync
rule's data query, RLS does not catch it, the API tests do not catch it, and the first symptom is
tenant A's price list appearing in tenant B's local SQLite — on a device, permanently.

So the sync path gets its own three controls, since it cannot borrow the database's:

**(a) The tenant claim is a bucket parameter, so the predicate cannot be omitted.**

```yaml
bucket_definitions:
  # Reference data every user of the tenant needs: catalogue, price lists, tax codes, customers.
  tenant_reference:
    parameters: |
      SELECT (request.jwt() ->> 'tid') AS tenant_id
    data:
      - SELECT * FROM sku        WHERE tenant_id = bucket.tenant_id
      - SELECT * FROM price_list WHERE tenant_id = bucket.tenant_id

  # Transactional data, one bucket per location the user is scoped to.
  location_scoped:
    parameters: |
      SELECT tenant_id AS tenant_id, location_id AS location_id
        FROM user_location_scope
       WHERE user_id   = request.jwt() ->> 'sub'
         AND tenant_id = request.jwt() ->> 'tid'
    data:
      - SELECT * FROM stock_on_hand
         WHERE tenant_id = bucket.tenant_id AND location_id = bucket.location_id
      - SELECT * FROM sale
         WHERE tenant_id = bucket.tenant_id AND location_id = bucket.location_id
           AND business_date >= now() - interval '90 days'      -- §2.7, minimisation window
```

`tenant_id` is part of the **bucket key**, sourced from `request.jwt()`. Every data query
therefore names `bucket.tenant_id` in order to be a valid query at all. A data query that omits it
is not a subtle leak — it is a rule that selects across the whole table, which the rule-generation
step rejects.

**`request.parameters()` is forbidden anywhere in this file.** Those are client-supplied and
unauthenticated; only `request.jwt()` claims are verified. A grep for `request.parameters()` in
`sync-rules.yaml` fails CI. This is the sync-path equivalent of "`tenant_id` never comes from a
client payload", and it is the same mistake wearing different clothes.

**(b) The rules are generated, not typed.** The same table registry that emits the DDL emits the
sync rules. A table is `sync: none | tenant_reference | location_scoped`, and its data query is
produced from that declaration.

**(c) The backstop for this path is a test, not a mechanism — so it has to be a real one.**
`tenant-isolation-test-engineer` owns a harness that provisions two tenants from *different*
templates, enrols a device against each, drives a representative workload, and then asserts
directly against the device's local SQLite file that **no row carrying the other tenant's
`tenant_id` exists in any table**. Not "the UI doesn't show it" — the bytes are not there. This is
`CLAUDE.md` §2.7 category 3 extended to the only path where the database cannot save us, and it
runs on every change to the schema, the registry, or the sync rules.

---

## 2.4 Permissions: composable, tenant-owned, additive

### Granularity

A permission is a string key, `domain.object.action[.qualifier]`, owned by the platform and
non-negotiable in vocabulary. Roles are owned by the tenant and free-form in composition. The
seam is deliberate: the platform decides what actions *exist*, the tenant decides who does them.

```sql
CREATE TABLE permission (              -- platform vocabulary; NO tenant_id (allow-listed)
  key          text PRIMARY KEY,       -- 'pos.price.override'
  domain       text NOT NULL,          -- 'pos' | 'stock' | 'customer' | 'gl' | 'admin' | ...
  is_sensitive boolean NOT NULL,       -- always audited; granting it is itself audited
  requires_fresh_authorization boolean NOT NULL,   -- blocked in restricted mode, §2.7
  bound_schema jsonb                   -- JSON-schema for the constraint object, or NULL
);
```

A representative slice of the vocabulary (the full list lives with the migration):

| Domain | Keys |
|---|---|
| `pos` | `pos.sell.cash` · `pos.sell.credit` *(bounded)* · **`pos.price.override`** *(sensitive, fresh)* · `pos.discount.apply` *(bounded)* · `pos.refund` *(sensitive)* · `pos.receipt.reprint` |
| `stock` | `stock.view` · `stock.adjust` *(sensitive, reason-coded)* · `stock.transfer.initiate` · `stock.transfer.receive` · `stock.count.perform` |
| `customer` | `customer.view` · `customer.create` · **`customer.credit.limit.set`** *(sensitive, fresh)* · `customer.credit.terms.set` *(sensitive)* · `customer.credit.hold.release` |
| `report` | `report.location.view` · `report.scope.view` · `report.network.view` · `report.margin.view` |
| `gl` / `ap` / `ar` | `gl.post` · `gl.review` · `gl.period.close` · `ap.invoice.enter` · `ar.receipt.apply` |
| `payroll` | `payroll.register.export` · `payroll.register.import` *(no computation exists to permit — §2.4 of the constitution)* |
| `admin` | `admin.user.manage` · `admin.role.manage` *(sensitive)* · `admin.device.enrol` · `admin.device.revoke` *(sensitive)* · `admin.tax.rate.manage` *(sensitive)* · `admin.offline_lease.extend` *(sensitive)* |
| `sync` | `sync.conflict.review` |

Granularity rule of thumb: **a permission exists where a role boundary plausibly falls in some
tenant's org chart, and nowhere else.** `pos.sell.cash` and `pos.sell.credit` are separate because
plenty of distributors let a junior take cash but not open a credit exposure. `pos.receipt.reprint`
is separate from `pos.sell.cash` because reprint is a small fraud vector. But there is no
`pos.sell.cash.line.add` — that is a step inside an operation, not a boundary anyone draws.

### Grouping into tenant-editable roles

```sql
CREATE TABLE role (
  tenant_id uuid NOT NULL, id uuid NOT NULL,
  name text NOT NULL,                    -- tenant's words. Platform never reads it.
  is_owner boolean NOT NULL DEFAULT false,
  derived_from_template text,            -- provenance only; no behaviour hangs off it (ADR-0006 §2.9)
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, name)
);

CREATE TABLE role_permission (
  tenant_id uuid NOT NULL, role_id uuid NOT NULL,
  permission_key text NOT NULL REFERENCES permission(key),
  bound jsonb,                           -- validated against permission.bound_schema
  PRIMARY KEY (tenant_id, role_id, permission_key),
  FOREIGN KEY (tenant_id, role_id) REFERENCES role (tenant_id, id)
);

CREATE TABLE role_assignment (
  tenant_id uuid NOT NULL, id uuid NOT NULL,
  user_id uuid NOT NULL, role_id uuid NOT NULL,
  scope_node_id uuid NOT NULL,           -- any node in the location tree (§2.5)
  effective_from timestamptz NOT NULL,
  effective_to   timestamptz,            -- NULL = open
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, role_id)       REFERENCES role          (tenant_id, id),
  FOREIGN KEY (tenant_id, scope_node_id) REFERENCES location_node (tenant_id, id)
);
```

**Bounded permissions** are how "credit sales up to a set limit" is expressed without a
special-case column. `pos.sell.credit` carries
`{"max_order_value_minor": "5000000", "currency": "GHS"}` — GH₵50,000. Note the **string**: a
`bigint` money value inside `jsonb` becomes a float64 the instant `JSON.parse` touches it, and
`ADR-0004` is categorical about `number` and money. Bound values that are money are decimal strings
parsed with `BigInt()`; bound values that are rates are basis points as integers.

**Evaluation is additive, with the most permissive bound winning, and there are no deny rules.**

```ts
type Decision =
  | { allow: true;  bound: Bound; grantId: GrantId }
  | { allow: false; reason: 'no_permission' | 'out_of_scope' | 'bound_exceeded' | 'stale_session' };

function authorize(
  ctx: AuthContext, key: PermissionKey, target: { locationId: LocationId; amountMinor?: bigint },
): Decision;
```

Deny rules make evaluation order-dependent and turn "why can Kofi not do this?" into a debugging
session. The model is a union of grants; a permission a role should not have is simply absent. The
cost is that you cannot express "manager, except at the Wenchi outlet" as an exception — you
express it as two assignments with different scopes, which is more typing and far easier to reason
about.

**No privilege escalation.** `admin.role.manage` lets you edit roles, but a grant operation is
rejected if the granting user does not itself hold the permission being granted, at a scope at
least as wide. Each tenant has exactly one `is_owner` role which holds every permission by
construction, cannot be deleted, cannot have permissions removed, and whose every action writes an
audit row. That role is the escalation path, and it is visible.

### Tenant #1's five roles, as a template

Applied once at onboarding as ordinary editable rows (`ADR-0006`). Nothing in the platform knows
these names.

| Template role | Permissions | Bounds | Scope node |
|---|---|---|---|
| Outlet staff | `pos.sell.cash`, `pos.sell.credit`, `pos.receipt.reprint`, `stock.view`, `stock.transfer.receive`, `customer.view` | `pos.sell.credit` → `max_order_value_minor: "0"` (effectively off until a manager raises it) | their outlet (leaf) |
| Outlet manager | + `stock.adjust`, `stock.transfer.initiate`, `stock.count.perform`, `report.location.view`, `customer.create`, `pos.discount.apply`, `pos.refund` | `pos.sell.credit` → `"500000"` (GH₵5,000); `pos.discount.apply` → `max_bps: 300` | their outlet (leaf) |
| Regional manager *(FY3+)* | + `report.scope.view`, `stock.transfer.initiate` across the region, `logistics.dispatch.manage` | `pos.sell.credit` → `"2000000"` | their **region node** |
| Head of Operations / Founder | `is_owner` — every permission | unbounded | **tenant root** |
| Accounts | `customer.credit.limit.set`, `customer.credit.terms.set`, `customer.credit.hold.release`, `ap.*`, `ar.*`, `gl.post`, `gl.review`, `gl.period.close`, `admin.tax.rate.manage`, `payroll.register.export`, `payroll.register.import`, `report.network.view`, `report.margin.view` | — | tenant root, but **`report.*` only** — no `pos.*`, no `stock.adjust` |

### The two hard prohibitions

The brief requires that outlet staff genuinely cannot override pricing and genuinely cannot change
a credit limit. The naive reading — "the platform forbids the role 'outlet staff' from holding
these permissions" — is unimplementable and wrong: "outlet staff" is a tenant-chosen string
(`CLAUDE.md` §2.9), and a different tenant will call the same job something else and may quite
legitimately let their counter staff discount. The platform cannot police a tenant's org chart.

What the platform *can* guarantee, and does, is stronger and more useful:

**1. There is no path to either outcome that does not pass through the permission check.**

- *Price.* The client never sends a price. A sale line carries `sku_id`, `qty`, `price_list_id`,
  `tax_code` and nothing else; the server recomputes the unit price from the tenant's price list
  and the effective-dated tax table (`ADR-0002`). If a line carries an `override` object
  (`{unit_price_minor, reason_code}`), the ingest handler calls `authorize(ctx, 'pos.price.override', …)`
  and **rejects the whole sale** if it fails. There is no `UPDATE sale_line SET unit_price` endpoint,
  no "correct the total" field, and no discount mechanism that can reach an arbitrary price — the
  bounded `pos.discount.apply` caps at `max_bps` and is applied server-side.
- *Credit limit.* `customer.credit_limit_minor` is not a writable column. It is a projection of an
  append-only `customer_credit_limit_change` event stream, and the only writer is the handler gated
  on `customer.credit.limit.set`. A direct `UPDATE customer SET credit_limit_minor` is blocked by
  column-level `REVOKE` on `app_rw` and by a trigger that raises.

**2. Both checks run server-side at ingest, not on the device.** This is the load-bearing sentence
of the whole section. A tablet's SQLite file is editable by anyone with root, so "we didn't sync
the permission to the device" is not enforcement and "we hid the button" is not enforcement. The
device's copy of the permission set exists so staff see a coherent UI and get an immediate,
comprehensible error offline. The server re-derives the decision when the write arrives.

There is a real cost here and it should be stated: a write rejected at ingest is rejected *after*
the customer has taken the goods and walked out. So a failed authorization at ingest does not
silently drop the write — it lands in `sync_quarantine` with the original payload intact, visible
to a holder of `sync.conflict.review`, and the sale is reported as an exception on the outlet's
daily reconciliation. Losing the record is worse than recording an unauthorized act.

**3. Granting a sensitive permission is itself a first-class, audited event.** Adding
`pos.price.override` to any role writes an `audit_event`, appears on the tenant's security report,
and requires the granter to hold it already. A tenant that wants their counter staff to discount
can have it — visibly, deliberately, and with a name attached.

**4. `qa-engineer` tests it as a matrix**, every template role against every restricted action,
with these two as named, non-skippable cases — including the offline case, where the assertion is
that a tampered local write is rejected at ingest and quarantined.

---

## 2.5 Location scope, including the regional manager who does not exist yet

Scope is a **node in a tenant-defined tree**, never an outlet id. Getting this right now costs a
closure table; getting it wrong means that in FY3, adding regional management is a migration of the
authorization model on top of live books.

```sql
CREATE TABLE location_node (
  tenant_id uuid NOT NULL, id uuid NOT NULL,
  parent_id uuid,                      -- NULL only at the tenant root
  kind      text NOT NULL,             -- tenant-defined: 'region', 'location', 'cluster', anything
  is_trading_location boolean NOT NULL, -- holds stock, takes sales, is a sync target
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES location_node (tenant_id, id)
);

-- Maintained by trigger. Truth is the adjacency list; this exists for lookup speed.
CREATE TABLE location_closure (
  tenant_id uuid NOT NULL, ancestor_id uuid NOT NULL, descendant_id uuid NOT NULL, depth int NOT NULL,
  PRIMARY KEY (tenant_id, ancestor_id, descendant_id)
);

-- The flattened answer, refreshed on change to role_assignment or location_node.
CREATE TABLE user_location_scope (
  tenant_id uuid NOT NULL, user_id uuid NOT NULL, location_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, user_id, location_id)
);
```

Why a closure table rather than a recursive CTE on demand: the sync rule's parameter query runs on
the sync service's connection every time a client reconnects, and sync-rule parameter queries do
not support recursive CTEs. A hierarchy that only the API can resolve is a hierarchy the sync
boundary cannot enforce — which puts it on the wrong side of the most important control. The
closure table costs a trigger and some write amplification on an almost-static table.

**The same mechanism, three depths** — this is the entire point:

| Template role | `scope_node_id` | Expands to |
|---|---|---|
| Outlet staff, outlet manager | the outlet leaf | 1 trading location |
| Regional manager (FY3) | the `region` node | every trading location under it |
| Head of Operations, Accounts | the tenant root | all 25 |

Adding the regional manager in FY3 is inserting a role row and an assignment row. No schema change,
no sync-rule change, no new concept. Tenant #1's tree at launch is
`Agyasei → Bono → Techiman Flagship`, and the Bono node has one child; the shape is already right.

**Narrowing scope removes data from the device.** Because `location_id` is part of the bucket key,
a user whose assignment moves from the region node to a single outlet loses buckets at the next
checkpoint, and the sync client deletes the rows for buckets it no longer subscribes to. Scope
reduction is therefore enforced on the device — *provided the device syncs*. If it never syncs, the
lease in §2.7 is what closes it.

### The right to see something is not the right to have it on your device

These are two different grants and the design keeps them apart. `permission` answers "may this user
read this?"; **`sync_profile` answers "does it come down to this tablet?"** — and the second is
strictly narrower.

The reason is concrete. Accounts holds `report.network.view`. If the permission alone drove sync,
an Accounts user's device would carry every contractor's credit position across six regions. So:

- Network- and region-wide **reporting** is served by an online server query, not by syncing 25
  outlets' movement history to a 2 GB tablet. `report.network.view` is marked
  `requires_fresh_authorization` and simply does not work offline. That is the correct behaviour:
  HQ reporting is a connected activity by nature (`ADR-0003` — latency affects reporting freshness,
  not the counter).
- A device's `sync_profile` is `own_locations` by default and never widens automatically with a
  permission grant. Widening it is an explicit, audited administrative act.
- Head-office staff who need breadth get a browser session on a better-connected machine, which
  syncs nothing.

Net effect: a Micro-Outlet tablet holds one outlet's data, and the founder's tablet holds the
flagship's — not the network's.

---

## 2.6 Audit trail

Every price override, discount, refund, stock adjustment, credit-limit and credit-terms change, GL
posting, period close, tax-rate edit, role and permission change, device enrolment and revocation,
and every platform-operator access writes an `audit_event`.

```sql
CREATE TABLE audit_event (
  tenant_id          uuid        NOT NULL,
  id                 uuid        NOT NULL,          -- server-assigned UUIDv7
  seq                bigint      NOT NULL,          -- per-tenant monotonic, server-assigned
  actor_kind         text        NOT NULL,          -- 'user' | 'system' | 'platform_operator'
  actor_user_id      uuid,
  actor_device_id    uuid,
  location_id        uuid,
  action             text        NOT NULL,          -- 'pos.price.override'
  permission_used    text        NOT NULL REFERENCES permission(key),
  grant_id           uuid,                          -- WHICH role_assignment authorised it
  subject_table      text        NOT NULL,
  subject_id         uuid        NOT NULL,
  before             jsonb,
  after              jsonb,
  reason_code        text,                          -- NOT NULL for reason-coded actions (trigger)
  reason_note        text,
  logical_ts         bytea       NOT NULL,          -- HLC from the device; ordering (sync-architect)
  device_wall_clock  timestamptz NOT NULL,          -- UNTRUSTED. Evidence, never a fact.
  monotonic_since_auth_ms bigint,                   -- device uptime-based elapsed since last auth
  server_received_at timestamptz NOT NULL DEFAULT clock_timestamp(),   -- trusted
  clock_skew_ms      bigint      NOT NULL,          -- device_wall_clock - server_received_at
  PRIMARY KEY (tenant_id, id)
);
```

`grant_id` is worth the column: it records *which* assignment authorised the act, so revoking a
role next month does not erase why the act was permitted last month. Because `role_assignment` is
effective-dated, "who could have done this on 14 March?" is answerable from data rather than
reconstructed from memory.

**Append-only, enforced rather than promised:**

```sql
REVOKE UPDATE, DELETE, TRUNCATE ON audit_event FROM app_rw;   -- INSERT and SELECT only
CREATE TRIGGER audit_event_immutable BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION app.raise_immutable();
CREATE POLICY audit_read ON audit_event FOR SELECT USING (tenant_id = app.current_tenant());
CREATE POLICY audit_write ON audit_event FOR INSERT WITH CHECK (tenant_id = app.current_tenant());
-- deliberately NO policy for UPDATE or DELETE: with RLS forced, absence of a policy denies.
```

A grant and a trigger stop the application. They do not stop someone with `app_migrate`. So a
sealer job runs every five minutes, computes a Merkle root over each tenant's new `seq` range and
writes `audit_seal (tenant_id, seq_from, seq_to, root_hash, sealed_at)`; seals are also shipped to
object storage with an object-lock retention policy. Chaining each row to its predecessor would be
stronger but serialises inserts per tenant, and this system's whole architecture is a burst of
writes arriving together after a sync. The cost of batching is an unsealed tail of up to five
minutes. Accepted, and named.

### The untrusted wall clock

A shop tablet's clock is wrong more often than anyone expects — a flat battery kills the RTC, and
staff change the time to make an alarm behave. It is also *worth* changing: backdating a price
override to before an audit period, or a sale to before a tax-rate change, is a real motive.

**Rule: `device_wall_clock` is recorded and never used for anything that matters.** Not for
ordering (the HLC does that), not for tie-breaking, not for tax-rate selection, not for period
assignment.

But a sale made offline on 31 March genuinely belongs in March, and it may arrive on 2 April, so
"just use `server_received_at`" is wrong too. The business date is the device clock **clamped to
the interval in which the device was demonstrably offline**:

```
business_date = clamp(device_wall_clock,
                      device_session.last_authenticated_at,   -- server-observed, trusted
                      server_received_at)                     -- server-observed, trusted
```

A device cannot claim a moment before its last authenticated contact with the server, nor after the
server received the write. The forgeable window is exactly the real offline interval — which is
also exactly the window the business legitimately needs. When the clamp bites, the row is written
with `clock_skew_ms` populated, an `audit_clock_anomaly` event is raised, and the transaction is
flagged for review rather than silently corrected.

`monotonic_since_auth_ms` is a second, independent estimate: elapsed time from the device's
boot-relative monotonic clock since the last successful authentication. It cannot be set by
changing the date, so a large disagreement between it and the wall-clock delta is direct evidence
of a clock change and raises the same anomaly.

**Residual weakness, stated plainly: a device offline for five days can place a transaction
anywhere within those five days, and nothing in this design can tell.** The mitigations are
detective, not preventive — anomaly flags, the 60-second sync target from the Phase 1 acceptance
criteria (a device that syncs often has a narrow window), and daily cash reconciliation per outlet.
Whether that residual is acceptable at period end is an accountant's call, not an engineer's; it
goes to the `CLAUDE.md` §2.8 review gate as **Q-SEC-2** below.

Related, and owned jointly with `ledger-engineer`: a late-arriving transaction whose clamped
business date falls inside a **closed** accounting period must not be posted into it. It goes to
the review queue and is posted to the open period with a reference to its true business date. Nobody
gets to reopen the books by being offline.

---

## 2.7 Devices: enrolment, revocation, local data, and the offline session

The attack surface is not the server. It is a hundred-odd cheap Android tablets on shop counters
across six regions, any of which can be picked up and walked away with.

### Enrolment

```sql
CREATE TABLE device (
  tenant_id uuid NOT NULL, id uuid NOT NULL,
  label text NOT NULL, home_location_id uuid NOT NULL,
  public_key bytea NOT NULL,               -- device keypair; private half never leaves the device
  sync_profile text NOT NULL DEFAULT 'own_locations',
  status text NOT NULL,                    -- 'active' | 'suspended' | 'revoked'
  enrolled_by uuid NOT NULL, enrolled_at timestamptz NOT NULL,
  revoked_by uuid, revoked_at timestamptz, revoked_reason text,
  last_authenticated_at timestamptz, last_seen_at timestamptz, app_version text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, home_location_id) REFERENCES location_node (tenant_id, id)
);
```

Enrolment is **online, in person, and permissioned**. A holder of `admin.device.enrol` issues a
one-time enrolment code (8 characters, 15-minute TTL, single use, bound to tenant and location).
The device generates a non-extractable Ed25519 keypair via WebCrypto (`extractable: false`, the
`CryptoKey` handle persisted in IndexedDB) and registers the public half. Enrolment is an audited
event.

The keypair binds the *device*; users still authenticate individually, because a counter tablet is
shared. Per-user unlock is a 6-digit PIN, rate-limited locally with exponential backoff, which
unwraps a per-user, per-device key. The PIN never leaves the device and is never a server
credential. Six digits is weak in isolation; it is acceptable only because it protects a key that
is itself useless once the lease expires (below), and because the attempt cap is enforced before
the key can be derived.

**Honest limit of the PWA choice.** A non-extractable WebCrypto key in a browser's IndexedDB
resists casual copying — JavaScript cannot read the raw key material — but it is not hardware-backed
on most low-end Android through a browser, and it does not resist an attacker with root and offline
access to the browser profile. `ADR-0003` names thermal receipt printing as the PWA's weakest point
and requires a hardware survey in Phase 1. **Hardware-backed key storage should be added to that
same survey**, because it is the second finding that would justify revisiting the native-Android
option, and it is cheaper to learn both at once.

### Local data at rest

Three controls, in descending order of how much work they actually do:

1. **Minimisation — by far the strongest.** A device holds only its own locations' data (§2.5) and
   only a rolling window of transactional history (default 90 days, tenant-configurable, in the
   sync rule). A stolen Micro-Outlet tablet exposes one outlet for one quarter, not the network for
   ten years. Nothing else on this list comes close to that reduction.
2. **Field-level encryption of a named sensitive set** — customer contact details, credit limits and
   balances, cost prices and margins — under a data key held in memory only after PIN unlock, wrapped
   both by a PIN-derived key (Argon2id) and by a server-held key so that a PIN reset does not destroy
   unsynced data. The cost is real and bounds the scope: an encrypted column cannot be searched or
   indexed locally, so anything the POS must search offline — SKU, price list, stock quantity —
   stays plaintext. Encryption whose key must be present for the app to run is a speed bump, not a
   wall; it raises the effort of a casual `adb pull` and nothing more. Do not oversell it.
3. **Device policy** — screen lock and Android file-based encryption required at enrolment. A PWA
   cannot verify either, which is a genuine gap; `devops-engineer` enforces it as a provisioning
   checklist and, at scale, MDM.

### Revocation

Revocation has to work against a device that is not listening, so it is three mechanisms and only
the third is unconditional:

1. **Server-side, immediate.** `status = 'revoked'`, `revoked_at` set. The sync connection is
   dropped, refresh is refused, and `did`/`sid` go into a revocation set checked on every request;
   the 15-minute access token bounds the residual to 15 minutes of online API access.
2. **Client-side, on next contact.** The sync endpoint returns `403 device_revoked`; the app wipes
   the local database, the device key, the wrapped user keys and the cached tokens before returning
   to the login screen. Effective — and entirely dependent on the device reconnecting, which a
   thief will prevent.
3. **Time-bounded by design.** The offline lease below expires whether or not the device ever hears
   from us again. **This is what makes revocation real without the device's cooperation.**

Revoking a *user* and revoking a *device* are separate actions with separate consequences: sacking
a clerk must not brick a shared counter tablet; losing a tablet must not lock out the clerk.

Writes queued on a revoked device are never auto-applied: anything arriving with that `device_id`
lands in `sync_quarantine` for a holder of `sync.conflict.review`. And the honest cost — a stolen
device that never reconnects takes its unsynced legitimate sales with it. That is why the Phase 1
acceptance criterion of syncing within 60 seconds of reconnection is a security requirement as much
as a sync one, and why daily per-outlet cash reconciliation is not optional.

### The offline session — an explicit decision, not a hand-wave

The tension is genuine. Force a re-login and a clerk in Wenchi with no signal cannot trade. Issue a
credential that does not expire and a stolen tablet is a permanent window into the business. Both
failures are unacceptable; the answer is to make the credential decay in a way that costs the
business its *risk exposure* before it costs it its *ability to trade*.

**Three credentials, deliberately separate:**

| Credential | Lifetime | Where it works | Purpose |
|---|---|---|---|
| Access token (JWT) | 15 min | Online only | API calls, opening a sync connection |
| Device refresh credential | Long-lived, device-key-bound | Online only | Obtaining access tokens |
| **Offline lease** | `T` (default 72 h) + grace | Offline | Authorises local operation while unreachable |

The **lease** is issued by the server on every successful sync and signed with a key the client
pins:

```jsonc
{
  "tid": "...", "sub": "...", "did": "...",
  "scope": ["<location_id>", "..."],
  "permission_snapshot_hash": "sha256:...",
  "issued_at": 1787000000,               // server clock — the only trustworthy timestamp here
  "full_until":   1787259200,            // issued_at + 72h
  "hard_stop_at": 1787345600             // full_until + 24h grace
}
```

**Enforcing expiry against a clock the device controls is circular**, so expiry is whichever of
these fires first:

- wall clock passes `full_until`;
- **monotonic elapsed since issue exceeds `T`** (boot-relative, not settable by changing the date);
- the wall clock jumps *backwards* past the last recorded value — a backwards jump is prima facie
  tampering and locks the device immediately.

A reboot resets the monotonic reference, so on cold start the app falls back to the wall clock plus
the backwards-jump check. A rooted attacker who edits the local state defeats all of it — which is
precisely why the lease is not the only control, and why §2.5's minimisation and the server-side
quarantine of revoked-device writes are the ones carrying the weight.

**Two horizons, because a cliff edge mid-trading-day is an outage the business cannot absorb.**

- **0 → `full_until` (72 h): full operation.** Everything the user's permissions allow.
- **`full_until` → `hard_stop_at` (+24 h): restricted mode.** Cash sales at list price and stock
  lookups continue. Everything marked `requires_fresh_authorization` is blocked: credit sales,
  price overrides, credit-limit changes, stock adjustments, refunds, network reporting. A
  persistent banner shows the remaining time and a "reconnect to restore" action. The outlet keeps
  taking money; it stops taking risk.
- **After `hard_stop_at`: sealed.** Read-only, no writes accepted, the in-memory data key dropped
  and non-derivable without a fresh server token. **Data is not wiped** — an outlet with a genuinely
  long outage must not lose its unsynced sales — but it is unreadable and the outbox survives
  encrypted until a successful server authentication reopens it.

`T` is tenant-configurable up to a platform ceiling of **14 days**. Extending it requires
`admin.offline_lease.extend`, is audited, and appears on the tenant's security report, because
extending it is a deliberate weakening of the posture and should look like one. Default 72 h covers
a long weekend plus a bad Monday, which is the shape of the outages `CLAUDE.md` §1 describes
("hours or days"). It is nonetheless a guess until the pilot produces real Techiman connectivity
data — **Q-SEC-3** below.

Wipe policy is asymmetric on purpose: **server-signalled revocation wipes everything including the
outbox** (those writes will be quarantined server-side anyway and should not be left lying on a
lost device); **failed unlock attempts seal but do not wipe** (a staff member with fat fingers
should not be able to destroy the day's takings).

---

## 2.8 Platform operator access

A multi-tenant product needs a support path — a customer will eventually ring with a broken ledger
— and an unaudited support path is a tenant boundary with a door in it.

`platform_support_grant (id, tenant_id, operator_id, mode, reason, ticket_ref, granted_at,
expires_at, approved_by)`. Read-only by default, four-hour maximum window, reason and ticket
mandatory, **write access requires two-person approval**. The grant is what sets `app.tenant_id`
for that session; there is no ambient operator access and no `BYPASSRLS` on any interactive role.
Every action writes `audit_event` rows with `actor_kind = 'platform_operator'` **into the tenant's
own audit trail**, where the tenant can see them. A customer whose books we can read without their
knowing is a customer we should not expect to keep.

---

## 2.9 Open questions

- **Q-SEC-1 — Hardware-backed key storage on the target tablets.** `OPEN` · owner
  `frontend-engineer` + `devops-engineer`. Add to the Phase 1 hardware survey alongside receipt
  printing (`ADR-0003`). If the answer is that browser-held keys are unacceptable for a business
  running on credit, that is the second finding that reopens the native-Android question.
- **Q-SEC-2 — Is the clamped business date acceptable at period end?** `NEEDS-HUMAN` · owner
  accountant, at the `CLAUDE.md` §2.8 gate. A device offline for D days can place a transaction
  anywhere in those D days. We can detect anomalies; we cannot prevent it. The accountant must say
  whether that is tolerable for a statutory period, and if not, the answer is a shorter maximum
  offline lease near period end — which is a business trade, not an engineering one.
- **Q-SEC-3 — Is 72 hours the right default lease?** `OPEN` · owner `product-manager` + pilot.
  Chosen from the constitution's "hours or days", not from data. Instrument actual offline
  durations per outlet from day one of the pilot and revisit before the first Micro-Outlet opens.
- **Q-SEC-4 — Rolling history window.** `OPEN` · owner `sync-architect` + `product-manager`. 90 days
  bounds a stolen device's exposure and a 2 GB tablet's working set, but a contractor on 60-day
  terms plus a dispute puts genuinely needed history right at the edge. Needs a real answer against
  tenant #1's ageing profile before Phase 1 go-live.

---

## 2.10 Concerns

Two, both narrow, neither asking to reopen a decision.

**1. "RLS is the backstop" is not true of the sync path, and the constitution reads as though it
is.** `CLAUDE.md` §2.1 and `ADR-0005` both present RLS as the mechanism that makes a forgotten
predicate fail closed. For the API path that is exactly right. For the replication path it is
false — logical replication is not subject to RLS, and there is no database-level control behind a
sync rule. Postgres publication row filters cannot help, because the filter is static and cannot
reference a per-connection tenant. I am not arguing against shared-schema-with-RLS; I am arguing
that the *highest-consequence path in the system has one layer, not two*, and that the compensating
controls in §2.3 — generated rules, the tenant claim as a bucket key, the banned
`request.parameters()`, and a device-level two-tenant leak test in CI — are load-bearing rather than
belt-and-braces. If those tests are ever allowed to be flaky or skipped, tenant isolation on the
sync path has no backstop at all. Worth saying out loud in the ADR, not just here.

**2. `ADR-0003` names receipt printing as the PWA's weak point; local key storage is a second one
and is not mentioned.** The decision is right for update distribution across 25 outlets and I would
make it again. But a PWA cannot hold a hardware-backed key, cannot verify that a device has a screen
lock, and cannot guarantee its local database is encrypted at rest — which puts more weight on data
minimisation and lease expiry than a native app would. The ask is small: add key storage and FBE
status to the Phase 1 hardware survey that `ADR-0003` already mandates, so both findings arrive
together and the native-Android question, if it has to be reopened, is reopened once.
