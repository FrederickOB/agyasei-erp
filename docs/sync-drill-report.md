# Sync drill report — Phase 1 acceptance demonstrations

**Generated:** 2026-08-23T21:40:10.459Z by `pnpm --filter @erp/sync-drills drill`
**Nothing mocked:** real Postgres 16 (docker, :5433), real self-hosted PowerSync service (:8080), real API (:3001); each device is an `@powersync/node` client with its own sqlite file and its own tokens.

**Overall: PASS** — 8/8 drills passed.

| Drill | Result |
|---|---|
| D1 — Offline sale syncs to server + second device < 60s | PASS |
| D2 — Two offline devices, same SKU — exact convergence | PASS |
| D3 — HQ sees post-sync stock and sales across locations | PASS |
| D4 — Verbatim replay of acked batches — all duplicate, zero new effects | PASS |
| D5 — Tenant isolation at the sync layer — raw device files | PASS |
| D6 — The PWA's own payload, over a real socket, into Postgres | PASS |
| D7 — Receipt-number regression — wipe a device's local DB mid-block, reissue | PASS |
| D8 — Credit at the sync layer — isolation, the permission gate, the location slice | PASS |

## D1 — Offline sale syncs to server + second device < 60s: PASS

**Measured:**
- iteration 1: server 207ms, visible on A2 203ms, total 207ms
- iteration 2: server 217ms, visible on A2 205ms, total 217ms
- iteration 3: server 215ms, visible on A2 204ms, total 215ms
- iteration 4: server 225ms, visible on A2 205ms, total 225ms
- iteration 5: server 239ms, visible on A2 205ms, total 239ms
- p95 over 5 iterations: 239ms

**Assertions:**

| Check | Result | Detail |
|---|---|---|
| iter 1: partition is real (sale absent from server while offline) | PASS | server has no such sale pre-reconnect |
| iter 1: offline sale synced < 60s | PASS | 207ms (limit 60000ms) |
| iter 2: partition is real (sale absent from server while offline) | PASS | server has no such sale pre-reconnect |
| iter 2: offline sale synced < 60s | PASS | 217ms (limit 60000ms) |
| iter 3: partition is real (sale absent from server while offline) | PASS | server has no such sale pre-reconnect |
| iter 3: offline sale synced < 60s | PASS | 215ms (limit 60000ms) |
| iter 4: partition is real (sale absent from server while offline) | PASS | server has no such sale pre-reconnect |
| iter 4: offline sale synced < 60s | PASS | 225ms (limit 60000ms) |
| iter 5: partition is real (sale absent from server while offline) | PASS | server has no such sale pre-reconnect |
| iter 5: offline sale synced < 60s | PASS | 239ms (limit 60000ms) |
| p95 < 60s | PASS | 239ms |
| A1 sees all its own D1 sales after reconnect | PASS | 5 sales |

## D2 — Two offline devices, same SKU — exact convergence: PASS

**Measured:**
- baseline on-hand (server, OUT-01, SKU-001): 490
- all 4 movements on server: 7ms after reconnect
- device-a1 converged: 203ms after server had all movements
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
- A3 outbox flush (2 ops): 97ms
- HQ cross-location query: 5ms over 57 locations
- tenant A sales total across locations: 89040 minor units
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
| Σ(per-location sales) = tenant-wide total (exact bigint) | PASS | actual=89040 expected=89040 |

## D4 — Verbatim replay of acked batches — all duplicate, zero new effects: PASS

**Measured:**
- state before replay: sales=6 movements=12 credit_entries=0 customers=1 write_log=41 on-hand(OUT-01)=595
- replayed 7 batches / 9 ops in 165ms

**Assertions:**

| Check | Result | Detail |
|---|---|---|
| A1 has acked batches to replay | PASS | 7 batches |
| every replayed op acked 'duplicate' (9/9) | PASS | all duplicate |
| zero new effects: state identical after replay | PASS | actual={"sales":6,"movements":12,"creditEntries":0,"customers":1,"writeLog":41,"onHand":"595"} expected={"sales":6,"movements":12,"creditEntries":0,"customers":1,"writeLog":41,"onHand":"595"} |

