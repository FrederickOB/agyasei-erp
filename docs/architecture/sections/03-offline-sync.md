# 3. Offline-First Sync

**Owner:** `sync-architect` · **Status:** Phase 0 draft for approval
**Depends on:** `ADR-0003` (PWA + managed Postgres, `eu-west`), `ADR-0004` (integer minor units),
`ADR-0005` (shared schema, RLS, tenant-scoped sync rules), `ADR-0006` (templates, not branches),
`ADR-0007` (jurisdiction packs)

This is the section most likely to be wrong in a way nobody notices for six months. Every design
choice below is made to convert silent corruption into a loud, visible, human-workable event, even
where that costs convenience.

> **Revision note.** This section was adversarially reviewed on 2026-08-20 and revised. Six
> blocking findings and twenty-one lesser ones were accepted. Corrections are applied inline where
> they are short; the full disposition of every finding, and the new mechanisms the review forced
> (server-stamped HLC, the write registry unification, the credit-allowance bucket, the completeness
> attestation), are in **§3.11**. **Where §3.11 and the body of this section differ, §3.11
> governs.**

The requirement, restated because everything here follows from it: a location trades fully offline
for hours or days; a sale, stock adjustment or credit transaction must **never** be lost, **never**
be silently double-counted, and **never** corrupt another location's — or another tenant's — data
on sync.

---

## 3.1 The sync layer: choice and justification

`CLAUDE.md` §2.2 requires this justification in writing before any application code exists. What
follows is the comparison, not a rationalisation of a foregone conclusion.

### 3.1.1 What we are actually buying

It is worth being precise about which problem we are outsourcing, because the two candidates split
it differently and that split is the whole argument.

An offline-first stack has five parts:

| # | Part | Get it wrong and… |
|---|---|---|
| A | **Local store** — a real database on the device, queryable offline | app is slow or unusable at the counter |
| B | **Download fan-out** — which rows reach which device, incrementally, resumably, consistently | wrong data on device; cross-tenant leak; 2GB tablet fills up |
| C | **Durable write outbox** — ordered, persistent, retrying, survives app kill and OS restart | **a sale is lost** |
| D | **Write semantics** — validation, authorization, idempotency, conflict detection | **a sale is double-counted**, or a limit is silently overwritten |
| E | **Convergence** — the data model itself merging cleanly | slow-burn divergence between HQ and outlets |

**Rule zero applies to B and C.** Those are the parts where a confident, reasonable-looking
implementation is wrong only under partition, at scale, months later. **D and E are ours regardless**
— they are business semantics and no framework can supply them. E is §3.7.

The right question is therefore not "which sync engine is best" but **"which candidate takes B and
C off us without also taking D away from us."**

### 3.1.2 PowerSync

Postgres stays the source of truth. The PowerSync Service tails Postgres logical replication,
materialises rows into **buckets** defined by declarative **sync rules** (YAML), and streams bucket
operations to clients. The client SDK maintains a local SQLite database and a persistent CRUD
upload queue.

The decisive property: **PowerSync does not write to Postgres.** Uploads are handed to a client
`uploadData()` hook that calls *our own backend API*. Our Node/TypeScript service validates,
authorizes, stamps `tenant_id` from the verified JWT, deduplicates on the idempotency key, detects
conflicts, and writes. The result flows back down through logical replication like any other change.

| Dimension | Assessment |
|---|---|
| **Write conflicts** | Handed to us, by design. PowerSync's own behaviour is "server state wins on the way down" — which is correct, because the server state is whatever *our* conflict logic decided. This is the property we want: the framework does not merge anything on our behalf, so nothing is silently resolved. |
| **Authorization model** | JWT-based. Sync rules distinguish **token parameters** (claims in the signed JWT — trusted) from **client parameters** (sent by the client — untrusted). Tenant scoping is expressible directly and declaratively (§3.2). The boundary is a reviewable, diffable, testable artefact in git rather than an if-statement in a proxy. |
| **Offline for a week** | Strong. The CRUD queue is in local SQLite; it survives app kill, OS restart and battery death, and uploads in order on reconnect. Downloads resume from the client's checkpoint; a client far past bucket compaction re-downloads affected buckets rather than desynchronising. Two real edges we must design for: **expired JWTs** (§3.1.7) and **head-of-line blocking on a poison mutation** (§3.3.4). |
| **Operational maturity** | Commercial product with production deployments, managed cloud and a self-hostable open core. Postgres is a first-class source. Documented bucket/compaction behaviour. It is not a research project. |
| **Cost** | Usage-based on the managed cloud, driven by sync operations and streamed bytes; self-hosting caps it at a VM plus the bucket store. See §3.1.6. |
| **Exit path** | Genuinely good — see §3.1.8. Because writes never traverse PowerSync, the write path is already vendor-neutral on day one. |
| **Costs we accept** | A commercial dependency with a source-available core. Sync rules are a **single global document for the whole service** — a bad deploy is an all-tenant event (§3.10, Concern 2). Bucket cardinality is an operational hazard that has to be designed for, not discovered. |

### 3.1.3 ElectricSQL

Electric is a **read-path sync engine**. It tails Postgres logical replication and serves **Shapes**
(a table plus a where-clause) as an HTTP log that is cacheable by ordinary CDN infrastructure. It is
Apache-2.0, operationally simple, and scales to very large numbers of concurrent readers cheaply.

Electric is genuinely excellent at part B. It also, deliberately and explicitly, **does not do
part C.** Writes are out of scope; the documented patterns hand the local write queue back to the
application, optionally composed with a separate local-store library.

The earlier ElectricSQL — the bidirectional, CRDT-merging, active-active system — was retired and
replaced by this design. Any comparison that credits Electric with automatic write merging is
comparing against a product that no longer exists.

| Dimension | Assessment |
|---|---|
| **Write conflicts** | Not addressed. Ours entirely — same as PowerSync in outcome, but we also inherit the queue that produces them. |
| **Authorization model** | A proxy or gatekeeper endpoint we write authorises a shape request and issues/forwards it. Flexible, but the tenant boundary becomes application code rather than a declared rule set, and a client-supplied where-clause reaching the shape definition is a total cross-tenant compromise. More expressive; more surface. |
| **Offline for a week** | Reads: fine — the shape log has a cached offset and a badly-behind client re-fetches. Writes: **undefined, because there is no write path.** A durable ordered outbox on a low-end Android PWA that survives seven days, 1,200 mutations, a browser eviction scare and an app upgrade is precisely the artefact rule zero exists to stop us building. |
| **Operational maturity** | The read engine is mature and pleasantly boring to run. The write story is a set of patterns, not a component. |
| **Cost** | Lowest — a stateless-ish service and a CDN. Real advantage. |
| **Exit path** | Excellent (Apache-2.0, no lock-in). |

### 3.1.4 Other serious contenders, honestly

- **Rocicorp Zero** (successor to the now-sunset Replicache). Query-driven sync with server-authoritative **custom mutators**: optimistic mutations replay on the server and rebase. That is a genuinely strong conflict model — arguably a better *shape* than either candidate above, because the mutation is one function that runs in both places. Against it: browser persistence is IndexedDB rather than SQLite; multi-day offline operation has not been its design centre (it is built for low-latency collaborative apps); and at the time of writing its maturity does not support betting a company's books on it. **Watch; do not pilot on it.**
- **Couchbase Lite / CouchDB replication.** The most field-proven offline replication protocol in the list, by a wide margin. Fails on a constitution-level constraint: the source of truth becomes a document store, and Phase 3 needs a native double-entry GL enforced in Postgres with RLS. Running both and reconciling them is a hand-rolled sync protocol wearing a hat. **Rejected.**
- **Ditto.** Peer-to-peer mesh sync between devices on the same LAN, no server required — genuinely attractive for a Flagship with four tills where the tills can agree with each other even when the town's link is down. Two objections: it is a CRDT document store, not Postgres; and its LWW register semantics would *merge* a credit-limit conflict, which is exactly the outcome §2.2 forbids. **Rejected, but the LAN-mesh idea is worth revisiting for intra-location till coordination later.**
- **Firestore.** Excellent offline persistence, proven in low-connectivity markets. Not Postgres; per-field LWW; cannot express the GL. **Rejected on the same ground as Couchbase.**
- **WatermelonDB.** A local store plus a sync *protocol you implement*. All of Electric's objection, more of it. **Rejected.**

### 3.1.5 Recommendation

**PowerSync.** Three reasons, in order of weight:

1. **It splits the problem along the correct seam.** It takes B and C — the two parts rule zero
   names — and hands us D, which we must own anyway. Electric takes only B and hands C back. On
   this project C is the requirement: *a sale must never be lost* is a statement about a durable
   client outbox, and that is the component Electric does not have.
2. **The tenant boundary becomes a declarative artefact.** `ADR-0005` calls sync rules "the
   isolation boundary that actually matters." A YAML document that is diffed in review, linted in
   CI and tested against a two-tenant fixture is a materially better place to put an unrecoverable
   failure mode than a proxy handler. The trusted/untrusted parameter split is enforced by the
   framework rather than by our own care.
3. **Writes through our own API is a feature, not a limitation.** Every constraint in this
   architecture — `tenant_id` from the token and never the payload, per-tenant idempotency keys,
   compare-and-set conflict detection, conflict routing to a review queue, GL postings derived
   server-side and never captured on a device — needs a server-side write path. A layer that wrote
   straight to Postgres from the device would have to be fought.

**Deployment:** PowerSync Cloud in an EU region alongside the Postgres primary (`ADR-0003`), with
self-hosting kept live as a pressure valve — no dependence on cloud-only features, and a
self-host runbook proven once before the pilot goes live, not first attempted under duress.
Re-evaluate managed vs. self-hosted at tenant #3.

### 3.1.6 Cost at our scale

Device count drives everything. Tenant #1's device estimate, from `outlets.csv`:

| Location type | Count | Devices each | Devices |
|---|---|---|---|
| Flagship (Techiman) | 1 | 5 (4 tills + manager) | 5 |
| RDC | 6 | 3 | 18 |
| Micro-outlet | 18 | 2 | 36 |
| HQ / regional / accounts | — | 6 | 6 |
| **Pilot (Techiman only, FY1)** | | | **~8** |
| **Full network (FY10)** | | | **~65** |

The cost driver is not row count, it is **fan-out**: a synced row costs once per device that
receives it. Which makes the point worth stating plainly — **narrow sync rules are a cost control
as well as a security control, and the two optimisations do not conflict.** A stock movement at
Wenchi should reach three devices (the Wenchi tablets, and HQ reporting), not sixty-five.

Rough volumes at full network: ~5,000–8,000 write rows/day network-wide (sales, lines, movements,
AR transactions), an average fan-out of ~3, and a per-device local database well under 50MB under
the windowing rules in §3.2.4. That is a small workload by any sync engine's standards.

On usage-based managed pricing this lands in the **low tens of USD per month at pilot and low
hundreds at full network**, which is a rounding error against the cost of one lost trading day at
the Flagship. Exact figures must be re-validated against current pricing at implementation — the
structural claims (fan-out is the driver; self-hosting caps the ceiling at infrastructure) are the
part that will not change. Multi-tenant scaling is roughly linear in devices, and a shared service
across tenants is cheaper than a per-tenant sync connection would be under database-per-tenant.

### 3.1.7 The week-offline case, concretely

A Wenchi micro-outlet tablet is offline Monday to the following Monday. On reconnect:

1. **Auth.** Its access token expired days ago. It must have kept trading regardless — local reads
   and the outbox are unconditional, never gated on a valid token. **The offline session is
   governed by `§2.7`, not by this section**, and this section previously invented a 30-day refresh
   token that does not exist there. The governing numbers are §2.7's: **72 h full trading, +24 h
   restricted mode** (cash sales continue; credit, overrides and adjustments stop), then **sealed —
   read-only, no new writes accepted, queued writes preserved**. A sealed device still uploads its
   queue on reconnect; sealing stops new writes, it never discards old ones. Extension beyond the
   default requires `admin.offline_lease.extend`, is audited, and §2.7 correctly describes it as a
   deliberate weakening of the posture. **The failure to avoid at all costs is a login screen that
   blocks access to unsynced local data** — sealing must never present as a login wall over an
   unsent queue.

   Whether 72 h is the right default for a Bawku micro-outlet, which §9 expects to be dark for
   longer than that, is `Q-SEC-3` — a product decision to be taken on instrumented pilot data, not
   an engineering default. This section does not get to answer it by writing a bigger number.
2. **Upload before download.** Queued mutations upload in order, batched, each idempotent (§3.3).
   ~1,200 mutations over 2G is minutes, not seconds; progress is visible and interruptible, and a
   partial upload is safe because every mutation is independently deduplicated.
