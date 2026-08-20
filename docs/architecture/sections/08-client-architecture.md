# 8. Client Architecture

**Owner:** `frontend-engineer` · delegating counter flows, printing and touch ergonomics to
`pos-ux-specialist` · **Affects:** all phases

This section describes the client the product actually ships: one installable PWA, built once,
running on low-end Android at every location of every tenant. It states what the client requires
of the sync layer rather than redefining it — the sync section is authoritative on the protocol.

The single sentence that governs everything below: **the network is not in the path of a sale.**
Every design choice here is downstream of that, including the ones that look like UI polish.

---

## 8.1 What runs on the device

| Layer | Choice | Why |
|---|---|---|
| Shell | Installable PWA (WebAPK), React + TypeScript, Vite | One artefact reaches 25 outlets same-day (`ADR-0003`) |
| Local store | SQLite compiled to WASM, persisted to OPFS, driven from a dedicated worker | Real SQL, real indexes, real FTS — off the main thread |
| Sync | PowerSync web SDK (`CLAUDE.md` §2.2) | Proven bidirectional sync; we do not hand-roll one |
| Router / state | File-routed React, no global store | Server state lives in SQLite; there is nothing left for Redux to hold |
| Build | Workbox service worker, build-hashed precache | Deliberate, testable update flow (§8.11) |

Three device-level preconditions are checked at first launch and are **hard gates, not warnings**:

1. **OPFS with synchronous access handles** must be available (Chrome 108+ on Android; confirm
   per device in the Phase 1 hardware spike). Without it the SQLite VFS falls back to an
   IndexedDB shim that is several times slower on eMMC and misses the performance budget in §8.10.
2. **`navigator.storage.persist()` must have been granted.** This is not hygiene. If the browser
   evicts origin storage while the device holds unsynced sales, those sales are gone and no
   server-side recovery exists. Chrome grants persistence to installed PWAs; a browser tab may
   not get it. **Therefore: a device that is not installed and not persisted may browse, but must
   not be allowed to take a sale.** The app refuses the counter role and says why.
3. **A supported client build** — see the schema lockstep rules in §8.11.

A device failing any of these gets a full-screen, plainly-worded block naming the specific
failure and the fix. It never degrades into a half-working till.

### The device holds tenant data, and that has client-side rules

Under `ADR-0005` the isolation boundary is the sync rule, but the consequence lands here: a
tablet in a district town holds a full local copy of one tenant's catalogue, prices, customers
and credit positions. Two client rules follow, and they are not optional:

- **The local database is keyed to `(tenant_id, user_id)`.** If the tenant claim in a freshly
  issued token differs from the `tenant_id` already in the local database, the client **wipes and
  re-hydrates from scratch**. It never syncs incrementally into a database that belonged to a
  different tenant. Re-provisioning a device to another tenant is a wipe, always.
- **A wipe is blocked while unsynced writes exist**, and that block escalates loudly rather than
  offering an "anyway" button. The corollary: **logging out never clears local data.** It locks
  the screen. Otherwise the first thing a frustrated staff member does with a stuck till is
  log out, and the day's sales go with it.

The client never sends `tenant_id` in an upload payload. It exists in the local row because the
local schema mirrors the server schema; the server stamps it from the verified token and treats a
mismatch as an incident, not a validation error (`ADR-0005` rule 2).

---

## 8.2 Reads and writes, from inside a component

**Reads are live queries against local SQLite.** A component declares the rows it needs; the sync
layer re-runs the query when any underlying table changes. There is no fetch, no cache layer, no
`isLoading` for data. The only genuine loading state in the product is first hydration when a
device is provisioned, and that is a dedicated screen, not a spinner inside the counter.

```tsx
// src/data/queries/cart.ts — the ONLY layer where SQL and raw rows exist.
export function useCartLines(draftId: DraftSaleId) {
  return useQuery(
    `SELECT id, sku_id, selling_unit_id, seq,
            CAST(qty_scaled       AS TEXT) AS qty_scaled,
            CAST(unit_price_minor AS TEXT) AS unit_price_minor,
            CAST(line_total_minor AS TEXT) AS line_total_minor
       FROM draft_sale_line
      WHERE draft_sale_id = ?
      ORDER BY seq`,
    [draftId],
    mapCartLine,           // TEXT -> bigint, exactly once, here
  );
}
```

