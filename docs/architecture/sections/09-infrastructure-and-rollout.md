# 9. Infrastructure, Migrations and Rollout

**Implements:** `ADR-0003` (PWA client, managed Postgres in an EU region) · `ADR-0005` (shared
schema, one migration for every tenant) · `CLAUDE.md` §3 (Phase 0 must contain a rollout plan with
success criteria and a rollback plan) · §2.2 (no write is ever lost)

Three facts drive everything in this section, and none of them are true of an ordinary web app.

1. **The database is roughly 5,000 km from the counter**, and no cloud region is closer.
2. **Every device holds a writable replica** with unsynced business records in it. A release is not
   a container swap; it is a change to a distributed system where most of the nodes are tablets in
   district towns that we cannot reach.
3. **One schema serves every tenant** (`ADR-0005`). A bad migration is not a customer incident, it
   is a platform incident.

The consequence that runs through the whole section: **the thing that can actually destroy value
here is a migration or a release that strands a device holding writes.** Downtime does not — an
outlet trades through downtime by design. That inversion is why this section spends more space on
migrations than on hosting.

This section does not define the sync protocol, bucket shapes, token contents or role model.
`sync-architect` and `rbac-security-engineer` own those; §9.10 names the seams. Where I need a
column on someone else's table, I say so rather than declaring it.

---

## 9.1 Hosting, and the West Africa latency trade-off stated plainly

**Decision: managed Postgres and the sync service in `eu-west-1` (Ireland), one cluster,
`eu-west-1-shared`** — the `platform.db_cluster` row from §1.4. Confirming `ADR-0003`, which was
recorded as provisional pending this document.

### The trade-off, not buried

No major cloud provider operates a West Africa region. There is no `af-west-1`. The realistic set
for a managed Postgres with point-in-time recovery, logical replication and an SLA is Europe, or
South Africa.

| Route from Techiman | Approximate RTT | Note |
|---|---|---|
| Accra → `eu-west-1` (Dublin) / `eu-central-1` (Frankfurt) | **90–130 ms** | The figure in `ADR-0003`. Fixed-line, from Accra. |
| Techiman → Accra domestic backhaul | **+20–40 ms** | Techiman is ~400 km inland; traffic transits Accra either way. |
| Mobile radio access (4G / HSPA) | **+30–60 ms / +80–200 ms** | The dominant and most variable term. Several outlets will be on HSPA. |
| **Realistic outlet-to-server RTT** | **150–300 ms**, with long tails | This is the number to design against, not 90 ms. |
| Accra → `af-south-1` (Cape Town) | **often worse than Europe** | Intra-African routing historically transits Europe. Must be measured before being believed. |

That last row is the one people get wrong. Going *south* is not obviously going *closer*: the
submarine cables landing at Accra — SAT-3/WASC, MainOne, WACS, ACE, 2Africa — are predominantly
Europe-oriented, and African peering has historically been thin enough that Accra→Johannesburg
frequently routes via London. Choosing a South African region on a map is not the same as choosing
it on a traceroute.

### Where 200 ms actually lands, and where it does not

**It does not land at the counter.** This is the payoff of offline-first, and it is worth being
precise about rather than hand-waving. A sale at the till is: read price from local SQLite, write
sale rows to local SQLite, commit locally, print. Zero network operations on the critical path.
A cashier in Techiman and a cashier in Dublin see identical POS latency, because neither one
touches the server to complete a sale.

**It lands in three places:**

1. **Sync convergence** — how long after reconnection a write is durable server-side and visible to
   HQ. `CLAUDE.md` §3 acceptance criterion 1 sets this at 60 seconds.
2. **HQ reporting freshness** — the delay between a sale at a micro-outlet and it appearing in the
   consolidated view.
3. **Genuinely interactive server operations** — sign-in, token refresh, the admin console,
   report generation, tenant provisioning. These are HQ-side and infrequent; 200 ms on a page load
   is not a business problem.

### The 60-second budget, and the rule it produces

Against a 200 ms RTT, a reconnecting device spends roughly:

```
DNS + TCP + TLS 1.3 handshake      ~4 RTT   ≈ 0.8 s
token validation / handshake        ~1 RTT   ≈ 0.2 s
upload of pending writes            ? RTT    ← the whole question
WAL → sync service → bucket recompute        ≈ 1–5 s (server-side, RTT-independent)
push to subscribed devices          ~1 RTT   ≈ 0.2 s
```

Fixed costs are ~2 seconds of a 60-second budget. Latency is not the risk. **Round-trip *count* is
the risk.** An outlet returning after a day offline may hold 200–400 pending writes. At one
round trip per write, 300 writes × 200 ms = **60 seconds of pure network wait**, and the
acceptance criterion fails on a system that is otherwise working perfectly.

> **Rule 9.1-A.** Upload cost must be `O(batches)`, not `O(writes)`. A sync batch carries at
> minimum 100 writes, requests are pipelined rather than serialised, and no sync operation may
> require more than 3 sequential round trips per batch. This is a hard requirement on
> `sync-architect`'s protocol choice and a Phase 1 measurement, not an aspiration.

The corollary is that EU hosting is fine *provided the protocol is not chatty*. A chatty protocol
would fail in Ghana and pass in every developer's local test, which is exactly the class of defect
that reaches production.

### What the managed Postgres must actually provide

These are vendor filters, not preferences. Several popular serverless Postgres products fail one
or more of them, and discovering that after choosing is expensive.

- **Logical replication with user-managed replication slots** (`wal_level = logical`). The sync
  service is a CDC consumer. A provider that restricts logical replication or caps slots is
  disqualified outright.
- **Point-in-time recovery** with continuous WAL archiving and a stated, contractual retention
  window (§9.5).
- **A non-superuser application role that cannot be granted `bypassrls`** — §1.3 Layer 2 depends
  on it. Some providers hand you a role with more privilege than you want and no way to reduce it.
- **Transaction-mode connection pooling.** §1.3 deliberately uses `SET LOCAL` rather than `SET`
  precisely so that transaction pooling remains available; a provider whose pooler breaks
  `SET LOCAL` semantics would force session pooling and multiply connection cost.
- **`pg_stat_statements`, `auto_explain`, and log export** — §9.4 depends on all three.
- **A written RTO for zone failure and provider-side failover.** Ask for the number. Do not assume
  "managed" means "highly available"; on several products it means "we restore from backup".

The sync service runs in the same region as the database, in a container platform with rolling
deploys, health checks, and — critically — the ability to **pin and roll back the sync service
version independently of the API**, because rolling back the sync service is more disruptive than
rolling back the API and the two must not be coupled (§9.8).

### What would change this decision

Named triggers, so this gets re-evaluated on evidence rather than on someone's instinct:

1. **A major provider opens a West or Central Africa region** offering managed Postgres with
   logical replication and PITR. Lagos and Accra have colocation and edge presence; neither has a
   managed Postgres control plane today. Re-check at every phase gate.
2. **Measured Accra→`af-south-1` latency beats Accra→`eu-west-1`** on real outlet connections over
   a two-week sample. This is cheap to measure and should be measured once during Phase 1 rather
   than argued about. If South Africa wins by more than 40 ms, revisit.
3. **A data-residency requirement lands**, whether from Ghana's Data Protection Act 2012 (Act 843)
   or from a prospective tenant's own procurement rules. This is a legal question, not an
   engineering one — see C6.
4. **HQ reporting freshness complaints that trace to RTT rather than outlet connectivity.** I
   expect this never to happen; outlet connectivity will dominate by an order of magnitude. If it
   does happen, the fix is a read replica near the users, not a region move.

The re-evaluation is cheap because §1.4 already made region a per-tenant row. A second region is a
`platform.db_cluster` insert plus the migration path §1.4 describes — a scheduled move, not a
re-architecture. What it is *not* is free: §1.4 is honest that a move means a write freeze and a
full device resync over metered data.

---

## 9.2 Environments

Five, and each exists for a reason that the others cannot serve.

