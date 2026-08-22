# 9. Infrastructure, Migrations and Rollout

**Implements:** `ADR-0003` (PWA client, managed Postgres in an EU region) · `ADR-0005` (shared
schema, one migration for every tenant) · `CLAUDE.md` §3 (Phase 0 must contain a rollout plan with
success criteria and a rollback plan) · §2.2 (no write is ever lost)

> **Revised 2026-08-22 after adversarial review. §9.12 records the disposition of every finding and
> governs where it differs from the body.** Six findings were blocking; five of the six were this
> section specifying a mechanism that §3 had already built, slightly differently — see §9.12.1.

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

Fixed costs are ~2 seconds of a 60-second budget. Round-trip **count** is one risk. An outlet
returning after a day offline may hold 200–400 pending writes. At one round trip per write,
300 writes × 200 ms = **60 seconds of pure network wait**, and the acceptance criterion fails on a
system that is otherwise working perfectly.

**But round trips are not the only term, and the first draft of this section priced only that one.**
Bytes matter too, and on the case the paragraph above sizes they dominate. §3.4.2 / §4.8 snapshot the
full tax basis onto every `sale_line_tax`; a mutation against a mutable row carries `changed_fields`
plus the base value of each (§3.11.10 #13); payloads are RFC 8785 canonical JSON (§3.11.6), which is
verbose by design. At §3's own ~250 bytes/row and ~5–8 rows per sale:

```
300 queued sales × ~6 rows × ~250 B      ≈  450 KB canonical, before framing
at 5× compression (§9.6, to be measured)  ≈   90 KB on the wire
uplink 1 Mbps (HSPA, typical)             ≈  0.7 s  compressed  /  3.6 s  uncompressed
uplink 0.3 Mbps (HSPA, congested)         ≈  2.4 s  compressed  /   12 s  uncompressed
uplink 30 kbps (GPRS fallback)            ≈   24 s  compressed  /  120 s  uncompressed
```

Two conclusions the round-trip framing hid. **Compression is not an optimisation, it is load-bearing
for the acceptance criterion** — uncompressed, a congested HSPA uplink eats a fifth of the budget on
one location's backlog. And **the 60-second criterion is not claimed on a 2G/GPRS fallback**; on that
link the queue drains correctly but not inside a minute, which is acceptable — the write is durable
on the device the whole time — and it must be *stated* rather than discovered by a failing test in
Techiman.

> **Rule 9.1-A — the sync cost budget, in both terms.**
> **(a) Round trips.** Upload cost is `O(batches)`, not `O(writes)`. A batch carries at minimum
> 100 writes, requests are pipelined rather than serialised, and no sync operation requires more
> than 3 sequential round trips per batch.
> **(b) Bytes.** A completed retail sale costs **≤ 2 KB canonical / ≤ 700 B on the wire** as an
> uploaded mutation. Measured in Phase 1 against real payloads, published, and regression-tested —
> a release that doubles the payload of a sale is a release that broke Ghana without breaking CI.
> **(c) The link the criterion assumes.** `CLAUDE.md` §3 acceptance 1 (60 s) is asserted against
> **≥ 1 Mbps uplink with compression negotiated**. Below that the requirement is *convergence
> without loss*, not convergence in 60 seconds.
> Hard requirements on `sync-architect`'s protocol choice; Phase 1 measurements, not aspirations.

> **Rule 9.1-B — backpressure, because the fleet reconnects together.** Devices do not fail
> independently. A regional cell outage, a maintenance window ending, a sync-rule deploy (§9.3.5)
> or §9.5's forced re-upload all end with the **entire fleet reconnecting inside the same minute**,
> against one sync service. So:
> - the **server advertises the batch size and a `retry_after`**, and the client obeys it rather
>   than choosing its own;
> - reconnection uses **full-jitter exponential backoff**, never a fixed interval, so devices that
>   went dark together do not come back together;
> - a **per-location concurrency cap** exists so a flagship draining four tills cannot occupy the
>   upload pipeline while eighteen micro-outlets wait — fairness is a rule, not an emergent
>   property of queueing;
> - **forced re-upload windows are staggered by ring** (§9.5, §9.7.2), announced, and never
>   fleet-wide simultaneously.

The corollary is that EU hosting is fine *provided the protocol is neither chatty nor fat*. A chatty
or verbose protocol would fail in Ghana and pass in every developer's local test, which is exactly
the class of defect that reaches production.

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
| `scratch` | **A restored production snapshot — production data, under production rules** | Created and destroyed by the restore drill (§9.5), migration rehearsal (§9.3.5) and per-tenant recovery (§9.5). Never long-lived. Governed below. |

Four rules about them:

**No production data in staging. Ever, including "anonymised".** A shared-schema multi-tenant
database anonymised badly is a cross-tenant leak with extra steps, and `ADR-0005` is explicit that
the leak is unrecoverable. Instead, staging gets a **synthetic volume generator** sized from
`financial-model-targets.md`: 25 locations, 219 SKUs, and transaction volume derived from revenue.

The sizing number, cited from the model's own row rather than reconstructed (`CLAUDE.md` §2.10):
**FY10 revenue is GH₵41,184,000** (`financial-model-targets.md` §3). The earlier draft quoted
"roughly GH₵42.2 m", which is the *fully-ramped steady state* implied by the per-tier rates
(6.6 m flagship / 3.3 m RDC / 0.88 m micro-outlet — those rates are canonical); the model's FY10
row is lower because outlets opened in FY9 and FY10 are still on the 40 / 70 / 100 % ramp. Staging
is seeded to **the fully-ramped figure, not the FY10 row** — deliberately the larger of the two,
because a load fixture should be the pessimistic reading. At a blended basket in the low hundreds
of cedis that is on the order of **100,000–200,000 sale headers a year**, perhaps 400,000–700,000
sale lines. Over ten years the largest table holds single-digit millions of rows.

**This is not a scale problem.** Nothing in this section should be justified by throughput. The
hard parts are correctness, connectivity and recoverability. Two consequences follow: we do not
buy infrastructure for scale we will not have, and we *do* still size migrations for lock duration
against a few million rows, because a five-second `ACCESS EXCLUSIVE` lock on a small table is still
a five-second stall for every tenant (§9.3.2).

One honest limit on that fixture: **staging seeded at one year's volume does not test ten years of
accumulation.** Migration lock duration against the ten-year table sizes is covered — §9.3.5
rehearses every migration against a restored production clone, which by definition has the real
accumulation in it. What staging is *not* covering is sync-rule behaviour and stale-fleet
behaviour at ten-year table sizes, because those run on staging rather than on `scratch`. So the
generator carries a **`--years` multiplier** and the annual capacity review reseeds staging at the
current network age plus three years. Cheap; easy to forget; stated here so it is scheduled.

**Staging holds a deliberately stale device fleet.** A set of pinned old client builds — the
oldest supported contract version, plus the two before it — running against staging continuously
with pending writes, *including writes enqueued before their build was upgraded*, which is the
exact population §9.3.4's gate exists to catch. This is the only way to test "an outlet comes back
after a week on an old build" before it happens for real. It is the fixture the contraction gate
(§9.3.4) is validated against, and the fixture must include the case where a device has *upgraded*
but has not *drained*.

**`scratch` is production data and gets production rules, not a footnote.** It was previously
described in one line, which sat badly next to "no production data in staging, ever". `scratch` is
a full copy of every tenant's books — it exists precisely because it is a faithful copy — and it
stands up repeatedly, on a schedule, with a `platform_admin` RLS-bypassing workflow attached
(§9.5's per-tenant recovery path). So:

- **It is a production-tier environment.** Same VPC and network isolation as production, same
  encryption at rest with the same KMS key class, same TLS-only ingress, no public endpoint.
- **Access is by named human, time-boxed, and approved** — a break-glass grant with an expiry, not
  standing membership of a group. The approver is not the requester.
- **Every session is logged**: who connected, from where, when, and every statement, exported to
  the same log sink as production. The `platform_admin` RLS-bypass path in particular is
  statement-logged in full, because it is the one place in the platform where the tenant boundary
  is deliberately off.
- **No client, tenant or third party ever connects to it**, and no application traffic is ever
  pointed at it.
- **Destruction is a recorded fact, not the last line of a runbook.** `platform.restore_drill`
  carries `scratch_destroyed_at timestamptz`, and an un-destroyed `scratch` older than 72 hours is
  a paging alert. A snapshot of every tenant's books left running because a drill was interrupted
  is a bigger exposure than anything else in this section.

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
6. **Set the location sync expectation** (§9.4) per location — trading hours, expected sync cadence,
   and the tenant's own operations-contact channel and address. Without this, the liveness monitor
   has nothing to compare against and nobody to tell.
7. **Assign each location's release ring** (§9.7.2). Rings are a **per-location, tenant-set value**
   (`app.location.release_ring`), not a platform taxonomy. A new tenant's locations all start at the
   **rearmost ring** — the one that receives a build only after every earlier ring has soaked it —
   never at a canary ring. Their pilot is their own; it does not double as ours.

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
  version              int primary key,     -- monotonic; bumped only by contract-visible changes
  min_served_contract  int not null,        -- the floor this deployment actually serves
  applied_at           timestamptz not null,
  phase                text not null,       -- 'expand'|'backfilling'|'backfilled'|'contracted'
  description          text not null,
  migration_id         text not null references platform.schema_migration (id),
  constraint contract_floor_sane check (min_served_contract <= version)
);

create table platform.client_release (
  version       text primary key,          -- '1.14.3'
  min_contract  int  not null,             -- oldest server contract this build can talk to
  max_contract  int  not null,             -- newest
  released_at   timestamptz not null,
  status        text not null              -- 'canary'|'stable'|'supported'|'deprecated'|'blocked'
);
```

The server declares the contract range it serves — `[min_served_contract, version]`, a stored pair,
not a sentence. Every client declares the range it understands. A device outside the range gets a
**distinguishable, named error** that the client surfaces as "this device needs an update before it
can sync — your sales are safe on this device", and its writes go to quarantine (§9.3.4) rather than
being rejected into the void.

> **Rule 9.3-A — the support floor, with an artefact behind it.** The server must serve every
> contract version claimed by any non-`blocked` client release with a device seen in the last
> **180 days**. No contraction may reduce the served range below that floor.
>
> **Enforced at deploy time, not by memory.** A deploy that would raise `min_served_contract`
> aborts unless:
>
> ```sql
> -- must return zero rows before min_served_contract may be raised to :NEW_FLOOR
> select r.version, min(r.min_contract) as needs, count(*) as devices
> from   app.device d
> join   platform.client_release r on r.version = d.client_version
> where  d.status = 'active'
>   and  r.status <> 'blocked'
>   and  d.last_seen_at > now() - interval '180 days'
>   and  r.min_contract < :NEW_FLOOR
> group by r.version;
> ```
>
> **Precedence, because two rules govern the same act and they are not equally strict.**
> Rule 9.3-A is a *floor* — it bounds how far back the server must reach. §9.3.4's gate is a
> *positive proof of drainage* with no time bound at all, and it is strictly stricter. **§9.3.4
> governs whether a contraction may proceed; Rule 9.3-A governs what the deployment must keep
> serving in the meantime.** Passing 9.3-A is necessary and not sufficient. Where they appear to
> conflict, the stricter one wins, and it is always §9.3.4.

### 9.3.2 Expand–migrate–contract, concretely

The abstract version is well known and useless under pressure. Here is a real change, with the
hazards named at each step.

**Choosing the example matters.** The first draft used credit limits — and got it wrong, because §4
and §6 have *already* built per-account credit terms (`app.credit_account` with
`credit_limit_minor app.money_minor`, `terms_days`, `facility_fee_bp_per_month app.bp`,
`limit_set_hlc`, `limit_write_id`; §6's effective-dated terms with `terms_days_snapshot` and
`fee_rate_bp_snapshot` on issued documents). Teaching a pattern with DDL that contradicts the
schema, omits the registry's own domains and base columns, and would fail §9.3.6's CI assertion is
worse than teaching nothing, because this is the example everyone copies.

**The change, which is real and not yet built:** `app.customer.price_list_id uuid` is today a
*scalar* override of the location's list (§4.9). §4.6 resolves price by "the customer's assigned
list, else the location's list, else the tenant default, all filtered to lists effective on the
transaction date" — so the *lists* are effective-dated but a customer's *assignment to a list* is
not. Move a contractor from wholesale to a framework list and every historical reprice silently
uses the new assignment. That is the same defect `CLAUDE.md` §2.5 forbids for tax rates, one table
over. So: promote the scalar to an effective-dated `app.customer_price_list_assignment`.

It is a good teaching example precisely because **it touches money** — which means the backfill is
governed by Rule 9.3-E below, and gets its own test under `CLAUDE.md` §2.7.

---

**Step 1 — Expand. Server release R1. Additive only. No client change ships in this release. The
sync-rule change does not ship in this release either (Rule 9.3-D).**

The table is *declared*, not hand-written (§1.3). The registry declaration is the source; the DDL
below is what it emits, shown so the migration is legible:

```ts
export const customerPriceListAssignment = tenantTable('customer_price_list_assignment', {
  columns: {
    customer_id:    ref('customer'),
    price_list_id:  ref('price_list'),
    effective_from: date(),
    effective_to:   date().nullable(),
    assigned_by:    ref('user').nullable(),   // null for the backfill's system actor
  },
  uniques: [['customer_id', 'effective_from']],
  indexes: [['customer_id', 'effective_from']],
  lifecycle: 'carry',
});
```

```sql
-- migration 0142_expand_customer_price_list_assignment.sql   (transactional)
create table app.customer_price_list_assignment (
  tenant_id      uuid        not null references platform.tenant (id),
  id             uuid        not null,               -- uuidv7
  customer_id    uuid        not null,
  price_list_id  uuid        not null,
  effective_from date        not null,
  effective_to   date,
  assigned_by    uuid,
  row_hlc        app.hlc     not null,               -- §3.6: mutable row ⇒ CAS token
  archived_at    timestamptz,                        -- §3.2.4 bucket membership
  created_at     timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, id),
  constraint cpla_customer_fk foreign key (tenant_id, customer_id)
    references app.customer (tenant_id, id) deferrable initially immediate,
  constraint cpla_price_list_fk foreign key (tenant_id, price_list_id)
    references app.price_list (tenant_id, id) deferrable initially immediate
);