## D5 — Tenant isolation at the sync layer — raw device files: PASS

**Measured:**
- B1 (tenant B device): 26 physical tables, 1021 synced rows on disk
- A1 (tenant A device): 26 physical tables, 1109 synced rows on disk

**Assertions:**

| Check | Result | Detail |
|---|---|---|
| non-vacuous: tenant A/OUT-01 predicts rows in product/sale/sale_line/stock_movement/customer | PASS | product=219 sale=5 sale_line=6 stock_movement=10 customer=1 |
| non-vacuous: tenant B/MAIN predicts rows in product/sale/sale_line/stock_movement/customer | PASS | product=219 sale=1 sale_line=1 stock_movement=2 customer=1 |
| B1 (tenant B device): raw row count equals tenant-scoped prediction for all 23 synced tables | PASS | all match (1021 rows on disk) |
| B1 (tenant B device): ZERO rows with tenant A's tenant_id in any of 26 physical tables | PASS | 0 foreign rows (1009 own-tenant rows present) |
| B1 (tenant B device): tenant A's uuid appears NOWHERE in the file's stored rows | PASS | zero occurrences |
| A1 (tenant A device): raw row count equals tenant-scoped prediction for all 23 synced tables | PASS | all match (1109 rows on disk) |
| A1 (tenant A device): ZERO rows with tenant B's tenant_id in any of 26 physical tables | PASS | 0 foreign rows (1097 own-tenant rows present) |
| A1 (tenant A device): tenant B's uuid appears NOWHERE in the file's stored rows | PASS | zero occurrences |

## D6 — The PWA's own payload, over a real socket, into Postgres: PASS

**Measured:**
- tenant 01911111-1111-7111-8111-111111111111 · location OUT-01 · list WHOLESALE · sku SKU-001
- receipt OUT-01-000001-78764C · till claimed 29700 minor units
- POST http://127.0.0.1:3001/sync/upload from origin http://localhost:5173: 58ms

**Assertions:**

| Check | Result | Detail |
|---|---|---|
| the browser preflight for this exact request is approved | PASS | status=204 allow-origin=http://localhost:5173 allow-methods=GET, POST, OPTIONS allow-headers=authorization, content-type |
| an arbitrary origin is NOT admitted (the bearer is tenant identity) | PASS | allow-origin=null |
| the batch was delivered and answered (CORS, auth, envelope) | PASS | ok=true status=200 |
| the PWA's own sale payload is ACKED APPLIED, not rejected | PASS | ack={"key":"01a03090-b852-7a45-9a3a-81692fff361b","status":"applied"} |
| exactly one sale row landed | PASS | rows=1 |
| it is filed against the device location the token scopes | PASS | 09cee1e8-5955-8ee5-ad33-ba79bf0499f0 vs 09cee1e8-5955-8ee5-ad33-ba79bf0499f0 |
| the sale line landed | PASS | sale_line rows=1 |
| tax lines landed (the pack rates in force on the business date) | PASS | sale_tax_line rows=3 |
| the stock movement landed, signed for an outflow | PASS | movements=[{"qty_delta":"-3","source_kind":"SALE"}] |
| the total is an exact bigint identity: subtotal − discount + tax | PASS | 19081 = 15900 − 0 + 3181 |
| tax is non-zero and positive | PASS | tax_total_minor=3181 |
| the SERVER priced it — the till's claim is not what was written | PASS | server=19081 till=29700 |
| the divergence is REPORTED back, not swallowed | PASS | priceCheck={"matches":false,"deltaMinor":"-10619","clientTotalMinor":"29700","serverTotalMinor":"19081"} |
| a byte-identical re-POST is acked duplicate | PASS | ack={"key":"01a03090-b852-7a45-9a3a-81692fff361b","status":"duplicate"} |
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
| the regression is DETECTED on reconnect | PASS | status=regression kind=LOST_CURSOR in 47ms |
| the review is SEVERITY 1 and names the overlap range | PASS | severity=1 overlap=1..3 expected=1..3 |
| the remainder of the block is BURNED | PASS | reason=REGRESSION_BURN burned=4..2000 |
| a FRESH block issues, strictly above everything the burned one covered | PASS | fresh=2001..4000 burned block ended at 2000 |
| exactly two blocks on the server: one burned, one live | PASS | actual=["1:REGRESSION_BURN","2001:live"] expected=["1:REGRESSION_BURN","2001:live"] |
| the review is on the server, open, severity 1, scoped to the outlet | PASS | severity=1 status=open class=SEQUENCE_CONSUMED_UPTO_REGRESSION overlap=1..3 scoped_locations=1 |
| a colliding sale is APPLIED, not dead-lettered and not retried forever | PASS | status=applied reason=none |
| and specifically NOT the raw unique violation that used to jam the queue | PASS | reason=none |
| both sales are recorded, on DISTINCT stored numbers | PASS | OUT-01-RCT-000001 \| OUT-01-RCT-000001-01AA3BC (printed OUT-01-RCT-000001) |
| the number the customer actually holds is preserved, not overwritten | PASS | receipt_no_claimed=null,OUT-01-RCT-000001 |
| and a severity-1 review names the collision — no two customers hold the same number UNDETECTED | PASS | open RECEIPT_NUMBER_COLLISION reviews: 1 |
| tenant B sees none of tenant A's blocks or reviews (§2.7 category 3) | PASS | rows visible to tenant B: 0 |