| Environment | Data | Purpose |
|---|---|---|
| `local` | Synthetic, tiny | Docker Compose: Postgres + sync service + API. Every developer runs the real sync service, not a stub. |
| `ci` | Ephemeral, seeded per run | Migration-from-zero, the §1.3 catalogue assertion, the two-tenant isolation fixture, sync-rule tests. |
| `staging` | **Synthetic at FY10 volume** | Same region, same provider, same migration tooling, smaller instance. Holds the permanent fixture tenants and the stale-client device fleet. |
| `production` | Real | `eu-west-1-shared`. |
| `scratch` | A restored production snapshot | Created and destroyed by the restore drill (§9.5) and by migration rehearsal (§9.3.5). Never long-lived. |

Three rules about them:

**No production data in staging. Ever, including "anonymised".** A shared-schema multi-tenant
database anonymised badly is a cross-tenant leak with extra steps, and `ADR-0005` is explicit that
the leak is unrecoverable. Instead, staging gets a **synthetic volume generator** sized to the FY10
network from `financial-model-targets.md`: 25 locations, 219 SKUs, and transaction volume derived
from steady-state revenue.

That sizing exercise produces a number worth stating out loud, because it should calm everyone
down: FY10 steady-state network revenue is roughly **GH₵42.2 m** (1 flagship at 6.6 m, 6 RDCs at
3.3 m, 18 micro-outlets at 0.88 m). At a blended basket in the low hundreds of cedis, that is on
the order of **100,000–200,000 sale headers a year**, perhaps 400,000–700,000 sale lines. Over ten
years the largest table holds single-digit millions of rows.

**This is not a scale problem.** Nothing in this section should be justified by throughput. The
hard parts are correctness, connectivity and recoverability. Two consequences follow: we do not
buy infrastructure for scale we will not have, and we *do* still size migrations for lock duration
against a few million rows, because a five-second `ACCESS EXCLUSIVE` lock on a small table is still
a five-second stall for every tenant (§9.3.2).

**Staging holds a deliberately stale device fleet.** A set of pinned old client builds — the
oldest supported contract version, plus the two before it — running against staging continuously
with pending writes. This is the only way to test "an outlet comes back after a week on an old
build" before it happens for real. It is also the fixture the contraction gate (§9.3.4) is
validated against.

### Provisioning tenant #2, operationally

§1.8 defines provisioning as a durable run of declarative steps. The operational half — what a
person actually does, in order:

1. **Capacity check.** Is `platform.db_cluster.accepts_new_tenants` true for the target cluster,
   and does the cluster have replication-slot and connection headroom for another tenant's sync
   buckets? A new tenant adds CDC fan-out, not just rows.
2. **Create the tenant and select a template** through the admin console, which starts a
   `platform.provisioning_run` (§1.8). Choose jurisdiction — irrevocable (§1.1).
3. **Register monitoring before activation.** A tenant must appear in the §9.4 rollups the moment
   its first location exists. A tenant that is live but invisible to monitoring is worse than one
   that is not live at all, and "we forgot to add them to the dashboard" is how an outlet goes dark
   for a week unnoticed.
4. **Satisfy the gates.** `platform.tenant_gate` rows for the accountant's chart-of-accounts review
   and the jurisdiction confirmation (`CLAUDE.md` §2.8). `activate` refuses while any is open.
5. **Enrol devices** (§9.9), one enrolment code per device, scoped to tenant + location + role.
6. **Set the location sync expectation** (§9.4) per location — trading hours and expected sync
   cadence. Without this, the liveness monitor has nothing to compare against.
7. **Assign the release ring** (§9.7). A new tenant joins on the current *stable* ring, never on a
   canary.

> **Rule 9.2-A.** Provisioning a tenant requires **no deploy and no migration.** If onboarding a
> customer needs a schema change or a code branch, the configuration model in §1.5 has failed and
> that is the bug to fix — not the onboarding runbook. This is the operational restatement of
> `CLAUDE.md` §2.9.

---

## 9.3 Migrations

This is the section that matters. Everything else here is recoverable.

### 9.3.1 What a migration is racing against

At any instant there are three populations, and they are not synchronised:

- **The server schema**, at one version.
- **Client builds in the field**, at several versions — a micro-outlet's tablet may be weeks behind.
- **Pending local writes**, sitting in SQLite on those devices, written against the schema the
  client build knew about.

The failure that matters: an outlet reconnects after three days, running an old build, holding 180
sales. The server has moved on incompatibly. Those sales are lost, and `CLAUDE.md` §2.2 says that
must never happen. Not "should rarely" — never.

The mechanism that makes this tractable is an explicit, negotiated **schema contract version**.

```sql
create table platform.schema_contract (
  version      int primary key,            -- monotonic; bumped only by contract-visible changes
  applied_at   timestamptz not null,
  phase        text not null,              -- 'expand' | 'backfilling' | 'backfilled' | 'contracted'
  description  text not null,
  migration_id text not null references platform.schema_migration (id)
);

create table platform.client_release (
  version       text primary key,          -- '1.14.3'
  min_contract  int  not null,             -- oldest server contract this build can talk to
  max_contract  int  not null,             -- newest
  released_at   timestamptz not null,
  status        text not null              -- 'canary'|'stable'|'supported'|'deprecated'|'blocked'
);
```

The server declares the contract range it serves. Every client declares the range it understands.
A device outside the range gets a **distinguishable, named error** that the client surfaces as
"this device needs an update before it can sync — your sales are safe on this device", and its
writes go to quarantine (§9.3.4) rather than being rejected into the void.

> **Rule 9.3-A — the support floor.** The server must serve every contract version claimed by any
> non-`blocked` client release with a device seen in the last **180 days**. No contraction may
> reduce the served range below that floor. This is what guarantees an outlet that has been offline
> for an unreasonably long time still has a path home.

### 9.3.2 Expand–migrate–contract, concretely

The abstract version is well known and useless under pressure. Here is a real change, with the
hazards named at each step.

**The change:** customer credit today is a scalar `app.customer.credit_limit_minor bigint`. Per
`ADR-0006` it must become per-account terms — limit, terms days, facility fee rate, effective
dates — in `app.credit_terms`. This is the change most likely to be needed early, and it touches
the canonical offline conflict case from `CLAUDE.md` §2.2.

---

**Step 1 — Expand. Server release R1. Additive only. No client change ships in this release.**

```sql
-- migration 0142_expand_credit_terms.sql   (transactional)
create table app.credit_terms (            -- emitted by the §1.3 registry, not hand-written
  tenant_id      uuid   not null references platform.tenant (id),
  id             uuid   not null,
  customer_id    uuid   not null,
  limit_minor    bigint not null,          -- ADR-0004
  terms_days     int    not null,
  fee_bp         int    not null,          -- basis points, ADR-0004
  effective_from date   not null,
  primary key (tenant_id, id),
  constraint credit_terms_customer_fk foreign key (tenant_id, customer_id)
    references app.customer (tenant_id, id) deferrable initially immediate
);
-- old column untouched. nothing dropped. nothing renamed.
```

Hazards at this step:

- **`app.customer.credit_limit_minor` is not touched.** Not renamed, not deprecated in the DDL, not
  commented out. Old clients still read and write it.
- **Dual-write in both directions, for the whole window.** New code writes both shapes. Writes
  arriving from *old* clients only set the old column, so a trigger projects old → new. New clients
  set the new shape, so a trigger projects new → old for the benefit of old readers. Both triggers
  exist simultaneously and both are deleted at contraction. Getting only one direction is the
  common and silent error.
- **Adding `app.credit_terms` to the sync rules creates a new bucket, and every device downloads
  it.** That is bytes on metered data (§9.6). Expand steps are not free at the edge, and the byte
  estimate goes in the migration's PR description.
- **`R1` ships no client change that depends on any of this.** See Rule 9.3-B.

**Step 2 — Backfill. Separate, batched, resumable, per-tenant.**

Never one statement over the whole table. One statement takes a long transaction, bloats WAL, and
hits every tenant at once — the exact shared-schema blast radius `ADR-0005` warns about.