-- the guard the backfill needs to be idempotent under READ COMMITTED (Rule 9.3-E)
create unique index cpla_customer_from_uq
  on app.customer_price_list_assignment (tenant_id, customer_id, effective_from);

alter table app.customer_price_list_assignment enable row level security;
alter table app.customer_price_list_assignment force  row level security;
create policy tenant_isolation on app.customer_price_list_assignment
  using      (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);

-- old column untouched. nothing dropped. nothing renamed.
```

`row_hlc`, `archived_at` and the base-column set come from §1.3's emitter, not from this migration —
if a hand-written expand migration is missing them, §9.3.6's CI assertion fails, which is the
assertion doing its job.

Hazards at this step:

- **`app.customer.price_list_id` is not touched.** Not renamed, not deprecated in the DDL, not
  commented out. Old clients still read and write it.
- **Projection runs in both directions for the whole window — and it is a *write*, not a trigger
  side effect.** See the box below; this is where the first draft was wrong.
- **The sync-rule change is a separate, scheduled event** (Rule 9.3-D). Adding this table to the
  rules is what makes it appear on 100+ devices, and *that*, not the `CREATE TABLE`, is the change
  with the blast radius.
- **`R1` ships no client change that depends on any of this.** See Rule 9.3-B.

> **The dual-write hazard the first draft got wrong, stated plainly.**
>
> The obvious implementation is a pair of triggers projecting old → new and new → old. **It is
> wrong, and it breaks the thing this platform is built on.** §3.11.7 is authoritative: *every*
> server-originated write goes through `app.write_log` with `origin='SERVER'`, a platform
> system-actor id, a server node id for HLC generation, and a **deterministic** `write_id`. §3.6
> requires every mutable row to carry `row_hlc`, and conflict detection is a compare-and-set against
> `base_row_hlc`.
>
> A trigger-inserted row has **no `write_log` entry, no `row_hlc`, and no `write_id`** — and because
> the trigger fires inside a replicated transaction, that row still reaches the WAL and still syncs
> to every device. A device then edits it, the CAS compares `base_row_hlc` against an absent
> `row_hlc`, and the server either rejects every edit or accepts every edit unconditionally.
> Neither is a conflict-resolution outcome; both are silent corruption.
>
> It is worse on any table that carries an adjudication trail. §4.9's credit limit is *the* canonical
> never-merge conflict (`CLAUDE.md` §2.2), adjudicated in the review queue using `limit_set_hlc` and
> `limit_write_id`. A trigger-projected limit change carries neither, so it is indistinguishable from
> a human's edit and **cannot be adjudicated at all.**
>
> **Therefore, without exception: expand-phase projection is a server-originated mutation through
> the normal write path.** A backfill/projection worker reads the source rows and issues ordinary
> `origin='SERVER'` mutations with
> `write_id = uuidv5(ns, 'proj:0142:' || tenant_id || ':' || customer_id || ':' || source_row_hlc)`,
> so a re-run is a no-op by §3.11.3's replay rule rather than a duplicate. HLC is server-stamped;
> `row_hlc` is set by the write path, not by the migration.
>
> **If a trigger is genuinely unavoidable** — the only case is a hot path where a worker cannot keep
> up and staleness would be user-visible — then the trigger must, *in the same statement*, insert the
> `write_log` row with `origin='SERVER'` and a deterministic `write_id`, and stamp `row_hlc` from the
> server node's HLC. A trigger that writes a row and not its log entry does not ship. This is a
> reviewable, testable condition, not a guideline.

**Step 2 — Backfill. Separate, batched, resumable, per-tenant, and — because it touches pricing —
governed by Rule 9.3-E.**

Never one statement over the whole table. One statement takes a long transaction, bloats WAL, and
hits every tenant at once — the exact shared-schema blast radius `ADR-0005` warns about.

```sql
-- Run per tenant, in a loop, with a cursor, throttled.
-- Executed by the projection worker, which wraps each batch as origin='SERVER' write_log
-- entries with deterministic write_ids (see the box above). SQL shown for the row shape.
insert into app.customer_price_list_assignment
       (tenant_id, id, customer_id, price_list_id, effective_from, effective_to,
        assigned_by, row_hlc)
select c.tenant_id,
       uuidv5(:ns, 'bf:0142:' || c.tenant_id || ':' || c.id),  -- deterministic: re-run = no-op
       c.id,
       c.price_list_id,          -- THE EXISTING PER-ROW VALUE. never a tenant default.
       c.created_at::date,       -- the customer's own start date, so history reprices correctly
       null,
       null,                     -- system actor; the write_log row carries who and why
       :server_hlc
from   app.customer c
where  c.tenant_id = :tenant
  and  c.id > :cursor
  and  c.price_list_id is not null       -- underivable rows go to a human, not to a default
order by c.id
limit  1000
on conflict (tenant_id, customer_id, effective_from) do nothing;
```

Three things in that statement are load-bearing, and the first draft got all three wrong:

1. **`c.price_list_id`, not a tenant default.** The first draft joined a tenant policy table and
   wrote `default_terms_days` and `default_fee_bp` onto every existing account — which means an
   account legitimately on fee-free terms silently acquires the tenant's fee and starts accruing.
   A batch job that changes what a customer owes, with nobody signing anything, is not a migration;
   it is an unauthorised repricing.
2. **`effective_from = c.created_at::date`, not `current_date`.** With `current_date` the row covers
   only the future, so recomputing any pre-backfill period finds no effective row — the same failure
   `CLAUDE.md` §2.5 forbids for tax rates.
3. **`on conflict … do nothing` against a real unique index**, not `not exists`. Under
   `READ COMMITTED` — which §3.11.10 #23 pins — a `not exists` guard is not atomic, so a resumed run
   racing a live one produces two assignment rows for one customer on one date, with no rule for
   which applies.

Rows where `price_list_id is null` are not defaulted. They are the ordinary case (the customer
resolves to the location's list), and they get **no assignment row at all** — absence is the correct
representation. Where a value genuinely cannot be derived, the row goes to a human work queue with
the tenant named, never to a default.

Progress lives in `platform.backfill_progress (migration_id, tenant_id, cursor, state, updated_at)`
so it is resumable after a crash and pausable per tenant. **Backfills are the one part of a
migration that can be canaried** — run a **designated canary tenant**, verify, then the rest. The
designated tenant is a per-migration choice recorded on the migration, not a hard-coded identity;
naming tenant #1 in platform logic is exactly what `ADR-0006` and `CLAUDE.md` §2.9 forbid.

**Step 2b — Sync-rule deploy. A separate, scheduled, announced event** (Rule 9.3-D). The new table
enters the rule document, buckets rebuild, and every device in every tenant re-downloads what the
rule change affects. Byte estimate published per tenant beforehand; run inside the maintenance
window; revert tested.

**Step 3 — Client release R2** reads the new shape and tolerates the old. Rolled out through the
rings in §9.7.2, over days. The server is already tolerant, so ring order does not matter for
correctness — which is the entire point of shipping the server first.

**Step 4 — Wait for catch-up.** §9.3.4. This is where the schedule stops being under our control.

**Step 5 — Contract, in three moves, not one.**

- *5a.* Deploy server code that no longer writes `app.customer.price_list_id`, and stop the
  new → old projection.
- *5b.* **Remove the column from the sync rules** — another scheduled rule deploy (Rule 9.3-D) —
  and wait for the fleet to take it. The column must leave the *rules* before it leaves the *table*,
  or the bucket rebuild and the `DROP COLUMN` race each other.
- *5c.* Only then, `alter table app.customer drop column price_list_id;`. Bump
  `platform.schema_contract`, set `phase = 'contracted'`.

> **How you prove nothing reads a column — and the proof the first draft used, which proves nothing.**
>
> The first draft's evidence was a `deprecated_column_read` ORM counter plus a `pg_stat_statements`
> sweep, "observed at zero for 14 days". **Both instruments are server-side, and the readers are
> not on the server.** Every device reads `price_list_id` out of its **local SQLite replica**. That
> read emits no server statement and never enters the ORM. The counter sits at zero while a hundred
> tablets read the column at every sale, 5c drops it, the next bucket rebuild removes it from local
> schema, and the counter-side price resolution fails open or hard-errors mid-sale.
>
> So the proof is split, and only one half is telemetry:
> - **Server readers** — the ORM counter and the `pg_stat_statements` sweep, at zero for 14 days.
>   This is evidence about the server and nothing else, and it must be labelled as such.
> - **Fleet readers** — **§9.3.4's contraction gate is the proof.** Every active enrolled device is
>   on a build whose `min_contract` post-dates the last build that read the column, *and* has
>   drained its queue since upgrading. There is no telemetry substitute for this; the gate is the
>   instrument.

Between 5a and 5c there is a window where the change is fully reversible by redeploying. After 5c
it is reversible only by restore. That asymmetry is why they are separate releases.

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

### 9.3.3 The rules that are never bent

> **Rule 9.3-B.** A schema change and a client change that depends on it **never ship in the same
> release.** The tolerant server ships first, alone, and is proven in production before the client
> that needs it is built. There is no "but it's only additive" exception, because the exception is
> how the rule dies.

> **Rule 9.3-C.** A contraction never ships until catch-up is **positively proven** (§9.3.4).
> Not "we think everyone updated". Not "it has been a month". Proven, by a query, with a recorded
> result attached to the migration.

> **Rule 9.3-D — the sync-rule deploy is the unit of blast radius, not the DDL.**
> A `CREATE TABLE` costs a millisecond and affects nobody. **Adding that table to the sync rules
> costs a bucket rebuild on every device of every tenant** — §3.11.8 and §3's C2 record that the
> rules are *one global document for the whole service*, and that a deploy rebuilds affected
> buckets fleet-wide. So the "provably safe additive expand" of §9.3.5 is, in its second half, a
> metered re-download for the whole fleet, and Case C's rollback (§9.8) is a *second* one. Four
> consequences, all binding:
> 1. **A schema expansion and its sync-rule change never ship together.** Same argument as
>    Rule 9.3-B, different axis: the DDL is reversible in seconds, the rule deploy is a fleet event.
>    They are separated so that reverting one does not force the other.
> 2. **Rule changes are batched into a scheduled window** (§9.3.5's maintenance window), with a
>    **per-tenant byte estimate published before the window**, because the tenant pays for it (§9.6).
>    Shipping rule changes as they are ready is how a fortnightly release cadence becomes a
>    fortnightly data bill.
> 3. **The rule document is versioned and stored** — `platform.sync_rule_version (id, applied_at,
>    document, checksum, byte_estimate_json, reverted_from)` — and its **revert is tested on
>    staging before the forward deploy**, not written during the incident.
> 4. **The two-tenant isolation fixture runs against the rule document itself**, at every version,
>    in CI. §3.11.9 is explicit that *the sync rules file is the isolation boundary*; testing
>    isolation only through the API tests the wrong artefact.

> **Rule 9.3-E — a backfill that touches money is a money-touching function.**
> `CLAUDE.md` §2.7 category 1 applies to backfills exactly as it applies to services, and a backfill
> is more dangerous than a service because it runs once, unattended, over every row. Therefore:
> - **It carries the existing per-row value. Never a tenant default, never a computed rate.** If the
>   old shape did not record the value, the new shape does not invent it.
> - **Rows whose value cannot be derived go to a human work queue**, named per tenant, and the
>   migration is not "done" while the queue is non-empty.
> - **Effective dates come from the row's own history**, never `current_date` — otherwise recomputing
>   any prior period finds no effective row (`CLAUDE.md` §2.5).
> - **Idempotence is structural**: a unique index plus `ON CONFLICT DO NOTHING`, or a deterministic
>   `write_id`. Never a `NOT EXISTS` guard, which is not atomic under `READ COMMITTED`.
> - **It ships with its own test**, written with it, asserting the backfilled figures against a
>   hand-computed fixture — including the "no derivable value" case.
> - **A backfill that would change a receivable, a payable, a price or a tax basis requires the same
>   named human sign-off as a ledger change**, recorded on the migration. A batch job must not be
>   able to reprice a customer while nobody is looking.

### 9.3.4 How you know every device has caught up

This is the question the whole discipline hangs on, and "check the dashboard" is not an answer.

#### One device registry, one lifecycle vocabulary

The first draft of this subsection invented a third device table in `platform`, cross-referenced to
§1.9 — which is a boundaries table, not a registry. That reference pointed at nothing, and three
registries with three different status vocabularies is how a gate ends up not behaving the way its
prose says it does. Corrected:

| Table | Owner | What it is |
|---|---|---|
| **`app.device`** (§2.7) | `rbac-security-engineer` | **The registry of record.** Identity, keypair, home location, lifecycle status. `(tenant_id, id)`. Tenant-owned, RLS on. |
| **`app.device_sync_state`** (§3.11.4) | `sync-architect` | Liveness and **drainage attestation**. `last_seen_at`, `last_queue_empty_at`, `outstanding_estimate`. |
| **`app.device_write_watermark`** (§3.11.3) | `sync-architect` | `contiguous_through`, `applied_count` — what the server has actually accepted. |

There is no `platform.device`. Operational columns go on `app.device`:

```sql
-- app.device — §2.7 owns it. These are the columns operations requires, and their
-- absence makes Rule 9.3-C unenforceable.
  client_version            text references platform.client_release (version),
  contract_version          int,          -- highest server contract this build supports
  contract_version_since    timestamptz,  -- WHEN this device first reported >= contract_version.
                                          -- set on transition only; never on every handshake.
  last_upload_at            timestamptz,  -- last accepted write batch
  bytes_up_28d              bigint,       -- §9.6
  bytes_down_28d            bigint,
  retired_at                timestamptz,  -- see "retirement" below; mirrors status='retired'
  retired_pending_writes    int,          -- the acknowledged write-off
  retired_close_exclusion_id uuid         -- FK to the period-close exclusion this retirement wrote