## D8 — Credit at the sync layer — isolation, the permission gate, the location slice: PASS

**Measured:**
- credit sync surface: book tables customer_account, credit_limit_version, credit_entry, credit_position_snapshot, credit_position_bucket (gated on credit.view at the tenant root); till table credit_allowance (gated on sale.record.credit ∩ location scope)

**Assertions:**

| Check | Result | Detail |
|---|---|---|
| server: tenant A position balance is the sum of its charges | PASS | actual=10633178 expected=10633178 |
| server: tenant B position balance is the sum of its charges | PASS | actual=4411909 expected=4411909 |
| fixtures are distinguishable: the two tenants’ balances differ | PASS | A=10633178 B=4411909 |
| fixture ages across more than one band on tenant A | PASS | current=0 1-30=2900077 31-60=7733101 61-90=0 90+=0 |
| gate: the accounts principals are in credit_sync_book_scope, the tills are NOT | PASS | credit.view at the tenant root gates the book; counter_staff holds sale.record.credit and no credit.view |
| R1.b gate: an OUTLET MANAGER assigned AT THE ROOT is NOT in credit_sync_book_scope | PASS | the template no longer grants credit.view to the outlet-manager role, so the root assignment confers nothing — the strongest form of the R1.b claim |
| accounts-A device: ZERO rows carrying tenant B's tenant_id in any of 26 physical tables | PASS | 0 foreign rows, 1148 own-tenant rows present (non-vacuous) |
| accounts-A device: tenant B's tenant uuid appears NOWHERE in the device's bytes | PASS | foreign="01922222-2222-7222-8222-222222222222" hits=0; positive control own="01911111-1111-7111-8111-111111111111" hits=2453 |
| accounts-A device: tenant B's customer name appears NOWHERE in the device's bytes | PASS | foreign="D8 Contractor Bravo mt6bygvc" hits=0; positive control own="D8 Contractor Alpha mt6bygvc" hits=2 |
| accounts-A device: tenant B's balance decimal string appears NOWHERE in the device's bytes | PASS | foreign="4411909" hits=0; positive control own="10633178" hits=4 |
| accounts-B device: ZERO rows carrying tenant A's tenant_id in any of 26 physical tables | PASS | 0 foreign rows, 1019 own-tenant rows present (non-vacuous) |
| accounts-B device: tenant A's tenant uuid appears NOWHERE in the device's bytes | PASS | foreign="01911111-1111-7111-8111-111111111111" hits=0; positive control own="01922222-2222-7222-8222-222222222222" hits=2134 |
| accounts-B device: tenant A's customer name appears NOWHERE in the device's bytes | PASS | foreign="D8 Contractor Alpha mt6bygvc" hits=0; positive control own="D8 Contractor Bravo mt6bygvc" hits=2 |
| accounts-B device: tenant A's balance decimal string appears NOWHERE in the device's bytes | PASS | foreign="10633178" hits=0; positive control own="4411909" hits=11 |
| till-A/OUT-01 device: ZERO rows carrying tenant B's tenant_id in any of 26 physical tables | PASS | 0 foreign rows, 1122 own-tenant rows present (non-vacuous) |
| till-A/OUT-01 device: tenant B's tenant uuid appears NOWHERE in the device's bytes | PASS | foreign="01922222-2222-7222-8222-222222222222" hits=0; positive control own="01911111-1111-7111-8111-111111111111" hits=2358 |
| till-A/OUT-01 device: tenant B's customer name appears NOWHERE in the device's bytes | PASS | foreign="D8 Contractor Bravo mt6bygvc" hits=0; positive control own="D8 Contractor Alpha mt6bygvc" hits=2 |
| till-A/OUT-01 device: tenant B's allowance headroom (own, positive control) appears NOWHERE in the device's bytes | PASS | foreign="4411909" hits=0; positive control own="300000" hits=113 |
| the OUT-01 till holds NO credit balance of ANY customer of its own tenant (§02: the right to see is not the right to hold) | PASS | own-tenant balance "10633178" hits=0; trade exposure "10633178" hits=0 |
| d8-accounts-a: every credit table on disk equals the tenant-scoped server prediction | PASS | customer_account=3 credit_limit_version=3 credit_entry=3 credit_position_snapshot=3 credit_position_bucket=15 credit_allowance=0 |
| d8-till-a-out01: every credit table on disk equals the tenant-scoped server prediction | PASS | customer_account=0 credit_limit_version=0 credit_entry=0 credit_position_snapshot=0 credit_position_bucket=0 credit_allowance=1 |
| d8-till-a-out03: every credit table on disk equals the tenant-scoped server prediction | PASS | customer_account=0 credit_limit_version=0 credit_entry=0 credit_position_snapshot=0 credit_position_bucket=0 credit_allowance=1 |
| d8-outlet-manager-a-root: every credit table on disk equals the tenant-scoped server prediction | PASS | customer_account=0 credit_limit_version=0 credit_entry=0 credit_position_snapshot=0 credit_position_bucket=0 credit_allowance=2 |
| d8-accounts-b: every credit table on disk equals the tenant-scoped server prediction | PASS | customer_account=2 credit_limit_version=2 credit_entry=1 credit_position_snapshot=2 credit_position_bucket=10 credit_allowance=0 |
| R5.3 gate: a tenant-A till WITHOUT credit.view holds ZERO of the credit book… | PASS | customer_account=0 credit_limit_version=0 credit_entry=0 credit_position_snapshot=0 credit_position_bucket=0 |
| …while the SAME tables on a tenant-A accounts device in the SAME run are non-empty (non-vacuity) | PASS | customer_account=3 credit_limit_version=3 credit_entry=3 credit_position_snapshot=3 credit_position_bucket=15 |
| …and the till is NOT simply empty: it holds its own allowance rows | PASS | credit_allowance=1 |
| the accounts device holds NO allowance rows — credit.view is not sale.record.credit | PASS | credit_allowance=0 |
| GAP 20: a ROOT-scoped OUTLET MANAGER device holds ZERO rows of the credit book, per table, on disk | PASS | customer_account=0 credit_limit_version=0 credit_entry=0 credit_position_snapshot=0 credit_position_bucket=0 |
| GAP 20 non-vacuity: the SAME tables on the accounts device in the SAME run are non-empty | PASS | accounts customer_account=3 vs manager 0 accounts credit_limit_version=3 vs manager 0 accounts credit_entry=3 vs manager 0 accounts credit_position_snapshot=3 vs manager 0 accounts credit_position_bucket=15 vs manager 0 |
| GAP 20: not one BOOK figure — balance, charge or limit — appears in the manager device file or its -wal | PASS | balance "10633178" hits=0; charge 1 "7733101" hits=0; charge 2 "2900077" hits=0; credit limit "96431907" hits=0 |
| GAP 20 positive control: the SAME figures ARE in the accounts device file — the grep is not blind | PASS | balance hits=4; charge 1 hits=7; charge 2 hits=5; credit limit hits=19 |
| GAP 20: the manager device DOES hold the customer's NAME — identity is not the book (R1.a) | PASS | name "D8 Contractor Alpha mt6bygvc" hits=3 on the manager file, while every money figure above is 0 — the right to see is not the right to hold |
| GAP 20: the manager device is NOT simply an empty file — it synced its tenant's other data | PASS | 18 synced data tables on disk, none of them a credit-book table |
| R5.4: the OUT-01 till holds allowance rows for OUT-01 and for no other location | PASS | distinct location_id on disk = [09cee1e8-5955-8ee5-ad33-ba79bf0499f0] (OUT-01=09cee1e8-5955-8ee5-ad33-ba79bf0499f0) |
| R5.4: the OUT-03 till holds OUT-03’s, in the same run — so "zero OUT-03 rows" above is not "no rows anywhere" | PASS | distinct location_id on disk = [6263284c-6cb0-8f41-bdd3-89e06817eded] (OUT-03=6263284c-6cb0-8f41-bdd3-89e06817eded) |
| R5.4: a customer who trades only at OUT-03 has NO row at all on the OUT-01 till | PASS | OUT-01 till customer_ids = [57fd9dd9-47a8-89f6-868e-72eab45ce404]; OUT-03-only customer = 93594498-e77e-8981-bd42-9d7ddd71b3bd |
| R5.3: granting credit.view fills the device in the same run — the gate is the parameter query, not the fixture | PASS | customer_account=3/3 credit_limit_version=3/3 credit_entry=3/3 credit_position_snapshot=3/3 credit_position_bucket=15/15 |
| till-A after grant: ZERO rows carrying tenant B's tenant_id in any of 26 physical tables | PASS | 0 foreign rows, 1149 own-tenant rows present (non-vacuous) |
| till-A after grant: tenant B's tenant uuid appears NOWHERE in the device's bytes | PASS | foreign="01922222-2222-7222-8222-222222222222" hits=0; positive control own="01911111-1111-7111-8111-111111111111" hits=2454 |
| till-A after grant: tenant B's customer name appears NOWHERE in the device's bytes | PASS | foreign="D8 Contractor Bravo" hits=0; positive control own="D8 Contractor Alpha mt6bygvc" hits=2 |
| till-A after grant: tenant B's balance decimal string appears NOWHERE in the device's bytes | PASS | foreign="4411909" hits=0; positive control own="10633178" hits=4 |
| R5.5 precondition: the accounts-A user is out of credit_sync_book_scope after revocation | PASS | the projection is trigger-maintained, so a revoked grant is gone before the next sync |
| R5.5: revoking credit.view empties the device on the next sync — from counts that were demonstrably > 0 | PASS | customer_account: 3 → 0; credit_limit_version: 3 → 0; credit_entry: 3 → 0; credit_position_snapshot: 3 → 0; credit_position_bucket: 15 → 0 |
| R5.5: and the revoked device retains no trace of the book in its bytes | PASS | row-level: PowerSync deletes the rows; page-level residue is covered by the byte grep in the forged-claim device below |
| R5.6: a token whose tid is tenant A and whose sub is a tenant-B user receives ZERO rows in every credit bucket | PASS | customer_account=0 credit_limit_version=0 credit_entry=0 credit_position_snapshot=0 credit_position_bucket=0 credit_allowance=0 |
| …non-vacuous: the SAME sub with its HONEST tid held rows in this run | PASS | customer_account=2 credit_limit_version=2 credit_entry=1 credit_position_snapshot=2 credit_position_bucket=10 |

## Environment

- Postgres: `postgresql://erp:***@localhost:5433/erp` — PostgreSQL 16.15 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit
- PowerSync service: `http://localhost:8080` — image journeyapps/powersync-service:1.24.0
- API: `http://127.0.0.1:3001` (apps/api dev server, HS256 dev tokens)
- Device SDK: @powersync/node 0.21.0 — one sqlite file per device under packages/sync-drills/.drill-data/
- Node v25.2.1 on darwin arm64
- Sync rules: infra/powersync/sync_rules.yaml (tenant id from token `tid` ONLY); uploads via POST /sync/upload → app.write_log pipeline (download-only sync service)
