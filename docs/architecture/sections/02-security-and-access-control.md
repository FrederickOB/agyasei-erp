# 2. Security, Access Control and the Isolation Boundary

Owner: `rbac-security-engineer`. Depends on `ADR-0005` (shared schema, RLS, tenant-scoped sync),
`ADR-0006` (Agyasei is a template), `ADR-0003` (PWA on low-end Android), `ADR-0004` (money is
`bigint` minor units). Written jointly with `sync-architect` — §2.3 below is not implementable
without the sync rule design, and the sync rule design is not safe without it.

**Where this section and §3 (offline sync), §4 (data model) or §5 (general ledger) differ, those
sections govern.** They were adversarially reviewed first and their rulings are authoritative. This
revision reconciles §2 to them; §2.11 records every point at which the earlier draft did not.
`ADR-0007` governs everything statutory. Table and column names follow §3.11.9 and §4.

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

## 2.2 Identity: what authenticates a user, and what the token carries

### What authenticates a user

The earlier draft opened with "authentication issues a JWT" and never said what was authenticated.
That gap mattered: §4.11 assumes an external identity provider (`user_account.subject_ref text NOT
NULL -- points at the identity provider. No password material in this schema, ever.`) while §2.7
says the device PIN "is never a server credential", which leaves a factor that this section owns
and did not describe. Stated now.

**The identity provider is external and is the only holder of primary credential material.** No
password hash, no TOTP seed, no recovery code lives in `app` or `platform`. `user_account.subject_ref`
is an opaque pointer into it. Phase 1 uses a managed OIDC provider in the same EU region as the
database (`ADR-0003`); the platform is an OIDC relying party and nothing more. Selecting the
specific provider is `devops-engineer`'s, constrained by: EU region, OIDC with EdDSA or ES256, JWKS
with `kid`, per-user TOTP available, and an admin API for lockout and de-provisioning.

| Concern | Rule |
|---|---|
| Primary factor | Username + password at the IdP. Minimum length enforced by the IdP, breached-password screening on |
| Second factor | **Required for any user holding a permission flagged `is_sensitive` (§2.4).** TOTP. A counter clerk with `pos.sell.cash` alone does not need it; an Accounts user does |
| Rate limiting | IdP-side, per account and per source: exponential backoff from the 4th failure, hard lockout at 10 within 15 minutes |
| Lockout release | An `admin.user.manage` holder in the same tenant, audited. Never self-service by email alone |
| Recovery | IdP-driven, to a verified address or number recorded at onboarding. **Recovering an account never re-grants roles** — `role_assignment` is untouched by a credential reset |
| De-provisioning | Disabling the IdP subject blocks new tokens; `role_assignment.effective_to` is what removes access to data already on devices (§2.5). **Both are required.** Doing only the first leaves a device syncing for the life of its lease |

### The bootstrap problem — a new hire, on Monday, with the link down

A user who has never authenticated has no wrapped per-user key on the tablet, and the wrapping key
is derived from an interactive login. So **a user must be online exactly once to become usable on a
given device.** That is a real constraint in a product whose reason for existing is that
connectivity fails, and pretending otherwise would be the kind of overclaim §3.11.1 calls out.

Two mitigations, both designed rather than hoped for:

1. **Pre-staging.** While a device is online, the server may push a *first-login package* for any
   user in that device's location scope: a per-user key wrapped under a server-held key and a
   single-use activation secret, with a **72-hour TTL** and no PIN set. The user's first login on
   that device is then local: they present the activation secret (issued by their manager, out of
   band) and choose a PIN, which re-wraps the key. So a new hire starting on Monday works offline
   **provided the tablet synced within the previous 72 hours** — which is the same assumption the
   offline lease already makes, so it adds no new failure mode.
2. **Any connected point will do.** Activation does not have to happen at the outlet. A manager's
   phone hotspot, the regional centre, or HQ all work, and the package then rides down on the next
   sync.

Residual, stated: a device that has been dark for longer than 72 hours cannot activate a user who
has never used it. The fallback is that the outlet trades under an already-activated user, which is
correct — the alternative is a local credential path that a rooted device could mint, and that is
worse than a staffing inconvenience. Whether 72 hours is the right pre-stage TTL rides with the
lease question, **Q-SEC-3**.

### What the token carries

Authentication issues an asymmetrically-signed JWT. **Two separate tokens are issued, with
different single-valued audiences** — one for the API, one for the sync service. A single token
with `aud: ["erp-api","erp-sync"]` means a token captured from either surface works at both, which
doubles the value of a replay for no benefit.

```jsonc
{
  "iss": "https://auth.<platform>/",
  "aud": "erp-api",        // exactly one audience. The sync token is a separate mint.
  "sub": "0192f4c1-...",   // user_id      — who
  "tid": "0192a007-...",   // tenant_id    — THE isolation claim
  "did": "0192b13e-...",   // device_id    — which enrolled device
  "sid": "0192c55a-...",   // session id — per USER per DEVICE, never equal to did
  "jti": "0192c55b-...",   // unique per token; replay bookkeeping and revocation granularity
  "cnf": { "jkt": "NzbLsX..." },  // DPoP thumbprint of the enrolled device key — §2.7
  "iat": 1787000000,
  "exp": 1787000900        // +15 minutes
}
```

`sid` is per **user per device**: a counter tablet is shared, so session identity that equals device
identity cannot distinguish two clerks on one till, and every audit row and every revocation would
be device-granular when it needs to be person-granular.

Four things are conspicuously **absent**, each for a reason:

- **No permissions.** They are resolved server-side per request from `app.user_effective_permission`
  (§2.4). A fat token means revocation lag measured in token lifetime; a thin token means a lookup.
  We take the lookup, cached in-process for 10 s keyed on `(tenant_id, user_id)`.
  **The true staleness bound is the cache TTL or the reconciler interval, whichever is longer —
  60 seconds** (§2.5). It is *not* 10 seconds: an eager invalidation on write cannot see a grant
  that expires because time passed, and that was the hole in the earlier draft.
- **No location scope.** Same reason, plus the token stays a fixed size regardless of whether the
  bearer is a Micro-Outlet clerk (1 location) or the founder (25). Scope is resolved from
  `app.user_location_scope` (§2.5).
- **No role name.** A role name is tenant data. Nothing on the platform ever branches on it.
- **No tenant name, region, or jurisdiction.** All of it is derivable from `tid` server-side, and
  every claim that is derivable is a claim that can go stale.

### How it is verified

Verified at the edge on every request, in this order, failing closed at each step:

1. **`alg` is pinned to EdDSA.** The verifier is constructed with a fixed algorithm and a fixed key
   set; `none`, `HS*` and any algorithm substitution are rejected before the signature is checked.
   `kid` must resolve to a key in the cached JWKS; an unknown `kid` triggers **one** JWKS refetch
   (rate-limited to once per minute per issuer) and then fails. Saying only "signature against the
   JWKS" leaves the single most-exploited JWT defect unaddressed.
2. `iss`, exact-match `aud` for the surface being called, `exp`, `nbf`, and `iat` not in the future
   beyond a 60-second skew allowance.
3. **DPoP proof-of-possession.** The request carries a DPoP proof signed by the device's enrolled
   Ed25519 key; its JWK thumbprint must equal `cnf.jkt`. The key already exists (§2.7 enrolment),
   is non-extractable, and never leaves the device, so this is nearly free. Without it the token is
   a pure bearer credential and `did` is an *assertion about* a device rather than proof of one —
   which means the audit trail's `actor_device_id` is only as strong as bearer custody on a rooted
   tablet. Replay of a captured token from another machine now fails at the proof.
4. **`did`, `sid` and `jti` against the revocation set** (§2.7). The set is Redis-backed with a
   local negative cache. **If the revocation store is unavailable the request is refused, not
   admitted** — `503`, retryable per §3.3.4. A fail-open revocation check is not a revocation check.
   The consequence is stated plainly: a revocation-store outage stops online API traffic while
   devices keep trading offline on their leases, which is the correct direction for this business.

Verification produces one object, and it is the only thing downstream code may read identity from:

```ts
/** The ONLY source of tenant identity in the process. Constructed by the verifier, frozen. */
export interface AuthContext {
  readonly tenantId:  TenantId;
  readonly userId:    UserId;
  readonly deviceId:  DeviceId;
  readonly sessionId: SessionId;
  /** The open cash session at the location, resolved server-side. Carries locationId
   *  and businessDate. Absent for non-POS surfaces; POS writes require it. §3.4.2 */
  readonly cashSession?: {
    readonly cashSessionId: CashSessionId;
    readonly locationId:    LocationId;
    readonly businessDate:  BusinessDate;
  };
}
```

### Five identifiers that never come from the client

§3.3.3 is explicit that `tenant_id`, `device_id`, `actor_user_id` and `location_id` are all taken
from the verified session — *"both are as attack-relevant as `tenant_id` and neither had been
server-derived."* The earlier draft banned only `tenant_id`, and that gap is a real corruption path
that is not a tenant leak and therefore not caught by any tenant-isolation test: **a clerk at outlet
A stamps a movement with outlet B's `location_id`. Same tenant, so the composite FK holds and RLS
admits it. The row lands in outlet B's stock ledger and outlet B's sync bucket, and §5's inventory
subledger replay reproduces the wrong location's balance, with a clean audit row attached.**

So the ban is structural and covers all five:

- The request-body schema generator **refuses to emit** a field named `tenant_id`/`tenantId`/
  `tenant`/`org_id`, `location_id`/`locationId`, `device_id`/`deviceId`, `user_id`/`userId`/
  `actor_user_id`, or `business_date`/`businessDate` on any input type.
- A lint rule fails the build on `req.body.<any of those>` and equivalents.
- `location_id` and `business_date` come from `ctx.cashSession` (§3.4.2), which the server resolved
  from the open session at the till. There is no other source.
- `authorize()` (§2.4) takes its `locationId` from `AuthContext`, never from a parameter the caller
  chose. A caller that wants to act at a different location is doing a scope-crossing operation and
  says so explicitly through a named operation (`stock.transfer.initiate`, which takes a
  *destination* and checks scope on both endpoints), not by relabelling its own write.

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

**`app` is the only schema tenant-owned tables may live in.** Not a convention — the CI guard in
§4.2.5 filters on `nspname = 'app'`, so a tenant table created in `public` escapes every assertion
it makes, and every DDL example in the earlier draft of this section was unqualified. The table
factory below emits into `app` and nothing else, and a separate CI assertion fails the build on any
relation outside `app` and `platform` carrying a column named `tenant_id`.

The `platform` schema is the deliberate and only exception, and the distinction is worth stating so
it is not read as a loophole: **`app` holds rows a tenant owns; `platform` holds rows the *platform*
owns that happen to name a tenant** — `platform.tenant`, `platform.tenant_database`,
`platform.permission` (§2.4), `platform.support_grant` (§2.8), `platform.audit_seal` (§2.6),
jurisdiction packs and their effective-dated rate tables, template definitions, and the migration
ledger. No tenant reads them through an ordinary session, so RLS is not their control; the surface
that reads them is the platform surface, and §2.8 governs it.

**Three of this section's tables take a `has_write_id` exemption in §4.2.5's versioned exemption
file, per assertion and for the same reason `stock_balance_current` does** — they are trigger-
maintained derivations, not client writes: `app.user_effective_permission`, `app.user_location_scope`
and `app.location_closure` (§2.4, §2.5). They are exempt from `has_write_id` and from nothing else;
`has_tenant_id` and `rls_forced` are never exemptible, which §4.2.5 enforces as a hard-coded refusal
rather than a policy. `app.device_location_scope` is a real client-visible write and carries a
`write_id`, so it takes no exemption.

**Composite keys and composite foreign keys.** Every tenant-owned table is keyed
`(tenant_id, id)`, and every reference between tenant-owned tables carries `tenant_id` through the
foreign key. This makes a cross-tenant *reference* a constraint violation rather than a bug. The
example is `app.stock_movement`, in the form §4.7.1 defines it — the earlier draft invented a
`stock_adjustment` table with its own `idempotency_key` under a tenant-scoped unique index, which
is registry #4 in the design §3.3.2 spent a page deleting:

```sql
-- Excerpt of app.stock_movement (§4.7.1 is canonical; reproduced only for the FK argument).
-- Emitted by app.new_tenant_table (§4.2.3): tenant_id, id, write_id, hlc, timestamps and the
-- RLS policy all come from app.tenant_row_base. Nothing here is hand-written.
  tenant_id    uuid     NOT NULL,
  id           uuid     NOT NULL,              -- UUIDv7, device-generated
  write_id     uuid     NOT NULL,              -- THE idempotency key lives on write_log (§3.3.2)
  hlc          app.hlc  NOT NULL,              -- SERVER-stamped at ingest (§3.4.1)
  location_id  uuid     NOT NULL,              -- from the cash session, NOT the payload (§2.2)
  product_id   uuid     NOT NULL,
  qty_delta    app.qty  NOT NULL,              -- scaled integer, ADR-0004
  qty_scale    smallint NOT NULL,              -- snapshot; §3 disposition #11
  uom_id       uuid     NOT NULL,              -- snapshot of the stocking unit
  reason_id    uuid     NOT NULL,              -- app.movement_reason, tenant-editable
  business_date date    NOT NULL,              -- FROM THE CASH SESSION, never a device clock
  archived_at  timestamptz,                    -- sync windowing only (§3.2.4)

  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, write_id)    REFERENCES app.write_log (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.location   (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id)  REFERENCES app.product    (tenant_id, id)
  -- NO per-table idempotency_key and NO UNIQUE (tenant_id, idempotency_key). §3.3.2 deleted that
  -- design by name: a device-minted opaque string under a tenant-scoped unique index collides,
  -- and the second device to arrive is told "already applied" for a sale that was never applied.

CREATE INDEX ON app.stock_movement (tenant_id, location_id, product_id, hlc);   -- tenant_id leads
```

You cannot attach tenant A's movement to tenant B's location. Not "you shouldn't" — the database
rejects it. This costs a wider key on every table and a compound index on every join; it buys an
entire class of bug that no amount of review reliably catches. The `write_id` foreign key buys the
second class: **omitting the idempotency key is a foreign-key violation**, not a code-review
comment, and there is no second opaque string for two devices to collide on.

**A single table factory.** Tables are declared through `app.new_tenant_table` (§4.2.3), which emits
the base columns, the composite PK, the composite FK to `write_log`, `ENABLE`/`FORCE ROW LEVEL
SECURITY`, the policy and the leading index together. Hand-written `CREATE TABLE` in a migration is
a review failure and a CI failure. `CLAUDE.md` §2.1 says "structurally, not by convention"; this is
what that means.

### The RLS policy shape

```sql
CREATE FUNCTION app.current_tenant() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

ALTER TABLE app.stock_movement ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.stock_movement FORCE  ROW LEVEL SECURITY;   -- the owner is not exempt

CREATE POLICY tenant_isolation ON app.stock_movement
  FOR ALL TO app_rw, app_ro
  USING      (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());
```

**How a forgotten predicate fails closed, precisely.** `current_setting('app.tenant_id', true)`
returns `NULL` when the GUC was never set (the `true` is `missing_ok`). `nullif` maps the empty
string to `NULL` as well. The policy predicate then evaluates to `tenant_id = NULL`, which is
`NULL`, and RLS admits a row only on `true`. So:

