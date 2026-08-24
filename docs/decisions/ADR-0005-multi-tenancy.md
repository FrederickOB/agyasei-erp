# ADR-0005 — Multi-tenancy: shared schema, RLS, tenant-scoped sync

**Status:** Accepted · **Date:** 2026-08-20 · **Affects:** all phases · **Supersedes:** nothing

## Context
This system is a **product**, not a bespoke build. Agyasei Jnr & Company Limited is tenant #1
and the pilot customer; other distribution businesses will run on the same platform.

That makes tenant isolation a constraint of the same rank as offline-first — and the two
interact badly if not designed together. Offline-first means tenant data lives in local SQLite
on tablets in district towns. Multi-tenant means a leak across tenants exposes one company's
books, margins and customer credit positions to another. Unlike most bugs, it is **unrecoverable**:
once the data has synced to a device, it cannot be recalled.

## Decision
**Shared schema, `tenant_id` on every tenant-owned table, Postgres row-level security, and
sync rules scoped by a verified tenant claim.**

Four rules make it hold:

1. **`tenant_id` is on every tenant-owned row**, and every index that matters leads with it.
2. **`tenant_id` is never accepted from a client payload.** It comes from the verified JWT,
   server-side, on every write. A client-supplied tenant ID is treated as an attack.
3. **RLS is the backstop, not the primary control.** Application queries scope by tenant *and*
   RLS enforces it, so a forgotten predicate fails closed rather than leaking. Belt and braces,
   because the failure mode is unrecoverable.
4. **Sync rules carry the tenant boundary.** A device syncs `tenant_id = token.tenant_id` and
   nothing else, intersected with the user's role and outlet scope (`ADR-0006`). The sync rule is
   the point at which data leaves the server for a device — so it is the isolation boundary that
   actually matters.

**The tenant → database mapping is a lookup from day one**, even though every tenant currently
resolves to the same database. That indirection is nearly free now and is the only thing that
makes promoting a large or regulated customer to a dedicated database later a configuration
change rather than a rewrite.

## Consequences
- Cheapest to operate; one migration run; one sync service. Appropriate for a product finding
  its first customers.
- **Isolation now depends on discipline, so it must be enforced structurally**: a shared base
  table definition or codegen that makes omitting `tenant_id` impossible, not a convention.
- **Cross-tenant leakage becomes a third mandatory test category** alongside money and sync
  (`CLAUDE.md` §2.7). Every read path gets a test that a second tenant's data is invisible.
- Idempotency-key uniqueness is scoped per tenant, not global.
- Per-tenant data export and deletion must be built deliberately — with a shared schema they are
  queries, not `pg_dump`. A customer leaving must be able to take their books with them.
- Noisy-neighbour risk is real at scale; monitor per-tenant query cost.

## Alternatives considered
- **Database per tenant** — strongest isolation, trivial per-customer backup and export, but
  migrations run N times and each tenant needs its own sync connection, raising cost per customer
  materially at low customer counts. Preserved as an upgrade path via the mapping above.
- **Schema per tenant** — sits awkwardly with sync-rule definitions and gives most of the
  operational cost of database-per-tenant without the strongest isolation guarantee. Rejected.