```

**Lifecycle vocabulary — one set, because today there are two and neither is complete.** §2.7 has
`active | suspended | revoked`; §3.11.4 has `active | suspended | retired`. Each is a subset of the
same four, so the reconciliation contradicts neither:

```
app.device.status ∈ 'active' | 'suspended' | 'revoked' | 'retired'
```

`app.device_sync_state.enrolment_status` is **the same value, not a second opinion** — it is a
denormalised copy maintained by the write path so that sync rules can filter on it without a join.
Adopting the four-value set in §2.7 and §3.11.4 is a **Phase 0 exit condition**, in the same class
as §3.11.9's naming reconciliation. See C9.

#### The gate: drainage after upgrade, not capability

**The gate is a positive signal, not an absence of one.** That instinct was right and the first
draft implemented the wrong positive signal. Its query asked only whether a device had *checked in
on the new contract* — and **upgrading a client does not rewrite the payloads already sitting in its
queue.**

The failure it lets through, concretely: the Wenchi tablet upgrades to build 1.15 on Friday over the
outlet's Wi-Fi and reports `contract_version = V`. Its upload queue still holds 180 sales enqueued
by build 1.14, canonicalised at the older mutation payload version (§3.11.6). The old gate returns
zero rows. Step 5c drops the column. On Monday the queue drains and all 180 writes land in
quarantine with reason `unknown_column`, needing hand replay per sale — precisely the outcome
Rule 9.3-C exists to make impossible.

§3.11.4 already built the right primitive and §9 was not using it: `last_queue_empty_at`, set **only**
by an explicit client "queue drained" acknowledgement. The gate is therefore *drainage after
upgrade*, corroborated by the server's own watermark:

```sql
-- Devices that would be stranded by contracting to required version :V.
-- Contraction is permitted only when this returns ZERO rows.
select d.tenant_id, d.home_location_id, d.id, d.client_version,
       d.contract_version, d.contract_version_since,
       s.last_seen_at, s.last_queue_empty_at, s.outstanding_estimate,
       case
         when d.contract_version is null
           or d.contract_version < :V              then 'never_upgraded'
         when s.last_queue_empty_at is null
           or s.last_queue_empty_at
              <= d.contract_version_since          then 'upgraded_but_not_drained'
         when w.contiguous_through is null
           or w.updated_at < d.contract_version_since then 'no_server_side_corroboration'
       end as blocking_reason
from   app.device d
join   app.device_sync_state       s on s.tenant_id = d.tenant_id and s.device_id = d.id
left   join app.device_write_watermark w on w.tenant_id = d.tenant_id and w.device_id = d.id
where  d.status in ('active', 'suspended')          -- see the suspension rule below
  and  ( d.contract_version is null
      or d.contract_version < :V
      or s.last_queue_empty_at is null
      or s.last_queue_empty_at <= d.contract_version_since
      or w.contiguous_through is null
      or w.updated_at < d.contract_version_since );
```

Three conditions, and each catches a distinct failure:

1. **`contract_version >= :V`** — the build can speak the new contract. Necessary, not sufficient.
2. **`last_queue_empty_at > contract_version_since`** — the device has explicitly acknowledged an
   empty queue *since it upgraded*. This is the one that catches the Wenchi case, and it is the
   whole point. `contract_version_since` is stamped on the transition, so a device that upgraded on
   Friday and drained on Monday passes, while one that upgraded on Friday and has not drained does
   not.
3. **`device_write_watermark.updated_at > contract_version_since`** — the *server* saw writes from
   this device advance after the upgrade. Client-reported drainage is a claim; the watermark is
   corroboration. A device whose local storage was evicted (see §9.5) can report an empty queue
   truthfully while its writes are simply gone — condition 3 does not detect that either, and
   nothing here can; it is named as a limitation rather than papered over.

**`suspended` blocks the gate, and that was missing.** A tablet suspended pending a staff
investigation still holds sixty sales. It is neither revoked nor retired. Under the first draft's
predicate it was invisible to the gate — and the operator's workaround (suspend rather than retire)
would produce *no* acknowledged write-off at all, so sixty sales would vanish with no record and no
signature. So: **`suspended` is treated exactly as `active` for this gate, for the same reason
§3.11.4 treats it as blocking a period close.** Suspension is a pause, not a disposal.

**`revoked` clears the gate**, because revocation already carries a recorded disposition: a
`staff_departed` revocation drains first (§9.9), and a `lost_or_stolen` revocation routes the
device's writes to quarantine under human review rather than into silence.

**`retired` clears the gate**, and that is the only path from "holding writes" to "no longer
blocking" — described next.

#### Retirement is one action, with one owner, and it is not only a migration action

A device that has not drained must be explicitly **retired** by a human asserting "that tablet is
gone". The first draft described this as a migration-gate action performed by "an operator at the
tenant", and that is wrong in a way that quietly corrupts the books.

**§3.11.4 is authoritative and already owns this policy.** `location_attested_through` holds only if
every non-retired enrolled device at the location has attested queue-empty; excluding a device is an
audited **Accounts** action recorded **on the close record** with its outstanding estimate, and
anything the device later produces posts as `is_late_arrival` onto a mandatory report. §3 says it
outright: *"it is one policy and one owner, not two."*

The scenario the first draft admitted: ops retires a dark tablet on 12 March to unblock a
contraction. February — which had been blocked on that device's attestation — silently becomes
closable, with no exclusion on the close record and nobody at Accounts in the loop. If the tablet
comes back, its sales post into the earliest open period (§5), so February is understated and March
overstated, permanently.

> **Rule 9.3-F — one retirement, one action, three records.** Retiring a device is a **single
> action**, defined by §3.11.4, and §9 does not re-invent it. It writes, atomically:
> - `app.device.status = 'retired'`, `retired_at`, `retired_pending_writes`;
> - the **period-close exclusion record** §3.11.4 requires, with the outstanding estimate, linked
>   via `retired_close_exclusion_id`;
> - an entry on the contraction record if a contraction is what prompted it.
>
> There is no path that sets one without the others. A retirement performed to unblock a migration
> is the same act, with the same audit trail and the same signature, as one performed to close a
> period — because it is the same write-off. **Who is entitled to perform it is `open-questions.md`
> Q19**, not a §9 decision; §9's contribution is that the answer must be one role, not two.

**And the figure the operator signs must not be a comfortable lie.** The first draft showed
`pending_writes_estimate` from the device's last handshake — which, for a device you are retiring,
is by definition from *before* it went dark. §3.11.4 labels its equivalent "device-reported,
advisory". The tablet that reported 3 pending on the Monday it vanished holds 180 by Friday; the
console says "3", the operator shrugs, and 180 sales are written off cheaply. A control that
produces false comfort is worse than no control.

The retirement screen therefore shows **three numbers and one sentence**, never one number:

```
  Last reported by the device:  3 unsynced writes,  17 days ago (5 Mar)
  Estimated actually held:      ~290 writes
                                 (17 days × 17.2 writes/day, this location's own
                                  trailing 28-day mean before it went dark)
  Server has accepted from it:  4,118 writes, contiguous through 2026-03-05T09:14

  The device-reported figure is a floor, not an estimate. The true number is
  unknown and is almost certainly larger. Retiring this device writes off
  whatever it holds, permanently.
