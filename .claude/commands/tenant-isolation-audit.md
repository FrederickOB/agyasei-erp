---
description: Prove no read path, sync rule, report or export leaks across tenants
---

Audit cross-tenant isolation using the `tenant-isolation-test-engineer` agent.

This is the third mandatory test category (`CLAUDE.md` §2.7) and it differs from the other two:
money and sync bugs are recoverable; **a tenant leak is not.** Once another company's data has
synced to a device it cannot be recalled.

**1. Schema enforcement — enumerate from the live catalogue, not from memory.**
Every tenant-owned table must have `tenant_id`, an RLS policy, and a leading index on it. Report
any table missing any of the three. Prefer a test that fails automatically when a new table
appears without isolation over a checklist someone has to remember.

**2. Enumerate every read path and cover each.** The forgotten ones are the ones that leak:
list and detail endpoints · search (especially full-text, which often bypasses the layer holding
the tenant predicate) · reports and aggregates · exports (CSV, payroll register, statutory
reports, tenant data export) · **sync rules** · error messages and validation.

**3. Assert absence, not presence.** A test that says "tenant A sees tenant A's data" passes
happily on a system showing tenant A *everyone's* data. Run a two-tenant fixture and assert
tenant B's rows are **absent** and the counts are exactly right. For aggregates, assert the
*numbers* — a total silently including another tenant's sales leaks commercially sensitive
information without ever showing a row.

**4. Attack the write side.**
- A client-supplied `tenant_id` in a payload must be ignored or rejected, never honoured. This is
  the single highest-value test in the suite.
- Cross-tenant foreign keys must be impossible.
- Tampered or expired tenant claims must fail closed.
- Idempotency-key uniqueness is per tenant — reuse across tenants must not collide or reveal.

**5. Prove RLS is actually working.** Deliberately issue a query with no tenant predicate,
**bypassing the application layer**, and assert the database returns nothing. If the test passes
only because the app also filtered, the backstop is untested (`CLAUDE.md` §2.1).

**6. Check for tenant-identity branching.** Grep for any code reading which tenant it is serving
(`ADR-0006` / `CLAUDE.md` §2.9). Includes the disguised form — branching on tenant #1's
vocabulary such as `'RDC'` or `'Flagship'`. Each is a defect; the fix is to model the
configuration dimension it stands in for.

**7. Sync rules — inspect the device.** A device authenticated for tenant A must hold zero
tenant-B rows in its **local SQLite**. Inspect the database directly, not the UI.

For each finding: file, line, the leak it enables, and the fix.