```sql
-- run per tenant, in a loop, with a cursor, throttled
insert into app.credit_terms (tenant_id, id, customer_id, limit_minor, terms_days, fee_bp, effective_from)
select c.tenant_id, gen_uuid_v7(), c.id, c.credit_limit_minor,
       t.default_terms_days, t.default_fee_bp, current_date
from   app.customer c
join   app.tenant_credit_policy t on t.tenant_id = c.tenant_id
where  c.tenant_id = :tenant
  and  c.id > :cursor
  and  not exists (select 1 from app.credit_terms x
                   where x.tenant_id = c.tenant_id and x.customer_id = c.id)
order by c.id
limit  1000;
```

Progress lives in `platform.backfill_progress (migration_id, tenant_id, cursor, state, updated_at)`
so it is resumable after a crash and pausable per tenant. **Backfills are the one part of a
migration that can be canaried** — run tenant #1, verify, then the rest. Use that.

**Step 3 — Client release R2** reads the new shape and tolerates the old. Rolled out through the
rings in §9.7, over days. The server is already tolerant, so ring order does not matter for
correctness — which is the entire point of shipping the server first.

**Step 4 — Wait for catch-up.** §9.3.4. This is where the schedule stops being under our control.

**Step 5 — Contract, in two moves, not one.**

- *5a.* Deploy server code that no longer writes `credit_limit_minor`, and drop the new → old
  trigger. Then **prove nothing reads it** — a `deprecated_column_read` counter incremented by the
  ORM layer, plus a `pg_stat_statements` sweep for the column name, observed at zero for 14 days.
- *5b.* Only then, `alter table app.customer drop column credit_limit_minor;` and drop the
  remaining trigger. Bump `platform.schema_contract`, set `phase = 'contracted'`.

Between 5a and 5b there is a window where the change is fully reversible by redeploying. After 5b
it is reversible only by restore. That asymmetry is why they are two releases.

---

### The always-true DDL rules

Postgres specifics that decide whether a migration is a non-event or an outage. A shared schema
means each of these hits every tenant simultaneously.

- **`lock_timeout = '3s'` and `statement_timeout` are set on every migration session**, with
  automatic retry and backoff. This is the single highest-value rule here. An `ALTER TABLE` waiting
  for `ACCESS EXCLUSIVE` **queues behind a long-running read and blocks every subsequent query on
  that table**, including plain `SELECT`s. A monthly report running at HQ can therefore convert a
  one-millisecond `ALTER` into a platform-wide stall. Failing fast and retrying is correct; waiting
  politely is not.
- **`ADD COLUMN` nullable, backfill, then `NOT NULL` via a validated constraint.** Add a
  `CHECK (col IS NOT NULL) NOT VALID`, `VALIDATE CONSTRAINT` (which takes only `SHARE UPDATE
  EXCLUSIVE`), then `SET NOT NULL` — which Postgres can then prove cheaply. Never `SET NOT NULL`
  directly on a populated table.
- **`CREATE INDEX CONCURRENTLY`, always.** It cannot run inside a transaction, so the migration
  runner needs a `-- non-transactional` annotation, and it can fail leaving an `invalid` index —
  the runner must detect `pg_index.indisvalid = false`, drop, and retry.
- **No `DROP COLUMN` in the same release as an `ADD COLUMN`.** Different phases, different
  releases.
- **Nothing is ever renamed.** A rename is add + backfill + drop, spread across the phases above.
  A rename is a contraction disguised as a cosmetic change, and it is the most common way this
  discipline gets accidentally broken.
- **No Postgres `enum` types on any table in `app`.** Enums cannot drop values, `ADD VALUE` has
  transaction-block restrictions, and a client that receives an enum value it does not know about
  is a stranded client. `app` uses `text` plus a `CHECK` constraint, which can be widened with
  `NOT VALID` + `VALIDATE` and narrowed at contraction. Enums remain fine in `platform` — nothing
  replicates from there (§1.1 already uses one for `tenant_state`, correctly).
- **Every migration ships with its contraction plan written at the same time.** The PR template
  requires: what is added, what will later be dropped, what proves the drop is safe, and the byte
  cost of any sync-rule change. A migration whose author cannot describe the contraction is a
  migration whose contraction never happens, and the schema accumulates dead columns that every
  future reader must reason about.
- **Any migration touching `platform` gets a named human reviewer**, per §1.3 — that is the schema
  where a mistake does not fail CI.

### 9.3.3 The two rules that are never bent

> **Rule 9.3-B.** A schema change and a client change that depends on it **never ship in the same
> release.** The tolerant server ships first, alone, and is proven in production before the client
> that needs it is built. There is no "but it's only additive" exception, because the exception is
> how the rule dies.

> **Rule 9.3-C.** A contraction never ships until catch-up is **positively proven** (§9.3.4).
> Not "we think everyone updated". Not "it has been a month". Proven, by a query, with a recorded
> result attached to the migration.

### 9.3.4 How you know every device has caught up

This is the question the whole discipline hangs on, and "check the dashboard" is not an answer.

The device registry belongs to `rbac-security-engineer` (§1.9). These are the columns **operations
requires on it**, and their absence would make Rule 9.3-C unenforceable:

```sql
-- platform.device — owned by rbac-security-engineer; operational columns specified here
  client_version          text references platform.client_release (version),
  contract_version        int,          -- highest server contract this build supports
  last_seen_at            timestamptz,  -- last authenticated sync connection
  last_upload_at          timestamptz,  -- last accepted write batch
  pending_writes_estimate int,          -- client-reported at every handshake
  bytes_up_28d            bigint,       -- §9.6
  bytes_down_28d          bigint,
  retired_at              timestamptz,  -- an operator asserted this device is out of service
  retired_pending_writes  int           -- what we knowingly wrote off when retiring it
```

**The gate is a positive signal, not an absence of one.** The naive query — "no device has been
seen recently on an old build" — is wrong, because a device that has been off for 90 days is
indistinguishable from a device in a drawer that comes back next Tuesday. Silence is not consent.

```sql
-- Devices that would be stranded by contracting to required version :V.
-- Contraction is permitted only when this returns zero rows.
select d.tenant_id, d.location_id, d.id, d.client_version,
       d.contract_version, d.last_seen_at, d.pending_writes_estimate
from   platform.device d
where  d.revoked_at is null
  and  d.retired_at is null
  and  (d.contract_version is null or d.contract_version < :V);
```

Every enrolled, non-revoked device must have **checked in on the new contract**. A device that has
not must be explicitly **retired** by a human — an operator at the tenant asserting "that tablet is
gone". Retirement is not a cleanup task; it is a business decision with money attached, so the
console shows `pending_writes_estimate` at the moment of retirement and requires the operator to
acknowledge the figure. Retiring a tablet with 40 unsynced sales is writing off 40 sales, and it
should feel like it.

**And then assume we got it wrong anyway.** A write arriving from a device below the minimum served
contract is **never dropped**:

```sql
create table platform.stranded_write (
  id           uuid primary key,
  tenant_id    uuid not null references platform.tenant (id),
  device_id    uuid not null,
  received_at  timestamptz not null default now(),
  client_version   text,
  contract_version int,
  reason       text not null,        -- 'below_min_contract' | 'unknown_table' | 'unknown_column'
  payload      jsonb not null,       -- the raw write, exactly as sent
  resolution   text,                 -- 'replayed' | 'discarded' | 'pending'
  resolved_by  text, resolved_at timestamptz
);
```

Quarantined writes raise a human review queue item with a distinguishable reason. `CLAUDE.md` §2.2
says a sale must never be silently lost; a stranded device is the most likely way to lose one, so
this table is the direct implementation of that promise, not a nicety. It also gives the operator
something better than an apology: the payload is there, and it can be replayed by hand.

**A useful side effect:** the size of `platform.stranded_write` is the honest scoreboard for whether
this discipline is being followed. It should be empty. A non-empty quarantine is a process failure
that has already been caught, which is the best kind.

### 9.3.5 One schema, every tenant

`ADR-0005` bought cheap operations and one migration run. The bill arrives here: **there is no
blast-radius containment.** A migration that locks a table locks it for every tenant. A migration
that corrupts data corrupts it for every tenant. There is no "roll out to 5% of customers".

Four mitigations, one of which is a genuine limitation to be stated rather than solved.

