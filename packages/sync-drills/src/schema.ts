/**
 * The device-side PowerSync schema for the drills.
 *
 * Synced tables mirror EXACTLY what infra/powersync/sync_rules.yaml can
 * deliver (client table name = source table name, columns from the rules'
 * SELECTs). `id` is implicit — never declared. Synced-shape tables are
 * READ-ONLY on the device: every write goes through the local-only outbox
 * and then the API's /sync/upload → app.write_log pipeline. The PowerSync
 * service is download-only (03-offline-sync §3.3).
 */
import { column, Schema, Table } from '@powersync/node';

const t = column.text;
const i = column.integer;

/** app.* tenant-owned tables (SELECT * in the rules → full column set). */
export const SYNCED_TABLES: Record<string, Table> = {
  location: new Table({
    tenant_id: t, write_id: t, hlc: t, created_at: t, updated_at: t, deleted_at: t,
    code: t, name: t, kind: t, location_type_id: t, parent_id: t, is_active: i,
    timezone: t, origin_template_id: t, origin_ref: t,
  }),
  location_type: new Table({ tenant_id: t, code: t, name: t, deleted_at: t }),
  unit_of_measure: new Table({ tenant_id: t, code: t, name: t, qty_scale: i, deleted_at: t }),
  product_category: new Table({ tenant_id: t, code: t, name: t, deleted_at: t }),
  product: new Table({
    tenant_id: t, write_id: t, hlc: t, created_at: t, updated_at: t, deleted_at: t,
    sku_code: t, name: t, category_id: t, stocking_uom_id: t, tax_code: t,
    stock_tracking: t, is_sellable: i, is_purchasable: i, notes: t,
    origin_template_id: t, origin_ref: t,
  }),
  product_uom: new Table({
    tenant_id: t, product_id: t, uom_id: t, is_default_sell: i, factor_num: t,
    factor_den: t, deleted_at: t,
  }),
  price_list: new Table({
    tenant_id: t, code: t, name: t, is_tax_inclusive: i, effective_from: t,
    effective_to: t, deleted_at: t,
  }),
  price_list_item: new Table({
    tenant_id: t, price_list_id: t, product_id: t, uom_id: t, unit_price_e4: t,
    min_qty: t, effective_from: t, effective_to: t, deleted_at: t,
  }),
  movement_reason: new Table({ tenant_id: t, code: t, name: t, deleted_at: t }),
  customer: new Table({
    tenant_id: t, code: t, name: t, phone: t, is_credit_customer: i, hlc: t, updated_at: t,
  }),
  stock_movement: new Table({
    tenant_id: t, write_id: t, hlc: t, created_at: t, updated_at: t, deleted_at: t,
    location_id: t, product_id: t, qty_delta: t, qty_scale: i, uom_id: t,
    reason_id: t, source_kind: t, source_id: t, unit_cost_e4: t, occurred_at: t,
    business_date: t, reverses_id: t, archived_at: t,
  }),
  sale: new Table({
    tenant_id: t, write_id: t, hlc: t, created_at: t, updated_at: t, deleted_at: t,
    location_id: t, customer_id: t, price_list_id: t, receipt_no: t,
    business_date: t, occurred_at: t, voids_sale_id: t, currency_code: t,
    money_scale: i, subtotal_net_minor: t, discount_minor: t, tax_total_minor: t,
    total_minor: t,
  }),
  sale_line: new Table({
    tenant_id: t, sale_id: t, line_no: i, product_id: t, selling_uom_id: t,
    qty_sell: t, qty_sell_scale: i, unit_price_e4: t, stocking_uom_id: t,
    qty_stock: t, qty_stock_scale: i, factor_num: t, factor_den: t,
    line_discount_minor: t, line_net_minor: t, tax_code: t, tax_minor: t,
    deleted_at: t,
  }),
  sale_tax_line: new Table({
    tenant_id: t, sale_id: t, sale_line_id: t, seq: i, tax_code: t, rate_bp: t,
    base_kind: t, base_includes: t, rounding_level: t, rounding_mode: t,
    base_minor: t, tax_minor: t, tax_rate_id: t, deleted_at: t,
  }),
  // ---- The credit slices (sync_rules.yaml tenant_credit / -------------------
  // location_credit_allowance, added by migration 0013). Column lists here
  // mirror the rules' explicit SELECTs EXACTLY: a column the rules do not
  // ship must not be declarable on a device, and a column they do ship that
  // is missing here would be silently dropped into ps_untyped — which is why
  // D5 counts the physical tables rather than the schema's.
  //
  // Every money column is TEXT. `column.integer` is a float64 in the client
  // SDK and a bigint pesewa balance would silently round (CLAUDE.md §2.3).
  customer_account: new Table({
    tenant_id: t, customer_id: t, credit_limit_minor: t, terms_days: i,
    facility_fee_bp_per_month: i, status: t, hlc: t, created_at: t, updated_at: t,
  }),
  credit_limit_version: new Table({
    tenant_id: t, credit_account_id: t, limit_minor: t, terms_days: i,
    fee_rate_bp: i, reason_code: t, note: t, supersedes_id: t, state: t,
    decided_by: t, decided_at_location: t, effective_from: t, hlc: t,
    created_at: t, updated_at: t,
  }),
  credit_entry: new Table({
    tenant_id: t, account_id: t, kind: t, amount_minor: t, business_date: t,
    due_date: t, source_kind: t, source_id: t, applies_to_id: t, hlc: t, created_at: t,
  }),
  credit_position_snapshot: new Table({
    tenant_id: t, account_id: t, customer_id: t, status: t, terms_days: i,
    credit_limit_minor: t, limit_version_id: t, balance_minor: t,
    trade_exposure_minor: t, available_minor: t, on_account_credit_minor: t,
    fee_outstanding_minor: t, opening_before_window_minor: t, aged_by: t,
    fee_confirmed_at: t, entry_window_days: i, as_of: t, as_of_hlc: t, computed_at: t,
  }),
  credit_position_bucket: new Table({
    tenant_id: t, account_id: t, seq: i, label: t, from_dpd: i, to_dpd: i,
    amount_minor: t, as_of: t, as_of_hlc: t,
  }),
  credit_allowance: new Table({
    tenant_id: t, location_id: t, customer_id: t, cap_minor: t,
    headroom_minor: t, offline_ceiling_minor: t, credit_hold: i,
    cap_valid_until: t, cap_version_id: t, snapshot_as_of: t, snapshot_as_of_hlc: t,
  }),
  // platform.* jurisdiction pack (explicit column lists in the rules).
  jurisdiction: new Table({
    code: t, name: t, currency_code: t, currency_symbol: t,
    minor_units_per_major: t, cash_rounding_unit_minor: t,
  }),
  tax_code: new Table({ jurisdiction_code: t, code: t, name: t, input_deductible: i }),
  tax_rate: new Table({
    jurisdiction_code: t, tax_code: t, rate_bp: t, base_kind: t, base_includes: t,
    rounding_level: t, rounding_mode: t, effective: t, legal_reference: t,
    confirmed_by: t, confirmed_at: t,
  }),
};

/** Client table names the sync rules can populate (D5 iterates these). */
export const SYNCED_TABLE_NAMES = Object.keys(SYNCED_TABLES);

export function buildDrillSchema(): Schema {
  return new Schema({
    ...SYNCED_TABLES,
    // The device outbox — LOCAL ONLY, never synced. Each row is one op for
    // POST /sync/upload, carrying its device-minted UUIDv7 idempotency key
    // and untrusted claimed_hlc (CLAUDE.md §2.2).
    outbox: new Table(
      {
        idempotency_key: t,
        kind: t,
        payload: t, // JSON
        claimed_hlc: t,
        client_wall_at: t,
        created_at: t,
        status: t, // 'pending' | 'acked'
      },
      { localOnly: true },
    ),
    // The device's CURRENT receipt-number block — LOCAL ONLY (03 §3.7.5).
    // This is exactly what OPFS eviction destroys, which is what D6 wipes.
    sequence_block: new Table(
      {
        sequence_key: t,
        location_id: t,
        block_start: t, // decimal string — a number, never a float64
        block_size: i,
        consumed_upto: t,
        number_format: t,
        number_prefix: t,
        location_code: t,
      },
      { localOnly: true },
    ),
  });
}