```tsx
// src/features/counter/CartLines.tsx — no SQL, no money maths, no formatting decisions.
const lines = useCartLines(draftId);
return <List rows={lines} render={l => <CartLineRow line={l} />} />;
```

**Writes are local transactions that resolve before the network is consulted.**

```ts
export async function completeSale(input: CompleteSaleInput): Promise<SaleId> {
  const saleId = input.draftId as unknown as SaleId; // see below: the id is the idempotency key
  await db.writeTransaction(async tx => {
    await tx.execute(
      `INSERT INTO sale (id, location_id, price_list_id, customer_id,
                         total_minor, tax_total_minor, client_ts, client_seq)
       VALUES (?, ?, ?, ?, CAST(? AS INTEGER), CAST(? AS INTEGER), ?, ?)`,
      [saleId, input.locationId, input.priceListId, input.customerId,
       input.totalMinor.toString(), input.taxTotalMinor.toString(),
       input.clientTs, input.clientSeq]);
    await insertLines(tx, saleId, input.lines);
    await insertTaxLines(tx, saleId, input.taxLines);   // rates resolved at sale time (ADR-0002)
    await tx.execute(`DELETE FROM draft_sale WHERE id = ?`, [input.draftId]);
  });
  return saleId;  // single-digit milliseconds. Nothing above this line awaits a socket.
}
```

Two consequences worth stating explicitly:

- **The draft cart lives in SQLite too**, in **local-only** tables (`draft_sale`,
  `draft_sale_line`) that never sync. A battery pull or a Chrome OOM-kill mid-sale must not lose
  the cart; an abandoned cart must never become a phantom sale at HQ. Local-only tables give both.
  Completion is the one transaction that promotes a draft into the synced `sale` tables.
- **The sale id *is* the idempotency key**, generated as a UUIDv7 at cart creation, before the
  first line is added. Not at the moment "Complete" is tapped. Every retry, every double-tap,
  every crash-and-resume writes the same key, and `CLAUDE.md` §2.2 makes the server side of that
  a primary-key conflict rather than a second sale.

**The only online-only operations in the product**, each of which shows an honest "needs a
connection" state rather than a spinner: first credential exchange at login, sync-token refresh,
tenant provisioning and template application, per-tenant export, statutory report generation, and
reprinting a receipt for a sale recorded on a different device. Nothing on that list is on the
counter's critical path.

---

## 8.3 Money and quantity at the client boundary

`ADR-0004` says `bigint` in TypeScript. The client has a specific way to lose that, and it is not
hypothetical: **SQLite `INTEGER` columns come back through the WASM driver as JavaScript
`number`** — float64 — before any of our code sees them. A lint rule banning `number` on money
types does not fire, because the driver produced the value.

The rule, therefore:

- **Every money and every scaled-quantity column is selected as `CAST(col AS TEXT)`** and parsed
  with `BigInt()` in the mapper. Every write binds a decimal string and `CAST(? AS INTEGER)`.
- **All SQL lives under `src/data/`.** A lint rule rejects `useQuery`, `db.execute` and raw row
  shapes anywhere else, so there is exactly one place where the cast discipline can fail and
  exactly one place to test it.
- **No arithmetic in SQL on money.** `SUM(line_total_minor)` returns a `number`. Totals are
  computed in TypeScript over `bigint`, or read from a column the server computed. If a query
  genuinely needs an aggregate, it is `CAST(SUM(x) AS TEXT)`.

Formatting happens once, at the presentation boundary, against the tenant's jurisdiction pack —
never against a constant:

```ts
type Currency = { code: string; symbol: string; exponent: number }; // GHS / GH₵ / 2 — today

function toDecimalString(minor: bigint, exponent: number): string {
  const scale = 10n ** BigInt(exponent);
  const neg = minor < 0n, abs = neg ? -minor : minor;
  const frac = exponent === 0 ? '' : '.' + (abs % scale).toString().padStart(exponent, '0');
  return `${neg ? '-' : ''}${abs / scale}${frac}`;         // exact; no float anywhere
}
```

The decimal *string* is then handed to `Intl.NumberFormat` for grouping and symbol placement
(feature-detect the string overload on target Chrome; fall back to manual grouping). Banned
outright, and enforced by lint: `Number(minor) / 100`, `toFixed`, any literal `100`, any literal
`GH₵`, `parseFloat` on a row value.