```

The lower bound is device-reported; the working figure is derived from the *location's own trading
history*, which the server has and the dark device cannot contradict. Both are recorded in
`retired_pending_writes` (the acknowledged figure) and on the close-record exclusion.

#### Quarantine — and it holds tenant business data, so it lives in `app`

**Assume we got the above wrong anyway.** A write arriving from a device below the minimum served
contract, or in a shape the server does not recognise, is **never dropped**.

The first draft put this table in `platform`, with `payload jsonb -- the raw write, exactly as
sent`. That is a **cross-tenant leak waiting on the one code path that only ever runs after
something has already gone wrong** — i.e. the path least likely to have a test. A quarantined sale
payload contains customer identity, line prices and credit terms. In `platform` it is not emitted by
the §1.3 registry, RLS does not cover it (§1.3 Layer 2 protects `app`), and the two-tenant read-path
fixture does not touch it. One missing `WHERE tenant_id = …` in the ops console's quarantine queue
shows tenant A's sales to tenant B's administrator — the leak class `ADR-0005` calls unrecoverable.

**Quarantine is tenant-owned data.** It is declared in the registry like everything else:

```sql
-- app.stranded_write — emitted by the §1.3 registry. tenant_id leads. RLS on.
create table app.stranded_write (
  tenant_id        uuid not null references platform.tenant (id),
  id               uuid not null,
  device_id        uuid not null,
  received_at      timestamptz not null default transaction_timestamp(),
  client_version   text,
  contract_version int,
  reason           text not null check (reason in (
                     'below_min_contract',    -- device predates the served floor
                     'unknown_table',         -- contract drift: Rule 9.3-B was broken
                     'unknown_column',        -- contract drift: Rule 9.3-B was broken
                     'revoked_device')),      -- §9.9 lost_or_stolen; a SECURITY hold
  payload          jsonb not null,            -- the raw write, exactly as sent
  original_write_id uuid,                     -- the device's write_log id, for replay (below)
  resolution       text check (resolution in ('replayed','discarded','pending')),
  resolved_by      uuid, resolved_at timestamptz, resolution_note text,
  primary key (tenant_id, id)
);
-- RLS enable + force + tenant_isolation policy, emitted by the registry.
-- In the two-tenant isolation fixture (CLAUDE.md §3 acceptance 5) like every other app table.
```

Platform operators who need a cross-tenant view of quarantine health get **counts, never payloads**,
through an aggregate view (`platform.stranded_write_rollup`: tenant, reason, count, oldest). The
payload is visible only inside the tenant, to a role the tenant granted.

**The scoreboard claim, corrected.** The size of the *contract-drift* reasons —
`unknown_table` and `unknown_column` — is the honest scoreboard for whether this discipline is being
followed, and it should be zero. `below_min_contract` is **not** a discipline failure: a device
returning after 200 days is outside Rule 9.3-A's 180-day floor and stranding it is the rule working
as designed. `revoked_device` is a security hold and belongs to a different process entirely. The
§9.4 alert text says which of the three it is, because a page labelled "rule violation" that is
routinely not a rule violation is a page people learn to dismiss.

#### Replaying a quarantined write, which is not "by hand"

"Replayed by hand" is not a design, and the obvious implementation re-dates the sale. Three weeks
later an operator replays a stranded sale through an admin path; §2's business-date rule clamps
`device_wall_clock` to `[device_session.last_authenticated_at, server_received_at]`; evaluated
against the **operator's** session that clamp lands on today. The sale posts to today's business
date, into a cash session that does not exist for that till, and into the earliest open period. The
receipt says 2 March; the books say 23 March; the cash-up for both days is wrong.

> **Requirement 9.3-G — replay is an ingest through the normal write path.**
> A quarantined write is discharged by re-submitting it as a **server-originated mutation**
> (§3.11.7), never by an ad-hoc admin insert:
> - `origin = 'SERVER'`, platform system actor, server node id for HLC generation;
> - `write_id = uuidv5(ns, 'replay:' || original_write_id)` — **deterministic**, so a double replay
>   is a no-op by §3.11.3's rule rather than a duplicate sale;
> - the **original** `claimed_hlc` and `device_wall_at` preserved verbatim as evidence, never
>   restamped;
> - the business-date clamp evaluated against the **original device session**, not the operator's;
> - `is_late_arrival = true` (§5), so it appears on the late-arrivals report at the next close;
> - the resolving human, the reason and the timestamp recorded on the `stranded_write` row.
>
> If the original session cannot be reconstructed — the device was wiped, the session record is
> past retention — replay is **refused**, and the correct remedy is a dated manual correcting
> document prepared by Accounts. "We put it in and hoped" is not one of the options.

`CLAUDE.md` §2.2 says a sale must never be silently lost; a stranded device is the most likely way
to lose one, so this table and this replay path are the direct implementation of that promise, not a
nicety.

### 9.3.5 One schema, every tenant

`ADR-0005` bought cheap operations and one migration run. The bill arrives here: **there is no
blast-radius containment.** A migration that locks a table locks it for every tenant. A migration
that corrupts data corrupts it for every tenant. There is no "roll out to 5% of customers".

Four mitigations, one of which is a genuine limitation to be stated rather than solved.

1. **You cannot canary a shared-schema DDL change. Accept it and move the risk — but be honest
   about where it moves to.** The DDL itself must be *provably* safe — additive, lock-bounded,
   reversible by a drop. Risk moves into the **application layer**, and the first draft claimed that
   layer "*is* canaryable through the release rings". **That claim was overstated and is corrected
   below**; what is canaryable is client builds and flag-gated server behaviour, not the deployed
   server version.
2. **Backfills are per-tenant and paced** (§9.3.2), so the data-transformation half — where logic
   bugs actually live — *is* genuinely canaryable. A **designated** canary tenant, recorded on the
   migration, verified, then the rest. Not a named tenant in platform logic (`ADR-0006`).
   **This is the strongest containment we actually have**, and with mitigation 1 corrected it is
   carrying more weight than the first draft gave it credit for.
3. **Every migration is rehearsed against a restored production clone** before it touches
   production. Deliberately, this is the *same* `scratch` environment the restore drill creates
   (§9.5), under §9.2's `scratch` rules. Two controls sharing one setup means neither one gets
   quietly dropped from the schedule. Rehearsal records the wall-clock duration of every DDL
   statement, and any statement exceeding one second on production-shaped data goes back for
   redesign.
4. **Contractions get a fresh verified backup taken immediately before**, and a maintenance window.
5. **Sync-rule deploys are separated from DDL and batched** (Rule 9.3-D) — because on the fleet
   side, the rule deploy *is* the change with the blast radius.

> **Correction — server releases are not ringed, and §9.3.5 must not lean on pretending they are.**
>
> §9.7.2's table was headed "client **and server** releases move through rings". One shared cluster,
> one API deployment and one sync service cannot serve build N to ring 1 and N−1 to ring 3 without
> per-device routing keyed on ring — a mechanism that appears nowhere in this document, and §9.1
> explicitly pins the sync service as a whole. So:
>
> - **The deployed server version is all-or-nothing.** Every tenant, every device, at once. There is
>   no server canary and this section will not claim one.
> - **What is ringed is (a) client builds** — genuinely, via Requirement 9.7-A's pinning — **and
>   (b) server *behaviour* behind flags** evaluated from the requesting device's ring
>   (`app.location.release_ring`, resolved from the verified session, never from the payload).
> - **A behaviour flag re-imposes Rule 9.3-B's discipline on the server**, and that is the cost of
>   having any server canary at all: one deployed build must contain **both** behaviours and be
>   correct under either, for the whole ramp. A flag is not a way to ship a half-finished change; it
>   is a way to make one finished change reversible without a redeploy.
> - **Flags are removed once ramped.** A flag left in place past its ramp is a second code path
>   nobody tests, which is a worse position than not having canaried.
>
> The practical consequence for §9.3.5: mitigation 1 buys less than the first draft implied.
> **Mitigations 2 and 3 — per-tenant backfills and clone rehearsal — are the containment.**

**On maintenance windows — a payoff worth naming, and a constraint that surfaces at tenant #2.**
Because every location trades fully offline, we have something most systems do not: **a real
maintenance window that costs nothing at the counter.** Sync pauses; sales continue; the queue
drains afterwards. All the complexity of offline-first buys this, and it should be spent
deliberately: **contractions and sync-rule deploys are scheduled inside that window, announced, and
never run when the person who wrote the migration is unavailable.**

But the window is **derived, not chosen**, and the first draft derived it from one jurisdiction —
"Ghana is UTC+0 … a 21:00 GMT window is 22:00 CET … completely invisible to the business". That
holds for one tenant. **Contractions and rule deploys are platform-wide by construction, and there
is no hour that is closed everywhere.** So:

> **Rule 9.3-H — the maintenance window is computed from the fleet, not from Ghana.**
> The window is the largest interval in the week that lies outside the union of every active
> tenant's `location_sync_expectation` trading hours, converted to UTC from each location's own
> timezone. It is recomputed whenever a tenant or location is added, and **onboarding surfaces a
> warning when a prospective tenant's trading hours would shrink the window below two hours** —
> which is the moment to have the conversation, not the night of tenant #2's first contraction.
> When no common window exists, contraction schedules become **per-tenant-announced with a
> per-tenant sync pause**, and the operator's night gets longer. Say so at sale, not at 21:00.

For tenant #1 alone the computed window is 21:00–23:00 UTC (outlets close 18:00–19:00 Africa/Accra,
which is UTC+0), which is 22:00–00:00 CET for a European-based operator: late, not nocturnal.

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
compares observed sync behaviour against a declared expectation, so that *silence* raises an alert.
The expectation is tenant-owned configuration containing a tenant staff member's contact details, so
it lives in `app` under RLS with everything else, not in `platform`:

```sql
-- app.location_sync_expectation — emitted by the §1.3 registry, RLS on, tenant_id leading.
create table app.location_sync_expectation (
  tenant_id        uuid not null references platform.tenant (id),
  location_id      uuid not null,
  trading_days     int[] not null,        -- ISO weekday numbers; a closed Sunday is not an outage
  trading_open     time not null,
  trading_close    time not null,
  timezone         text not null,         -- 'Africa/Accra' for tenant #1; per location
  expected_gap_p90 interval,              -- learned: rolling 28-day p90 of inter-sync gap
  alert_after      interval not null,     -- greatest(expected_gap_p90 * 3, '4 hours')
  alert_after_max  interval not null,     -- TENANT-SET CEILING. see the drift trap below.
  ops_contact_channel text not null,      -- 'sms' | 'email' | 'whatsapp' | 'webhook' — tenant config
  ops_contact_address text not null,      -- the address for that channel
  primary key (tenant_id, location_id)
);
```

Thresholds are **per-location and learned, not global**. A micro-outlet that syncs twice a day is
healthy; the Techiman flagship going two hours without a sync at 11:00 on a Tuesday is not. A
single platform-wide threshold would either page constantly for the micro-outlets or never fire for
the flagship.

**Two holes in that design as first drafted, both of which hide the exact failure it exists to
catch.**

> **(a) The expectation is per location; the harm accrues per device queue.**
> The flagship has four tills. Till 3's queue is head-of-line blocked on a poison mutation
> (§3.3.4). It authenticates and downloads daily, so the *location's* inter-sync gap looks perfect,
> no alert fires, and till 3 accumulates a week of sales. Same shape for one of three micro-outlet
> tablets left in a drawer while the other two sync fine.
>
> **The evaluator runs per device, and the location expectation supplies the thresholds.** Every
> `active` or `suspended` device in `app.device_sync_state` is evaluated in its location's trading
> window against that location's `alert_after`. The location rollup remains, as a *display*, sorted
> worst-first — but it is not the thing that pages.

> **(b) A gradually degrading location raises its own alarm threshold and the alarm never fires.**
> `alert_after = greatest(expected_gap_p90 * 3, '4 hours')` learns from a rolling 28-day p90. A
> location whose connectivity decays over a month teaches the monitor that decay is normal. There
> was a floor and no ceiling, so the threshold walks away from the failure it is measuring.
>
> Three corrections: **`alert_after_max`**, a tenant-set ceiling that `alert_after` is clamped to;
> **drift is its own signal** — `expected_gap_p90` rising more than 50 % over 28 days raises a
> business-hours ticket to the tenant even while every individual sync is inside threshold, because
> "this outlet is getting worse" is actionable before "this outlet is dark" is; and the learned
> baseline is **frozen during and for 7 days after any incident**, so an outage does not train the
> monitor to tolerate outages.

> **(c) "Connected but not draining" is its own paging signal, and it did not exist.**
> The nightmare has two shapes and the first draft only monitored one. A device that is *dark*
> stops producing telemetry. A device that is *connected and stuck* produces perfect telemetry — it
> authenticates, it downloads, `last_seen_at` is fresh — while nothing goes up. This is the poison
> mutation, the exhausted quota, the client bug that fails on upload only.
>
> ```
> PAGE when, for any active/suspended device, during its location's trading hours:
>     last_seen_at        is fresh (within alert_after)
> AND ( last_queue_empty_at is older than alert_after * 2
>       OR last_upload_at    is older than alert_after * 2
>       OR outstanding_estimate has risen on ≥ 3 consecutive handshakes )
> ```
>
> A device that is talking to us and not draining is a *worse* signal than one that is silent,
> because it is losing writes while every dashboard says it is healthy.

**And the alert must route to the tenant, not only to us.** This is the operational insight that
changes the design: **most sync-lag alerts are not resolvable by the platform team.** The cause is
almost always physical — a data bundle ran out, a router is off, the tablet is in a drawer, the
staff member who knows the PIN is on leave. No amount of platform on-call fixes an expired data
bundle in Wenchi. So the alert goes to two places: the platform on-call *and* the tenant's named
operations contact, over **the channel that tenant configured** — `(channel, address)`, per
§3.11.10 finding 22, which already ruled that notification channel is tenant configuration.
Tenant #1's configured value is SMS, because SMS is what reliably arrives in Ghana; that is a
tenant's answer, not the platform's. Plus a persistent tile on the HQ dashboard showing every
location and time-since-last-sync, sorted worst-first, which is the screen the head of operations
should have open.

### The signal table

| Signal | Source | Threshold | Pages? |
|---|---|---|---|
| **Replication slot lag / WAL disk** | Postgres `pg_replication_slots`, disk metric | Lag > 2 GB or disk > 70% | **Yes, hardest.** If the sync service stops consuming the slot, WAL accumulates until the primary fills its disk and *the entire platform stops*. This is the classic managed-Postgres-plus-CDC outage and it kills everyone at once. |
| **Sync service down / uploads failing platform-wide** | Health check + upload success rate | Any 5-minute window with < 90% upload success across ≥ 3 tenants | **Yes.** |
| **Database unavailable** | Connection probe from outside the VPC | 2 consecutive failures | **Yes.** |
| **Sync lag per *device*** | `app.device_sync_state` evaluated against its location's `app.location_sync_expectation` | `alert_after` (clamped to `alert_after_max`) exceeded during that location's trading hours | **During trading hours only**, to tenant ops + platform on-call. Not at 03:00 — the outlet is closed and waking someone teaches them to ignore the pager. |
| **Connected but not draining** | `last_seen_at` fresh while `last_queue_empty_at` / `last_upload_at` stale, or `outstanding_estimate` rising | See §9.4(c) | **Yes, during trading hours.** The failure that looks healthiest. |
| **Sync-expectation drift** | `expected_gap_p90` trend | +50 % over 28 days | No — business-hours ticket to the tenant. Catches the outlet that is getting worse before it is dark. |
| **Lost-write reconciliation** | Each device's local write-log count vs. `app.device_write_watermark.applied_count` | **Any unexplained discrepancy** | **Yes.** This is pilot success criterion 1 (§9.7.1) promoted to a **standing daily control** rather than a pilot-only check. It is the only signal that directly measures `CLAUDE.md` §2.2, and it silently stopped at the end of the pilot in the first draft. It runs forever, for every tenant. |
| **Human review queue** | `conflict_review`, **excluding items in an auto-resolving class that has not yet reached its deadline** | **Oldest non-auto-resolving item > 1 business day** (primary), depth > 25 (secondary) | Business hours. Age matters more than depth: 40 items from this morning is a busy day, one item from nine days ago is a divergence nobody is looking at. **The exclusion matters**: §3's conflict class #7 deliberately sits up to 14 days before `lww_after(n)` fires, so a flat "oldest > 1 day" threshold would be permanently dominated by items ageing *by design* and the metric would be ignored within a fortnight. §3 gave the hook — `auto_resolved` is a distinct status "so the metric stays honest" — and this is where it gets used. Auto-resolving items get their own gauge: count, and how many auto-resolved without a human ever looking. |
| **Failed sync attempts by reason** | Sync service, categorised: `auth_expired`, `device_revoked`, `below_min_contract`, `conflict_rejected`, `payload_too_large`, `network_timeout` | Rate-of-change per reason per tenant | `below_min_contract` > 0 pages, **labelled "a device has been stranded", not "a rule was violated"** — a device returning after 200 days is stranded *within* Rule 9.3-A's 180-day floor, which is the rule working. The page exists because a stranded device needs a human either way; mislabelling it as a violation is how the page gets dismissed. `unknown_table` / `unknown_column` in `app.stranded_write` **are** discipline failures and are labelled as such. Others are dashboards + business-hours tickets. |
| **Client version spread and contract drainage** | `app.device.client_version`, `contract_version`, `contract_version_since` × `app.device_sync_state.last_queue_empty_at` | No threshold — it is a gauge | No. But it is the input to the contraction gate (§9.3.4) and to ring progression (§9.7.2), so it must be accurate, not merely present. The gauge shows **upgraded-and-drained**, **upgraded-not-drained** and **not-upgraded** as three separate populations, because the middle one is invisible on a version histogram and is the one that strands writes. |
| **`scratch` lifetime** | `platform.restore_drill.scratch_destroyed_at` | Any `scratch` cluster alive > 72 h | **Yes.** A full copy of every tenant's books left running because a drill was interrupted (§9.2). |
| **Per-tenant query cost** | `pg_stat_statements` + tagged statements | One tenant > 40% of total DB time over 15 min | Business hours. Noisy neighbours (`ADR-0005`). |
| **Bytes per outlet per day** | `app.device.bytes_up/down_28d` | Above the §9.6 budget | No, but it is visible to the tenant, because they pay for it. |
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

**RTO, redefined — because the first draft's number measured the easy half.** "4 hours for a
full-cluster restore" is the time to get bytes back into a database. It is not the time until the
business is trading normally on synced data, and the gap between the two is where every step in
§9.5's expanded runbook lives. So there are two numbers and both are published:

| | Target | What it means |
|---|---|---|
| **RTO-server** | **4 hours** | Decision → cluster restored, catalogue assertion green, trial balance verified. |
| **RTO-fleet** | **Measured, not targeted, until the drill has measured it** | Decision → **every location's counter trading normally against synced data**: replication slot re-created, sync service re-initialised, buckets rebuilt, sequence counters fast-forwarded, fleet re-uploaded and re-downloaded, conflict storm worked. |

RTO-fleet is the number the business experiences. It is announced to tenants during an incident and
it includes a metered-data cost they pay (§9.6, ≤ 30 MB per device for a full re-sync). Both are
measured by the drill, not asserted.

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
the restore runbook — but it is **step 6 of 8, not step 1 of 3**. The first draft's three-step
recipe (invalidate checkpoints → devices replay → idempotency keys dedupe) is correct as far as it
goes and omits the three server-side artefacts that actually break during a PITR. The full runbook
is in "The restore runbook" below.

The three-step core, stated once because it is the part that works:

1. Invalidate every device's sync checkpoint to a point *before* the restore target.
2. Devices replay their local write log from that point.
3. **Idempotency keys deduplicate the replay** (`CLAUDE.md` §2.2). This is precisely what they are
   for. A system without them cannot safely restore.

Which imposes a client requirement: **devices retain their local write log for at least the backup
retention window plus a margin — 35 days — rather than pruning on acknowledgement.**

**The cost, with the arithmetic rather than "trivial".** The first draft said "tens of megabytes"
and left it there, against §3's carefully derived 15 MB micro-outlet / 60 MB flagship device budget
and §8.10's binding storage limit. One flagship till:

```
~200 receipts/day/till + stock movements, cash sessions, credit ops   ≈ 250 mutations/day
a 3-line sale mutation: header + 3 lines + 3 tax rows + 1 tender
   at §3's ~250 B/row canonical JSON                                  ≈ 2 KB