- A `SELECT` that forgot its `WHERE tenant_id = $1` returns **zero rows**, not another tenant's rows.
- An `INSERT` that forgot to set `tenant_id` fails the `WITH CHECK` with
  `new row violates row-level security policy`.
- A query run without a tenant context returns nothing, and the integration tests that expect data
  fail immediately.

**But zero rows is the right answer for a security backstop and the wrong answer for a money
report.** A forgotten GUC produces an empty credit-ageing report rather than an error, and an empty
ageing report looks like a customer who owes nothing. So `withTenant()` **asserts** the GUC is set
and parses as a UUID before running any work, and raises in the application if it is not. RLS stays
the backstop; the application is loud. `missing_ok=true` remains correct at the policy layer — it is
what keeps an unauthenticated path returning empty rather than 500-ing — but it is no longer the
only thing standing between a bug and a silently wrong number.

Three operational details make the difference between this working and this being decoration:

1. **`FORCE ROW LEVEL SECURITY` is mandatory.** Without it, the table owner bypasses every policy.
   If migrations run as the same role the app uses, RLS is silently off. Three roles, not two:

   | Role | Owns | `BYPASSRLS` | Login | Used by |
   |---|---|---|---|---|
   | `app_migrate` | every table | **yes** | no interactive login; break-glass only (§2.8) | migrations, the archival job, the audit sealer |
   | `app_rw` | nothing | no | yes | the application |
   | `app_ro` | nothing | no | yes | reporting, support read sessions (§2.8), analytics |

   `app_ro` exists because §2.8 claims platform support is "read-only by default" and there was no
   role that made it so — it was application convention on a read-write connection.

2. **`SET LOCAL` semantics, via `set_config`, never string interpolation.** The tenant GUC is set
   inside the transaction:
   ```ts
   await db.transaction(async (tx) => {
     // SET LOCAL does NOT accept bind parameters — `SET LOCAL app.tenant_id = ?` is a parse error,
     // and the reflex fix is string interpolation into the most security-critical statement in the
     // system. set_config() is an ordinary function call and parameterises properly.
     await tx.raw("SELECT set_config('app.tenant_id', $1::uuid::text, true)", [ctx.tenantId]);
     assertTenantGuc(tx);            // reads it back; raises if NULL or not a uuid
     return work(tx);
   });
   ```
   The `::uuid::text` round-trip is deliberate: a value that is not a UUID fails in the cast rather
   than being stored as a GUC string that `app.current_tenant()` will later fail to parse in a
   context where the failure is harder to read.

   Under a transaction-pooling connection pooler (PgBouncer in `transaction` mode, or a managed
   equivalent), a session-scoped `SET` survives into the next borrower's transaction — which means
   a plain `SET` does not merely fail to isolate, it actively hands one tenant's context to another
   tenant's query. This is the single most likely way this design fails in production. There is one
   `withTenant()` wrapper; acquiring a raw pool connection outside it is a lint error.

3. **The CI guard is §4.2.5's, not this section's.** The earlier draft carried its own guard, and
   §4.2.5 subsequently enumerated four defects in exactly that shape and fixed each: a boolean-only
   check passes a policy of `USING (true)`; `relkind = 'r'` misses partitioned tables, and
   `write_log` and `stock_movement` are the named partitioning candidates; views and matviews are
   missed entirely, and a view without `WITH (security_invoker = true)` is evaluated against its
   owner — which for `app_migrate` means `BYPASSRLS` returns all tenants; and the float guard was
   name-based. §4.2.5 also moved the exemption list **out of the database** into a checked-in
   versioned file, because an exempt table inside `app` is a row any migration or compromised
   `app_rw` grant can insert to silence the guard, and made exemptions **per assertion**, with
   `has_tenant_id` and `rls_forced` never exemptible.

   §4.2.5 is canonical and is not restated here. What this section owns is the consequence:
   **the support-grant table is `platform.support_grant` (§2.8) and is therefore outside the
   guard's scope entirely.** The earlier draft called it `platform_support_grant`, put it on an
   allow-list of tables *without* a `tenant_id` column, and then defined it in §2.8 *with* one;
   both assertions could not be satisfied. It does have a `tenant_id` — it is the grant to read one
   tenant — it lives in `platform`, and its own isolation is by construction: only the platform
   surface reads it, and it is what *sets* `app.tenant_id` rather than being protected by it.

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

