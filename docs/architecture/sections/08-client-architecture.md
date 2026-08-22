# 8. Client Architecture

**Owner:** `frontend-engineer` · delegating counter flows, printing and touch ergonomics to
`pos-ux-specialist` · **Affects:** all phases

This section describes the client the product actually ships: one installable PWA, built once,
running on low-end Android at every location of every tenant.

**Revised 2026-08-21 after adversarial review.** The first draft was written against an earlier
data model and sync protocol and the gap was not cosmetic: the sale it showed the client writing
could not have been accepted by the server §3 and §4 describe. Nine required columns, two child
tables and every rounding rule the device owns were missing, and each of those failures lands as a
`422 MUTATION_REJECTED` — which §3.3.4 defines as the *only* definitive rejection, i.e. dead-lettered.
A tendered, printed, cash-collected sale in a poison table is precisely the outcome §3.3.2 rewrote
itself to prevent. §8.14 is the full disposition. **Where §8.14 and the body differ, §8.14 governs.**

Two sentences govern everything below.

**The network is not in the path of a sale.** Every design choice here is downstream of that,
including the ones that look like UI polish.

**This section is not authoritative on anything it shares with §2, §3, §4 or §5.** It states what
the client must do to satisfy those sections. Where it appeared to redefine them, it was wrong, and
the corrections are in §8.14.

---

## 8.1 What runs on the device

| Layer | Choice | Why |
|---|---|---|
| Shell | Installable PWA (WebAPK), React + TypeScript, Vite | One artefact reaches 25 outlets same-day (`ADR-0003`) |
| Local store | SQLite compiled to WASM, persisted to OPFS, driven from a dedicated worker | Real SQL, real indexes, real FTS — off the main thread |
| Sync | PowerSync web SDK (`CLAUDE.md` §2.2) | Proven bidirectional sync; we do not hand-roll one |
| Router / state | File-routed React, no global store | Server state lives in SQLite; there is nothing left for Redux to hold |
| Build | Workbox service worker, build-hashed precache | Deliberate, testable update flow (§8.11) |

### Six hard gates, not warnings

The first draft listed three and omitted the three that fail most often in the field. All six are
re-evaluated **on every launch and on every resume**, not once at first launch — persistence can be
revoked, a lease expires on a timer, and a second browser instance can appear at any moment.

| # | Gate | Failure behaviour |
|---|---|---|
| 1 | **OPFS with synchronous access handles** (Chrome 108+ on Android; confirmed per device in the Phase 1 hardware spike) | Full-screen block. The IndexedDB VFS fallback is several times slower on eMMC and misses §8.10 outright, so it is not offered as a degraded mode. |
| 2 | **This instance holds the single-writer lock** (§8.1c) | The losing instance shows a plain "This till is open in another window" screen with a "use it here instead" action. It never opens the database. |
| 3 | **The device is enrolled and holds an unexpired offline lease** (§2.7) | Enrolment missing → the enrolment flow. Lease past `full_until` → restricted mode per §2.7. Past `hard_stop_at` → sealed, read-only, data key dropped. |
| 4 | **Storage is persisted and has headroom** (§8.1b) | Not persisted → **hydration is refused**, not selling. Low headroom → a first-class device state that blocks new writes before the disk fills. |
| 5 | **The build is inside the server's supported read range** (`min_client_schema` … `max_client_schema`, §8.11) | Read-only quarantine, with the update path in front of the user. |
| 6 | **The build is at or above `min_writable_schema`** (§8.11) | Writes refused. This gate fires *before* gate 5 would, deliberately, so a device stops taking sales while its queue can still drain. |

A device failing any gate gets a full-screen, plainly-worded block naming the specific failure and
the fix. It never degrades into a half-working till.

### 8.1a The local database is per-tenant and per-device — never per-user

The first draft keyed the OPFS database to `(tenant_id, user_id)` and then blocked a wipe while
unsynced writes existed. Those two rules deadlock: a device holding unsynced tenant-A writes that
is re-provisioned to tenant B cannot wipe (writes pending) and cannot drain (no tenant-A token), so
the device is bricked and the writes are unrecoverable. The `user_id` half also contradicted
"logging out never clears local data" — if the database is keyed to the user, a shift change is a
full re-hydration over 2G at every handover, with the outgoing cashier's unsynced sales sitting in a
database nobody is logged into.

The corrected rules:

- **The OPFS database path is keyed to `tenant_id` alone**: `/{tenant_id}/erp.sqlite3`. Multiple
  tenants' databases may coexist on one device, so tenant A's queue drains independently of tenant
  B's provisioning and **the wipe-on-re-provision is unnecessary**. It is deleted.
- **A database is never opened under a token whose `tid` differs from its path.** That is not a
  merge case, it is an assertion failure; the client opens the right database or none.
- **User identity is a lock-screen concern.** Per-user PIN unlock (§2.7) unwraps a per-user,
  per-device key; a shift change is an unlock, not a re-hydration. Logging out locks the screen and
  clears the in-memory data key. It never clears local data — otherwise the first thing a frustrated
  staff member does with a stuck till is log out, and the day's sales go with it.
- **Wiping happens for exactly two reasons**, both of which are §2.7's: `403 device_revoked` from
  the server (which wipes everything including the outbox, because those writes will be quarantined
  server-side anyway and should not be left on a lost device), and an operator-initiated
  de-provisioning that first requires the queue to be empty *and* attested (§8.5).

### 8.1b Persistence gates hydration, not selling

The first draft let an unpersisted device "browse but not sell". That is exposure with none of the
benefit: browsing means the tenant's catalogue, prices, customer list, credit positions and 90 days
of transactions have already been written to evictable storage on a device the browser may silently
empty. So:

- **`navigator.storage.persisted()` must be true before the first byte of tenant data is
  hydrated.** If it is false the client calls `persist()`; if that is refused, hydration does not
  start and the screen explains that the app must be installed first. Enrolment is online and in
  person (§2.7), so a technician is present when this matters.
- **A transition from persisted to unpersisted is an incident, not a prompt.** Detected on launch
  or resume, it blocks writes, raises a device-health event on next contact, and tells the operator
  to stop taking sales on this device.
- **`navigator.storage.estimate()` is consulted before every write.** Below a configured headroom
  (default: the greater of 64 MB and 10 % of quota) the client enters a **Storage low** device
  state: it keeps selling but refuses non-essential local writes (FTS rebuilds, perf samples,
  cached receipt renders) and escalates in the status bar. Below a hard floor (16 MB) it refuses
  new sales with a named reason rather than letting a `QuotaExceededError` land mid-transaction
  after the cash was tendered.

### 8.1c One instance, elected

OPFS synchronous access handles are exclusive: one context holds the database. On a shared counter
tablet, Chrome restoring tabs after an OOM-kill, a staff member opening the PWA in a browser tab
alongside the installed WebAPK, and the service worker's own access all produce a second contender.
On this hardware that is a weekly event and the first draft had no story for it.

Election is a **Web Lock** (`navigator.locks.request('db-writer', {mode:'exclusive'})`) held for the
lifetime of the instance, with a `BroadcastChannel` heartbeat so the losing instance can offer
"use it here instead" (which releases the lock in the other instance and re-elects). The losing
instance never opens the database, never queries, and shows one plain screen. The lock is gate 2
above because a database-locked exception surfacing as a generic error in the middle of a sale is
exactly the ambiguity §8.5 exists to eliminate.

### 8.1d What the client never sends

§3.3.3 is explicit that four fields come from the verified session and never from the payload:
`tenant_id` (from the JWT), and `device_id`, `actor_user_id` and `location_id` (from the session).
The first draft named only the first. The other three are as attack-relevant: `actor_user_id` is the
audit trail and `location_id` feeds sync scope, so a client-supplied `location_id` is a write into
another outlet's bucket.

**Enforced structurally, not by review:** the shared mutation payload type has no field for any of
the four, so a handler cannot populate one. Local rows carry `location_id` because reads and local
indexes need it; the *payload builder* has no access to it. A divergence between the local row's
`location_id` and the session's is an incident, reported on next contact.

---

## 8.2 Reads and writes, from inside a component

**Reads are live queries against local SQLite.** A component declares the rows it needs; the sync
layer re-runs the query when any underlying table changes. There is no fetch, no cache layer, no
`isLoading` for data. The only genuine loading state in the product is first hydration when a
device is provisioned, and that is a dedicated screen, not a spinner inside the counter.

```tsx
// src/data/queries/cart.ts — the ONLY layer where SQL and raw rows exist.
// Four scaled-integer domains, four casts. See §8.3.
export function useCartLines(draftId: DraftSaleId) {
  return useQuery(
    `SELECT id, product_id, line_no,
            selling_uom_id,  CAST(qty_sell      AS TEXT) AS qty_sell,      qty_sell_scale,
            stocking_uom_id, CAST(qty_stock     AS TEXT) AS qty_stock,     qty_stock_scale,
            CAST(qty_stock_computed  AS TEXT) AS qty_stock_computed,
            conversion_confirmed_by,
            CAST(unit_price_e4       AS TEXT) AS unit_price_e4,     -- rate_e4, NOT minor
            CAST(list_price_e4       AS TEXT) AS list_price_e4,     -- what the price list said
            price_list_item_id, is_price_override, override_approved_by,
            CAST(line_discount_minor AS TEXT) AS line_discount_minor,
            CAST(line_net_minor      AS TEXT) AS line_net_minor,
            CAST(tax_minor           AS TEXT) AS tax_minor
       FROM local_draft_sale_line
      WHERE draft_sale_id = ?
      ORDER BY line_no`,
    [draftId],
    mapCartLine,           // TEXT -> branded bigint, exactly once, here
  );
}
```

```tsx
// src/features/counter/CartLines.tsx — no SQL, no money maths, no formatting decisions.
const lines = useCartLines(draftId);
return <List rows={lines} render={l => <CartLineRow line={l} />} />;
```

### The canonical sale write

**This is the write §4.8 accepts.** The first draft's eight-column `INSERT` is replaced; every
field below exists because a `NOT NULL`, a `CHECK`, a composite foreign key or a deferred constraint
trigger in §4.8 requires it, and the client-side origin of each is named.

| Field | Where the client gets it |
|---|---|
| `write_id` | The outbox row written in **this same local transaction** (§3.3.3). Locally that row lives in `local_outbox` — §3.3.3 calls it `outbox_meta` — and **its id *is* `write_log.id`**, the one idempotency key §4.2.2 rules on. There is no second key. The composite FK `(tenant_id, write_id)` makes omitting it a foreign-key violation server-side. |
| `id` (sale) | UUIDv7 minted at cart creation **from the HLC's physical component**, not `Date.now()` (§3.7.3). |
| `cash_session_id`, `business_date` | The open cash session (§8.2a). There is no path to a sale without one. |
| `receipt_no` | The device's sequence-block cursor, consumed inside this transaction (§8.2b). |
| `currency_code`, `money_scale` | Snapshotted from the tenant's jurisdiction pack at capture. Never assumed to be 2 (`ADR-0007`). |
| `subtotal_net_minor`, `discount_minor`, `tax_total_minor`, `total_minor` | Computed on the device per §8.3's rounding rules. `CHECK (total = subtotal_net − discount + tax_total)`. |
| `sale_line` rows | All of §4.8's columns, including both quantities, both scales, `factor_num/den`, `price_list_item_id` and the override/confirmation fields. |
| `sale_line_tax` rows | One per component in pack order, carrying `base_kind`, `base_includes`, `rounding_level`, `rounding_mode`, `base_minor`, `tax_minor`, `tax_rate_id`, `is_recoverable_snapshot` (§3.4.2). |
| `sale_tender` rows | Written in the same transaction. §4.8's deferred trigger asserts `total_minor = Σ amount_minor` **and fires even at zero tenders**. |
| `stock_movement` rows | `qty_stock` in the stocking unit, with `qty_scale` and `uom_code` snapshotted (§3.7.1). |
| `credit_entry` CHARGE | If a tender uses the on-account method, in the same `write_id`, for the same amount — enforced. |