1. **You cannot canary a shared-schema DDL change. Accept it and move the risk.** The DDL itself
   must be *provably* safe — additive, lock-bounded, reversible by a drop. Everything risky must
   live in the **application layer**, which *is* canaryable through the release rings (§9.7). This
   is a second, independent argument for expand–migrate–contract, arrived at from operations rather
   than from compatibility: the shape of the change is dictated by what can be canaried.
2. **Backfills are per-tenant and paced** (§9.3.2), so the data-transformation half — where logic
   bugs actually live — *is* canaryable. Tenant #1 first, verified, then the rest.
3. **Every migration is rehearsed against a restored production clone** before it touches
   production. Deliberately, this is the *same* `scratch` environment the restore drill creates
   (§9.5). Two controls sharing one setup means neither one gets quietly dropped from the schedule.
   Rehearsal records the wall-clock duration of every DDL statement, and any statement exceeding
   one second on production-shaped data goes back for redesign.
4. **Contractions get a fresh verified backup taken immediately before**, and a maintenance window.

**On maintenance windows — a payoff worth naming.** Because every location trades fully offline,
we have something most systems do not: **a real maintenance window that costs nothing at the
counter.** Sync pauses; sales continue; the queue drains afterwards. Ghana is UTC+0 and outlets
close around 18:00–19:00 local, so a 21:00 GMT window is 22:00 CET — late but not nocturnal for a
European-based operator, and completely invisible to the business. All the complexity of
offline-first buys this, and it should be spent deliberately: **contractions are scheduled inside
that window, announced, and never run when the person who wrote the migration is unavailable.**

### 9.3.6 Tooling, and the tension with codegen

Forward-only, checksummed, plain SQL files in `migrations/`, applied by a runner that takes a
Postgres advisory lock (so two concurrent deploys cannot race), records into
`platform.schema_migration (id, checksum, applied_at, applied_by, duration_ms)`, and runs each file
in one transaction unless annotated `-- non-transactional`.

There is a real tension with §1.3, which generates DDL from a TypeScript registry. Codegen produces
the **desired state**; migrations are the **path**. Resolving it by hand-waving produces drift, so:

- Codegen emits a *proposed* migration as a diff against the current schema.
- A human edits that proposal into an expand or contract step — codegen cannot know which phase a
  change belongs to, because that is a compatibility judgement.
- **CI asserts that applying every migration from zero produces exactly the schema the registry
  declares** — column for column, index for index, constraint for constraint. Then it runs the §1.3
  catalogue assertion against the result.

That last check is what keeps the two representations honest, and it fails loudly the first time
someone hand-writes a migration that the registry does not know about.

---

## 9.4 Monitoring: the signals that actually matter

The interesting signals here are not CPU and memory. On a system where the counter never touches
the server, a p99 API latency of 300 ms is invisible to the business and a healthy-looking server
dashboard is exactly what a catastrophe looks like.

### The nightmare scenario, and why it is invisible

**A micro-outlet stops syncing on a Monday and nobody notices until month end.**

Here is why every conventional monitor misses it: **a device that is not connecting generates no
telemetry.** Error rate: zero. Failed requests: zero. Latency: fine. CPU: flat. Every graph is
green, because the outlet has stopped producing data of any kind — including error data. The
absence of signal *is* the signal, and absence does not trigger threshold alerts.

Meanwhile, at that outlet: sales accumulate locally; the stock position at HQ is a week stale, so
reorder points fire on fiction; and — the expensive one — **credit limits are stale in both
directions.** A contractor who hit their limit at the dark outlet can walk into a connected one and
buy on credit, because the connected outlet's device never learned about the first purchase. A week
of that is real, uncollectable exposure, and it is discovered by the accounts team wondering why
the ageing report looks wrong.

And the merge gets worse the longer it runs. A week of divergence is a week of conflicts arriving
in one burst.

**Therefore the monitor is a liveness expectation, not an error rate.** A scheduled evaluator
compares observed sync behaviour against a declared expectation per location, so that *silence*
raises an alert:

```sql
create table platform.location_sync_expectation (
  tenant_id        uuid not null references platform.tenant (id),
  location_id      uuid not null,
  trading_days     int[] not null,        -- ISO weekday numbers; a closed Sunday is not an outage
  trading_open     time not null,
  trading_close    time not null,
  timezone         text not null,         -- 'Africa/Accra'
  expected_gap_p90 interval,              -- learned: rolling 28-day p90 of inter-sync gap
  alert_after      interval not null,     -- greatest(expected_gap_p90 * 3, '4 hours')
  ops_contact_msisdn text,                -- the tenant's own operations contact
  primary key (tenant_id, location_id)
);
```

Thresholds are **per-location and learned, not global**. A micro-outlet that syncs twice a day is
healthy; the Techiman flagship going two hours without a sync at 11:00 on a Tuesday is not. A
single platform-wide threshold would either page constantly for the micro-outlets or never fire for
the flagship.

**And the alert must route to the tenant, not only to us.** This is the operational insight that
changes the design: **most sync-lag alerts are not resolvable by the platform team.** The cause is
almost always physical — a data bundle ran out, a router is off, the tablet is in a drawer, the
staff member who knows the PIN is on leave. No amount of platform on-call fixes an expired data
bundle in Wenchi. So the alert goes to two places: the platform on-call *and* the tenant's named
operations contact, by SMS, because SMS is what reliably arrives in Ghana. Plus a persistent tile
on the HQ dashboard showing every location and time-since-last-sync, sorted worst-first, which is
the screen the head of operations should have open.

### The signal table

| Signal | Source | Threshold | Pages? |
|---|---|---|---|
| **Replication slot lag / WAL disk** | Postgres `pg_replication_slots`, disk metric | Lag > 2 GB or disk > 70% | **Yes, hardest.** If the sync service stops consuming the slot, WAL accumulates until the primary fills its disk and *the entire platform stops*. This is the classic managed-Postgres-plus-CDC outage and it kills everyone at once. |
| **Sync service down / uploads failing platform-wide** | Health check + upload success rate | Any 5-minute window with < 90% upload success across ≥ 3 tenants | **Yes.** |
| **Database unavailable** | Connection probe from outside the VPC | 2 consecutive failures | **Yes.** |
| **Sync lag per location** | `platform.location_sync_expectation` evaluator | `alert_after` exceeded during that location's trading hours | **During trading hours only**, to tenant ops + platform on-call. Not at 03:00 — the outlet is closed and waking someone teaches them to ignore the pager. |
| **Human review queue** | Queue table | **Oldest item age > 1 business day** (primary), depth > 25 (secondary) | Business hours. Age matters more than depth: 40 items from this morning is a busy day, one item from nine days ago is a divergence nobody is looking at. |
| **Failed sync attempts by reason** | Sync service, categorised: `auth_expired`, `device_revoked`, `below_min_contract`, `conflict_rejected`, `payload_too_large`, `network_timeout` | Rate-of-change per reason per tenant | `below_min_contract` > 0 pages — it means Rule 9.3-A was violated and writes are quarantining. Others are dashboards + business-hours tickets. |
| **Client version spread** | `platform.device.client_version` | No threshold — it is a gauge | No. But it is the input to the contraction gate (§9.3.4) and to ring progression (§9.7), so it must be accurate, not merely present. |
| **Per-tenant query cost** | `pg_stat_statements` + tagged statements | One tenant > 40% of total DB time over 15 min | Business hours. Noisy neighbours (`ADR-0005`). |
| **Bytes per outlet per day** | `platform.device.bytes_up/down_28d` | Above the §9.6 budget | No, but it is visible to the tenant, because they pay for it. |
| **PITR restore point age, backup job success, drill recency** | Backup service | Restore point > 15 min old; drill > 100 days old | Yes for restore point. A stale drill is a control failure, raised as a blocking ticket (§9.5). |

**Per-tenant attribution needs a mechanism, and the obvious one does not work.**
`pg_stat_statements` aggregates by query fingerprint and has no tenant dimension —
`SET LOCAL app.tenant_id` is invisible to it. Two options considered:

- *Rejected:* one Postgres role per tenant, so `pg_stat_statements.userid` gives attribution free.
  It works, but it multiplies roles by tenants, complicates the RLS policy set and fragments the
  connection pool. Not worth it at low tenant counts, and it is `rbac-security-engineer`'s
  boundary anyway.
