/**
 * What the device "downloaded": the rows the sync stream would have delivered
 * for one tenant, one location — in the shape the server's buckets carry them
 * (infra/powersync/sync_rules.yaml) and every one with a `tenant_id`, because a
 * synced row always has one and provisioning refuses rows without (data/session/
 * device-price-list.ts). Applied by src/e2e/download-seam.ts, which refuses any
 * local-only table: tills, carts, the outbox and receipt numbers are produced by
 * the real UI under test.
 *
 * Product data is neutral fixture vocabulary, deliberately sized to stress the
 * layout: long names, a fractional unit, more cards than fit one screen.
 * Money is decimal strings of `unit_price_e4` (minor units × 10^4), never a
 * float (ADR-0004). The currency is ISO 4217's TEST code, XTS, at scale 2.
 */
import identity from './identity.json' with { type: 'json' };

type Cell = string | number | null;
type Row = Record<string, Cell>;

export interface DownloadFixture {
  readonly tables: Readonly<Record<string, readonly Row[]>>;
}

const T = identity.tenantId;
const STAMP = '2026-11-01T00:00:00.000Z';

/** Deterministic fixture UUIDs: 0193…-<kind><n>. */
function fid(kind: number, n: number): string {
  return `01930000-0000-7000-8${String(kind).padStart(3, '0')}-${String(n).padStart(12, '0')}`;
}

interface ProductSpec {
  readonly sku: string;
  readonly name: string;
  readonly category: string;
  readonly uom: string;
  /** minor units per selling unit, as a decimal string. */
  readonly priceMinor: string;
}

const UOMS: Readonly<Record<string, { name: string; scale: number }>> = {
  BAG: { name: 'bag', scale: 0 },
  LEN: { name: 'length', scale: 0 },
  KG: { name: 'kg', scale: 3 },
  SHT: { name: 'sheet', scale: 0 },
  PC: { name: 'piece', scale: 0 },
  M: { name: 'metre', scale: 2 },
  TIN: { name: 'tin', scale: 0 },
};

const CATEGORIES = ['Binders', 'Steel', 'Roofing', 'Timber', 'Fixings', 'Finishes', 'Plumbing'];

/** Prices chosen so change and splits are easy to read in a failure trace. */
export const PRODUCTS: readonly ProductSpec[] = [
  { sku: 'BND-001', name: 'Binder grade A 50kg bag', category: 'Binders', uom: 'BAG', priceMinor: '8500' },
  { sku: 'BND-002', name: 'Binder grade B 50kg bag', category: 'Binders', uom: 'BAG', priceMinor: '7900' },
  { sku: 'BND-003', name: 'Tile adhesive, flexible, water-resistant, 20kg bag', category: 'Binders', uom: 'BAG', priceMinor: '12450' },
  { sku: 'STL-010', name: 'Ribbed bar 12mm x 12m length', category: 'Steel', uom: 'LEN', priceMinor: '18500' },
  { sku: 'STL-016', name: 'Ribbed bar 16mm x 12m length', category: 'Steel', uom: 'LEN', priceMinor: '31000' },
  { sku: 'STL-WIR', name: 'Annealed tie wire, sold by weight', category: 'Steel', uom: 'KG', priceMinor: '975' },
  { sku: 'STL-MSH', name: 'Welded reinforcement mesh A142, 2.4m x 4.8m sheet', category: 'Steel', uom: 'SHT', priceMinor: '64000' },
  { sku: 'RF-030', name: 'Corrugated roofing sheet 0.30mm', category: 'Roofing', uom: 'SHT', priceMinor: '4800' },
  { sku: 'RF-040', name: 'Long-span roofing sheet 0.40mm, pre-painted, cut to length', category: 'Roofing', uom: 'M', priceMinor: '6650' },
  { sku: 'RF-NAI', name: 'Roofing nails with washers', category: 'Roofing', uom: 'KG', priceMinor: '1450' },
  { sku: 'TMB-23', name: 'Sawn timber 2" x 3" x 12ft', category: 'Timber', uom: 'PC', priceMinor: '1500' },
  { sku: 'TMB-24', name: 'Sawn timber 2" x 4" x 12ft', category: 'Timber', uom: 'PC', priceMinor: '2100' },
  { sku: 'TMB-PLY', name: 'Marine plywood 18mm 8ft x 4ft board', category: 'Timber', uom: 'SHT', priceMinor: '39500' },
  { sku: 'FX-NL3', name: 'Wire nails 3 inch', category: 'Fixings', uom: 'KG', priceMinor: '1200' },
  { sku: 'FX-NL4', name: 'Wire nails 4 inch', category: 'Fixings', uom: 'KG', priceMinor: '1200' },
  { sku: 'FX-HNG', name: 'Butt hinge 4 inch, pair', category: 'Fixings', uom: 'PC', priceMinor: '650' },
  { sku: 'FN-EMW', name: 'Emulsion paint, white, 20 litre tin', category: 'Finishes', uom: 'TIN', priceMinor: '42000' },
  { sku: 'FN-GLS', name: 'Gloss paint, brilliant white, 4 litre tin', category: 'Finishes', uom: 'TIN', priceMinor: '15500' },
  { sku: 'PL-P50', name: 'PVC pressure pipe 50mm x 6m length', category: 'Plumbing', uom: 'LEN', priceMinor: '5600' },
  { sku: 'PL-ELB', name: 'PVC elbow 50mm', category: 'Plumbing', uom: 'PC', priceMinor: '350' },
  { sku: 'PL-TAP', name: 'Brass bib tap 1/2 inch with hose union', category: 'Plumbing', uom: 'PC', priceMinor: '4750' },
];