**§3.2.3 is the canonical sync-rules listing and this section does not carry a second copy.** The
earlier draft did, and the copy had reverted three fixes §3 had already made after its own review:
it took the tenant claim with no liveness check (so a suspended user's device kept receiving the
catalogue for the life of its lease — §3 disposition #24); it windowed a data query on
`now() - interval '90 days'`, which §3.2.4 opens by explaining does not re-evaluate as time passes;
and it windowed on `business_date`, which §3.2.4 rules out by name because a device offline across
the boundary uploads rows that are immediately out of window and are then delivered to nobody,
including the till that created them. It also used different claim names, bucket names and table
names. A second copy of the isolation boundary is a second thing that can be wrong, and it was.

What this section owns on the sync path is three properties and two contracts.

**(a) The tenant claim is a bucket parameter, so the predicate cannot be omitted.** `tenant_id` is
part of every bucket key and is sourced from `request.jwt()`. Every data query therefore names
`bucket.tenant_id` in order to be a valid query at all. A data query that omits it is not a subtle
leak — it is a rule that selects across the whole table, which the rule-generation step rejects.

**(b) `request.parameters()` is forbidden anywhere in that file.** Those are client-supplied and
unauthenticated; only `request.jwt()` claims are verified. A grep for `request.parameters()` in
`sync-rules.yaml` fails CI. This is the sync-path equivalent of "`tenant_id` never comes from a
client payload", and it is the same mistake wearing different clothes.

**(c) The rules are generated, not typed.** The same table registry that emits the DDL emits the
sync rules. A table declares its bucket membership, and its data query is produced from that
declaration.

**Contract 1 — device liveness and the device ceiling belong in the parameter queries.** Revocation
that is enforced only by an application revocation set is not enforced at the sync service at all:
the sync service validates the JWT against JWKS and does not consult application state, so a
revoked device's stream continues until its token expires. And `device.sync_profile` as the earlier
draft had it was a column with a promise attached — it appeared in no parameter query, so nothing
made it true. Both are fixed by the same join, which §2.5 defines and §3.2.3 must carry:

```sql
-- Required amendment to §3.2.3's location_ops / tenant_transfers / location_credit_allowance
-- parameter queries. Part of the §3.11.9 Phase 0 reconciliation pass.
JOIN device_location_scope dls
     ON  dls.tenant_id   = uls.tenant_id
     AND dls.location_id = uls.location_id
     AND dls.device_id   = (request.jwt() ->> 'did')::uuid
JOIN device d
     ON  d.tenant_id = uls.tenant_id AND d.id = dls.device_id
     AND d.status = 'active'
-- and on tenant_reference, which has no location term, the device liveness half alone.
```

Revocation then fails closed through the same mechanism as everything else: `status <> 'active'`
means the parameter query returns zero rows, means no buckets, means the stream stops — without the
sync service needing to know what revocation is.

**Contract 2 — the backstop for this path is a test, not a mechanism, so it has to be a real one.**
`tenant-isolation-test-engineer` owns a harness that provisions two tenants from *different*
templates, enrols a device against each, drives a representative workload, and then asserts
directly against the device's local SQLite file that **no row carrying the other tenant's
`tenant_id` exists in any table**. Not "the UI doesn't show it" — the bytes are not there. This is
`CLAUDE.md` §2.7 category 3 extended to the only path where the database cannot save us, and it
runs on every change to the schema, the registry, or the sync rules.

---

## 2.4 Permissions: composable, tenant-owned, additive

### Granularity and vocabulary

A permission is a string key, `domain.object.action[.qualifier]`, owned by the platform and
non-negotiable in vocabulary. Roles are owned by the tenant and free-form in composition. The
seam is deliberate: the platform decides what actions *exist*, the tenant decides who does them.

```sql
CREATE TABLE platform.permission (     -- platform vocabulary; NO tenant_id. In `platform`, so the
  key          text PRIMARY KEY,       -- §4.2.5 guard's app-schema assertions do not apply.
  domain       text NOT NULL,          -- 'pos' | 'credit' | 'stock' | 'customer' | 'gl' | 'admin' | ...
  is_sensitive boolean NOT NULL,       -- always audited; granting it is itself audited; forces 2FA
  raises_credit_exposure boolean NOT NULL,   -- the §2.4 prohibition family, below
  offline_mode text NOT NULL           -- 'never' | 'until_lease_expiry' | 'always'
    CHECK (offline_mode IN ('never','until_lease_expiry','always')),
  bound_schema jsonb                   -- JSON-schema for the constraint object, or NULL
);
```

**`offline_mode` replaces the earlier `requires_fresh_authorization` boolean, which carried two
incompatible meanings.** §2.5 used it for `report.network.view`, a permission that "simply does not
work offline" — blocked from minute zero. §2.7 used it for `pos.price.override` and `stock.adjust`,
which work fully for 72 hours and stop at `full_until`. One flag cannot express both. Three values:

| `offline_mode` | Meaning | Example |
|---|---|---|
| `never` | Requires a live server call. Unavailable the moment the link drops | `report.network.view`, `report.margin.view`, `admin.*`, `gl.period.close` |
| `until_lease_expiry` | Works for `0 → full_until`; blocked in restricted mode; refused after `hard_stop_at` | `pos.price.override`, `pos.refund`, `stock.adjust`, `credit.sell` |
| `always` | Works for the whole life of the lease, restricted mode included | `pos.sell.cash`, `stock.view`, `pos.receipt.reprint` |

**`platform.permission` is the single machine-readable source of these flags.** The template table
below shows *which roles hold which keys*; it does not restate the flags, because two places
stating the same flag is how they came to disagree in the first draft.

A representative slice of the vocabulary (the full list ships with the migration):

| Domain | Keys |
|---|---|
| `pos` | `pos.sell.cash` · **`pos.price.override`** *(sensitive)* · `pos.discount.apply` *(bounded)* · `pos.refund` *(sensitive)* · `pos.receipt.reprint` · **`pos.pricelist.select`** *(bounded — §2.4's third prohibition)* |
| `credit` | **`credit.sell`** *(bounded)* · `credit.read` · **`credit.account.open`** *(sensitive, exposure)* · **`credit.limit.set`** *(sensitive, exposure)* · `credit.terms.set` *(sensitive, exposure)* · `credit.hold.release` *(sensitive, exposure)* · `credit.cap.set` *(sensitive, exposure)* |
| `stock` | `stock.view` · `stock.adjust` *(sensitive, reason-coded)* · `stock.transfer.initiate` · `stock.transfer.receive` · `stock.count.perform` |
| `customer` | `customer.view` · `customer.create` · `customer.edit` |
| `report` | `report.location.view` · `report.scope.view` · `report.network.view` · `report.margin.view` |
| `gl` / `ap` / `ar` | `gl.post` · `gl.review` · `gl.period.close` · `ap.invoice.enter` · `ar.receipt.apply` |
| `payroll` | `payroll.register.export` · `payroll.register.import` *(no computation exists to permit — `CLAUDE.md` §2.4)* |
| `logistics` | `logistics.dispatch.manage` |
| `admin` | `admin.user.manage` · `admin.role.manage` *(sensitive)* · `admin.assignment.manage` *(sensitive)* · `admin.device.enrol` · `admin.device.revoke` *(sensitive)* · `admin.device.scope.manage` *(sensitive)* · `admin.tax.rate.manage` *(sensitive)* · `admin.offline_lease.extend` *(sensitive)* |
| `sync` | `sync.conflict.review` |

**Reconciled with §3.2.3, which is authoritative.** §3's sync rules gate on `credit.sell` and
`credit.read`; the earlier draft of this section had `pos.sell.credit` and no read key at all, and
`role_permission.permission_key REFERENCES permission(key)`, so §3's rules were gating on keys that
did not exist — parameter query returns zero rows, no `location_credit_allowance` bucket, offline
credit sales silently do not work. Since §2 owns the vocabulary and §3 owns the rules, §2 moves:
**`pos.sell.credit` is renamed `credit.sell`** and **`credit.read` is added**, matching §3.2.3
verbatim. `logistics.dispatch.manage` appeared in this section's own template table and not in its
own vocabulary; it is added. Credit gets its own domain, which is also the better decomposition:
extending credit is a credit-risk act that happens to occur at a till, not a POS feature.

Granularity rule of thumb: **a permission exists where a role boundary plausibly falls in some
tenant's org chart, and nowhere else.** `pos.sell.cash` and `credit.sell` are separate because
plenty of distributors let a junior take cash but not open a credit exposure. `pos.receipt.reprint`
is separate because reprint is a small fraud vector. But there is no `pos.sell.cash.line.add` —
that is a step inside an operation, not a boundary anyone draws.

### Grouping into tenant-editable roles

```sql
CREATE TABLE app.role (
  -- app.new_tenant_table base: tenant_id, id, write_id, hlc, timestamps
  name text NOT NULL,                    -- tenant's words. Platform never reads it.
  is_owner boolean NOT NULL DEFAULT false,
  derived_from_template text,            -- provenance only; no behaviour hangs off it (ADR-0006)
  UNIQUE (tenant_id, name)
);

-- Exactly one owner role per tenant, enforced rather than asserted. The earlier draft stated
-- all three of these properties in prose and had no DDL behind any of them.
CREATE UNIQUE INDEX role_one_owner ON app.role (tenant_id) WHERE is_owner;
CREATE TRIGGER role_owner_immutable BEFORE UPDATE OR DELETE ON app.role
  FOR EACH ROW EXECUTE FUNCTION app.refuse_owner_transition();
  -- refuses: is_owner false->true, is_owner true->false, DELETE of an is_owner row,
  -- and (from role_permission's trigger) removal of any permission from an is_owner role.

CREATE TABLE app.role_permission (       -- EFFECTIVE-DATED and APPEND-ONLY
  -- base columns as above
  role_id        uuid NOT NULL,
  permission_key text NOT NULL REFERENCES platform.permission(key),
  bound          jsonb,                  -- validated against permission.bound_schema
  effective_from timestamptz NOT NULL,
  effective_to   timestamptz,            -- NULL = open. Revocation is a value, never a DELETE.
  granted_by     uuid NOT NULL,
  FOREIGN KEY (tenant_id, role_id) REFERENCES app.role (tenant_id, id),
  -- at most one live grant of a key to a role at any instant
  EXCLUDE USING gist (
    tenant_id WITH =, role_id WITH =, permission_key WITH =,
    tstzrange(effective_from, effective_to) WITH &&)
);

CREATE TABLE app.role_assignment (
  -- base columns as above
  user_id        uuid NOT NULL,
  role_id        uuid NOT NULL,
  scope_node_id  uuid NOT NULL,          -- any node in app.location (§2.5). NEVER NULL.
  bound_override jsonb,                  -- may only NARROW the role's bound. Never widen.
  effective_from timestamptz NOT NULL,
  effective_to   timestamptz,            -- NULL = open
  FOREIGN KEY (tenant_id, role_id)       REFERENCES app.role     (tenant_id, id),
  FOREIGN KEY (tenant_id, scope_node_id) REFERENCES app.location (tenant_id, id)
);

REVOKE DELETE ON app.role, app.role_permission, app.role_assignment FROM app_rw;
-- plus a BEFORE DELETE trigger that raises. Revocation is effective_to, never removal:
-- a hard-deleted assignment dangles every audit_event.grant_id that pointed at it.
```

**`role_permission` is effective-dated because `grant_id` alone cannot answer the question the
audit trail exists to answer.** The earlier draft claimed *"who could have done this on 14 March?"
is answerable from data"* on the strength of `role_assignment` being dated. But the assignment
points at a role, and the role's *contents* were an undated mutable set: if the role's permission
set changed on 20 March, the role as it stood on 14 March was unreconstructable from the tables.
Dating both, append-only, makes the claim true. The as-of query is one join:

```sql
-- Everything user U could do at location L on date D
SELECT rp.permission_key, rp.bound, ra.bound_override, ra.id AS grant_id
FROM   app.role_assignment ra
JOIN   app.location_closure lc ON lc.tenant_id = ra.tenant_id
                              AND lc.ancestor_id = ra.scope_node_id
JOIN   app.role_permission rp ON rp.tenant_id = ra.tenant_id AND rp.role_id = ra.role_id
WHERE  ra.tenant_id = :t AND ra.user_id = :u AND lc.descendant_id = :l
  AND  :d >= ra.effective_from AND :d < COALESCE(ra.effective_to, 'infinity')
  AND  :d >= rp.effective_from AND :d < COALESCE(rp.effective_to, 'infinity');
```

### Bounds

**Bounded permissions** are how "credit sales up to a set limit" is expressed without a
special-case column. `credit.sell` carries `{"max_order_value_minor": "5000000"}`. Note the
**string**: a `bigint` money value inside `jsonb` becomes a float64 the instant `JSON.parse`
touches it, and `ADR-0004` is categorical about `number` and money. Bound values that are money are
decimal strings parsed with `BigInt()`; bound values that are rates are basis points as integers.

**No `currency` inside a bound.** The earlier draft carried `{"max_order_value_minor": "...",
"currency": "GHS"}`, which duplicates `platform.tenant.currency_code` and `money_scale` (§4.3) into
tenant role data with no stated behaviour if the two disagree. A tenant has exactly one currency by
`ADR-0007`. Minor units are rendered once at the presentation boundary using `tenant.money_scale`;
this document does not translate them into cedis, because doing so embeds `money_scale = 2` in
prose and `CLAUDE.md` §2.3 says never assume 100.

**Four rules govern bounds, and the first draft stated none of them.**

1. **Absence, never a zero bound, is how a permission is withheld.** A bound may narrow a grant; it
   may never stand in for the grant's absence. This is not style. §3.2.3's
   `location_credit_allowance` bucket gates on `up.permission = 'credit.sell'` **with no bound
   check** — a PowerSync parameter query cannot parse a `jsonb` bound, by construction. So a clerk
   holding `credit.sell` with `max_order_value_minor: "0"`, described in the earlier template as
   "effectively off", still receives a `credit_allowance` row — cap, headroom, offline ceiling, hold
   flag — for **every credit customer trading at that location**, on a tablet §2.7 says will be
   stolen. §2.5's entire "the right to see is not the right to have it on your device" argument was
   defeated by an encoding choice made one page earlier. The template below no longer grants outlet
   staff `credit.sell` at all.

2. **Composition is max-wins per location, and that is a stated consequence, not a hidden one.**
   Effective bound for key K at location L is
   `max over contributing grants of min(role_permission.bound, role_assignment.bound_override)`.
   The consequence, worked: a regional cover assignment carrying `max_order_value_minor:
   "2000000"` at the region node raises the same person's ceiling at their *home outlet* from
   `"500000"` to `"2000000"`, because the home outlet is under the region. `bound_override` on the
   assignment is how a tenant expresses "wider scope, not higher ceiling" — the cover assignment is
   issued with `bound_override: {"max_order_value_minor": "500000"}` and nothing moves. Deny rules
   would be the other answer and are rejected below; an inspectable "effective permissions at
   location L" API, which returns the winning `grant_id` per key, is what makes the composition
   readable rather than surprising.

3. **The escalation check covers bounds, not just keys.** A granter may set bound `B` on key `K` for
   a role assigned at scope `S` only if, for **every** location in `S`'s expansion, the granter's own
   effective bound for `K` is at least as permissive as `B`, and the granter holds `K` there. The
   earlier draft checked only the key, so a holder of `admin.role.manage` who held `credit.sell` at
   `"500000"` could edit their own role's bound to `"999999999"` and pass.

4. **Which permission gates assignment writes is stated: `admin.assignment.manage`, and it is
   granted only alongside `admin.role.manage`.** The earlier draft's escalation rule constrained
   editing `role_permission` and said nothing about `role_assignment`, so a user-manager holding
   only `admin.user.manage` could assign the owner role to themselves. `platform.permission` carries
   a `requires` edge from `admin.assignment.manage` to `admin.role.manage`; a role holding the
   former without the latter fails validation at save time.

### Evaluation

**Additive, with no deny rules.**

```ts
type Decision =
  | { allow: true;  bound: Bound; grantId: GrantId }
  | { allow: false; reason: 'no_permission' | 'out_of_scope' | 'bound_exceeded'
                          | 'stale_session' | 'offline_mode' };

function authorize(
  ctx: AuthContext,                     // locationId comes from ctx.cashSession — §2.2
  key: PermissionKey,
  target: { amountMinor?: bigint; priceListId?: PriceListId },
): Decision;
```

Deny rules make evaluation order-dependent and turn "why can Kofi not do this?" into a debugging
session. The model is a union of grants; a permission a role should not have is simply absent. The
cost is that you cannot express "manager, except at the Wenchi outlet" as an exception — you
express it as two assignments with different scopes, which is more typing and far easier to reason
about.

**Every denial writes an audit row** (§2.6). Forty probes at a price override must not be invisible.

### `app.user_effective_permission` — the flattening table §3 depends on

§3.2.3 gates `location_credit_allowance`, `tenant_credit` and `tenant_reviews` on joins against
`user_effective_permission`, and §3.11.8 rules categorically that **it may not be a view** —
logical replication does not replicate views, so a view is not a limitation to work around but a
thing that will simply not be there. The earlier draft of §2 never mentioned the table at all, which
left the isolation boundary depending on an object with no owner, no DDL and no maintenance story.
It is this section's, and it is defined here.

```sql
CREATE TABLE app.user_effective_permission (   -- trigger-maintained. NOT a view. §3.11.8
  tenant_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  permission  text NOT NULL,        -- column name matches §3.2.3's `up.permission`
  location_id uuid NOT NULL,        -- ONE ROW PER LOCATION. Never NULL. See below.
  bound       jsonb,                -- max-composed per rule 2 above
  grant_ids   uuid[] NOT NULL,      -- contributing role_assignment ids; grant_ids[1] is the winner
  valid_from  timestamptz NOT NULL,
  valid_to    timestamptz,          -- NULL = open
  revoked_at  timestamptz,          -- set by the reconciler when valid_to passes
  PRIMARY KEY (tenant_id, user_id, permission, location_id)
);
CREATE INDEX ON app.user_effective_permission (tenant_id, permission, location_id)
  WHERE revoked_at IS NULL;
```

**`location_id` is `NOT NULL` and the table is fully expanded**, one row per location in scope,
rather than carrying `NULL = all locations`. §4.11's `staff_assignment` used the NULL encoding and
it is **default-open** in the table that feeds the isolation-adjacent parameter query: a bug that
nulls one column grants network-wide scope silently, which is precisely what §2.3's "everything
fails closed, there is no default-open path" forbids. §3.2.3's predicate
`(up.location_id IS NULL OR up.location_id = uls.location_id)` still works unchanged; the NULL
branch is simply never taken.

The cost is rows: tenant #1 at full network is 65 users × ~35 keys × up to 25 locations, and only
the handful of tenant-root users expand to 25. Realistic total is low tens of thousands of rows on
an almost-static table. That is not a cost worth a default-open encoding.

`app.user_location_scope` has the same shape and the same maintenance:

```sql
CREATE TABLE app.user_location_scope (         -- trigger-maintained; §3.2.3 reads it
  tenant_id uuid NOT NULL, user_id uuid NOT NULL, location_id uuid NOT NULL,
  grant_ids uuid[] NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to   timestamptz,
  revoked_at timestamptz,                      -- §3.2.3's `uls.revoked_at IS NULL` needs this
  PRIMARY KEY (tenant_id, user_id, location_id)
);
```

The earlier draft's `user_location_scope` had no `revoked_at` column at all, so §3.2.3's
authoritative parameter query could not be written against §2's schema. Maintenance and the expiry
problem are in §2.5, because they are the same problem for both tables.

### Tenant #1's five roles, as a template

Applied once at onboarding as ordinary editable rows (`ADR-0006`). Nothing in the platform knows
these names. Bounds are minor-unit decimal strings, rendered at `platform.tenant.money_scale`.

| Template role | Permissions | Bounds | Scope node |
|---|---|---|---|
| Outlet staff | `pos.sell.cash`, `pos.receipt.reprint`, `stock.view`, `stock.transfer.receive`, `customer.view` | — | their outlet (leaf) |
| Outlet manager | + `credit.sell`, `stock.adjust`, `stock.transfer.initiate`, `stock.count.perform`, `report.location.view`, `customer.create`, `customer.edit`, `pos.discount.apply`, `pos.refund`, `pos.pricelist.select` | `credit.sell` → `max_order_value_minor: "500000"`; `pos.discount.apply` → `max_bps: 300`; `pos.pricelist.select` → `allowed_price_list_ids: [retail, wholesale]` | their outlet (leaf) |
| Regional manager *(FY3+)* | + `report.scope.view`, `logistics.dispatch.manage` | `credit.sell` → `"2000000"` | their **region node** |
| Head of Operations / Founder | `is_owner` — every permission | unbounded | **tenant root** |
| Accounts | `credit.read`, `credit.account.open`, `credit.limit.set`, `credit.terms.set`, `credit.hold.release`, `credit.cap.set`, `ap.*`, `ar.*`, `gl.post`, `gl.review`, `gl.period.close`, `admin.tax.rate.manage`, `payroll.register.export`, `payroll.register.import`, `report.network.view`, `report.margin.view`, `sync.conflict.review` | — | tenant root, but **`report.*` and `credit.*` only** — no `pos.*`, no `stock.adjust` |

**Outlet staff no longer hold `credit.sell`.** In the earlier draft they held it with a `"0"` bound
"effectively off", which as shown above is not off at all on the sync path. A tenant that wants
counter staff to sell on credit grants them the key and a bound, visibly, and their tablets then
receive the allowance rows that make it work.

### The prohibitions

The brief requires that outlet staff genuinely cannot override pricing and genuinely cannot change
a credit limit. The naive reading — "the platform forbids the role 'outlet staff' from holding
these permissions" — is unimplementable and wrong: "outlet staff" is a tenant-chosen string
(`CLAUDE.md` §2.9), and a different tenant will call the same job something else and may quite
legitimately let their counter staff discount. The platform cannot police a tenant's org chart.

What the platform *can* guarantee, and does, is stronger and more useful.

**1. There is no path to any of the three outcomes that does not pass through a permission check.**
Three, not two — the earlier draft's list of two was incomplete in a way that made its own guarantee
false.

- *Price.* The client never sends a price. A sale line carries `product_id`, `qty`, `uom_id` and
  nothing else; the server resolves the price list and recomputes the unit price from
  `app.price_list_item` and the effective-dated tax basis (`ADR-0002`, §4.6, §3.4.2). If a line
  carries an `override` object — `{unit_price_e4, reason_code}`, at **e4**, because §4.13 rule 3
  computes from `unit_price_e4` and a value submitted as `unit_price_minor` into an `_e4` column is
  a 10,000× error in one direction and silent truncation of every sub-pesewa unit price in the other
  — the ingest handler calls `authorize(ctx, 'pos.price.override', …)` and **routes the whole sale to
  review** if it fails. There is no `UPDATE sale_line SET unit_price` endpoint and no "correct the
  total" field.

- *Price list.* **This is the third case and the earlier draft did not have it.** That draft's sale
  line carried `price_list_id` as an ordinary client input and then claimed *"there is no discount
  mechanism that can reach an arbitrary price"*. A price-list identifier **is** the price, indirected
  once. `CLAUDE.md` Phase 1 requires retail *and* wholesale pricing, so every tenant has at least
  two lists with materially different prices; nothing in the vocabulary gated which list a user may
  sell from, and `authorize()` was never called on the choice. An outlet clerk holding
  `pos.sell.cash` alone could select the wholesale list and sell a tonne of cement at wholesale — an
  arbitrary price reduction, server-recomputed, fully authorized, zero audit rows, without needing
  the discount cap, the override or a composed role.

  Fixed structurally: **the server resolves the price list per §4.6's rule** (the customer's assigned
  list, else the location's, else the tenant default, filtered to lists effective on the transaction
  date, lowest `priority` wins). A client that asserts a different list is performing a named
  operation, `price_list_override`, gated on `pos.pricelist.select` and bounded by
  `{"allowed_price_list_ids": [...]}`. No grant means the resolved list, always. The grant is on the
  role, not in the payload.

- *Credit exposure.* The earlier draft wrote the prohibition on a **column** —
  `customer.credit_limit_minor` is not writable — and two documented paths reached the outcome
  anyway. `customer.create` was granted to Outlet manager, and nothing said the *initial* limit was
  gated; a manager could create "Kwame Mensah (2)" with a large opening limit and sell to it,
  because the append-only stream protects *updates* and the first event is a create. And
  `credit.hold.release` reaches "increase realisable exposure" exactly, by releasing a hold placed
  *because* the limit was breached.

  So the prohibition is stated as an **outcome, with the family of permissions that can reach it
  enumerated and flagged in the schema** (`platform.permission.raises_credit_exposure`):
  `credit.account.open`, `credit.limit.set`, `credit.terms.set`, `credit.hold.release`,
  `credit.cap.set`. Every member is `is_sensitive`, every member writes an `audit_event`, and every
  member is subject to the escalation rule. Structurally: `app.customer` (§4.9) carries no limit —
  the limit lives on `app.credit_account`, which `customer.create` cannot create. Opening a credit
  account with any non-zero `credit_limit_minor` requires `credit.account.open`; the create path
  cannot set it, and there is no field on the customer payload where it could arrive.
  `credit_limit_minor` changes are a projection of the append-only `app.credit_limit_version` stream
  (§3.2.2, §4.9 — the earlier draft called this `customer_credit_limit_change`, a fourth name for
  a table §4 and §6 already own), and the only writer is the handler gated on `credit.limit.set`.
  Direct `UPDATE` is blocked by column-level `REVOKE` on `app_rw` and by a trigger that raises.

**2. Every bounded permission states its base, its rounding point, and that it is evaluated on the
server-recomputed figure.** The earlier draft stated none of the three, which makes a cap an
unspecified comparison against a possibly device-supplied number.

| Bound | Compared against | Evaluated | Rounding |
|---|---|---|---|
| `credit.sell → max_order_value_minor` | the **credit portion** of the document total, **gross of tax and net of discount** — the amount that actually becomes a `credit_entry` charge (§4.9) | on the **server-recomputed** total (§3.4.2: the server recomputes every monetary figure from the snapshotted basis and compares byte for byte). A rooted tablet cannot understate the order to defeat the cap | after §4.13 rows 3, 4, 5 and 6 — i.e. against the final document figure, not an intermediate |
| `pos.discount.apply → max_bps` | the **document** discount as a fraction of the document net before tax, computed **before** §4.13 row 4's largest-remainder allocation | server-side, on the recomputed net | checked pre-allocation. A per-line check *after* allocation rejects legitimate sales: largest-remainder pushes remainder pesewas onto the highest-value lines, so one line can exceed `max_bps` of itself by a pesewa while the document total is exact |
| `pos.pricelist.select → allowed_price_list_ids` | the asserted `price_list_id` | server-side, against the grant | n/a |

On a tax-inclusive price list, §4.13 row 10 requires **discount the gross, then de-gross**; on an
exclusive list the order is the other way, and the two give different tax. The cap is evaluated
against the net after discount in both cases, so the ordering does not change the comparison — but
it changes the number, so the rule is named rather than left to the implementer.

**`max_order_value_minor` is a cap on authority, not a control on exposure**, and the earlier draft
implied otherwise. It is a **per-order** limit; a clerk can apply it ten times in a row. The actual
offline credit control is §3.2.2/§6.7's `credit_allowance` — `cap_minor`, `headroom_minor` and
`offline_ceiling_minor` per location, leased with `valid_until` (§4.9). §2 never mentioned the
allowance and that was an omission, not a difference of opinion: the role bound and the allowance
are two different controls doing two different jobs, and describing only the first makes the system
look safer than it is.

**3. Both checks run server-side at ingest, not on the device.** This is the load-bearing sentence
of the whole section. A tablet's SQLite file is editable by anyone with root, so "we didn't sync
the permission to the device" is not enforcement and "we hid the button" is not enforcement. The
device's copy of the permission set exists so staff see a coherent UI and get an immediate,
comprehensible error offline. The server re-derives the decision when the write arrives.

There is a real cost and it should be stated: a write rejected at ingest is rejected *after* the
customer has taken the goods and walked out. **Losing the record is worse than recording an
unauthorized act**, so the write is never dropped. §3.11.2 states the same rule from the sync side:
*a client never completes a CRUD transaction into local-only storage.*

The mechanism, named as §3 names it rather than as a fourth thing. The earlier draft invented
`sync_quarantine`, which is a fourth name for a queue §3.6.2 and §4.12 already specify — §3.11.9
deletes `app.sync_conflict` in favour of `conflict_review` for exactly this reason:

- An unauthorized write at ingest opens an `app.conflict_review` row with
  **`conflict_class = 'UNAUTHORIZED_WRITE'`**, severity 1, routed to the queue mapped to
  `sync.conflict.review`, with the original payload intact.
- The response is **`200 {status:"routed_to_review", review_id}`** — §3.3.4's accepted-but-pending
  code. It is deliberately not `403`, which §3.3.4 defines as *retryable, possibly a stale
  permission snapshot, never discard*: a device cannot distinguish two meanings of one status, so
  either revoked writes retry forever or stale-permission writes get wiped. It is deliberately not
  `422` either, which is the only definitive rejection and would dead-letter a real sale.
- **The consequence §2 had not stated: a sale held in review has already left the shelf.** Its
  `stock_movement` is not in the subledger, so §5's inventory replay and the physical count diverge
  until a human acts, and §4.7.2's nightly `stock_balance` assertion will not see it because the row
  does not exist. So an open `UNAUTHORIZED_WRITE` review carries a **quantity and value marker onto
  the outlet's daily reconciliation** — the divergence is reported as a known, attributed figure
  rather than surfacing later as an unexplained count variance.

**4. Granting a sensitive permission is itself a first-class, audited event.** Adding
`pos.price.override` to any role writes an `audit_event`, appears on the tenant's security report,
and requires the granter to hold it already at a scope at least as wide and at a bound at least as
permissive. A tenant that wants their counter staff to discount can have it — visibly,
deliberately, and with a name attached.

**5. `qa-engineer` tests it as a matrix**, every template role against every restricted action, with
**three** named non-skippable cases: no price override, no credit-limit change (in the outcome
sense, covering the whole `raises_credit_exposure` family), and **no selling from an ungranted price
list** — including the offline case, where the assertion is that a tampered local write is rejected
at ingest and routed to review.

---

## 2.5 Location scope, effective dating, and the device ceiling

Scope is a **node in the tenant's location tree**, never an outlet id. Getting this right now costs
a closure table; getting it wrong means that in FY3, adding regional management is a migration of
the authorization model on top of live books.

### The tree is §4.3's, not a second one

The earlier draft defined its own `location_node` with `kind text NOT NULL -- tenant-defined:
'region', 'location', 'cluster', anything` and a single `is_trading_location boolean`. §4.3 rules
the opposite way and is authoritative, and the reason is `ADR-0006` running in the direction this
section was not watching:

- **`location.kind` is platform structure** — `CHECK (kind IN ('OUTLET','WAREHOUSE','GROUP',
  'TRANSIT','SUPPLIER_GAP'))` — *"a closed enum because the platform genuinely branches on it."*
- **`location_type` is tenant vocabulary** — FLAGSHIP / RDC / MICRO for tenant #1; another tenant
  creates BRANCH / DEPOT. *"`if (type.code === 'RDC')` is the same defect as
  `if (tenant === 'agyasei')`."*

Putting tenant words in `kind` gets it exactly backwards, and it cost more than a naming argument:
**a model with one boolean and no TRANSIT concept cannot express where in-transit stock lives.**
§4.7.3 and §5.6.3 both rule that in-transit inventory sits at the **sending location's durable
TRANSIT node**, `is_trading = false`, `is_postable_location = true`. Under the earlier §2, a
regional manager's scope expansion — "every trading location under it" — silently excluded TRANSIT
nodes from `user_location_scope`, so the sending outlet could not see its own in-transit stock, the
transfer-dispatch flow had no sync scope, and §5's inventory-subledger-to-GL tie at close named a
location no device was scoped to.

**§4.3's `app.location` is adopted verbatim.** This section adds only the closure table and the
scope rules:

```sql
-- Maintained by trigger over app.location. Truth is the adjacency list; this is for lookup speed.
CREATE TABLE app.location_closure (
  tenant_id uuid NOT NULL, ancestor_id uuid NOT NULL, descendant_id uuid NOT NULL, depth int NOT NULL,
  PRIMARY KEY (tenant_id, ancestor_id, descendant_id)
);
```

Why a closure table rather than a recursive CTE on demand: the sync rule's parameter query runs on
the sync service's connection every time a client reconnects, and sync-rule parameter queries do
not support recursive CTEs. A hierarchy that only the API can resolve is a hierarchy the sync
boundary cannot enforce — which puts it on the wrong side of the most important control. The
closure table costs a trigger and some write amplification on an almost-static table.

**Scope expansion rules, stated per `kind`:**

| `kind` | In `user_location_scope`? | Notes |
|---|---|---|
| `OUTLET`, `WAREHOUSE` | Yes, if under the assignment's `scope_node_id` | The ordinary case |
| `GROUP` | No — a group node holds no stock and takes no sales, so there is nothing to sync | It is a *scope node*, not a *scope member*. `scope_node_id` may point at one; the expansion contains its descendants |
| **`TRANSIT`** | **Yes — in the scope of whoever holds the sending location**, because §4.3 hangs it off that location | Never a sync target on its own and never a `scope_node_id`. A user scoped to Techiman is scoped to Techiman's TRANSIT node; nobody is scoped to a TRANSIT node without its parent |
| `SUPPLIER_GAP` | No | Server-side accounting construct; no device business |

**One assignment table, and §2 owns it.** §4.11 defines `app.staff_assignment (staff_id,
location_id, role_id, from_date, to_date, is_primary)` in parallel with this section's
`role_assignment`, keyed differently (`staff_id` vs `user_id` — and §4 separates staff from users
deliberately, because a yard hand has an employment record and no login), dated differently (`date`
vs `timestamptz`), and scoped differently, with **`NULL location_id` meaning all locations**. Two
assignment tables feeding one isolation-adjacent parameter query is the §4.17.1 pattern —
*one table, one owner, a cross-reference rather than a second definition* — and the NULL encoding is
the fail-open half.

**Ruling, made here and to be reflected in §4.11's next pass:** `app.role_assignment` is the single
assignment table. `app.staff_assignment` keeps employment placement (`staff_id`, `location_id`,
`from_date`, `to_date`, `is_primary`) for payroll and rota purposes and **loses `role_id`**; access
comes from `role_assignment.user_id → app.user_account.id → staff_id`. A yard hand has a `staff`
row, no `user_account`, and therefore no assignment and no scope, which is the correct outcome and
is expressed by absence rather than by a null.

### Effective dating that actually takes effect

This is the defect the earlier draft was least aware of. It said `user_location_scope` is *"the
flattened answer, refreshed on change to `role_assignment` or `location_node`"* and that the
permission cache is *"invalidated eagerly by `LISTEN`/`NOTIFY` on `role_assignment`"*.

**Time passing is not a change to `role_assignment` and fires no `NOTIFY`.** A manager sets a
covering assignment to expire on 31 August. On 1 September the row is expired, but no trigger ran,
so `user_location_scope` still contains the region's 18 outlets, the parameter query still returns
18 buckets, and the clerk's tablet keeps syncing every outlet's sales and stock — indefinitely,
until some unrelated write to `role_assignment` happens to fire the trigger. The in-process cache
has the same hole, and the "10 s stale, accepted" cost analysis was wrong: the true bound was *until
the next unrelated write*.

Two mechanisms, both required, because each covers the other's gap:

**(a) Predicate, so a stale materialisation cannot grant.** `user_location_scope` and
`user_effective_permission` carry `valid_from` / `valid_to` / `revoked_at`, and **both the
authorizer and every sync parameter query filter on liveness**:

```sql
-- authorizer
WHERE now() >= valid_from AND now() < COALESCE(valid_to, 'infinity') AND revoked_at IS NULL
-- §3.2.3 parameter queries already filter `uls.revoked_at IS NULL`; the valid_to predicate joins it
```

**(b) A reconciler on a stated interval, so a device stops receiving rather than merely stops being
authorized.** A predicate closes the API path immediately. It does not by itself remove a bucket:
PowerSync re-evaluates parameter queries on connect and on token refresh, and a long-lived
connection on a 15-minute token will re-evaluate within 15 minutes — but "within 15 minutes"
is not a bound anyone should have to derive from token lifetime. So a **scheduled reconciler runs
every 60 seconds**, expires rows whose `valid_to` has passed by setting `revoked_at`, inserts rows
whose `valid_from` has arrived, and emits the invalidation signal. **60 seconds is the real
staleness bound of the entire authorization model** and is stated as such: §2.2's cache TTL of 10 s
is not the bound, it is a sub-component of it.

**Cache invalidation, and the pooler that makes the obvious answer impossible.** §2.3 mandates
PgBouncer in `transaction` mode and calls session-scoped state under it the most likely way this
design fails. **PgBouncer in transaction mode does not support `LISTEN`/`NOTIFY`** — it is a
documented, categorical limitation, for the same reason `SET` is unsafe there. The earlier draft
stated the invalidation mechanism and the pooling mode two pages apart and they were mutually
exclusive. Resolution:

- Each application instance holds **one dedicated direct (non-pooled) connection** solely for
  `LISTEN app_permission_change`. It carries no queries and no tenant context.
- **If that connection drops, the instance falls back to the 10-second TTL and logs a degraded
  metric.** Correctness does not depend on the notify — the TTL and the 60-second reconciler are
  the guarantee; the notify is a latency optimisation on top. Stating it the other way round, as
  the earlier draft did, made a best-effort channel load-bearing.
- The reconciler emits the notify after committing its expiry batch, so scheduled demotions
  propagate to caches on the same 60-second beat as they propagate to buckets.

**Maintenance triggers**, in one place so there is no ambiguity about who writes these tables:

| Change | Effect |
|---|---|
| `INSERT`/`UPDATE` on `role_assignment` | recompute both tables for that `(tenant_id, user_id)` |
| `INSERT`/`UPDATE` on `role_permission` | recompute `user_effective_permission` for every user assigned that role |
| `INSERT`/`UPDATE` on `app.location` (parent change, deactivation) | recompute closure, then both tables for every affected user |
| `INSERT`/`UPDATE` on `device_location_scope` or `device.status` | no effect on these tables — the device term is a separate join in the parameter query (§2.3, Contract 1) |
| 60-second reconciler | set `revoked_at` where `valid_to` has passed; activate rows where `valid_from` has arrived; `NOTIFY` |

A CI test drives each row of that table and asserts the flattened contents match a from-scratch
recomputation. A materialisation that can drift from its source is a materialisation that will.

### The same mechanism, three depths

| Template role | `scope_node_id` | Expands to |
|---|---|---|
| Outlet staff, outlet manager | the outlet leaf | 1 OUTLET + its TRANSIT node |
| Regional manager (FY3) | the `GROUP` region node | every OUTLET under it + their TRANSIT nodes |
| Head of Operations, Accounts | the tenant root | every trading location and TRANSIT node in the tenant |

Adding the regional manager in FY3 is inserting a role row and an assignment row. No schema change,
no sync-rule change, no new concept. Tenant #1's tree at launch is
`Agyasei (root) → Bono (GROUP) → Techiman Flagship (OUTLET) → Techiman TRANSIT`, and the Bono node
has one child; the shape is already right.

**Narrowing scope removes data from the device.** Because `location_id` is part of the bucket key,
a user whose assignment moves from the region node to a single outlet loses buckets at the next
checkpoint, and the sync client deletes the rows for buckets it no longer subscribes to. Scope
reduction is enforced on the device — *provided the device syncs within the reconciler's beat plus
its reconnect interval*. If it never syncs, the lease in §2.7 is what closes it.

### The right to see something is not the right to have it on your device

These are two different grants and the design keeps them apart. `permission` answers "may this user
read this?"; **the device's location scope answers "does it come down to this tablet?"** — and the
second is strictly narrower.

The earlier draft made this argument with a `device.sync_profile` column and no mechanism: it was
not a bucket parameter, `did` appeared in no parameter query, and its other enum values were never
named. A column with a promise attached. Replaced with a table that is a real term in the query:

```sql
CREATE TABLE app.device_location_scope (     -- the DEVICE ceiling. Joined in §3.2.3 (§2.3 Contract 1)
  tenant_id uuid NOT NULL, device_id uuid NOT NULL, location_id uuid NOT NULL,
  write_id  uuid NOT NULL,
  added_by  uuid NOT NULL, added_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, device_id, location_id)
);
```

- **Seeded from the device's home location at enrolment**, one row. Never widened automatically by
  any permission grant.
- **Widening requires `admin.device.scope.manage`, is audited, and appears on the tenant's security
  report.** Moving a tablet between outlets is the same audited act — a row removed and a row added,
  with the effect on its buckets stated in the confirmation.
- **The effective device scope is `user_location_scope ∩ device_location_scope`.** This is the
  mechanism that keeps the founder's tablet holding the flagship's data rather than the network's,
  and it is enforced in the parameter query rather than promised in prose.

Network- and region-wide **reporting** is served by an online server query, not by syncing 25
outlets' movement history to a 2 GB tablet. `report.network.view` and `report.margin.view` are
`offline_mode = 'never'`. That is the correct behaviour: HQ reporting is a connected activity by
nature (`ADR-0003` — latency affects reporting freshness, not the counter). Head-office staff who
need breadth get a browser session, which is enrolled as a device with an **empty**
`device_location_scope` and therefore syncs nothing at all.

### The shared counter tablet, and what a user switch actually costs

§2.7 is explicit that the tablet is shared and that per-user unlock is a PIN, but every bucket in
§3.2.3 is parameterised on `request.user_id()` and the sync stream carries one user's JWT. The
earlier draft never resolved what that means, leaving two possibilities — a device holding the union
of every user who ever logged in, or a full re-download at every shift change — both bad and neither
chosen. Stated now:

**Scope is per user. The device holds the current user's bucket set, and a user switch is a delta,
not a re-download.** On switch the app reconnects with the new user's token; PowerSync drops buckets
no longer subscribed and downloads those newly subscribed. Buckets whose key is unchanged are not
re-downloaded, and that is what makes this affordable:

| Switch | Delta |
|---|---|
| Clerk → clerk, same outlet | **Nothing.** Same `location_ops` key, same `tenant_reference` |
| Clerk → outlet manager, same outlet | `location_credit_allowance` for that one location, plus `tenant_reviews` for the manager's queues. Hundreds of small rows |
| Anyone → visiting regional manager, on a **counter** tablet | **Nothing extra.** `device_location_scope` bounds the tablet to its own location, so the regional manager gets that outlet's buckets and no others |
| Anyone → visiting regional manager, on the manager's **own** device | Their full scope, which is what that device is provisioned for |

The third row is the point of `device_location_scope` and is why the device ceiling had to become a
real term rather than a column. Without it, a regional manager logging into a counter tablet pulls
17 further `location_ops` buckets over 2G onto a 2 GB device, and then discards them at logout —
which §3 Concern 2 correctly calls an outage rather than a deploy. The residual cost, measured at
the pilot rather than assumed, is **Q-SEC-5**.

The local database holds the current user's buckets; the previous user's rows are removed by the
sync client as ordinary bucket departures. Field-level encryption (§2.7) is per user, so a departing
user's sensitive fields are also key-inaccessible independent of whether the rows have gone yet.

---

## 2.6 Audit trail

Every price override, discount, refund, stock adjustment, credit-exposure change, GL posting,
period close, tax-rate edit, role and permission change, assignment change, device enrolment,
revocation and scope change, every platform-operator access, **every sensitive report read**, and
**every authorization denial** writes an `audit_event`.

```sql
CREATE TABLE app.audit_event (
  -- Emitted by app.new_tenant_table (§4.2.3), so tenant_id, id, write_id and hlc come from
  -- app.tenant_row_base and this table satisfies §4.2.5's has_write_id assertion rather than
  -- needing an exemption it is not on the list for.
  tenant_id          uuid        NOT NULL,
  id                 uuid        NOT NULL,          -- server-assigned UUIDv7
  write_id           uuid        NOT NULL,          -- the unit of work this act belongs to
  hlc                app.hlc     NOT NULL,          -- SERVER-STAMPED at ingest (§3.4.1, §4.2.1)

  event_class        text        NOT NULL           -- 'write' | 'denial' | 'sensitive_read'
                                 CHECK (event_class IN ('write','denial','sensitive_read')),
  actor_kind         text        NOT NULL,          -- 'user' | 'system' | 'platform_operator'
  actor_user_id      uuid,
  actor_device_id    uuid,
  location_id        uuid,                          -- from the session, never the payload (§2.2)
  action             text        NOT NULL,          -- 'pos.price.override'
  permission_used    text        NOT NULL REFERENCES platform.permission(key),
  decision           text        NOT NULL           -- 'allow' | 'deny'
                                 CHECK (decision IN ('allow','deny')),
  deny_reason        text,                          -- authorize()'s Decision.reason, NULL if allow
  grant_id           uuid,                          -- WHICH role_assignment authorised it
  bound_applied      jsonb,                         -- the effective bound at decision time
  subject_table      text        NOT NULL,
  subject_id         uuid,                          -- NULL for a denial with no subject yet
  before             jsonb,
  after              jsonb,
  reason_code        text,                          -- NOT NULL for reason-coded actions (trigger)
  reason_note        text,
  read_extent        jsonb,                         -- sensitive_read: report id, filters, row count,
                                                    -- and total value disclosed
  claimed_hlc        app.hlc,                       -- what the device asserted. UNTRUSTED.
  device_wall_at     timestamptz,                   -- UNTRUSTED. Evidence, never a fact.
  clock_skew_ms      bigint,                        -- device_wall_at - server_received_at
  monotonic_since_auth_ms bigint,                   -- LEASE-TAMPER EVIDENCE ONLY (§2.7)
  server_received_at timestamptz NOT NULL DEFAULT transaction_timestamp(),   -- trusted
  business_date      date,                          -- FROM THE CASH SESSION (§3.4.2). Never derived.

  PRIMARY KEY (tenant_id, id)
);

-- The earlier draft had no index beyond the PK, so every access pattern it named — the sealer's
-- range scan, by subject, by actor, by time — was a sequential scan of the audit table.
CREATE INDEX ON app.audit_event (tenant_id, subject_table, subject_id, id);
CREATE INDEX ON app.audit_event (tenant_id, actor_user_id, id);
CREATE INDEX ON app.audit_event (tenant_id, server_received_at);
CREATE INDEX ON app.audit_event (tenant_id, action, id) WHERE decision = 'deny';
```

**The HLC is server-stamped, and this was the sharpest defect in the earlier draft.** It carried
`logical_ts bytea NOT NULL, -- HLC from the device`. §3.4.1 rules categorically that the HLC written
to `write_log` and to every row is **generated server-side at ingest**, with the client's value kept
as `claimed_hlc` (untrusted, display and forensics only), because accepting a device HLC is *"a
permanent, unrecoverable corruption path with an alert attached to it."* Applying that to the *audit
trail* — the one artefact whose ordering must survive an adversary — was worse than applying it
anywhere else: a rooted tablet stamps a price override with an HLC below the tenant's watermark and
it sorts before the grant that authorised it, or above it and it sorts after the period close. The
type is §4.2.1's `app.hlc` (the fixed-width text projection of §3.4.1's composite, `COLLATE "C"`,
full 32-hex node), not `bytea`.

