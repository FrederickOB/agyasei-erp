/**
 * The "Construction materials distribution — Ghana" starter template
 * (ADR-0006), and its applier.
 *
 * TEMPLATES ARE SEED DATA, NOT RUNTIME COUPLING (01-tenancy §1.6):
 * applyTemplate() inserts ORDINARY, EDITABLE rows once; after that the
 * tenant owns them and the template has no further authority. There is no
 * live inheritance, no "reset to template", and the applier NEVER UPDATES —
 * re-running it after a tenant has edited a seeded row changes nothing.
 *
 * Idempotency is structural, not procedural: every seeded row's id is
 * DETERMINISTIC in (tenant, template, ref), so a re-run is
 * INSERT ... ON CONFLICT (tenant_id, id) DO NOTHING. Rows also carry
 * origin_template_id / origin_ref provenance for template-defect advisories;
 * NO business logic may ever read origin_ref (CLAUDE.md §2.9).
 *
 * What this template deliberately does NOT contain (01 §1.6): locations
 * (onboarding input — see applyTenant1Locations below), prices, users,
 * opening balances, money amounts, or tax RATES (those are the jurisdiction
 * pack's; the template only references tax CODES the pack defines).
 */
import { createHlcClock, hlcNodeFromName } from '../hlc.js';
import { deterministicUuid, sha256Hex } from '../ids.js';
import type { Queryable } from '../testing/harness.js';
import { parseOutlets } from './outlets.js';
import { parseSkus, TEMPLATE_UOMS, type CatalogueLine } from './skus.js';

export const TEMPLATE_ID = 'construction-materials-gh';
export const TEMPLATE_VERSION = 1;
export const TEMPLATE_JURISDICTION = 'GH';

const hlcClock = createHlcClock(hlcNodeFromName('erp-template-applier'));

/** Deterministic row id: same (tenant, template, ref) → same id, always. */
function rowId(tenantId: string, ref: string): string {
  return deterministicUuid(tenantId, TEMPLATE_ID, ref);
}

function slug(text: string): string {
  return text
    .toUpperCase()
    .replace(/&/g, 'AND')
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function batchInsert(
  tx: Queryable,
  table: string,
  columns: string[],
  rows: unknown[][],
  chunkSize = 40,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const params: unknown[] = [];
    const tuples = chunk
      .map((row) => {
        if (row.length !== columns.length) {
          throw new Error(`batchInsert ${table}: row arity ${row.length} != ${columns.length}`);
        }
        const ph = row.map((v) => {
          params.push(v);
          return `$${params.length}`;
        });
        return `(${ph.join(', ')})`;
      })
      .join(', ');
    await tx.query(
      `insert into ${table} (${columns.join(', ')}) values ${tuples}
       on conflict (tenant_id, id) do nothing`,
      params,
    );
  }
}

/** One SERVER-origin write_log row per template module (04 §4.2.2/§4.17.3):
 *  deterministic id from (op, natural key) so a re-run is a no-op. */
async function moduleWrite(tx: Queryable, tenantId: string, module: string): Promise<string> {
  const writeId = deterministicUuid(tenantId, TEMPLATE_ID, 'write', module);
  const op = `template.apply:${module}`;
  await tx.query(
    `insert into app.write_log
       (tenant_id, id, origin, hlc, claimed_hlc, device_id, user_id, location_id,
        op, schema_version, request_hash, response_body)
     values ($1, $2, 'SERVER', $3, null, null, null, null, $4, 1, decode($5, 'hex'), null)
     on conflict (tenant_id, id) do nothing`,
    [tenantId, writeId, hlcClock.next(), op, sha256Hex(`${TEMPLATE_ID}@${TEMPLATE_VERSION}:${module}`)],
  );
  return writeId;
}

const MOVEMENT_REASONS: { code: string; name: string }[] = [
  { code: 'OPENING', name: 'Opening balance' },
  { code: 'DAMAGE', name: 'Damaged goods' },
  { code: 'THEFT', name: 'Theft / shrinkage' },
  { code: 'SAMPLE', name: 'Customer sample' },
  { code: 'COUNT_VARIANCE', name: 'Stock count variance' },
  { code: 'PROMOTION', name: 'Promotional use' },
  { code: 'EXPIRY', name: 'Expired stock' },
  { code: 'BREAKAGE', name: 'Breakage in handling' },
  { code: 'TRANSFER', name: 'Inter-location transfer' },
  { code: 'CORRECTION', name: 'Ledger correction' },
];