export function productIdOf(sku: string): string {
  const i = PRODUCTS.findIndex((p) => p.sku === sku);
  if (i < 0) throw new Error(`no fixture product ${sku}`);
  return fid(10, i + 1);
}

function base(): Row {
  return { tenant_id: T, hlc: null, updated_at: STAMP };
}

export function downloadFixture(): DownloadFixture {
  const uomIds = new Map(Object.keys(UOMS).map((code, i) => [code, fid(1, i + 1)]));
  const catIds = new Map(CATEGORIES.map((name, i) => [name, fid(2, i + 1)]));

  return {
    tables: {
      // jurisdiction_pack bucket: platform rows, keyed by code, no tenant_id.
      jurisdiction: [
        {
          id: 'XT',
          code: 'XT',
          name: 'Test jurisdiction',
          currency_code: 'XTS',
          currency_symbol: '¤',
          minor_units_per_major: 100,
          cash_rounding_unit_minor: 1,
        },
      ],
      location: [
        {
          ...base(),
          id: identity.locationId,
          code: 'OUT-01',
          name: 'Test outlet one',
          kind: 'OUTLET',
          location_type_id: null,
          parent_id: null,
          is_active: 1,
          timezone: 'UTC',
        },
        {
          ...base(),
          id: identity.otherLocationId,
          code: 'OUT-02',
          name: 'Test outlet two',
          kind: 'OUTLET',
          location_type_id: null,
          parent_id: null,
          is_active: 1,
          timezone: 'UTC',
        },
      ],
      price_list: [
        {
          ...base(),
          id: identity.priceListId,
          code: 'COUNTER',
          name: 'Counter prices',
          is_tax_inclusive: 1,
          currency_code: 'XTS',
          priority: 10,
          location_id: null,
          effective_from: '2020-01-01',
          effective_to: null,
        },
      ],
      unit_of_measure: Object.entries(UOMS).map(([code, u]) => ({
        ...base(),
        id: uomIds.get(code)!,
        code,
        name: u.name,
        dimension: null,
        qty_scale: u.scale,
      })),
      product_category: CATEGORIES.map((name) => ({
        ...base(),
        id: catIds.get(name)!,
        code: name.toUpperCase(),
        name,
        parent_id: null,
      })),
      product: PRODUCTS.map((p) => ({
        ...base(),
        id: productIdOf(p.sku),
        sku_code: p.sku,
        name: p.name,
        aliases: null,
        category_id: catIds.get(p.category)!,
        stocking_uom_id: uomIds.get(p.uom)!,
        tax_code: null,
        stock_tracking: 'STOCKED',
        is_sellable: 1,
        is_purchasable: 1,
      })),
      product_uom: PRODUCTS.map((p, i) => ({
        ...base(),
        id: fid(11, i + 1),
        product_id: productIdOf(p.sku),
        uom_id: uomIds.get(p.uom)!,
        factor_num: 1,
        factor_den: 1,
        can_sell: 1,
        can_buy: 1,
        is_default_sell: 1,
        tolerance_bp: 0,
        sort_order: 0,
      })),
      price_list_item: PRODUCTS.map((p, i) => ({
        ...base(),
        id: fid(12, i + 1),
        price_list_id: identity.priceListId,
        product_id: productIdOf(p.sku),
        uom_id: uomIds.get(p.uom)!,
        unit_price_e4: `${p.priceMinor}0000`,
        min_qty: 0,
        effective_from: '2020-01-01',
        effective_to: null,
      })),
      stock_snapshot: PRODUCTS.map((p, i) => ({
        id: fid(13, i + 1),
        product_id: productIdOf(p.sku),
        location_id: identity.locationId,
        qty_scaled: `${100 * 10 ** UOMS[p.uom]!.scale}`,
        as_of: STAMP,
      })),
      tender_method: [
        ['Cash', 'TILL_CASH', 1, 0, 0, 10],
        ['Mobile money', 'MOMO_WALLET', 0, 0, 1, 20],
        ['Bank transfer', 'BANK_TRANSFER', 0, 0, 1, 30],
        ['On account', 'AR_TRADE', 0, 1, 0, 50],
      ].map(([name, role, isCash, onAccount, needsRef, order], i) => ({
        ...base(),
        id: fid(14, i + 1),
        code: String(name).toUpperCase().replace(/\s+/g, '-'),
        name: String(name),
        posting_role: String(role),
        is_cash: Number(isCash),
        is_on_account: Number(onAccount),
        requires_reference: Number(needsRef),
        is_active: 1,
        sort_order: Number(order),
      })),
    },
  };
}