- *Chosen:* a SQLCommenter-style trailing comment — `/* tenant=<uuid>,op=<name> */` — injected by
  `withTenant` on every statement, combined with `log_min_duration_statement` log export and
  aggregation. Costs log volume, gives exact attribution including the slow one-off report that
  fingerprint aggregation would bury.

### What we deliberately do not alert on

CPU, memory, request-latency percentiles, and pod restarts. They are dashboards for debugging, not
pages. On this system they do not correlate with business harm, and every non-actionable page
spends credibility that the three real pages above will need.

---

## 9.5 Backup, restore, and drills that are actually run

### Backup and archive are different things

Conflating them is common and expensive, so they are separated by name:

- **Backup** — operational recovery. Continuous WAL archiving with point-in-time recovery.
  **RPO ≤ 5 minutes. Retention 7 days at launch, 30 days from Phase 3** when the GL becomes the
  system of record. `ADR-0003`'s note that this is "not a tier upgrade" is right: PITR is a
  requirement.
- **Archive** — statutory and contractual record-keeping. The §1.7 export artefacts (machine form
  and accountant form) written monthly to immutable object storage with a long retention, per the
  jurisdiction pack's retention rule. Ghanaian tax record retention is measured in years; **backups
  must never be the mechanism for that**, because a backup's shape follows the current schema and a
  six-year-old backup of a schema nobody remembers is not a record, it is an archaeology project.

**RTO target: 4 hours** for a full-cluster restore. Measured by the drill, not asserted.

### The device fleet is a partial distributed backup — and only partial

Worth stating because it genuinely improves the picture, and worth bounding because it is easy to
over-claim. Recent writes that *originated on devices* exist in two places: the server and the
device that made them. Server-side loss of the last few minutes is often recoverable by replay.

What it does **not** cover: server-side derived data, HQ-originated edits, ledger postings computed
server-side, and anything a device has since discarded. So it is a mitigation, not a backup.

### What a restore does to devices — the part nobody plans for

Restore the server to T−2h and the server has **forgotten writes that devices believe were
acknowledged**. Those devices have marked them synced and will never send them again. The result is
not a visible error; it is permanent, silent divergence — sales that exist on a tablet, on a printed
receipt, and in the cash drawer, but not in the books.

**Therefore any in-place restore is followed by a forced re-upload window**, as a mandatory step of
the restore runbook:

1. Invalidate every device's sync checkpoint to a point *before* the restore target.
2. Devices replay their local write log from that point.
3. **Idempotency keys deduplicate the replay** (`CLAUDE.md` §2.2). This is precisely what they are
   for. A system without them cannot safely restore.

Which imposes a client requirement: **devices retain their local write log for at least the backup
retention window plus a margin — 35 days — rather than pruning on acknowledgement.** The storage
cost is trivial: at flagship volumes that is on the order of tens of megabytes of compact rows.
`sync-architect` and `frontend-engineer` own the implementation; the requirement is operational and
it must exist before the pilot, not after the first restore.

### Per-tenant recovery on a shared schema

**A single tenant cannot be restored in place.** PITR restores a cluster; rewinding one tenant would
require rewinding all of them. So the "customer deleted a year of stock adjustments" case has this
path, and it is slow and manual:

restore to `scratch` at time T → run the §1.7 export machinery for that tenant alone → selectively
re-import the affected tables under `platform_admin` → verify against the tenant's own trial
balance → destroy `scratch`.

This is a real cost of `ADR-0005` and it should be written down rather than discovered. The
mitigation that makes it tolerable: **a nightly per-tenant logical export to object storage**, using
the same `carry`/`derived` registry as §1.7. Encrypted, tenant-scoped, retained 30 days. It gives
tenant-scoped recovery a source that is not a four-hour cluster restore, and — usefully — it
exercises the export path every single night, so the export that a departing customer eventually
asks for has been running successfully for years rather than being written in a hurry.

### Restore drills

An untested backup is a belief, not a control.

**Quarterly, scheduled, owned by a named person, and the drill is not "did the restore complete".**

```
1. Pick a random timestamp within the retention window. Random, not convenient —
   a drill that always restores to "last midnight" tests one code path.
2. Restore to a fresh `scratch` cluster. Start the stopwatch at the decision, not at
   the first command: the clock the business cares about includes finding the runbook.
3. Run the §1.3 catalogue assertion against the restored schema.
4. Row-count and checksum every registry table per tenant against the values recorded
   at the restore timestamp.
5. THE REAL CHECK: compute tenant #1's trial balance from the restored cluster and
   compare it, to the pesewa, against the same trial balance computed from production
   as at the same timestamp. A restore that completes but produces different books
   has failed.
6. Rehearse the next pending migration against it (§9.3.5).
7. Record the wall-clock RTO in platform.restore_drill. Publish the number.
8. Destroy `scratch`.
```

Step 5 is the one that separates this from theatre. Steps 1–4 prove the bytes came back; only step 5
proves the *books* came back, and the books are the product.

```sql
create table platform.restore_drill (
  id uuid primary key,
  ran_at timestamptz not null,
  operator text not null,
  restore_target timestamptz not null,     -- the PITR timestamp chosen
  rto_seconds int not null,                -- decision → verified, wall clock
  catalogue_assertion_passed boolean not null,
  row_counts_matched boolean not null,
  trial_balance_matched boolean not null,
  notes text
);
```

**If the newest row is more than 100 days old, that is a control failure**, raised as a blocking
ticket against the phase gate — not a to-do that slides. The whole reason to write it down is that
drills are the first thing dropped when a quarter gets busy, and the quarter that gets busy is
exactly the quarter you will need the restore.

---

## 9.6 Connectivity economics

Outlets are on intermittent, often metered mobile data. **Bytes on the wire cost the customer
money**, and unlike server cost, we do not pay it — which makes it precisely the cost most likely to
be ignored. Twenty-five outlets each burning an unnecessary 200 MB a month is a line item on a
customer's bill that they will eventually ask us to justify.

**Budgets, to be validated in Phase 1 — these are targets to measure against, not measurements:**

| | Target |
|---|---|
| First sync after enrolment (catalogue, customers, opening stock) | **≤ 30 MB** |
| Steady state, flagship | **≤ 5 MB / day** |
| Steady state, micro-outlet | **≤ 1 MB / day** |
| Client update (PWA) | **≤ 500 KB** of changed chunks |
| Full re-sync (should be rare and always scheduled) | **≤ 30 MB**, announced in advance |

**The rules that get us there:**

- **Incremental and resumable by construction.** Checkpoint-based resume, so a sync interrupted at
  80% resumes at 80%. A protocol that restarts a transfer on a dropped connection will never
  complete on a bad link — it will burn the bundle trying.
- **Never a full bucket re-download after a long offline period.** A device returning after a week
  fetches the delta.
- **Compression negotiated on the wire.** ERP rows are repetitive text and compress 5–10×. Measure
  the real ratio on real payloads during Phase 1 rather than assuming it.
- **Bucket scoping is a bytes decision as much as a security decision — and they are the same
  boundary.** `CLAUDE.md` §2.6 requires a device to download only what its tenant, role and location
  scope permit. That control, built for isolation, is also the single biggest lever on data cost: a
  micro-outlet with three staff must not receive every location's stock ledger or the tenant's full
  transaction history. When `sync-architect` sizes buckets, the security review and the data-cost
  review are the same review.
- **No binary blobs in sync buckets.** Product photos and scanned documents go to object storage,
  fetched on demand, downscaled, and cached — with **"images over Wi-Fi only" as the default**.
  Without this rule, someone syncs 219 product photos to 25 outlets and nobody notices until the
  bundles run out. It is the single most likely way this budget gets blown.
- **Sync-rule deployments are change-managed events with a published byte estimate.** See C2 — on
  some sync platforms, changing sync rules causes affected buckets to be rebuilt and re-downloaded.
  If that is true of ours, then a routine-looking config change is a metered-data event across the
  whole fleet, and it must be scheduled into the maintenance window with the cost stated beforehand.