`grant_id` and `bound_applied` are worth the columns: they record *which* assignment authorised the
act and *what ceiling applied*, so revoking a role next month does not erase why the act was
permitted last month. Because both `role_assignment` and `role_permission` are effective-dated and
neither is deletable (§2.4), "who could have done this on 14 March, and up to what value?" is
answerable from data rather than reconstructed from memory. The earlier draft claimed this on the
strength of `role_assignment` alone, and it was not true.

### Reads and denials

Two classes the earlier draft did not have, both of which are how this trail earns its name:

- **`sensitive_read`.** An Accounts user holding `report.margin.view` and `report.network.view` can
  export the entire customer credit book and the margin curve. For a system of record holding credit
  positions, that must not be traceless. Every report marked sensitive in its definition writes one
  row carrying the report identity, the filters, the row count and the total value disclosed
  (`read_extent`). Cost: one insert per report run. Accepted.
- **`denial`.** `authorize()` returning `no_permission | out_of_scope | bound_exceeded |
  stale_session | offline_mode` writes a row. Forty probes at a price override in an afternoon are a
  pattern; forty silent failures are nothing. A rate limiter on the *audit* insert would defeat the
  purpose, so denials are written unconditionally and the **alerting** is what is thresholded.
  `UNAUTHORIZED_WRITE` reviews (§2.4) write a denial row as well as opening the review; the earlier
  draft routed them only to the queue.