```ts
// src/data/mutations/completeSale.ts
// One local transaction. Nothing in it awaits a socket.
export async function completeSale(draftId: DraftSaleId): Promise<CompleteSaleResult> {
  const till  = await cashSession.requireOpen();     // §8.2a — no open session, no sale
  const draft = await loadPricedDraft(draftId);      // priced, rounded and confirmed already
  const saleId  = draft.saleId;                      // minted at cart creation; stable across retries
  const writeId = uuidv7FromHlc(hlc.now());          // §3.7.3
  const receipt = sequence.peek('RECEIPT');          // §8.2b — consumed inside the transaction

  try {
    return await db.writeTransaction(async tx => {
      // 1. Outbox row and business rows commit together (§3.3.3). ON CONFLICT makes a
      //    double-tap, a crash-and-resume and a retry the same no-op.
      //    request_hash is computed HERE, at enqueue, and frozen: §3.3.3 requires that a
      //    client upgrade cannot change the hash of an already-queued mutation.
      const claimed = await tx.execute(
        `INSERT INTO local_outbox (id, op, schema_version, hlc, device_wall_at,
                                   base_row_hlc, request_hash, payload)
         VALUES (?, 'sale.create', ?, ?, ?, NULL, ?, ?)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [writeId, SCHEMA_VERSION, hlc.text(), nowIso(),
         draft.requestHash, draft.canonicalPayload]);
      if (claimed.rows.length === 0) return alreadyCompleted(saleId);   // idempotent success

      await tx.execute(
        `INSERT INTO sale (
            id, write_id, hlc, device_wall_at,
            location_id, cash_session_id, business_date, receipt_no,
            customer_id, price_list_id, currency_code, money_scale,
            subtotal_net_minor, discount_minor, tax_total_minor, total_minor)
         VALUES (?, ?, ?, ?,   ?, ?, ?, ?,   ?, ?, ?, ?,
                 CAST(? AS INTEGER), CAST(? AS INTEGER),
                 CAST(? AS INTEGER), CAST(? AS INTEGER))
         ON CONFLICT (id) DO NOTHING`,
        [saleId, writeId, hlc.text(), nowIso(),
         till.locationId, till.id, till.businessDate, receipt.number,
         draft.customerId, draft.priceListId, till.currencyCode, till.moneyScale,
         draft.totals.subtotalNet.toString(), draft.totals.discount.toString(),
         draft.totals.taxTotal.toString(),    draft.totals.total.toString()]);

      await insertSaleLines(tx, saleId, writeId, draft);      // §4.8 sale_line, every column
      await insertSaleLineTaxes(tx, saleId, writeId, draft);  // one row per component, pack order
      await insertSaleTenders(tx, saleId, writeId, draft);    // Σ amount_minor = total_minor
      await insertStockMovements(tx, saleId, writeId, draft); // qty_stock, stocking unit
      if (draft.onAccountTender) await insertCreditCharge(tx, saleId, writeId, draft);

      await tx.execute(
        `UPDATE local_sequence_cursor SET consumed_upto = ?
          WHERE sequence_key = 'RECEIPT' AND install_id = ?`, [receipt.number, INSTALL_ID]);
      // The draft is MARKED, never deleted. See "the state the first draft had no name for".
      await tx.execute(
        `UPDATE local_draft_sale SET state = 'COMPLETED', sale_id = ? WHERE id = ?`,
        [saleId, draftId]);

      return { status: 'committed', saleId, receiptNo: receipt.text };
    });
  } catch (e) {
    return localCommitFailed(draftId, e);   // a NAMED state, not a thrown promise. See below.
  }
}
```

Four consequences worth stating explicitly.

- **The draft cart lives in SQLite too**, in **local-only** tables (`local_draft_sale`,
  `local_draft_sale_line`, `local_draft_tender`) that never sync. A battery pull or a Chrome
  OOM-kill mid-sale must not lose the cart; an abandoned cart must never become a phantom sale at
  HQ. Local-only tables give both. Their migration policy is §8.11's, and it is explicit, because
  local-only tables in a sync-managed schema are otherwise dropped and recreated on a client schema
  change — which would destroy every held cart at every update.
- **The sale id *is* the idempotency key**, minted at cart creation before the first line is added,
  from the HLC's physical component so a tablet whose clock says 2019 does not spray inserts across
  the index (§3.7.3). Every retry, every double-tap, every crash-and-resume writes the same key.
- **`ON CONFLICT (id) DO NOTHING` on the `write_log` claim is what makes that true locally.** The
  first draft asserted idempotency and then wrote code with no conflict clause, no guard and no
  catch: the second of two double-taps hit a primary-key violation, the transaction threw, the draft
  had already been deleted, and the natural UI rendering of a thrown promise is "sale failed" — so
  the cashier rings it again from a fresh cart with a **new** id, and that is a genuine,
  non-deduplicable duplicate. The section's own thesis is that duplicates come from a person who
  does not know whether the last sale went through; the code manufactured that person.
- **The Complete control is disabled on first activation** and stays disabled until the transaction
  resolves one way or the other. Belt to the `ON CONFLICT` braces.

### The state the first draft had no name for

A local commit can fail: `QuotaExceededError` on a full 2 GB tablet, an OPFS write error, the
database lock lost to another instance. The cash has been tendered. There is no record.

This gets its own full-screen state, visually distinct from every other state in the product, and
it is the only place in the counter that uses an alarm colour:

> **NOT RECORDED — do not hand over goods**
> This sale did not save on this device. *(reason, in plain words)*
> The cart is still here. Try again · Move to another till · Call your manager

**The cart is not destroyed.** That is why `completeSale` marks the draft rather than deleting it:
after a failure there is something to retry against, and after a success there is a row that proves
the draft was already completed, so a resumed app does not present an old cart as live. Completed
drafts are purged by a janitor 24 hours after their sale is acknowledged.

### Online-only operations

The first draft presented a closed list and it was not closed. A closed list that is not closed is
worse than an open one, because the reader stops looking — §4.13 makes exactly this point about its
own rounding list. So: **these are the online-only operations known at Phase 0, and the list is
open.** Each shows an honest "needs a connection" state, never a spinner.

| Operation | Authority |
|---|---|
| First credential exchange at login; sync-token refresh | §2.7 |
| Device enrolment | §2.7 |
| Tenant provisioning and template application | §1 |
| Per-tenant export; statutory report generation | §7 |
| Reprinting a receipt recorded on a different device | §8.8 |
| **Reprinting a receipt older than the sync window** — with the message "older than 90 days, needs a connection", never a mystery empty result | §3.2.4 |
| **Resolving a severity-1 conflict review** | §3.6.1 |
| **Fetching a conflict review's context snapshot** | §3.6.2 |
| **Requesting a sequence-block replenishment** | §3.7.5 |
| **A manager approval by a manager who has never unlocked on this device** | §2.7, §8.7 |

Nothing on that list is on the counter's critical path for a cash sale.

---

## 8.2a The cash session — opening and closing the till

The first draft had no till open/close surface at all, and the consequence was worse than a missing
screen. **Without a cash session the device has no trustworthy date**, so offline resolution of
effective-dated rates falls back to `Date.now()` — on a device §3.4.1 explicitly says may be set to
2019 or 2030 by a user dismissing a certificate warning. That tablet resolves last year's rate set,
prints a non-compliant invoice, and every sale it takes mismatches the server's recompute.

§4.8a is the table and §3.4.2 states the constraints. This subsection is the client half, because
every one of those constraints is a screen.

**Opening.** The counter's first screen when no session is open is the open-till screen, not the
cart. It captures the opening float on the money keypad and records `opened_by`.

- **Online: validate against server time.** More than ±1 day from the server's date and the open is
  refused, with the server's date shown. §3.4.2.
- **Offline: permitted, and flagged.** `opened_offline = true`, which appears on the close report
  and on the outlet's daily reconciliation. The proposed `business_date` is prefilled from the
  device's best estimate and the operator confirms it, with the date rendered large and unabbreviated
  — a device four days out prints a date the operator can see is wrong.
- **Refused into a closed or locked accounting period** (§5.2.6). This requires the period state to
  be resident on the device: `accounting_period` rows are in the reference bucket. Named here as a
  requirement on §3.2.2 because the client cannot enforce a rule it cannot read offline.
- **One session per till per business date** (§4.8a's unique constraint). An offline race between
  two devices claiming the same till is §3.6 conflict class #17 and goes to review; the client does
  not resolve it.

**During.** `cash_session.business_date` is the **only** date the client resolves anything against:
tax-rate effectivity, price-list effectivity, credit terms and ageing, period membership. `Date.now()`
appears in exactly two places in the client — `device_wall_at` (untrusted, display only) and the
HLC's physical component (clamped, §3.4.1) — and a lint rule enforces that.

**One calendar day maximum, with a hard auto-close at local midnight** in `location.timezone`. This
is client UI and there is no server that can do it for an offline till. At midnight the session
closes with `auto_closed = true` and the operator gets a carry-over prompt that opens a **new**
session for the new date. It never extends the old one. Without this, the till nobody closes over a
long weekend stamps a week of trade with one `business_date` and posts a week to one day and one
VAT period.

**Closing.** Counted cash on the keypad, expected computed locally from the session's tenders,
variance shown before confirmation and never after. The close is a document; §5.6.2 rules 11/11b
post the banking and the variance. A session cannot close while a sale is in flight or a print is
mid-attempt.

**If a session opened offline is later contradicted by server time by more than ±1 day**, the client
does not silently correct it — the session and its sales are flagged and the divergence goes to
review. Correcting a `business_date` after the fact is restating a VAT period.

---

## 8.2b Receipt numbers: the block cursor lives on the device

§3.6's conflict class #14 was downgraded from "impossible" to "structurally improbable, and
detected" for one reason: **`consumed_upto` lives on the device.** If OPFS is evicted or the PWA is
reinstalled, the local cursor resets while the server still shows the block live, and the device
reissues numbers it has already printed — on a document type that may be a statutory VAT invoice.
§8 owns the device and the first draft never mentioned `receipt_no` at all.

- **The cursor lives in the persisted database, in `local_sequence_cursor`, and it is not a draft
  table.** §8.11's local-table migration policy names it explicitly as a table that must survive
  every client schema change; dropping it on an update would reissue a block from its start.
- **It carries `install_id`**, regenerated on every hydration. A cursor whose `install_id` does not
  match the current install is **never resumed**. The client requests a fresh block with
  `reason = 'rehydrated'` and the server burns the remainder of any block still showing live for
  this device (§3.7.5 already burns on regression; this makes the client ask for it rather than
  wait to be caught).
- **It is consumed inside the document's transaction**, so a number cannot be burned by a sale that
  did not commit, and cannot be reused by one that did.
- **It is reported on every reconnect** as `consumed_upto`. The server compares against the last
  report; any regression burns the block, issues a fresh one and raises a severity-1 review naming
  the overlap range.
- **Replenishment is expressed in days of observed throughput**, per §3.7.5: request the next block
  when the remainder falls below five days of this device's own p95 daily consumption, or below 100
  numbers, whichever comes first — and only when there is connectivity.
- **Exhaustion offline never stops trading.** The device switches to §3.7.5's emergency form
  (`SUN-RCT-004999-D3F`, suffix from `device_id`), marks it as such on the receipt and on the record,
  and the status bar carries a persistent line: *"Emergency receipt numbers in use — reconnect to
  get a new block."* The exceptional case is visibly exceptional.

---

## 8.3 Money, quantity and rounding at the client boundary

### Four scaled-integer domains, not one

The first draft treated "money" as a single scale and held unit prices as `unit_price_minor`. §4.8
holds them as `unit_price_e4` — four *additional* decimal places beyond the minor unit — precisely
because bulk goods price sub-pesewa. Binding wire at GH₵0.4567/kg is `456700` at `rate_e4`; a client
holding minor units must round it to `46` pesewas at capture, 12.5 kg then extends to 575 pesewas
instead of 571, and the server's byte-for-byte recompute (§3.4.2) raises a severity-1
`receipt_recompute_mismatch` on every fractional-unit line — with the wrong number already on paper
in the customer's hand.

The client boundary therefore carries **four** domains, and they are branded types, not aliases:

```ts
// src/data/domains.ts
declare const b: unique symbol;
export type Minor  = bigint & { readonly [b]: 'money_minor' };  // §4.2.1 app.money_minor
export type Qty    = bigint & { readonly [b]: 'qty' };          // §4.2.1 app.qty — carries its scale
export type RateE4 = bigint & { readonly [b]: 'rate_e4' };      // unit prices, unit costs, WAC
export type Bp     = bigint & { readonly [b]: 'bp' };           // rates, tolerances, margins
export type Scaled<T> = { readonly value: T; readonly scale: number };  // never a bare Qty
export type Money  = { readonly value: Minor; readonly currency: string; readonly scale: number };
export type Formatted = string & { readonly [b]: 'formatted' }; // display only; never compared
```

Every one of the four is selected as `CAST(col AS TEXT)` and parsed with `BigInt()` in the mapper;
every write binds a decimal string and `CAST(? AS INTEGER)`. The reason is unchanged from the first
draft and it is still the best paragraph in this section: **SQLite `INTEGER` columns come back
through the WASM driver as JavaScript `number`** — float64 — before any of our code sees them, so a
lint rule banning `number` on money types never fires, because the driver produced the value.

- **All SQL lives under `src/data/`.** A lint rule rejects `useQuery`, `db.execute` and raw row
  shapes anywhere else, so there is exactly one place where the cast discipline can fail and exactly
  one place to test it.
- **No arithmetic in SQL on any of the four.** `SUM(line_net_minor)` returns a `number`. Aggregates
  are computed in TypeScript over `bigint`, or read from a column the server computed. Where a query
  genuinely needs one, it is `CAST(SUM(x) AS TEXT)` and it is reviewed as a money change.
- **A `Qty` never travels without its scale.** `qty_delta = 2500` is 2.5 t at scale 3 and 25.00 at
  scale 2 and the value cannot say which; §3.7.1 snapshots the scale onto every movement for exactly
  this reason and the client mirrors it.

### The rounding the device performs — and the BigInt trap

`CLAUDE.md` §2.3: *"Rounding is explicit and stated at every boundary; never implicit."* The first
draft used the word *rounding* once, about trimming trailing zeros for display. That is the largest
single omission in it, because **at least six of §4.13's twelve rounding points execute on the
device, offline**, and the obvious TypeScript implementation of all six is systematically wrong in
the same direction.

> `qty_sell = 125` (12.5 kg at `qty_scale = 1`), `unit_price_e4 = 456700`.
> Correct: `125 × 456700 / 10^5 = 570.875 → ROUND_HALF_UP → 571`.
> The natural expression `(qty * price) / (10n ** 5n)` gives **570**. BigInt division truncates
> toward zero. One pesewa low, on every fractional line, always in the same direction, forever.
> Across §3.2.4's own arithmetic (9,000 lines per micro-outlet per 90 days) that is a guaranteed,
> silent, one-directional drift and a guaranteed severity-1 recompute mismatch.

§8.3's ban on `Number(minor)/100` catches the float hazard and misses this one entirely, because
`bigint` division *looks* safe. So:

```ts
// src/data/round.ts — the ONLY module in the client where `/` or `%` may touch a scaled integer.
export type RoundingMode = 'half_up' | 'half_even' | 'half_down' | 'up' | 'down';

