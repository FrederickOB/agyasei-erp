# Credit offline visibility and suspension — rulings

**Owner:** `sync-architect`. **Status:** decided; implementers build exactly this.
**Authority:** `CLAUDE.md` §2.1/§2.2/§2.6/§2.7 · `03-offline-sync` §3.2, §3.3.4, §3.6 · `06-customer-credit`
§6.1, §6.5, §6.7, §6.8 · `02-security-and-access-control` §2.5.
**Scope:** the two gaps in `phase1-status` §5 criterion 3(c) and §6 — `credit_entry` is in no bucket, and
`credit.setStatus` does not exist. No code here.

Names used below are the ones the **database** actually holds, because permissions resolve per request
from `platform.permission`. §03/§06 write `credit.read` and `credit.sell`; the catalogue holds
**`credit.view`** and **`sale.record.credit`**. Implementers use the catalogue names and add no new
codes except where a ruling says so.

---

## R1. What may reach a device

**Ruling: two audiences, two different slices, and neither is "the credit book".**

### R1.a The counter — `location_credit_allowance`, keyed `(tenant_id, location_id)`

Build the bucket §3.2.2 and §6.5 already specify, from a new **server-derived** table `credit_allowance`.
Nothing else on the credit surface reaches an outlet device.

- **Gate (parameter query):** the user holds **`sale.record.credit`** at that location in
  `app.effective_permission`, intersected with `app.user_location_scope`. Table-driven, not the `locs`
  token claim — this bucket lands *after* §6 item 4's swap, never before it. No grant → no rows → no bucket.
- **Which customers:** one row per `(location, customer)` where the customer is a credit customer of this
  tenant **and** either (i) a live `credit_account_location_cap` lease exists for that `(account, location)`,
  or (ii) the customer has a credit sale at *that location* inside the allowance-residency window
  (tenant config, default **90 days**, same knob family as §3.2.4). Nothing else. A customer who has never
  traded at this outlet is not on this outlet's tablet.
- **Which columns:** `cap_minor`, `headroom_minor`, `offline_ceiling_minor`, `credit_hold`,
  `cap_valid_until`, `cap_version_id`, `snapshot_as_of`, `snapshot_as_of_hlc`. Explicit list, never `SELECT *`.
  **No limit, no balance, no ageing, no entry, no fee, no payment history.**
- **Residency:** rows leave by ordinary per-row membership when the window lapses or the lease is revoked —
  never by changing the bucket key. §3.2.4's scheduled-outage lesson applies unchanged.

*Cost, accepted:* a customer's **first** credit sale at a new outlet is refused while offline. It is
recorded as a `credit_refusal` with reason `cap` and its outcome (`part_paid` / `cash` / `proforma`), which
§6.7.2 already publishes as a standing report, so the cost is measured rather than argued about.

**A stolen counter tablet holds:** what this one outlet may lend, today, to the customers who trade here —
and a hold flag. It does not disclose any customer's limit, balance, ageing, purchase history, or the
existence of customers who trade elsewhere.

### R1.b Accounts / HQ — `tenant_credit`, keyed `(tenant_id)`

- **Gate:** holds **`credit.view`** in `app.effective_permission` for this tenant. The key is
  `tenant_id` and not `(tenant_id, location_id)` because **`customer_account` has no `location_id`**
  (§6.5) — a location-keyed credit book would be a fiction, and `credit_entry` carries no location column
  to key it by. This is the one place §3.2.1 rule 3 is answered by *bounding* rather than by narrowing.
- **Which accounts:** accounts in status `ACTIVE` or `SUSPENDED`, plus `CLOSED` accounts whose last entry
  falls inside the entry window. A long-closed account is not on anyone's tablet.
- **Which entries:** `credit_entry` **windowed per row by `archived_at`**, exactly as §3.2.4 does it —
  nightly job on `server_received_at`, `archived_at IS NULL` in the data query, bucket key untouched.
  Default HQ/accounts window **400 days**, tenant config with a jurisdiction-pack floor.
- **Plus one new server-derived row per account, `credit_position_snapshot`:** balance, the ageing bucket
  vector rendered against the policy in force, fee-accrued-to-date (labelled provisional while
  `fee_confirmed_at` is null), `opening_before_window_minor`, `as_of` and `as_of_hlc`. This row is what
  makes the window safe — see R2.