### Append-only, enforced rather than promised

```sql
REVOKE ALL     ON app.audit_event FROM PUBLIC;
GRANT  INSERT, SELECT ON app.audit_event TO app_rw;
GRANT  SELECT  ON app.audit_event TO app_ro;
REVOKE UPDATE, DELETE, TRUNCATE ON app.audit_event FROM app_rw, app_ro;
-- TRUNCATE is called out because RLS never applies to TRUNCATE: a policy would not have stopped it.

CREATE TRIGGER audit_event_immutable BEFORE UPDATE OR DELETE ON app.audit_event
  FOR EACH ROW EXECUTE FUNCTION app.raise_immutable();

CREATE POLICY audit_read  ON app.audit_event FOR SELECT TO app_rw, app_ro
  USING (tenant_id = app.current_tenant());
CREATE POLICY audit_write ON app.audit_event FOR INSERT TO app_rw
  WITH CHECK (tenant_id = app.current_tenant());
-- deliberately NO policy for UPDATE or DELETE: with RLS forced, absence of a policy denies.
-- Policies carry an explicit TO clause; without one they apply to PUBLIC, which is not the intent.
```

### The seal, and what it can and cannot prove

A grant and a trigger stop the application. They do not stop someone with `app_migrate`. So a sealer
job computes a Merkle root over each tenant's newly sealable rows and writes:

```sql
CREATE TABLE platform.audit_seal (
  tenant_id     uuid NOT NULL,
  seal_no       bigint NOT NULL,          -- per tenant, gapless: seals chain, rows do not
  id_from       uuid NOT NULL,            -- inclusive; audit_event.id (UUIDv7)
  id_to         uuid NOT NULL,            -- inclusive
  row_count     bigint NOT NULL,          -- what a deletion changes
  root_hash     bytea NOT NULL,
  prev_seal_hash bytea NOT NULL,          -- seals chain, so a whole seal cannot be dropped
  xid_horizon   xid8 NOT NULL,            -- see below
  sealed_at     timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, seal_no)
);
```

**The commit-order race, and why `seq` is gone.** The earlier draft sealed "a Merkle root over each
tenant's new `seq` range" every five minutes, with `seq` "per-tenant monotonic, server-assigned".
If `seq` comes from a sequence, values are handed out **before** commit and out of commit order, so
a transaction holding `seq = 1000` can commit *after* the sealer has sealed through 1005. That row
is then either outside every seal forever, or it breaks the seal it belongs to — an unfalsifiable
alarm. Rollbacks leave permanent gaps indistinguishable from deletions, which is the one thing the
seal exists to detect. And there was no `UNIQUE (tenant_id, seq)` and no index on it, so the range
scan was a sequential scan.

The fix is a **transaction-visibility horizon rather than a counter**:

- The sealer takes `h = pg_snapshot_xmin(pg_current_snapshot())` and seals only rows whose `xmin`
  precedes `h`. Every transaction that could have produced such a row has committed or aborted, so
  the sealed set is stable and complete for that range. Rows from in-flight transactions are sealed
  by the *next* seal, in ordinary `id` order, with no gap and no alarm.
- Rows are ordered and ranged by **`id`** — a server-assigned UUIDv7, already the primary key, so
  the range scan is an index scan on `(tenant_id, id)`. Nobody expects UUIDv7s to be contiguous, so
  there is no gap to misread. What the seal asserts is *"these `row_count` rows, in this id range,
  hash to this root"*; a deletion changes both the count and the root.
- Seals chain on `prev_seal_hash` and are shipped to object storage with an object-lock retention
  policy, so removing a whole seal is also detectable.

Chaining each *row* to its predecessor would be stronger but serialises inserts per tenant, and this
system's whole architecture is a burst of writes arriving together after a sync. The cost of
batching is an unsealed tail of up to five minutes. Accepted, and named.

**What the seal cannot prove, stated next to it because it bounds everything above.** Audit rows are
server-assigned and are created when a mutation *arrives*, so **an act performed offline exists in
the audit trail only once its mutation reaches the server.** A device that never reconnects, or a
rooted device that drops one mutation from its outbox before uploading, produces no audit row for an
act that happened. The seal proves that what arrived has not been altered; it proves nothing about
what did not arrive. The controls on that gap are elsewhere and are the same ones that protect the
sales themselves: §3.11.4's completeness attestation gating period close, the drain-before-wipe rule
in §2.7, the 60-second Phase 1 sync target, and daily per-outlet cash reconciliation.

### The untrusted wall clock

A shop tablet's clock is wrong more often than anyone expects — a flat battery kills the RTC, and
staff change the time to make an alarm behave. It is also *worth* changing: backdating a price
override to before an audit period, or a sale to before a tax-rate change, is a real motive.

**Rule: `device_wall_at` is recorded and used for nothing.** Not for ordering (the server-stamped
HLC does that), not for tie-breaking, not for tax-rate selection, not for period assignment, not for
any `WHERE` in a report. It exists so an operator can be shown what their own device believed.

**`business_date` comes from the open cash session, not from the device clock, and not from a
clamp.** §3.4.2 states it categorically and §4.7.1 states it in DDL — `business_date date NOT NULL,
-- FROM THE CASH SESSION, never from the device clock` — and §4 records that the clamp construction
was considered and rejected by name as *"the device clock plus an offset plus a rule."*

The earlier draft of this section built the clamp anyway:
`business_date = clamp(device_wall_clock, last_authenticated_at, server_received_at)`, with a
"residual weakness" escalated as an open question. That is a defect, not a difference of emphasis.
`business_date` is the VAT tax point and the GL period key, so the rule made the tax point a function
of an attacker-controlled clock bounded only by the offline interval — which §2.7 then lets a tenant
configure up to 14 days. A clerk sets the tablet back four days, sells at a pre-increase VAT rate
(`ADR-0007` reprices on transaction date), and the design recorded an anomaly flag rather than
refusing. Worse, keeping the machinery *and* the open question meant a Phase 1 implementer reading
§2 would have built the clamp while another reading §3 and §4 built the session, and the two would
have disagreed about which day a sale belongs to.

**The clamp, its derivation and the open question that depended on it are deleted.** What §2 owns is
the security residue, which is narrower and true:

- The cash session is a **human assertion**, and an unvalidated human input is not a control. Its
  integrity comes from §3.4.2's four constraints, enforced on `app.cash_session` (§4.8a): one
  calendar day maximum per session; hard auto-close at `location.timezone` midnight with a
  carry-over prompt that opens a *new* session; refusal to open more than ±1 day from server time
  whenever the device is online at open, with `opened_offline = true` recorded when it is not; and
  refusal to open into a closed or locked period.
- `sale.cash_session_id` is `NOT NULL`, so there is no path to a `business_date` that was not
  asserted by a named human at a stated time — and that human is in the audit trail.
- The device wall clock is **evidence**: `device_wall_at` and `clock_skew_ms` are recorded, and a
  device with persistent skew is surfaced to its location's manager. §3.4.1 already refuses a write
  beyond ±24 hours of skew with a retryable `409 CLOCK_RESYNC_REQUIRED`, so nothing poisoned enters
  the order and nothing is lost.
- **`monotonic_since_auth_ms` survives, with one job only: lease-tamper evidence** (§2.7). It is
  boot-relative and not settable by changing the date, so a large disagreement between it and the
  wall-clock delta is direct evidence of a clock change. It is not an input to any date.

**Late arrivals follow §5, not a review queue.** The earlier draft sent a late transaction whose date
falls in a closed period to "the review queue"; §5 rules that it posts into the **earliest open
period**, retains its `document_date`, sets `is_late_arrival = true`, and is listed on the
late-arrivals report at the next close — with no review step and with period status enforced by a
database trigger rather than application code. §5's wording is adopted verbatim. Nobody gets to
reopen the books by being offline, and nobody has to work a queue to close a month either.

