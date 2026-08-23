# Sync drill report — Phase 1 acceptance demonstrations

**Generated:** 2026-08-22T22:02:00.312Z by `pnpm --filter @erp/sync-drills drill`
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
- iteration 1: server 207ms, visible on A2 203ms, total 207ms
- iteration 2: server 222ms, visible on A2 204ms, total 222ms
- iteration 3: server 212ms, visible on A2 204ms, total 212ms
- iteration 4: server 220ms, visible on A2 204ms, total 220ms
- iteration 5: server 214ms, visible on A2 200ms, total 214ms
- p95 over 5 iterations: 222ms

**Assertions:**

| Check | Result | Detail |
|---|---|---|
| iter 1: partition is real (sale absent from server while offline) | PASS | server has no such sale pre-reconnect |
| iter 1: offline sale synced < 60s | PASS | 207ms (limit 60000ms) |
| iter 2: partition is real (sale absent from server while offline) | PASS | server has no such sale pre-reconnect |
| iter 2: offline sale synced < 60s | PASS | 222ms (limit 60000ms) |
| iter 3: partition is real (sale absent from server while offline) | PASS | server has no such sale pre-reconnect |
| iter 3: offline sale synced < 60s | PASS | 212ms (limit 60000ms) |
| iter 4: partition is real (sale absent from server while offline) | PASS | server has no such sale pre-reconnect |
| iter 4: offline sale synced < 60s | PASS | 220ms (limit 60000ms) |
| iter 5: partition is real (sale absent from server while offline) | PASS | server has no such sale pre-reconnect |
| iter 5: offline sale synced < 60s | PASS | 214ms (limit 60000ms) |
| p95 < 60s | PASS | 222ms |
| A1 sees all its own D1 sales after reconnect | PASS | 5 sales |

## D2 — Two offline devices, same SKU — exact convergence: PASS

**Measured:**
- baseline on-hand (server, OUT-01, SKU-001): 9705
- all 4 movements on server: 3ms after reconnect
- device-a1 converged: 203ms after server had all movements
- device-a2 converged: 0ms after server had all movements

**Assertions:**

| Check | Result | Detail |
|---|---|---|
| no movement reached server while partitioned | PASS | actual=0 expected=0 |
| server on-hand = baseline 9705 + Σdeltas 105 (exact) | PASS | actual=9810 expected=9810 |
| device A1 local on-hand equals server | PASS | actual=9810 expected=9810 |
| device A2 local on-hand equals server | PASS | actual=9810 expected=9810 |
| A1 and A2 movement ledgers identical (row for row) | PASS | A1=392 rows, A2=392 rows, byte-identical |
| converged ledgers are non-empty | PASS | 392 rows |
| write_log rows per op key (no loss, no dup) | PASS | actual=[1,1,1,1] expected=[1,1,1,1] |
| exactly one stock_movement row per op | PASS | actual=4 expected=4 |

## D3 — HQ sees post-sync stock and sales across locations: PASS

**Measured:**
- A3 outbox flush (2 ops): 90ms
- HQ cross-location query: 5ms over 57 locations
- tenant A sales total across locations: 22312241 minor units
- on-hand SKU-001: OUT-01=9810, OUT-03=225

**Assertions:**

| Check | Result | Detail |
|---|---|---|
| A3 (OUT-03) upload acks applied | PASS | actual=["applied","applied"] expected=["applied","applied"] |
| OUT-01 present with sales | PASS | sales_count=131 |
| OUT-03 present with sales | PASS | sales_count=27 |
| sales visible across ≥ 2 locations in one view | PASS | 2 locations |
| HQ OUT-01 on-hand equals independent ledger sum | PASS | actual=9810 expected=9810 |
| HQ OUT-03 on-hand equals independent ledger sum | PASS | actual=225 expected=225 |
| Σ(per-location sales) = tenant-wide total (exact bigint) | PASS | actual=22312241 expected=22312241 |

