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
| Local schema (one definition) | `src/data/schema.ts` | Synced-shape `product`/`price`/`stock_snapshot`; local-only `cart`, `cart_line`, `outbox`, `local_config`. Same definition builds the PowerSync schema and the test DDL. |
| Money discipline | `src/data/queries/*`, `src/money/*` | Every money/qty column read as `CAST(col AS TEXT)` → `BigInt()`; display only via `@erp/money` `format()` with the CurrencySpec from `local_config`. A grep test bans literal symbols and tenant vocabulary. |
| Four offline states | `src/state/sync-status.ts` | Explicit machine: online-synced / offline / syncing / **stuck**; calm permanent status bar, never a toast, never the word "error". |
| Per-record badges | `src/lib/badges.ts`, sales list & receipt | `Waiting to send` / `Saved` / `Needs checking`, derived from data (`server_ack_at`, `rejected_at`). |
| Atomic checkout | `src/data/mutations/checkout.ts` | One transaction: outbox insert + cart clear. Fault-injection test proves rollback of both sides. Q8 seam documented in the payload builder — sale capture only, no e-invoice issuance/clearance fields. |
| Version-gated SW updates | `src/sw/version-gate.ts`, `src/sw/register.ts` | `skipWaiting` off; the client asks `release.json` (stubbed in `public/`) which build to run before activating a waiting worker; applies only at a safe point. |

## Integration notes

- `@erp/money` is declared `workspace:*` **and** aliased to its source
  (`vite.config.ts` `resolve.alias`, `tsconfig.json` `paths`) so build, tests
  and typecheck don't depend on the package's `dist/` being built first.
- The live-query layer is a small change-bus (`src/data/db.ts`); swapping it
  for PowerSync incremental watch queries is contained inside `src/data/`.
- Tests run the real SQL against real SQLite via `node:sqlite` (Node ≥ 22.5),
  over DDL generated from the same schema definition the device uses.
