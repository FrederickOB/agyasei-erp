/**
 * The device's local schema (§8.1, §8.2) — ONE definition, two consumers:
 *
 * - `src/data/powersync.ts` builds the PowerSync Schema from it (browser),
 * - `localSchemaDdl()` builds plain SQLite DDL from it (node test adapter),
 *
 * so the schema the tests exercise is the schema the device runs.
 *
 * Synced-shape tables (`product`, `price`, `stock_snapshot`) mirror the server
 * catalogue and are READ-ONLY on the device — they arrive through the sync
 * stream. LOCAL-ONLY tables never sync:
 *
 * - `cart` / `cart_line`: the draft sale. Lives in SQLite so a battery pull or
 *   an OOM-kill mid-sale cannot lose the cart, and an abandoned cart can never
 *   become a phantom sale at HQ (§8.2). The cart id is a UUIDv7 minted at cart
 *   creation — it becomes the sale id AND the idempotency key.
 * - `outbox`: pending writes awaiting upload into the ONE write registry
 *   (`app.write_log`). Carries `idempotency_key` (the UUIDv7) and
 *   `claimed_hlc` (the device's untrusted clock assertion; the server stamps
 *   the authoritative HLC at ingest).
 * - `local_config`: device-scoped records — the CurrencySpec for display, the
 *   device HLC node id. Presentation reads configuration, never constants.
 *
 * NOTE on tenant_id: local synced rows mirror the server schema (which carries
 * tenant_id on every tenant-owned row), but the client NEVER sends tenant_id
 * in an upload payload — the server stamps it from the verified token and
 * treats a mismatch as an incident (ADR-0005; §8.1).
 *
 * Money/quantity columns are INTEGER in SQLite and are ALWAYS selected as
 * `CAST(col AS TEXT)` then parsed with `BigInt()` — the wasm driver would
 * otherwise hand back float64 `number`s (§8.3). Writes bind decimal strings
 * through `CAST(? AS INTEGER)`.
 */

export type LocalColumnType = 'text' | 'integer';

export interface LocalColumnDef {
  readonly name: string;
  readonly type: LocalColumnType;
}

export interface LocalTableDef {
  readonly name: string;
  readonly localOnly: boolean;
  readonly columns: readonly LocalColumnDef[];
}

const t = (name: string): LocalColumnDef => ({ name, type: 'text' });
const i = (name: string): LocalColumnDef => ({ name, type: 'integer' });

export const LOCAL_TABLES: readonly LocalTableDef[] = [
  // ---- synced shape (read-only on device; hydrated by the sync stream) ----
  {
    name: 'product',
    localOnly: false,
    columns: [
      t('code'),
      t('name'),
      t('aliases'), // tenant-edited local names — first-class search data (§8.7)
      t('category'),
      t('uom_label'), // selling-unit label, snapshot of the unit definition
      i('qty_scale'), // scaled-integer denomination of quantities in this unit
      i('active'),
    ],
  },
  {
    name: 'price',
    localOnly: false,
    columns: [
      t('product_id'),
      t('price_list_id'),
      i('unit_price_e4'), // minor units per selling unit × 10^4 (money-adjacent: CAST AS TEXT)
    ],
  },
  {
    name: 'stock_snapshot',
    localOnly: false,
    columns: [
      t('product_id'),
      t('location_id'),
      i('qty_scaled'), // scaled integer — CAST AS TEXT on read
      t('as_of'),
    ],
  },
  // ---- local-only (never syncs) ----
  {
    name: 'local_config',
    localOnly: true,
    columns: [t('key'), t('value')],
  },
  {
    name: 'cart',
    localOnly: true,
    // id = UUIDv7 = the future sale id = the idempotency key (§8.2).
    columns: [t('created_at'), t('price_list_id'), t('status')],
  },
  {
    name: 'cart_line',
    localOnly: true,
    columns: [
      t('cart_id'),
      i('seq'),
      t('product_id'),
      t('name_snapshot'), // snapshots survive later catalogue edits (§8.3d)
      t('uom_label_snapshot'),
      i('qty_scale'),
      i('qty_scaled'), // CAST AS TEXT on read
      i('unit_price_e4'), // CAST AS TEXT on read
    ],
  },
  {
    name: 'outbox',
    localOnly: true,
    columns: [
      // id equals idempotency_key; the column is kept explicit because it IS
      // the contract with app.write_log (id is the per-tenant idempotency key).
      t('idempotency_key'),
      t('claimed_hlc'), // device assertion — server stores it UNTRUSTED
      t('kind'), // 'sale' (skeleton); adjustments/transfers/payments later
      t('payload'), // JSON; every monetary value is a decimal STRING of minor units
      i('total_minor'), // for the sales list — CAST AS TEXT on read
      t('created_at'),
      t('server_ack_at'), // NULL until the server acks; drives the §8.5 badge
      t('rejected_at'),
      t('reject_reason'),
    ],
  },
];

/**
 * Plain-SQLite DDL for the same schema (node test adapter). PowerSync gives
 * every table a TEXT `id` primary key; the DDL mirrors that.
 *
 * The unique index on outbox.idempotency_key is local defence in depth — the
 * AUTHORITATIVE uniqueness is `app.write_log`'s per-tenant primary key at
 * ingest (architecture ruling: one write registry).
 */
export function localSchemaDdl(): string[] {
  const stmts = LOCAL_TABLES.map((table) => {
    const cols = table.columns
      .map((c) => `${c.name} ${c.type === 'integer' ? 'INTEGER' : 'TEXT'}`)
      .join(', ');
    return `CREATE TABLE ${table.name} (id TEXT PRIMARY KEY NOT NULL${cols.length > 0 ? ', ' + cols : ''})`;
  });
  stmts.push('CREATE UNIQUE INDEX idx_outbox_idempotency_key ON outbox (idempotency_key)');
  stmts.push('CREATE INDEX idx_cart_line_cart ON cart_line (cart_id)');
  stmts.push('CREATE INDEX idx_outbox_pending ON outbox (created_at)');
  return stmts;
}