## D4 — Verbatim replay of acked batches — all duplicate, zero new effects: PASS

**Measured:**
- state before replay: sales=158 movements=587 credit_entries=99 customers=77 write_log=1866 on-hand(OUT-01)=9810
- replayed 7 batches / 9 ops in 180ms

**Assertions:**

| Check | Result | Detail |
|---|---|---|
| A1 has acked batches to replay | PASS | 7 batches |
| every replayed op acked 'duplicate' (9/9) | PASS | all duplicate |
| zero new effects: state identical after replay | PASS | actual={"sales":158,"movements":587,"creditEntries":99,"customers":77,"writeLog":1866,"onHand":"9810"} expected={"sales":158,"movements":587,"creditEntries":99,"customers":77,"writeLog":1866,"onHand":"9810"} |

## D5 — Tenant isolation at the sync layer — raw device files: PASS

**Measured:**
- B1 (tenant B device): 20 physical tables, 1077 synced rows on disk
- A1 (tenant A device): 20 physical tables, 2444 synced rows on disk

**Assertions:**

| Check | Result | Detail |
|---|---|---|
| non-vacuous: tenant A/OUT-01 predicts rows in product/sale/sale_line/stock_movement/customer | PASS | product=219 sale=131 sale_line=158 stock_movement=542 customer=77 |
| non-vacuous: tenant B/MAIN predicts rows in product/sale/sale_line/stock_movement/customer | PASS | product=219 sale=9 sale_line=9 stock_movement=18 customer=9 |
| B1 (tenant B device): raw row count equals tenant-scoped prediction for all 17 synced tables | PASS | all match (1077 rows on disk) |
| B1 (tenant B device): ZERO rows with tenant A's tenant_id in any of 20 physical tables | PASS | 0 foreign rows (1065 own-tenant rows present) |
| B1 (tenant B device): tenant A's uuid appears NOWHERE in the file's stored rows | PASS | zero occurrences |
| A1 (tenant A device): raw row count equals tenant-scoped prediction for all 17 synced tables | PASS | all match (2444 rows on disk) |
| A1 (tenant A device): ZERO rows with tenant B's tenant_id in any of 20 physical tables | PASS | 0 foreign rows (2432 own-tenant rows present) |
| A1 (tenant A device): tenant B's uuid appears NOWHERE in the file's stored rows | PASS | zero occurrences |

## D6 — The PWA's own payload, over a real socket, into Postgres: PASS

**Measured:**
- tenant 01911111-1111-7111-8111-111111111111 · location OUT-01 · list WHOLESALE · sku SKU-001
- receipt OUT-01-000001-98BF62 · till claimed 29700 minor units
- POST http://127.0.0.1:3001/sync/upload from origin http://localhost:5173: 59ms

**Assertions:**

| Check | Result | Detail |
|---|---|---|
| the browser preflight for this exact request is approved | PASS | status=204 allow-origin=http://localhost:5173 allow-methods=GET, POST, OPTIONS allow-headers=authorization, content-type |
| an arbitrary origin is NOT admitted (the bearer is tenant identity) | PASS | allow-origin=null |
| the batch was delivered and answered (CORS, auth, envelope) | PASS | ok=true status=200 |
| the PWA's own sale payload is ACKED APPLIED, not rejected | PASS | ack={"key":"01a02b7e-adba-7aae-988a-b24c3fcfa803","status":"applied"} |
| exactly one sale row landed | PASS | rows=1 |
| it is filed against the device location the token scopes | PASS | 09cee1e8-5955-8ee5-ad33-ba79bf0499f0 vs 09cee1e8-5955-8ee5-ad33-ba79bf0499f0 |
| the sale line landed | PASS | sale_line rows=1 |
| tax lines landed (the pack rates in force on the business date) | PASS | sale_tax_line rows=3 |
| the stock movement landed, signed for an outflow | PASS | movements=[{"qty_delta":"-3","source_kind":"SALE"}] |
| the total is an exact bigint identity: subtotal − discount + tax | PASS | 19081 = 15900 − 0 + 3181 |
| tax is non-zero and positive | PASS | tax_total_minor=3181 |
| the SERVER priced it — the till's claim is not what was written | PASS | server=19081 till=29700 |
| the divergence is REPORTED back, not swallowed | PASS | priceCheck={"matches":false,"deltaMinor":"-10619","clientTotalMinor":"29700","serverTotalMinor":"19081"} |
| a byte-identical re-POST is acked duplicate | PASS | ack={"key":"01a02b7e-adba-7aae-988a-b24c3fcfa803","status":"duplicate"} |
| the replay produced NO second effect | PASS | sale rows after replay=1 |
| and no second stock movement | PASS | stock_movement rows after replay=1 |