/** half_up == half away from zero, matching Postgres round(numeric). Shared test vectors. */
export function divRound(num: bigint, den: bigint, mode: RoundingMode): bigint {
  if (den === 0n) throw new ZeroDenominator();            // never NaN, never Infinity, never 0
  const negative = (num < 0n) !== (den < 0n);
  const n = num < 0n ? -num : num;
  const d = den < 0n ? -den : den;
  const q = n / d, r = n % d, twice = r * 2n;
  let up: boolean;
  switch (mode) {
    case 'half_up':   up = twice >= d; break;
    case 'half_down': up = twice >  d; break;
    case 'half_even': up = twice >  d || (twice === d && (q & 1n) === 1n); break;
    case 'up':        up = r !== 0n;   break;
    case 'down':      up = false;      break;
  }
  const mag = up ? q + 1n : q;
  return negative ? -mag : mag;
}
```

**Enforcement is type-level.** A typed-lint rule bans the `/`, `%`, `*` and `**` operators on
`Minor`, `Qty`, `RateE4` and `Bp` outside `src/data/round.ts` and `src/data/pricing.ts`. Branded
types make that rule mechanical: the operators are not merely discouraged on those types, they do
not type-check outside the two modules that unwrap them.

**Negatives are in the test vectors, not an afterthought.** Returns, credit notes and voiding
documents produce negative extensions, and "half up" on a negative is the difference between −571
and −570.

### The six rules the device implements

Numbered as §4.13 numbers them. **These are the server's rules; the device runs the same code path
against the same vectors, because §3.4.2 makes byte-for-byte equality an invariant, not a target.**

| §4.13 | On the device | Client expression |
|---|---|---|
| 1 | Selling → stocking unit, **continuous** target | `divRound(qtySell * fNum * 10n**stockScale, fDen * 10n**sellScale, 'half_up')` |
| 2 | Selling → stocking unit, **discrete** target | Same computation, then **operator confirmation** (§8.7). Both figures stored; neither derived from the other. |
| 3 | Extended line amount | `lineNet = divRound(qtySell * unitPriceE4, 10n**qtyScale * 10_000n, 'half_up')` — **once, on the extended amount, never on the unit price** |
| 4 | Document discount across lines | Largest remainder: floor each line's proportional share, then distribute the remaining minor units to the highest-value lines in `line_no` order. `Σ line_discount = document discount`, exactly. |
| 5 | Tax per line, per component, in declared order | For each component *c* in pack order: `base_c = netAfterDiscount + Σ(tax_j : j ∈ base_includes_c)`; `tax_c = divRound(base_c * rate_bp_c, 10_000n, c.rounding_mode)` applied at `c.rounding_level`. Each component's `rounding_level` and `rounding_mode` are **written onto its `sale_line_tax` row** — a field the first draft never mentioned writing. |
| 6 | De-grossing a tax-inclusive list | `net = divRound(gross * 10_000n, 10_000n + effectiveBp, mode)` where `effectiveBp` is derived from the component set and its base composition, never a single rate; then compute each component forward from `net` per rule 5 and place the residual `gross − net − Σ tax_c` by largest remainder across components in pack order. `net + Σ tax_c = gross`, exactly, by construction. |
| 10 | Document discount on a tax-**inclusive** list | **Discount the gross, then de-gross.** The customer is quoted an inclusive price and negotiates against it. |

Rules 7, 8, 9, 11 and 12 do not execute on the device: the facility fee is `credit-engineer`'s and
server-side, weighted-average cost is restated server-side (§4.7.4), and metric divisions are
reporting. `unit_cost_e4` on a sale line is provisional at capture and explicitly restated by the
server; the client never shows a margin computed from it.

### Formatting

Once, at the presentation boundary, from the **document's** snapshotted scale — never from the live
jurisdiction pack:

```ts
function toDecimalString(minor: bigint, exponent: number): string {
  const scale = 10n ** BigInt(exponent);
  const neg = minor < 0n, abs = neg ? -minor : minor;
  const frac = exponent === 0 ? '' : '.' + (abs % scale).toString().padStart(exponent, '0');
  return `${neg ? '-' : ''}${abs / scale}${frac}`;         // exact; no float anywhere
}
```

The decimal *string* is handed to `Intl.NumberFormat` for grouping and symbol placement
(feature-detect the string overload on target Chrome; fall back to manual grouping). Banned outright
and enforced by lint: `Number(minor) / 100`, `toFixed`, `parseFloat` on a row value, any literal
`GH₵`, and any money-context literal `100`.

**A formatter reading `currency_code` and `money_scale` from the live pack rather than from the row
is a bug.** §4.8 snapshots both onto the sale, commented *"Never assume 100 (ADR-0007)"*, because a
jurisdiction can redenominate — Ghana did, in 2007 — and `ADR-0002` requires a reprint to reproduce
the original document exactly. Every render path takes the scale from the document. A `Money` value
in this client carries its currency and scale (see the type above), so a formatter that is handed a
bare `Minor` does not compile.

**Trailing-zero trimming** (`2.500 t` → `2.5 t`) is a display rule that never feeds back into
arithmetic, and it applies to the `Formatted` type only, which cannot be compared for equality.

---

## 8.4 Offline is a state, not an error

Offline is the expected condition for hours at a time. It gets a calm, permanent, unmistakable
presentation, and it never produces a modal, a red banner, a toast, or the word "error".

### Escalation is on wall-clock age, not connected time

The first draft watched "the age of the oldest queued write **while connectivity is present**",
with a 15-minute threshold. On an edge-of-coverage link that grants 40 seconds of reachability every
few minutes, the device never accumulates 15 contiguous connected minutes — so it never escalates,
and the status bar keeps reading `Offline · 14 sales waiting`, annotated by the table itself as
*"Nothing. Keep selling."* That is the user being misled about sync state by the control designed to
prevent it. The `Offline` row also had no age escalation at all: a device offline for six days
holding 900 sales rendered identically to one offline for twenty minutes.

**The measure is the wall-clock age of the oldest unacknowledged write, in every state, and it is
always displayed.**

| State | Condition | Shown as | What a person is meant to do |
|---|---|---|---|
| Caught up | queue empty, sync connected | `Online · all saved` | Nothing |
| Offline | no reachability signal; age < `offline_escalate_after` (default 24 h) | `Offline 2 h 10 min · 14 waiting` | Nothing. Keep selling. |
| **Offline, long** | no reachability signal; age ≥ threshold | `Offline 3 days · 212 waiting — tell your manager` | Escalate. Distinct from the §2.7 lease countdown, which has its own wording and fires on its own clock at `full_until` — a device can be badly stale well before its lease is in danger, and it can be inside its lease and still holding three days of takings nobody knows about. |
| Catching up | draining | `Sending · 9 of 14 · oldest 40 min` | Nothing |
| **Not sending** | **at least one reachability signal in the window** *and* age ≥ `stuck_after` (default 30 min) | `Not sending · oldest 2 h 14 min · stock adjustment 09:12 is blocking — tell your manager` | Escalate |
| Restricted / Sealed | §2.7 lease past `full_until` / `hard_stop_at` | §2.7's wording | Reconnect |
| Storage low / critical | §8.1b | `Storage low — tell your manager` | Escalate |

Two properties the first draft's version lacked:

- **The `Not sending` condition separates "no network" from "network, and something is wrong".** A
  flapping 2G link supplies reachability signals, so the flapping case escalates on age exactly as a
  good link would. A genuinely disconnected device escalates on the offline track instead, which is
  the honest description.
- **It names the blocking write, not the count behind it.** "14 sales waiting" when the head of the
  queue is a stock adjustment points the manager at the wrong thing. The head-of-queue mutation's
  type, time and originating screen are shown, because §3.3.4's whole design is that a poison
  message blocks everything behind it and the person who can act needs to know which message.

### Presentation rules

All of these come from the counter being a bright, dusty, hurried place.

- Status is **text plus icon plus count plus age**. Colour is never the only channel.
- Status is **persistent chrome**, never a toast. A toast is a message you can miss, and every
  message about whether money was recorded is a message you must not miss.
- **No spinner ever appears on the sale path.** If something on that path could wait on the network,
  it has been designed wrong.
- **Never claim a verification that could not happen.** An offline credit check does not show a
  confident balance. It shows the balance, its `as_of` timestamp from the last sync checkpoint, the
  locally-pending sales already deducted from headroom, and the plain words "not verified now".
  `credit-engineer` owns the arithmetic; the client owns the honesty of it.

---

## 8.5 Per-record sync state, and why it is the anti-duplicate design

The failure the brief forbids — double-counted sales — is almost never caused by the sync layer. It
is caused by a person who does not know whether the last sale went through, and rings it again.
Every rule in this subsection exists to remove that doubt.

**Per-record state is derived from data, not from a flag the client maintains.** Client-side
bookkeeping drifts; a row that came back from the server cannot lie.

The first draft had three badges and they collapsed two categorically different events: a `422`
dead-letter means *the money is in the drawer and absent from the ledger*; a conflict review means
*two managers disagree about a credit limit*. Both rendered as `Needs checking`. It also had no
state at all for §3.3.4's `200 {status:"routed_to_review"}`, where the write was **accepted** but its
effect awaits a human — a sale in that state is neither `pending` (it was acknowledged) nor honestly
`Saved`. And it named two columns that do not exist: §3.4.2's four timestamps are `hlc`,
`device_wall_at`, `server_received_at` and `business_date`; there is no `server_ack_at` and no
`server_seq`.

| State | Derivation | Badge |
|---|---|---|
| `pending` | Local row exists; `server_received_at IS NULL` | `Waiting to send` |
| `accepted_pending_review` | Upload returned `200 routed_to_review`; the write is accepted, its effect is not applied | `Sent · under review` |
| `synced` | `server_received_at` set and the row arrived back down the sync stream | `Saved` |
| `needs_review` | An open `conflict_review` references it | `Needs checking` |
| **`rejected`** | **`422 MUTATION_REJECTED`, durably dead-lettered (§3.3.4)** | **`NOT SAVED — tell your manager`** |

`rejected` gets its own escalation path, not a badge on a list: a persistent status-bar line, an
entry at the top of the Tasks area, and — because the money is in the drawer and the receipt is in
the customer's hand — the sale is named on the outlet's daily reconciliation. A dead-lettered sale
is a cash-versus-books discrepancy, and the till that produced it is the only place that can
reconstruct it from the printed stub.

The sixth state, **`NOT RECORDED`**, is not a per-record badge because there is no record. It is
§8.2's full-screen state.

### Rules built on top

- **Completing a sale lands on the receipt screen**, showing the receipt number and its badge — not
  back on an empty cart. An empty cart after a slow tap is the single most reliable way to
  manufacture a duplicate.
- **"Recent sales" is one tap from the counter, always**, showing the last 20 with their badges,
  totals and receipt numbers. The answer to "did that go through?" must always be available without
  asking the network and without asking a manager.
- **A pending sale is not editable and not re-creatable.** It can be voided — which creates a linked
  reversing document per §4.8, never a mutation of the original — it can be reprinted, it cannot be
  quietly retyped.
- Badges appear on **stock adjustments, transfers, credit payments and cash-session closes** too, not
  only sales. A transfer a manager believes was recorded and was not is the same class of error.
- The badge vocabulary is words a busy person reads at a glance in daylight. It is not
  "queued/committed/reconciled".

### The recompute verdict has a home

§3.4.2: the server recomputes every monetary figure from the snapshotted basis and compares against
the device's captured total **byte for byte**; inequality is a severity-1 `receipt_recompute_mismatch`
review, never a silent overwrite of either side. **The till that printed that receipt is the only
place that can act on it**, and the first draft gave it no surface, so the severity-1 opened
somewhere the printing device would never see.

A `receipt_recompute_mismatch` review scoped to a sale syncs to the device that created it. The
sale's badge becomes `Needs checking` with the specific wording *"the office total does not match
the printed receipt"*, the receipt is re-openable from the badge, and severity 1 triggers §3.6.2's
out-of-band channel. Resolution is online (§3.6.1) and the device says so.

### The device attests to what it is holding

§3.3.4 goes to considerable lengths to make dead-lettering durable server-side *before the queue
entry is released*, on the grounds that a wipe, a replacement or an OPFS eviction before that report
landed loses the sale with no server-side trace. **The same reasoning applies to the ordinary
queue and the first draft did not extend it**: a tablet dropped in a gutter with 40 unsynced sales
left no record that those sales ever existed. §8.12's Q-B asked about lost-device *confidentiality*;
the lost-*writes* half was never asked.

So on every sync — not only when the queue drains — the device reports a cheap attestation into
§3.11.4's `device_sync_state`:

| Field | Meaning |
|---|---|
| `outstanding_estimate` | count of unacknowledged writes (already in §3.11.4) |
| `oldest_unacked_hlc` | **new** — the head of the queue, so the gap has a start |
| `unacked_receipt_range` | **new** — receipt numbers consumed but not uploaded |
| `last_queue_empty_at` | set only by an explicit "queue drained" ack (already in §3.11.4) |

It costs one small row per sync and it converts silent loss into a named, bounded gap an outlet
manager can reconstruct from the printed receipt stubs. It also gives §3.11.4's completeness
attestation something to gate a period close on for the device population, rather than a count with
no bounds. The two new fields are an ask on §3.11.4, recorded in §8.12.

---

## 8.6 Conflicts arrive as work

`CLAUDE.md` §2.2 sends unresolvable conflicts to a human review queue. The client's contribution is
that the queue is a **place**, not an interruption. The table is §3.6.2's `conflict_review`; the
first draft called it `review_task`, which does not exist.

- A conflict materialises as a `conflict_review` row that syncs **only to devices whose tenant,
  role and location scope permit acting on it** — scope is normalised into
  `conflict_review_location` and the data query filters on it (§3.6.2), so the client does not
  filter and cannot leak. A cashier never sees a credit-limit dispute.
- It appears as a numbered item in a persistent Tasks area with an unread count in the primary
  navigation. It survives reload, app update and device restart. It is never a toast.

### What renders offline, and what does not

The first draft specified a review screen showing "both versions side by side with who, where, when
and what was happening around each… plus the customer's current exposure". §3.6.2 corrected exactly
that: **the heavy `context` snapshot is not synced.** It is stored server-side in
`conflict_review_context` and fetched when a reviewer *opens* the item, online. What syncs is
`proposals_summary` — actor, role, location, HLC, proposed value, stated reason — because a
severity-1 review must not put a customer's credit history on sixty-five tablets. Implementing §8's
version would have either re-created the leak §3.6.2 closed, or failed silently offline on a path
§8.2's online-only list did not include.

| Panel | Source | Offline |
|---|---|---|
| The proposals: both values, both actors, both locations, both HLCs, both stated reasons | `proposals_summary`, synced | **Renders** |
| The ancestor value and the current pending value | synced with the review | **Renders** |
| Context: balance, ageing, oldest invoice, 12-month purchase history as at the moment the conflict opened | `conflict_review_context`, server-side | **"Needs a connection to show the customer's position"** — an honest named state, not a spinner and not an empty panel |
| Resolution controls, severity 1 | — | **Disabled, with the reason shown**: §3.6.1 forbids offline severity-1 resolution because two offline reviewers resolving one review is a recursion class #19's CAS does not close |
| Resolution controls, severity 2–4 | — | Enabled; the resolution is an ordinary mutation with its own `write_id` and HLC |

Resolution is two explicit, differently-worded buttons naming the value each picks, plus "enter a
third value" and "keep the ancestor". There is no "resolve" button that hides which version it is
choosing. A note is mandatory at severity 1 and 2 (§3.6.2) and it lands on the entity's audit trail,
not only in the review record.

**Anything still under review shows a caveat where the data is used.** §3.6.2 makes this
field-level, not page-level, and makes it change behaviour: if a customer's credit limit is
disputed, the counter sees it on the customer at the moment of a credit sale, and credit is
permitted only up to the ancestor value (§3.6.1 step 4) — not only in a queue somebody opens on
Friday.

---

## 8.7 The counter flow

### Two price lists, never ambiguous

Price lists are tenant configuration rows (`price_list.id`, `.label`, `.tax_inclusive`), not an
enum. Tenant #1 ships two — a retail list and a wholesale/contractor list — but the client knows
only "the tenant's price lists" and "the default for a walk-in".

- The active list is **a persistent chip in the cart header**, in words from configuration.
- The list follows the **customer selection**: choosing a credit customer switches to their assigned
  list and says so, out loud, as a line in the cart. There is no hidden toggle whose state you have
  to remember.
- **Changing the list re-prices the whole cart and shows the before/after total.** Silent re-pricing
  is how the wrong price gets charged.
- Price-list resolution is deterministic per §4.6's total tie-break, evaluated against
  `cash_session.business_date` — never `Date.now()`.

### Discounts and overrides are two different things

The first draft said outlet staff "cannot override a price at all" and never used the word
*discount*. That defeats the gross-revenue ruling at the point of capture. §5.6.2 rule 1b posts
gross revenue with a `SALES_DISCOUNT` contra account, added because *"a manager granting approved
overrides all day produced books indistinguishable from lower list prices."* §4.8 carries
`sale.discount_minor`, `sale_line.line_discount_minor`, `is_price_override`, `override_approved_by`
and `price_list_item_id` (`NULL if overridden`). §2.4 treats `pos.discount.apply` and
`pos.price.override` as **two different permissions with different risk classes**. If the client
writes an agreed GH₵75 into the price field against a GH₵78.50 list price — the only thing the first
draft's model could do — then `price_list_item_id` is lost, `line_discount_minor` is zero, the
server can only post net revenue, and the gross-sales figure §5.6.4's margin metric depends on never
existed.

**The cart line carries list price and discount as separate captured facts:**

| Captured | Column | Permission |
|---|---|---|
| What the price list said | `list_price_e4`, `price_list_item_id` | — |
| A bounded discount off it | `line_discount_minor` (and `sale.discount_minor` for a document discount) | `pos.discount.apply`, **bounded** by the role's `max_bps` |
| An arbitrary price | `unit_price_e4` with `is_price_override = true`, `override_approved_by` set, `price_list_item_id` NULL | `pos.price.override`, **sensitive and `requires_fresh_authorization`** |

- **Discount is the ordinary path.** The keypad offers a percentage or an amount, the client shows
  the cap from the permission binding (`max_bps`, rendered as the tenant's own words), and a request
  above the cap is refused locally with the reason. The cap is enforced server-side at ingest; the
  client rendering it is a courtesy, not the control (§2.4).
- **A document discount allocates by §4.13 rule 4** — largest remainder, remainder minor units to
  the highest-value lines in `line_no` order — and on a tax-inclusive price list it is applied to the
  gross before de-grossing, per rule 10. Both are in `src/data/pricing.ts` with the server's vectors.
- **An override is a distinct, deliberate action** rendered as "Ask manager", never as an editable
  price field. Price is static text on the line, not a disabled input, because a disabled input
  invites tapping.
- **Manager approval works offline**, and §2.7 already supplies the mechanism the first draft
  deferred: the approving manager unlocks with their 6-digit PIN on this device, which unwraps their
  per-user, per-device key. That key is an offline-verifiable credential and its use produces
  `override_approved_by` at capture — which §4.8's `CHECK (NOT is_price_override OR
  override_approved_by IS NOT NULL)` requires, so the row is otherwise unwritable.
- **The device's check is not the enforcement.** §2.4's load-bearing sentence: both checks run
  server-side at ingest. The ingest handler calls `authorize(ctx, 'pos.price.override', …)` and, on
  failure, the write lands in `sync_quarantine` with the payload intact and the sale is reported as
  an exception on the outlet's daily reconciliation. Losing the record is worse than recording an
  unauthorized act. **This is why capturing the override as an intent works**: it is §3.7.2's "model
  intent, not outcome" applied to authorization.
- **The consequence that needs a business decision:** the approving manager must have unlocked on
  *that specific tablet* at least once while online, or the approval cannot happen offline. At a
  micro-outlet visited monthly by a regional manager, that may not hold. **Q-I in §8.12.**

### The conversion confirmation — the counter *does* do unit maths

The first draft said "the counter never does unit maths — a staff member sells *three 12m lengths*,
and the conversion to tons is the data model's job", and that the staff member "never performs a
conversion". §4.4.4 rules the opposite, and §4.8 now backs it with a constraint:

> **The POS computes 234.375, rounds half-up to 234, shows it to the operator, and requires
> confirmation before the sale commits.**
> `CHECK (qty_stock = qty_stock_computed OR conversion_confirmed_by IS NOT NULL)`

Without that step the client cannot supply `conversion_confirmed_by`, so any line where the yard
hands over a different count fails the CHECK, `422`s and dead-letters — for all 26 of tenant #1's
dual-unit rows. §8.3(b) of the first draft is deleted.

The line control, on the 33 SKUs that need it:

1. The operator picks the selling unit (`is_default_sell` first, then `sort_order`). Two units, two
   segments; the control does not appear on the other 186 SKUs.
2. `qty_sell` is entered in that unit at its `qty_scale`.
3. The client computes `qty_stock_computed` by §4.13 rule 1, using the **snapshotted** rational
   `factor_num/factor_den` — never a decimal factor. 2.5 t of 12 mm rebar is `2500 × 13500 / (144 ×
   1000)` = 234.375 → 234 bars.
4. **The computed stocking quantity is shown and confirmed.** "234 bars leaving the yard — confirm
   or change." Confirming records `qty_stock = qty_stock_computed` with no approver.
5. **Amending within `product_uom.tolerance_bp`** records the amended `qty_stock` and
   `conversion_confirmed_by = the confirming user`. 235 bars against a 234 computation is 43 bp on
   the template's derived tolerance and passes.
6. **Beyond tolerance** the line needs a permission counter staff do not hold and raises a
   `CONVERSION_OUT_OF_TOLERANCE` review (§4.4.4). The manager-approval path is the same one used for
   an override.
7. `factor_num`, `factor_den`, both quantities and both scales are written onto the line, so
   correcting a factor tomorrow does not restate a historical document.

This is one extra tap on a sale that is already unusual, and it is the difference between a stock
ledger that reconciles to the yard and one that is quietly wrong 234 times out of 235.

### Which stock balance the counter reads

The first draft never said, and there is a wrong answer available. §4.7.3 and §5.6.3 rule that
in-transit stock lives at the **sending location's durable TRANSIT node**, which is
`is_trading = false, is_postable_location = true`. A counter that reads all balances at its own
location therefore sells 40 bags that are already on a truck.

- **The sale path reads sellable on-hand at the trading location only, excluding that location's
  own TRANSIT node.** The transit balance is visible on a separate "on the road" view for anyone
  with `stock.transfer.initiate`, and never in the cart.
- **`is_stale` is honoured.** §3.7.1 requires `stock_balance` (§4.7.2's table; §3.7.1 calls it
  `stock_balance_current` — one of the names §3.11.9 must reconcile) to carry `is_stale boolean`
  and for it to sync. A device holding a stale row **falls back to full local replay** over the
  movements it holds; if the window does not reach far enough back it shows *"stock figure
  recalculating"* rather than a number it cannot stand behind. The first draft mentioned neither.
- **The replay has a budget and it is not free.** It aggregates scaled integers over up to 90 days
  of `stock_movement` rows for one product, and §8.3 bans `SUM` on a scaled column, so it runs in
  TypeScript over `bigint` from `CAST(qty_delta AS TEXT)`. It is on the sale path, inside the 80 ms
  add-line budget. §8.10 carries it as its own line item and it is measured on the reference device,
  not asserted. If it misses, the fallback is the "recalculating" state, never a stale number.
- **Negative on-hand does not block a sale** (§4.7.2). It raises a review item and a location alert.
  A counter that refuses to sell cement visibly stacked behind it teaches staff to work around the
  system.

### Search that tolerates how people actually type

A contractor asks for "half-inch rod", not "Reinforcement Bar 12mm". Search is local, so we can
afford to be generous.

```sql
-- Local-only. EXTERNAL CONTENT over the synced catalogue, maintained by triggers.
CREATE VIRTUAL TABLE local_sku_search USING fts5(
  code, name, category, sub_category, size_spec, aliases, tokens,
  content = 'product', content_rowid = 'rowid',
  tokenize = "unicode61 remove_diacritics 2",
  prefix   = '2 3 4'
);
```

- **Incremental maintenance, not rebuild.** The first draft rebuilt the index "whenever the synced
  catalogue changes". At 219 rows that is fine and at 20,000 it is a multi-second blocking write
  every time a price list syncs. External-content FTS5 with insert/update/delete triggers keeps it
  incremental.
- **The tokenisation profile is template and jurisdiction-pack data, not platform logic.** The first
  draft hard-coded a lumber-and-rebar profile into the platform's search index — `2"x3"`, `2 x 3`
  and `2 by 3` collapsing to one token; `12mm` indexing as `12mm`, `12` and `mm` — two subsections
  before §8.9 declares that class of thing forbidden. A pharmacy tenant would get a normaliser tuned
  for imperial timber dimensions and a food distributor would get `12` matched against `12mm`. So:
  `search_profile` is a tenant configuration row (dimension patterns, unit-suffix splitting, synonym
  collapses, casing and punctuation rules), the platform ships a conservative default, and **the
  construction-materials template ships the timber-and-rebar profile** alongside its aliases. The
  same normaliser runs at index time and at query time, from the same profile row.
- **`aliases` is tenant data, and it is a first-class product feature**, not a hack. Managers add
  the words their customers actually use — "rod", "iron rod", "half-inch rod", "zinc", "chalk".
  Seeded from the template, edited forever after. This is the highest-leverage thing in the counter
  flow and it costs one text column.
- **Rank by what this location actually sells.** `local_sku_rank(product_id, sold_count, window_days)`
  computed from local sale lines, blended with `bm25()`. Seeded at template application from a
  **generic template-supplied ranking hint**, not from a named product column — the first draft
  seeded it from `turnover_speed`, which is one tenant's catalogue attribute and does not belong as a
  platform column. Cement should win a two-letter query at every outlet **because the outlet sells
  it**, not because a constant says so.
- **Recompute on an idle callback with a staleness bound**, not "nightly". A tablet powered down
  each evening never reaches a nightly job. The rank is recomputed when `requestIdleCallback` fires
  and the table is older than its bound (default 24 h), and always after hydration.
- **A zero-result search falls back** to a trigram-similarity pass before it says "nothing found",
  and "nothing found" is never a dead end: it offers catalogue browse and a special-order path.
- **Queries run in the SQLite worker.** Input is debounced ~120 ms, results are keyed so a slow
  query cannot overwrite a newer one, and the main thread never blocks on a keystroke.
- Camera barcode scanning (`BarcodeDetector`) is an optional accelerator for the SKUs that carry
  barcodes — paint, tools, fixings. It is never a dependency; sand and rebar have no barcode.

### Touch, held carts, and the fast path

- **Minimum 56 × 56 dp** for any target on the sale path, 12 dp apart. WCAG's 44 assumes a clean
  screen and an unhurried finger; neither holds here.
- **No hover-dependent affordance, no required drag, no long-press-only action.**
- **Destructive actions get undo, not confirmation.** A confirm dialog on every line removal trains
  people to tap through dialogs, which is precisely how the one dialog that mattered gets dismissed.
  Removing a line removes it, with a 5-second undo bar. Voiding a completed sale — a real,
  ledger-visible event that creates a reversing document — is the exception and takes a deliberate
  second step with a reason code.
- **Held carts exist**, because at a builders' merchant a customer leaves to fetch money and the
  cashier must serve the next person. A held cart is a `local_draft_sale` in state `HELD`, named by
  the customer or a colour, resumable from a persistent strip. It holds no receipt number and burns
  no sequence. **Held carts survive a client schema change** — see §8.11's migration policy, which
  exists because of them.
- **A quick grid of this location's top SKUs** occupies the counter's first screen, from the same
  `local_sku_rank` as search. Tap adds one; the quantity chip on the line opens a numeric pad.
- **The stated target for the highest-volume sale in the business**: 20 bags of OPC 42.5N, cash,
  walk-in, receipt printed — **≤ 8 taps and ≤ 10 seconds from an empty cart**, on the reference
  device in §8.10, offline, with a cash session already open. This is an acceptance test, not an
  aspiration.

---

## 8.8 Receipt printing — the highest-risk part of the client

`ADR-0003` already calls this the PWA's weakest point. Stating the risk more precisely, because the
precision is what makes it testable:

1. **Web Bluetooth speaks BLE GATT only. It cannot open a Bluetooth Classic RFCOMM/SPP serial
   socket — at all, on any platform.** Most sub-$60 58 mm thermal printers sold into West African
   markets are SPP-only. If the printers the tenant can actually buy are SPP, no amount of client
   engineering reaches them from a PWA. **This, not flakiness, is the most likely way printing
   fails**, and it is a procurement question as much as an engineering one.
2. **Persistent device permission is the second gate.** If `navigator.bluetooth.getDevices()` is
   unavailable on the target Chrome build, every single receipt requires the user to pick the printer
   from a chooser dialog, triggered by a user gesture. That is not a POS. Whether the permission
   backend is enabled on the target builds must be *measured*, not assumed.
3. **WebUSB is not a primary path on this hardware.** It works in Chrome for Android, but needs USB
   OTG, and a cheap tablet that is charging usually has no port free. Useful at a flagship counter
   with a powered desk; not a fleet answer.
4. **Even when BLE works, there is no back-channel.** Writes go out in MTU-sized chunks with no
   acknowledgement; the app cannot tell that the paper ran out. "Printed" means "bytes were
   accepted", and the UI must say the weaker thing it actually knows.
5. **The `companion-bridge` fallback has a constraint the first draft never stated.** An HTTPS page
   issuing subresource requests to `http://127.0.0.1` is **mixed content**, and **Private Network
   Access** adds a preflight requirement on top; both are moving targets on Chrome for Android and
   either can make the fallback non-viable for reasons that have nothing to do with the shim's size.
   If the shim must serve a PNA preflight, or the device must trust a locally-issued certificate,
   then "the shim stays tiny and effectively never changes" is no longer true — it acquires a TLS
   story and a certificate lifecycle across 25 outlets. **This goes in the spike matrix**, measured
   on the same Chrome builds as the BLE work.