---

## 2.7 Devices: enrolment, revocation, local data, and the offline session

The attack surface is not the server. It is a hundred-odd cheap Android tablets on shop counters
across six regions, any of which can be picked up and walked away with.

### Enrolment

```sql
CREATE TABLE app.device (
  -- app.new_tenant_table base
  label      text NOT NULL,
  public_key bytea NOT NULL,               -- device keypair; private half never leaves the device
  jkt        text NOT NULL,                -- JWK thumbprint of public_key; goes into the token's cnf
  form_factor text NOT NULL                -- 'tablet' | 'browser' — a browser session is enrolled
             CHECK (form_factor IN ('tablet','browser')),  -- so every human write has a device_id

  -- ONE status vocabulary, shared with §3.11.4's device_sync_state.enrolment_status.
  status text NOT NULL CHECK (status IN ('active','suspended','retired')),
  retired_reason text CHECK (retired_reason IN ('lost','stolen','damaged','decommissioned','replaced')),
  retired_by uuid, retired_at timestamptz,

  enrolled_by uuid NOT NULL, enrolled_at timestamptz NOT NULL,
  last_authenticated_at timestamptz, last_seen_at timestamptz, app_version text
);
-- Location scope is app.device_location_scope (§2.5), not a single home_location_id column.
-- A device at a GROUP node, a device moved between outlets and a device with no scope at all
-- (the browser session) are all expressible; a single NOT NULL column expressed none of them.
```

**One status vocabulary, because two produced an undefined period close.** The earlier draft used
`'active' | 'suspended' | 'revoked'` while §3.11.4's `device_sync_state.enrolment_status` is
`'active' | 'suspended' | 'retired'`, and §5's close gate is that a period cannot lock while **every
active enrolled device** at a location has not attested an empty queue, with a non-attesting device
**blocking the close and being named**. A stolen device that was `revoked` in §2 mapped to no §3
status: depending on which table the gate consulted, either every month-end close was permanently
blocked by a tablet in a thief's pocket, or the device silently vanished from the gate and the
audited-exclusion record §5 requires was never created. `retired` with a `retired_reason` is the
single vocabulary; `device_sync_state.enrolment_status` is a projection of `device.status`.

**Revoking a device performs the §3.11.4 exclusion as part of the same audited action.** Retiring a
device writes the `audit_event`, sets `enrolment_status = 'retired'`, and records the device's
last-reported `outstanding_estimate` on the close record, so the exclusion is visible with a number
attached rather than as an absence. Who is entitled to perform that exclusion is
`docs/open-questions.md` **Q19**, already open and owned; this section supplies the mechanism, not
the policy.

Enrolment is **online, in person, and permissioned**. A holder of `admin.device.enrol` issues a
one-time enrolment code. Its parameters, which the earlier draft left unstated even though it is the
only thing between an attacker and an enrolled device inside a tenant:

- **8 characters from Crockford base32** (32 symbols, no I/L/O/U, case-insensitive) — **40 bits** of
  entropy, generated from a CSPRNG.
- **Single use, 15-minute TTL, bound to tenant and location**, invalidated on first redemption
  attempt whether or not it succeeds.
- **Redemption is rate-limited**: 5 attempts per source per hour and 20 per tenant per hour, with
  the tenant limit alerting rather than merely refusing. At 40 bits with a 15-minute window and 20
  attempts an hour, blind guessing is not a threat; the rate limit exists because the code is
  human-transcribed and therefore sometimes reused or photographed.

The device generates a non-extractable Ed25519 keypair via WebCrypto (`extractable: false`, the
`CryptoKey` handle persisted in IndexedDB) and registers the public half; its thumbprint becomes
`jkt` and is bound into every access token as `cnf.jkt` (§2.2). Enrolment is an audited event.

The keypair binds the *device*; users still authenticate individually, because a counter tablet is
shared. Per-user unlock is a 6-digit PIN that unwraps a per-user, per-device key. The PIN never
leaves the device and is never a server credential.

**The PIN, honestly.** The earlier draft said six digits is "acceptable only because the attempt cap
is enforced before the key can be derived". Against the adversary this section itself names — root
plus the browser profile — that argument is wrong: the attempt cap is an app-level counter in the
same storage the attacker owns. What actually stands between the attacker and the key is the KDF.
Parameters: **Argon2id, m = 64 MiB, t = 3, p = 1**, which is roughly 300–500 ms per guess on the
low-end Android class `ADR-0003` targets and perhaps 5–15 ms per guess on a desktop GPU-assisted
attack. At 10^6 candidates that is **hours to a couple of days of offline work** — not years. So the
PIN is a delay, not a barrier, and it is sized to the window in which the lease expires and the
server-held wrap becomes unavailable, not to the value of the data. Two consequences follow, both
already in the design: the offline lease horizon is what genuinely bounds a stolen device, and
minimisation is what bounds what is worth stealing. If the pilot's threat picture changes, the
answer is hardware-backed key storage (**Q-SEC-1**), not more PIN digits.

**Honest limit of the PWA choice.** A non-extractable WebCrypto key in a browser's IndexedDB
resists casual copying — JavaScript cannot read the raw key material — but it is not hardware-backed
on most low-end Android through a browser, and it does not resist an attacker with root and offline
access to the browser profile. `ADR-0003` names thermal receipt printing as the PWA's weakest point
and requires a hardware survey in Phase 1. **Hardware-backed key storage should be added to that
same survey**, because it is the second finding that would justify revisiting the native-Android
option, and it is cheaper to learn both at once.

### Local data at rest

Three controls, in descending order of how much work they actually do:

1. **Minimisation — by far the strongest.** A device holds only `user_location_scope ∩
   device_location_scope` (§2.5) and only a rolling window of transactional history (default 90
   days, tenant-configurable with a jurisdiction-pack floor, enforced per row via `archived_at` per
   §3.2.4). A stolen Micro-Outlet tablet exposes one outlet for one quarter, not the network for ten
   years. Nothing else on this list comes close to that reduction.
2. **Field-level encryption of a named sensitive set** — customer contact details, cost prices and
   margins, and the `credit_allowance` figures — under a data key held in memory only after PIN
   unlock, wrapped both by the PIN-derived key and by a server-held key so that a PIN reset does not
   destroy unsynced data. **The set no longer names "credit limits and balances", because §3.2.2
   rules that the customer bucket carries "No balances, no limits, no ageing" and the credit book
   never reaches an outlet device at all.** What is on a till is `cap_minor`, `headroom_minor`,
   `offline_ceiling_minor`, `credit_hold` and `snapshot_as_of` for its own location, and that is
   what gets encrypted. The cost is real and bounds the scope: an encrypted column cannot be
   searched or indexed locally, so anything the POS must search offline — product, price, stock
   quantity — stays plaintext. Encryption whose key must be present for the app to run is a speed
   bump, not a wall. Do not oversell it.
3. **Device policy** — screen lock and Android file-based encryption required at enrolment. A PWA
   cannot verify either, which is a genuine gap; `devops-engineer` enforces it as a provisioning
   checklist and, at scale, MDM.

### Revocation

Revocation has to work against a device that is not listening, so it is four mechanisms and only the
last is unconditional:

1. **At the sync service, by parameter query.** `status <> 'active'` makes the device-liveness join
   in §2.3's Contract 1 return zero rows, so the parameter query yields no buckets and the stream
   stops. **This is the mechanism that actually works**, because it is the same fail-closed path as
   everything else and does not require the sync service to know what revocation is. The earlier
   draft said "the sync connection is dropped" and put `did`/`sid` in an application revocation set
   — which the sync service does not consult, so a revoked device's stream was unaffected until its
   token expired.
2. **At the API, immediately.** `did`, `sid` and `jti` enter the revocation set checked on every
   request; the 15-minute access token bounds the residual, and the DPoP binding (§2.2) means a
   token lifted off the device is not usable elsewhere in the meantime. The set fails **closed** if
   its store is unavailable.
3. **On the device, on next contact — but the outbox drains first.** Detailed below.
4. **Time-bounded by design.** The offline lease expires whether or not the device ever hears from
   us again. **This is what makes revocation real without the device's cooperation.**

Revoking a *user* and revoking a *device* are separate actions with separate consequences: sacking
a clerk must not brick a shared counter tablet; losing a tablet must not lock out the clerk.

### Drain before wipe

The earlier draft had the client wipe its local database, keys and **outbox** on `403
device_revoked`, justified by "those writes will be quarantined server-side anyway". **That
parenthetical is false, and it is the most expensive error in the section.** The outbox is by
definition the set of writes the server does *not* have. A tablet reported stolen at 09:00 and found
in the stockroom at 11:00 reconnects, receives the revocation, and destroys three days of unsynced
sales, stock movements and credit tenders **before uploading any of them** — a recoverable case,
deliberately made unrecoverable. It also broke §3.11.2's rule that *a client never completes a CRUD
transaction into local-only storage; either the server has the write, or the server has the
dead-letter, or the queue stays blocked.* And `403 device_revoked` collided with §3.3.4's taxonomy,
where `403` means *permission denied, possibly a stale snapshot, retry with backoff, never discard* —
so a device could not distinguish the two, and either revoked devices retried forever or
stale-permission writes were wiped.

The sequence, corrected:

1. **Revocation returns `423 LOCKED` with `reason = "device_revoked"`.** `423` is already in
   §3.3.4's retryable set, which is exactly right: the client must keep trying to reach the server,
   not give up and delete.
2. **The client's first action is a drain-only upload** to `/sync/revoked-drain`, which accepts
   writes from a retired device and posts **nothing into the books**. Every mutation becomes an
   `app.conflict_review` row with `conflict_class = 'REVOKED_DEVICE_WRITE'` and the original payload
   intact, for a holder of `sync.conflict.review`. Drain is idempotent on `write_id` like every other
   write path, so a partial drain resumes rather than duplicating.
3. **The ordinary upload queue stays blocked throughout.** No CRUD transaction is completed while
   the drain runs, so §3.11.2's rule holds without amendment: either the server has the write, or
   the server has it in review, or the queue stays blocked. A blocked queue is visible at the
   counter; a deleted one is not.
4. **The wipe happens only after the server acknowledges the drain**, and then it is complete: local
   database, device key, wrapped user keys, cached tokens.
5. **If the drain does not complete within 24 hours of the first `423`**, the client wipes anyway,
   reports the **count of undrained writes** to `/sync/revoked-drain/abandoned` (a bare counter, no
   payload, which succeeds far more often than a bulk upload over 2G), and the server raises a
   severity-1 alarm naming the device, the location and the count. If even the counter cannot be
   sent, the device wipes at the 24-hour mark and the loss is unattributed.

Stating the trade explicitly: a device we believe is stolen keeps its data for up to 24 hours after
it reappears. That is the correct choice, because the case where it reappears is overwhelmingly the
case where it was never stolen, and **a lost sale is a worse outcome than 24 further hours of
exposure on a device that is already in the building.** For a device believed to be in hostile hands,
`retired_reason = 'stolen'` shortens the drain window to zero and wipes on contact — an explicit,
audited choice by the revoking user at the moment of revocation, not a default.

The honest residual: a stolen device that never reconnects takes its unsynced legitimate sales with
it and produces no audit rows for them (§2.6). That is why the Phase 1 acceptance criterion of
syncing within 60 seconds of reconnection is a security requirement as much as a sync one, and why
daily per-outlet cash reconciliation is not optional.

### The offline session — an explicit decision, not a hand-wave

The tension is genuine. Force a re-login and a clerk in Wenchi with no signal cannot trade. Issue a
credential that does not expire and a stolen tablet is a permanent window into the business. Both
failures are unacceptable; the answer is to make the credential decay in a way that costs the
business its *risk exposure* before it costs it its *ability to trade*.

**Three credentials, deliberately separate:**

| Credential | Lifetime | Where it works | Purpose |
|---|---|---|---|
| Access token (JWT, DPoP-bound) | 15 min | Online only | API calls, opening a sync connection |
| Device refresh credential | Long-lived, device-key-bound | Online only | Obtaining access tokens |
| **Offline lease** | `T` (default 72 h) + grace | Offline | Authorises local operation while unreachable |

The **lease** is issued by the server on every successful sync:

```jsonc
{
  "tid": "...", "sub": "...", "did": "...",
  "scope": ["<location_id>", "..."],      // user_location_scope ∩ device_location_scope
  "permission_snapshot_hash": "sha256:...",
  "issued_at": 1787000000,               // server clock — the only trustworthy timestamp here
  "full_until":   1787259200,            // issued_at + 72h
  "hard_stop_at": 1787345600             // full_until + 24h grace
}
```

**Lease signing keys are separate from the JWT signing keys and rotate on a different schedule**,
because the earlier draft had a device pinning a key that rotated quarterly while permitting leases
up to 14 days, and said nothing about what a device does with a lease it cannot verify. Rules:

- The lease is signed by a dedicated **lease key**, rotated **annually** with a **two-key overlap**,
  so at any moment a device recognises the current and the previous key. Pins are refreshed on every
  sync, so a device that has synced within a year always holds both.
- **A lease signed by an unrecognised `kid` is not honoured for extension, and does not seal the
  device.** The device continues on the horizons of the last lease it *did* verify, and raises a
  visible "cannot verify server response, working offline" state. Sealing on an unverifiable lease
  would turn a key-rotation mistake at the platform into a fleet-wide outage, which is a far more
  likely event than the attack it would be defending against.

**Enforcing expiry against a clock the device controls is circular**, so expiry is whichever of
these fires first:

- wall clock passes `full_until`;
- **monotonic elapsed since issue exceeds `T`** (boot-relative, not settable by changing the date) —
  this is the only consumer of `monotonic_since_auth_ms`;
- the wall clock jumps *backwards* past the last recorded value — a backwards jump is prima facie
  tampering and locks the device immediately.

A reboot resets the monotonic reference, so on cold start the app falls back to the wall clock plus
the backwards-jump check. A rooted attacker who edits the local state defeats all of it — which is
precisely why the lease is not the only control, and why minimisation (§2.5), the sync-service
liveness join (§2.3) and the review routing of revoked-device writes are the ones carrying the
weight.

**Two horizons, because a cliff edge mid-trading-day is an outage the business cannot absorb.** The
horizons map onto `platform.permission.offline_mode` (§2.4), which is the single place the sets are
enumerated:

- **0 → `full_until` (72 h): full operation.** Everything the user's permissions allow whose
  `offline_mode` is `until_lease_expiry` or `always`. `never` permissions have never worked offline
  and do not start now.
- **`full_until` → `hard_stop_at` (+24 h): restricted mode.** Only `offline_mode = 'always'`
  continues: cash sales at the resolved list price, stock lookups, receipt reprints within the
  window. Everything marked `until_lease_expiry` stops — price overrides, refunds, stock
  adjustments, and **credit sales**. A persistent banner shows the remaining time and a "reconnect
  to restore" action. The outlet keeps taking money; it stops taking risk.
- **After `hard_stop_at`: sealed.** Read-only, no writes accepted, the in-memory data key dropped
  and non-derivable without a fresh server token. **Data is not wiped** — an outlet with a genuinely
  long outage must not lose its unsynced sales — but it is unreadable and the outbox survives
  encrypted until a successful server authentication reopens it.