250 × 2 KB                                                            ≈ 500 KB/day
× 35 days                                                             ≈ 17.5 MB uncompressed
                                                                      ≈ 5–6 MB at 3× compression
```

So it is **~10 % of the 60 MB flagship budget compressed, ~30 % uncompressed** — not trivial, not
alarming, and it must be **counted inside §8.10's device budget rather than added on top of it**.
The retained log is stored compressed. `sync-architect` and `frontend-engineer` own the
implementation; the requirement is operational and it must exist before the pilot, not after the
first restore.

**And a retained log is only a restore backstop if it cannot be evicted.** PWA origin storage is
evictable — §3's conflict class #14 exists because OPFS eviction actually happens. §8 already makes
this a hard gate: `navigator.storage.persist()` must have been granted, and **a device that is not
installed and not persisted may browse but must not take a sale**. §9 adopts that gate rather than
restating it, and adds one operational consequence: **persistence status is reported at every
handshake and a device whose persistence has been revoked is treated as a liveness incident**, not a
warning, because from that moment its write log is a belief.

> **The blind spot, named because nothing here closes it.** A device whose storage is evicted looks
> **caught up** to §9.3.4's contraction gate — it truthfully reports an empty queue, because the
> queue is gone — and produces **no `stranded_write` row**, because quarantine catches writes that
> arrive, not writes destroyed in place. The `device_write_watermark.applied_count` reconciliation
> in §9.4 is the only control that would notice, and it notices *after* the loss. This is the
> residual risk that the persistence gate exists to make rare, and it is why the gate is a hard
> block rather than a nag.

### The restore runbook — eight steps, and three of them were missing

The first draft's runbook restored the database and re-uploaded from devices. Between those two
things sit three server-side artefacts that a PITR breaks, none of which were mentioned, and one of
which produces duplicate statutory invoice numbers.

```
  0. DECIDE. Start the stopwatch. Record wall-clock time and the restore target.
     Announce a sync pause to every tenant. Counters keep trading offline — that is
     the whole point of this architecture and this is the moment it pays.

  1. RESTORE the cluster to time T. (This is the step the old runbook had.)

  2. RE-CREATE THE LOGICAL REPLICATION SLOT.                        ← was missing
     PITR produces a NEW TIMELINE. The slot the sync service consumes does not
     survive it. Worse: the sync service's own bucket and checkpoint store is now
     AHEAD of the database, holding operations at LSNs that no longer exist. It
     must be treated as corrupt, not as stale.

  3. RE-INITIALISE THE SYNC SERVICE and REBUILD BUCKETS.            ← was missing
     Stop the sync service. Discard its checkpoint store. Re-create the slot,
     replay from the restored WAL position, rebuild every bucket from scratch.
     THIS IS A FLEET-WIDE RE-DOWNLOAD — §3.11.8 calls it "an outage, not a deploy"
     and §9.6 budgets it at <= 30 MB per device. It is inside RTO-fleet, it is
     NOT inside RTO-server, and its metered cost is announced to tenants BEFORE
     traffic resumes, not billed to them silently afterwards.

  4. FAST-FORWARD THE SEQUENCE COUNTERS. BEFORE ACCEPTING ANY WRITE. ← was missing
     app.sequence_block (§3.7.5, canonical per §4.3) allocates receipt and
     VAT-invoice blocks under a row lock on a per-(tenant, location, sequence_key)
     counter. Restoring to T-2h REWINDS THAT COUNTER. Blocks allocated after T-2h
     were consumed and PRINTED ON PAPER, and the server has forgotten them — so it
     will re-issue the identical range to another device. §3's conflict class #14
     only rejects a DEVICE regressing consumed_upto; nothing detects the SERVER
     regressing, because until now nothing could make it regress.

     The result if this step is skipped is DUPLICATE STATUTORY INVOICE NUMBERS
     ACROSS TWO LOCATIONS, discovered at a VAT audit. There is no recovery.

     For every (tenant, location, sequence_key):
       a. Collect the maximum consumed_upto that ANY device reports, including
          devices that have not yet reconnected — poll them during step 6 and
          hold the counter open until every active device has reported or been
          retired under Rule 9.3-F.
       b. Fast-forward the counter past that maximum.
       c. BURN THE OVERLAP: mark the range [restored_counter, max_reported] as
          never-reissuable, and record it as an explicit reported gap. §3.7.5
          already commits to reporting gaps precisely; this is a reported gap
          with a known cause.
       d. Raise a severity-1 review item per burned range, naming it, so the
          auditor's question has a written answer before the auditor asks.

  5. VERIFY THE BOOKS before letting anything write. §1.3 catalogue assertion,
     then the trial-balance comparison of the drill's step 5 — FOR EVERY ACTIVE
     TENANT, not just one.

  6. FORCED RE-UPLOAD WINDOW. Invalidate device checkpoints to before T; devices
     replay their local write log; idempotency keys dedupe. STAGGERED BY RING
     (Rule 9.1-B) so the fleet does not arrive at once.

  7. WORK THE CONFLICT STORM, which is expected and must not be mistaken for a
     new incident. See below.

  8. RESUME. Stop the stopwatch at "every location's counter trading normally on
     synced data" — that is RTO-fleet. Publish both numbers.
```

> **A restore triggers a conflict-review storm, and §9.4's alarm will fire immediately.**
> On replay the server stamps **new** HLCs at ingest (§3.4.1), so `row_hlc` values differ from what
> devices hold. Every outstanding CAS mutation carrying a `base_row_hlc` from the forgotten window
> mismatches, and arrives as a conflict. §3's per-`(entity, field_path)` coalescing and per-reviewer
> ceiling (§3.11.10 #21) make the volume survivable, but §9.4's "oldest item age > 1 business day"
> alarm will fire the moment the window opens.
>
> **So the runbook says so, and the queue is annotated rather than suppressed.** Items created
> during a replay window carry `origin_incident_id`; the §9.4 alarm excludes them for the duration
> of the window plus 2 business days; they are worked as their own batch with their own owner. They
> are **not** auto-resolved and **not** hidden — a restore is exactly when a real divergence is most
> likely, and the reviewer must be able to see the storm and the real conflicts in the same list,
> distinguished by label.

### Per-tenant recovery on a shared schema

**A single tenant cannot be restored in place.** PITR restores a cluster; rewinding one tenant would
require rewinding all of them. So the "customer deleted a year of stock adjustments" case has this
path, and it is slow and manual:

restore to `scratch` at time T (under §9.2's `scratch` rules — named human, time-boxed grant,
full statement logging) → run the §1.7 export machinery for that tenant alone → selectively
re-import the affected tables **through the normal server write path** with deterministic
`write_id`s per §3.11.7, never as raw `platform_admin` inserts → verify against the tenant's own
trial balance → destroy `scratch` and record `scratch_destroyed_at`.

The `platform_admin` RLS-bypass in the export half is the single place in the platform where the
tenant boundary is deliberately off. It is statement-logged in full, it is time-boxed, and the
import half does not use it — because an import that bypasses the write path reproduces exactly the
`row_hlc`/`write_log` defect §9.3.2 spends a page on.

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
2. Restore to a fresh `scratch` cluster, under §9.2's `scratch` rules. Start the
   stopwatch at the decision, not at the first command: the clock the business cares
   about includes finding the runbook.
3. Run the §1.3 catalogue assertion against the restored schema.
4. Compare every registry table, per tenant, against THE DIGEST JOB'S RECORDED
   OUTPUT for the nearest digest at or before the restore timestamp (see below).
   Row count and digest. Not "the values recorded at the restore timestamp" —
   nothing was recording them.
5. THE REAL CHECK: for EVERY ACTIVE TENANT, compute the trial balance from the
   restored cluster and compare it, TO THE MINOR UNIT OF THAT TENANT'S OWN
   JURISDICTION PACK, against the same trial balance computed from production as
   at the same timestamp. A restore that completes but produces different books
   has failed.
6. Exercise runbook steps 2, 3 and 4 above — slot re-creation, sync-service
   re-initialisation, sequence-counter fast-forward — against `scratch` with the
   staging device fleet pointed at it. A drill that skips these has not drilled
   the half of the runbook that was missing until now.
7. Rehearse the next pending migration against it (§9.3.5).
8. Record BOTH RTO numbers in platform.restore_drill. Publish them.
9. Destroy `scratch`, and record `scratch_destroyed_at`.
```

Step 5 is the one that separates this from theatre. Steps 1–4 prove the bytes came back; only step 5
proves the *books* came back, and the books are the product.

**Steps 4 and 5 were not executable as first written, and the fix is a job that has to exist.**

Step 5 *is* computable as-of, because the GL is append-only — a trial balance as at T is a query.
That half worked. **Step 4 did not.** Production is mutable: `credit_account.credit_limit_minor`,
`stock_balance_current` and `customer` are updated in place, so there is no as-of-T query for them,
and nothing in the design was recording digests continuously. There was nothing to compare against.

> **Requirement 9.5-A — the continuous digest job.** A scheduled job records, **per tenant, per
> registry table**: row count, a digest over the primary keys, and a digest over the full row image
> for mutable tables. Hourly for tables in the money and credit path, daily for the rest. Output
> goes to `app.table_digest (tenant_id, table_name, as_of, row_count, pk_digest, row_digest)` —
> and, critically, **it is inside the backup**, so a restored cluster carries its own history of
> what it used to contain. Without this, step 4 is a sentence.
>
> It pays for itself twice: it is also the cheapest continuous detector of silent corruption, and
> the input to the per-tenant export reconciliation in §1.7.

Step 5's earlier wording named tenant #1 and said "to the pesewa". Both are single-tenant
reasoning. Once tenant #2 is live, **the only control that verifies books would never have verified
theirs**; and "pesewa" makes a platform control speak one jurisdiction's minor unit, which
`CLAUDE.md` §2.5 makes a pack value. Every active tenant, in that tenant's own minor unit.