### How the client is built so the answer can change

Printing is an interface with swappable transports and a mandatory fallback. Nothing in the sale
path knows which transport is in use.

```ts
interface ReceiptTransport {
  readonly id: 'ble-escpos' | 'webusb-escpos' | 'companion-bridge' | 'system-print' | 'none';
  probe(): Promise<TransportHealth>;
  /** Never rejects into the sale path — AND never hangs. Settles within `timeoutMs`
   *  (default 12 s) with {outcome:'timeout'}. A promise that cannot reject can still
   *  hang forever on a dropped GATT connection, which is the same outage with a
   *  friendlier stack trace. */
  print(doc: ReceiptDocument, timeoutMs?: number): Promise<PrintAttempt>;
}
```

| Transport | Viability | Role |
|---|---|---|
| `ble-escpos` | BLE GATT printers only; needs persistent permission | Intended primary |
| `webusb-escpos` | Needs OTG and a free port | Flagship desk counters |
| `companion-bridge` | Tiny native APK exposing loopback HTTP; PWA posts to `127.0.0.1` — subject to mixed-content and PNA, above | Fallback if BLE fails — but see §8.13 |
| `system-print` | Android print framework via `window.print()` | A4 invoices only; too slow for a queue |
| `none` | Full-screen receipt with a large receipt number | **Mandatory.** Every tenant, every device. |