- **The PWA is cheaper than an APK, and that is a real reason it won.** Content-hashed chunks mean a
  release ships only what changed — a few hundred KB — where an APK update is a full re-download of
  the whole application, per device, per release, over the customer's mobile data. Across 25 outlets
  and a fortnightly release cadence this is not a rounding error. Worth recording alongside
  `ADR-0003`'s known costs, since that ADR lists the PWA's weaknesses and not this strength.
- **Measured and shown to the tenant.** Devices report bytes up/down at each handshake; the platform
  aggregates per location per month and displays it on the HQ dashboard. If the customer pays for
  it, the customer gets to see it — and we get an early warning when a release regresses.

---

## 9.7 Rollout

### The shape of the problem is not what it looks like

"Staged rollout across 25 locations" implies 25 existing sites to convert. There are none.
Tenant #1's network **grows by opening outlets** — Techiman flagship in FY1; Sunyani RDC and
Techiman Micro-Outlet 1 in FY2; Tamale RDC, Wenchi Micro-Outlet and Kumasi RDC in FY3 — over
ten years. A
location joins the system on the day it opens, and its go-live is one line in an outlet-opening
checklist.

So there are really two staging problems, and conflating them produces a plan that is wrong about
both:

- **The pilot** — one location, once, proving the system works at all. §9.7.1.
- **Release staging across a growing fleet** — continuous, forever, and the thing that actually
  consumes operational attention after month two. §9.7.2.

### 9.7.1 The pilot: Techiman flagship

**Stage 0 — preconditions. Not a single sale until every one is true.**

- [ ] Accountant's review gate satisfied: chart of accounts, double-entry logic, and one full month
      of generated statements checked against manual expectations (`CLAUDE.md` §2.8). Recorded as a
      satisfied `platform.tenant_gate` row, not an email.
- [ ] Jurisdiction pack confirmed by a qualified Ghanaian professional (`ADR-0007`), including VAT
      registration status and the correct levy set (`ADR-0002`).
- [ ] **Receipt printing proven on the exact deployed hardware** — `ADR-0003` flags this as the
      PWA's weakest point and requires it be settled during Phase 1, not at pilot.
- [ ] Restore drill passed within the last 30 days, with the trial-balance comparison green (§9.5).
- [ ] Two-tenant isolation test green at every read path (`CLAUDE.md` §3 acceptance 5).
- [ ] Devices enrolled, local encryption active, revocation tested end-to-end (§9.9).
- [ ] Monitoring live: location sync expectation set, tenant ops contact SMS number confirmed by an
      actual test message.
- [ ] **Paper fallback in place and rehearsed** — pre-numbered receipt books at the counter, a
      written procedure, and one two-hour paper drill completed by the actual staff (§9.8).
- [ ] Staff trained, with the outlet manager able to complete open, cash-up, stock adjustment and
      credit sale unassisted.

The paper fallback is a precondition, not a contingency, and it is what makes rollback safe: if the
outlet cannot trade without the software, we will hesitate to roll back a bad release, and
hesitating is how a bad release gets into the books.

**Stage 1 — pilot, four weeks minimum.**

There is a scheduling collision that must be named. Tenant #1's Techiman flagship **opens on 1
August 2026**, and that is also the ERP's go-live date. A brand-new outlet, brand-new staff and
brand-new software all starting on the same morning means that when something goes wrong, nobody
will be able to tell whether the software is broken or the staff are still learning it — and the
pilot's entire purpose is to answer that question.

**Recommendation: run the ERP in a dry-run window of 2–4 weeks before trading opens** — real
catalogue, real prices, real hardware, staff practising against synthetic customers, sync and
printing exercised daily, no revenue at risk. Then day one of trading is the software's second
week, not its first. If the date is immovable, we accept it explicitly and adjust: the first week's
metrics measure staff learning, and the 14-day success clocks start at the end of it. See C1.

**Stage 1 success criteria — the gate before any second location.**

Objective, measurable, time-bound, and checked by a named human at a scheduled review. Not
inferred from a dashboard, because a dashboard can be green for the wrong reason.

1. **Zero lost writes over 14 consecutive trading days.** Every sale written on a device appears
   exactly once server-side. Measured by daily reconciliation of each device's local write-log
   count against server-accepted count. Zero unexplained discrepancies — not "a few we think we
   understand".
2. **Airplane-mode sale syncs within 60 seconds of reconnection, p95, over ≥ 50 measured
   instances.** `CLAUDE.md` §3 acceptance 1 says 60 seconds; one successful demo is not evidence.
3. **Sync lag p95 < 15 minutes during trading hours**, and no unexplained dark period > 4 hours.
4. **Human review queue: every item resolved within one business day, queue never exceeds 10 open
   items, and no item resolved by guessing.** Each resolution has a recorded reason.
5. **Cash-up reconciles to the pesewa for 14 consecutive days** — ERP till total equals counted
   cash plus recorded credit sales. This is the criterion the business actually trusts, and the one
   that catches money bugs that pass unit tests.
6. **≥ 99% of sales produce a printed receipt on the first attempt** on the deployed hardware.
7. **Data cost per outlet within the §9.6 budget** for the final 7 days.
8. **Zero P1 incidents in the final 7 days**; every P2 has a merged fix or a written, accepted
   workaround.
9. **The outlet manager operates unassisted for 5 consecutive days** — no support contact for
   routine operations.
10. **A restore drill executed against pilot-era data with the trial balance matching.**

**Failing any one criterion means the expansion does not happen. It does not mean rollback.** Those
are different decisions with different triggers, and confusing them causes teams to either expand
onto a broken system or tear down a working one. The clock restarts; the gate stays shut.

### 9.7.2 Release rings, which is the rollout that never ends

Client and server releases move through rings, with soak time between them.

| Ring | Population | Soak before advancing |
|---|---|---|
| **0** | Staging fixture devices + 2 devices at HQ | 24 h |
| **1** | Techiman flagship | **72 trading hours** |
| **2** | RDCs (Sunyani, Tamale, Kumasi, …) | 72 trading hours |
| **3** | Micro-outlets | — |

A ring cannot advance while any device in a lower ring has an unresolved P1 or P2, a rising
`failed_sync` rate, or a quarantined write.