export interface ApplyTemplateResult {
  templateId: string;
  templateVersion: number;
  /** SKUs whose second selling unit or split needs the founder (§4.16). */
  founderPending: { skuNo: number; reason: string }[];
}

/**
 * Apply the template for one tenant. Run INSIDE the tenant's own context —
 * `db.withTenant(tenantId, (tx) => applyTemplate(tx, tenantId))` — so the
 * application runs as app_user under RLS, exactly like the export job
 * (01 §1.7: the sensitive paths are the MOST constrained, not the least).
 *
 * Requires: seedGhanaJurisdiction() (the product rows reference GH tax
 * codes) and a platform.tenant row whose jurisdiction is GH — the applier
 * refuses a mismatched tenant (01 §1.6 manifest rule).
 */
export async function applyTemplate(tx: Queryable, tenantId: string): Promise<ApplyTemplateResult> {
  // The applier refuses a tenant whose jurisdiction differs from the
  // template's (01 §1.6). platform.tenant is readable (not writable) by
  // app_user for exactly this kind of check.
  const jur = await tx.query<{ jurisdiction_code: string }>(
    'select jurisdiction_code from platform.tenant where id = $1',
    [tenantId],
  );
  const code = jur.rows[0]?.jurisdiction_code;
  if (code !== TEMPLATE_JURISDICTION) {
    throw new Error(
      `template ${TEMPLATE_ID} is for jurisdiction ${TEMPLATE_JURISDICTION}; tenant ${tenantId} has ${String(code)}`,
    );
  }

  const skus = await parseSkus();
  const founderPending: ApplyTemplateResult['founderPending'] = [];

  // --- module: units_of_measure ------------------------------------------
  {
    const writeId = await moduleWrite(tx, tenantId, 'units_of_measure');
    await batchInsert(
      tx,
      'app.unit_of_measure',
      ['tenant_id', 'id', 'write_id', 'hlc', 'code', 'name', 'dimension', 'qty_scale', 'origin_template_id', 'origin_ref'],
      TEMPLATE_UOMS.map((u) => [
        tenantId,
        rowId(tenantId, `uom:${u.code}`),
        writeId,
        hlcClock.next(),
        u.code,
        u.name,
        u.dimension,
        u.qtyScale,
        TEMPLATE_ID,
        `uom:${u.code}`,
      ]),
    );
  }

  // --- module: location_types (tenant VOCABULARY, never platform logic) ---
  {
    const writeId = await moduleWrite(tx, tenantId, 'location_types');
    const types = [
      { code: 'FLAGSHIP', name: 'Flagship store' },
      { code: 'RDC', name: 'Regional distribution centre' },
      { code: 'MICRO', name: 'Community micro-outlet' },
    ];
    await batchInsert(
      tx,
      'app.location_type',
      ['tenant_id', 'id', 'write_id', 'hlc', 'code', 'name', 'origin_template_id', 'origin_ref'],
      types.map((t) => [
        tenantId,
        rowId(tenantId, `loctype:${t.code}`),
        writeId,
        hlcClock.next(),
        t.code,
        t.name,
        TEMPLATE_ID,
        `loctype:${t.code}`,
      ]),
    );
  }

  // --- module: catalogue ---------------------------------------------------
  {
    const writeId = await moduleWrite(tx, tenantId, 'catalogue');

    // Category tree: 12 top-level categories, 54 sub-categories.
    const cats = new Map<string, { name: string; ref: string }>();
    const subs = new Map<string, { name: string; ref: string; parentRef: string }>();
    for (const line of skus) {
      const catSlug = slug(line.category);
      const catRef = `cat:${catSlug}`;
      cats.set(catSlug, { name: line.category, ref: catRef });
      const subSlug = `${catSlug}:${slug(line.subCategory)}`;
      subs.set(subSlug, { name: line.subCategory, ref: `cat:${subSlug}`, parentRef: catRef });
    }

    await batchInsert(
      tx,
      'app.product_category',
      ['tenant_id', 'id', 'write_id', 'hlc', 'code', 'name', 'parent_id', 'origin_template_id', 'origin_ref'],
      [...cats.entries()].map(([catSlug, c]) => [
        tenantId,
        rowId(tenantId, c.ref),
        writeId,
        hlcClock.next(),
        catSlug,
        c.name,
        null,
        TEMPLATE_ID,
        c.ref,
      ]),
    );
    await batchInsert(
      tx,
      'app.product_category',
      ['tenant_id', 'id', 'write_id', 'hlc', 'code', 'name', 'parent_id', 'origin_template_id', 'origin_ref'],
      [...subs.entries()].map(([subSlug, s]) => [
        tenantId,
        rowId(tenantId, s.ref),
        writeId,
        hlcClock.next(),
        subSlug,
        s.name,
        rowId(tenantId, s.parentRef),
        TEMPLATE_ID,
        s.ref,
      ]),
    );

    // Products: one per catalogue line. The §4.5 compound-size expansion
    // (15 lines → 32 products, 219 → 236) is a template-AUTHORING step that
    // needs the founder's confirmation of the size splits; until then the
    // template imports the catalogue lines 1:1 and flags the class-C lines.
    const productRows = skus.map((line) => {
      const ref = `sku:${line.skuNo}`;
      const subSlug = `${slug(line.category)}:${slug(line.subCategory)}`;
      if (line.underSpecified) {
        founderPending.push({
          skuNo: line.skuNo,
          reason: 'under-specified catalogue line (04 §4.4.2 class C) — split/reclassify before go-live',
        });
      }
      for (const pending of line.pendingSellUoms) {
        founderPending.push({
          skuNo: line.skuNo,
          reason: `second selling unit ${pending} needs a founder-confirmed conversion factor (§4.16)`,
        });
      }
      const flags: string[] = [];
      if (line.underSpecified) flags.push('[NEEDS-FOUNDER: under-specified line — see §4.4.2 class C]');
      for (const p of line.pendingSellUoms) flags.push(`[NEEDS-FOUNDER: ${p} conversion factor unconfirmed]`);
      const notes = [line.notes, ...flags].filter((s) => s.length > 0).join(' ') || null;
      return [
        tenantId,
        rowId(tenantId, ref),
        writeId,
        hlcClock.next(),
        `SKU-${String(line.skuNo).padStart(3, '0')}`,
        line.description,
        rowId(tenantId, `cat:${subSlug}`),
        rowId(tenantId, `uom:${line.stockingUomCode}`),
        'GH.VAT.STD', // template references pack tax CODES; rates stay in the pack
        line.nonStocked ? 'NON_STOCKED' : 'STOCKED',
        true,
        true,
        notes,
        TEMPLATE_ID,
        ref,
      ];
    });
    await batchInsert(
      tx,
      'app.product',
      ['tenant_id', 'id', 'write_id', 'hlc', 'sku_code', 'name', 'category_id', 'stocking_uom_id',
       'tax_code', 'stock_tracking', 'is_sellable', 'is_purchasable', 'notes', 'origin_template_id', 'origin_ref'],
      productRows,
    );

    // product_uom: every product gets its stocking unit at 1/1 (exact ⇒
    // tolerance 0), plus the confirmed dual-unit rows — rebar at EXACTLY
    // 13500/d² bars per tonne (04 §4.4.1).
    const puomCols = ['tenant_id', 'id', 'write_id', 'hlc', 'product_id', 'uom_id', 'factor_num', 'factor_den',
      'can_sell', 'can_buy', 'is_default_sell', 'tolerance_bp', 'sort_order', 'origin_template_id', 'origin_ref'];
    const puomRows: unknown[][] = [];
    const puomRow = (line: CatalogueLine, uomCode: string, num: bigint, den: bigint, isStocking: boolean, tolBp: number) => {
      const ref = `sku:${line.skuNo}:uom:${uomCode}`;
      return [
        tenantId,
        rowId(tenantId, ref),
        writeId,
        hlcClock.next(),
        rowId(tenantId, `sku:${line.skuNo}`),
        rowId(tenantId, `uom:${uomCode}`),
        String(num),
        String(den),
        true,
        isStocking, // stocking unit is also the purchase unit until supplier data says otherwise
        isStocking, // default selling unit is the stocking unit
        tolBp,
        isStocking ? 0 : 1,
        TEMPLATE_ID,
        ref,
      ];
    };
    for (const line of skus) {
      puomRows.push(puomRow(line, line.stockingUomCode, 1n, 1n, true, 0));
      for (const sell of line.sellingUoms) {
        puomRows.push(puomRow(line, sell.uomCode, sell.factorNum, sell.factorDen, false, sell.toleranceBp));
      }
    }
    await batchInsert(tx, 'app.product_uom', puomCols, puomRows);
  }

  // --- module: movement_reasons -------------------------------------------
  {
    const writeId = await moduleWrite(tx, tenantId, 'movement_reasons');
    await batchInsert(
      tx,
      'app.movement_reason',
      ['tenant_id', 'id', 'write_id', 'hlc', 'code', 'name', 'origin_template_id', 'origin_ref'],
      MOVEMENT_REASONS.map((r) => [
        tenantId,
        rowId(tenantId, `reason:${r.code}`),
        writeId,
        hlcClock.next(),
        r.code,
        r.name,
        TEMPLATE_ID,
        `reason:${r.code}`,
      ]),
    );
  }

  // --- module: price_lists (structure only — templates NEVER seed prices) --
  {
    const writeId = await moduleWrite(tx, tenantId, 'price_lists');
    const lists = [
      { code: 'RETAIL', name: 'Counter retail', inclusive: true, priority: 10 },
      { code: 'WHOLESALE', name: 'Contractor wholesale', inclusive: false, priority: 20 },
    ];
    await batchInsert(
      tx,
      'app.price_list',
      ['tenant_id', 'id', 'write_id', 'hlc', 'code', 'name', 'is_tax_inclusive', 'currency_code',
       'priority', 'location_id', 'effective_from', 'effective_to', 'origin_template_id', 'origin_ref'],
      lists.map((l) => [
        tenantId,
        rowId(tenantId, `pricelist:${l.code}`),
        writeId,
        hlcClock.next(),
        l.code,
        l.name,
        l.inclusive,
        'GHS',
        l.priority,
        null,
        '2026-08-01',
        null,
        TEMPLATE_ID,
        `pricelist:${l.code}`,
      ]),
    );
  }

  return { templateId: TEMPLATE_ID, templateVersion: TEMPLATE_VERSION, founderPending };
}