Three rules that hold regardless of which transport wins:

- **The sale is committed to local SQLite before any print is attempted.** A print failure is a
  retry against a completed sale. It is never a rollback and never blocks the next customer.
- **The `ReceiptDocument` is derived from the sale's own snapshotted rows, and carries its scale.**
  It renders from `sale`, `sale_line`, `sale_line_tax` and `sale_tender` — which already snapshot
  everything §4.8 lists, including `currency_code` and `money_scale` — plus the pack's required
  fields and tenant branding. **The formatter takes the scale from the document, never from the live
  pack** (§8.3), so a redenomination cannot re-render a historical receipt at the new exponent.
  **It is not stored a second time.** The first draft implied a stored structured document, which
  would double §3.2.4's 8 MB-per-micro-outlet arithmetic for no gain; what *is* cached is the
  rendered byte-stream in `local_print_queue`, per sale, discarded once printed or after 7 days.
- **Failed prints queue per sale** and are retryable from the sale, so a printer that comes back
  after a power cut can catch up without anyone re-ringing anything.

### The Phase 1 printing spike — scheduled, gated, and *early*

`ADR-0003` requires this proven during Phase 1. Concretely, it runs in **the first three weeks of
Phase 1, before the tenant buys printers**, because the finding can change the purchase order more
cheaply than it can change the client.

**Matrix:** two representative tablets (~2 GB RAM, Android 11–13, current Chrome) × at least three
printer models actually purchasable in Ghana, including at least one known BLE GATT model and one
commodity SPP model, plus one Android-POS terminal with an integrated printer. **Plus a
`companion-bridge` cell**: loopback HTTP from the installed PWA on each Chrome build under test,
with and without a PNA preflight, recording whether mixed content is blocked.

**Protocol:** 200 consecutive receipts per device/printer pair; printer power-cycled mid-run; tablet
screen locked and the PWA backgrounded mid-run (Android drops GATT connections — measure it); a
Chrome update applied and the run repeated.

**Pass criteria:**

- ≥ 99.5 % of print attempts succeed on the first try **with no device-chooser dialog**;
- median receipt (12 lines, 58 mm) printed in < 3 s, p95 < 5 s;
- automatic reconnection < 5 s after a printer power cycle, with no human step;
- **zero hangs**: every attempt settles within the timeout;
- zero cases where a print outcome altered, delayed or duplicated a sale record.

**What would reopen the native-Android question (`ADR-0003`)** — any one of these, raised the day it
is observed, not at pilot:

- the printers procurable in the market are SPP-only, so Web Bluetooth cannot address them;
- persistent device permission is unavailable, forcing a chooser dialog per receipt;
- first-try success below 99 %, or reconnection after a power cycle requiring a human;
- backgrounding or screen-lock reliably kills the connection with no recovery inside the PWA;
- **the loopback fallback needs a certificate or a PNA-serving shim**, because that is the point at
  which the "tiny, unchanging shim" argument fails.

The honest reading of the fallback column: **`companion-bridge` is already a partial concession.**
It means shipping a native APK to 25 outlets, which is the cost `ADR-0003` chose the PWA to avoid.
It is worth it only if the shim stays tiny and effectively never changes, so the fleet update story
survives for the 99 % of the product that is not printing. If the shim starts growing, the argument
for the PWA has already lost and we should say so rather than accumulate a second codebase by
degrees.

---

## 8.9 Tenant-driven presentation

The client is tenant-aware and never tenant-authoritative. It renders what configuration says.

| Surface | Source | Never |
|---|---|---|
| Location type chip | `location_type.label` / `.label_plural` | `"Flagship"`, `"RDC"`, `"Micro-Outlet"` |
| Role names | `role.name` | A role enum in TypeScript |
| Customer segments | `customer_segment.label` | `"contractor"` |
| Currency symbol, scale, grouping | Jurisdiction pack (`ADR-0007`), snapshotted on documents | `GH₵`, `/100`, `toFixed(2)` |
| Tax code and component labels, receipt fields | Jurisdiction pack | `"VAT"`, `"NHIL"`, `"GETFund"` |
| CoA account labels | Tenant's chart of accounts | Any hard-coded account name |
| Price list names | `price_list.label` | `"Retail"` / `"Wholesale"` |
| Receipt branding, receipt-number format | Tenant config + pack (§3.7.5) | Per-tenant CSS or a per-tenant build |
| **Search tokenisation profile** | `search_profile`, template data (§8.7) | Imperial timber dimension patterns in platform code |
| **SKU ranking seed** | Generic template-supplied hint | A named product column such as `turnover_speed` |
| Escalation chains, notification channel | Tenant config (§3.6.2) | "SMS because Ghana" |

Two distinctions that keep this honest:

- **Product chrome vs. tenant terminology.** "Search", "Cart", "Complete sale" are product copy and
  live in the string catalogue. "Contractor", "Flagship", "facility fee" are *one tenant's words for
  their own things* and live in that tenant's data. When those are confused, the product ends up with
  an `if (tenant)` in a component, which `CLAUDE.md` §2.9 forbids.
