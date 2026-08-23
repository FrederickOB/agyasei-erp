/**
 * tenantTable() — the Drizzle factory every app-schema table is defined
 * through. It structurally injects the tenant pattern so omitting tenant_id
 * (or the write spine) is IMPOSSIBLE, not a convention someone remembers
 * (CLAUDE.md §2.1; ADR-0005; 01-tenancy §1.3).
 *
 * IMPORTANT: these definitions MIRROR the hand-written SQL in ../migrations —
 * they never generate it. Migrations are the source of truth; the mirror
 * exists so application code gets typed queries and so the conformance suite
 * has a registry to reconcile against pg_catalog (a table present in the
 * database but absent from this registry fails CI, 01 §1.3 layer 3).
 *
 * Injected on every table:
 *   tenant_id  uuid NOT NULL   — from the verified token, NEVER a client payload
 *   id         uuid NOT NULL   — UUIDv7, client-generatable offline
 *   write_id   uuid NOT NULL   — composite FK to app.write_log: the idempotency spine
 *   hlc        text NOT NULL   — server-stamped hybrid logical clock
 *   created_at / updated_at / deleted_at
 *   PRIMARY KEY (tenant_id, id) — every index that matters leads with tenant_id
 */
import {
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const appSchema = pgSchema('app');
export const platformSchema = pgSchema('platform');

const RESERVED_KEYS = new Set([
  'tenantId',
  'id',
  'writeId',
  'hlc',
  'createdAt',
  'updatedAt',
  'deletedAt',
]);

/** SQL names of the app tables defined through tenantTable(). */
const tenantTableRegistry = new Map<string, unknown>();

/**
 * App tables that legitimately have NO write_id column, per-assertion
 * exemptions in the sense of 04 §4.2.5. NOTHING is ever exempt from
 * tenant_id or forced RLS — the conformance suite hard-codes that refusal.
 *
 * Two kinds of exemption, and no third:
 *
 *  1. `write_log` is the referent of the write-spine FK, so it cannot also
 *     carry one.
 *  2. SERVER-DERIVED rows (04 §4.17.3, migration 0013). No client write
 *     creates them — a trigger recomputes them from rows that DO carry a
 *     write spine, and the spine of the derived row is the spine of its
 *     source. Giving them a nullable `write_id` would be a column that means
 *     nothing, which is worse than a named exemption: `credit_allowance` and
 *     `credit_position_*` are precisely the rows a device must never be able
 *     to author, and an always-null write column would invite one to try.
 */
export const WRITE_ID_EXEMPT: readonly string[] = [
  'write_log',
  'credit_sync_book_scope',
  'credit_sync_location_scope',
  'credit_ageing_band',
  'credit_position_snapshot',
  'credit_position_bucket',
  'credit_allowance',
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExtraBuilder = (t: any) => any[];

export function tenantTable<TCols extends Record<string, unknown>>(
  name: string,
  columns: TCols,
  extra?: ExtraBuilder,
) {
  if (tenantTableRegistry.has(name)) {
    throw new Error(`tenantTable('${name}') defined twice`);
  }
  for (const key of Object.keys(columns)) {
    if (RESERVED_KEYS.has(key)) {
      throw new Error(
        `tenantTable('${name}'): column key '${key}' is injected by the factory and cannot be redefined`,
      );
    }
  }

  const table = appSchema.table(
    name,
    {
      tenantId: uuid('tenant_id').notNull(),
      id: uuid('id').notNull(),
      writeId: uuid('write_id').notNull(),
      hlc: text('hlc').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
      deletedAt: timestamp('deleted_at', { withTimezone: true }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(columns as any),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (t: any) => [
      primaryKey({ name: `${name}_pkey`, columns: [t.tenantId, t.id] }),
      ...(extra ? extra(t) : []),
    ],
  );

  tenantTableRegistry.set(name, table);
  return table;
}

/**
 * Register an app table that is NOT built by the factory. The only legitimate
 * caller is write_log (the write spine's referent). Anything else is a
 * defect the conformance suite will surface: the table must still satisfy
 * every structural assertion or appear in a per-assertion exemption.
 */
export function registerAppTable(name: string, table: unknown): void {
  if (tenantTableRegistry.has(name)) {
    throw new Error(`registerAppTable('${name}'): already registered`);
  }
  tenantTableRegistry.set(name, table);
}

/** Every app table the mirror knows about — the conformance registry. */
export function registeredAppTableNames(): string[] {
  return [...tenantTableRegistry.keys()].sort();
}