**Quantities get the same treatment.** Per Open Question Q7, 59 of tenant #1's SKUs sell in
fractional or dual units. The client's obligations are: (a) `qty_scaled` is a `bigint` read as
text, with the scale coming from the unit definition, never assumed; (b) the counter never does
unit maths — a staff member sells *three 12m lengths*, and the conversion to tons is the data
model's job; (c) the selling unit and the conversion factor in force are **snapshotted onto the
sale line**, so a later correction to a rebar conversion factor cannot silently rewrite last
month's receipts; (d) trailing-zero trimming (`2.500 t` → `2.5 t`) is a display rule that never
feeds back into arithmetic.

---

## 8.4 Offline is a state, not an error

Offline is the expected condition for hours at a time. It gets a calm, permanent, unmistakable
presentation, and it never produces a modal, a red banner, a toast, or the word "error".

There are **four** states the persistent status bar can show, not two:

| State | Shown as | What a person is meant to do |
|---|---|---|
| Online, caught up | `Online · all saved` | Nothing |
| Offline | `Offline · 14 sales waiting` | Nothing. Keep selling. |
| Online, catching up | `Sending · 9 of 14` | Nothing |
| **Stuck** | `Not sending · 14 sales waiting since 09:12 — tell your manager` | Escalate |

The fourth is the one that matters and the one that is usually missing. The upload queue is
ordered: a single write the server rejects — an expired token, a schema mismatch, a rejected
payload — **blocks everything behind it**. The device keeps showing "pending" and keeps looking
healthy while the day's takings pile up behind a poison message. So the client watches the age of
the oldest queued write while connectivity is present, and past a threshold (default 15 minutes)
it stops calling this "pending" and starts calling it stuck, in those words, with the timestamp.

Presentation rules, all of which come from the counter being a bright, dusty, hurried place:

- Status is **text plus icon plus count**. Colour is never the only channel.
- Status is **persistent chrome**, never a toast. A toast is a message you can miss, and every
  message about whether money was recorded is a message you must not miss.
- **No spinner ever appears on the sale path.** If something on that path could wait on the
  network, it has been designed wrong.
- **Never claim a verification that could not happen.** An offline credit check does not show a
  confident balance. It shows the balance, its `as_of` timestamp from the last sync checkpoint,
  the locally-pending sales already deducted from headroom, and the plain words "not verified
  now". `credit-engineer` owns the arithmetic; the client owns the honesty of it.

---

## 8.5 Per-record sync state, and why it is the anti-duplicate design

The failure the brief forbids — double-counted sales — is almost never caused by the sync layer.
It is caused by a person who does not know whether the last sale went through, and rings it
again. Every rule in this subsection exists to remove that doubt.

**Per-record state is derived from data, not from a flag the client maintains.** Client-side
bookkeeping drifts; a row that came back from the server cannot lie.

| State | Derivation | Badge |
|---|---|---|
| `pending` | Row exists locally, `server_ack_at IS NULL` | `Waiting to send` |
| `synced` | Server stamped `server_ack_at` / `server_seq`; the row arrived back down the sync stream | `Saved` |
| `attention` | A `review_task` row references it, or its upload was rejected | `Needs checking` |

Rules built on top:

- **Completing a sale lands on the receipt screen**, showing the sale number and its badge — not
  back on an empty cart. An empty cart after a slow tap is the single most reliable way to
  manufacture a duplicate.
- **"Recent sales" is one tap from the counter, always**, showing the last 20 with their badges
  and their totals. The answer to "did that go through?" must always be available without asking
  the network and without asking a manager.
- **A pending sale is not editable and not re-creatable.** It can be voided (which creates a
  linked reversal that also syncs), it can be reprinted, it cannot be quietly retyped.
- Badges appear on **stock adjustments, transfers and credit payments** too, not only sales. A
  transfer that a manager believes was recorded and was not is the same class of error.
- The badge vocabulary is three words a busy person can read at a glance in daylight. It is not
  "queued/committed/reconciled".

---

## 8.6 Conflicts arrive as work

`CLAUDE.md` §2.2 sends unresolvable conflicts to a human review queue. The client's contribution
is that the queue is a **place**, not an interruption.

- A conflict materialises as a `review_task` row that syncs **only to devices whose tenant, role
  and location scope permit acting on it** — the sync rules already carry that boundary, so the
  client does not filter and cannot leak. A cashier never sees a credit-limit dispute.