- **The load-bearing enforcement is type-level; the grep is a second belt.** The first draft
  presented a build-time banned-token grep as the enforcement, and a grep cannot do the job. It
  cannot recognise "the literal `100` **in any money context**", and it will not fire at all on the
  real leak, which is a component branching on tenant *data* — `priceList.label === 'Wholesale'`,
  `location.code.startsWith('TKM')` — where no banned token appears in source. So:
  - **Branded types** (`Minor`, `Qty`, `RateE4`, `Bp`, `Formatted`) with the typed-lint rule from
    §8.3 banning arithmetic operators outside `src/data/`. `Formatted` cannot be compared for
    equality, which kills the whole class of "compare the rendered label" bug.
  - **A `TenantLabel` display type** for every value in the table above: it renders and it does not
    compare. `priceList.label === 'Wholesale'` does not type-check; `priceList.isTaxInclusive` does.
    Behaviour hangs off configuration *properties*, never off labels.
  - **The grep stays** — `Flagship`, `RDC`, `Micro-Outlet`, `contractor`, `GH₵`, `pesewa`, `Ghana`,
    `VAT`, `NHIL`, `GETFund` outside `packages/jurisdiction-*` and the template seed files — because
    it is cheap and it catches the copy-paste. It is not presented as the control.

There is one artefact for all tenants. Configuration is data that arrives through the sync stream
like everything else, so a tenant renaming "contractor" to "trade account" takes effect at every
counter on the next sync, with no deploy.

---

## 8.10 Performance budget

### The reference envelope is the platform's, not tenant #1's

The first draft's reference dataset was "the tenant #1 dataset (219 SKUs, 90 days of one location's
transactions)", and "219 SKUs is already too many" read as a platform statement when it was a tenant
statement. That is `CLAUDE.md` §2.9 / `ADR-0006` at the level of engineering commitments rather than
code: the platform's only stated performance envelope was one customer's catalogue, and a second
tenant with 5,000 SKUs and 300 sales/day had no budget at all — while §8.9's own rule (one artefact;
tenant differences are configuration) is what makes that a problem rather than an inconvenience.

**Reference device:** a ~2 GB RAM Android tablet, mid-range SoC four or more years old, eMMC
storage, current Chrome.

**Reference envelope (platform):**

| Dimension | Envelope | Tenant #1 flagship, for comparison |
|---|---|---|
| Active products | 5,000 | 219 |
| Sales per day per location | 400 | ~200 across 4 tills |
| Lines per sale | 4 | ~2.5 |
| Concurrent tills per location | 4 | 4 |
| Sync window | **tenant-configured**, jurisdiction-pack floor (§3.2.4); budgets stated at 90 days and scale linearly | 90 days |
| Customers with credit | 2,000 | ~150 at FY1 |

Local row count is a function of the configured window, not a constant:
`rows ≈ window_days × sales_per_day × (1 sale + L lines + L tax + L movements + 1.2 tenders)`.
At the envelope and 90 days that is ~470,000 rows against tenant #1's ~30,000. **The client
publishes a device-class ceiling**: if `window_days × throughput` computes past the envelope for the
device class, hydration is refused with a plain explanation and HQ must shorten the window or move
that location to a higher device class. It never degrades quietly into a till that takes eleven
seconds to add a line.

### The budget

| Item | Budget (p95) | Note |
|---|---|---|
| **SQLite WASM binary (with FTS5), gzipped** | **1.2 MB** | Precached. Not counted in route JS. |
| **WASM fetch-from-precache + compile + instantiate + OPFS VFS open** | **700 ms** | The first draft omitted this entirely and then set a 2.5 s cold start; on this SoC it is commonly 300–700 ms before a single query runs. |
| Cold start (installed, warm OPFS, WASM in code cache) → counter interactive | 3.5 s | Includes the row above |
| First launch after an update (WASM recompiled) | 6 s | Once per release, and it is why activation is atomic |
| Keystroke → search results painted | 120 ms | At 5,000 products |
| Add line to cart → repaint | 80 ms | Includes pricing, conversion, tax per component |
| **Stale-balance local replay for one product** | **60 ms**, inside the 80 ms above | §8.7 / §3.7.1. Measured, not assumed: `bigint` aggregation over up to 90 days of movements. |
| Complete sale → receipt screen (local commit) | 300 ms | The full §8.2 transaction: header, lines, tax rows, tenders, movements, `write_log` |
| Interaction to Next Paint on the sale path | 100 ms | |
| Longest task on the sale path | 200 ms | |
| Counter route JS, gzipped (initial) | 250 KB | Excludes the WASM binary |
| All routes, gzipped | 600 KB | Excludes the WASM binary |
| **JS heap after an 8-hour shift** | **100 MB, growth < 8 MB/hour** | |
| **WASM linear memory after an 8-hour shift** | **96 MB, growth < 4 MB/hour** | **New.** OPFS-backed SQLite holds its page cache in `WebAssembly.Memory`, which grows and never shrinks and **is not JS heap**. A leak budget that measures only the heap measures the wrong layer. Enforced by an explicit `PRAGMA cache_size` byte cap. |
| **Combined renderer footprint** | **200 MB** | The number that actually decides whether Chrome OOM-kills the till |

The last three rows are the ones usually omitted and they matter most here. These devices are not
reloaded daily; a till stays open for days. **A leak budget is a harder constraint than a start-up
budget on this fleet**, and the sale path is the code that runs ten thousand times between reloads.

### How the budget is held

- **Virtualise every list over ~30 rows** with fixed-height rows, so nothing measures the DOM.
- **Paginate in SQL, not in the renderer.** Keyset pagination (`WHERE (hlc, id) < (?, ?) ORDER BY
  hlc DESC LIMIT 50`), never `SELECT *` then slice.
- **Narrow live queries.** Each component subscribes to the smallest query that answers its
  question, so recording a sale invalidates the sales list and the balances for the affected products
  and nothing else re-renders. One broad `useEverything()` hook would defeat local SQLite entirely.
- **Client-owned local indexes** are this section's deliverable, not the server's:
  `sale(location_id, hlc DESC)`, `sale_line(sale_id)`, `sale_line_tax(sale_id, line_no)`,
  `stock_movement(location_id, product_id, hlc)` (the replay path), `stock_balance(location_id,
  product_id)`, `conflict_review(required_permission, status)`, plus the FTS5 table in §8.7.
- **Lazy-load everything that is not the counter.** Reporting, admin, ledger review and the
  template/onboarding flows are separate chunks. A cashier's device should never parse the GL review
  screen's JavaScript.
- **Measure on the fleet, not on a laptop.** A ring buffer records p50/p95 for the named interactions
  and syncs one aggregate row per device per day. That row is **`device_perf_daily`** — a tenant-owned
  table with `tenant_id`, `write_id`, `device_id`, a 90-day retention policy and a note that it is
  device telemetry landing in a tenant's exportable dataset. It needs a home in §4; recorded in
  §8.12. CI fails the build on a regression.
- **CI approximates the device with 4× CPU throttling, and the approximation has a stated blind
  spot:** CPU throttling does not model eMMC random-write latency, which is the binding constraint
  for SQLite over OPFS on this hardware. CI catches regressions in compute; only the physical device
  catches regressions in write amplification. The commit budgets (`complete sale`, `add line`) are
  therefore **device-gated, not CI-gated**, and re-measured on the hardware every release train.

If a screen feels slow, the network is not available as an excuse. Reads are local; slowness is this
section's defect.

---

## 8.11 Service-worker updates and schema lockstep

### Updating 25 outlets without stranding one

- Workbox service worker, build-hashed precache, **`skipWaiting` disabled**. A new version never
  activates under a cashier mid-sale.
- **Activation is atomic.** The new build becomes eligible only once every precache entry —
  including the SQLite WASM binary — is stored. A device that loses connectivity mid-download stays
  on the working build rather than half-updating into an unbootable shell.
- The client polls a small `release.json` (`no-store`) carrying
  `{ build_id, min_client_schema, min_writable_schema, max_client_schema, cohort }`.
  `devops-engineer` owns cohort mechanics; the client honours them, so a release reaches the pilot
  location, then a region, then the fleet.
- **The update prompt is a status-bar affordance, never a modal**, and it applies at a safe point:
  no cart in progress, no sale in flight, no print queued. Otherwise it waits, or applies at the
  tenant's configured quiet hour, or on next launch.
- **An update that crosses `min_writable_schema` is not deferrable.** Ordinary updates can be put
  off; an update the device needs in order to keep writing applies at the next safe point or at
  next launch, whichever comes first, and the "later" control is removed. This is the client half of
  the fix in "quarantine, corrected" below: a build cannot drift three releases behind by a person
  tapping "later" forever.
- The sync endpoint and `release.json` are never cached. Old caches are purged on activate.

### Local-only tables have a migration policy, and it is not "drop and recreate"

Local-only tables in a sync-managed schema are normally dropped and recreated on a client schema
change. The first draft put the cart in local-only tables to survive a battery pull and then let
`client_schema_version` move, which destroys them — and its "applies at a safe point: cart empty"
protects only the *in-flight* cart. The unaddressed case is the **held cart** (§8.7) and the
**sequence cursor** (§8.2b), neither of which is empty at a safe point.

| Local-only table | Policy |
|---|---|
| `local_outbox` | **Never dropped, and never rewritten.** §3.3.3: the device computes `request_hash` at enqueue and a client upgrade must not change the hash of an already-queued mutation — otherwise every rollout re-hashes the queue, returns `409 IDEMPOTENCY_KEY_REUSE` and parks a day's takings across the fleet behind an alert storm. A migration may add columns; it may never touch `id`, `payload` or `request_hash` of an existing row. |
| `local_sequence_cursor` | **Never dropped.** Explicit forward migration on every schema change. Losing it reissues receipt numbers (§3.6 class #14). |
| `local_draft_sale`, `local_draft_sale_line`, `local_draft_tender` | **Explicit forward migration.** Held carts survive. If a migration genuinely cannot preserve them, the update gate becomes "no drafts at all" — the operator is told to clear or complete held carts — and it is never a silent drop. |
| `local_print_queue`, `local_sku_rank`, `local_sku_search`, `local_perf_sample` | Droppable and rebuildable. Rebuilt on first launch after the update. |

The rule stated once: **a local-only table is droppable only if its contents can be reconstructed
from synced data.** Anything else gets a migration, and a CI check fails a client schema change that
adds a non-reconstructable local table without one.

### Schema lockstep — and why the client refuses to write

Two versions are in play: the `sync_schema_version` the server serves, and the
`client_schema_version` a build expects. The server sends its version and its supported range in the
sync handshake, and the client checks at boot **and on every reconnect**.

**Below `min_writable_schema` the client enters write quarantine.** It shows an unmissable,
full-width, plainly-worded block — *"This till is out of date and cannot take sales. Update now."* —
and:

- it **still displays** already-recorded data, so the outlet is not blind;
- it **still drains its upload queue** (see the correction below, which is what makes that true);
- it **accepts no new writes of any kind**.

**Why refusing to write beats writing something subtly wrong.** A refusing till costs one outlet an
hour and a phone call, and everyone knows immediately which outlet and which hour. A client writing
against a drifted contract — a dropped column silently discarded, a renamed field defaulting to
zero, a tax line landing under a code the server no longer recognises — produces data that looks
fine at the counter, syncs cleanly, and surfaces weeks later as a trial balance that will not
balance, across 25 locations, with no way to identify which rows are wrong. In a system that is its
tenant's book of record with no accounting SaaS behind it to catch the drift (`ADR-0004`), that
trade is not close.

### Quarantine, corrected — the server contract §8 asserted does not exist

The first draft supported "it still drains its upload queue" with this claim:

> *"the server must keep accepting writes from any client version it has ever served, for a
> compensation window of at least 90 days."*

**§3 offers no such contract and §3 is authoritative.** §3.3.3: the server supports **N−2** and
answers an unsupported `schema_version` with a **retryable** `426 UPGRADE_REQUIRED`, never a
discard; §3.3.4 lists `426` as retry-with-backoff. PowerSync's queue is ordered, so on a till three
releases behind, the first `426` blocks all 40 queued sales — permanently, by design, because
retryable means retry forever. The stated reason for allowing the drain is defeated in exactly the
case it was written for. The claim is deleted. In its place, four things, three of which are client
mechanisms:

1. **Write quarantine fires inside the accepted range, not at its edge.** `min_writable_schema` is
   set by `devops-engineer` **at least one full release above the server's hard N−2 floor**, so a
   device that hits write quarantine still has a whole release of headroom in which its already-queued
   writes are accepted. The client quarantines *before* it falls out of the write range, which is the
   only ordering in which "drain the queue" means anything.
2. **The §2.7 lease bounds how far a trading device can drift.** A device that has not synced within
   `hard_stop_at` (default 72 h + 24 h grace) is sealed and takes no new writes at all. So a device
   with a non-empty queue is at most one lease period behind the fleet. **This turns N−2 sufficiency
   into a release-cadence rule**: `sync_schema_version` must not advance by more than one step within
   any window of `hard_stop_at` plus the fleet drain SLO. That is a release-train constraint owned by
   `devops-engineer` and gated in the release pipeline, and it is what makes the whole scheme sound
   rather than lucky.
3. **Non-deferrable updates across the write floor**, above, so the "three releases behind" device
   is not reachable by a person tapping "later".
4. **The residual still needs a server-side answer.** A device restored from a backup, or re-leased
   after a very long outage, can arrive outside the write range holding a queue. Retrying `426`
   forever is not acceptable and dead-lettering a valid sale is not either — it converts a real sale
   into a rejection. The client's part: it detects sustained `426` on the head of the queue, shows
   `Not sending` naming the blocking write (§8.4), and offers a manager-authorised **"upload for
   recovery"** that POSTs the raw queued payloads to a durable server-side holding endpoint —
   the same shape as §3.3.4's `/sync/dead-letter` (durable server-side **before** the queue entry is
   released) but landing as replayable `sync_quarantine` items rather than rejections.
   **That endpoint does not exist and §3 must rule on it. Q-G in §8.12.**