/**
 * Tenant #1's location network — ONBOARDING INPUT, deliberately NOT part of
 * the template (01 §1.6: location types are template data; locations are
 * entered at onboarding). Builds the tree from outlets.csv: one root GROUP,
 * six region GROUP nodes, 25 OUTLET nodes — row 21 ("Initial Fleet + HQ/ERP
 * Systems") is a capex line, excluded by parseOutlets() — plus one durable
 * TRANSIT node per stock-holding location, created with the location
 * (04 §4.7.3: one per SENDING LOCATION, never one per transfer).
 *
 * Requires applyTemplate() first (location types must exist).
 */
export async function applyTenant1Locations(tx: Queryable, tenantId: string): Promise<void> {
  const plan = await parseOutlets();
  const writeId = await moduleWrite(tx, tenantId, 'tenant1_locations');
  const tz = 'Africa/Accra';
  const cols = ['tenant_id', 'id', 'write_id', 'hlc', 'code', 'name', 'kind', 'location_type_id',
    'parent_id', 'is_active', 'timezone', 'origin_template_id', 'origin_ref'];

  const rootRef = 'loc:ROOT';
  await batchInsert(tx, 'app.location', cols, [
    [tenantId, rowId(tenantId, rootRef), writeId, hlcClock.next(), 'ROOT',
     'Agyasei Jnr & Company network', 'GROUP', null, null, true, tz, TEMPLATE_ID, rootRef],
  ]);

  await batchInsert(
    tx,
    'app.location',
    cols,
    plan.regions.map((region) => {
      const ref = `loc:REG-${slug(region)}`;
      return [tenantId, rowId(tenantId, ref), writeId, hlcClock.next(), `REG-${slug(region)}`,
        `${region} region`, 'GROUP', null, rowId(tenantId, rootRef), true, tz, TEMPLATE_ID, ref];
    }),
  );

  const outletRows: unknown[][] = [];
  for (const o of plan.outlets) {
    const ref = `loc:OUT-${o.outletId}`;
    outletRows.push([
      tenantId, rowId(tenantId, ref), writeId, hlcClock.next(), `OUT-${String(o.outletId).padStart(2, '0')}`,
      o.name, 'OUTLET', rowId(tenantId, `loctype:${o.tier}`),
      rowId(tenantId, `loc:REG-${slug(o.region)}`), o.fyOpened === 1, tz, TEMPLATE_ID, ref,
    ]);
    // The durable per-location TRANSIT node (04 §4.7.3).
    const tRef = `loc:TRA-${o.outletId}`;
    outletRows.push([
      tenantId, rowId(tenantId, tRef), writeId, hlcClock.next(), `TRA-${String(o.outletId).padStart(2, '0')}`,
      `${o.name} — in transit`, 'TRANSIT', null,
      rowId(tenantId, ref), o.fyOpened === 1, tz, TEMPLATE_ID, tRef,
    ]);
  }
  await batchInsert(tx, 'app.location', cols, outletRows);
}