- It appears as a numbered item in a persistent Tasks area with an unread count in the primary
  navigation. It survives reload, app update and device restart. It is never a toast.
- Opening one shows **both versions side by side** with who, where, when and what was happening
  around each — for the canonical hard case (two locations editing one customer's credit limit
  while both offline), that means both limits, both authors, both locations, both timestamps, and
  the customer's current exposure. Then two explicit, differently-worded buttons. No "resolve"
  button that hides which version it is picking.
- **Anything still under review shows a caveat where the data is used.** If a customer's credit
  limit is disputed, the counter sees that on the customer, at the moment of a credit sale — not
  only in a queue somebody opens on Friday.

---

## 8.7 The counter flow

### Two price lists, never ambiguous

Price lists are tenant configuration rows (`price_list.id`, `.label`, `.tax_inclusive`), not an
enum. Tenant #1 ships two — a retail list and a wholesale/contractor list — but the client knows
only "the tenant's price lists" and "the default for a walk-in".

- The active list is **a persistent chip in the cart header**, in words from configuration.
- The list follows the **customer selection**: choosing a credit customer switches to their
  assigned list and says so, out loud, as a line in the cart. There is no hidden toggle whose
  state you have to remember.
- **Changing the list re-prices the whole cart and shows the before/after total.** Silent
  re-pricing is how the wrong price gets charged.
- Outlet staff cannot override a price at all (`CLAUDE.md` §2.6). So price is rendered as static
  text — not a disabled input, which invites tapping — with a single **"Ask manager"** action
  that creates an approval request. Critically, **that approval must work with no network**: the
  manager is usually standing at the counter. The design is a local re-authentication on the same
  device, which requires an offline-verifiable credential. See Q-D in §8.12 — this is a security
  trade `rbac-security-engineer` must decide, not something the client can settle alone.

### Search that tolerates how people actually type

A contractor asks for "half-inch rod", not "Reinforcement Bar 12mm". Search is local, so we can
afford to be generous.

```sql
-- Local-only. Rebuilt on hydration and whenever the synced catalogue changes.
CREATE VIRTUAL TABLE sku_search USING fts5(
  sku_id UNINDEXED,
  code, name, category, sub_category, size_spec,
  aliases,                                   -- tenant-editable, the local names
  tokenize = "unicode61 remove_diacritics 2",
  prefix   = '2 3 4'
);
```

- **Normalise identically at index time and query time**: lowercase; strip `"` and `'`; `2"x3"`,
  `2 x 3` and `2 by 3` all collapse to the same token; `12mm` indexes as `12mm`, `12` and `mm`,
  so a bare `12` finds the 12mm rebar and `2x3` finds the timber.
- **`aliases` is tenant data, and it is a first-class product feature**, not a hack. Managers add
  the words their customers actually use — "rod", "iron rod", "half-inch rod", "zinc", "chalk".
  Seeded from the template, edited forever after. This is the highest-leverage thing in the
  counter flow and it costs one text column.