```sql
create table platform.restore_drill (
  id uuid primary key,
  ran_at timestamptz not null,
  operator text not null,
  restore_target timestamptz not null,     -- the PITR timestamp chosen
  rto_server_seconds int not null,         -- decision → books verified, wall clock
  rto_fleet_seconds  int,                  -- decision → fleet trading on synced data
  catalogue_assertion_passed boolean not null,
  digests_matched boolean not null,        -- step 4, against app.table_digest
  trial_balance_matched_tenants uuid[] not null,   -- every active tenant, not one
  trial_balance_failed_tenants  uuid[] not null,
  slot_and_sync_reinit_exercised boolean not null, -- step 6
  sequence_fastforward_exercised boolean not null, -- step 6
  scratch_destroyed_at timestamptz,        -- §9.2. NOT the last line of a runbook.
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
- **Sync-rule deployments are change-managed events with a published per-tenant byte estimate —
  this is Rule 9.3-D, not a preference.** §3.11.8 and §3's C2 record that the rules are one global
  document whose deploy rebuilds affected buckets fleet-wide. A routine-looking config change is
  therefore a metered-data event across every device of every tenant, it is the **unit of blast
  radius** for a migration (not the DDL), it is batched into the maintenance window computed by
  Rule 9.3-H, and its revert is tested on staging before the forward deploy. C2 measures the actual
  multiplier; Rule 9.3-D is binding regardless of what the measurement says, because even a cheap
  rebuild is a scheduled fleet event rather than a config push.
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

**The scheduling collision this section was written to avoid has already happened, and the plan
must be re-based rather than left as a recommendation about a date in the past.**

The first draft recommended "a dry-run window of 2–4 weeks before trading opens", against a
Techiman flagship opening of **1 August 2026**. That date has passed. This document is still in
Phase 0 and no software exists, so the honest position is:

- **The outlet opened on schedule. The ERP did not, and could not — Phase 0 is not approved.**
- **None of the ten Stage 1 clocks below have started, and none can.** Every one of them measures
  the behaviour of a running system at a trading location. There is no running system.
- **The outlet is trading today on whatever it is trading on** — paper, spreadsheets, or the
  incumbent process. That is a fact for `product-manager` to record, not an engineering variable,
  and it changes the pilot in one important way: **go-live is now a cut-over, not an opening.**

A cut-over is in some ways *easier* than the collision the first draft feared — the staff already
know how to run the outlet, so a defect no longer hides behind a learning curve, which was the
whole objection. It is harder in one way the first draft did not consider: **there are now opening
balances and an in-flight trading history to migrate** (`open-questions.md` Q20), and a cut-over
with wrong opening balances is worse than a launch with none.

**Re-based Stage 1 plan.** The pilot window is defined relative to the phase gate, not to a
calendar date that has expired:

| | |
|---|---|
| **T₀** | Phase 0 architecture document approved. |
| **T₀ + build** | Phase 1 built and Stage 0's preconditions all green, including Q20's opening balances prepared and signed. |
| **T₁ = go-live decision** | A **2–4 week parallel-run window** — the ERP runs alongside the outlet's current process, real catalogue, real prices, real hardware, real customers, cash-up reconciled against *both* every evening. Not synthetic customers; a parallel run is strictly better evidence than a dry run and is available precisely because the outlet is already trading. |
| **T₂ = cut-over** | The current process stops being the record. **The 14-day success clocks below start here**, and not before. |

The parallel run replaces the dry run and is a strict improvement. The 2–4 week window and the
requirement that clocks start at cut-over are unchanged in substance. See C1, and
`open-questions.md` Q12, which needs re-basing to match.

**Stage 1 success criteria — the gate before any second location.**

Objective, measurable, time-bound, and checked by a named human at a scheduled review. Not
inferred from a dashboard, because a dashboard can be green for the wrong reason.

1. **Zero lost writes over 14 consecutive trading days.** Every sale written on a device appears
   exactly once server-side. Measured by daily reconciliation of each device's local write-log
   count against `app.device_write_watermark.applied_count`. Zero unexplained discrepancies — not
   "a few we think we understand". **This control does not stop at the end of the pilot.** It is
   the only signal that directly measures `CLAUDE.md` §2.2, and it is promoted to a standing §9.4
   daily signal for every tenant, forever. The first draft let it lapse silently at the end of this
   list, which would have retired the platform's single most important detector on the day the
   platform started carrying real volume.
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

**Client releases move through rings.** Server releases do not — see §9.3.5's correction: one
cluster, one API deployment, one sync service, deployed all-or-nothing. What a ring can gate on the
server side is **flag-evaluated behaviour**, resolved from the requesting device's location ring.
The first draft's table said "client **and server** releases move through rings" and no mechanism
existed for the second half.

**Rings are per-location, tenant-set values, not a platform taxonomy.** The first draft's table was
tenant #1's org chart — "Ring 1 Techiman flagship · Ring 2 RDCs (Sunyani, Tamale, Kumasi) · Ring 3
Micro-outlets" — presented as platform logic. Tenant #2 has no RDCs. `ADR-0006` and `CLAUDE.md` §2.9
forbid exactly this. So:

```sql
-- app.location.release_ring smallint not null default <the tenant's rearmost ring>
-- app.tenant_release_ring (tenant_id, ring, label, soak_interval, is_canary)
```

The **platform** defines only the mechanics: rings are ordered, ring 0 is always the staging fixture
fleet plus platform-held devices, a build enters ring *n+1* only after soaking in ring *n*, and a
ring cannot advance while any device in a lower ring has an unresolved P1 or P2, a rising
`failed_sync` rate, or an unresolved `app.stranded_write` row.

**Tenant #1's configured rings**, which are template seed data (`ADR-0006`) and ordinary editable
rows thereafter:

| Ring | Tenant #1's population | Soak before advancing |
|---|---|---|
| **0** | Staging fixture devices + 2 devices at HQ | 24 h |
| **1** | Techiman flagship | **72 trading hours** |
| **2** | RDCs (Sunyani, Tamale, Kumasi, …) | 72 trading hours |
| **3** | Micro-outlets | — (rearmost) |

**Ring 1 is the flagship, deliberately, and that is a real trade.** It is the highest-revenue
location — putting the newest build there first puts the most money nearest the risk. Tenant #1
accepts it for two reasons: the founder and the support team are physically standing there, so a
problem is seen in minutes rather than at month end; and the alternative is worse, because a
micro-outlet with three staff and no technical support discovering a bug alone is the scenario with
no fast feedback path at all. This is the trade the `devops-engineer` brief asks for ("the flagship
stays a release ahead so problems surface where the founder is standing") and it is worth stating
that it costs something rather than pretending it is free. **It is a tenant's trade to make**; a
tenant who wants their smallest outlet as the canary configures that instead.

**Micro-outlets go last** for the same reason: furthest from help, thinnest staffing.

**A new tenant's locations all start at the rearmost ring** — the one that takes a build only after
every other ring has soaked it — never at a canary ring. (The first draft said "ring 2's stable
release" in §9.7.2 and "the current *stable* ring" in §9.2 step 7; those disagreed. **Rearmost ring
governs**, and §9.2 has been corrected to match.) Their pilot is their own; it does not double as
ours.

> **Requirement 9.7-A — PWAs auto-update, and that defeats staged rollout unless we stop it.**
> A service worker's default behaviour is to fetch the newest build. Left alone, every device in
> every ring updates within hours of a deploy and rings become decorative. The client must
> therefore ask a server-controlled `/release` endpoint **which build it should be running** — keyed
> by device id → location → ring → pinned version — and cache that build's content-hashed assets
> rather than whatever is newest. It also needs a **force-update override** for shipping a P1 fix
> immediately. Owned by `frontend-engineer`, built before the second location exists.
>
> **And `/release` must refuse to pin a build that cannot talk to the live server.** This is not an
> ergonomic nicety; it is the control that stops §9.8's Case A rollback from stranding the highest
> revenue location in the middle of an incident. Three parts:
>
> 1. **`/release` rejects any pin request** where the candidate build's
>    `[min_contract, max_contract]` (from `platform.client_release`) does not contain the live
>    `platform.schema_contract.version`. It returns the reason and the acceptable builds.
> 2. **The console displays the contract range beside every candidate build**, and greys out the
>    ones that would quarantine the ring. An on-call engineer at 16:40 on a Friday should not have
>    to remember which contraction shipped three weeks ago.
> 3. **A deploy-time invariant** asserts the same for every version currently pinned in any ring.
>    A server deploy that would raise the contract past a pinned client build **fails the deploy**
>    rather than silently stranding a ring — which is the same failure as the rollback case,
>    arriving from the other direction.

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

1. **Pick the rollback target from the console's list of *eligible* builds.** The console shows each
   build's `[min_contract, max_contract]` next to it and greys out any build that cannot talk to the
   live server contract. Do not type a version from memory.
2. Set the affected ring's pinned version back to that build (Requirement 9.7-A). `/release` will
   refuse a build outside the served contract range; if it refuses, **that is the control working**
   — the build you remember as good predates a contraction and pinning it would quarantine the ring.
   Roll forward to the newest eligible build below the bad one instead.
3. Force service-worker update; devices reload on next launch.
4. The local database is untouched, **and confirm this rather than assume it**: the target build's
   contract range covers the live contract, which is what step 1 checked. Rule 9.3-B guarantees the
   *bad release itself* did not change the schema; it says nothing about whether the **target** of
   the rollback predates some *earlier, separate* contraction. Those are different questions and the
   first draft's step 3 asserted the second from the first.
5. Pending writes survive and upload under the old client. **This is the payoff of Rule 9.3-B**,
   and it is the whole reason the rule has no exceptions.

> **The failure step 1 exists to prevent, because it is not hypothetical.** Contraction 0147 shipped
> three weeks ago; the served contract is V = 12 and the fleet is on build 1.16 (`min_contract` 12).
> Release 1.17 has a P1 at 16:40 on a Friday. On-call pins ring 1 back to 1.15 — the build everyone
> remembers as good — whose `max_contract` is 11. Every device at the flagship is now below the
> served floor, quarantines, and **the highest-revenue location stops syncing during the incident it
> was rolled back to fix.** Under maximum stress, in the one procedure written to require no
> deliberation. The console and the endpoint make that impossible; the runbook step just says so out
> loud.

**Case B — server application release, no DDL. Minutes.**

1. Redeploy the previous API image.
2. **Roll back the sync service only if it is implicated.** It is versioned and deployed
   separately for exactly this reason — rolling it back may re-key buckets and cost a re-sync
   across the fleet (§9.6), so it is not a reflex.
3. Verify uploads resume: `failed_sync` rate by reason returns to baseline.

**Case C — a migration has already been applied. Hours, not minutes.**

1. **Was it an expand step, and has its sync-rule change shipped yet?** These are two questions
   because Rule 9.3-D separates them.
   - *DDL only, rules not yet deployed* — reversible in seconds: stop the projection worker, then
     drop the added object. Nothing in the field has ever seen it.
   - *Rules already deployed* — the drop is a **second fleet-wide bucket rebuild** on top of the
     first. That is a metered-data event for every tenant, not a `DROP TABLE`. Revert the rule
     document to its previous stored version (Rule 9.3-D part 3, whose revert was tested on
     staging), announce the byte cost, run it in the maintenance window, *then* drop the object.
     **A rollback that costs the customer 30 MB per device is a decision, not a reflex** — if the
     added object is inert, leaving it in place until the next scheduled window is usually correct.
2. **Was it a contraction?** You cannot un-drop a column. There is no fast path. The options are:
   restore to `scratch` at a point before the contraction, extract the dropped data, and re-import
   it **through the normal write path** (§9.5); or a full PITR restore with §9.5's eight-step
   runbook, all of it, including the sequence-counter fast-forward.
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

Identifying them requires knowing which rows the bad build wrote, which requires provenance — and
the first draft asked for the wrong mechanism, in the wrong place, on every table.

> **Requirement 9.8-A — build provenance, on the write, not on the row.**
> **Two columns on `app.write_log` (§3.11.3, §4), not two columns on every table in `app`:**
>
> ```sql
> alter table app.write_log
>   add column client_build text,   -- the client build that produced the mutation; null iff origin='SERVER'
>   add column server_build text;   -- the server build that accepted and applied it; always set
> ```
>
> **Why the first draft's version was wrong, since it is instructive.** It proposed
> `written_by_client` / `written_by_server` in §1.3's `tenantTable` base columns, "stamped on insert
> **and update**". Stamped on update, **the second writer erases the first** — so the one query it
> exists to answer is the one it cannot answer. Any row that 1.14.2 wrote badly and 1.14.4 later
> touched now reads `1.14.4`, and the corrupt rows are exactly the ones most likely to have been
> touched again.
>
> **§3 already built the right substrate and §9 was duplicating it.** `app.write_log` is permanent
> (§3.11.3 — only `response_body` and `request_hash` are pruned), already carries every write's
> identity, `origin`, HLC, device, user and op; `app.row_version` (§3.11.5) already holds per-row
> history; and §3.11.3 already requires **every mutation's effect to be keyed by its `write_id`**.
> So "find everything release 1.14.2 touched" is:
>
> ```sql
> select wl.id as write_id, wl.op, wl.hlc, wl.location_id, rv.table_name, rv.row_id
> from   app.write_log wl
> join   app.row_version rv on rv.write_id = wl.id
> where  wl.tenant_id = :tenant
>   and  (wl.client_build = '1.14.2' or wl.server_build = '1.14.2');
> ```
>
> One column on one table instead of two on every table; **append-only, so it cannot be
> overwritten**; and it survives the update case the first draft's version loses. It also answers
> questions the row-stamp could not: which *user* and which *device* were involved, and in what
> order.
>
> Still true from the first draft, and still the reason this is a pre-pilot requirement: **the
> retrofit is worthless by construction.** The writes you need provenance for are the ones recorded
> before the column existed. See C4.

**2. Writes still sitting on devices, made under the old contract.** They upload normally after
rollback, because Rule 9.3-A guarantees the old contract is still served. Nothing special happens.
This is the ordinary, boring, correct case, and it is boring precisely because of the rules.

**3. Writes on devices in a shape only the bad version understood.** This can only exist if Rule
9.3-B was broken. If it happens: they land in `app.stranded_write` (§9.3.4) with reason
`unknown_column`, and are discharged through **Requirement 9.3-G's replay path** once a fixed build
is out — a server-originated mutation with a deterministic `write_id`, the original session's
business-date clamp, the original `claimed_hlc` preserved, and `is_late_arrival` set. **Not "by
hand".** The first draft said "replayed by hand", which is not a design and whose obvious
implementation re-dates the sale to the day the operator clicked the button. They are **never
dropped**. The quarantine table exists for the day the discipline fails, which is the only day it
matters.

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

`app.device.status = 'revoked'` (§2.7, §9.3.4) → the token endpoint refuses that device →
**existing tokens remain valid until they expire.** So revocation is **bounded, not instant**, and
the bound is the token TTL.

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
| `lost_or_stolen` | **Quarantine to `app.stranded_write` with `reason = 'revoked_device'`** for human review. A thief with an unlocked tablet can fabricate sales, and a fabricated sale that flows straight into the ledger is worse than a delayed real one. |

The reason code is required at revocation, and the console asks for it rather than defaulting.

**`revoked_device` is a distinct quarantine reason, and that matters for two reasons.** The first
draft routed security quarantine into the same table with a `reason` enumeration that did not
contain a value for it — so it would have been filed as `below_min_contract` or nothing. Worse, it
would have polluted the scoreboard: §9.3.4's "the contract-drift reasons should be zero" claim and
§9.4's `below_min_contract` page both become meaningless if a stolen tablet's writes land in the
same bucket as a contract failure. **A security hold and a migration failure are different
incidents, worked by different people, with different urgency.** They share a table because the
storage shape is identical; they do not share a reason code, a queue, or an alert.

---

## 9.10 Boundaries with other sections

| Concern | Owner |
|---|---|
| Sync protocol, batching, bucket shapes, re-sync semantics on rule change (Rule 9.1-A, Rule 9.1-B, Rule 9.3-D, §9.6, C2) | `sync-architect` |
| **Versioned, stored sync-rule document with a tested revert** (Rule 9.3-D); isolation fixture run against the rule document | `sync-architect` + `tenant-isolation-test-engineer` |
| `app.device` table (§2.7) — the **one** registry; the four-value lifecycle vocabulary; token TTL and contents; enrolment/revocation mechanics (§9.9, Proposal 9.9-B, C9) | `rbac-security-engineer` — §9.3.4 specifies the operational columns and reason codes I need on it |
| `app.device_sync_state` / `app.device_write_watermark` columns the contraction gate reads: `last_queue_empty_at`, `contiguous_through`, `applied_count` (§9.3.4) | `sync-architect` (§3.11.3, §3.11.4) — §9 consumes these, does not redefine them |
| **Retirement as one action writing both the contraction record and the period-close exclusion** (Rule 9.3-F) | `sync-architect` (§3.11.4) + `ledger-engineer`; the *role* is `open-questions.md` Q19 |
| `app.write_log.client_build` / `server_build` (Requirement 9.8-A) | `sync-architect` (§3.11.3) + `tenant-platform-engineer` |
| **`app.stranded_write` and `app.location_sync_expectation` emitted by the §1.3 registry, RLS on, in the isolation matrix** | `tenant-platform-engineer` + `tenant-isolation-test-engineer` |
| **Requirement 9.5-A — the continuous per-tenant table-digest job** (`app.table_digest`) | `tenant-platform-engineer` + me |
| **Replay of a quarantined write through the normal write path** (Requirement 9.3-G) | `sync-architect` (§3.11.7) + `ledger-engineer` for the `is_late_arrival` posting |
| Service-worker release pinning, the `/release` endpoint, and its **contract-range refusal** (Requirement 9.7-A) | `frontend-engineer` |
| Correction-by-reversing-entry shape for bad-release data (§9.8) | `ledger-engineer` |
| Receipt-printing hardware trial; local-encryption trial; `navigator.storage.persist()` gate reporting (C3, §9.5) | `pos-ux-specialist` + `frontend-engineer` |
| Statutory record retention driving archive policy (§9.5) | `compliance-gatekeeper` |
| Pilot success criteria 1, 2, 4 as executable drills; criterion 1 promoted to a standing daily control (§9.4) | `sync-test-engineer`; criterion 5 with `money-test-engineer` |
| **Rule 9.3-E test for every money-touching backfill** | `money-test-engineer` |
| Ghana data-residency / Act 843 question (C6) | `compliance-gatekeeper` + external counsel |

---

## 9.11 Concerns and open questions

**C1 — *Superseded by events.* The collision has already happened; the pilot plan needed re-basing,
not a recommendation about a past date.** The first draft recommended a 2–4 week dry run "before
trading opens" on 1 August 2026. **That date has passed and Phase 0 is not approved**, so the
recommendation was unactionable as written and has been replaced (§9.7.1).

What is true now, and what `product-manager` must record: the outlet opened; the ERP did not and
could not; **none of the ten Stage 1 clocks have started, and none can, because no system exists at
a trading location**. Go-live is therefore a **cut-over from whatever the outlet is running on
today**, not an opening. §9.7.1's re-based plan replaces the dry run with a **2–4 week parallel
run** — strictly better evidence, and available only because the outlet is already trading — and
starts the 14-day clocks at cut-over, `T₂`, defined relative to the phase gate rather than to a
calendar date.

The cut-over framing removes the original objection (a defect can no longer hide behind a staff
learning curve) and introduces one the first draft did not consider: **there are now opening
balances and an in-flight trading history to migrate**, which is `open-questions.md` Q20 and is
Phase 1 work, not Phase 3. A cut-over onto wrong opening balances is worse than a launch with none.

`NEEDS-HUMAN` — founder, for the cut-over date and for confirming what the outlet is running on in
the meantime. **`open-questions.md` Q12 must be re-based to match; it still reads as though 1 August
2026 is in the future.**

**C2 — The *magnitude* of a sync-rule re-download is unmeasured; the *discipline* no longer waits on
the measurement.** On several offline-sync platforms, changing sync rules rebuilds affected buckets
and clients re-sync them; §3.11.8 records this as an assumed capability with a stated fallback. If it
is true of ours, a config change that looks routine is a metered-data event across every device of
every tenant — and it interacts directly with §9.3.2, where every expand step eventually adds a
table to the rules.

**What changed since the first draft:** this was written as an open question whose answer would
determine whether expansions get batched into windows. That was too permissive. Rule 9.3-D now makes
the rule deploy the **unit of blast radius** unconditionally — separated from its DDL, batched into
the computed maintenance window (Rule 9.3-H), versioned with a tested revert, and published with a
per-tenant byte estimate — because even a *cheap* rebuild is a scheduled fleet event over somebody
else's metered data rather than a config push. C2 now measures the multiplier so the byte estimates
are honest and so §9.6's budgets can be validated; it no longer gates the discipline. **Still must
be measured in Phase 1 before the release cadence is fixed.** Owner: `sync-architect` + me.

**C3 — The PWA cannot use hardware-backed key storage, and that is a real cost of `ADR-0003`.**
Local encryption tops out at a non-extractable Web Crypto key in IndexedDB. Together with the
receipt-printing risk that `ADR-0003` already flags, that is now two material weaknesses in the PWA
choice, and the ADR lists only one. Not proposing we revisit it now — proposing the Phase 1 hardware
trial measure **both**, so the Phase 1 gate makes that call on evidence rather than by default. If
receipt printing also proves unreliable, the two findings together are a much stronger case for
native Android than either alone.

**C4 — Build provenance must exist before the pilot; the *mechanism* has been corrected.** The
urgency was right and the mechanism was not. The first draft asked §1.3 for
`written_by_client` / `written_by_server` on the `tenantTable` base, stamped on insert **and
update** — which loses the answer to its own question, because on update the second writer erases
the first, and the rows that most need provenance are the ones a later build touched again. It also
duplicated machinery §3 had already built.

**Corrected (Requirement 9.8-A): two columns on `app.write_log`, not two on every table.**
`client_build` and `server_build`, append-only, joined to `app.row_version` by `write_id` to answer
"what did 1.14.2 touch". One column on one table, un-overwritable, and it additionally answers
which user and which device were involved.

What has not changed is the urgency: **the retrofit is worthless by construction**, because the
writes you need provenance for are the ones recorded before the columns existed. Owner:
`sync-architect` (the table is §3.11.3's) with `tenant-platform-engineer`.

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

**C7 — Contraction gated on proven drainage means one lost tablet blocks contraction forever, and
the way out of that is a write-off that needs an owner.** The gate is the correct default — the
alternative strands writes — and §9.3.4 has now made it a *drainage* gate rather than a *capability*
gate, which makes it strictly harder to satisfy and therefore makes this question sharper, not
softer. A `suspended` device now blocks too, which is correct and which removes the workaround the
first draft accidentally left open (suspend instead of retire, and the write-off happens with no
record at all).

**§9 no longer proposes its own policy.** §3.11.4 already owns it, and §3 says outright that it is
"one policy and one owner, not two". Rule 9.3-F makes retirement a single action writing both the
contraction record and the period-close exclusion, so a device cannot be retired to unblock a
migration without Accounts seeing the close-record consequence.

**What still needs a human is the same question `open-questions.md` Q19 already asks**, and Q19's
scope must widen: it is currently framed as "who may exclude a dark device from a period close",
and it is in fact "who may retire a device, thereby writing off its unsynced writes **and** excluding
it from close **and** unblocking a contraction" — one act, three consequences. §3 proposes the
Accounts role; §9's first draft proposed a tenant administrator; those are the same disagreement Q19
records, and it must be resolved once. `NEEDS-HUMAN` — founder for tenant #1, then standard
onboarding policy.

**C8 — Two costs I am asserting are small without having priced them.** Quarterly full-cluster
restore drills consume compute for the scratch cluster; alerting to tenant operations contacts
(§9.4) needs a provider and a per-message cost on whichever channel the tenant configures. Both are
almost certainly immaterial next to a week-long sync outage or an untested backup, and I am
proposing we do both regardless — but the numbers should be filled in at the Phase 1 gate rather
than left as an assumption that quietly becomes a reason to skip the drill.

**C9 — One device registry and one lifecycle vocabulary is a cross-section reconciliation, and it
is a Phase 0 exit condition.** Three sections defined three device registries: §2.7's `device` in
the tenant schema (`active | suspended | revoked`), §3.11.4's `app.device_sync_state`
(`active | suspended | retired`), and §9's now-deleted `platform.device` with `revoked_at` and
`retired_at` as separate nullable timestamps, cross-referenced to a §1.9 that is a boundaries table
and not a registry at all. The result was a contraction gate written against a table that does not
exist, with a predicate that silently ignored `suspended`.

§9.3.4 resolves it: **`app.device` (§2.7) is the registry of record**, `app.device_sync_state` and
`app.device_write_watermark` hold liveness and drainage, there is no `platform.device`, and the
lifecycle vocabulary is the four-value union `active | suspended | revoked | retired` — of which
§2.7's set and §3.11.4's set are each a subset, so nothing authoritative is contradicted.

**This is not `NEEDS-HUMAN`; it is a cross-section ruling requiring adoption**, in the same class as
§3.11.9's naming reconciliation and with the same status: **Phase 0 exit condition, not Phase 1
cleanup.** `rbac-security-engineer` adds the operational and contract columns (including
`contract_version_since`, without which the drainage gate cannot be written) to §2.7;
`sync-architect` aligns `enrolment_status` in §3.11.4 as a denormalised copy of `app.device.status`
rather than a second vocabulary. If either owner disagrees with the union, that disagreement must be
resolved before Phase 1 code, because the contraction gate is unwritable until it is.

**C10 — A restore hands the tenant a metered-data bill, and nobody has decided who pays it.**
`NEEDS-HUMAN`, and it is new. §9.5's runbook now states plainly what the first draft omitted: a PITR
invalidates the replication slot, the sync service's bucket store must be rebuilt, and **that is a
fleet-wide re-download** — §9.6 budgets a full re-sync at ≤ 30 MB per device, so a 25-outlet tenant
with ~40 devices is on the order of **1.2 GB of the customer's mobile data**, consumed because *our*
database needed restoring.

The engineering is settled (announce the cost before resuming traffic; stagger by ring). **The
commercial question is not**: does the platform absorb, reimburse, or simply disclose that cost, and
does the answer differ between a provider-caused restore and a tenant-requested one? This belongs in
the commercial terms alongside `open-questions.md` Q14's suspension and offboarding windows, and it
should be decided before the first tenant signs rather than during the first incident. Owner:
founder. **To be promoted to `open-questions.md`.**

---

## 9.12 Revisions from adversarial review

Reviewed 2026-08-22 against §1, §2, §3, §4, §5 and §6. **Six blocking findings, thirteen major,
twelve minor.** Where this subsection and the body above differ, **this subsection governs**.

### 9.12.1 The pattern behind the blocking findings

Five of the six came from one habit, and it is a different habit from the one §3.11.1 diagnosed.
§3 overclaimed. **§9 under-read.**

Every blocking finding except B5 is a case of this section building a mechanism that §3 had already
built, and building it slightly differently:

- The contraction gate invented a capability check when §3.11.4 had already built the **drainage
  attestation** (`last_queue_empty_at`) that answers the actual question (B1).
- Dual-write triggers and batched backfills wrote rows directly when §3.11.7 had already ruled that
  **every server-originated write goes through the write path** with a deterministic `write_id`
  (B3).
- A third `platform.device` registry appeared alongside §2.7's and §3.11.4's, with a third status
  vocabulary and a cross-reference to a section that is a boundaries table (B6).
- Row provenance was requested as new base columns when `app.write_log` + `app.row_version` already
  carried it, and in a form the first draft's own mechanism could not match (M13).
- "Replayed by hand" and "retired by an operator" both re-invented policies §3.11.4 and §3.11.7 had
  already settled, in ways that quietly broke period close and business-date clamping (M3, M4).

The corrective discipline is §4.17.1's, stated from the operational side: **before specifying a
mechanism, find the section that owns the primitive and consume it.** A migration document that
writes rows around the sync layer's write registry is not a migration document; it is a second,
worse sync layer.

The sixth (B5) is a different and more familiar error — putting tenant business data in `platform`
because the *code path* felt like platform code. It is the leak class `ADR-0005` calls unrecoverable,
sitting on the path least likely to be tested.

### 9.12.2 What the review confirmed, recorded once

The core inversion — **downtime is cheap, a stranded device is expensive** — survived, and it
remains the organising principle. So did Rule 9.3-B, the DDL rules (including no Postgres enums in
`app`, for the right reason), the monitoring philosophy that absence of signal is the signal, the
connectivity-economics argument, restore-drill step 5, and §9.9's split of revocation by reason.
Those are unchanged and are not re-argued below.

### 9.12.3 Full disposition

| # | Sev | Finding | Disposition |
|---|---|---|---|
| **B1** | Blocking | Contraction gate proves capability, not drainage | **Accepted.** §9.3.4 rewritten. Gate is now drainage-after-upgrade: `contract_version >= V` **and** `last_queue_empty_at > contract_version_since` **and** watermark corroboration. New column `app.device.contract_version_since`. The eviction blind spot is named rather than papered over. |
| **B2** | Blocking | Rollback can cross the served-contract floor and strand a ring | **Accepted.** Requirement 9.7-A extended: `/release` refuses a pin outside the served range, the console displays and greys ranges, and a deploy-time invariant checks every pinned build. §9.8 Case A step 1 rewritten; the old step 3's non-sequitur removed and replaced with an explicit confirmation. |
| **B3** | Blocking | Trigger dual-write and backfill bypass §3.11.7's write registry | **Accepted, and it was the worst of the six.** §9.3.2 now requires expand-phase projection and backfills to be server-originated mutations with deterministic `write_id`s. A boxed passage explains why a trigger-inserted row breaks the CAS and makes §4.9's credit-limit conflict unadjudicable. Triggers permitted only if they emit the `write_log` row and stamp `row_hlc` in the same statement. |
| **B4** | Blocking | Restore runbook omits slot, sync-service state, sequence counters | **Accepted.** §9.5 now carries an eight-step runbook with slot re-creation, sync-service re-initialisation with the fleet re-sync priced and announced, and a **mandatory sequence-counter fast-forward with overlap burn** before any write is accepted. RTO split into RTO-server (4 h) and RTO-fleet (measured). |
| **B5** | Blocking | `platform.stranded_write` puts tenant payloads outside RLS | **Accepted.** Moved to `app.stranded_write`, registry-emitted, `tenant_id` leading, RLS on, in the two-tenant isolation matrix. `platform.location_sync_expectation` likewise moved to `app` (it holds tenant staff contact details). Platform operators get counts through `platform.stranded_write_rollup`, never payloads. |
| **B6** | Blocking | Three incompatible device registries; gate written against the one that does not exist | **Accepted.** `platform.device` deleted. §2.7's `app.device` is the registry of record; §3.11.4 and §3.11.3 supply liveness and drainage. Four-value lifecycle `active\|suspended\|revoked\|retired` (a superset of both existing sets, so neither is contradicted). **`suspended` explicitly blocks the gate.** §1.9 reference corrected to §2.7. Adoption tracked as C9, a Phase 0 exit condition. |
| **M7** | Major | "Server releases move through rings" asserted, never shown | **Accepted.** Server releases are stated plainly as **all-or-nothing**; only clients are ringed. §9.3.5 mitigation 1 re-derived without the canary claim, and mitigations 2 and 3 (per-tenant backfills, clone rehearsal) named as the actual containment. Flag-gated server *behaviour* keyed on ring is retained as the one real server canary, with the Rule 9.3-B-style cost stated. |
| **M6** | Major | Every expand step is also a sync-rule deploy; blast radius is not the DDL | **Accepted.** New **Rule 9.3-D**: the rule deploy is the unit of blast radius; expansion and rule change never co-ship; rule changes batched into the computed window with per-tenant byte estimates; versioned stored rule document with a tested revert; two-tenant isolation fixture run against the rule document. §9.3.2 gains a separate step 2b and a three-move contraction (5a/5b/5c). §9.8 Case C rewritten. |
| **M1** | Major | Liveness monitor cannot see the failure it is built for | **Accepted, all three parts.** Evaluation moved to per **device**; "connected but not draining" added as its own paging signal; `alert_after_max` ceiling added, drift (+50 % over 28 days) alerted on separately, and the learned baseline frozen during and 7 days after an incident. |
| **M2** | Major | Write-off figure at retirement is a stale device claim | **Accepted.** The retirement screen shows three numbers and a sentence: last-reported (labelled a floor), a derived estimate from the location's own trailing throughput × days dark, and the server's accepted watermark. |
| **M3** | Major | Retiring a device silently unblocks period close | **Accepted.** New **Rule 9.3-F**: one retirement action writing `app.device.status`, the §3.11.4 close-record exclusion, and the contraction record atomically. §9 defers to §3.11.4 rather than re-inventing the policy. The **owner** conflict (§3 says Accounts, §9 said tenant administrator) is `open-questions.md` Q19, whose scope must widen — see C7. |
| **M4** | Major | "Replayed by hand" re-dates the sale | **Accepted.** New **Requirement 9.3-G**: replay is a server-originated ingest with `write_id = uuidv5(ns,'replay:'\|\|original_write_id)`, original `claimed_hlc`/`device_wall_at` preserved, `is_late_arrival` set, and the business-date clamp evaluated against the **original** device session. Refused outright if the original session cannot be reconstructed — the remedy is then a dated correcting document. |
| **M5** | Major | "Prove nothing reads the column" measures only the server | **Accepted.** Server read telemetry is now explicitly labelled evidence about the server alone. The fleet proof **is** the §9.3.4 gate. Column leaves the sync rules (5b) before it leaves the table (5c), and that removal is its own fleet event under Rule 9.3-D. |
| **M8** | Major | Worked migration contradicts §4 and §6, would fail §9.3.6's CI gate | **Accepted.** The credit-terms example is withdrawn — §4.9 and §6 already built per-account terms, so it taught DDL that contradicts the schema. Replaced with a genuine unbuilt change: promoting the scalar `app.customer.price_list_id` to an effective-dated `app.customer_price_list_assignment`. Written as a `tenantTable` registry declaration plus its emitted DDL, with `app.hlc`, `row_hlc`, `archived_at` and RLS present, so it passes §9.3.6's assertion. |
| **M9** | Major | Backfill changes what customers owe | **Accepted, and generalised.** New **Rule 9.3-E**: a money-touching backfill carries the existing per-row value (never a default), takes `effective_from` from the row's own history (never `current_date`), is idempotent via a unique index + `ON CONFLICT DO NOTHING` (never `NOT EXISTS` under `READ COMMITTED`), sends underivable rows to a human, ships with its own test per `CLAUDE.md` §2.7, and requires named sign-off when it would move a receivable, payable, price or tax basis. |
| **M10** | Major | Restore-drill steps 4 and 5 not executable; step 5 checks one tenant | **Accepted.** New **Requirement 9.5-A**: a scheduled per-tenant, per-table row-count-and-digest job writing `app.table_digest`, **inside the backup**, which is what makes step 4 possible. Step 5 runs for **every active tenant**, in **that tenant's jurisdiction pack's minor unit**, not "to the pesewa". Drill gains step 6, exercising the runbook steps B4 added. |
| **M11** | Major | 60-second budget ignores bandwidth and the herd | **Accepted.** Rule 9.1-A gains a bytes term (≤ 2 KB canonical / ≤ 700 B on the wire per sale) and states the link the criterion assumes (≥ 1 Mbps uplink with compression); below that the requirement is convergence without loss, not in 60 s. New **Rule 9.1-B** adds backpressure: server-advertised batch size and `retry_after`, full-jitter reconnect, per-location concurrency cap, re-upload windows staggered by ring. |
| **M12** | Major | `scratch` is production data everywhere except in the rules about it | **Accepted.** §9.2 gives `scratch` a full paragraph: production-tier isolation and encryption, named time-boxed break-glass access with a separate approver, full statement logging of the `platform_admin` RLS-bypass path, no client traffic, and `scratch_destroyed_at` as a column on `platform.restore_drill` with a paging alert at 72 hours. The per-tenant recovery import now goes through the normal write path rather than raw admin inserts. |
| **M13** | Major | Requirement 9.8-A duplicates §3 and cannot answer its own question | **Accepted.** Replaced with two columns on `app.write_log` (`client_build`, `server_build`), append-only, joined to `app.row_version` by `write_id`. The old per-row proposal is shown alongside with the reason it fails (stamped on update, the second writer erases the first). C4 rewritten. |
| m1 | Minor | Rule 9.3-A has no enforcement artefact | **Accepted.** `platform.schema_contract.min_served_contract` added with a `CHECK`, plus a deploy-time query that must return zero rows before the floor may be raised. Precedence stated explicitly: §9.3.4 governs whether a contraction proceeds, 9.3-A governs what must keep being served; the stricter wins and it is always §9.3.4. |
| m2 | Minor | `stranded_write.reason` omits the revocation case | **Accepted.** `revoked_device` added as a distinct reason, and §9.9 routes `lost_or_stolen` to it. Stated that a security hold and a contract failure share a table but not a reason code, a queue or an alert. |
| m3 | Minor | `below_min_contract > 0` is not proof of a rule violation | **Accepted.** It still pages, labelled "a device has been stranded". Only `unknown_table` / `unknown_column` are labelled discipline failures, and the "should be empty" scoreboard claim is narrowed to those two. |
| m4 | Minor | Release rings are tenant #1's org chart | **Accepted.** `app.location.release_ring` + `app.tenant_release_ring`, tenant-set. Platform defines only ordering, soak and advancement blocking. Tenant #1's rings shown as template seed data. The §9.2 / §9.7.2 disagreement resolved: **rearmost ring** governs for a new tenant, and §9.2 step 7 corrected. §9.3.5's backfill canary is now a *designated* tenant recorded on the migration, not a named one. |
| m5 | Minor | `ops_contact_msisdn` hard-codes SMS | **Accepted.** `(ops_contact_channel, ops_contact_address)`, per §3.11.10 finding 22. SMS is tenant #1's configured value, not the platform's. |
| m6 | Minor | Maintenance-window payoff is single-tenant reasoning | **Accepted.** New **Rule 9.3-H**: the window is computed from the union of every active tenant's `location_sync_expectation` trading hours in UTC, recomputed on tenant/location change, with an onboarding warning when a prospective tenant would shrink it below two hours and a per-tenant fallback when no common window exists. Tenant #1's 21:00–23:00 UTC is shown as a derived result, not a premise. |
| m7 | Minor | 35-day write-log retention asserted without arithmetic; ignores eviction | **Accepted.** Arithmetic supplied: ~17.5 MB uncompressed / ~5–6 MB compressed per flagship till, i.e. ~10 % of §3's 60 MB device budget, and it is counted **inside** §8.10's budget rather than added to it. Eviction handled by adopting §8's existing `navigator.storage.persist()` hard gate (a non-persisted device may not take a sale) plus per-handshake persistence reporting. The gate's blind spot — an evicted device looks caught up and produces no `stranded_write` row — is named explicitly. |
| m8 | Minor | A restore triggers a conflict-review storm that masks real conflicts | **Accepted.** Runbook step 7 plus a boxed note: replay items carry `origin_incident_id`, the §9.4 age alarm excludes them for the window plus 2 business days, they are worked as their own batch, and they are annotated rather than suppressed so a genuine divergence during a restore is still visible. |
| m9 | Minor | Review-queue alarm contradicts §3's designed 14-day auto-resolve | **Accepted.** The primary threshold now excludes items in an auto-resolving class that has not reached its deadline, using §3's `auto_resolved` status hook. Auto-resolving items get their own gauge, including how many resolved without a human ever looking. |
| m10 | Minor | Lost-write detector is pilot-only | **Accepted.** Promoted from pilot success criterion 1 to a **standing daily §9.4 signal** for every tenant, against `app.device_write_watermark.applied_count`, paging on any unexplained discrepancy. |
| m11 | Minor | FY10 figure is a reconstruction, not the canonical line | **Accepted.** `financial-model-targets.md` §3's **41,184,000** is now cited, with the reconstruction explained (FY9/FY10 outlets are still on the 40/70/100 ramp; the per-tier rates are canonical). Staging is stated to be sized to the **fully-ramped** figure deliberately, as the pessimistic reading. The related point — staging at one year's volume under-tests ten-year accumulation for sync-rule and stale-fleet behaviour — is accepted with a `--years` multiplier and an annual reseed. |
| m12 | Minor | C1's recommendation is already unactionable | **Accepted.** 1 August 2026 has passed and Phase 0 is unapproved, so §9.7.1 is re-based: go-live is a **cut-over**, not an opening; the dry run becomes a **2–4 week parallel run** (better evidence, available because the outlet already trades); all ten Stage 1 clocks start at cut-over `T₂`, defined relative to the phase gate. Stated plainly that **none of the clocks have started and none can**. New dependency surfaced: opening balances (`open-questions.md` Q20) are now on the critical path. |

**Nothing was rejected.** Two findings were accepted with the mechanism changed rather than adopted
as proposed — M3 (§9 defers to §3.11.4's policy instead of writing its own, and hands the ownership
question to Q19) and C2's reframing under M6 (the discipline no longer waits on the measurement) —
and both changes are stated where they occur.

### 9.12.4 Promoted to `docs/open-questions.md`

`product-manager` owns that file. Three items:

| | Item | Action |
|---|---|---|
| **New** | **C10 — who pays for the fleet re-sync a restore forces.** A PITR rebuilds every bucket; §9.6 budgets ≤ 30 MB per device, so a 25-outlet tenant is on the order of 1.2 GB of *their* mobile data, spent because our database needed restoring. Absorb, reimburse, or disclose? Does it differ for a provider-caused versus tenant-requested restore? | **Add as a new `NEEDS-HUMAN` question**, owner founder, alongside Q14's commercial windows. Decide before the first tenant signs. |
| **Q12** | The pilot/opening collision — currently written as though 1 August 2026 is in the future. It is not, and Phase 0 is unapproved. | **Re-base** to §9.7.1's cut-over plan: parallel run, clocks at `T₂`, and record what the outlet is actually trading on today. Note the new dependency on Q20 (opening balances), which a cut-over makes critical-path. |
| **Q19** | "Who may exclude a dark device from a period close?" — the scope is too narrow. Rule 9.3-F makes retirement **one act with three consequences**: writing off unsynced writes, excluding the device from close, and unblocking a contraction. | **Widen the question** to cover all three, and resolve the §3-says-Accounts / §9-said-tenant-administrator disagreement once. It is one policy and one owner. |

One item deliberately **not** promoted: **C9** (one device registry, one lifecycle vocabulary). It
needs no human — it is a cross-section engineering reconciliation between §2.7, §3.11.4 and §9.3.4,
in the same class as §3.11.9's naming reconciliation, and it carries the same status: **a Phase 0
exit condition**, because the contraction gate cannot be written until the owners adopt it.