## D7 — Receipt-number regression — wipe a device's local DB mid-block, reissue: PASS

**Measured:**
- block 32001..34000 (size 2000), format '{location_code}-{prefix}-{n:06d}' prefix 'RCT' at OUT-01
- printed before the wipe: OUT-01-RCT-032001, OUT-01-RCT-032002, OUT-01-RCT-032003

**Assertions:**

| Check | Result | Detail |
|---|---|---|
| the server allocates the block — the device never self-issues | PASS | status=ok block=32001..34000 review=null |
| three sales applied on the issued numbers | PASS | applied, applied, applied |
| the server records the reported cursor and opens nothing | PASS | consumed_upto=32003 expected=32003 review=null |
| after the wipe the device holds no block — it cannot know it ever did | PASS | local sequence_block row destroyed with the sqlite file |
| the regression is DETECTED on reconnect | PASS | status=regression kind=LOST_CURSOR in 50ms |
| the review is SEVERITY 1 and names the overlap range | PASS | severity=1 overlap=32001..32003 expected=32001..32003 |
| the remainder of the block is BURNED | PASS | reason=REGRESSION_BURN burned=32004..34000 |
| a FRESH block issues, strictly above everything the burned one covered | PASS | fresh=34001..36000 burned block ended at 34000 |
| exactly two blocks on the server: one burned, one live | PASS | actual=["32001:REGRESSION_BURN","34001:live"] expected=["32001:REGRESSION_BURN","34001:live"] |
| the review is on the server, open, severity 1, scoped to the outlet | PASS | severity=1 status=open class=SEQUENCE_CONSUMED_UPTO_REGRESSION overlap=32001..32003 scoped_locations=1 |
| a colliding sale is APPLIED, not dead-lettered and not retried forever | PASS | status=applied reason=none |
| and specifically NOT the raw unique violation that used to jam the queue | PASS | reason=none |
| both sales are recorded, on DISTINCT stored numbers | PASS | OUT-01-RCT-032001 \| OUT-01-RCT-032001-01AE926 (printed OUT-01-RCT-032001) |
| the number the customer actually holds is preserved, not overwritten | PASS | receipt_no_claimed=null,OUT-01-RCT-032001 |
| and a severity-1 review names the collision — no two customers hold the same number UNDETECTED | PASS | open RECEIPT_NUMBER_COLLISION reviews: 9 |
| tenant B sees none of tenant A's blocks or reviews (§2.7 category 3) | PASS | rows visible to tenant B: 0 |

## Environment

- Postgres: `postgresql://erp:***@localhost:5433/erp` — PostgreSQL 16.15 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit
- PowerSync service: `http://localhost:8080` — image journeyapps/powersync-service:1.24.0
- API: `http://127.0.0.1:3001` (apps/api dev server, HS256 dev tokens)
- Device SDK: @powersync/node 0.21.0 — one sqlite file per device under packages/sync-drills/.drill-data/
- Node v25.2.1 on darwin arm64
- Sync rules: infra/powersync/sync_rules.yaml (tenant id from token `tid` ONLY); uploads via POST /sync/upload → app.write_log pipeline (download-only sync service)