- **Rank by what this location actually sells.** A local materialised `sku_rank_local(sku_id,
  sold_count_90d)` recomputed from local sale lines nightly, blended with `bm25()`. Seeded at
  template application from `turnover_speed` (72 of tenant #1's 219 SKUs are Fast) until there is
  real history. Cement outsells everything at every outlet, so cement should win a two-letter
  query at every outlet — but because the outlet sells it, not because a constant says so.
- **A zero-result search falls back** to a trigram-similarity pass before it says "nothing found",
  and "nothing found" is never a dead end: it offers catalogue browse and a special-order path.
- **Queries run in the SQLite worker.** Input is debounced ~120 ms, results are keyed so a slow
  query cannot overwrite a newer one, and the main thread never blocks on a keystroke.
- Camera barcode scanning (`BarcodeDetector`) is an optional accelerator for the SKUs that carry
  barcodes — paint, tools, fixings. It is never a dependency; sand and rebar have no barcode.

### Touch, and the fast path

- **Minimum 56 × 56 dp** for any target on the sale path, 12 dp apart. WCAG's 44 assumes a clean
  screen and an unhurried finger; neither holds here.
- **No hover-dependent affordance, no required drag, no long-press-only action.**
- **Destructive actions get undo, not confirmation.** A confirm dialog on every line removal
  trains people to tap through dialogs, which is precisely how the one dialog that mattered gets
  dismissed. Removing a line removes it, with a 5-second undo bar. Voiding a completed sale — a
  real, ledger-visible event — is the exception and takes a deliberate second step with a reason
  code.
- **A quick grid of this location's top SKUs** occupies the counter's first screen, from the same
  `sku_rank_local` as search. Tap adds one; the quantity chip on the line opens a numeric pad.
- **The stated target for the highest-volume sale in the business**: 20 bags of OPC 42.5N, cash,
  walk-in, receipt printed — **≤ 8 taps and ≤ 10 seconds from an empty cart**, on the reference
  device in §8.10, offline. This is an acceptance test, not an aspiration.
- SKUs with two selling units (rebar by length or by ton, wire by roll or by kg) show a segmented
  unit control on the line. The staff member picks the unit the customer is buying in and never
  performs a conversion.

---

## 8.8 Receipt printing — the highest-risk part of the client

`ADR-0003` already calls this the PWA's weakest point. Stating the risk more precisely, because
the precision is what makes it testable:

1. **Web Bluetooth speaks BLE GATT only. It cannot open a Bluetooth Classic RFCOMM/SPP serial
   socket — at all, on any platform.** Most sub-$60 58 mm thermal printers sold into West African
   markets are SPP-only. If the printers the tenant can actually buy are SPP, no amount of client
   engineering reaches them from a PWA. **This, not flakiness, is the most likely way printing
   fails**, and it is a procurement question as much as an engineering one.
2. **Persistent device permission is the second gate.** If `navigator.bluetooth.getDevices()` is
   unavailable on the target Chrome build, every single receipt requires the user to pick the
   printer from a chooser dialog, triggered by a user gesture. That is not a POS. Whether the
   permission backend is enabled on the target builds must be *measured*, not assumed.
3. **WebUSB is not a primary path on this hardware.** It works in Chrome for Android, but needs
   USB OTG, and a cheap tablet that is charging usually has no port free. Useful at a flagship
   counter with a powered desk; not a fleet answer.
4. **Even when BLE works, there is no back-channel.** Writes go out in MTU-sized chunks with no
   acknowledgement; the app cannot tell that the paper ran out. "Printed" means "bytes were
   accepted", and the UI must say the weaker thing it actually knows.

### How the client is built so the answer can change

Printing is an interface with swappable transports and a mandatory fallback. Nothing in the sale
path knows which transport is in use.

```ts
interface ReceiptTransport {
  readonly id: 'ble-escpos' | 'webusb-escpos' | 'companion-bridge' | 'system-print' | 'none';
  probe(): Promise<TransportHealth>;
  print(doc: ReceiptDocument): Promise<PrintAttempt>;   // never throws into the sale path
}
```

| Transport | Viability | Role |
|---|---|---|
| `ble-escpos` | BLE GATT printers only; needs persistent permission | Intended primary |
| `webusb-escpos` | Needs OTG and a free port | Flagship desk counters |
| `companion-bridge` | Tiny native APK exposing loopback HTTP; PWA posts to `127.0.0.1` | Fallback if BLE fails — but see §8.13 |
| `system-print` | Android print framework via `window.print()` | A4 invoices only; too slow for a queue |
| `none` | Full-screen receipt with a large sale number | **Mandatory.** Every tenant, every device. |

Three rules that hold regardless of which transport wins:

- **The sale is committed to local SQLite before any print is attempted.** A print failure is a
  retry against a completed sale. It is never a rollback and never blocks the next customer.
- **The receipt is stored as a structured `ReceiptDocument`** — lines, quantities in their sold
  units, tax lines with the `tax_rate_id` rows that were in force, the jurisdiction pack's
  required fields, tenant branding — and each transport renders that document. A reprint renders
  the stored document. It never recomputes against today's rates (`ADR-0002`).
- **Failed prints queue per sale** and are retryable from the sale, so a printer that comes back
  after a power cut can catch up without anyone re-ringing anything.

### The Phase 1 printing spike — scheduled, gated, and *early*

`ADR-0003` requires this proven during Phase 1. Concretely, it runs in **the first three weeks of
Phase 1, before the tenant buys printers**, because the finding can change the purchase order
more cheaply than it can change the client.

**Matrix:** two representative tablets (~2 GB RAM, Android 11–13, current Chrome) × at least
three printer models actually purchasable in Ghana, including at least one known BLE GATT model
and one commodity SPP model, plus one Android-POS terminal with an integrated printer.

**Protocol:** 200 consecutive receipts per device/printer pair; printer power-cycled mid-run;
tablet screen locked and the PWA backgrounded mid-run (Android drops GATT connections — measure
it); a Chrome update applied and the run repeated.

**Pass criteria:**

- ≥ 99.5 % of print attempts succeed on the first try **with no device-chooser dialog**;
- median receipt (12 lines, 58 mm) printed in < 3 s, p95 < 5 s;
- automatic reconnection < 5 s after a printer power cycle, with no human step;
- zero cases where a print outcome altered, delayed or duplicated a sale record.

**What would reopen the native-Android question (`ADR-0003`)** — any one of these, raised the day
it is observed, not at pilot:

- the printers procurable in the market are SPP-only, so Web Bluetooth cannot address them;
- persistent device permission is unavailable, forcing a chooser dialog per receipt;
- first-try success below 99 %, or reconnection after a power cycle requiring a human;
- backgrounding or screen-lock reliably kills the connection with no recovery inside the PWA.

The honest reading of the fallback column: **`companion-bridge` is already a partial concession.**
It means shipping a native APK to 25 outlets, which is the cost `ADR-0003` chose the PWA to
avoid. It is worth it only if the shim stays tiny and effectively never changes, so the fleet
update story survives for the 99 % of the product that is not printing. If the shim starts
growing, the argument for the PWA has already lost and we should say so rather than accumulate a
second codebase by degrees.

---

## 8.9 Tenant-driven presentation

The client is tenant-aware and never tenant-authoritative. It renders what configuration says.

| Surface | Source | Never |
|---|---|---|
| Location type chip | `location_type.label` / `.label_plural` | `"Flagship"`, `"RDC"`, `"Micro-Outlet"` |
| Role names | `role.name` | A role enum in TypeScript |
| Customer segments | `customer_segment.label` | `"contractor"` |
| Currency symbol, scale, grouping | Jurisdiction pack (`ADR-0007`) | `GH₵`, `/100`, `toFixed(2)` |
| Tax code labels, receipt fields | Jurisdiction pack | `"VAT"`, `"NHIL"` |
| CoA account labels | Tenant's chart of accounts | Any hard-coded account name |
| Price list names | `price_list.label` | `"Retail"` / `"Wholesale"` |
| Receipt branding | Tenant config | Per-tenant CSS or a per-tenant build |

Two distinctions that keep this honest:

- **Product chrome vs. tenant terminology.** "Search", "Cart", "Complete sale" are product copy
  and live in the string catalogue. "Contractor", "Flagship", "facility fee" are *one tenant's
  words for their own things* and live in that tenant's data. When those are confused, the
  product ends up with an `if (tenant)` in a component, which `CLAUDE.md` §2.9 forbids.
- **Enforcement is a CI check, not a review habit.** A build-time grep fails the build on a
  banned-token list — `Flagship`, `RDC`, `Micro-Outlet`, `contractor`, `GH₵`, `pesewa`, `Ghana`,
  `VAT`, `NHIL`, `GETFund`, and the literal `100` in any money context — anywhere outside
  `packages/jurisdiction-*` and the template seed files. Tenant #1's vocabulary is the thing most
  likely to leak into a component, because it is what everyone on the project says out loud.

There is one artefact for all tenants. Configuration is data that arrives through the sync stream
like everything else, so a tenant renaming "contractor" to "trade account" takes effect at every
counter on the next sync, with no deploy.

---

## 8.10 Performance budget

**Reference device**, named so the budget means something: a ~2 GB RAM Android tablet, mid-range
SoC four or more years old, eMMC storage, current Chrome, with the tenant #1 dataset loaded (219
SKUs, 90 days of one location's transactions). CI approximates it with 4× CPU throttling; the
real numbers are taken on the physical device during the Phase 1 hardware spike, alongside the
printers.

| Interaction | Budget (p95) |
|---|---|
| Cold start (installed, warm OPFS) → counter interactive | 2.5 s |
| Keystroke → search results painted | 120 ms |
| Add line to cart → repaint | 80 ms |
| Complete sale → receipt screen (local commit) | 300 ms |
| Interaction to Next Paint on the sale path | 100 ms |
| Longest task on the sale path | 200 ms |
| Counter route JS, gzipped (initial) | 250 KB |
| All routes, gzipped | 600 KB |
| **JS heap after an 8-hour shift** | **120 MB, growth < 10 MB/hour** |

The last row is the one that is usually omitted and matters most here. These devices are not
reloaded daily; a till stays open for days. **A leak budget is a harder constraint than a
start-up budget on this fleet**, and the sale path is the code that runs ten thousand times
between reloads.

How the budget is held:

- **Virtualise every list over ~30 rows** with fixed-height rows, so nothing measures the DOM.
  219 SKUs is already too many; transaction history is unbounded.
- **Paginate in SQL, not in the renderer.** Keyset pagination (`WHERE (created_at, id) < (?, ?)
  ORDER BY created_at DESC LIMIT 50`), never `SELECT *` then slice.
- **Narrow live queries.** Each component subscribes to the smallest query that answers its
  question, so recording a sale invalidates the sales list and the stock balance for the affected
  SKUs, and nothing else re-renders. One broad `useEverything()` hook would defeat local SQLite
  entirely.
- **Client-owned local indexes** are part of this section's deliverable, not the server's:
  `sale(location_id, created_at DESC)`, `sale_line(sale_id)`, `stock_balance(location_id,
  sku_id)`, `review_task(assignee_role_id, state)`, plus the FTS5 table in §8.7.
- **Lazy-load everything that is not the counter.** Reporting, admin, ledger review and the
  template/onboarding flows are separate chunks. A cashier's device should never parse the GL
  review screen's JavaScript.
- **Measure on the fleet, not on a laptop.** A ring buffer records p50/p95 for the named
  interactions and syncs one aggregate row per device per day (`client_perf_daily`). The budget
  is monitored across 25 outlets rather than asserted once. CI fails the build on a regression.

If a screen feels slow, the network is not available as an excuse. Reads are local; slowness is
this section's defect.

---

## 8.11 Service-worker updates and schema lockstep

### Updating 25 outlets without stranding one

- Workbox service worker, build-hashed precache, **`skipWaiting` disabled**. A new version never
  activates under a cashier mid-sale.
- **Activation is atomic.** The new build becomes eligible only once every precache entry —
  including the SQLite WASM binary — is stored. A device that loses connectivity mid-download
  stays on the working build rather than half-updating into an unbootable shell.
- The client polls a small `release.json` (`no-store`) carrying
  `{ build_id, min_client_schema, max_client_schema, cohort }`. `devops-engineer` owns cohort
  mechanics; the client honours them, so a release reaches the pilot location, then a region,
  then the fleet.
- **The user-facing update prompt is a status-bar affordance, never a modal**, and it applies at a
  safe point: cart empty, no sale in flight, no print queued. Otherwise it waits, or applies at
  the tenant's configured quiet hour, or on next launch.
- The sync endpoint and `release.json` are never cached. Old caches are purged on activate.

### Schema lockstep — and why the client refuses to write

Two versions are in play: the `sync_schema_version` the server serves, and the
`client_schema_version` a build expects. The server sends its version and its supported range in
the sync handshake, and the client checks at boot **and on every reconnect**.

**If the client is outside the supported range, in either direction, it enters read-only
quarantine.** It shows an unmissable, full-width, plainly-worded block — *"This till is out of
date and cannot take sales. Update now."* — and:

- it **still displays** already-recorded data, so the outlet is not blind;
- it **still drains its upload queue**, so pending sales are never stranded by the quarantine;
- it **accepts no new writes of any kind**.

That second point only works if the server upholds one rule, which belongs in the sync section
but is stated here because the client depends on it: **the server must keep accepting writes from
any client version it has ever served, for a compensation window of at least 90 days, and
breaking write-contract changes must be additive (expand/contract).** Without that, quarantine
converts a stale build into lost sales, which is worse than the disease.

Ordering follows: the backend deploys first and is backward-compatible; the client rolls out
after. A client ahead of its server is a rollout race, and it quarantines too, in the same way.

**Why refusing to write beats writing something subtly wrong.** A refusing till costs one outlet
an hour and a phone call, and everyone knows immediately which outlet and which hour. A client
writing against a drifted contract — a dropped column silently discarded, a renamed field
defaulting to zero, a tax line landing under a code the server no longer recognises — produces
data that looks fine at the counter, syncs cleanly, and surfaces weeks later as a trial balance
that will not balance, across 25 locations, with no way to identify which rows are wrong. In a
system that is its tenant's book of record with no accounting SaaS behind it to catch the drift
(`ADR-0004`), that trade is not close.

### Kill switch, and its limit

A `client_directive` row scoped by tenant and location syncs down and can force a minimum version
or set a device read-only, so HQ can stop a bad build from taking sales without an app-store
round trip or a site visit. **It only reaches a device that syncs**, which is exactly the device
least likely to be the problem.

The tempting fix — restrict a device that has not synced in N days — is dangerous here, because
trading offline for days *is the product*. The line taken: **staleness never blocks a cash sale.**
It escalates the status-bar wording, and it blocks only operations whose safety genuinely depends
on fresh data — credit sales beyond locally-verifiable headroom, outbound stock transfers, and
any price, role or configuration administration. The threshold is tenant configuration with a
conservative default, and choosing it is a business decision, not an engineering one (Q-E below).

---

## 8.12 What this section needs from other sections

| # | Need | Owner |
|---|---|---|
| Q-A | **A supported-printer list, decided before tenant #1 buys hardware.** BLE GATT ESC/POS, or an Android-POS terminal. This is procurement, and it is the cheapest available mitigation of the largest client risk. | `product-manager` + founder |
| Q-B | Lost/stolen/resold device policy for a tablet holding a full local tenant dataset. See §8.13. | `rbac-security-engineer` + `devops-engineer` |
| Q-C | **A bounded sync window for transactional history on counter devices** (proposed: 90 days of sales at a location; HQ reporting reads from the server, not from a device). The §8.10 memory and disk budgets assume this. An unbounded local history breaks the reference device within a couple of years. | `sync-architect` |
| Q-D | An offline-verifiable credential for in-person manager approval (price override, over-limit credit) with no network. | `rbac-security-engineer` |
| Q-E | The staleness threshold at which a device is restricted, and which operations it restricts. | `product-manager` + founder |
| Q-F | Q7 (fractional and dual units) resolved in the data model. The counter cannot ship a unit selector against an undecided conversion model. | `software-engineer` + founder |

---

## 8.13 Concerns

**1. The printing spike is scheduled correctly but sequenced too late by default.** `ADR-0003`
says "during Phase 1", which is right, but the finding is only cheap while it can still change
the purchase order. It should be the *first* work in Phase 1 and it should gate printer
procurement. This is a request for sequencing, not a disagreement with the decision.

**2. Local database encryption is a real gap in the PWA path, and I think it is a larger
long-term risk than printing.** `ADR-0005` gets tenant isolation right at the server and at the
sync rule, but the client-side consequence is a tablet in a district town holding one tenant's
catalogue, margins, customer list and credit exposure in OPFS, unencrypted. There is no supported
encryption story for WASM SQLite over OPFS in a PWA — and any key the PWA could hold lives in the
same origin storage as the data, so it would be theatre rather than protection. RLS does nothing
for data already on a device, and an offline device cannot be remotely wiped. The mitigations
available to us are real but partial, and they are not ours alone: an app-level lock screen with
a short idle timeout, local-database destruction after N failed unlocks or after the sync token
has been unrenewable for N days, and — the substantive one — Android Enterprise managed devices
with enforced screen lock and full-disk encryption, which is a `devops-engineer` and procurement
decision. **This does not change my view that the PWA is the right call**; the update story
across 25 outlets is worth more than the delta. But it should be recorded as a known,
accepted risk with a named owner rather than discovered during a security review, and if a
tenant ever arrives with a regulatory requirement here, this — not printing — is the constraint
that will force the native question again.

**3. The offline manager approval in §8.7 is a genuine tension I have designed toward rather than
resolved.** Requiring the network would break the counter; verifying locally means a credential
verifier lives on the device. I have specified the UX and deferred the mechanism to Q-D
deliberately, because picking a scheme here would be the client quietly making a security
decision that is not its to make.

**4. The bounded sync window (Q-C) is a soft dependency I am treating as hard.** The §8.10
budgets do not survive an unbounded local transaction history on 2 GB hardware. If the sync
section concludes that counter devices must hold full history, the performance budget in this
section needs renegotiating, and the honest version of that conversation is better had in Phase 0
than in Phase 1 year two.