3. **Download.** The client's checkpoint is a week old and its buckets have been compacted past it,
   so affected buckets re-download rather than replay operation-by-operation. Bounded by the
   windowing in §3.2.4 — tens of MB, not hundreds.
4. **Conflicts** surface as review-queue entries (§3.6), most of them within the location, not
   across it.
5. **Beyond retention — replaced.** The earlier design pruned the dedupe registry at 90 days and
   sent anything older to a `stale_device_batch` an HQ user confirmed in one click. That was a
   double-posting mechanism wearing the clothes of a safety control: after the prune there is no
   per-mutation dedupe left, the reviewer is approving ~1,200 mutations of which an unknown subset
   already posted, and the approval books revenue and COGS into today's open period at today's
   cost. **Deduplication is now structural, not temporal** (§3.11.3): a permanent, tiny
   `device_write_watermark` row per device makes any write at or below the watermark a replay
   regardless of age, so `write_log` bodies can be pruned freely and there is no cliff. There is no
   bulk-confirm action. Operationally the 14-day alert stands: **any device that has not synced in
   14 days raises an alert**, because at that point it is a stolen tablet, a dead SIM or a departed
   employee long before it is a data problem.

### 3.1.8 Exit path

If PowerSync proves wrong, what has to change?

| Layer | Survives? |
|---|---|
| Postgres schema, RLS, constraints, movement logs | **Yes** — untouched. |
| Write API, idempotency, HLC, conflict detection, review queue | **Yes** — none of it is PowerSync-aware. This is the majority of the code and the entirety of the correctness-critical code. |
| Server-side domain and GL logic | **Yes.** |
| Sync rules (YAML) | **No** — rewrite as shapes/rules in the successor. ~300 lines of declarative config with a full test suite already written against it. |
| Client data-access layer | **Partial** — SQL against local SQLite mostly survives; the connector, queue integration and reactive query hooks do not. |
| Client outbox | **No** — replaced, or hand-built (which is the thing we were avoiding, and the reason the exit would be painful). |

Estimated exit: **weeks, not a rewrite.** The property that buys this is that **writes never
traverse the sync layer**, so no business rule is expressed in vendor terms. To keep that true, two
standing rules: (a) all local reads go through a thin repository layer, never PowerSync APIs
scattered through components; (b) no domain logic in sync rules — they filter rows, they never
compute, derive or transform.

---

## 3.2 Sync rules

Sync rules answer one question: **which rows reach this device.** They are the point at which data
leaves the server, so they are simultaneously the tenant boundary (`ADR-0005`), the RBAC boundary
(`CLAUDE.md` §2.6), the device-theft blast radius, and the cost driver. Designed with
`rbac-security-engineer`, not after them.

### 3.2.1 Three inviolable rules

1. **`tenant_id` comes only from the signed token.** `request.jwt() ->> 'tenant_id'` — never
   `request.parameters()`, which is client-supplied and therefore hostile input. A single rule
   using a client parameter for tenant scope is a total, unrecoverable compromise.
2. **Every data query repeats `tenant_id = bucket.tenant_id`,** even when the bucket key already
   implies it via `location_id`. Defence in depth: a mis-assigned `locations.tenant_id` row would
   otherwise ship another tenant's outlet to a device.
3. **A device holds one location's window, never the network's.** Both a security requirement (the
   tablet can be stolen) and a hardware one (2GB of RAM, `ADR-0003`).

### 3.2.2 Bucket design

| Bucket definition | Key | Contents | Audience |
|---|---|---|---|
| `tenant_reference` | `(tenant_id)` | `locations`, `location_types`, `products`, `product_units`, `price_lists`, `price_list_items`, `tax_codes`, jurisdiction-pack rows, `roles`, `permissions` | every user of the tenant |
| `location_ops` | `(tenant_id, location_id)` | `stock_movements` (windowed), `stock_balance_snapshots`, `stock_counts`, `sales`, `sale_lines`, `payments`, `cash_sessions`, `sequence_blocks` | users scoped to that location |
| `tenant_customers` | `(tenant_id)` | `customer` — identity fields, `credit_hold`, `has_open_conflict`. **No balances, no limits, no ageing.** | all POS users |
| **`location_credit_allowance`** | `(tenant_id, location_id)` | **`credit_allowance` only** — `{customer_id, cap_minor, headroom_minor, offline_ceiling_minor, credit_hold, snapshot_as_of}` for *this location*. No balance, no limit, no ageing, no history. | holders of **`credit.sell`** scoped to that location |
| `tenant_credit` | `(tenant_id)` | `credit_account`, `credit_limit_version`, `credit_entry`, ageing snapshots | holders of `credit.read` |
| `tenant_transfers` | `(tenant_id, location_id)` | `stock_transfer` headers and lines where this location is **either** endpoint | users scoped to either endpoint |
| `tenant_reviews` | `(tenant_id, review_queue)` | `conflict_review` rows for that queue, intersected with the reviewer's location scope | holders of a permission mapped to that queue |
| `user_private` | `(tenant_id, user_id)` | notifications, preferences, device state | that user only |

**The credit-allowance bucket is new, and it closes a contradiction the first review found.** As
originally written this section said credit limits and balances "never leave the server", while
§6.7 required the till to enforce a per-location cap and an offline single-sale ceiling and to tell
the customer *"your limit is GH₵8,000 but we can only do GH₵4,000 today"*. Both cannot be true.
The resolution is that **the till learns a bounded local allowance, not the account**: a
`headroom_minor` for this location as at `snapshot_as_of`, and nothing else. A stolen tablet
discloses what one outlet may lend one customer today; it does not disclose the customer's limit,
balance, ageing or purchase history, and it discloses nothing about customers who do not trade at
that location. §3.2.3's claim is now true as stated, and §6.7 is buildable.

**Bucket cardinality, re-derived.** The earlier "~130 buckets" counted parameterised definitions as
one bucket each, which is wrong: a bucket's identity is its definition *plus its parameter values*.
Tenant #1 at full network: `location_ops` 25 · `location_credit_allowance` 25 · `tenant_transfers`
25 · `user_private` 65 (one per user) · `tenant_reviews` — one per *review queue* per user, and
this is exactly why the key is a coarse `review_queue` grouping (~6) rather than a raw permission
(~30): 65 × 6 ≈ 390 instead of ~1,950 · plus ~3 tenant-wide ≈ **~530 buckets**, four times the
earlier figure and still comfortable. Stating the parameter cardinality is the point; a document
that calls bucket count "an operational hazard that has to be designed for" and then mis-counts it
by an order of magnitude has designed for nothing.

The `tenant_reference` bucket is deliberately shared by every device rather than split per
location: 219 SKUs is small, catalogue lookups must work for any product a customer asks about, and
splitting would multiply bucket count for no benefit.

### 3.2.3 What a rule actually looks like

```yaml
# powersync/sync-rules.yaml  — reviewed by two people, CI-gated (§3.9)
bucket_definitions:

  # ---- Tenant-wide reference data ------------------------------------------
  tenant_reference:
    # tenant_id from the SIGNED token. Never request.parameters().
    # Liveness check added on review: every other parameter query verifies the
    # user is still active; this one took the JWT claim alone, so a suspended
    # user's device kept receiving the catalogue and price lists for the life of
    # its offline lease. Symmetry is the control.
    parameters: |
      SELECT m.tenant_id
      FROM   tenant_membership m
      WHERE  m.user_id   = request.user_id()
        AND  m.tenant_id = (request.jwt() ->> 'tenant_id')
        AND  m.revoked_at IS NULL
        AND  m.status = 'active'
    data:
      - SELECT * FROM locations       WHERE tenant_id = bucket.tenant_id AND deleted_at IS NULL
      - SELECT * FROM products        WHERE tenant_id = bucket.tenant_id AND deleted_at IS NULL
      - SELECT * FROM product_units   WHERE tenant_id = bucket.tenant_id
      - SELECT * FROM price_list_items WHERE tenant_id = bucket.tenant_id
      - SELECT * FROM tax_codes       WHERE tenant_id = bucket.tenant_id
      - SELECT * FROM tax_rates       WHERE tenant_id = bucket.tenant_id

  # ---- Per-location operational data ---------------------------------------
  location_ops:
    # Location scope is read server-side from the user's assignment, never sent
    # by the client. Zero rows => zero buckets => nothing syncs. Fails closed.
    #
    # NOTE: the sync window is NO LONGER a bucket parameter. It was, and that was
    # a scheduled monthly outage: a bucket's identity is its definition plus its
    # parameter values, so advancing the epoch created a DIFFERENT bucket and every
    # device in the fleet re-downloaded 90 days of movements over 2G on the same
    # night. Windowing is now per-row (archived_at, §3.2.4), so membership changes
    # without the bucket key changing.
    parameters: |
      SELECT uls.tenant_id, uls.location_id
      FROM   user_location_scope uls
      WHERE  uls.user_id   = request.user_id()
        AND  uls.tenant_id = (request.jwt() ->> 'tenant_id')
        AND  uls.revoked_at IS NULL
    data:
      - SELECT * FROM stock_movement
         WHERE tenant_id  = bucket.tenant_id      -- repeated deliberately (rule 2)
           AND location_id = bucket.location_id
           AND archived_at IS NULL
      # Current balance only. The nightly historical series stays server-side:
      # 219 SKUs x 365 nights x 25 locations is ~2M rows a year and it was in no
      # window at all, against a claimed "well under 50MB". See §3.2.4.
      - SELECT * FROM stock_balance_current
         WHERE tenant_id = bucket.tenant_id AND location_id = bucket.location_id
      - SELECT * FROM sale
         WHERE tenant_id = bucket.tenant_id AND location_id = bucket.location_id
           AND archived_at IS NULL
      # sale_line, sale_tender, sale_line_tax, cash_session and stock_count each
      # carry a denormalised (tenant_id, location_id) precisely so they can appear
      # here: a PowerSync data query selects from ONE table and cannot join.
      # That is a schema requirement on §4, not an optimisation. (§3.11.10)
      - SELECT * FROM sale_line
         WHERE tenant_id = bucket.tenant_id AND location_id = bucket.location_id
           AND archived_at IS NULL
      - SELECT * FROM sale_line_tax
         WHERE tenant_id = bucket.tenant_id AND location_id = bucket.location_id
           AND archived_at IS NULL
      - SELECT * FROM cash_session
         WHERE tenant_id = bucket.tenant_id AND location_id = bucket.location_id
           AND archived_at IS NULL
      - SELECT * FROM sequence_block
         WHERE tenant_id = bucket.tenant_id AND location_id = bucket.location_id
           AND exhausted_at IS NULL

  # ---- Per-location credit ALLOWANCE (not the account) ---------------------
  # Gated on credit.sell AND on location scope. A till learns what it may lend
  # here today. It never learns the limit, the balance, the ageing or the history.
  location_credit_allowance:
    parameters: |
      SELECT uls.tenant_id, uls.location_id
      FROM   user_location_scope uls
      JOIN   user_effective_permission up
             ON  up.user_id   = uls.user_id
             AND up.tenant_id = uls.tenant_id
             AND up.permission = 'credit.sell'
             AND (up.location_id IS NULL OR up.location_id = uls.location_id)
      WHERE  uls.user_id   = request.user_id()
        AND  uls.tenant_id = (request.jwt() ->> 'tenant_id')
        AND  uls.revoked_at IS NULL
    data:
      - SELECT tenant_id, location_id, customer_id, cap_minor, headroom_minor,
               offline_ceiling_minor, credit_hold, snapshot_as_of, row_hlc
          FROM credit_allowance
         WHERE tenant_id = bucket.tenant_id AND location_id = bucket.location_id

  # ---- Permission-gated: the credit book itself ---------------------------
  # The gate IS the parameter query. No permission -> no rows -> no bucket.
  tenant_credit:
    parameters: |
      SELECT up.tenant_id
      FROM   user_effective_permission up
      WHERE  up.user_id    = request.user_id()
        AND  up.tenant_id  = (request.jwt() ->> 'tenant_id')
        AND  up.permission = 'credit.read'
    data:
      - SELECT * FROM credit_account        WHERE tenant_id = bucket.tenant_id
      - SELECT * FROM credit_limit_version  WHERE tenant_id = bucket.tenant_id
      - SELECT * FROM credit_entry          WHERE tenant_id = bucket.tenant_id
                                              AND archived_at IS NULL

  # ---- Transfers: visible to BOTH endpoints -------------------------------
  # A receiving outlet needs the inbound dispatch before the lorry arrives,
  # which is exactly when it is offline. The two legs live in two different
  # location_ops buckets, so the header needs its own.
  tenant_transfers:
    parameters: |
      SELECT uls.tenant_id, uls.location_id
      FROM   user_location_scope uls
      WHERE  uls.user_id   = request.user_id()
        AND  uls.tenant_id = (request.jwt() ->> 'tenant_id')
        AND  uls.revoked_at IS NULL
    data:
      - SELECT * FROM stock_transfer_endpoint      -- one row per (transfer, endpoint)
         WHERE tenant_id = bucket.tenant_id AND location_id = bucket.location_id
           AND archived_at IS NULL

  # ---- Review queue, routed by queue + location scope ----------------------
  # location_scope was declared and never used, so a credit-limit review — with
  # balance, ageing and 12 months of purchase history in its context blob —
  # reached every holder of the permission at all 25 outlets. The heavy context
  # is no longer synced at all: it is fetched online when a reviewer opens the item.
  tenant_reviews:
    parameters: |
      SELECT rq.tenant_id, rq.review_queue, uls.location_id
      FROM   user_effective_permission up
      JOIN   review_queue_permission rq
             ON  rq.tenant_id  = up.tenant_id
             AND rq.permission = up.permission
      JOIN   user_location_scope uls
             ON  uls.user_id = up.user_id AND uls.tenant_id = up.tenant_id
             AND uls.revoked_at IS NULL
      WHERE  up.user_id   = request.user_id()
        AND  up.tenant_id = (request.jwt() ->> 'tenant_id')
    data:
      - SELECT tenant_id, id, conflict_class, severity, entity_table, entity_id,
               field_path, ancestor_value, proposals_summary, pending_state,
               pending_value, review_queue, location_id, status, opened_at,
               escalate_at, escalation_level
          FROM conflict_review_location   -- one row per (review, in-scope location)
         WHERE tenant_id  = bucket.tenant_id
           AND review_queue = bucket.review_queue
           AND location_id  = bucket.location_id
           AND status IN ('open','claimed')
```