**Credit sales offline are governed by the allowance, not by the role bound**, and restricted mode
is a *third* control on top of both. Within `0 → full_until` a credit sale is permitted if the user
holds `credit.sell`, the order is within `max_order_value_minor`, **and** it fits inside the
customer's `credit_allowance` for that location — `headroom_minor` and `offline_ceiling_minor`
(§3.2.2, §6.7), which is the control that actually bounds exposure because it is per customer per
location rather than per order. The earlier draft did not mention the allowance and implied the role
bound was the credit control; it is not.

`T` is tenant-configurable up to a platform ceiling of **14 days**. Extending it requires
`admin.offline_lease.extend`, is audited, and appears on the tenant's security report, because
extending it is a deliberate weakening of the posture and should look like one. Default 72 h covers
a long weekend plus a bad Monday, which is the shape of the outages `CLAUDE.md` §1 describes
("hours or days"). It is nonetheless a guess until the pilot produces real Techiman connectivity
data — **Q-SEC-3**.

**Wipe policy, restated after the drain correction:**

- **Server-signalled revocation drains first, then wipes everything** (above). The only writes lost
  are those the drain could not deliver, and their count is reported and alarmed.
- **Failed unlock attempts seal but never wipe.** A staff member with fat fingers must not be able
  to destroy the day's takings.
- **Lease expiry seals but never wipes**, for the same reason.

---

## 2.8 Platform operator access

A multi-tenant product needs a support path — a customer will eventually ring with a broken ledger
— and an unaudited support path is a tenant boundary with a door in it. The earlier draft described
controls that its own role model did not contain; they exist now.

```sql
CREATE TABLE platform.support_grant (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, operator_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('read','write')),
  reason text NOT NULL, ticket_ref text NOT NULL,
  granted_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  approver_1 uuid NOT NULL,
  approver_2 uuid,                                  -- write requires two DISTINCT approvers
  CHECK (expires_at <= granted_at + interval '4 hours'),
  CHECK (mode = 'read' OR (approver_2 IS NOT NULL AND approver_2 <> approver_1)),
  CHECK (approver_1 <> operator_id AND (approver_2 IS NULL OR approver_2 <> operator_id))
);
```

Read-only by default; four-hour maximum window; reason and ticket mandatory; **write access requires
two distinct approvers, neither of whom is the operator** — the earlier draft had a single
`approved_by` column, which cannot record two approvers, so the two-person rule was prose with no
mechanism. The grant is what sets `app.tenant_id` for that session, and a `read` grant connects as
**`app_ro`** (§2.3) rather than as a read-write role the operator promises not to write with. Every
action writes `audit_event` rows with `actor_kind = 'platform_operator'` **into the tenant's own
audit trail**, where the tenant can see them.

**`app_migrate` is the role the earlier draft's controls did not touch, and it is the one that can
read everything.** It owns every table and has `BYPASSRLS`, so it can read and modify every tenant's
books and rewrite audit rows. Custody model, stated:

- **No interactive login.** The role's credential lives in the secrets manager and is injected into
  the migration runner and two scheduled jobs (the audit sealer, the archival job) and nowhere else.
- **Human use is a break-glass path**: a time-boxed credential checkout requiring two distinct
  approvers, expiring in one hour, with the session recorded.
- **Every checkout writes a `platform_operator` audit row into every tenant whose data the session
  touched**, and the checkout record itself is covered by the audit seal (§2.6) — which is why the
  sealer runs as `app_migrate` and the sealer's own activity is chained rather than self-attested.
- The scheduled jobs run under separately-scoped credentials with only the grants they need
  (`GRANT UPDATE (archived_at)` for archival, `SELECT` on `audit_event` plus `INSERT` on
  `audit_seal` for the sealer), not under the full owner role.

A customer whose books we can read without their knowing is a customer we should not expect to keep,
and until this paragraph existed that was a description of the actual state of the system rather
than of its policy.

---

## 2.9 Open questions

- **Q-SEC-1 — Hardware-backed key storage on the target tablets.** `OPEN` · owner
  `frontend-engineer` + `devops-engineer`. Add to the Phase 1 hardware survey alongside receipt
  printing (`ADR-0003`). If the answer is that browser-held keys are unacceptable for a business
  running on credit, that is the second finding that reopens the native-Android question. §2.7's
  Argon2id parameters make the PIN a delay measured in hours, not years, which raises the value of
  this answer.
- **Q-SEC-2 — May a device hold an offline lease across a statutory period end?** `NEEDS-HUMAN` ·
  owner accountant, at the `CLAUDE.md` §2.8 gate. **Restated.** The previous form of this question
  asked whether a *clamped business date* is acceptable at period end; the clamp is deleted (§2.6)
  and `business_date` now comes from a human-opened, server-validated cash session, so that question
  no longer exists. What survives is narrower and still not an engineer's call: a session opened
  offline is validated only when the device is next online, and a device on a 72-hour (or, if a
  tenant extends it, 14-day) lease can trade across a month end and arrive after the close, posting
  as `is_late_arrival` into the next open period per §5. The accountant must say whether that is
  tolerable for a statutory period, and if not, the remedy is a **shorter maximum lease near period
  end** — a business trade, not an engineering one. Promote to `docs/open-questions.md`.
- **Q-SEC-3 — Is 72 hours the right default lease, and 72 hours the right pre-stage TTL?** `OPEN` ·
  owner `product-manager` + pilot. Chosen from the constitution's "hours or days", not from data.
  The same number now also bounds §2.2's first-login pre-staging, so a new hire cannot be activated
  on a device that has been dark longer than the lease. Instrument actual offline durations per
  outlet from day one of the pilot and revisit before the first Micro-Outlet opens.
- **Q-SEC-4 — Rolling history window.** `OPEN` · owner `sync-architect` + `product-manager`. 90 days
  bounds a stolen device's exposure and a 2 GB tablet's working set, but a contractor on 60-day
  terms plus a dispute puts genuinely needed history right at the edge. §3.2.4 makes the window
  tenant configuration with a jurisdiction-pack floor; the number still needs a real answer against
  tenant #1's ageing profile before Phase 1 go-live.
- **Q-SEC-5 — What does a shift change cost on a shared tablet over 2G?** `OPEN` · owner
  `sync-architect` + pilot. **New.** §2.5 rules that scope is per user and a switch is a bucket
  delta, and that `device_location_scope` prevents the pathological case of a regional manager
  logging into a counter tablet. The clerk→manager delta is small in theory (`location_credit_allowance`
  for one location plus `tenant_reviews`); it has not been measured on a real link. If it is not
  sub-10-seconds at a Techiman-grade connection, the shift-change UX needs a design, not a bug
  report. Promote to `docs/open-questions.md`.
- **Q-SEC-6 — Is a once-online bootstrap acceptable for new staff?** `NEEDS-HUMAN` · owner founder /
  head of operations. **New.** §2.2 rules that a user must be online once to become usable on a
  device, mitigated by 72-hour pre-staging. A new hire starting at a Micro-Outlet whose link has
  been down for four days cannot be activated there, and must either trade under an existing user
  or wait. The alternative is a locally-mintable credential, which a rooted device could forge, so
  engineering has taken the safer side. The business must confirm that the staffing consequence is
  acceptable and say what the outlet should do in the meantime. Promote to `docs/open-questions.md`.
- **Q-SEC-7 — Who are the two approvers for platform write access?** `NEEDS-HUMAN` · owner founder +
  `devops-engineer`. **New.** §2.8 requires two distinct approvers for a `write` support grant and
  for an `app_migrate` break-glass checkout, neither of whom may be the operator. At the size of the
  team that will run this platform at launch, "two distinct people who are both awake" is a real
  operational constraint, and an emergency at 02:00 on a Sunday is exactly when the rule will be
  under pressure. Either two named people commit to being reachable, or the rule needs a documented
  emergency single-approver path with a mandatory retrospective — but it must be decided in advance,
  not improvised during an incident. Promote to `docs/open-questions.md`.

---

## 2.10 Concerns

Three, none asking to reopen a decision.

**1. "RLS is the backstop" is not true of the sync path, and the constitution reads as though it
is.** `CLAUDE.md` §2.1 and `ADR-0005` both present RLS as the mechanism that makes a forgotten
predicate fail closed. For the API path that is exactly right. For the replication path it is
false — logical replication is not subject to RLS, and there is no database-level control behind a
sync rule. Postgres publication row filters cannot help, because the filter is static and cannot
reference a per-connection tenant. I am not arguing against shared-schema-with-RLS; I am arguing
that the *highest-consequence path in the system has one layer, not two*, and that the compensating
controls in §2.3 — generated rules, the tenant claim as a bucket key, the banned
`request.parameters()`, the device-liveness join, and a device-level two-tenant leak test in CI —
are load-bearing rather than belt-and-braces. If those tests are ever allowed to be flaky or
skipped, tenant isolation on the sync path has no backstop at all. **Worth saying out loud in
`ADR-0005`, not just here.**

**2. `ADR-0003` names receipt printing as the PWA's weak point; local key storage is a second one
and is not mentioned.** The decision is right for update distribution across 25 outlets and I would
make it again. But a PWA cannot hold a hardware-backed key, cannot verify that a device has a screen
lock, and cannot guarantee its local database is encrypted at rest — which puts more weight on data
minimisation and lease expiry than a native app would. §2.7 now states the Argon2id cost honestly
rather than implying the PIN is a barrier, which makes the gap sharper, not smaller. The ask is
small: add key storage and FBE status to the Phase 1 hardware survey that `ADR-0003` already
mandates, so both findings arrive together and the native-Android question, if it has to be
reopened, is reopened once.

**3. This section's cross-section contracts are not yet reflected in the sections that must carry
them, and §3.11.9 makes that a Phase 0 exit condition.** Three items, all small, none contentious,
all of which make something in another section wrong until they land:

| Contract | Lands in | Why it blocks |
|---|---|---|
| Device-liveness and `device_location_scope` joins in the parameter queries (§2.3 Contract 1) | §3.2.3 | Without them, revocation is not enforced at the sync service and the device ceiling does not exist |
| `role_id` removed from `app.staff_assignment`; `role_assignment` is the single assignment table (§2.5) | §4.11 | Two assignment tables feed one parameter query, and §4's has a default-open `NULL = all locations` encoding |
| `credit.sell` / `credit.read` as the canonical keys; `credit.*` domain added (§2.4) | already correct in §3.2.3 | §2 moved to §3, so nothing else changes — recorded so a future editor does not "fix" it back |

I do not think any of these is a decision; they are a reconciliation pass, and they should happen
before Phase 1 code rather than during it, exactly as §3.11.9 says.

---

## 2.11 Revisions from adversarial review

Reviewed 2026-08-21 against `CLAUDE.md`, `ADR-0001…0007` and the three authoritative sections
(§3 offline sync, §4 data model, §5 general ledger). **Eight blocking findings, twenty major,
eleven minor — thirty-nine in total.** Where this subsection and the body above differ, this
subsection governs.

### 2.11.1 The pattern behind the blocking findings

Six of the eight blocking findings, and most of the major ones, came from **one cause: this section
was drafted before §3, §4 and §5 were adversarially reviewed, and was not re-read against their
rulings afterwards.** In six places it did not merely differ from them — it **reinstated a specific
defect one of them had explicitly deleted**:

| §2 carried | Which section had deleted it | What the deleted version costs |
|---|---|---|
| `clamp(device_wall_clock, …)` for `business_date` | §3.4.2, §4.7.1, §4.17.2 — from the cash session | The VAT tax point becomes a function of an attacker-controlled clock |
| A per-table `idempotency_key` under a tenant-scoped unique index | §3.3.2, §4.2.2 — one registry, `write_log.id` | "Already applied" for a sale that was never applied |
| `tenant_reference` with no liveness check | §3 disposition #24 — membership check added | A suspended user's device keeps syncing for the life of its lease |
| `now()` and `business_date` in a sync data query | §3.2.4 — per-row `archived_at` on `server_received_at` | A frozen window and late rows delivered to nobody |
| A device-supplied HLC on the audit row | §3.4.1, §4.2.1 — server-stamped at ingest | An audit trail an attacker can reorder |
| A fourth name for the review queue (`sync_quarantine`) | §3.11.9, §4.12 — `conflict_review` | Two queues, one of which is not in any sync bucket |

That is not a naming problem. §3.11.1 names the same habit from the other side — *stating a strong
claim and not building the machinery underneath it* — and the corrective discipline is §4.17.1's:
**one table, one owner, a cross-reference rather than a second definition.** This section now cites
§3.2.3, §4.2.5, §4.3, §4.7.1, §4.9, §4.13 and §5 rather than restating them, and the places where it
must ask another section to change are listed as explicit contracts (§2.10 Concern 3) rather than
being quietly written a second way.

The one finding worth dwelling on separately is **B3**, because it was not a cross-section slip. The
section stated a guarantee — *"there is no path to either outcome that does not pass through the
permission check"* — and the guarantee was false against its own design: `price_list_id` was an
ungated client input, and a price list **is** a price, indirected once. Nothing in §3, §4 or §5
would have caught it. It is the reason the prohibition is now written as an **outcome** with an
enumerated permission family (§2.4) rather than as a list of two columns.

### 2.11.2 Mechanisms added

| Mechanism | Purpose | Where |
|---|---|---|
| `pos.pricelist.select` with `allowed_price_list_ids` | price-list choice becomes a grant, not a payload field | §2.4 |
| `platform.permission.raises_credit_exposure` + `credit.account.open` | the credit prohibition is an outcome with a named family, not a column | §2.4 |
| `offline_mode` enum replacing `requires_fresh_authorization` | one flag could not express "never offline" and "offline for T then not" | §2.4, §2.7 |
| `app.user_effective_permission` (trigger-maintained table) | §3.2.3 depends on it; §3.11.8 rules it may not be a view; §2 had never defined it | §2.4 |
| `revoked_at` / `valid_from` / `valid_to` + 60 s reconciler | an expired assignment now actually stops syncing | §2.5 |
| `app.device_location_scope` joined in the parameter query | the device ceiling becomes a term in the query instead of a promise on a column | §2.3, §2.5 |
| Device-liveness join in the parameter queries | revocation enforced at the sync service, fail-closed | §2.3 |
| DPoP binding, pinned `alg`, `jti`, split audiences | the token stops being a pure bearer credential | §2.2 |
| `423 LOCKED` + drain-only upload before wipe | a recovered device no longer destroys three days of unsynced sales | §2.7 |
| `app_ro` role | §2.8's "read-only by default" had no role behind it | §2.3, §2.8 |
| Two distinct approvers with a `CHECK`; `app_migrate` custody model | the two-person rule and the one role that can read every tenant | §2.8 |
| xid-horizon seal, `prev_seal_hash`, count in the seal | the seal no longer races commit order or mistake rollbacks for deletions | §2.6 |
| `sensitive_read` and `denial` audit classes | exporting the credit book, and forty probes at an override, are no longer traceless | §2.6 |
| `role_permission` effective dating + `EXCLUDE` + `REVOKE DELETE` | "who could do this on 14 March" is answerable from data | §2.4 |
| Payload ban extended to `location_id`, `device_id`, `user_id`, `business_date` | cross-location stock and GL corruption inside one tenant | §2.2 |
| IdP, 2FA, lockout, recovery and first-login pre-staging | the factor §2 owned and never described | §2.2 |

### 2.11.3 Full disposition

**Blocking**

