# @erp/db

Schema source of truth, tenant machinery, seeds and the isolation test harness.

## Layout

| Path | What |
|---|---|
| `migrations/` | **Hand-written, numbered SQL — THE schema.** Drizzle mirrors, never generates. |
| `src/migrate.ts` | Tiny ordered SQL runner (no framework). Works against PGlite and `pg`. |
| `src/tenant-table.ts` | `tenantTable()` — the Drizzle factory that structurally injects `tenant_id`, `id`, `write_id`, `hlc` and the `(tenant_id, id)` PK, so omission is impossible. All app tables are defined through it. |
| `src/schema.ts` | Typed mirrors of the migrations. Money/qty/rates are `bigint` (mode `'bigint'`) — never `number` (ADR-0004). |
| `src/testing/harness.ts` | Hermetic Postgres via PGlite. **PGlite connects as a superuser, which BYPASSES RLS** — the harness runs every tenant-scoped block under `SET LOCAL ROLE app_user` so RLS genuinely applies. |
| `src/seed/` | `skus.csv` / `outlets.csv` parsing, the "construction-materials-gh" template, `applyTemplate(tx, tenantId)`, the Ghana jurisdiction seed (rates all `[UNCONFIRMED]`, `confirmed_by IS NULL` — the §2.8 gate). |
| `test/` | Conformance (pg_catalog interrogation), two-tenant SQL-level isolation as `app_user`, write_log idempotency, effective-dated tax repricing, seed counts + idempotency. |

## Invariants enforced here

- `tenant_id` on every app row; RLS **enabled and forced**; policy text canonical; every PK leads with `tenant_id`; composite FKs carry `tenant_id` on both sides. The conformance suite fails any new table that misses any of it.
- One write registry: `app.write_log`; `id` **is** the idempotency key, unique **per tenant** (PK `(tenant_id, id)`), `hlc` server-stamped, `claimed_hlc` untrusted.
- Stock and credit are append-only ledgers; on-hand and balances are derived.
- Money/quantities/rates: `bigint` minor units / scaled integers / e4 rates in both layers. Minor-unit scale comes from `platform.jurisdiction`, never assumed 100.
- No statutory payroll anything — `app.staff` is capture only (CLAUDE.md §2.4).
- Q8 (Ghana e-VAT clearance) is UNRESOLVED: `app.sale` carries a clearly marked seam comment and **no** issuance/clearance fields.

## Running the tests

```sh
npm install --no-package-lock   # inside packages/db (workspace rule: no root install)
npx vitest run
```
