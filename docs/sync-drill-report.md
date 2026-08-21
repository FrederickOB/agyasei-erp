# Sync drill report — Phase 1 acceptance demonstrations

**Generated:** 2026-08-21T16:44:50.218Z by `pnpm --filter @erp/sync-drills drill`
**Nothing mocked:** real Postgres 16 (docker, :5433), real self-hosted PowerSync service (:8080), real API (:3001); each device is an `@powersync/node` client with its own sqlite file and its own tokens.

**Overall: PASS** — 6/6 drills passed.

| Drill | Result |
|---|---|
| D1 — Offline sale syncs to server + second device < 60s | PASS |
| D2 — Two offline devices, same SKU — exact convergence | PASS |
| D3 — HQ sees post-sync stock and sales across locations | PASS |
| D4 — Verbatim replay of acked batches — all duplicate, zero new effects | PASS |
| D5 — Tenant isolation at the sync layer — raw device files | PASS |
| D6 — Receipt-number regression — wipe a device's local DB mid-block, reissue | PASS |

## D1 — Offline sale syncs to server + second device < 60s: PASS

**Measured:**
- iteration 1: server 209ms, visible on A2 203ms, total 209ms
- iteration 2: server 209ms, visible on A2 201ms, total 209ms
- iteration 3: server 210ms, visible on A2 201ms, total 210ms
- iteration 4: server 210ms, visible on A2 204ms, total 210ms
- iteration 5: server 209ms, visible on A2 203ms, total 209ms
- p95 over 5 iterations: 210ms

**Assertions:**

| Check | Result | Detail |
|---|---|---|
| iter 1: partition is real (sale absent from server while offline) | PASS | server has no such sale pre-reconnect |
| iter 1: offline sale synced < 60s | PASS | 209ms (limit 60000ms) |
| iter 2: partition is real (sale absent from server while offline) | PASS | server has no such sale pre-reconnect |
| iter 2: offline sale synced < 60s | PASS | 209ms (limit 60000ms) |
| iter 3: partition is real (sale absent from server while offline) | PASS | server has no such sale pre-reconnect |
| iter 3: offline sale synced < 60s | PASS | 210ms (limit 60000ms) |
| iter 4: partition is real (sale absent from server while offline) | PASS | server has no such sale pre-reconnect |
| iter 4: offline sale synced < 60s | PASS | 210ms (limit 60000ms) |
| iter 5: partition is real (sale absent from server while offline) | PASS | server has no such sale pre-reconnect |
| iter 5: offline sale synced < 60s | PASS | 209ms (limit 60000ms) |
| p95 < 60s | PASS | 210ms |
| A1 sees all its own D1 sales after reconnect | PASS | 5 sales |

## D2 — Two offline devices, same SKU — exact convergence: PASS

**Measured:**
- baseline on-hand (server, OUT-01, SKU-001): 490
- all 4 movements on server: 5ms after reconnect
- device-a1 converged: 201ms after server had all movements
- device-a2 converged: 1ms after server had all movements

**Assertions:**

| Check | Result | Detail |
|---|---|---|
| no movement reached server while partitioned | PASS | actual=0 expected=0 |
| server on-hand = baseline 490 + Σdeltas 105 (exact) | PASS | actual=595 expected=595 |
| device A1 local on-hand equals server | PASS | actual=595 expected=595 |
| device A2 local on-hand equals server | PASS | actual=595 expected=595 |
| A1 and A2 movement ledgers identical (row for row) | PASS | A1=10 rows, A2=10 rows, byte-identical |
| converged ledgers are non-empty | PASS | 10 rows |
| write_log rows per op key (no loss, no dup) | PASS | actual=[1,1,1,1] expected=[1,1,1,1] |
| exactly one stock_movement row per op | PASS | actual=4 expected=4 |

## D3 — HQ sees post-sync stock and sales across locations: PASS

**Measured:**
- A3 outbox flush (2 ops): 48ms
- HQ cross-location query: 4ms over 57 locations
- tenant A sales total across locations: 42000 minor units
- on-hand SKU-001: OUT-01=595, OUT-03=26

**Assertions:**

| Check | Result | Detail |
|---|---|---|
| A3 (OUT-03) upload acks applied | PASS | actual=["applied","applied"] expected=["applied","applied"] |
| OUT-01 present with sales | PASS | sales_count=5 |
| OUT-03 present with sales | PASS | sales_count=1 |
| sales visible across ≥ 2 locations in one view | PASS | 2 locations |
| HQ OUT-01 on-hand equals independent ledger sum | PASS | actual=595 expected=595 |
| HQ OUT-03 on-hand equals independent ledger sum | PASS | actual=26 expected=26 |
| Σ(per-location sales) = tenant-wide total (exact bigint) | PASS | actual=42000 expected=42000 |

## D4 — Verbatim replay of acked batches — all duplicate, zero new effects: PASS

**Measured:**
- state before replay: sales=6 movements=12 credit_entries=0 customers=1 write_log=21 on-hand(OUT-01)=595
- replayed 7 batches / 9 ops in 66ms

**Assertions:**