Ordering follows: the backend deploys first and is backward-compatible; the client rolls out after.
A client ahead of its server is a rollout race, and it quarantines too, in the same way.

### Kill switch, its governance, and the staleness rule §8 got wrong

A `device_directive` row scoped by tenant and location syncs down and can force a minimum version or
set a device read-only, so HQ can stop a bad build from taking sales without an app-store round trip
or a site visit. **It only reaches a device that syncs**, which is exactly the device least likely to
be the problem.

**It also stops an outlet trading, and the first draft gave it no governance.** Setting a device
read-only is comparable in consequence to `admin.device.revoke`, which §2.4 classes as sensitive and
§2.6 audits. So: issuing a `device_directive` requires a sensitive permission, is an audited event,
appears on the tenant's security report, and carries a mandatory reason. Whether it should require
two-person approval, as §2.8 requires for platform-operator writes, is **Q-J in §8.12**. The table
itself needs a home in §4 with `tenant_id` and `write_id`; recorded in §8.12.

**On staleness, §2 governs and the first draft contradicted it.** §8 asserted "staleness never
blocks a cash sale" as settled. §2.7 specifies an **offline lease**, default 72 h plus a 24 h grace,
which "expires whether or not the device ever hears from the server" and enumerates precisely what
it gates. The correct statement:

- **0 → `full_until` (72 h): full operation.** Staleness escalates the status-bar wording (§8.4) and
  nothing else.
- **`full_until` → `hard_stop_at` (+24 h): restricted mode.** Cash sales at list price and stock
  lookups continue. Everything `requires_fresh_authorization` is blocked: credit sales, price
  overrides, credit-limit changes, stock adjustments, refunds, network reporting. The outlet keeps
  taking money; it stops taking risk.
- **After `hard_stop_at`: sealed.** Read-only, no writes, the in-memory data key dropped. **Cash
  sales stop.** Data is not wiped and the outbox survives encrypted.

So staleness *does* eventually block a cash sale, at `hard_stop_at`, and saying otherwise was the
client quietly overruling the security section. `T` is tenant-configurable to a 14-day platform
ceiling and its default is `Q-SEC-3` in §2.9 — which is what §8's old Q-E duplicated with a different
owner. Q-E is deleted.

---

## 8.12 What this section needs from other sections

### Open

| # | Need | Owner | Promote to `open-questions.md` |
|---|---|---|---|
| Q-A | **A supported-printer list, decided before tenant #1 buys hardware.** BLE GATT ESC/POS, or an Android-POS terminal. This is procurement, and it is the cheapest available mitigation of the largest client risk. | `product-manager` + founder | already carried |
| Q-B | Lost/stolen/resold device policy for a tablet holding a full local tenant dataset — the **confidentiality** half. Points at §2.7 and `Q-SEC-1`; the **lost-writes** half is answered by §8.5's attestation. | `rbac-security-engineer` + `devops-engineer` | already carried |
| **Q-G** | **A durable server-side recovery path for queued writes from a device outside the server's accepted `schema_version` range.** §3.3.3 answers `426` retryably and §3.3.4's only definitive rejection is `422`; neither fits a valid sale on a stale build. §8.11 proposes a `/sync/quarantine`-shaped holding endpoint. **§3 must rule.** | `sync-architect` | **yes — new** |
| **Q-H** | **The platform performance envelope.** §8.10 now budgets against 5,000 products / 400 sales per location per day / a configurable window, with tenant #1 as one point inside it. Those numbers are an engineering guess at what the product must support, not a product decision. If the answer is materially larger, the reference device and possibly the PWA choice change. | `product-manager` + founder | **yes — new** |
| **Q-I** | **Offline manager approval requires the approving manager to have unlocked on that specific tablet at least once while online.** §2.7's per-user, per-device key is the only offline-verifiable credential available, and §4.8's CHECK requires an approver at capture. At a Micro-Outlet visited monthly by a regional manager this may be operationally unacceptable. | `product-manager` + founder | **yes — new** |
| **Q-J** | **Governance of the kill switch.** A `device_directive` can stop an outlet trading. Who may issue one, does it need two-person approval as §2.8 requires for platform-operator writes, and does it appear on the tenant's security report? | `rbac-security-engineer` + `product-manager` | **yes — new** |

### Asks on other sections (engineering, not open questions)

| Ask | Owner |
|---|---|
| `device_sync_state` gains `oldest_unacked_hlc` and `unacked_receipt_range` (§8.5) | `sync-architect`, §3.11.4 |
| `accounting_period` rows resident in the reference bucket, so an offline till can refuse to open a session into a locked period (§8.2a) | `sync-architect`, §3.2.2 |
| `device_perf_daily` and `device_directive` need rows in §4 with `tenant_id`, `write_id` and retention (§8.10, §8.11) | `software-engineer`, §4 |
| Name reconciliation: §3.7.1's `stock_balance_current` vs §4.7.2's `stock_balance` (§8.7) | §3.11.9 |
| §2.4 says a sale line carries "`sku_id`, `qty`, `price_list_id`, `tax_code` and nothing else". §4.8 makes `unit_price_e4`, `list_price_e4` and the tax basis `NOT NULL` snapshots and §3.4.2 has the server recompute and compare. **§4 governs**; §2.4's sentence predates it and should be restated as "the client sends a price and the server never trusts it." | `rbac-security-engineer`, §2.4 |

### Closed by other sections

| # | Was | Now |
|---|---|---|
| Q-C | A bounded sync window for transactional history on counter devices | **Closed.** §3.2.4: per-row `archived_at`, 90 days on outlet devices / 400 on HQ, **tenant-configurable with a jurisdiction-pack floor**. §8.10's budget is restated as a function of the configured window. |
| Q-D | An offline-verifiable credential for in-person manager approval | **Closed.** §2.7's per-user PIN unwrapping a per-user, per-device key, plus §2.4's server-side re-authorization at ingest. The residual is operational, not cryptographic: **Q-I**. |
| Q-E | The staleness threshold at which a device is restricted | **Deleted — duplicate.** §2.7 owns it; the default is `Q-SEC-3` in §2.9. |
| Q-F | Q7 (fractional and dual units) resolved in the data model | **Closed.** §4.4 resolves Q7: 27 SKUs need fractional quantities, 30 need dual units, and §4.4.4 specifies the operator confirmation the counter implements in §8.7. |

---

## 8.13 Concerns

**1. The printing spike is scheduled correctly but sequenced too late by default.** `ADR-0003` says
"during Phase 1", which is right, but the finding is only cheap while it can still change the
purchase order. It should be the *first* work in Phase 1 and it should gate printer procurement.
This is a request for sequencing, not a disagreement with the decision. It now carries a
`companion-bridge` cell too, because the fallback's viability is as procurement-shaped as the
primary's.

**2. Local database encryption — restated against §2, which has already designed for most of it.**
The first draft said there is "no supported encryption story for WASM SQLite over OPFS in a PWA —
and any key the PWA could hold lives in the same origin storage as the data, so it would be
theatre." That was written as though §2 did not exist, and a Phase 0 reader comparing the two got
contradictory risk statements about the platform's largest accepted exposure. §2.7 specifies:
minimisation (a device holds one tenant, its own locations, and a rolling window — by far the
strongest control); a 6-digit per-user PIN, rate-limited with exponential backoff, unwrapping a
per-user-per-device key; **field-level encryption of a named sensitive set** — customer contact
details, credit limits and balances, cost prices and margins — under a data key held in memory only
after unlock, wrapped **both** by an Argon2id PIN-derived key **and by a server-held key**, which
answers the "the key is in the same origin storage" objection directly; and lease expiry, which
makes the local copy useless past `hard_stop_at`.

What the client can implement: all of it. What it costs, stated plainly because §2 states it: **an
encrypted column cannot be searched or indexed locally**, so everything the POS must search offline
— SKU, name, aliases, price, stock quantity — stays plaintext. The residual exposure after selective
field encryption is therefore a device holding one tenant's **catalogue, price lists and stock
positions** in the clear, for its own locations, for the configured window. That is a real
commercial exposure and it is smaller than the first draft implied, because the customer list,
credit positions and margins are not in it.

The remaining ask is unchanged and belongs to procurement: **Android Enterprise managed devices with
enforced screen lock and file-based encryption**, which a PWA cannot verify. That, plus `Q-SEC-1`'s
hardware-backed key storage, is the pair that would reopen the native question on security grounds.
**This does not change my view that the PWA is the right call** — the update story across 25 outlets
is worth more than the delta — but it should be recorded as a known, accepted risk with a named
owner rather than discovered during a security review.

**3. The performance envelope is an engineering guess about the product's market.** §8.10 now states
a platform envelope rather than tenant #1's catalogue, which is the right shape, but the numbers in
it came from me, not from a product decision. If the intended market includes distributors with
20,000 SKUs, the reference device is wrong, the sync window is wrong, and the honest conversation is
about a device class rather than a budget. **Q-H.**

**4. The offline approval path now works, and it has an operational cost nobody has agreed to.**
Closing Q-D against §2 means a manager can only approve on a tablet they have unlocked on while
online. That is correct security and it may be wrong operations at a Micro-Outlet. I have specified
the mechanism and named the consequence rather than quietly assuming a regional manager visits often
enough. **Q-I.**

**5. Six of the eight blocking findings in the review had one cause, and it is worth naming.** This
section was written against an earlier version of §3 and §4 and never re-read them. §4.17.1 records
the identical pattern in the data model — "drafted as though §3 and §5 did not exist" — and §3.11.9
exists because the same drift happened once already across the sync and data-model sections. The
corrective discipline is the one §4.17.1 states: **one owner per contract, named in the owning
section, and a cross-reference rather than a second definition.** For this section specifically:
§8 owns the device and the screens, and it owns **no** column, no protocol response and no rounding
rule. Where it needs one it cites it. A Phase 0 exit check should re-run every code sample in §8
against §3 and §4 as written on the day of the gate, because a document that shows the canonical
write must show the canonical write.

---

## 8.14 Revisions from adversarial review

Reviewed 2026-08-21 against `CLAUDE.md`, `ADR-0002/0003/0004/0005/0007`, and the authoritative
rulings in §2, §3, §4 and §5. **Eight blocking findings, twenty-one major, nine minor.**
**Where this subsection and the body differ, this subsection governs.**

### 8.14.1 The pattern behind the blocking findings

Every blocking finding except B3 and B8 came from the same cause: **this section was drafted against
an earlier data model and sync protocol and never re-read them.** It wrote a sale the server cannot
accept (B1), held a unit price at the wrong scale (B2), forbade the conversion confirmation §4.4.4
requires (B4), omitted the cash session the whole date model hangs on (B5), asserted a server
contract §3 does not offer (B6), and omitted the discount capture §5.6.2 rule 1b depends on (B7).
B3 (rounding) and B8 (the duplicate the code manufactures) are different: those are defects of
craft in this section's own territory, and they are the two I am least comfortable about, because
they were mine alone to catch.

### 8.14.2 Full disposition