| # | Finding | Disposition |
|---|---|---|
| B1 | `business_date` derived from the device wall clock | **Accepted.** Clamp, derivation and `Q-SEC-2`'s old form all deleted. `business_date` comes from the cash session (§3.4.2, §4.7.1, §4.8a); §2 states only the security residue and keeps `monotonic_since_auth_ms` as lease-tamper evidence. `Q-SEC-2` restated as the narrower period-end lease question. §2.6 |
| B2 | Server-signalled revocation wipes the outbox | **Accepted.** `423 LOCKED reason=device_revoked`; drain-only upload to a revoked-device ingest that posts nothing into the books; wipe only after ack, or at a 24 h timeout with the undrained count reported and alarmed. `retired_reason='stolen'` shortens the window to zero as an explicit audited choice. §2.7 |
| B3 | `price_list_id` is an ungated client input | **Accepted.** Server resolves the list per §4.6; a client assertion is a named `price_list_override` gated on `pos.pricelist.select` bounded by `allowed_price_list_ids`. Added as the third named non-skippable QA case. §2.4 |
| B4 | `stock_adjustment` DDL: per-table idempotency key, wrong name, no `write_id`, no scale, no dates | **Accepted.** Replaced with a §4.7.1-conformant `app.stock_movement` excerpt: `write_id` FK to `write_log`, `qty_scale`, `uom_id`, `business_date`, server-stamped `hlc`, `archived_at`, `app.qty`. `idempotency_key` deleted. The composite-FK argument survives and is strengthened by the `write_id` FK. §2.3 |
| B5 | Sync-rule example reinstates two fixed defects and drops the liveness check | **Accepted.** §2's listing deleted entirely; §3.2.3 cited as canonical. §2 keeps only the three properties it uniquely owns plus two explicit contracts on §3.2.3. `user_location_scope` gains `revoked_at` so §3's authoritative query can be written against §2's schema. §2.3, §2.4 |
| B6 | `audit_event.logical_ts` is an HLC from the device | **Accepted.** Server-stamped `app.hlc`, plus `claimed_hlc`, `device_wall_at` and `clock_skew_ms` as untrusted evidence. `write_id` added so the table satisfies §4.2.5's `has_write_id`. §2.6 |
| B7 | `location_node.kind` is tenant-defined; TRANSIT has no place | **Accepted.** §4.3's `app.location` adopted verbatim — closed `kind` enum, `location_type_id` for tenant vocabulary, `is_trading` / `is_postable_location` separate. Per-`kind` scope table added; TRANSIT is in scope for whoever holds the sending location and is never a sync target of its own. §2.5 |
| B8 | An expired `role_assignment` never propagates | **Accepted, both remedies.** `valid_from`/`valid_to`/`revoked_at` as a predicate filtered by the authorizer and the parameter queries, **and** a 60-second reconciler that materialises expiry and emits the notify. §2.2's cost sentence rewritten: the real staleness bound is 60 s, not 10 s. §2.5 |

**Major**

| # | Finding | Disposition |
|---|---|---|
| M1 | Two paths reach "outlet staff changed a credit limit" | **Accepted.** Prohibition restated as an outcome; `raises_credit_exposure` family enumerated (`credit.account.open`, `credit.limit.set`, `credit.terms.set`, `credit.hold.release`, `credit.cap.set`); the limit lives on `credit_account`, which `customer.create` cannot create. §2.4 |
| M2 | A `"0"` bound still grants the key, and the sync gate reads keys | **Accepted.** Absence, never a zero bound, is how a permission is withheld — stated as a platform rule with the reason (a parameter query cannot parse a `jsonb` bound). Outlet staff lose `credit.sell` in the template. §2.4 |
| M3 | Bound composition, escalation over bounds, `is_owner` uniqueness | **Accepted, all four.** Max-wins stated as an explicit consequence with a worked example plus `bound_override` to narrow; escalation predicate extended to bounds; `admin.assignment.manage` named and required to accompany `admin.role.manage`; partial unique index and immutability trigger on `is_owner`. §2.4 |
| M4 | `role_permission` undated; grants hard-deletable | **Accepted.** `role_permission` effective-dated and append-only with an `EXCLUDE` constraint; `DELETE` revoked on all three tables with a raising trigger; the as-of query is given. §2.4 |
| M5 | `unit_price_minor` is the wrong scale | **Accepted.** `unit_price_e4`, named as §4.13 rule 3 names it, with the 10,000× consequence stated. §2.4 |
| M6 | Bounded permissions: unspecified base, rounding point and side | **Accepted.** A table states the base, the rounding point and that both are evaluated on the server-recomputed figure, cross-referencing §4.13 rows 3, 4, 5, 6 and 10. Discount cap moved to the document, pre-allocation. §2.4 |
| M7 | The CI guard is the superseded version | **Accepted.** §2's guard deleted; §4.2.5 cited as canonical. `platform_support_grant` contradiction resolved — it is a `platform` table, outside the guard's scope, and it does carry `tenant_id`. "`app` is the only schema for tenant-owned tables" added as a stated rule with its own assertion. §2.3 |
| M8 | `SET LOCAL app.tenant_id = ?` is not valid SQL | **Accepted.** `SELECT set_config('app.tenant_id', $1::uuid::text, true)`, with the cast asserting the value is a UUID before it becomes a GUC string. §2.3 |
| M9 | `LISTEN`/`NOTIFY` does not work through a transaction pooler | **Accepted.** One dedicated non-pooled connection per instance for `LISTEN`, with stated drop behaviour (fall back to TTL, degraded metric). Correctness rests on the TTL and the reconciler; the notify is a latency optimisation, stated as such. §2.5 |
| M10 | Seal commit-order race; no `seq` uniqueness; no read or denial auditing; completeness unbounded | **Accepted; one remedy differs.** Read auditing (`sensitive_read` with extent), denial auditing, and the sync-bounded completeness limit are added verbatim as asked. On the seal, **`seq` is removed rather than made unique**: a per-tenant gapless counter either serialises audit inserts per tenant — against a design whose write pattern is a post-sync burst — or is a sequence, which is exactly the commit-order race. Sealing is on an `xid8` visibility horizon over the existing `(tenant_id, id)` UUIDv7 index, with `row_count` and a `prev_seal_hash` chain. This fixes all four sub-findings (race, gaps, uniqueness, sequential scan) without the serialisation. §2.6 |
| M11 | `user_effective_permission` undefined; permission keys do not match §3 | **Accepted.** Table defined, trigger-maintained, `location_id NOT NULL` and fully expanded rather than `NULL = all`. Vocabulary reconciled to §3.2.3: `pos.sell.credit` → **`credit.sell`**, **`credit.read`** added, `logistics.dispatch.manage` added, `credit` promoted to its own domain. §2 moved because §3's rules are authoritative. §2.4 |
| M12 | Revocation unenforceable at the sync service; no proof-of-possession | **Accepted.** DPoP over the existing enrolled Ed25519 key with `cnf.jkt`; device-liveness join in the parameter queries (Contract 1); `alg` pinned to EdDSA with `kid` resolution and a rate-limited JWKS refetch; `jti` added; audiences split; revocation-set lookup fails **closed** with the consequence stated. §2.2, §2.3, §2.7 |
| M13 | Two device status vocabularies; effect on period close undefined | **Accepted.** One vocabulary `'active'|'suspended'|'retired'` with `retired_reason`; `device_sync_state.enrolment_status` is a projection of it; revoking performs §3.11.4's exclusion in the same audited action, recording `outstanding_estimate` on the close. Who may exclude remains `open-questions.md` **Q19**. §2.7 |
| M14 | `requires_fresh_authorization` carries two meanings; credit-sale sets disagree | **Accepted.** Three-valued `offline_mode` on `platform.permission` as the single machine-readable source; restricted mode reconciled with §3.2.2/§6.7's `credit_allowance` and `offline_ceiling_minor`, with the explicit statement that `max_order_value_minor` is a per-order authority cap and not the exposure control. §2.4, §2.7 |
| M15 | Only `tenant_id` banned from payloads | **Accepted.** Generator and lint ban extended to `location_id`, `device_id`, `user_id` and `business_date`; `location_id` and `business_date` come from `ctx.cashSession`; `authorize()` takes its location from `AuthContext`. The same-tenant cross-location corruption path is spelled out, because no tenant-isolation test would have caught it. §2.2 |
| M16 | Shared tablet versus per-user buckets; `sync_profile` has no mechanism | **Accepted.** Model stated and priced per switch type; `sync_profile` replaced by `app.device_location_scope`, a real term in the parameter query. The unmeasured cost becomes **Q-SEC-5**. §2.5 |
| M17 | What authenticates a user is never stated | **Accepted.** External OIDC IdP; 2FA required for `is_sensitive` holders; rate limiting, lockout, recovery and de-provisioning stated; enrolment code alphabet (Crockford base32, 8 chars, 40 bits) and redemption rate limits stated; the once-online bootstrap named with 72-hour pre-staging as the mitigation and the residual escalated as **Q-SEC-6**. §2.2, §2.7 |
| M18 | `role_assignment` duplicates `staff_assignment`; `NULL = all locations` is fail-open | **Accepted.** Ruling made: `role_assignment` is the single assignment table with `scope_node_id NOT NULL`; `staff_assignment` keeps employment placement and loses `role_id`. Listed as a contract on §4.11 in §2.10 Concern 3. §2.5 |
| M19 | §2.8's controls do not exist; `app_migrate` untouched | **Accepted.** `app_ro` added and used by read grants; two distinct approvers with `CHECK`s that also exclude the operator; `app_migrate` custody model, break-glass path, seal coverage and separately-scoped job credentials stated. Who the two approvers actually are becomes **Q-SEC-7**. §2.3, §2.8 |
| M20 | `sync_quarantine` is a fourth name; the implied response code is retryable | **Accepted.** Renamed to `app.conflict_review` with `conflict_class = 'UNAUTHORIZED_WRITE'` (and `'REVOKED_DEVICE_WRITE'` for the drain path); response is `200 routed_to_review` per §3.3.4, explicitly not `403` and not `422`, with the reason for each. The unstated consequence added: a sale held in review has left the shelf, so its `stock_movement` is absent from the subledger and the divergence is carried as an attributed marker on the daily reconciliation. §2.4 |

**Minor**

| # | Finding | Disposition |
|---|---|---|
| m1 | `currency` inside a role bound; `money_scale` embedded in prose | **Accepted.** `currency` dropped from bounds (`ADR-0007`: one currency per tenant). Money figures are given as minor-unit strings and rendered at `tenant.money_scale`; no cedi conversions in prose. §2.4 |
| m2 | Lease-key pinning versus quarterly rotation | **Accepted.** Lease key is separate from the JWT key, rotates annually with a two-key overlap, pins refresh on every sync, and an unrecognised `kid` neither extends the lease nor seals the device — it continues on the last verified horizon with a visible state. §2.7 |
| m3 | `did` and `sid` are the same UUID in the example | **Accepted.** Distinct values, with the rule stated: `sid` is per user per device, because a shared tablet needs person-granular sessions. §2.2 |
| m4 | The 6-digit PIN argument is wrong against the stated adversary | **Accepted.** Argon2id parameters (64 MiB, t=3, p=1) and the resulting guess rate stated; the claim downgraded to "a delay, not a barrier", sized to the lease horizon rather than to the value of the data. §2.7 |
| m5 | Fail-closed reads return zero rows, which is silently wrong for money | **Accepted.** `withTenant()` asserts the GUC is set and UUID-parseable before running work; RLS remains the backstop and `missing_ok=true` stays at the policy layer. §2.3 |
| m6 | `audit_event` has no index beyond the PK | **Accepted.** Four indexes added, covering subject, actor, time and denials; the sealer uses the existing `(tenant_id, id)` PK. §2.6 |
| m7 | `TRUNCATE` and `PUBLIC`; policies have no `TO` clause | **Accepted.** `REVOKE ALL FROM PUBLIC`, explicit grants, `TO` clauses on both policies, and a note that RLS never applies to `TRUNCATE`. §2.6 |
| m8 | `device.home_location_id uuid NOT NULL` has no story for moves or GROUP/TRANSIT nodes | **Accepted.** Column removed; `app.device_location_scope` replaces it, moving a tablet is an audited act gated on `admin.device.scope.manage`, and a browser session has an empty scope. §2.5, §2.7 |
| m9 | Late-arrival handling diverges from §5 | **Accepted.** §5's wording adopted verbatim: earliest open period, retain `document_date`, `is_late_arrival = true`, late-arrivals report, no review step. §2.6 |
| m10 | Naming drift throughout | **Accepted.** `sku`→`product`, `stock_adjustment`→`stock_movement`, `location_node`→`location`, `location_scoped`→`location_ops`, `sync_quarantine`→`conflict_review`, `price_list`→`price_list_item`, `customer_credit_limit_change`→`credit_limit_version`, `credit_account` for the limit. §2.7's encryption set corrected to match §3.2.2's "No balances, no limits, no ageing" — a till holds `credit_allowance` figures, not the credit book. Throughout |
| m11 | `is_sensitive` / `offline_mode` flags stated in two places that disagree | **Accepted.** `platform.permission` is the single machine-readable source; the template table lists which roles hold which keys and no longer restates flags. §2.4 |

### 2.11.4 Nothing rejected, one remedy substituted

Every finding was materially correct. The only place this revision does not do what the review asked
is **M10's seal remedy**: the review asked for `UNIQUE (tenant_id, seq)` and a covering index, and
this section removes `seq` instead. The reason is in §2.6 — a per-tenant gapless `seq` is either a
serialisation point on a write path whose defining characteristic is a post-sync burst, or it is a
sequence, which reintroduces the commit-order race the finding identifies. An `xid8` horizon over the
existing UUIDv7 primary key fixes all four sub-findings without either cost. Every other sub-finding
in M10 is accepted as written.

### 2.11.5 What survives from the first draft unchanged

Recorded because the review named these as sound and they should not drift in a later edit: the
two-boundary table (§2.1); composite keys and composite foreign keys carrying `tenant_id` through
every reference (§2.3); the `FORCE ROW LEVEL SECURITY` / `app_migrate` versus `app_rw` split and the
`SET LOCAL` analysis under a transaction pooler (§2.3); naming logical replication as outside RLS
(§2.3, §2.10 Concern 1); *"losing the record is worse than recording an unauthorized act"* (§2.4);
minimisation ranked honestly above encryption, and the refusal to wipe on lease expiry (§2.7); the
`ADR-0006` posture in the permission model — no role enum, no platform branch on a role name,
tenant #1's five roles as seed data; and `CLAUDE.md` §2.4's payroll boundary, where
`payroll.register.export` / `.import` exist and no computation does.

**Five items are promoted to `docs/open-questions.md`:** the restated `Q-SEC-2` (offline lease
across a statutory period end — `NEEDS-HUMAN`, accountant), the restated `Q-SEC-3` (default lease
and pre-stage TTL — `OPEN`, pilot), `Q-SEC-5` (shift-change sync cost on a shared tablet — `OPEN`,
pilot), `Q-SEC-6` (once-online bootstrap for new staff — `NEEDS-HUMAN`, founder), and `Q-SEC-7`
(who the two approvers are — `NEEDS-HUMAN`, founder + `devops-engineer`). The previous `Q-SEC-2` —
whether a *clamped business date* is acceptable at period end — is **withdrawn**, because the clamp
it depended on no longer exists.