Three properties worth naming:

- **Everything fails closed.** No location assignment, no permission, no token claim → the
  parameter query returns zero rows → no bucket → no data. There is no default-open path.
- **Roles are data, not enum values.** `user_effective_permissions` is a view over the tenant's own
  editable roles (`ADR-0006`). No rule anywhere names a role. No rule anywhere names a tenant.
- **The credit book never reaches an outlet device; a bounded allowance does.** `credit_account`,
  the limit, the balance, the ageing and the payment history are not on a till, in any bucket, at
  any permission an outlet role holds. What a till holds is one `credit_allowance` row per credit
  customer *for its own location*: a cap, a headroom figure, an offline single-sale ceiling and a
  hold flag, stamped `snapshot_as_of`. §2.6 says outlet staff have no credit-limit authority; the
  strongest available form of that is that the limit is not on the device, and this is that form.
  The till can therefore say *"we can do GH₵4,000 here today"* without being able to say what the
  customer's limit is — which is also the only sentence it is entitled to say, because with the
  network down it does not know the network position (§6.7, Concern 4).

### 3.2.4 Windowing: keeping a 2GB tablet small

`stock_movement` is append-only and grows forever; devices cannot hold all of it. PowerSync data
queries are evaluated against replicated rows, so a `WHERE occurred_at > now() - interval '90 days'`
does not re-evaluate as time passes.

**The first design put the window in the bucket key and that was wrong.** A `sync_epoch` selected
by the parameter query makes the epoch part of the bucket's *identity*: advancing it monthly
produces a different bucket, and every device drops the old one and re-downloads ninety days of
movements, sales and sequence blocks from scratch — simultaneously, fleet-wide, over 2G. That is
Concern 2's "full-fleet re-sync is an outage, not a deploy", scheduled monthly and unacknowledged.
It also stranded rows: a device offline across a month boundary uploaded rows whose epoch was
already below the mark, so they were accepted server-side and then delivered to nobody, including
the till that created them. A clerk would watch their own sales disappear after a successful sync.

**Windowing is therefore per row, not per bucket:**

- Every windowed table carries **`archived_at timestamptz`**, NULL while resident.
- A nightly job sets it on rows whose **`server_received_at`** is older than the window — never on
  `business_date` or `hlc`, so a late arrival is resident for its full window starting from when it
  actually arrived, and can never be archived before the device that created it has seen it
  acknowledged.
- Data queries filter `archived_at IS NULL`. A row leaving the window leaves the bucket by ordinary
  per-row membership and PowerSync deletes it from the device. **The bucket key never changes, so
  nothing else re-downloads.**
- `archived_at` is the single whitelisted mutation on an otherwise append-only table: column-level
  `GRANT UPDATE (archived_at)` to the archival role only, and the append-only trigger permits the
  `NULL → timestamp` transition and no other. This is the same shape §5.3 uses for
  `journal_entry.reversed_by_entry_id`.
- Balances survive because `stock_balance_current` stays resident (§3.7.1) — **one row per
  `(location, product)`, upserted server-side, not the nightly historical series.** The historical
  `stock_balance_snapshot` series is server-side only; syncing it was an unbounded growth path that
  the earlier text neither windowed nor noticed.

Default window: **90 days** of movements and sales on outlet devices; 400 days on HQ/accounts
devices. **Both are tenant configuration with a jurisdiction-pack floor**, not platform constants —
document retention is a statutory minimum (pack) and a commercial choice (tenant), and 90 is
neither.

**The 50MB estimate, with the arithmetic rather than the assertion.** One micro-outlet, 90 days:
~40 sales/day × 90 = 3,600 sales, ~2.5 lines each = 9,000 `sale_line` + ~9,000 `sale_line_tax` +
9,000 `stock_movement` + 3,600 `sale_tender`; at ~250 bytes/row that is ~8 MB. Plus
`stock_balance_current` at 219 rows, `tenant_reference` at ~1,500 rows (236 products, 262
`product_uom`, ~900 price-list items, locations, tax rows) ≈ 1 MB, plus `credit_allowance` at a few
hundred rows. **Under 15 MB at a micro-outlet, under 60 MB at the flagship** (4 tills, ~5× volume)
— which is why the flagship's window is a tenant-tunable number and not a constant. SQLite page
overhead and indexes roughly double these; the budget in §8.10 is the binding one.

Cost, stated plainly: **a till cannot look up a receipt older than the window without
connectivity.** Reprints of older receipts are an online-only operation. That is the right trade
against a device that fills up and stops trading, but it must be a designed behaviour with a clear
message — "older than 90 days, needs a connection" — not a mystery empty result.

---

## 3.3 Idempotency

The direct defence against *never silently double-counted*. Structural, not conventional.

### 3.3.1 The key

Every mutation carries a client-generated **`mutation_id uuid` (UUIDv7)**, generated once when the
user commits the action and **never regenerated on retry**. It is not a hash of the payload — two
genuinely distinct sales of one bag of cement, same price, same second, same till, are two sales
and must both post.

`mutation_id` is generated inside the local transaction that writes the optimistic rows, so an app
crash between "row written" and "id assigned" is impossible.

### 3.3.2 Where the constraint lives — one registry, not three

**Correction from review.** This section originally defined `applied_mutations`; §4.2.2 defined
`app.write_log` with a separate `idempotency_key text` and a *tenant*-scoped unique index over a
*device*-scoped opaque string; §5.2.4 defined a third key on `journal_entry`. Three registries,
three key names, three uniqueness scopes and no statement of which was authoritative. That is not a
tidiness complaint — it produced a lost-sale path. A device-generated opaque string unique per
tenant collides eventually; the second device to arrive is told "already applied" for a sale that
was never applied, which is worse than a duplicate because a duplicate is visible. And a business
row's composite FK to a `write_log` row that `ON CONFLICT DO NOTHING` never inserted is an FK
violation → a `4xx` → quarantine → **a tendered, printed, cash-collected sale in a poison table.**

**Decision: `app.write_log` is the single client-write registry.** `applied_mutations` is deleted
and its correctness-bearing columns move onto it. `write_log.id` — the client-generated UUIDv7 —
**is** the idempotency key; there is no second opaque string, so there is nothing to collide.
`journal_entry`'s key is a different thing and stays: it deduplicates *server-derived postings*
from documents (§5.2.4), keyed on the document, not on a device write.

```sql
CREATE TABLE app.write_log (
  tenant_id       uuid        NOT NULL,
  id              uuid        NOT NULL,          -- UUIDv7, client-generated. THE idempotency key.
  origin          text        NOT NULL           -- 'DEVICE' | 'SERVER'   (§3.11.7)
                              CHECK (origin IN ('DEVICE','SERVER')),
  device_id       uuid,                          -- NULL iff origin='SERVER'
  actor_user_id   uuid,                          -- NULL only for scheduled server jobs
  location_id     uuid,                          -- from the session, NOT the payload
  op              text        NOT NULL,          -- 'sale.create', 'stock.adjust', ...
  schema_version  integer     NOT NULL,          -- mutation payload version (§3.11.6)
  request_hash    bytea       NOT NULL,          -- sha256 over the JCS canonical form,
                                                 -- computed ON THE DEVICE at enqueue time
  response_body   jsonb,                         -- replayed verbatim to retries
  entity_ids      uuid[]      NOT NULL DEFAULT '{}',

  -- ordering. The SERVER's clock is authoritative; the device's is evidence.
  hlc_wall        bigint      NOT NULL,          -- server-stamped at ingest (§3.4.1)
  hlc_ctr         integer     NOT NULL,
  hlc_node        uuid        NOT NULL,          -- full 128 bits. Never truncated.
  claimed_hlc     text,                          -- what the device asserted. UNTRUSTED.
  clock_skew_ms   bigint,
  device_wall_at  timestamptz,                   -- UNTRUSTED, forensics/display only
  received_at     timestamptz NOT NULL DEFAULT transaction_timestamp(),

  CHECK (origin = 'SERVER' OR device_id IS NOT NULL),
  PRIMARY KEY (tenant_id, id)                    -- THE constraint
);
```

**The unique constraint is the primary key `(tenant_id, id)`** — in the database, on the write
path, not in a cache and not in application code. A cache-based dedupe is a dedupe that fails open
the first time the cache is cold. Every tenant-owned business row carries
`FOREIGN KEY (tenant_id, write_id) REFERENCES app.write_log (tenant_id, id)`, so omitting the key
is a foreign-key violation rather than a code-review comment (§4.2.2).

**Why scoped per tenant** (`ADR-0005`, `CLAUDE.md` §2.1), three independent reasons:

1. **It is a covert channel.** A global unique index means tenant A can probe for the existence of
   tenant B's mutation ids. Small, but it is a cross-tenant information flow and those are the ones
   we treat as unrecoverable.
2. **It creates false collisions in the dangerous direction.** A global collision returns "already
   applied" for a sale that was never applied for *this* tenant — a silently dropped sale, which is
   worse than a duplicate because a duplicate is visible.
3. **It obstructs per-tenant export and deletion**, which `ADR-0005` requires as a first-class
   capability. Per-tenant rows delete with the tenant; a global namespace does not.

### 3.3.3 Making an ambiguous failure safe

The client cannot distinguish "the server never received it" from "the server applied it and the
response was lost." So it never tries: **it always retries with the same `mutation_id`, and the
server always deduplicates.**

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;   -- pinned, and the reason matters: under
  -- REPEATABLE READ a concurrent duplicate that commits first makes DO NOTHING insert
  -- zero rows while the follow-up SELECT cannot see the winner in this snapshot, and
  -- the server has no response to return. READ COMMITTED sees it. If the read still
  -- comes back empty (the winner has not committed), we return 409 RETRY_LATER, which
  -- is retryable — never a definitive rejection.
  SET LOCAL app.tenant_id = :tenant_from_jwt;      -- RLS context (ADR-0005)

  INSERT INTO app.write_log
         (tenant_id, id, origin, device_id, actor_user_id, location_id, op,
          schema_version, request_hash, hlc_wall, hlc_ctr, hlc_node,
          claimed_hlc, clock_skew_ms, device_wall_at)
  VALUES (:tenant_from_jwt, :write_id, 'DEVICE', :device_id_from_session,
          :user_id_from_session, :location_id_from_session, :op,
          :schema_version, :request_hash_from_device,
          :server_hlc_wall, :server_hlc_ctr, :server_hlc_node,
          :claimed_hlc, :skew_ms, :device_wall_at)
  ON CONFLICT (tenant_id, id) DO NOTHING;

  -- 0 rows inserted  -> replay path: SELECT request_hash, response_body ...
  -- 1 row  inserted  -> first application: run domain logic here, in THIS transaction,
  --                     then UPDATE app.write_log SET response_body = :result
