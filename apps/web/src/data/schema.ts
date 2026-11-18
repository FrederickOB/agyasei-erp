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
    // ONE SHAPE — the catalogue exactly as the server models it.
    //
    // This table used to carry a SECOND, parallel shape (code / category /
    // uom_label / qty_scale / active) that only the dev seed ever populated,
    // with the counter's projection reading those columns and the synced
    // columns sitting beside them unused. The device therefore showed the
    // seed's five demo products and NONE of the tenant's 219, in the one mode
    // where the tenant's catalogue was actually present. A second shape is
    // also how the freeze in data/seed.ts happened: the seed had to write a
    // synced table to populate it.
    //
    // So the projection now reads the real thing — product ⋈ product_uom ⋈
    // unit_of_measure ⋈ price_list_item (data/queries/products.ts) — and the
    // dev seed writes THAT shape into the same tables, in local-only mode
    // only. `aliases` stays: it is tenant-edited local search vocabulary
    // (§8.7) with no server column yet, so it reads NULL on synced rows and
    // the matcher already handles null.
    name: 'product',
    localOnly: false,
    columns: [
      t('tenant_id'),
      t('sku_code'),
      t('name'),
      t('aliases'), // tenant-edited local names — first-class search data (§8.7)
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
  // -- bucket: tenant_credit (holders of `credit.view`, gated in the DATABASE) --
  //
  // THE CREDIT BOOK, BOUNDED — and every money figure on it is SYNCED AND
  // AUTHORITATIVE. Nothing on this device sums `credit_entry` into a balance
  // or sorts it into an ageing band, and that is arithmetic rather than taste:
  // the entry log here is WINDOWED, so Σ(local entries) ≠ balance by
  // construction, and the gap grows with the age of the account. A device that
  // summed its own log would produce a confidently wrong number at exactly the
  // moment nobody can check it (docs/credit-offline-plan.md R2).
  //
  // `credit_position_snapshot` is what makes the window safe: it carries the
  // balance AND `opening_before_window_minor`, so
  //   opening_before_window_minor + Σ(local live entries) = balance_minor
  // holds exactly, in bigint, no matter how much has archived out.
  {
    // NAMED FOR THE SERVER TABLE, NOT FOR THE CONCEPT. PowerSync derives a
    // client table's name from the source table in the bucket's data query
    // (`FROM "app"."customer_account"`), so a client table called
    // `credit_account` receives NOTHING: the rows arrive with type
    // `customer_account`, find no declared table, and land in `ps_untyped`
    // where no query in this app can see them. That is exactly what happened
    // — 0 rows here, 80 in `ps_untyped` — and it made the entire offline
    // credit position silently unavailable while 16 unit tests passed, because
    // the node test adapter builds its DDL from THIS list and the tests seeded
    // the wrong name too. `packages/wire-conformance/test/sync-rules-to-device.test.ts`
    // now fails if a synced table here is not a table the rules can deliver.
    name: 'customer_account',
    localOnly: false,
    columns: [
      t('tenant_id'),
      t('customer_id'),
      i('credit_limit_minor'),
      i('terms_days'),
      i('facility_fee_bp_per_month'),
      t('status'),
      t('hlc'),
      t('created_at'),
      t('updated_at'),
    ],
  },
  {
    name: 'credit_limit_version',
    localOnly: false,
    columns: [
      t('tenant_id'),
      t('credit_account_id'),
      i('limit_minor'),
      i('terms_days'),
      i('fee_rate_bp'),
      t('reason_code'),
      t('note'),
      t('supersedes_id'),
      t('state'),
      t('decided_by'),
      t('decided_at_location'),
      t('effective_from'),
      t('hlc'),
      t('created_at'),
      t('updated_at'),
    ],
  },
  {
    // Statement lines. DISPLAY ONLY — listed, never totalled (R2).
    name: 'credit_entry',
    localOnly: false,
    columns: [
      t('tenant_id'),
      t('account_id'),
      t('kind'),
      i('amount_minor'), // SIGNED — CAST AS TEXT on read
      t('business_date'),
      t('due_date'),
      t('source_kind'),
      t('source_id'),
      t('applies_to_id'),
      t('hlc'),
      t('created_at'),
    ],
  },
  {
    name: 'credit_position_snapshot',
    localOnly: false,
    columns: [
      t('tenant_id'),
      t('account_id'),
      t('customer_id'),
      t('status'),
      i('terms_days'),
      i('credit_limit_minor'),
      t('limit_version_id'),
      i('balance_minor'),
      i('trade_exposure_minor'),
      i('available_minor'),
      i('on_account_credit_minor'),
      i('fee_outstanding_minor'),
      i('opening_before_window_minor'),
      t('aged_by'),
      t('fee_confirmed_at'),
      i('entry_window_days'),
      t('as_of'),
      // The server HLC this position was evaluated through. The till's causal
      // `local_deduction` compares its own server-stamped `ack_hlc` against
      // THIS — two server clocks, never a device clock against a server one.
      t('as_of_hlc'),
      t('computed_at'),
    ],
  },
  {
    // The ageing vector, rendered SERVER-SIDE against the tenant's own bands.
    // The band edges are policy and policy is not on this device, so there is
    // no way to recompute this here even if somebody wanted to.
    name: 'credit_position_bucket',
    localOnly: false,
    columns: [
      t('tenant_id'),
      t('account_id'),
      i('seq'),
      t('label'),
      i('from_dpd'),
      i('to_dpd'),
      i('amount_minor'),
      t('as_of'),
      t('as_of_hlc'),
    ],
  },
  // -- bucket: location_credit_allowance (holders of `sale.record.credit`) --
  // What THIS outlet may lend TODAY, and a hold flag. No limit, no balance, no
  // ageing, no entry, no history — a stolen counter tablet discloses this
  // outlet's lending room for the customers who trade here and nothing else
  // (06 §6.5). Empty until §6.7's cap leases exist.
  {
    name: 'credit_allowance',
    localOnly: false,
    columns: [
      t('tenant_id'),
      t('location_id'),
      t('customer_id'),
      i('cap_minor'),
      i('headroom_minor'),
      i('offline_ceiling_minor'),
      i('credit_hold'),
      t('cap_valid_until'),
      t('cap_version_id'),
      t('snapshot_as_of'),
      t('snapshot_as_of_hlc'),
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
      // The device-allocated human-facing number this sale was rung under
      // (03 §3.7.5). Denormalised out of `payload` because the receipt screen,
      // the recent-sales list and a reprint all need it without parsing JSON.
      t('receipt_no'),
      // Cash tender is DEVICE-LOCAL state, deliberately not on the wire: the
      // sale contract has nowhere to put it server-side until app.cash_session
      // and app.sale_tender land (see the design note in
      // packages/contracts/src/sale.ts), and a field the server silently drops
      // is worse than one it refuses. Cash-up reads these columns.
      i('tendered_minor'), // CAST AS TEXT on read
      i('change_minor'), // CAST AS TEXT on read
      t('created_at'),
      // THE QUEUE POSITION, and the only key the drain orders on. `created_at`
      // is millisecond-resolution and `id` is a uuidv7 with no intra-ms
      // counter, so the pair ties and then breaks the tie at random; this is a
      // strictly increasing enqueue-time integer, so the order is total,
      // deterministic and the order the ops were actually queued in. A COUNT,
      // never a magnitude — see `data/sync/queue-seq.ts` for the whole
      // argument, including why a monotonic uuidv7 would not have fixed it.
      i('queue_seq'),
      t('server_ack_at'), // NULL until the server acks; drives the §8.5 badge
      // DEAD-LETTERED, and why. Set only for a DEFINITIVE rejection: the op
      // leaves the queue for the visible "Needs checking" state and is never
      // retried again.
      t('rejected_at'),
      t('reject_reason'),
      // REFUSED BUT STILL QUEUED, and why. The retryable case (§3.3.4) — the
      // row stays pending and keeps retrying, exactly as before; these two
      // columns only stop the server's sentence from being thrown away.
      // Without them a write refused every 30 seconds for hours is completely
      // mute: the §8.4 stuck state says a queue is not draining and nothing,
      // anywhere, can say what the server actually objected to.
      t('last_refusal_reason'),
      t('last_refusal_at'),
    ],
  },
  {
    // Receipt print queue — one row per sale, LOCAL-ONLY (§8.8, §8.11).
    //
    // WHAT IT HOLDS. The rendered ESC/POS bytes of a print that has not
    // succeeded yet (`bytes_b64`, dropped the moment it is sent), and the
    // receipt SNAPSHOT (`doc_json`) the retry and any reprint render from.
    // The snapshot exists because a sale rung offline has no `sale_line` rows
    // on the device until the server has priced it and the rows stream back;
    // the cart that held the names is deleted at checkout. Without it a
    // reprint of an unsynced sale would have nothing to print.
    //
    // WHAT IT IS NOT. It is never the sale. Nothing reads it to decide what
    // was sold, nothing writes to the outbox from it, and a failed print only
    // ever touches this table. Rows are discarded at `expires_at` (7 days).
    //
    // DROPPABLE (§8.11): losing it loses a retry and a convenience reprint,
    // never a sale. A reprint after expiry renders from synced rows instead.
    name: 'local_print_queue',
    localOnly: true,
    columns: [
      t('sale_id'),
      t('receipt_no'),
      t('doc_json'), // the ReceiptDocument snapshot; bigint tagged, see printing/document.ts
      t('bytes_b64'), // rendered bytes of the outstanding print; NULL once sent
      i('paper_width_mm'),
      t('state'), // 'pending' (a print is outstanding) | 'sent'
      i('is_copy'), // 1 once this request is a reprint
      i('attempts'),
      t('last_outcome'),
      t('last_evidence'),
      t('last_detail'),
      t('last_transport'),
      t('last_attempt_at'),
      t('requested_at'), // when the CURRENT request (first print or reprint) was made
      t('created_at'),
      t('expires_at'),
    ],
  },
  {
    // Device-allocated human-facing sequence numbers (03 §3.7.5). LOCAL-ONLY
    // and consumed with ZERO connectivity — a block is drawn down inside the
    // same local transaction that writes the sale, so a rolled-back checkout
    // burns no number and a committed one can never re-issue it.
    //
    // `source` is the whole safety argument. A 'server' block is one the
    // server allocated under a row lock on a per-(tenant, location,
    // sequence_key) counter: ranges are disjoint by construction, so the
    // printed number needs no device tag. A 'device' block is one this device
    // self-issued because no server-allocated block was on hand — its range
    // overlaps every other device's, so disjointness has to come from the
    // identifier itself and the formatter appends the device tag. Both are
    // "per-device blocks, monotonic within a device, gaps expected", which is
    // exactly what §3.7.5 chooses; only the source of disjointness differs.
    // LOCAL-ONLY, and that is the second half of the safety argument: a
    // counter is never synced DOWN to a device (04 §4.7 deleted
    // `document_number_range` for exactly that defect), so `consumed_upto` is
    // device state that is REPORTED and compared server-side, never
    // authoritative here.
    //
    // This table is also precisely what a wipe destroys. Evict OPFS, or
    // reinstall the PWA on the same enrolled device, and the row goes with it
    // while the server still shows the block live — which is how the
    // regression is detected (`data/sequence.ts` buildBlockReport, and
    // `sequence.syncBlock` on the server).
    name: 'sequence_block',
    localOnly: true,
    columns: [
      t('sequence_key'), // 'RECEIPT' | 'INVOICE' | … — pack + tenant data, not an enum
      t('location_id'),
      t('device_node'), // this device's 32-hex HLC node id
      t('source'), // 'server' | 'device'
      i('block_start'), // CAST AS TEXT on read — a counter, same discipline
      i('block_size'),
      i('consumed_upto'), // NULL until the first number is drawn
      // The tenant's rendering configuration, as the SERVER handed it down with
      // the block (app.sequence_counter.number_format / .number_prefix, and the
      // location's own code). NULL on a self-issued block, which has none.
      //
      // It lives on the BLOCK rather than in device configuration so a block
      // and the format its numbers were printed under cannot drift apart: a
      // reprint of yesterday's receipt must render what the customer is holding.
      t('number_format'),
      t('number_prefix'),
      t('location_code'),
      t('issued_at'),
      t('exhausted_at'), // set when the last number in the block is consumed
      // The cursor value this device last TOLD the server about, stamped when
      // the reconnect report is queued. Not the same thing as consumed_upto:
      // the gap between the two is the window a wipe would hide.
      t('reported_at'),
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
  stmts.push('CREATE UNIQUE INDEX idx_print_queue_sale ON local_print_queue (sale_id)');
  stmts.push('CREATE INDEX idx_outbox_pending ON outbox (created_at)');
  // The drain's own key. Unique because two ops may never share a queue
  // position — a duplicate would put the order back where it was.
  stmts.push('CREATE UNIQUE INDEX idx_outbox_queue_seq ON outbox (queue_seq)');
  // One live block per (sequence_key, location) on this device: the partial
  // index makes "two open blocks for the same counter" unrepresentable rather
  // than merely unlikely, so a number can never be drawn from a stale block.
  stmts.push(
    `CREATE UNIQUE INDEX idx_sequence_block_open
       ON sequence_block (sequence_key, location_id)
     WHERE exhausted_at IS NULL`,
  );
  stmts.push(
    'CREATE INDEX idx_sequence_block_range ON sequence_block (sequence_key, location_id, block_start)',
  );
  // The credit read path is always "one account", so every credit table is
  // keyed by it. The snapshot is one row per account and the bucket vector is
  // read in `seq` order, which is the order the server rendered the bands in.
  stmts.push('CREATE INDEX idx_credit_entry_account ON credit_entry (account_id, business_date)');
  stmts.push(
    'CREATE UNIQUE INDEX idx_credit_position_snapshot_account ON credit_position_snapshot (account_id)',
  );
  stmts.push(
    'CREATE UNIQUE INDEX idx_credit_position_bucket_account ON credit_position_bucket (account_id, seq)',
  );
  stmts.push('CREATE INDEX idx_customer_account_customer ON customer_account (customer_id)');
  stmts.push(
    'CREATE UNIQUE INDEX idx_credit_allowance_scope ON credit_allowance (location_id, customer_id)',
  );
  return stmts;
}