| Check | Result | Detail |
|---|---|---|
| A1 has acked batches to replay | PASS | 7 batches |
| every replayed op acked 'duplicate' (9/9) | PASS | all duplicate |
| zero new effects: state identical after replay | PASS | actual={"sales":6,"movements":12,"creditEntries":0,"customers":1,"writeLog":21,"onHand":"595"} expected={"sales":6,"movements":12,"creditEntries":0,"customers":1,"writeLog":21,"onHand":"595"} |

## D5 — Tenant isolation at the sync layer — raw device files: PASS

**Measured:**
- B1 (tenant B device): 20 physical tables, 576 synced rows on disk
- A1 (tenant A device): 20 physical tables, 664 synced rows on disk

**Assertions:**

| Check | Result | Detail |
|---|---|---|
| non-vacuous: tenant A/OUT-01 predicts rows in product/sale/sale_line/stock_movement/customer | PASS | product=219 sale=5 sale_line=6 stock_movement=10 customer=1 |
| non-vacuous: tenant B/MAIN predicts rows in product/sale/sale_line/stock_movement/customer | PASS | product=219 sale=1 sale_line=1 stock_movement=2 customer=1 |
| B1 (tenant B device): raw row count equals tenant-scoped prediction for all 17 synced tables | PASS | all match (576 rows on disk) |
| B1 (tenant B device): ZERO rows with tenant A's tenant_id in any of 20 physical tables | PASS | 0 foreign rows (564 own-tenant rows present) |
| B1 (tenant B device): tenant A's uuid appears NOWHERE in the file's stored rows | PASS | zero occurrences |
| A1 (tenant A device): raw row count equals tenant-scoped prediction for all 17 synced tables | PASS | all match (664 rows on disk) |
| A1 (tenant A device): ZERO rows with tenant B's tenant_id in any of 20 physical tables | PASS | 0 foreign rows (652 own-tenant rows present) |
| A1 (tenant A device): tenant B's uuid appears NOWHERE in the file's stored rows | PASS | zero occurrences |

## D6 — Receipt-number regression — wipe a device's local DB mid-block, reissue: PASS

**Measured:**
- block 1..2000 (size 2000), format '{location_code}-{prefix}-{n:06d}' prefix 'RCT' at OUT-01
- printed before the wipe: OUT-01-RCT-000001, OUT-01-RCT-000002, OUT-01-RCT-000003

**Assertions:**

| Check | Result | Detail |
|---|---|---|
| the server allocates the block — the device never self-issues | PASS | status=ok block=1..2000 review=null |
| three sales applied on the issued numbers | PASS | applied, applied, applied |
| the server records the reported cursor and opens nothing | PASS | consumed_upto=3 expected=3 review=null |
| after the wipe the device holds no block — it cannot know it ever did | PASS | local sequence_block row destroyed with the sqlite file |
| the regression is DETECTED on reconnect | PASS | status=regression kind=LOST_CURSOR in 19ms |
| the review is SEVERITY 1 and names the overlap range | PASS | severity=1 overlap=1..3 expected=1..3 |
| the remainder of the block is BURNED | PASS | reason=REGRESSION_BURN burned=4..2000 |
| a FRESH block issues, strictly above everything the burned one covered | PASS | fresh=2001..4000 burned block ended at 2000 |
| exactly two blocks on the server: one burned, one live | PASS | actual=["1:REGRESSION_BURN","2001:live"] expected=["1:REGRESSION_BURN","2001:live"] |
| the review is on the server, open, severity 1, scoped to the outlet | PASS | severity=1 status=open class=SEQUENCE_CONSUMED_UPTO_REGRESSION overlap=1..3 scoped_locations=1 |
| a colliding sale is APPLIED, not dead-lettered and not retried forever | PASS | status=applied reason=none |
| and specifically NOT the raw unique violation that used to jam the queue | PASS | reason=none |
| both sales are recorded, on DISTINCT stored numbers | PASS | OUT-01-RCT-000001 \| OUT-01-RCT-000001-01A53B1 (printed OUT-01-RCT-000001) |
| the number the customer actually holds is preserved, not overwritten | PASS | receipt_no_claimed=null,OUT-01-RCT-000001 |
| and a severity-1 review names the collision — no two customers hold the same number UNDETECTED | PASS | open RECEIPT_NUMBER_COLLISION reviews: 1 |
| tenant B sees none of tenant A's blocks or reviews (§2.7 category 3) | PASS | rows visible to tenant B: 0 |

## Environment

- Postgres: `postgresql://erp:***@localhost:5433/erp` — PostgreSQL 16.15 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit
- PowerSync service: `http://localhost:8080` — image journeyapps/powersync-service:1.24.0
- API: `http://127.0.0.1:3011` (apps/api dev server, HS256 dev tokens)
- Device SDK: @powersync/node 0.21.0 — one sqlite file per device under packages/sync-drills/.drill-data/
- Node v25.2.1 on darwin arm64
- Sync rules: infra/powersync/sync_rules.yaml (tenant id from token `tid` ONLY); uploads via POST /sync/upload → app.write_log pipeline (download-only sync service)