- `credit_limit_version` syncs in the same bucket (it is the limit's authority, and `credit.view` holders
  are the audience for a fork marker).

**A stolen accounts tablet holds:** this tenant's live credit book for the last 400 days. That is a real
exposure and it is the reason `credit.view` must never be in the counter-staff or outlet-manager template
role, and the reason R5 tests revocation, not just isolation.

**Not synced anywhere, at any permission:** `credit_policy`, fee accrual detail/shadow rows, allocation
rows, and the heavy `conflict_review_context` blob (§3.6.2 fetches it online).

---

## R2. Derived vs synced

**Ruling: synced and authoritative. No device computes a credit balance or an ageing bucket, ever.**

The decisive argument is not taste, it is arithmetic: **the entry log on the device is windowed, so
Σ(local entries) ≠ balance by construction.** A device that sums its window produces a confidently wrong
number that gets *more* wrong the longer the account has existed. That is the one failure mode
`CLAUDE.md` §2.2 and §0a both name — a wrong figure shown confidently at a counter.

So:

| Figure | Authority | May the device compute it? |
|---|---|---|
| Balance | `credit_position_snapshot.balance_minor` | **No.** Displayed as synced, with its `as_of`. |
| Ageing buckets | `credit_position_snapshot` vector | **No.** Bucket edges come from `credit_policy`, which is not on the device. |
| Facility fee to date | `credit_position_snapshot`, provisional label | **No.** |
| What this till may lend | `credit_allowance.headroom_minor` | **Only** §6.5's causal subtraction (below). |
| Statement lines | synced `credit_entry` rows | Display only — listed, never totalled. |

**The single exception, already specified in §6.5 and not to be re-derived:** the till computes
`sellable_now = max(0, min(headroom_minor − local_deduction, cap_minor))`, where `local_deduction` sums this
location's own credit sales that are either not yet uploaded or whose **server-stamped** `ack_hlc`
(§3.3.4) is greater than `allowance.snapshot_as_of_hlc`. Two server-generated HLCs are compared; a device
clock is never compared to a server one; the term can only *reduce* what the till will lend. It is not a
balance and must never be rendered as one.

**When they disagree, the synced authority wins and the difference is shown, not folded in.** An accounts
device holding entries newer than `as_of_hlc` renders *"balance 1,300,000 as at 14:07 — 2 movements
recorded since, not yet included"*, with those movements listed. It does not add them. This is the
D6/D9 precedent applied one layer up: the till's claimed `clientTotalMinor: "1"` lost to the server's
618,000, and a device-recomputed balance is the same kind of claim.

**Enforce it structurally, not by review.** There must be no function in `apps/web` that reduces credit
entry amounts to a total, and the money-lint pass must fail if one appears — the same tripwire shape as
`outbox-surface.test.ts`. A second implementation of a money function that nothing forbids will be written.

---

## R3. Staleness

**Ruling: three states, never four; provenance travels with every figure; and staleness is bounded by
expiry, not by warning text.**

1. **Three states only**, extending §0a's `useApiQuery` discipline rather than replacing it:
   `verified_online` (this interaction round-tripped to the server), `synced_as_of` (from a snapshot, with
   its age stated in the same sentence as the number), `unavailable` (no snapshot at all). **There is no
   "last known" state**, and a `synced_as_of` figure must never be rendered in the place or styling a
   `verified_online` figure uses.
2. **The word "balance" unqualified is reserved for `verified_online`.** A synced figure reads *"balance as
   at 06:40 today"* or *"as at Tuesday"*. The counter never sees a network `available` figure at all,
   because it does not have one (§6.8).
3. **No green tick, no "limit check passed", no unqualified approval on a stale allowance** — §6.8 verbatim.
4. **`credit_limit_check = 'verified_online'` may be stamped on a sale only when the authorisation actually
   round-tripped in that checkout** and the response carried the server-stamped HLC. It is never inferred
   from "the device believes it is online". Anything else is `unverified_offline`, `sub_limit_only` or
   `manager_override`. These are persisted columns on the sale, not UI state — a banner that existed only on
   a screen is not evidence three weeks later.
