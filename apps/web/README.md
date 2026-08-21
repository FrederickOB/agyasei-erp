# @erp/web — installable PWA shell and POS skeleton

The client the product ships (§8 of the architecture document): one installable
PWA, React 18 + TypeScript + Vite, local SQLite through the PowerSync web SDK,
targeting low-end Android. **The network is not in the path of a sale.**

## Running

```sh
pnpm dev          # local-only mode: no backend needed, dev data seeded
pnpm build        # production build (vite build)
pnpm test         # vitest
pnpm typecheck
```

- **Local-only mode** (default): with the sync env unset, the database opens
  with the full local schema and never connects. The app is completely usable
  offline with a seeded placeholder catalogue and a placeholder CurrencySpec
  (`XTS` / generic currency sign) — no real jurisdiction's symbol or scale is
  baked in anywhere.
- **Sync mode**: set all three of `VITE_API_URL`, `VITE_POWERSYNC_URL` and
  `VITE_API_TOKEN` (see `env.example`; fixed dev contract: API on
  `http://localhost:3001`, PowerSync on `http://localhost:8080`). The
  connector (`src/data/powersync.ts` + `src/data/sync/`) then:
  - exchanges the API bearer at `GET /sync/token` for a short-lived PowerSync
    client token (aud `powersync`, `tid` from the verified session), cached
    until near expiry;
  - streams downloads from the PowerSync service under
    `infra/powersync/sync_rules.yaml` — the service is **download-only**;
  - drains the local outbox in order to `POST /sync/upload` (the one write
    path into `app.write_log`), marking a row complete ONLY on a per-key
    server ack (`applied`/`duplicate`); a definitive rejection becomes the
    visible `Needs checking` state, never a silent drop.

## What is here

| Area | Where | Notes |
|---|---|---|
| **Wire contract** | `@erp/contracts` | The ONE client↔server declaration. `buildSalePayload` returns a value **typed as** `CreateSaleInput` and parses its own JSON with `createSaleInput` before the outbox insert, so a divergence is a compile error, then a counter-visible refusal — never a BAD_REQUEST at a till in Techiman. The upload envelope and the 500-op batch cap come from the same package. |
| Local schema (one definition) | `src/data/schema.ts` | Synced-shape `product`/`price`/`stock_snapshot` + the synced bucket mirrors; local-only `cart`, `cart_line`, `outbox`, `sequence_block`, `local_config`. Same definition builds the PowerSync schema and the test DDL. |
| Receipt numbers, offline | `src/lib/receipt-number.ts`, `src/data/sequence.ts` | Per-location blocks drawn down inside the checkout transaction, zero connectivity (03 §3.7.5). A server-allocated block prints bare; a self-issued one carries a device tag, because that is the only thing that makes it un-collidable between two tills that cannot see each other. Format is tenant configuration; the platform fallback carries no tenant's words. |
| Money discipline | `src/data/queries/*`, `src/money/*` | Every money/qty column read as `CAST(col AS TEXT)` → `BigInt()`; display only via `@erp/money` `format()` with the CurrencySpec from `local_config`. A grep test bans literal symbols and tenant vocabulary. |
| Four offline states | `src/state/sync-status.ts` | Explicit machine: online-synced / offline / syncing / **stuck**; calm permanent status bar, never a toast, never the word "error". |
| Per-record badges | `src/lib/badges.ts`, sales list & receipt | `Waiting to send` / `Saved` / `Needs checking`, derived from data (`server_ack_at`, `rejected_at`). |
| Atomic checkout | `src/data/mutations/checkout.ts` | One transaction: receipt-number draw + outbox insert + cart clear. Fault-injection test proves rollback of all three — a failed sale burns no number. Q8 seam documented in the payload builder — sale capture only, no e-invoice issuance/clearance fields. |
| Server is the pricing authority | `src/data/mutations/checkout.ts` | The wire carries product + quantity; the server reprices from the price list and tax table in force on `businessDate`. The till still computes its own total locally for display and the offline receipt, and puts it on the wire in exactly one place — `clientTotalMinor`, the contract's stale-price-list detector, which the server compares and never obeys. Cash tendered/change stay in local outbox columns. |
| Version-gated SW updates | `src/sw/version-gate.ts`, `src/sw/register.ts` | `skipWaiting` off; the client asks `release.json` (stubbed in `public/`) which build to run before activating a waiting worker; applies only at a safe point. |

## Device provisioning

A sale needs to know where it is being rung. These live in `local_config` and
are read by `src/data/queries/session.ts`; the dev seed writes them, and in
production they are provisioned at enrolment from the verified session — never
guessed, because a sale filed against the wrong outlet moves stock and cash at
a counter that never saw it.

| Key | What |
|---|---|
| `location_id` | The location this device trades at. Its `code` and `timezone` come from the synced `location` row; the trading day is derived in that timezone. |
| `location_code` | Fallback code, used only until the synced row arrives. |
| `price_list_id` | The list the counter sells from. The cart pins it; the sale sends the resolved **code**, which is how the API names a price list. |
| `receipt_number_format` | `{template, width, prefix}` — jurisdiction pack + tenant override (03 §3.7.5). Absent it, a neutral platform fallback. |

Missing any of these is a **refusal to record**, surfaced on the counter with
the cart intact, not a default.

## Integration notes

- `@erp/contracts` and `@erp/money` are declared `workspace:*` **and** aliased to their source
  (`vite.config.ts` `resolve.alias`, `tsconfig.json` `paths`) so build, tests
  and typecheck don't depend on those packages' `dist/` being built first.
- `tests/live-upload.smoke.ts` is **not** collected by vitest. With the stack
  up and an API dev server on the current source, it ships a payload built by
  the client's own `buildSalePayload`, through the client's own transport, to
  the real `POST /sync/upload` — demonstrated, not asserted.
- The live-query layer is a small change-bus (`src/data/db.ts`); swapping it
  for PowerSync incremental watch queries is contained inside `src/data/`.
- Tests run the real SQL against real SQLite via `node:sqlite` (Node ≥ 22.5),
  over DDL generated from the same schema definition the device uses.