COMMIT;
```

Note what is **not** taken from the payload: `tenant_id` (JWT), `device_id`, `actor_user_id` and
`location_id` (the verified session). `user_id` is the audit trail and `location_id` feeds sync
scope; both are as attack-relevant as `tenant_id` and neither had been server-derived. Also note
`transaction_timestamp()` rather than `clock_timestamp()` throughout: one unit of work gets one
server time, so a sale written across midnight cannot split across a reporting boundary.

Three properties, each load-bearing:

- **The marker and the effect commit atomically.** They are in one transaction, so there is no
  window in which the marker exists and the sale does not, or vice versa. If the domain logic
  fails, the marker rolls back too and a retry gets a genuine fresh attempt — correct, because
  nothing was applied.
- **A replay returns the stored `response_body` verbatim** — identical status, identical entity
  ids. The retry is indistinguishable from the original success. It does not return `409`; a
  `409` would be a lie, because the caller's intent *was* carried out.
- **A replay with a different `request_hash` is not a retry.** Same key, different payload means a
  client bug or key reuse. Reject with `409 IDEMPOTENCY_KEY_REUSE`, **apply nothing**, and alert.
  Silently applying the second version here would be exactly the corruption this table exists to
  prevent.

  This only works if "the same payload" is a defined thing, and it was not. **Canonicalisation is
  RFC 8785 (JCS)**, with every monetary and quantity value serialised as a **decimal string**
  (`"5000000"`, never `5000000` — a JSON number is float64 on parse and that is the `ADR-0004`
  trap). The canonical form is a versioned, frozen artefact with its own test vectors. Critically,
  **the device computes `request_hash` at enqueue time and stores it in the outbox**, so a client
  upgrade cannot change the hash of an already-queued mutation. Without that rule every rollout —
  and the rollout window is measured in days, because the queue is — would add a field, reorder a
  key or change a serialisation, hash differently on retry, return `409`, and park a day's takings
  across the fleet behind an alert storm. Every mutation also carries `schema_version`; the server
  supports **N−2** and answers an unsupported version with a **retryable** `426 UPGRADE_REQUIRED`,
  never a discard.

**Client side**, the rule is a single sentence: *complete the local transaction only on a
definitive answer.*

```ts
// Every domain write goes through mutate(), which writes the optimistic rows AND
// one outbox_meta row (mutation_id, type, hlc, base_row_hlc, payload) in ONE
// local transaction. One PowerSync CRUD transaction == one domain mutation.
async function uploadData(db: AbstractPowerSyncDatabase) {
  const tx = await db.getNextCrudTransaction();
  if (!tx) return;
  const m = readOutboxMeta(tx);

  const res = await api.post('/sync/mutations', {
    mutation_id:    m.mutationId,      // UUIDv7 — generated ONCE, reused on every retry
    type:           m.type,
    hlc:            m.hlc,             // ordering timestamp (§3.4)
    base_row_hlc:   m.baseRowHlc,      // compare-and-set token (§3.5)
    device_id:      DEVICE_ID,
    device_wall_at: new Date().toISOString(),  // UNTRUSTED — display only
    payload:        m.payload,
    // tenant_id is deliberately ABSENT. The server takes it from the JWT. (§2.1)
  });

  // The response taxonomy is EXPLICIT (§3.3.4). "4xx that is not 401" was not, and it
  // discarded every conflict, every stale-permission write and every partial-rollout
  // validation bug as poison.
  if (res.ok)            return tx.complete();          // applied OR routed_to_review
  if (res.status >= 500 || res.networkError) throw retryable();
  if (RETRYABLE_4XX.has(res.status))         throw retryable();  // 401 408 409 423 425 426 429
  return deadLetter(tx, res);                           // definitive rejection — §3.3.4
}
```

Retention: `write_log` **rows** are permanent (§4.2.2); only `response_body` and `request_hash` are
pruned, at 90 days. Replay protection past that point comes from `device_write_watermark`
(§3.11.3), which is permanent and tiny, so there is no retention cliff and no bulk-confirm path.

### 3.3.4 Head-of-line blocking, and the response taxonomy that makes it safe

PowerSync's queue is ordered. A mutation the server *deterministically* rejects (a validation bug,
a schema mismatch after a partial rollout) will be retried forever and **every mutation behind it
stops syncing.** One malformed record and an outlet goes dark while appearing to work fine.

The first version of this section answered that with "a `4xx` that is not `401` is definitive", and
that rule was wrong in three ways at once, each of which loses real sales:

- **A conflict is a `4xx`.** The canonical credit-limit case in §3.6.1 — the flagship example of
  this entire section — would have returned a 4xx, been quarantined locally, dropped from the
  queue, and shown the operator *"1 record could not be sent"* instead of opening a review.
- **`403` is not definitive.** A device on an offline lease whose permission snapshot is one
  revision stale gets 403 during an ordinary role-propagation race. Quarantining it discards a
  legitimate sale.
- **`400` during a partial rollout is not definitive either.** The document names a schema mismatch
  mid-rollout as the archetypal cause and then makes the response *discard every affected sale on
  every device* rather than block loudly.

And the quarantine itself had no durable path: the mutation left PowerSync's durable queue for a
local `poison_mutations` table, and "the server is told" over the network that had just failed. A
wipe, a replacement or an OPFS eviction before that report landed and the sale was gone with no
server-side trace — converting head-of-line blocking, which is loud and recoverable, into silent
per-device loss.

**The taxonomy, stated once and enumerated:**

| Response | Meaning | Client action |
|---|---|---|
| `200 {status:"applied", ...}` | applied | complete |
| `200 {status:"replayed", ...}` | already applied; stored body returned verbatim | complete |
| **`200 {status:"routed_to_review", review_id}`** | **a conflict was detected and a review opened.** The write is *accepted*; its effect is pending a human. | complete |
| `401` | token expired | refresh, retry |
| `403` | permission denied — possibly a stale snapshot | **retry with backoff**, escalate after N attempts |
| `408 · 425 · 429 · 503` | timeout / too early / throttled / unavailable | retry with backoff |
| `409 IDEMPOTENCY_KEY_REUSE` · `409 RETRY_LATER` | same key different payload · concurrent first-writer still committing | retry with backoff; the first also alerts |
| `423 LOCKED` | period locked, tenant suspended, device sealed | retry with backoff |
| `426 UPGRADE_REQUIRED` | `schema_version` older than N−2 | retry after update |
| **`422 MUTATION_REJECTED`** | **the only definitive rejection.** The payload cannot ever be applied — a malformed body, a violated invariant that is not a conflict. | dead-letter |

**Dead-lettering is durable server-side before the queue entry is released.** The client POSTs the
raw payload to `/sync/dead-letter` and completes the CRUD transaction **only on a `2xx` from that
endpoint**. If dead-lettering fails, the mutation stays in the queue and the queue stays blocked —
which is the correct failure, because a blocked queue is visible at the counter and a lost sale is
not. Server-side the entry becomes a `rejected_mutation` review item at severity 1. The device
shows a banner, the metric is monitored, nothing is discarded.

This is not a hypothetical edge. It is the most likely way this system fails in production, and it
gets a named drill (§3.9).

---

## 3.4 Logical clocks

Wall clocks on cheap Android tablets in district towns drift, get reset by users, and are sometimes
hours or years wrong. **Nothing orders by device wall-clock time.** Ever.

### 3.4.1 Hybrid logical clocks, not Lamport

**Decision: HLC.** Lamport counters are correct for causality and unusable for everything else:

- They carry no relation to real time, so nobody reading an audit trail can correlate an event to
  anything that happened in the world.
- You cannot window or partition on them — §3.2.4's sync window and the 90-day retention both need
  a timestamp that means roughly what a calendar means.
- A device offline for a week returns with a low counter and its events sort as *old* relative to
  everything that happened online. Causally defensible, operationally wrong: it inverts every
  tie-break heuristic we actually want.

HLC gives all of that back at negligible cost. `(wall_ms, ctr, node)`: track physical time when the
clock is sane, increment the counter when it is not, never go backwards, and **advance the local
clock on every timestamp received from a peer.** That last property is the one that matters here —
a tablet whose clock is set to 2019 converges to within milliseconds of real time on its *first*
contact with the server and stays there, without anyone touching Android settings.

```sql
CREATE TYPE hlc AS (wall_ms bigint, ctr integer, node uuid);
-- Postgres compares composite values field-by-field, which is exactly HLC order.
-- If the pinned version lacks a usable default btree opclass for the composite,
-- fall back to three plain columns (hlc_wall, hlc_ctr, hlc_node) plus a composite
-- index. Identical semantics; only the ergonomics change.
```

`node` is the `device_id`, which makes the order **total** — no two events ever compare equal, so
every tie-break is deterministic and replayable rather than dependent on arrival order.

**The server stamps the authoritative HLC. The client's is evidence, not order.** The first version
of this section said a client HLC more than 60 seconds ahead of the server would be "recorded as
submitted" with a `clock_skew_ms` flag and a device-health event. Combined with "advance the local
clock on every timestamp received from a peer", that is a permanent, unrecoverable corruption path
with an alert attached to it:

> One tablet has its date set to 2030 — the common real cause is a user "fixing" an expired-
> certificate warning. Its writes are *accepted* carrying a 2030 HLC. They replicate to the server
> and down to every other device. Every receiving device takes `max(...)` and advances its own HLC
> wall to 2030, monotonically, forever. Every subsequent legitimate write now sorts below the
> archival mark and is invisible; every UUIDv7 generated from the HLC's physical component sprays
> into a distant keyspace region — the exact defect §3.7.3 exists to prevent; every tie-break in
> §3.6 inverts; every retention window is computed against a fictional present. The device-health
> event is an alert about a corruption that has already propagated irreversibly.

So the clamp moves to the ingest boundary, before the value can enter the shared order:

- **Client:** `wall_ms = max(Date.now(), last_seen_hlc.wall_ms)`, as before — but a client HLC is
  now only ever an *assertion*.
- **Server:** the HLC written to `write_log` and to every row is **generated server-side at
  ingest**, from the server clock, advanced past the highest HLC already accepted for that tenant.
  The client's value is stored as `claimed_hlc` (untrusted; display and forensics only) with
  `clock_skew_ms` alongside.
- **Beyond a bounded skew the write is refused, not flagged.** More than **±24 hours** returns a
  retryable `409 CLOCK_RESYNC_REQUIRED`; the client resynchronises against the server's time
  response and retries the identical queued mutation. Nothing is lost — the queue is untouched —
  and nothing poisoned enters the order. Skew within tolerance is accepted and recorded.
- **Ordering never depends on a device clock, so this costs nothing we wanted.** Causality inside a
  device is preserved by the per-device counter and by upload order; `business_date` (below) is
  what determines the accounting period; and the device's own belief about the time survives in
  `device_wall_at` for the operator.

Devices with persistent skew are surfaced to their location's manager — they are also the devices
printing wrong times on customer receipts, so this is a business-visible defect, not only a data
one.

### 3.4.2 Four timestamps, named so misuse is obvious

Every event-bearing row carries all four. The naming is the control.

| Column | Trust | Purpose | Never used for |
|---|---|---|---|
| `hlc` (composite) | **Authoritative** | ordering, tie-breaks, conflict tie-breaks, sync windowing | display |
| `device_wall_at timestamptz` | **UNTRUSTED** (say so in the column comment) | showing the operator what their own device thought the time was | ordering, reporting periods, tax point, any `WHERE` in a report |
| `server_received_at timestamptz` | Trusted | sync latency, SLA measurement, forensics | the time of trade — it is the time of *sync* |
| `business_date date` | **Human-asserted** | the trading day the event belongs to: GL period, VAT tax point, daily sales report | ordering |

`business_date` is the subtle one and the most important. **It comes from the open cash session at
the location, not from the device clock** (`app.cash_session`, §4.8a). A human opens the till for a
trading day; every sale in that session inherits the date.

**But an unvalidated human input is not a control, and as first written this had none.** The claim
that a tablet "*cannot* post a sale to the wrong accounting period" was false: nothing bounded a
session's duration, nothing checked its date against the server, nothing stopped it being opened
into a closed period, and nothing closed it automatically. A till nobody closes over a long weekend
stamps a week of trade with one `business_date`, and the whole week posts to one day and one VAT
period. The design relocated the risk from a machine clock to an unvalidated human input and then
called it solved. The constraints, now stated:

- **One calendar day maximum per session.** `CHECK (business_date = ...)` plus a hard auto-close at
  local midnight (`location.timezone`), with an explicit carry-over prompt that opens a *new*
  session for the new date rather than extending the old one.
- **Validated against server time whenever the device is online at open.** More than ±1 day out and
  the open is refused with the server's date shown. Offline opens are permitted — they must be —
  and are flagged `opened_offline = true` for the close report.
- **Refused into a closed or locked period** (§5.2.6), which is only meaningful because §3.11.4
  gives the close process a completeness attestation to gate on.
- **`sale.cash_session_id` is `NOT NULL`.** There is no path to a sale without a session, so there
  is no path to a `business_date` that was not asserted by a named human at a stated time.

This is what makes `ADR-0007`'s effective-dated rates work offline: a sale made on 30 June and
synced on 3 July has `business_date = 2026-06-30`, so it prices against June's rates.

**The full tax basis is snapshotted, not just the rate.** §7.2.4 proves with a dated Ghanaian
example that `(tax_code, rate)` is insufficient: on 1 January 2026 the *base* changed and **no rate
did**. A sale captured offline on 28 December and re-derived later from `(tax_code, rate)` alone
reproduces a different total, and §7.3's recompute-and-flag job would report a divergence it could
not explain. So each `sale_line_tax` row (§4.8) carries `tax_component_id`, `rate_bp`, `base_kind`,
`base_includes`, `rounding_level`, `rounding_mode`, `base_minor`, `tax_minor` and the identity of
the `tax_rate` row used. §3.7.4's own rule — *any row a completed document references is
denormalised into the document at capture* — was stated and then not applied to the tax parameters;
it is now.

**Who computes the total, and what happens when the two disagree.** The device computes and prints;
**the server recomputes every monetary figure from the snapshotted basis and compares against the
device's captured total, byte for byte.** Equality is an invariant. Inequality is a severity-1
`receipt_recompute_mismatch` review — never a silent overwrite of either side, because the printed
receipt is in a customer's hand and the ledger is the book of account, and quietly preferring one
to the other is how a stale device build writes the number that posts. `CLAUDE.md` §2.3 requires
rounding to be explicit at every boundary; the device→server write path is the boundary this
section owns, and it was the only one left implicit.

---

## 3.5 Conflict detection

Worth stating because it removes a large body of machinery: **we do not need CRDTs or version
vectors.** Every write funnels through one Postgres, so Postgres is the single serialisation point
and a per-row compare-and-set detects every concurrent edit exactly.

- Every mutable row carries **`row_hlc hlc`** — the HLC of the write that produced its current value.
- Every mutation against a mutable row carries **`base_row_hlc`** — the `row_hlc` of the version the
  user was actually looking at when they decided.
- Server: `UPDATE … WHERE row_hlc = :base_row_hlc`. Zero rows affected → the user decided against a
  stale view → **concurrent modification**, routed by the taxonomy in §3.6.

That is the whole detector. HLC is *not* used to detect concurrency — a total order cannot — it is
used to order and tie-break *after* concurrency has been detected by the CAS.

Append-only rows (movements, AR transactions, sale lines) have no `row_hlc` and no CAS, because
they are never updated. They cannot conflict. That is the point of §3.7.

**Detection is the easy half. The hard half is what happens next, and the answer is usually "a
human."**

---

## 3.6 Conflict taxonomy

Every class below is a row in a `conflict_classes` table — the resolution rule, the severity, the
required permission and the expiry policy are **data, declared once**, not judgement exercised at
runtime. Tenants may tighten a class (auto → review); a tenant may never loosen a severity-1 class.

`AUTO` = converges by construction or by a stated deterministic rule.
`AUTO+FLAG` = applied automatically because reality has already happened, and an exception is raised.
`REVIEW` = goes to §3.6.2. Never silently overwritten.

| # | Entity / field | Conflict | Outcome | Rule / rationale |
|---|---|---|---|---|
| 1 | `stock_movements` | Two devices append movements for one SKU/location while offline | **AUTO** | No conflict exists. Both rows land; on-hand = snapshot + Σ movements. Intent, not outcome (§3.7). |
| 2 | Derived on-hand goes negative after merge | Both outlets sold the last 3 bags | **AUTO+FLAG** | Both sales stand — the cement physically left the building and you cannot un-sell it. A `negative_stock` exception goes to the outlet manager for a recount. The record was wrong, not the sale. |
| 3 | `stock_counts` (a stocktake — an *outcome*) | Two overlapping counts of one SKU/location | **AUTO** within tenant tolerance (later HLC becomes the baseline, both retained); **REVIEW** beyond it | A stocktake is an assertion about the world at a time. Two assertions that disagree by more than tolerance is a real business problem, usually theft or a miscount. |
| 4 | `sales` uploaded twice | Retry after ambiguous failure | **AUTO** | Idempotency key (§3.3). Not a conflict. |
| 5 | `sales` — void vs. settled | A void arrives for a sale already paid elsewhere | **REVIEW** (sev 1) | Money moved. No automatic answer exists. |
| 6 | **`credit_limits.limit_minor`** | **Two locations set different limits while both offline** | **REVIEW (sev 1) — always** | **The canonical case. §3.6.1.** No auto rule. Not LWW. Not "lower wins". |
| 7 | `customer` descriptive fields (phone, address, contact) | Two edits | **AUTO** if the declared changed-field sets are disjoint; **REVIEW (sev 4)** if they intersect, auto-resolving to latest HLC after 14 days with an audit note | A phone number is not a risk decision. *Corrected on review:* "field-level merge by HLC" is not implementable with one `row_hlc` and a whole-row CAS — it cannot tell a phone-only edit from a phone-and-address edit, and a payload carrying the whole row overwrites the other party's field with a stale value that looks intentional. So a mutation against a mutable row **must declare `changed_fields text[]` and carry the base value of each**; merge is per declared field, and disjointness is decidable rather than assumed. |
| 8 | `customers.credit_hold` | One location sets the hold, another clears it | **AUTO+FLAG → hold wins immediately, and REVIEW (sev 2)** | Asymmetric risk. Wrongly holding costs a phone call; wrongly releasing costs a bad debt. Resolve to the safe state *and* surface it. |
| 9 | `ar_transactions` (invoices, payments) | Two receipts for one customer at two locations | **AUTO** | Append-only. Balance = Σ. Cannot conflict. |
| 10 | Credit sale breaching the limit after merge | Each location was within limit locally; combined is over | **AUTO+FLAG** → over-limit exception to Accounts | Same logic as #2 — the goods are gone. This is inherent to offline credit and drives the location sub-limit design. See Concern 4. |
| 11 | `products`, `price_list_items` | HQ edit vs. an outlet edit | **Cannot occur** | Catalogue and price writes are permission-restricted to HQ roles. The best conflict resolution is a permission design in which the conflict is unreachable. |
| 12 | Price change vs. an offline sale at the old price | HQ raises cement while Wenchi is offline | **AUTO — not a conflict** | The sale line carries its own `unit_price_minor`, `tax_code` and resolved rate. It does not reference a live price. §3.4.2. |
| 13 | `stock_transfers` | Sender dispatches 20 bags; receiver counts 18 | **AUTO+FLAG** | Not a conflict — an expected discrepancy. Both legs are independent movements. The variance raises a `transfer_variance` exception to the regional manager. A transfer modelled as one mutable object would have been a conflict; modelled as two intents it is a business event. |
| 14 | Receipt / invoice numbers | Two devices allocate the same number | **Structurally improbable, and detected** | Per-device block allocation (§3.7.5). *Downgraded on review:* "impossible" was false under the failure this document itself calls its sharpest edge. `consumed_upto` lives on the device; if OPFS is evicted or the PWA is reinstalled on the same enrolled device, the local cursor resets while the server still shows the block live, and the device reissues numbers it has already printed — on a document type that may be a statutory VAT invoice. So: on every reconnect the device reports `consumed_upto`; the server **rejects any regression**, burns the remainder of that block, issues a fresh one, and sends the overlap range to review at severity 1. |
| 15 | `user_role_assignments`, `user_location_scope` | Two admins change one user's role or scope | **REVIEW (sev 1)**; pending state is the **more restrictive** of the two | Security-relevant and asymmetric, like #8. |
| 16 | Soft delete vs. concurrent edit | One device deletes a customer, another edits it | **AUTO** if the delete is causally later (CAS succeeds); **REVIEW (sev 3)** otherwise | Deletes are soft, so nothing is destroyed either way and the stakes are recoverable. |
| 17 | `cash_sessions` | The same till opened on two devices | **REVIEW (sev 2)** | Two open sessions on one till means the cash count will not reconcile. |
| 18 | GL postings (Phase 3) | — | **Cannot occur** | Postings are **derived server-side** from settled documents and never captured on or synced from a device. The GL is a consequence, not an input. This boundary is load-bearing and must not erode. |
| 19 | `conflict_reviews` themselves | Two reviewers resolve one conflict | **AUTO** | CAS on `status`; the second reviewer is told "already resolved by Ama at 09:14". A UI outcome, not a data conflict. |

### 3.6.1 The canonical hard case, worked

Kofi Mensah Contractors, limit GH₵50,000 (`5_000_000` pesewas, `ADR-0004`).

- **Tuesday, Sunyani RDC, offline.** The regional manager raises the limit to GH₵80,000 for the
  Ampomah school project. `base_row_hlc` = HLC of the 50,000 version.
- **Wednesday, Techiman Flagship, offline.** The outlet manager lowers it to GH₵30,000 because two
  invoices are past 60 days. Same `base_row_hlc`.
- **Thursday.** Both sync.

Sunyani arrives first, CAS succeeds, limit becomes 80,000, `row_hlc` advances. Techiman arrives,
CAS fails. Then:

1. **Techiman's write is not applied.** Obviously.
2. **Sunyani's write is reverted to the ancestor, 50,000.** Less obviously — and this is the
   deliberate choice. Leaving Sunyani applied means *first-to-sync wins*, which is arrival-order
   dependent and therefore arbitrary; here it would be arbitrary in the dangerous direction,
   leaving an 80,000 limit standing on a customer another manager considers a 30,000 risk. **The
   ancestor is the last value both parties agreed on and the only defensible neutral position.**
   Its cost is real: Sunyani's manager saw his change take and then saw it revert. So he is
   notified, by name, with the reason. Reverting silently would be as bad as overwriting silently.

   **Finding the ancestor requires a version history, which this design did not have.** A row
   carried a current value and a `row_hlc` and nothing else; `conflict_review.ancestor_value` had
   to be populated from something that did not exist. So: **`app.row_version (tenant_id, entity_table,
   entity_id, field_path, hlc, value_jsonb, write_id, actor_user_id)`**, append-only, written on
   every mutable-row write, retained for at least *max offline lease + review expiry horizon* (a
   tenant-configured value, floor 90 days). Four consequences the worked example glossed:
   - **A value whose ancestor cannot be reconstructed is never auto-reverted.** It goes straight to
     review with the current value frozen and both proposals attached.
   - **Third parties join the open review, they do not open a second one.** Kintampo's 60,000,
     arriving later against the same base, is appended to the existing review's `proposals`. An
     N-party merge is one decision, not N−1 pairwise ones.
   - **The revert is a server-originated write** — `origin='SERVER'`, a platform system actor, a
     server-generated HLC. That is why `write_log.actor_user_id` is nullable (§3.3.2): a schema
     that forced a user id here would have attributed an automatic reversion to a human.
   - **Severity-1 reviews cannot be resolved offline.** Two offline reviewers both resolving one
     review is a resolution-of-a-resolution recursion that class #19's CAS does not close, because
     the loser's *value* write has already been applied locally. Severity-1 resolution requires
     connectivity; the queue says so on the device.

   And one case the revert does not fix: between Sunyani's write landing at 09:00 and Techiman's
   arriving at 09:05, an online till at Kumasi may have sold GH₵70,000 on credit against the 80,000
   limit. Reverting to 50,000 leaves the customer over limit with no exception raised, because
   class #10 covers offline merges only. **The revert therefore re-runs the exposure check and
   raises a `credit_exposure_exception` if the reverted limit is now breached** (§6.7).
3. **A severity-1 review opens** holding all three values with full provenance — who, which
   location, which device, both HLCs, both untrusted wall-clock times with skew, both stated
   reasons — plus a snapshot of the customer's balance, ageing and 12-month purchase history, so
   the decision is reproducible in audit rather than reconstructed later.
4. **Until it is resolved:** the customer record shows *"Credit limit under review"* as a
   field-level marker at every till. Credit sales are permitted **up to the ancestor 50,000** and
   blocked above it, with an on-screen instruction to call Accounts. Head of operations can
   override with a mandatory note.
5. **Resolution** is applied as an ordinary mutation with its own `mutation_id`, HLC and audit row —
   through the normal write path, subject to the normal permission checks, syncing by the normal
   mechanism. **The review queue has no back door into the data.**

Note what is *not* here. There is no "take the minimum" rule. It is superficially attractive and it
is wrong twice over: it silently discards a deliberate commercial decision by a regional manager,
and it can strand a contractor mid-project on a Friday afternoon with no explanation and nobody
accountable for the choice. A credit limit is a risk decision. The system's job is to make sure a
person makes it, with the facts in front of them.

### 3.6.2 The review queue

A review queue nobody works is silent overwriting with extra steps. So it is designed as a
product surface, not a table.

**Shape**

```sql
CREATE TABLE conflict_reviews (
  tenant_id           uuid        NOT NULL,
  id                  uuid        NOT NULL,        -- UUIDv7
  conflict_class      text        NOT NULL,        -- FK -> conflict_classes (§3.6)
  severity            smallint    NOT NULL,        -- 1 blocking .. 4 informational
  entity_table        text        NOT NULL,
  entity_id           uuid        NOT NULL,
  field_path          text,                        -- 'limit_minor'; NULL = whole row
  ancestor_value      jsonb,                       -- last value both parties agreed on
  proposals           jsonb       NOT NULL,        -- [{mutation_id, value, actor, role,
                                                   --   location, device_id, hlc,
                                                   --   device_wall_at, clock_skew_ms,
                                                   --   server_received_at, reason, context}]
  pending_state       text        NOT NULL,        -- 'ancestor' | 'safe_default' | 'first_applied'
  pending_value       jsonb       NOT NULL,        -- what the row actually reads right now
  required_permission text        NOT NULL,        -- routes the queue (§3.2.3)
  location_scope      uuid[],                      -- which locations' reviewers may see it
  status              text        NOT NULL DEFAULT 'open',
                                                   -- open|claimed|resolved|auto_resolved|expired
  claimed_by          uuid, claimed_at   timestamptz,
  resolved_by         uuid, resolved_at  timestamptz,
  resolution          jsonb,                       -- {choice, value, note}
  opened_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  escalate_at         timestamptz NOT NULL,
  escalation_level    smallint    NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX ON conflict_reviews (tenant_id, status, severity, opened_at);
```

Three corrections to that shape, all from review:

- **Money in `jsonb` is money as a string.** `ancestor_value`, `proposals`, `pending_value`,
  `resolution` and `response_body` all carry monetary values. `JSON.parse('{"limit_minor":5000000}')`
  yields a float64 — the precise thing `ADR-0004` calls fatal — and it lands on the path where a
  human reads a credit limit and re-enters it. Every money and quantity value inside every `jsonb`
  column is a decimal **string**, and the `money-test-engineer` lint rule covers jsonb payloads as
  well as columns.
- **`location_scope` was declared and never used.** The bucket filtered on permission alone, so
  every holder of `credit.read` at all 25 outlets received a credit-limit review — with balance,
  ageing and 12 months of purchase history embedded in a `jsonb` blob no column-level control
  touches. §3.2.3's "the number never leaves the server" was defeated by §3.6.2 in the same
  document. Scope is now normalised into `conflict_review_location (tenant_id, review_id,
  location_id)` and the data query filters on it (array containment in a data query is not
  something to assume a sync engine supports).
- **The heavy `context` snapshot is not synced.** It is stored server-side in
  `conflict_review_context` and fetched when a reviewer *opens* the item, online. What syncs is
  `proposals_summary` — actor, role, location, HLC, the proposed value, the stated reason. The
  reviewer still gets the full snapshot (balance, oldest invoice age, payment history *as at the
  moment the conflict opened*, so the decision is auditable rather than reconstructed), but a
  sev-1 review does not put a customer's credit history on sixty-five tablets.

**Who is notified.** Routing is **by permission and location scope, never by named individual** —
naming a person is precisely how a queue rots the first time someone takes leave. Three channels:

1. A badge on the review screen for every eligible user, delivered by the `tenant_reviews` bucket
   (§3.2.3) so it works on a device that is itself intermittently connected.
2. **An out-of-band channel at severity 1 and 2**, whose identity is a **per-tenant notification
   preference**, not a platform rule. For tenant #1 that will be SMS, because SMS reaches a manager
   in Bono Region and email does not — but "this is Ghana" is a fact about one tenant's market, and
   writing it into platform behaviour is the same defect as an `RDC` branch (`ADR-0006`,
   `CLAUDE.md` §2.9).
3. A daily digest of everything open, to every eligible reviewer, at a tenant-configured local time.

**Notifications are deduplicated and rate-limited.** Upload-before-download means a week-old queue
arrives with a week-stale `base_row_hlc` on every mutable-row edit, so a long partition produces a
*burst* of CAS failures — and the first design put an SMS on each one. Reviews are therefore
deduplicated per `(entity, field_path)`: forty edits to one customer produce **one** review with
forty proposals, and each reviewer has a per-hour notification ceiling with an overflow digest.

**How it is worked.** Sorted by severity, then age. Claim (CAS on `status`). Side-by-side proposals
with full provenance. Choose: accept A, accept B, enter a third value, or keep the ancestor. **A
note is mandatory at severity 1 and 2**, and it lands in the entity's audit trail, not only in the
review record — six months later the question will be "why is this contractor's limit 65,000?" and
the answer must be attached to the customer, not buried in a resolved conflict.

**What the record looks like while pending.** Not a page-level warning — a **field-level** one, on
every surface that reads it: POS customer lookup, credit check, HQ reporting. `has_open_conflict`
and `conflict_review_ids` sit on the entity, maintained by trigger and synced. And crucially the
marker is not cosmetic: **it changes what the till will do**, per §3.6.1 step 4. Disputed values
gate the actions that depend on them.

**If nobody works it for a week.** Each class declares an expiry policy in `conflict_classes`:

| Policy | Applies to | Behaviour |
|---|---|---|
| `escalate_only` | severity 1 — credit limits, settled-sale voids, role/scope changes | **Never auto-resolves.** Escalates up a **tenant-configured chain of *permissions***, stored per `conflict_class` as `escalation_step (conflict_class, level, after_interval, permission)`. Tenant #1's template seeds four steps at 24h / 72h / 7d / 14d resolving to its own role names — *those names are template data, not platform policy; "outlet manager → regional manager → head of operations" hard-coded into a platform expiry rule is `CLAUDE.md` §2.9's failure mode exactly.* At the final step **the pending state hardens to the safe state** (for a credit-limit dispute, the customer goes to `credit_hold`). Inaction has a consequence that is safe, loud and attributable — not silence. |
| `safe_default_after(n)` | asymmetric-risk classes (#8, #15) | Already sitting at the safe value; after *n* days that value is formally accepted with an audit entry "auto-accepted after *n* days without review". |
| `lww_after(n)` | low-stakes descriptive (#7) | After *n* days (default 14) the later HLC wins, with an audit note. Status becomes `auto_resolved` — deliberately distinct from `resolved`, so the metric stays honest. |

**And it is measured.** `oldest_open_severity_1_age` and `open_conflicts_by_age` are on the tenant
health dashboard and on operational alerting. A severity-1 conflict older than seven days is a
support ticket raised by us, to the tenant. If there is one number that tells us whether this entire
design works in the field, it is that one.

---

## 3.7 Convergent data design

The cheapest conflict is one that cannot happen. Most of this section is about arranging that.

### 3.7.1 Append-only movement logs over mutable counters

Two offline outlets decrementing `products.quantity_on_hand` is unresolvable. Two outlets appending
movements converges by construction.

```sql
CREATE TABLE stock_movements (
  tenant_id       uuid   NOT NULL,
  id              uuid   NOT NULL,         -- UUIDv7, client-generated (§3.7.3)
  location_id     uuid   NOT NULL,
  product_id      uuid   NOT NULL,
  qty_delta       bigint NOT NULL,         -- SIGNED, scaled integer in the product's stocking unit.
                                           -- Never float, never numeric. ADR-0004 / Q7.
  qty_scale       smallint NOT NULL,       -- SNAPSHOT. Was a lookup into product_units, which is
  uom_code        text     NOT NULL,       -- the same referential-survivability hazard §3.7.4
                                           -- solves for prices and did not solve for quantity:
                                           -- qty_delta=2500 is 2.5 t at scale 3 and 25.00 at
                                           -- scale 2, and the row could not say which. One unit
                                           -- correction would silently reinterpret ten years of
                                           -- movements by a factor of ten, with no error anywhere.
  movement_type   text   NOT NULL,         -- SALE|RETURN|RECEIPT|TRANSFER_OUT|TRANSFER_IN
                                           -- |ADJUSTMENT|COUNT_BASELINE|WRITE_OFF
  reason_code     text,                    -- required for ADJUSTMENT and WRITE_OFF
  source_doc_type text, source_doc_id uuid,
  hlc             hlc         NOT NULL,    -- ordering (§3.4)
  business_date   date        NOT NULL,    -- from the cash session, not the clock
  device_wall_at  timestamptz NOT NULL,    -- UNTRUSTED
  server_received_at timestamptz,
  device_id       uuid NOT NULL,
  actor_user_id   uuid NOT NULL,
  mutation_id     uuid NOT NULL,
  sync_epoch      integer NOT NULL,        -- windowing (§3.2.4)
  PRIMARY KEY (tenant_id, id)
);
REVOKE UPDATE, DELETE ON stock_movements FROM app_writer;
-- plus a BEFORE UPDATE OR DELETE trigger that raises, because a future GRANT is one
-- migration away and this invariant is worth two belts.
```

**No UPDATE. No DELETE.** A mistake is corrected by a compensating movement, exactly as a ledger is
corrected by a reversing entry. Using the same discipline for stock as Phase 3 will use for the GL
is worth something on its own: one mental model, one audit story, one set of habits.

On-hand is derived:

```
on_hand(location, product)
  = latest snapshot.qty
  + Σ qty_delta FROM stock_movements WHERE hlc > snapshot.as_of_hlc
```

`stock_balance_snapshots (tenant_id, location_id, product_id, as_of_business_date, as_of_hlc, qty)`
is written nightly, server-side, and does two jobs: it bounds the local scan on a 2GB tablet, and it
lets §3.2.4 drop old movements off the device without losing the balance.

Be honest about the wrinkle: a movement can arrive *after* a snapshot was computed but carry an HLC
*before* it — a device that was offline for two days. So the invariant is **snapshots are advisory
and always recomputable; the movements are the truth.** A late arrival marks affected snapshots
`stale` and a recompute job rebuilds them. Any snapshot in the system can be rebuilt by replay, and
a test asserts exactly that (§3.9).

**The staleness must reach the device, and originally it did not.** Between the late arrival and
the recompute, every till computing `snapshot + Σ(hlc > as_of_hlc)` silently omits that movement
with no marker — and the "snapshot replay" drill asserts a byte-identical *rebuild*, so it never
catches the window. So: `stock_balance_current` carries **`is_stale boolean`** and it syncs. A
device holding a stale row **falls back to full local replay** over the movements it holds and, if
it cannot (the window does not reach back far enough), shows *"stock figure recalculating"* rather
than a number it cannot stand behind. Recompute latency is a stated SLO — **within 60 seconds of
the late arrival committing** — and is alerted on, because a stale flag that persists is a broken
job, not a slow one.

### 3.7.2 Model intent, not outcome

| Do not sync | Sync instead |
|---|---|
| `products.quantity_on_hand = 42` | `stock_movements(qty_delta, reason)` |
| `customers.balance = 412000` | `ar_transactions(invoice / payment / adjustment)` |
| a recomputed `sale.total` | sale lines carrying captured unit price, quantity, tax code and resolved rate; the total is derived and then stored for audit |
| `set stock to 42` | `COUNT_BASELINE(counted = 42)` **plus** `ADJUSTMENT(delta = 42 − on_hand_at_count, reason = STOCKTAKE_VARIANCE)` |

That last row is the pattern worth internalising. A stocktake is the one genuinely
outcome-shaped operation in the system, and it is decomposed into an event ("a human counted 42 at
this HLC") and its consequence ("therefore the book was out by −3"). The variance is computed on the
device from the device's view, so a stale view produces a wrong variance — which is exactly why
conflict class #3 sends disagreeing counts to review rather than trusting the later one.

### 3.7.3 Client-generated UUIDv7 identifiers

Everything a client creates gets its ID on the client. A device that cannot reach the server cannot
be given one, and an ID assigned later means the local rows have to be rewritten — which means
foreign keys have to be rewritten, which is a migration running on a tablet at a counter.

**v7, not v4**, because these are the biggest and most append-heavy tables in the system. A v7's
time-ordered prefix keeps B-tree inserts at the right-hand edge of the index; v4 scatters them
across the whole keyspace and shreds the buffer cache. **Not `bigserial`**, for the reason above.
**Not `(device_id, device_seq)`**, which works but makes every foreign key two columns.

One non-obvious hazard: **UUIDv7 embeds a timestamp taken from an untrusted device clock.** Two
consequences. First, the v7 prefix is never treated as data — `hlc` is the ordering timestamp and
nothing reads a time out of an ID. Second, and this is the fix worth writing down: **generate v7
from the HLC's physical component, not from `Date.now()`.** The ID then inherits the clamped,
server-corrected clock, so a tablet set to 2019 does not spray inserts into a distant region of the
index. Collision risk is a non-issue at 74 bits of per-millisecond randomness across ~65 devices.

### 3.7.4 Soft deletes

`deleted_at timestamptz`, `deleted_by uuid`, `deleted_mutation_id uuid`. Never a hard delete — one
that syncs cannot be recovered, and on this platform "recovered" would mean from a backup of a
shared-schema database, which is a restore of everyone's data.

Sync rules carry `deleted_at IS NULL` in their data queries, so a soft-deleted row leaves its bucket
and PowerSync removes it from the device. Tombstone propagation for free, with no tombstone table.
A device cannot then distinguish "deleted" from "no longer in my scope" — which is fine, because in
both cases it must stop showing it.

The real hazard is referential survivability: a completed sale line pointing at a product that has
since been deleted, on a device where the product row is gone. So **any row a completed document
references is denormalised into the document at capture**: `product_name_snapshot`, `unit_snapshot`,
`unit_price_minor`, `tax_code_snapshot`, `customer_name_snapshot`. A reviewer will read that as a
normalisation smell; it is not. It is denormalisation for **referential survivability across a sync
boundary**, and it is also what makes a reprinted receipt match the one the customer took home.

Hard deletion exists exactly once in the platform: the per-tenant data-deletion path `ADR-0005`
requires for a departing customer. Deliberate, server-side, audited, and unrelated to this
mechanism.

### 3.7.5 Human-facing sequence numbers, allocated offline

Receipt and invoice numbers must be human-readable, per-location, and allocable with **zero**
connectivity. You cannot have all three of {globally sequential, gapless, offline-allocable}. We
choose: **per-device blocks, monotonic within a device, gaps expected and reported.**

```sql
CREATE TABLE sequence_blocks (
  tenant_id     uuid   NOT NULL,
  sequence_key  text   NOT NULL,     -- 'RECEIPT' | 'INVOICE' | 'TRANSFER' | 'CREDIT_NOTE'
  location_id   uuid   NOT NULL,
  device_id     uuid   NOT NULL,
  block_start   bigint NOT NULL,
  block_size    integer NOT NULL,    -- default 500, tenant-configurable
  consumed_upto bigint,              -- reported back by the device on sync
  issued_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  exhausted_at  timestamptz,
  PRIMARY KEY (tenant_id, sequence_key, location_id, block_start)
);
```

- The server allocates a block under a row lock on a per-`(tenant, location, sequence_key)` counter.
  **A block is never reused, never returned, and never reissued to a device that has been reset.**
- The device consumes locally with no network at all. It requests the next block when it drops below
  20% remaining **and** has connectivity. *Corrected on review:* "roughly two weeks of numbers" was
  wrong for the case that matters — 500 numbers against a flagship till's throughput (~150–200
  receipts/day at one of four tills) is **three to four days**, not two weeks. `block_size` is
  therefore tenant- and location-type-configurable with a default of 2,000 at a Flagship-class
  location, and the low-water trigger is expressed in *days of observed throughput*, not percent.
- **`consumed_upto` is device-local state that is reported, never authoritative.** On every
  reconnect the server compares the reported value against the last one; **any regression burns the
  remainder of the block, issues a fresh one, and raises a severity-1 review naming the overlap
  range** (conflict class #14).
- Format is a **jurisdiction-pack value with a tenant override**, not a platform constant.
  `ADR-0007` makes invoice numbering rules a pack concern, and the pack states whether gaps are
  permitted, whether per-location series are permitted, the required width and the overflow
  behaviour. Tenant #1's template ships `{location_code}-{prefix}-{n:06d}` (e.g. `SUN-RCT-004312`)
  — the location code makes the block boundary invisible to a human and makes a printed receipt
  self-describing — and the platform raises rather than wrapping when `n` exceeds the pack's width.
  The `sequence_key` list is likewise pack + tenant data, not a hard-coded enum.
- **Gaps are expected and documented as such.** A lost, wiped or retired device takes its unconsumed
  tail with it. `consumed_upto` lets us report precisely which numbers were never issued, which is
  what an auditor will ask for — materially better than claiming a gaplessness we cannot deliver.
- **Exhaustion must never stop trading.** A device that burns through its block while offline
  switches to an emergency form — `SUN-RCT-004999-D3F`, suffix derived from `device_id` — marked as
  such on the receipt and on the record, and reconciled on sync. The exceptional case is visibly
  exceptional.
- Never allocate by hashing `device_id` into a number space. The numbers stop looking sequential and
  humans lose the plot at exactly the moment they need to trust them.

**Open question, and a serious one.** `ADR-0007` makes invoice numbering rules a jurisdiction-pack
value. Whether Ghana's GRA accepts gapped, per-location, per-device VAT invoice numbering — and in
particular whether a VAT invoice number must be issued by GRA's electronic invoicing system at all —
is `NEEDS-HUMAN` and it **blocks Phase 1 POS design**. If GRA must issue the number, then offline
VAT-invoice issuance is impossible as designed and the POS must issue a **delivery note or proforma
offline and the VAT invoice on reconnect** — a materially different counter workflow, not a code
tweak. `compliance-gatekeeper` must resolve this before Phase 1 POS work starts, and
`product-manager` should carry it into `docs/open-questions.md`. See Concern 3.

---

## 3.8 Interaction with tenant isolation

Restating the two places sync and tenancy touch, because they are the unrecoverable ones.

1. **`tenant_id` is absent from every client payload** (§3.3.3 code sketch). It is stamped
   server-side from the verified JWT on every write. Enforced structurally: the shared mutation
   base type has no `tenant_id` field, so a handler *cannot* read one from the body.
2. **Sync rules take `tenant_id` only from `request.jwt()`.** A CI check greps the rules for
   `request.parameters()` in any tenant-scoping position and fails the build. This is a lint rule
   because it is the single highest-consequence typo in the repository.

Both are covered by §2.7's third mandatory test category, run against a two-tenant fixture, at
every read path — including the sync path, which is the read path that actually ships bytes to a
device.

---

## 3.9 Testing — with `sync-test-engineer`

Nothing here is done on reasoning alone. Real partitions, real skew, real multi-device runs, on
representative hardware. The named drills:

| Drill | Asserts |
|---|---|
| **Two-device partition** — both offline, movements on one SKU, reconnect | Phase 1 acceptance #2: reconciles or flags. Demonstrated, not asserted. |
| **Ambiguous failure** — kill the connection after the server commits, before the response | Exactly one sale exists. The retry returns the identical response body. |
| **Idempotency-key reuse** — same key, different payload | `409`, nothing applied, alert raised. |
| **Clock skew, backwards and within tolerance** — devices at −6h, +12h and 2019 | Ordering unaffected; `business_date` correct; skew flagged; UUIDv7 prefixes still sane. |
| **Clock skew, forwards and beyond tolerance** — one device at **+5 years** | *(new — the old drill tested only the safe direction.)* The write is **refused** with `CLOCK_RESYNC_REQUIRED`, the queue is intact, **no other device's HLC advances**, no row is archived early, and no UUIDv7 lands in a distant keyspace region. |
| **Offline to seal and back** — 72h full, 24h restricted, sealed on day 5, reconnect on day 7 | *(replaces "week offline"; the 30-day refresh token it assumed does not exist — §2.7.)* Cash sales continue through hour 96; credit and overrides stop at 72h; no writes accepted after seal; **every write made before the seal uploads intact**; bounded re-download; upload completes over throttled 2G. |
| **Extended lease** — `admin.offline_lease.extend` to 14 days, ~1,200 queued mutations | The extension is audited and attributable; no loss, no duplicates; the review burst is deduplicated per `(entity, field)` and notifications are rate-limited. |
| **Poison mutation** — a deterministically rejected write mid-queue | The queue keeps moving; the dead-letter POST lands server-side **before** the CRUD transaction completes; a `rejected_mutation` review opens; the outlet does not go dark. |
| **Dead-letter unreachable** — reject the mutation, then fail the dead-letter endpoint | The queue **stays blocked** and the banner says so. Nothing is completed locally. This is the correct failure. |
| **Conflict is not poison** — force a CAS failure on a credit limit | Response is `200 routed_to_review`, the queue completes normally, a sev-1 review exists, and **nothing lands in the dead-letter table**. |
| **Stale permission race** — revoke a role, then upload a write authored under the old snapshot | `403` is retried with backoff and eventually succeeds or escalates. The sale is not discarded. |
| **Client upgrade mid-queue** — enqueue 200 mutations on build N, upgrade to N+1, drain | Zero `IDEMPOTENCY_KEY_REUSE`. Hashes computed at enqueue survive the upgrade; an N−3 payload gets a retryable `426`, not a discard. |
| **Window advance** — advance the archival mark with 65 devices connected | Rows leave buckets per row. **No bucket re-download.** Bytes transferred are proportional to rows archived, not to window size. |
| **Late row below the mark** — a device offline across the boundary uploads old business dates | The rows are resident on the originating device until acknowledged and are never archived on `business_date`. |
| **Receipt-number regression** — wipe a device's local DB mid-block, reissue | The regression is detected on reconnect, the block is burned, a fresh block issues, and the overlap range is in review. No two customers hold the same number undetected. |
| **Completeness attestation** — close a period with one device dark | Close **blocks** and names the device. Excluding it requires an audited Accounts action recorded on the close (§3.11.4). |
| **Recompute mismatch** — device reports a total that disagrees with server recomputation | Severity-1 review; neither side is silently overwritten. |
| **Tenant crossing** — forge `tenant_id` in client parameters and in the payload | Zero rows. Both in sync rules and on the write path. |
| **Queue rot** — open a severity-1 conflict, advance 14 days, no reviewer | Escalation chain fires; pending state hardens to the safe value; nothing silently resolves. |
| **Sequence exhaustion** — burn a block offline | Trading continues; emergency numbers issued and reconciled. |
| **Snapshot replay** — rebuild every `stock_balance_snapshot` from movements | Byte-identical to the incremental value, for every location/SKU. |
| **Storage eviction** — fill device storage, background the PWA, return | Unsynced writes survive. See Concern 1 — this one may fail, and we need to know early. |
| **60-second SLA** — airplane mode sale, reconnect | Visible at HQ within 60s (Phase 1 acceptance #1). |

---

## 3.10 Concerns

Where I disagree, or where a decision has a cost the rest of the document should not absorb quietly.

**1. The PWA's local database can be evicted, and that is a data-loss path.** This is the
sharpest edge in `ADR-0003` and it is not a sync-layer problem — no sync engine can protect a queue
the browser deletes. On Android Chrome the local SQLite lives in OPFS under a storage quota, and a
browser under storage pressure may evict a site's data. Mitigations: call
`navigator.storage.persist()` at install and **refuse to enter offline trading mode if it is not
granted**; monitor `navigator.storage.estimate()` and warn well before the quota; keep the window
in §3.2.4 tight so we are never near it. But the honest position is that **this must be tested on
representative low-end hardware in Phase 1**, alongside the receipt-printing test `ADR-0003`
already mandates — and if eviction proves reachable in practice, that is the second finding that
would justify revisiting native Android. I am not asking to reopen `ADR-0003`; I am asking that its
Phase 1 hardware test cover this too.

**2. Shared-schema tenancy makes the sync-rule deploy an all-tenant event.** I accept `ADR-0005`
and am not relitigating it. But it has a consequence specific to this section that is worth naming:
PowerSync sync rules are **one global document for the whole service**, so a bad deploy hits every
tenant's every device at once, and rule changes force affected buckets to re-sync — a full-fleet
re-sync over 2G is an outage, not a deploy. Three mitigations belong in the rollout plan: sync-rule
changes require two reviewers and a green two-tenant isolation test in CI; deploys are scheduled
outside trading hours with a verified rollback; and if PowerSync supports staged or canary rule
deployment at implementation time, we use it. Database-per-tenant would have given blast-radius
isolation on exactly this artefact — that is a genuine cost of the shared-schema choice and it
should be recorded as one.

**3. Ghana's electronic VAT invoicing may be incompatible with offline invoice issuance.**
`NEEDS-HUMAN`, blocks Phase 1 POS design, detailed in §3.7.5. If invoice numbers must originate
from GRA's system, the offline counter workflow changes shape. This needs an answer before POS
design, not during it.

**4. Network-wide credit limits are structurally unenforceable while locations trade offline.**
Not a disagreement — a statement that should be made out loud rather than discovered. §2.2 requires
offline credit sales and the credit model implies a network-wide limit per customer. Both cannot
hold: two offline locations can each sell within the limit and jointly exceed it (conflict class
#10). The design's answer is **per-location credit sub-limits** enforced locally, with the network
limit checked server-side on sync and breaches raised as exceptions to Accounts. The consequence is
that a customer's true maximum offline exposure is **Σ(location sub-limits), not the customer
limit** — and setting those sub-limits is a risk decision for the same accountant who owns Q4, not
an engineering default. `credit-engineer` and I should agree the mechanism; the numbers are the
tenant's.

**5. A device that thinks it is online but is not is the most dangerous state in this system.**
2G and 3G in the field fail as packet loss and half-open connections far more often than as clean
disconnection, and a long-lived sync stream can sit "connected" and dead. The counter UI therefore
carries a **permanent, always-visible sync-freshness indicator** — "Synced 4 min ago" / "Not synced
for 6 hours" — derived from the last acknowledged checkpoint, never from a socket's belief about
itself. `pos-ux-specialist` owns the surface; I am asserting it is not optional chrome. A clerk who
believes stock and credit figures are live when they are six hours stale will make decisions the
data does not support, and no amount of correctness underneath fixes that.

---

## 3.11 Revisions from adversarial review

This section was reviewed against §2, §4, §5 and §6 on 2026-08-20. Six findings were blocking. What
follows is the mechanism each one forced, then the full disposition table. **Where this subsection
and the body above differ, this subsection governs.**

### 3.11.1 What the review got right that is worth stating plainly

Three of the six blocking findings were not subtleties. They were paths on which a real sale is
lost, and they were all produced by the same drafting habit: **stating a strong claim and not
building the machinery underneath it.** "The number never leaves the server" while §6 required the
number at the counter. "Structurally impossible" for a control that breaks under the failure this
document calls its own sharpest edge. "A tablet cannot post a sale to the wrong period" for an
input with no validation. A Phase 0 document that overclaims is worse than one that admits a gap,
because the reviewer stops checking. Every such claim in this section has now been either made true
or withdrawn.

### 3.11.2 Response taxonomy and durable dead-lettering

See §3.3.4. The load-bearing rule: **a client never completes a CRUD transaction into local-only
storage.** Either the server has the write, or the server has the dead-letter, or the queue stays
blocked. There is no third state in which the only copy of a sale is on a tablet that has just been
told the server does not want it.

### 3.11.3 `device_write_watermark` — dedupe without a retention cliff

Replaces the 90-day prune and the `stale_device_batch` bulk approval.

```sql
CREATE TABLE app.device_write_watermark (
  tenant_id            uuid    NOT NULL,
  device_id            uuid    NOT NULL,
  last_applied_hlc     text    NOT NULL,   -- highest server-stamped HLC accepted from this device
  contiguous_through   text    NOT NULL,   -- highest HLC with no gap below it
  last_write_id        uuid    NOT NULL,
  applied_count        bigint  NOT NULL,
  updated_at           timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, device_id)
);
```

- A write whose server-stamped HLC is at or below `contiguous_through` for that device is a
  **replay, regardless of age.** No 90-day cliff, no bulk-confirm, no unreviewable batch.
- `write_log` rows are permanent; only `response_body` and `request_hash` are pruned at 90 days. A
  replay past that point returns `200 {status:"replayed", already_applied:true}` without a stored
  body — correct, because the effect exists and the caller's intent was carried out.
- The invariant the whole design was silently leaning on is now **stated and enforced**: *every
  mutation's effect is keyed by client-generated identity, so a replay is an insert conflict rather
  than a duplicate.* For the mutation shapes where that was not true — payment allocation, sequence
  block consumption, stocktake baselines, any update-shaped mutation — the effect row now carries
  the originating `write_id` in its natural key or a unique index over it. A CI test enumerates
  every mutation type and fails if any lacks a replay-safe key.

### 3.11.4 Completeness attestation — `GL-Q4`, answered

§5.2.6 requires that *a period cannot be locked while any location has an unsynced document dated
on or before the period end*, and logged the contract as `GL-Q4` owned by this section. It was not
delivered, and the naive delivery is wrong: **a high-water mark computed from received data cannot
prove absence.** A tablet that is powered off, stolen or on a dead SIM sends nothing, and the
server cannot distinguish "nothing pending" from "400 sales pending".

So the contract is **attestation, not a watermark**:

```sql
CREATE TABLE app.device_sync_state (
  tenant_id                 uuid NOT NULL,
  device_id                 uuid NOT NULL,
  location_id               uuid NOT NULL,
  last_seen_at              timestamptz,
  last_queue_empty_at       timestamptz,   -- set ONLY by an explicit client "queue drained" ack
  last_uploaded_business_date date,
  outstanding_estimate      integer,       -- device-reported, advisory
  enrolment_status          text NOT NULL, -- 'active'|'suspended'|'retired'
  PRIMARY KEY (tenant_id, device_id)
);
```

- `location_attested_through(location, T)` is true iff **every `active` enrolled device at that
  location has reported `last_queue_empty_at > T`.**
- **A device that has not attested blocks the close, and that is the correct default.** Excluding it
  is an explicit, audited action by the Accounts role — it retires or suspends the device, the
  action is recorded **on the close record** with the device's last-reported `outstanding_estimate`,
  and anything the device later produces posts as `is_late_arrival` with a mandatory line on the
  late-arrivals report. §9's C7 names the same policy gap for contraction; it is one policy and one
  owner, not two.
- This also resolves §5.2.6's internal contradiction. Close is gated on **attestation**, and the
  late-arrival path exists for documents from devices that were *excluded* by the audited action —
  not, as the text implied, for documents from devices that were silently ignored.

### 3.11.5 Version history for mutable rows

`app.row_version`, per §3.6.1. Retention ≥ max offline lease + review expiry horizon. Money and
quantity values inside `value_jsonb` are decimal strings.

### 3.11.6 Mutation payload versioning and canonicalisation

RFC 8785 (JCS); money and quantity as strings; hash computed on the device at enqueue; N−2
server support; `426 UPGRADE_REQUIRED` is retryable. Canonicalisation is a frozen, versioned
artefact with published test vectors, not a convention.

### 3.11.7 Server-originated writes

Conflict resolutions, reversions, accruals, archival and every scheduled job write through
`write_log` with `origin='SERVER'`, a platform system-actor id, a server node id for HLC
generation, and a **deterministic** `write_id` derived from `(op, natural key)` — e.g.
`uuidv5(ns, 'fee_accrual:' || credit_account_id || ':' || period_id)` — so a re-run is a no-op
rather than a double posting. `device_id` and `actor_user_id` are nullable precisely so a system
write is not forced to impersonate a human.

### 3.11.8 PowerSync capability verification — gated, not assumed

The design leans on capabilities that were asserted rather than checked, and the whole tenant
boundary sits on them. Before Phase 1 code, each of these is verified against the pinned version
and the fallback is exercised at least once:

| Capability the design assumes | If unsupported |
|---|---|
| A parameter query may **JOIN** (`user_location_scope` ⋈ `user_effective_permission` ⋈ `review_queue_permission`) | Maintain flattened, trigger-maintained materialised tables (`user_bucket_scope`, `user_review_queue_scope`) and select from one table |
| `user_effective_permission` may be a **view** | **It may not.** Logical replication does not replicate views — this is a known limitation, not a risk. It is a trigger-maintained table from day one. |
| Data queries may filter on a denormalised `location_id` on child tables | Non-negotiable schema requirement on §4, already stated in §3.2.3 |
| Per-row bucket membership changes (`archived_at`) propagate as deletes | Fall back to a coarse, rarely-changed window value in the bucket key, deployed out of hours, with the fleet re-download priced |
| Rule deploys can be staged or canaried | Deploy out of trading hours with a verified rollback; §9's C2 measures the cost first |

### 3.11.9 Naming reconciliation

The sections were written against different names for the same tables. Canonical form is **singular,
as defined in §4**: `stock_movement`, `sale`, `sale_line`, `sale_line_tax`, `sale_tender`,
`cash_session`, `stock_count`, `stock_transfer`, `customer`, `credit_account`, `credit_entry`,
`credit_allowance`, `tax_rate`, `product_uom`, `sequence_block`, `write_log`, `conflict_review`.
`app.sync_conflict` is deleted in favour of `conflict_review` (§4.12). The four-timestamp scheme in
§3.4.2 is canonical and §4's `occurred_at` is one of them (`device_wall_at`, untrusted). **This
reconciliation is a Phase 0 exit condition**, not a Phase 1 cleanup: the sync rules file *is* the
isolation boundary, and it is currently written against a schema that does not exist.

### 3.11.10 Full disposition

| # | Finding | Disposition |
|---|---|---|
| 1 | Credit bucket makes offline credit impossible | **Accepted.** New `location_credit_allowance` bucket gated on `credit.sell` (§3.2.2/3.2.3). Reconciled with §6.7. |
| 2 | Conflict and poison indistinguishable | **Accepted.** Explicit response taxonomy; durable server-side dead-letter (§3.3.4). |
| 3 | `stale_device_batch` double-posts | **Accepted.** Replaced by `device_write_watermark` (§3.11.3). Bulk approval deleted. |
| 4 | Clock skew flagged, not rejected | **Accepted.** Server-stamped HLC at ingest; `claimed_hlc` untrusted; ±24h refusal; new forward-skew drill (§3.4.1). |
| 5 | Completeness watermark missing | **Accepted.** `device_sync_state` + attestation (§3.11.4). `GL-Q4` closes as an engineering contract; the *exclusion policy* needs an owner — carried to the README as a new open question. |
| 6 | 30-day refresh token contradicts §2.7 | **Accepted.** §2.7 governs; §3.1.7 restated; drills replaced. Lease length remains `Q-SEC-3`. |
| 7 | Epoch in bucket key → monthly fleet re-download | **Accepted.** Per-row `archived_at`, archived on `server_received_at` (§3.2.4). |
| 8 | `stock_balance_snapshots` unbounded on device | **Accepted.** `stock_balance_current` only; history server-side; 50 MB estimate re-derived with arithmetic. |
| 9 | Sale line cannot reproduce its own tax | **Accepted.** Full basis snapshotted in `sale_line_tax` (§3.4.2, §4.8). |
| 10 | Who computes the total is unstated | **Accepted.** Server recomputes and compares; mismatch is a sev-1 review, never a silent overwrite. |
| 11 | `qty_scale` not on the movement | **Accepted.** `qty_scale` + `uom_code` denormalised (§3.7.1). §4 already had this; §3's DDL was stale. |
| 12 | "Revert to the ancestor" has no version history | **Accepted.** `app.row_version`; N-party rule; unreconstructable ancestor → freeze + review; server-actor; no offline sev-1 resolution; revert re-runs the exposure check. |
| 13 | Field-level merge not implementable | **Accepted.** Mutations declare `changed_fields` + base values; class #7 rewritten. |
| 14 | Review queue leaks credit context to 25 outlets | **Accepted.** `conflict_review_location`; heavy context server-side only. |
| 15 | `business_date` unvalidated | **Accepted.** Session constraints in §3.4.2; `app.cash_session` added to §4. |
| 16 | Class #14 "structurally impossible" is false | **Accepted.** Downgraded; regression detection; block-size arithmetic corrected. |
| 17 | No mutation versioning; canonicalisation undefined | **Accepted.** §3.11.6. |
| 18 | Unverified PowerSync capabilities | **Accepted.** §3.11.8; the view→table point is a correction, not a risk. |
| 19 | Bucket count understated | **Accepted.** Re-derived to ~530; `tenant_reviews` re-keyed on a coarse `review_queue`. |
| 20 | Money in `jsonb` parses to float | **Accepted.** Strings everywhere; lint rule extended to jsonb. |
| 21 | Conflict burst; no coalescing or rate limit | **Accepted.** Dedupe per `(entity, field_path)`; per-reviewer ceiling. Upload-before-download is a client connector setting, stated as such rather than asserted. |
| 22 | Tenant #1 vocabulary in platform logic (×4) | **Accepted, all four.** Escalation chain, notification channel, receipt format and `sequence_key` list, retention windows — each moved to tenant config or the jurisdiction pack. |
| 23 | Dedupe isolation level unspecified | **Accepted.** `READ COMMITTED` pinned; empty-read returns retryable `409 RETRY_LATER`. |
| 24 | `tenant_reference` has no liveness check | **Accepted.** Membership check added. |
| 25 | Transfers have no bucket | **Accepted.** `tenant_transfers`, visible to both endpoints. |
| 26 | Stale snapshots not flagged to devices | **Accepted.** `is_stale` syncs; device replays or refuses to show a number; 60 s recompute SLO. |
| 27 | Naming drift across sections | **Accepted.** §3.11.9; Phase 0 exit condition. |

Nothing was rejected. That is not a compliment to the review so much as a comment on the draft: a
first pass over a design this size will contain roughly this many real defects, and the value of the
document is that they were found before code rather than in month four.
