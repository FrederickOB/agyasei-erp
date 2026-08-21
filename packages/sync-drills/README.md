# @erp/sync-drills — Phase 1 acceptance drills against the real stack

Executable demonstrations (CLAUDE.md §3: *demonstrated, not asserted*) of the
Phase 1 sync acceptance criteria. **Nothing is mocked**: real docker Postgres 16
(`localhost:5433`), the real self-hosted PowerSync service (`localhost:8080`,
download-only — sync rules are the tenant boundary), the real API
(`localhost:3001`, spawned automatically if not already running). Each
"device" is an `@powersync/node` client with its **own sqlite file** under
`.drill-data/` and its **own tokens** (API JWT → `GET /sync/token` →
short-lived PowerSync token; `tid` only ever from the verified token).

```sh
pnpm stack:up                          # once: postgres + powersync (infra/README.md)
pnpm --filter @erp/sync-drills drill   # runs D1–D7, writes docs/sync-drill-report.md
```

Exit code is non-zero if **any** hard assertion fails. Every run is
self-contained: fresh device files, fresh UUIDv7 idempotency keys, baselines
measured before deltas — safe to re-run against an accumulated dev database.

| Drill | Demonstrates | Hard assertion |
|---|---|---|
| D1 | Airplane-mode sale syncs after reconnect (criterion 1) | server + second device see it **< 60s**; 5 iterations, p95 reported |
| D2 | Two devices, same SKU, both offline (criterion 2) | server on-hand = exact Σ; identical device ledgers; one `write_log` row per op |
| D3 | HQ cross-location view (criterion 4) | HQ figures = independent per-location sums, exact bigint |
| D4 | Idempotent retry | byte-verbatim replay of every acked batch → all `duplicate`, zero new effects |
| D5 | Tenant isolation at the sync layer (criterion 5) | RAW sqlite inspection: zero other-tenant rows/uuid mentions **and** per-table counts equal tenant-scoped server predictions |
| D6 | **The PWA's own payload, end to end** | `apps/web`'s real `checkout()` → real outbox → real transport, browser `Origin`, real socket: ack `applied`; sale + line + tax lines + movement in Postgres; total an exact bigint identity and the **server's**, not the till's; replay `duplicate` with no second effect |
| D7 | Receipt-number regression — wipe a device's local DB mid-block, reissue (03 §3.9, conflict class #14) | the sqlite file is genuinely DELETED; on reconnect the regression is detected, the block is burned, a fresh block issues, a **severity-1** review names the overlap range, and a colliding sale still lands `applied` (the till does not go dark) |

> **What D1–D5 do NOT cover, stated plainly.** Their payloads are built by
> `src/context.ts` — the drills' own idea of the API's shape — and their transport
> is `@powersync/node`, which has no browser origin. Two production bugs walked
> straight through a green 5/5: CORS (no drill ever made a cross-origin request)
> and the sale payload shape (the PWA's real payload had never been handed to the
> API's real schema, so every sale it uploaded was `BAD_REQUEST`). D6 exists to
> close that hole, and `packages/wire-conformance` closes it again hermetically on
> every `pnpm test`. D1–D5's payload helpers are now typed against
> `@erp/contracts`, so they can no longer drift from the contract either — but a
> drill agreeing with the contract still is not evidence that the PWA does.

Writes go **only** through the outbox → `POST /sync/upload` →
`runIdempotent` over `app.write_log` (server-stamped HLC, per-tenant keys).
The PowerSync stream is never an upload path; the drill connector throws if a
crud batch ever appears.

Device fleet per run: A1, A2 (tenant A, OUT-01 Techiman Flagship), A3
(tenant A, OUT-03, upload-only for D3), B1 (tenant B, MAIN), and A6 (tenant A,
OUT-01) — created inside D7 so wiping its database cannot disturb the others.
A6 keeps its identity across the wipe (same `device_id`, same user, same
tokens): a reinstall on the SAME enrolled device is the case that matters. Price seeding is
the one direct-SQL step (no price mutation API exists yet) and mirrors
`apps/api/test/util.ts` `seedWholesalePrice` — a SERVER-origin `write_log` row
first, under the tenant's own RLS context.
