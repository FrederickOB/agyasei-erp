# Sync drill report — Phase 1 acceptance demonstrations

**Generated:** 2026-08-21T17:21:43.883Z by `pnpm --filter @erp/sync-drills drill`
**Nothing mocked:** real Postgres 16 (docker, :5433), real self-hosted PowerSync service (:8080), real API (:3001); each device is an `@powersync/node` client with its own sqlite file and its own tokens.

**Overall: PASS** — 7/7 drills passed.

| Drill | Result |
|---|---|
| D1 — Offline sale syncs to server + second device < 60s | PASS |
| D2 — Two offline devices, same SKU — exact convergence | PASS |
| D3 — HQ sees post-sync stock and sales across locations | PASS |
| D4 — Verbatim replay of acked batches — all duplicate, zero new effects | PASS |
| D5 — Tenant isolation at the sync layer — raw device files | PASS |
| D6 — The PWA's own payload, over a real socket, into Postgres | PASS |
| D7 — Receipt-number regression — wipe a device's local DB mid-block, reissue | PASS |

## D1 — Offline sale syncs to server + second device < 60s: PASS

**Measured:**
- iteration 1: server 210ms, visible on A2 202ms, total 210ms
- iteration 2: server 210ms, visible on A2 202ms, total 210ms
- iteration 3: server 210ms, visible on A2 203ms, total 210ms
- iteration 4: server 208ms, visible on A2 202ms, total 208ms
- iteration 5: server 209ms, visible on A2 202ms, total 209ms
- p95 over 5 iterations: 210ms

**Assertions:**

| Check | Result | Detail |
|---|---|---|
| iter 1: partition is real (sale absent from server while offline) | PASS | server has no such sale pre-reconnect |
| iter 1: offline sale synced < 60s | PASS | 210ms (limit 60000ms) |
| iter 2: partition is real (sale absent from server while offline) | PASS | server has no such sale pre-reconnect |
| iter 2: offline sale synced < 60s | PASS | 210ms (limit 60000ms) |
| iter 3: partition is real (sale absent from server while offline) | PASS | server has no such sale pre-reconnect |
| iter 3: offline sale synced < 60s | PASS | 210ms (limit 60000ms) |
| iter 4: partition is real (sale absent from server while offline) | PASS | server has no such sale pre-reconnect |
| iter 4: offline sale synced < 60s | PASS | 208ms (limit 60000ms) |
| iter 5: partition is real (sale absent from server while offline) | PASS | server has no such sale pre-reconnect |
| iter 5: offline sale synced < 60s | PASS | 209ms (limit 60000ms) |
| p95 < 60s | PASS | 210ms |
| A1 sees all its own D1 sales after reconnect | PASS | 5 sales |

## D2 — Two offline devices, same SKU — exact convergence: PASS

**Measured:**
- baseline on-hand (server, OUT-01, SKU-001): 490
- all 4 movements on server: 4ms after reconnect
- device-a1 converged: 202ms after server had all movements
- device-a2 converged: 0ms after server had all movements

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
- A3 outbox flush (2 ops): 52ms
- HQ cross-location query: 5ms over 57 locations
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
- state before replay: sales=6 movements=12 credit_entries=0 customers=1 write_log=38 on-hand(OUT-01)=595
- replayed 7 batches / 9 ops in 110ms

**Assertions:**

| Check | Result | Detail |
|---|---|---|
| A1 has acked batches to replay | PASS | 7 batches |
| every replayed op acked 'duplicate' (9/9) | PASS | all duplicate |
| zero new effects: state identical after replay | PASS | actual={"sales":6,"movements":12,"creditEntries":0,"customers":1,"writeLog":38,"onHand":"595"} expected={"sales":6,"movements":12,"creditEntries":0,"customers":1,"writeLog":38,"onHand":"595"} |

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

## D6 — The PWA's own payload, over a real socket, into Postgres: PASS

**Measured:**
- tenant 01911111-1111-7111-8111-111111111111 · location OUT-01 · list WHOLESALE · sku SKU-001
- receipt OUT-01-000001-FF245B · till claimed 29700 minor units
- POST http://127.0.0.1:3001/sync/upload from origin http://localhost:5173: 40ms

**Assertions:**

