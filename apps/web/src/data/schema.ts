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
    // DUAL SHAPE (interim): the projection columns below (code/aliases/
    // uom_label/qty_scale/active) are the POS read contract, populated by the
    // dev seed in local-only mode. The `tenant_reference` bucket
    // (infra/powersync/sync_rules.yaml) streams `app.product` rows into this
    // same table, hydrating the SERVER columns (sku_code, category_id, …).
    // Re-pointing the POS read layer at the raw catalogue shape (joins over
    // product_uom / unit_of_measure / price_list_item) is the follow-on
    // integration; until then synced rows are queryable but the counter's
    // projection reads still come from the seeded columns.
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
      // ---- server catalogue columns (hydrated by the sync stream) ----
      t('tenant_id'),
      t('sku_code'),
      t('category_id'),
      t('stocking_uom_id'),
      t('tax_code'),
      t('stock_tracking'),
      i('is_sellable'),
      i('is_purchasable'),
      t('hlc'),
      t('updated_at'),
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
  // ---- synced mirrors of the sync_rules.yaml buckets -----------------------
  // One table per row type the service streams (infra/powersync/
  // sync_rules.yaml): tenant_reference, jurisdiction_pack, tenant_customers,
  // location_ops and tenant_sale_lines_interim. Columns mirror the bucket
  // SELECTs (minus `id`, which PowerSync supplies, and server plumbing like
  // write_id). These tables are READ-ONLY on the device — writes go through
  // the outbox, never here. Money/qty/rate columns are INTEGER and MUST be
  // read as CAST(col AS TEXT) → BigInt(), like every money column (§8.3).
  //
  // -- bucket: tenant_reference --
  {
    name: 'location',
    localOnly: false,
    columns: [
      t('tenant_id'),
      t('code'),
      t('name'),
      t('kind'), // OUTLET | WAREHOUSE | GROUP | TRANSIT
      t('location_type_id'),
      t('parent_id'),
      i('is_active'),
      t('timezone'),
      t('hlc'),
      t('updated_at'),
    ],
  },
  {
    name: 'location_type',
    localOnly: false,
    columns: [t('tenant_id'), t('code'), t('name'), t('hlc'), t('updated_at')],
  },
  {
    name: 'unit_of_measure',
    localOnly: false,
    columns: [
      t('tenant_id'),
      t('code'),
      t('name'),
      t('dimension'),
      i('qty_scale'), // digit count, not a magnitude
      t('hlc'),
      t('updated_at'),
    ],
  },
  {
    name: 'product_category',
    localOnly: false,
    columns: [t('tenant_id'), t('code'), t('name'), t('parent_id'), t('hlc'), t('updated_at')],
  },
  {
    name: 'product_uom',
    localOnly: false,
    columns: [
      t('tenant_id'),
      t('product_id'),
      t('uom_id'),
      i('factor_num'), // rational conversion snapshot — CAST AS TEXT on read
      i('factor_den'), // CAST AS TEXT on read
      i('can_sell'),
      i('can_buy'),
      i('is_default_sell'),
      i('tolerance_bp'), // integer basis points
      i('sort_order'),
      t('hlc'),
      t('updated_at'),
    ],
  },
  {
    name: 'price_list',
    localOnly: false,
    columns: [
      t('tenant_id'),
      t('code'),
      t('name'),
      i('is_tax_inclusive'),
      t('currency_code'),
      i('priority'),
      t('location_id'),
      t('effective_from'),
      t('effective_to'),
      t('hlc'),
      t('updated_at'),
    ],
  },
  {
    name: 'price_list_item',
    localOnly: false,
    columns: [
      t('tenant_id'),
      t('price_list_id'),
      t('product_id'),
      t('uom_id'),
      i('unit_price_e4'), // minor units per selling unit × 10^4 — CAST AS TEXT on read
      i('min_qty'), // scaled integer — CAST AS TEXT on read
      t('effective_from'),
      t('effective_to'),
      t('hlc'),
      t('updated_at'),
    ],
  },
  {
    name: 'movement_reason',
    localOnly: false,
    columns: [t('tenant_id'), t('code'), t('name'), t('hlc'), t('updated_at')],
  },
  // -- bucket: jurisdiction_pack (platform rows; id = code / composite) --
  {
    name: 'jurisdiction',
    localOnly: false,
    columns: [
      t('code'),
      t('name'),
      t('currency_code'),
      t('currency_symbol'),
      i('minor_units_per_major'), // the pack's scale — NEVER assume 100
      i('cash_rounding_unit_minor'),
    ],
  },
  {
    name: 'tax_code',
    localOnly: false,
    columns: [t('jurisdiction_code'), t('code'), t('name'), i('input_deductible')],
  },
  {
    name: 'tax_rate',
    localOnly: false,
    columns: [
      t('jurisdiction_code'),
      t('tax_code'),
      i('rate_bp'), // integer basis points
      t('base_kind'),
      t('base_includes'),
      t('rounding_level'),
      t('rounding_mode'),
      t('effective'), // effective-dated range, serialized
      t('legal_reference'),
      t('confirmed_by'),
      t('confirmed_at'),
    ],
  },
  // -- bucket: tenant_customers (identity ONLY — no balances, no limits) --
  {
    name: 'customer',
    localOnly: false,
    columns: [
      t('tenant_id'),
      t('code'),
      t('name'),
      t('phone'),
      i('is_credit_customer'),
      t('hlc'),
      t('updated_at'),
    ],
  },
  // -- bucket: location_ops --
  {
    name: 'stock_movement',
    localOnly: false,
    columns: [
      t('tenant_id'),
      t('location_id'),
      t('product_id'),
      i('qty_delta'), // SIGNED scaled integer — CAST AS TEXT on read
      i('qty_scale'),
      t('uom_id'),
      t('reason_id'),
      t('source_kind'),
      t('source_id'),
      i('unit_cost_e4'), // CAST AS TEXT on read
      t('occurred_at'),
      t('business_date'),
      t('reverses_id'),
      t('archived_at'),
      t('hlc'),
      t('created_at'),
      t('updated_at'),
    ],
  },
  {
    name: 'sale',
    localOnly: false,
    columns: [
      t('tenant_id'),
      t('location_id'),
      t('customer_id'),
      t('price_list_id'),
      t('receipt_no'),
      t('business_date'),
      t('occurred_at'),
      t('voids_sale_id'),
      t('currency_code'),
      i('money_scale'), // snapshot of minor_units_per_major — CAST AS TEXT on read
      i('subtotal_net_minor'), // CAST AS TEXT on read
      i('discount_minor'), // CAST AS TEXT on read
      i('tax_total_minor'), // CAST AS TEXT on read
      i('total_minor'), // CAST AS TEXT on read
      t('hlc'),
      t('created_at'),
      t('updated_at'),
    ],
  },
  // -- bucket: tenant_sale_lines_interim (moves into location_ops when the
  //    §3.11.10 denormalisation migration lands) --
  {
    name: 'sale_line',
    localOnly: false,
    columns: [
      t('tenant_id'),
      t('sale_id'),
      i('line_no'),
      t('product_id'),
      t('selling_uom_id'),
      i('qty_sell'), // CAST AS TEXT on read
      i('qty_sell_scale'),
      i('unit_price_e4'), // CAST AS TEXT on read
      t('stocking_uom_id'),
      i('qty_stock'), // CAST AS TEXT on read
      i('qty_stock_scale'),
      i('factor_num'), // CAST AS TEXT on read
      i('factor_den'), // CAST AS TEXT on read
      i('line_discount_minor'), // CAST AS TEXT on read
      i('line_net_minor'), // CAST AS TEXT on read
      t('tax_code'),
      i('tax_minor'), // CAST AS TEXT on read
      t('hlc'),
      t('created_at'),
      t('updated_at'),
    ],
  },
  {
    name: 'sale_tax_line',
    localOnly: false,
    columns: [
      t('tenant_id'),
      t('sale_id'),
      t('sale_line_id'),
      i('seq'),
      t('tax_code'),
      i('rate_bp'), // integer basis points
      t('base_kind'),
      t('base_includes'),
      t('rounding_level'),
      t('rounding_mode'),
      i('base_minor'), // CAST AS TEXT on read
      i('tax_minor'), // CAST AS TEXT on read
      t('tax_rate_id'),
      t('hlc'),
      t('created_at'),
      t('updated_at'),
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
