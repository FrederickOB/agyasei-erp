# Sync drill report — Phase 1 acceptance demonstrations

**Generated:** 2026-08-21T09:05:23.783Z by `pnpm --filter @erp/sync-drills drill`
**Nothing mocked:** real Postgres 16 (docker, :5433), real self-hosted PowerSync service (:8080), real API (:3001); each device is an `@powersync/node` client with its own sqlite file and its own tokens.

**Overall: PASS** — 5/5 drills passed.

| Drill | Result |
|---|---|
| D1 — Offline sale syncs to server + second device < 60s | PASS |
| D2 — Two offline devices, same SKU — exact convergence | PASS |
| D3 — HQ sees post-sync stock and sales across locations | PASS |
| D4 — Verbatim replay of acked batches — all duplicate, zero new effects | PASS |
| D5 — Tenant isolation at the sync layer — raw device files | PASS |

## D1 — Offline sale syncs to server + second device < 60s: PASS

**Measured:**
- iteration 1: server 208ms, visible on A2 203ms, total 208ms
- iteration 2: server 208ms, visible on A2 202ms, total 208ms
- iteration 3: server 210ms, visible on A2 202ms, total 210ms
- iteration 4: server 209ms, visible on A2 200ms, total 209ms
- iteration 5: server 210ms, visible on A2 202ms, total 210ms
- p95 over 5 iterations: 210ms

**Assertions:**

| Check | Result | Detail |
|---|---|---|
| iter 1: partition is real (sale absent from server while offline) | PASS | server has no such sale pre-reconnect |
| iter 1: offline sale synced < 60s | PASS | 208ms (limit 60000ms) |
| iter 2: partition is real (sale absent from server while offline) | PASS | server has no such sale pre-reconnect |
| iter 2: offline sale synced < 60s | PASS | 208ms (limit 60000ms) |
| iter 3: partition is real (sale absent from server while offline) | PASS | server has no such sale pre-reconnect |
| iter 3: offline sale synced < 60s | PASS | 210ms (limit 60000ms) |
| iter 4: partition is real (sale absent from server while offline) | PASS | server has no such sale pre-reconnect |
| iter 4: offline sale synced < 60s | PASS | 209ms (limit 60000ms) |
| iter 5: partition is real (sale absent from server while offline) | PASS | server has no such sale pre-reconnect |
| iter 5: offline sale synced < 60s | PASS | 210ms (limit 60000ms) |
| p95 < 60s | PASS | 210ms |
| A1 sees all its own D1 sales after reconnect | PASS | 5 sales |

## D2 — Two offline devices, same SKU — exact convergence: PASS

**Measured:**
- baseline on-hand (server, OUT-01, SKU-001): 1085
- all 4 movements on server: 4ms after reconnect
- device-a1 converged: 203ms after server had all movements
- device-a2 converged: 0ms after server had all movements

**Assertions:**

| Check | Result | Detail |
|---|---|---|
| no movement reached server while partitioned | PASS | actual=0 expected=0 |
| server on-hand = baseline 1085 + Σdeltas 105 (exact) | PASS | actual=1190 expected=1190 |
| device A1 local on-hand equals server | PASS | actual=1190 expected=1190 |
| device A2 local on-hand equals server | PASS | actual=1190 expected=1190 |
| A1 and A2 movement ledgers identical (row for row) | PASS | A1=20 rows, A2=20 rows, byte-identical |
| converged ledgers are non-empty | PASS | 20 rows |
| write_log rows per op key (no loss, no dup) | PASS | actual=[1,1,1,1] expected=[1,1,1,1] |
| exactly one stock_movement row per op | PASS | actual=4 expected=4 |

## D3 — HQ sees post-sync stock and sales across locations: PASS

**Measured:**
- A3 outbox flush (2 ops): 40ms
- HQ cross-location query: 4ms over 57 locations
- tenant A sales total across locations: 84000 minor units
- on-hand SKU-001: OUT-01=1190, OUT-03=52

**Assertions:**

| Check | Result | Detail |
|---|---|---|
| A3 (OUT-03) upload acks applied | PASS | actual=["applied","applied"] expected=["applied","applied"] |
| OUT-01 present with sales | PASS | sales_count=10 |
| OUT-03 present with sales | PASS | sales_count=2 |
| sales visible across ≥ 2 locations in one view | PASS | 2 locations |
| HQ OUT-01 on-hand equals independent ledger sum | PASS | actual=1190 expected=1190 |
| HQ OUT-03 on-hand equals independent ledger sum | PASS | actual=52 expected=52 |
| Σ(per-location sales) = tenant-wide total (exact bigint) | PASS | actual=84000 expected=84000 |

## D4 — Verbatim replay of acked batches — all duplicate, zero new effects: PASS

**Measured:**
- state before replay: sales=12 movements=24 credit_entries=0 customers=2 write_log=33 on-hand(OUT-01)=1190
- replayed 7 batches / 9 ops in 61ms

**Assertions:**

| Check | Result | Detail |
|---|---|---|
| A1 has acked batches to replay | PASS | 7 batches |
| every replayed op acked 'duplicate' (9/9) | PASS | all duplicate |
| zero new effects: state identical after replay | PASS | actual={"sales":12,"movements":24,"creditEntries":0,"customers":2,"writeLog":33,"onHand":"1190"} expected={"sales":12,"movements":24,"creditEntries":0,"customers":2,"writeLog":33,"onHand":"1190"} |

## D5 — Tenant isolation at the sync layer — raw device files: PASS

**Measured:**
- B1 (tenant B device): 19 physical tables, 584 synced rows on disk
- A1 (tenant A device): 19 physical tables, 704 synced rows on disk

**Assertions:**

| Check | Result | Detail |
|---|---|---|
| non-vacuous: tenant A/OUT-01 predicts rows in product/sale/sale_line/stock_movement/customer | PASS | product=219 sale=10 sale_line=12 stock_movement=20 customer=2 |
| non-vacuous: tenant B/MAIN predicts rows in product/sale/sale_line/stock_movement/customer | PASS | product=219 sale=2 sale_line=2 stock_movement=4 customer=2 |
| B1 (tenant B device): raw row count equals tenant-scoped prediction for all 17 synced tables | PASS | all match (584 rows on disk) |
| B1 (tenant B device): ZERO rows with tenant A's tenant_id in any of 19 physical tables | PASS | 0 foreign rows (572 own-tenant rows present) |
| B1 (tenant B device): tenant A's uuid appears NOWHERE in the file's stored rows | PASS | zero occurrences |
| A1 (tenant A device): raw row count equals tenant-scoped prediction for all 17 synced tables | PASS | all match (704 rows on disk) |
| A1 (tenant A device): ZERO rows with tenant B's tenant_id in any of 19 physical tables | PASS | 0 foreign rows (692 own-tenant rows present) |
| A1 (tenant A device): tenant B's uuid appears NOWHERE in the file's stored rows | PASS | zero occurrences |

## Environment

- Postgres: `postgresql://erp:***@localhost:5433/erp` — PostgreSQL 16.15 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit
- PowerSync service: `http://localhost:8080` — image journeyapps/powersync-service:1.24.0
- API: `http://127.0.0.1:3001` (apps/api dev server, HS256 dev tokens)
- Device SDK: @powersync/node 0.21.0 — one sqlite file per device under packages/sync-drills/.drill-data/
- Node v25.2.1 on darwin arm64
- Sync rules: infra/powersync/sync_rules.yaml (tenant id from token `tid` ONLY); uploads via POST /sync/upload → app.write_log pipeline (download-only sync service)