| Check | Result | Detail |
|---|---|---|
| the browser preflight for this exact request is approved | PASS | status=204 allow-origin=http://localhost:5173 allow-methods=GET, POST, OPTIONS allow-headers=authorization, content-type |
| an arbitrary origin is NOT admitted (the bearer is tenant identity) | PASS | allow-origin=null |
| the batch was delivered and answered (CORS, auth, envelope) | PASS | ok=true status=200 |
| the PWA's own sale payload is ACKED APPLIED, not rejected | PASS | ack={"key":"01a02557-b700-7087-a289-3bc6f83d5ad4","status":"applied"} |
| exactly one sale row landed | PASS | rows=1 |
| it is filed against the device location the token scopes | PASS | 09cee1e8-5955-8ee5-ad33-ba79bf0499f0 vs 09cee1e8-5955-8ee5-ad33-ba79bf0499f0 |
| the sale line landed | PASS | sale_line rows=1 |
| tax lines landed (the pack rates in force on the business date) | PASS | sale_tax_line rows=3 |
| the stock movement landed, signed for an outflow | PASS | movements=[{"qty_delta":"-3","source_kind":"SALE"}] |
| the total is an exact bigint identity: subtotal − discount + tax | PASS | 9001 = 7500 − 0 + 1501 |
| tax is non-zero and positive | PASS | tax_total_minor=1501 |
| the SERVER priced it — the till's claim is not what was written | PASS | server=9001 till=29700 |
| the divergence is REPORTED back, not swallowed | PASS | priceCheck={"matches":false,"deltaMinor":"-20699","clientTotalMinor":"29700","serverTotalMinor":"9001"} |
| a byte-identical re-POST is acked duplicate | PASS | ack={"key":"01a02557-b700-7087-a289-3bc6f83d5ad4","status":"duplicate"} |
| the replay produced NO second effect | PASS | sale rows after replay=1 |
| and no second stock movement | PASS | stock_movement rows after replay=1 |

## D7 — Receipt-number regression — wipe a device's local DB mid-block, reissue: PASS

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
| the regression is DETECTED on reconnect | PASS | status=regression kind=LOST_CURSOR in 23ms |
| the review is SEVERITY 1 and names the overlap range | PASS | severity=1 overlap=1..3 expected=1..3 |
| the remainder of the block is BURNED | PASS | reason=REGRESSION_BURN burned=4..2000 |
| a FRESH block issues, strictly above everything the burned one covered | PASS | fresh=2001..4000 burned block ended at 2000 |
| exactly two blocks on the server: one burned, one live | PASS | actual=["1:REGRESSION_BURN","2001:live"] expected=["1:REGRESSION_BURN","2001:live"] |
| the review is on the server, open, severity 1, scoped to the outlet | PASS | severity=1 status=open class=SEQUENCE_CONSUMED_UPTO_REGRESSION overlap=1..3 scoped_locations=1 |
| a colliding sale is APPLIED, not dead-lettered and not retried forever | PASS | status=applied reason=none |
| and specifically NOT the raw unique violation that used to jam the queue | PASS | reason=none |
| both sales are recorded, on DISTINCT stored numbers | PASS | OUT-01-RCT-000001 \| OUT-01-RCT-000001-01AC271 (printed OUT-01-RCT-000001) |
| the number the customer actually holds is preserved, not overwritten | PASS | receipt_no_claimed=null,OUT-01-RCT-000001 |
| and a severity-1 review names the collision — no two customers hold the same number UNDETECTED | PASS | open RECEIPT_NUMBER_COLLISION reviews: 1 |
| tenant B sees none of tenant A's blocks or reviews (§2.7 category 3) | PASS | rows visible to tenant B: 0 |

## Environment

- Postgres: `postgresql://erp:***@localhost:5433/erp` — PostgreSQL 16.15 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit
- PowerSync service: `http://localhost:8080` — image journeyapps/powersync-service:1.24.0
- API: `http://127.0.0.1:3001` (apps/api dev server, HS256 dev tokens)
- Device SDK: @powersync/node 0.21.0 — one sqlite file per device under packages/sync-drills/.drill-data/
- Node v25.2.1 on darwin arm64
- Sync rules: infra/powersync/sync_rules.yaml (tenant id from token `tid` ONLY); uploads via POST /sync/upload → app.write_log pipeline (download-only sync service)