**Ring 1 is the flagship, deliberately, and that is a real trade.** It is the highest-revenue
location — putting the newest build there first puts the most money nearest the risk. We accept it
for two reasons: the founder and the support team are physically standing there, so a problem is
seen in minutes rather than at month end; and the alternative is worse, because a micro-outlet with
three staff and no technical support discovering a bug alone is the scenario with no fast feedback
path at all. This is the trade the `devops-engineer` brief asks for ("the flagship stays a release
ahead so problems surface where the founder is standing") and it is worth stating that it costs
something rather than pretending it is free.

**Micro-outlets go last** for the same reason: furthest from help, thinnest staffing.

**A new tenant is onboarded onto ring 2's stable release**, never a canary. Their pilot is their
own; it does not double as ours.

> **Requirement 9.7-A — PWAs auto-update, and that defeats staged rollout unless we stop it.**
> A service worker's default behaviour is to fetch the newest build. Left alone, every device in
> every ring updates within hours of a deploy and rings become decorative. The client must
> therefore ask a server-controlled `/release` endpoint **which build it should be running** — keyed
> by device id → ring → pinned version — and cache that build's content-hashed assets rather than
> whatever is newest. It also needs a **force-update override** for shipping a P1 fix immediately.
> This is a non-obvious engineering constraint on the frontend that has to be built before the
> second location exists, and it is owned by `frontend-engineer`.

---

## 9.8 Rollback runbook

Written to be executed by someone stressed, at the counter, possibly on their phone. Short
sentences, numbered steps, no deliberation required.

### What triggers a rollback

Agreed in advance so that nobody argues about it at the time.

| | Trigger | Class |
|---|---|---|
| **R1** | **Money is wrong.** Any mismatch between a printed receipt total and the recorded sale, or a cash-up that does not reconcile and is not explained within one hour. | Automatic |
| **R2** | **A write is lost.** Any confirmed sale recorded on a device and absent server-side after a successful sync. | Automatic |
| **R3** | **Cross-tenant data visible.** Any instance. No threshold. | Automatic |
| **R4** | **The counter cannot trade.** Sales cannot be completed on ≥ 2 devices at a location for > 15 minutes. | Judgement |
| **R5** | **Sync has stopped**, platform-wide, or the review queue is growing faster than it is worked for > 2 hours. | Judgement |
| **R6** | **A credit control fails open** — an over-limit credit sale is permitted. | Judgement |

Anything else is a defect. File it, fix it forward, do not roll back.

**R3 is not fixed by a rollback alone.** Rolling back stops the leak from widening; it does not
recall data already on a device. `ADR-0005` says this failure is unrecoverable, and it means it.
R3 additionally triggers device revocation for affected devices (§9.9) and an incident process that
is out of scope here.

### Who decides

**The engineer on call. Alone. Now.**

- R1, R2, R3 are **automatic**: roll back first, inform afterwards. No approval is sought.
- R4, R5, R6 are the on-call's judgement, with the founder notified.
- The founder may call a rollback unilaterally at any time.
- There is no committee, no bridge call, no sign-off.

**Nobody needs permission to roll back, and the bias is strongly toward rolling back.** Rolling back
a good release costs a day of schedule. Not rolling back a bad one costs the books, and the books
are the product.

### The first five minutes — do these before anything else

```
1. TELL THE OUTLET TO SWITCH TO THE PAPER RECEIPT BOOK.
   Trading continues on paper from this moment. This is step one because it is the
   only step that stops losing money.

2. DO NOT WIPE, RESET OR RE-ENROL ANY DEVICE.
   The pending writes on those tablets may be the only copy of today's sales.
   Nobody "clears the app to fix it".

3. WRITE DOWN the wall-clock time and the exact release version in production.
   Everything after this depends on knowing when it started and what was running.
```

### Then, by change type — three different procedures

**Case A — client-only release. Minutes.**

1. Set the affected ring's pinned version back to the previous build (Requirement 9.7-A).
2. Force service-worker update; devices reload on next launch.
3. The local database is untouched — the schema contract did not change, because Rule 9.3-B
   forbids shipping a schema change with a client change.
4. Pending writes survive and upload under the old client. **This is the payoff of Rule 9.3-B**,
   and it is the whole reason the rule has no exceptions.

**Case B — server application release, no DDL. Minutes.**

1. Redeploy the previous API image.
2. **Roll back the sync service only if it is implicated.** It is versioned and deployed
   separately for exactly this reason — rolling it back may re-key buckets and cost a re-sync
   across the fleet (§9.6), so it is not a reflex.
3. Verify uploads resume: `failed_sync` rate by reason returns to baseline.

**Case C — a migration has already been applied. Hours, not minutes.**

1. **Was it an expand step?** Then it is reversible: drop the added object. By Rule 9.3-B nothing
   in the field depends on it yet. Drop the dual-write triggers first, then the object.
2. **Was it a contraction?** You cannot un-drop a column. There is no fast path. The options are:
   restore to `scratch` at a point before the contraction, extract the dropped data, and re-import
   it; or a full PITR restore with the forced device re-upload window from §9.5.
3. Either way, execute §9.5's re-upload step. A restore without it silently loses acknowledged
   writes.

Case C is why contractions are scheduled separately, announced, run in the maintenance window, and
preceded by a fresh verified backup — so that if it comes to a restore, the restore point is
minutes old rather than hours.

### What happens to writes made on the bad version

The question people forget until they are in it. There are three populations.

**1. Writes that reached the server.** They are in the database and they do not disappear when you
redeploy. They are not automatically wrong — decide per case. If the bad version *computed*
something incorrectly (a total, a tax line, a facility fee, a GL posting), those rows must be
identified and corrected, and **the correction is a reversing entry, never an in-place update** —
the ledger is append-only and the audit trail has to show what happened and when (`ledger-engineer`
owns the posting shape).

Identifying them requires knowing which rows the bad build wrote, which requires provenance:

> **Requirement 9.8-A — row provenance.** Every row in `app` carries `written_by_client text` and
> `written_by_server text` in the `tenantTable` base columns (§1.3), stamped on insert and update.
> Without them, "find everything release 1.14.2 touched" is unanswerable and the correction becomes
> guesswork over a date range. This is a §1.3 base-column change I am asking for, and it must exist
> before the pilot — retrofitting provenance is worthless, because the rows you need it for were
> written before you added it. See C4.

**2. Writes still sitting on devices, made under the old contract.** They upload normally after
rollback, because Rule 9.3-A guarantees the old contract is still served. Nothing special happens.
This is the ordinary, boring, correct case, and it is boring precisely because of the rules.

**3. Writes on devices in a shape only the bad version understood.** This can only exist if Rule
9.3-B was broken. If it happens: they land in `platform.stranded_write` (§9.3.4) with reason
`unknown_column`, and are replayed by hand once a fixed build is out. They are **never dropped**.
The quarantine table exists for the day the discipline fails, which is the only day it matters.

### How the location keeps trading

An outlet that cannot take a sale is losing money every minute, so the fallback is not optional.

1. **Pre-numbered paper receipt books at every location, permanently.** Bought and stocked as a
   standing control, not procured during an incident. The number range in use is recorded per
   location so it can be reconciled later.
2. **Cash sales continue on paper without restriction.**
3. **Credit sales are the dangerous ones**, because the credit-limit check is exactly the control
   the software provides and paper does not. **Rule: during a paper fallback, no new credit is
   extended beyond a stated per-customer cap without a phone call to Accounts.** The cap is a
   tenant credit-policy value, set in advance, not invented at the counter.
4. **The manager cashes up on paper that evening** and reconciles the drawer to the paper book.
   That reconciled total is the authority when the sales are re-entered.
5. **Re-entry is a distinct, flagged flow.** Paper sales are entered afterwards with their original
   date, time and paper receipt number, through a "recorded from paper" path that marks them for
   the review queue and for the accountant. **Never back-dated silently** — a back-dated sale that
   looks like a normal one is an audit problem forever.
6. **The fallback is rehearsed before go-live** — one scheduled two-hour paper drill during the
   pilot, with the real staff. Same argument as the restore drill: an unrehearsed fallback is a
   belief. A manager discovering during an incident that nobody knows the credit rule is the
   scenario the drill exists to prevent.

### Afterwards

- Incident record created immediately; blameless write-up within 48 hours.
- **Pilot success-criteria clocks reset.** The 14-day counters start again from zero.
- The fix ships through the **full ring sequence**. No shortcuts, because the shortcut is what
  caused this. The single exception is a P1 data-loss fix, which may go to a hotfix ring — and that
  exception requires the same named decider, recorded.
- If the rollback was Case C, the next restore drill is brought forward and the migration is
  re-rehearsed before it is attempted again.

---

## 9.9 Secrets, device enrolment and revocation

### Secrets

- **No credentials in the repository.** Enforced by a pre-commit secret scanner and a CI scan, not
  by reviewer diligence.
- Everything lives in a cloud-KMS-backed secret manager. §1.4 already has the right shape:
  `platform.db_cluster.dsn_secret_ref` stores a **pointer, never a DSN**. Nothing in the database
  can leak a credential, because the database does not hold one.
- **Rotation:** database credentials every 90 days, automated. Token-signing keys rotate with
  overlap — two keys active, new tokens signed with the newest, old accepted until expiry.

> **Rule 9.9-A.** Signing-key retirement lag must exceed the **maximum** token TTL plus 7 days.
> §1.2 contemplates a 7-day TTL to let offline outlets keep trading, so a key retired after 3 days
> would invalidate a legitimately-offline outlet's token and lock a trading location out. The
> retirement schedule is derived from the TTL, never chosen independently.

- **CI holds no production secrets.** Deploys authenticate by short-lived OIDC federation. A stolen
  CI token should be worth nothing an hour later.

### Device enrolment

Enrolment is a **tenant-scoped, location-scoped, human-approved** act — never a self-service signup.

```
Admin at the tenant issues an enrolment code
  → short-lived (15 min), single-use, bound to (tenant_id, location_id, role_id)
Device redeems it over TLS
  → generates a keypair locally, registers the public key
  → receives a device identity; the private key never leaves the device
Thereafter: sync tokens require device assertion + user credential
```

Two independent factors, and each one alone is insufficient: a stolen tablet without a user
credential cannot sync, and a stolen user credential on an unenrolled device cannot sync. That
matters more here than in a typical system, because the tablet holds a full local copy of the
tenant's books.

### Local data at rest — the honest limitation

The local SQLite database is encrypted; §1.2's device seal works by **discarding the key** rather
than deleting rows, so sealing is one atomic operation that a power cut cannot half-complete.

But the honest version, which belongs next to `ADR-0003`'s receipt-printing risk rather than buried:
**a PWA cannot reach the Android Keystore.** There is no hardware-backed key storage available to
web code. The realistic ceiling is a non-extractable Web Crypto key held in IndexedDB, unlocked by
user authentication. That defends against casual access, a lost tablet picked up by a stranger, and
a curious employee. It does **not** defend against a rooted device, or a determined attacker with
the device unlocked and time.

A native Android client could use the Keystore. This is a genuine cost of `ADR-0003` and I am not
proposing we relitigate it — I am proposing it be **measured alongside the receipt-printing trial
during Phase 1**, so the Phase 1 gate decides on evidence about both. See C3.

The compensating controls are the ones we already have: minimise what is on the device at all
(bucket scoping, §9.6), keep seal windows short, and revoke fast.

### Revocation

`platform.device.revoked_at` is set → the token endpoint refuses that device → **existing tokens
remain valid until they expire.** So revocation is **bounded, not instant**, and the bound is the
token TTL.

That produces a tension worth naming rather than smoothing over: **a 7-day TTL is what lets a
genuinely disconnected outlet keep trading, and it is also how long a stolen tablet keeps working.**
One number cannot be right for both.

> **Proposal 9.9-B — two TTLs, set per location.** Default **24 hours**. A longer TTL (up to 7 days)
> is granted only to locations the tenant has flagged `low_connectivity`, set on the location record
> and reviewed at each phase gate. Stolen-tablet exposure at a well-connected flagship then becomes
> a day rather than a week, while Wenchi keeps its week. `rbac-security-engineer` owns the numbers
> and the token contents; this is an operational argument for making it a per-location value rather
> than a platform constant.

**Revocation must stop uploads too, not only downloads** — but *how* depends on why, and collapsing
the two cases loses either data or integrity:

| `revoked_reason` | Upload treatment |
|---|---|
| `staff_departed`, `device_replaced`, `reassigned` | Accept writes whose logical timestamp precedes `revoked_at`, for a drain window — same logic as §1.2 suspension. The tablet holds real sales and they are the tenant's property. |
| `lost_or_stolen` | **Quarantine to `platform.stranded_write`** for human review. A thief with an unlocked tablet can fabricate sales, and a fabricated sale that flows straight into the ledger is worse than a delayed real one. |

The reason code is required at revocation, and the console asks for it rather than defaulting.

---

## 9.10 Boundaries with other sections

| Concern | Owner |
|---|---|
| Sync protocol, batching, bucket shapes, re-sync semantics on rule change (Rule 9.1-A, §9.6, C2) | `sync-architect` |
| `platform.device` table, token TTL and contents, enrolment/revocation mechanics (§9.9, Proposal 9.9-B) | `rbac-security-engineer` — §9.9 specifies the operational columns and reason codes I need on it |
| `tenantTable` base columns, incl. Requirement 9.8-A provenance columns | `tenant-platform-engineer` (§1.3) |
| Service-worker release pinning and the `/release` endpoint (Requirement 9.7-A) | `frontend-engineer` |
| Correction-by-reversing-entry shape for bad-release data (§9.8) | `ledger-engineer` |
| Receipt-printing hardware trial; local-encryption trial (C3) | `pos-ux-specialist` + `frontend-engineer` |
| Statutory record retention driving archive policy (§9.5) | `compliance-gatekeeper` |
| Pilot success criteria 1, 2, 4 as executable drills | `sync-test-engineer`; criteria 5 with `money-test-engineer` |
| Ghana data-residency / Act 843 question (C6) | `compliance-gatekeeper` + external counsel |

---

## 9.11 Concerns and open questions

**C1 — The pilot and the outlet opening are the same day, and that makes the pilot unreadable.**
Tenant #1's Techiman flagship opens 1 August 2026 and the ERP goes live the same morning. New
outlet, new staff, new software: when something goes wrong nobody will be able to separate a
software defect from a staff learning curve, which is exactly what the pilot exists to distinguish.
Recommend a 2–4 week dry-run window before trading opens. If the date is immovable, that must be an
explicit decision with the first week reclassified as training and the 14-day success clocks
starting after it. `NEEDS-HUMAN` — founder.

**C2 — Deploying sync rules may force a fleet-wide re-download, and we have not verified it.**
On several offline-sync platforms, changing sync rules rebuilds affected buckets and clients
re-sync them. If that is true of ours, then a config change that looks routine is a metered-data
event across 25 outlets — and it interacts directly with §9.3.2, where every expand step adds a
table to the sync rules. **This must be measured in Phase 1 before the release cadence is fixed**,
because it may mean batching schema expansions into scheduled windows rather than shipping them as
they are ready. Owner: `sync-architect` + me.

**C3 — The PWA cannot use hardware-backed key storage, and that is a real cost of `ADR-0003`.**
Local encryption tops out at a non-extractable Web Crypto key in IndexedDB. Together with the
receipt-printing risk that `ADR-0003` already flags, that is now two material weaknesses in the PWA
choice, and the ADR lists only one. Not proposing we revisit it now — proposing the Phase 1 hardware
trial measure **both**, so the Phase 1 gate makes that call on evidence rather than by default. If
receipt printing also proves unreliable, the two findings together are a much stronger case for
native Android than either alone.

**C4 — Requirement 9.8-A (row provenance) is a change I am asking of §1.3, and it cannot be added
later.** Without `written_by_client` / `written_by_server` on the `tenantTable` base, "identify
every row release 1.14.2 wrote incorrectly" is answerable only by guessing at a time range. The
retrofit is worthless by construction: the rows you need provenance for are the ones written before
the column existed. Two `text` columns, added now, that nobody looks at until the day they are the
only thing that helps. Owner: `tenant-platform-engineer`.

**C5 — Single region, single cluster, and no HA story beyond the provider's own failover.** I am
proposing we accept this, and the reason is specific rather than lazy: because counters trade
offline, an hour of database downtime costs sync freshness and HQ reporting, not sales. For a
25-outlet business that is a tolerable failure. Two things must still happen: **ask the provider for
its written zone-failure RTO and record it** rather than assuming "managed" means "highly
available"; and state the threshold at which this changes — when a tenant's operations depend on
real-time cross-location data (centralised credit approval is the obvious candidate), or when the
tenant count makes an outage a contractual matter rather than an apology.

**C6 — Ghana data residency is a legal question we have not asked.** Hosting a Ghanaian company's
books in Ireland may carry registration or cross-border transfer conditions under the Data
Protection Act 2012 (Act 843), and EU hosting brings the operator within EU data-protection law
regardless of where the customer is. Neither is an engineering judgement. This is the single input
that could invalidate §9.1 outright, and it costs one conversation to resolve. `NEEDS-HUMAN` —
`compliance-gatekeeper` plus Ghanaian counsel, before Phase 1 go-live rather than after.

**C7 — Contraction gated on positive check-in means one lost tablet blocks contraction forever.**
That is the correct default — the alternative strands writes — but it needs a policy owner. Device
retirement writes off whatever `pending_writes_estimate` says, which is a business decision with
money attached, and today nobody owns it. Proposal: retirement requires a tenant administrator, not
a platform operator, and the acknowledged figure is recorded in `retired_pending_writes`.
`NEEDS-HUMAN` — founder for tenant #1, then it becomes standard onboarding policy.

**C8 — Two costs I am asserting are small without having priced them.** Quarterly full-cluster
restore drills consume compute for the scratch cluster; SMS alerting to tenant operations contacts
(§9.4) needs a provider and a per-message cost. Both are almost certainly immaterial next to a
week-long sync outage or an untested backup, and I am proposing we do both regardless — but the
numbers should be filled in at the Phase 1 gate rather than left as an assumption that quietly
becomes a reason to skip the drill.