5. **The bound is `cap_valid_until`.** When the lease expires (`cap_lease_days`, default 7) the device stops
   lending on credit and writes a `cap_lease_expired` refusal. A tablet dark for a fortnight cannot keep
   lending on a fortnight-old number no matter how carefully the screen is worded.
6. **Never:** imply a check that did not happen; render ageing computed on-device; show an empty statement
   as "no activity" when the window or the sync is the reason; or let a `synced_as_of` figure survive a
   failed refresh (§0a's mutation-tested rule — the previous answer is discarded before every re-run).

---

## R4. Suspension semantics

**Ruling: `credit.setStatus` is the account *lifecycle* transition and nothing else. Holds are a separate,
faster, reversible switch. Two things, two names, one authority each — because three flags meaning
"stopped" is how a suspended customer keeps transacting (§6.1, `M-14`).**

**Statuses:** `ACTIVE`, `SUSPENDED`, `CLOSED`. The live check constraint carries `ON_HOLD`; a new migration
retires it — existing `ON_HOLD` rows migrate to `SUSPENDED` **and** set the new `customer.credit_hold`, so
no account silently becomes sellable. Never edit migration `0004`.

**Legal transitions** (anything else is refused, with the attempted pair named):

| From → To | Permitted | Precondition |
|---|---|---|
| ACTIVE → SUSPENDED | yes | reason code required |
| SUSPENDED → ACTIVE | yes | reason code required |
| ACTIVE/SUSPENDED → CLOSED | yes | exposure **= 0** (settled or written off); otherwise SUSPEND instead |
| CLOSED → ACTIVE | yes | reason code; audited as a reopen (one account per customer is a constraint) |
| X → X | no-op, not an error | idempotent by write key |

**Who:** the capability **`credit.account.manage`**, at **tenant** scope — an account has no location, so a
location-scoped grant cannot cover it. No role name appears anywhere. One change: that permission's
`requires_fresh_authorization` must be flipped to **true**. §02 §2.5 defines that flag for exactly this —
a lifecycle decision taken offline against a stale view of the account.

**What SUSPENDED means:** no new `CHARGE` entries; `sales.createSale` refuses credit tender (it already
refuses non-`ACTIVE`) and **cash sales are unaffected** — suspending credit must not stop the customer
buying. `PAYMENT`, `ADJUSTMENT`, `WRITE_OFF` and fee accrual continue; accrual is governed by
`fee_accrual_stop_days`, not by status.

**Holds stay separate:** `customer.credit_hold` is the single authority, projected into
`credit_allowance.credit_hold`, resolved hold-wins with a severity-2 review (§3.6 class #8). It is the fast
switch; `setStatus` is the deliberate one.

### The offline case — what actually happens to a device that is dark when an account is suspended

It keeps selling on credit until it syncs. Nothing can prevent that. Four rulings, none of which invent a
mechanism that needs the link to be up:

1. **The exposure is bounded by machinery that already exists, and by nothing new.** Worst case is
   Σ over dark locations holding a live lease of `min(remaining cap_minor, offline_ceiling_minor × sales)`.
   That is `Σ(live caps)` from §6.7.1 — a risk number the tenant chose, not a limit the system enforces.
2. **Suspension shortens the runway rather than chasing the device.** `setStatus(SUSPENDED)` and
   `credit_hold = true` both **revoke every live `credit_account_location_cap` lease** for that account
   server-side and forbid issuing a new one. Connected locations lose the allowance row on the next sync;
   dark locations run out at `cap_valid_until` and start refusing with `cap_lease_expired`. Suspension
   cannot reach a dark tablet — it can guarantee the dark tablet runs out. A tenant wanting a tighter bound
   tightens `cap_lease_days`, and pays for it in `cap_lease_expired` refusals it can already see.
3. **No bespoke priority-sync channel.** Build none. It works only when the link is up, which is the case
   that does not need it, and it would be a second authoritative path into the device's credit state —
   the defect `sync_rules.yaml` note (d) already refuses for sequence blocks. Instead, reuse the channel
   that exists: **the upload response** (§3.3.4) returns current `status`, `credit_hold` and
   `cap_valid_until` for every account named in the batch. A device with any connectivity at all learns the
   hold on its next upload, before its next credit sale — narrower than a bucket and already on the path.
4. **Credit sales that arrive after a suspension are accepted, never discarded** (§6.7 rule 1 — the goods
   are gone). Each raises a **new conflict class #20, `credit_sale_after_suspension`, `AUTO+FLAG`,
   severity 2**, routed to the Accounts queue, carrying the sale, location, `credit_limit_check`,
   `snapshot_as_of_hlc` and the suspension's HLC — so the reviewer can tell "the device was blind" from
   "someone sold against a hold they could see". Detection is idempotent on a `detection_key` over the
   sorted contributing entry ids, in §6.7's exact shape, so a sync retry raises one item and not two.

---

## R5. The isolation test plan — what must be proven at the sync layer before this ships

Proven **against the device's own local SQLite**, not against the API. The bucket is the boundary; the API
is a different control and passing it proves nothing about this one. Two tenants, seeded from **different
templates**, both with credit customers carrying **distinguishable non-zero** balances, ageing across more
than one bucket, live allowances at two locations each, and one open limit fork.

**The non-vacuity rule, applied to every check below:** an assertion that a device holds **0** rows is only
admissible when the *same query shape* on the *same device in the same run* returns **N > 0** rows with an
**asserted exact value** for the tenant/location/permission that should have them. A count of zero on a
query that returns zero everywhere proves nothing, and that is how this project has been fooled sixteen
times (§0).

1. **Cross-tenant, per bucket.** A tenant-A device holds A's `credit_allowance`,
   `credit_position_snapshot`, `credit_entry`, `credit_account`, `credit_limit_version` rows — asserted by
   exact bigint value — and **zero** rows of each carrying tenant B's `tenant_id`. Repeated with the roles
   swapped, so neither direction passes by seeding accident.
2. **The file, not the table.** Grep the raw local SQLite file for tenant B's customer name and for the
   decimal string of B's balance: zero hits, while the identical grep for tenant A's marker hits. A row
   deleted from a table can still sit in a page; the positive control is what makes the negative mean
   something.
3. **The permission gate, not the seed.** A tenant-A user **without** `credit.view` holds zero
   `credit_entry` and zero `credit_position_snapshot` rows while holding a non-zero `credit_allowance` set;
   grant `credit.view` and re-sync **in the same run**, and the rows appear. This proves the parameter
   query excludes them, not the fixture.
4. **Same-tenant location narrowing** — the cut no tenant-isolation test covers. An OUT-01 device holds
   allowance rows for OUT-01 and **zero** for OUT-03, while an OUT-03 device in the same run holds OUT-03's.
   Plus: a customer trading only at OUT-03 has **no row at all** on the OUT-01 device.
5. **Revocation empties the device.** Expire the role assignment; on next sync the credit rows are gone,
   from a device where the count was previously asserted > 0.
6. **The forged claim.** A token whose `tid` is tenant B but whose `uid` belongs to tenant A yields zero
   rows in every credit bucket — the parameter queries join `effective_permission`/`user_location_scope`,
   so it fails closed. Paired with a CI grep gating `sync_rules.yaml` against `request.parameters()`
   anywhere in a credit bucket (§3.9's two-person review is not a substitute for a machine check).
7. **Windowing is not a leak path.** Archiving an entry removes it from the device on the next sync and it
   does not resurrect; `credit_position_snapshot.opening_before_window_minor` moves by exactly the archived
   amount, so the balance is unchanged — asserted as a bigint identity.
8. **Suspension propagation, offline.** Suspend an account while a device is genuinely partitioned (the
   fetch rejects, as in D10 group 5): the device keeps selling to `cap_valid_until`, then refuses with
   `cap_lease_expired`; on reconnect every sale lands, exactly one `credit_sale_after_suspension` review
   exists after **two** drain passes, and the allowance row is gone.
9. **Mutation-test the suite before believing it.** Delete `AND tenant_id = bucket.tenant_id` from **one**
   credit data query, and separately drop the `credit.view` join from the `tenant_credit` parameter query.
   Each must turn checks 1 and 3 red. A green isolation suite that survives a removed tenant predicate is
   the finding, and it is the only result of this plan that would block the ship.