| # | Sev | Finding | Disposition |
|---|---|---|---|
| B1 | Blocking | `completeSale` missing nine fields and two child tables; every sale definitively rejected | **Accepted.** §8.2's write re-derived from §4.8 as-ruled, with a table naming the client-side origin of every server-required field: `write_id` in the same local transaction, `cash_session_id`/`business_date` from §8.2a, `receipt_no` from §8.2b's cursor, `currency_code`/`money_scale` snapshotted, the four money columns, and `sale_line_tax`, `sale_tender`, `stock_movement` and the on-account `credit_entry` written in the same transaction. |
| B2 | Blocking | Unit price held at `minor`, not `rate_e4` | **Accepted.** Four scaled-integer domains (`Minor`, `Qty`+scale, `RateE4`, `Bp`) as branded types; the cart query and the `CAST(… AS TEXT)` rule name all four; prices never round at the unit. §8.3. |
| B3 | Blocking | No rounding rule stated; the obvious BigInt implementation truncates | **Accepted.** New §8.3 rounding section: `divRound(num, den, mode)` in `src/data/round.ts` as the only module where `/` may touch a scaled integer; typed-lint ban on arithmetic operators on the branded types; the six §4.13 rules the device runs (1–6, 10) tabulated with their client expressions; negatives in the shared vectors; `rounding_level`/`rounding_mode` written onto each `sale_line_tax` row. |
| B4 | Blocking | "The counter never does unit maths" contradicts §4.4.4 | **Accepted.** §8.3(b) deleted. §8.7 gains the seven-step conversion control: computed stocking quantity shown, confirm or amend, `tolerance_bp` bound, `CONVERSION_OUT_OF_TOLERANCE` beyond it, `conversion_confirmed_by` captured, factors snapshotted. Q-F closed. |
| B5 | Blocking | No cash session; no trustworthy date to price against | **Accepted.** New §8.2a: open with float and server-time validation, `opened_offline`, refusal into a locked period, one-calendar-day maximum with hard midnight auto-close and carry-over, close-and-count with variance. Every date-resolved quantity resolves against `cash_session.business_date`; `Date.now()` is lint-restricted to two call sites. |
| B6 | Blocking | Quarantine drain is false under N−2; §8 asserted a contract §3 contradicts | **Accepted.** The "any version ever served / 90 days" claim is deleted. Replaced with: `min_writable_schema` set a full release above the hard floor so quarantine fires inside the accepted range; non-deferrable updates across the write floor; a **release-cadence rule** derived from §2.7's lease (a trading device is at most one lease period behind, so `sync_schema_version` may not advance more than one step per `hard_stop_at` + drain SLO); and the residual raised as **Q-G**. |
| B7 | Blocking | Discounts and overrides absent; defeats the gross-revenue ruling at capture | **Accepted.** §8.7 gains list price and discount as separate captured facts, `pos.discount.apply` (bounded by `max_bps`) distinguished from `pos.price.override` (sensitive, fresh), §4.13 rule 4 largest-remainder allocation and rule 10 ordering in `src/data/pricing.ts`, `price_list_item_id` retained on discounted lines. |
| B8 | Blocking | The shown code manufactures the duplicate the section exists to prevent | **Accepted.** `ON CONFLICT (id) DO NOTHING` on the `write_log` claim with an idempotent success return; Complete disabled on first activation; the draft is **marked** `COMPLETED`, never deleted, so there is something to recover to; a named full-screen `NOT RECORDED — do not hand over goods` state for a failed local commit; storage headroom checked before the write (§8.1b); the id generated from the HLC's physical component per §3.7.3. |
| M1 | Major | "Stuck" keyed to connected time hides a poison message on a flapping link | **Accepted.** Escalation is on **wall-clock age of the oldest unacknowledged write**, displayed in every state. `Not sending` requires a reachability signal in the window plus age ≥ `stuck_after`; a genuinely offline device escalates on a separate, longer offline track. The blocking write is named, not the count behind it. |
| M2 | Major | Three badges collapse "a human must choose" with "not in the books" | **Accepted.** Five badges: `pending`, `accepted_pending_review` (§3.3.4's `routed_to_review`), `synced`, `needs_review`, and `rejected` — the last with its own escalation path and a line on the daily reconciliation. Column names corrected to `server_received_at` and `hlc`; `server_ack_at`/`server_seq` deleted. |
| M3 | Major | Tenant-switch wipe deadlocks; the two §8.1 rules contradict | **Accepted.** §8.1a: the OPFS path is keyed to `tenant_id` alone, databases coexist, the wipe-on-re-provision is deleted, and user identity is explicitly a lock-screen concern. |
| M4 | Major | The persistence gate is on selling, not hydrating | **Accepted.** §8.1b gates **hydration**; `persisted()` re-checked on every launch and resume with a transition to unpersisted treated as an incident; `estimate()` headroom checked before every write with `Storage low` / `Storage critical` as first-class device states. |
| M5 | Major | The sequence-block cursor is absent | **Accepted.** New §8.2b: `local_sequence_cursor` in the persisted store and never a draft table, consumed inside the document transaction, reported on every reconnect, **never resumed after a re-hydration** (`install_id`, fresh block requested, server burns the remainder), low-water in days of observed throughput, emergency `-D3F` form with a persistent counter message. |
| M6 | Major | Nothing knows a lost device held unsynced sales | **Accepted.** §8.5's attestation on every sync: `outstanding_estimate`, `oldest_unacked_hlc`, `unacked_receipt_range`. The two new fields are an ask on §3.11.4 (§8.12). |
| M7 | Major | Multi-tab and the OPFS single-writer lock unaddressed | **Accepted.** §8.1c: Web Lock election with a `BroadcastChannel` heartbeat and a "use it here instead" action; added as gate 2 in §8.1. |
| M8 | Major | Enrolment and the lease missing from the gates; §8.11 contradicts §2 on staleness | **Accepted.** Enrolment + unexpired lease is gate 3. §8.11's "staleness never blocks a cash sale" is withdrawn in §2's favour and restated as §2.7's three horizons — cash sales *do* stop at `hard_stop_at`. Q-E deleted in favour of `Q-SEC-3`. |
| M9 | Major | §8.13 concern 2 asserts a gap §2 has designed for | **Accepted.** Concern 2 rewritten against §2.7: what the client can implement (all of it), the stated cost (encrypted columns are unsearchable, so the searchable set stays plaintext), the **residual** after selective field encryption (catalogue, prices and stock positions in the clear — not customers, credit or margins), and Android Enterprise FBE plus `Q-SEC-1` as the remaining asks. |
| M10 | Major | Q-D is already answered in §2 and hardened in §4 | **Accepted.** Q-D closed against §2.7's per-user-per-device key and §2.4's ingest-side re-authorization; §8.7 states the intent-capture framing (§3.7.2) and the `sync_quarantine` outcome on failure; the enrolment consequence for managers is raised as **Q-I**. |
| M11 | Major | The review UI assumes data §3.6.2 stopped syncing and offers a resolution §3.6.1 forbids offline | **Accepted.** §8.6 rewritten as a per-panel table: `proposals_summary` renders locally, context is fetched online with an honest named state, severity-1 resolution is disabled offline with the reason shown. Table renamed `conflict_review`. |
| M12 | Major | "The only online-only operations" is presented as exhaustive and is not | **Accepted.** Four missing operations added (sev-1 resolution, context fetch, out-of-window reprint with §3.2.4's exact message, sequence replenishment, plus manager approval on an unfamiliar device) and the closed-list claim replaced with "known at Phase 0, and the list is open". |
| M13 | Major | `is_stale` and the local-replay fallback are absent, and the replay has no budget | **Accepted.** §8.7 adds `is_stale` handling, the local replay, and the "stock figure recalculating" state; §8.10 carries the replay as its own 60 ms line item inside the 80 ms add-line budget, computed in TypeScript over `bigint` from `CAST(qty_delta AS TEXT)`, device-measured. |
| M14 | Major | The budget omits the WASM binary, measures the wrong memory, and is calibrated to one tenant | **Accepted, all three.** WASM binary (1.2 MB gzipped) and instantiate cost (700 ms) are budgeted line items and the cold start is raised to 3.5 s to accommodate them; **WASM linear memory** (96 MB, growth < 4 MB/h) and a combined 200 MB renderer footprint are budgeted with an explicit page-cache cap; the reference dataset becomes a **platform envelope** (5,000 products, 400 sales/day/location, window-parameterised) with tenant #1 as one point inside it, plus a device-class ceiling that refuses hydration rather than degrading. |
| M15 | Major | The search normaliser hard-codes construction tokenisation into platform logic | **Accepted.** `search_profile` is template/jurisdiction-pack data applied at onboarding alongside `aliases`; the platform ships a conservative default and the construction template ships the timber-and-rebar profile. Added to §8.9's table. |
| M16 | Major | `companion-bridge`'s most likely failure mode unstated | **Accepted.** Mixed content and Private Network Access stated in §8.8 as risk 5, added to the spike matrix as its own cell, and added to the list of findings that reopen `ADR-0003` — because a shim that must serve a PNA preflight or a local certificate is no longer "tiny and unchanging". |
| M17 | Major | Local-only draft tables have no upgrade story; held carts undefined | **Accepted.** Held carts exist and are specified (§8.7). §8.11 gains an explicit local-only migration policy table: the cursor and the drafts get forward migrations, everything reconstructable is droppable, and a CI check fails a schema change that adds a non-reconstructable local table without a migration. |
| M18 | Major | Reprints format against today's pack, not the snapshotted scale | **Accepted.** The `Money` type carries currency and scale so a formatter handed a bare `Minor` does not compile; `ReceiptDocument` renders from the sale's own snapshotted rows. **Storage question answered: it is not stored twice** — the structured document is derived, and only the rendered byte-stream is cached per-sale in `local_print_queue` for 7 days, so §3.2.4's arithmetic is untouched. |
| M19 | Major | Which stock balance the counter reads is unstated; TRANSIT stock is sellable | **Accepted.** §8.7 states it: sellable on-hand at the trading location, **excluding that location's own TRANSIT node** (§4.7.3, §5.6.3); transit is a separate "on the road" view, never in the cart. |
| M20 | Major | Untrusted-field and timestamp discipline not mirrored from §3 | **Accepted.** §8.1d extends the never-sent rule to `location_id`, `device_id` and `actor_user_id`, enforced by a payload type with no field for them. `client_ts`/`client_seq` deleted in favour of §3.4.2's four names (`hlc`, `device_wall_at`, `server_received_at`, `business_date`). |
| M21 | Major | The server's recompute verdict has no client surface | **Accepted.** §8.5: a `receipt_recompute_mismatch` review scoped to a sale syncs to the originating device, the sale's badge becomes `Needs checking` with wording naming the mismatch, the receipt is re-openable, and severity 1 triggers §3.6.2's out-of-band channel. |
| m1 | Minor | Table-name drift | **Accepted.** §3/§4 names adopted (`conflict_review`, `write_log`, `cash_session`, `sale_line_tax`, `sale_tender`, `stock_movement`, `sequence_block`, `server_received_at`). Client-only tables now carry a `local_` prefix so the distinction is visible in every query, and the local outbox is named `local_outbox` with a note that §3.3.3 calls it `outbox_meta` and that its id *is* `write_log.id` — one key, per §4.2.2, not a second registry. `client_perf_daily` → `device_perf_daily` and `client_directive` → `device_directive`, both raised in §8.12 as needing a §4 row with `tenant_id`, `write_id` and retention. The `stock_balance_current`/`stock_balance` divergence is flagged for §3.11.9 rather than silently picked. |
| m2 | Minor | §8.12 stale on Q-C and Q-F | **Accepted.** Both closed with pointers; Q-C's answer (tenant-configurable window with a pack floor) is what forced §8.10's budget to be restated as a function of the window. |
| m3 | Minor | The CI banned-token grep is asserted, not designed | **Accepted.** §8.9 demotes it to a second belt and makes branded types plus a `TenantLabel` display type that cannot be compared for equality the load-bearing control — which is the only thing that catches `priceList.label === 'Wholesale'`. |
| m4 | Minor | `turnover_speed` as a platform column | **Accepted.** Replaced by a generic template-supplied ranking hint; added to §8.9's table. |
| m5 | Minor | 4× CPU throttling does not model eMMC write latency | **Accepted.** Stated as a named blind spot; the commit budgets are device-gated rather than CI-gated and re-measured every release train. |
| m6 | Minor | `print()` never throws but can hang | **Accepted.** The interface takes a `timeoutMs` (default 12 s) and settles with `{outcome:'timeout'}`; "zero hangs" is a spike pass criterion. |
| m7 | Minor | The kill switch has no governance | **Accepted in part, promoted in part.** Sensitive permission, mandatory reason, audited, on the security report — stated. Whether two-person approval is required is **Q-J**. |
| m8 | Minor | FTS rebuild on every catalogue change | **Accepted.** External-content FTS5 with triggers; incremental maintenance. |
| m9 | Minor | `local_sku_rank` "recomputed nightly" assumes an awake device | **Accepted.** Idle-callback recompute with a staleness bound, plus always after hydration. |

**Nothing was rejected.** Two findings were partially reframed rather than taken as written — m7,
where the governance question splits into a stated rule and an open question, and M18, where the
review asked whether `ReceiptDocument` is stored and the answer is that it should not be — and
neither is a disagreement with the finding.

Four new open questions are promoted to `docs/open-questions.md`: **Q-G** (recovery path for
out-of-range queued writes, `sync-architect`), **Q-H** (the platform performance envelope,
`product-manager` + founder), **Q-I** (the enrolment consequence of offline manager approval,
`product-manager` + founder) and **Q-J** (kill-switch governance, `rbac-security-engineer` +
`product-manager`).
