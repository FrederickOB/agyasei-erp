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
import { TEMPLATE_ROLES } from './roles.js';
import { TEMPLATE_TENDER_METHODS } from './tenders.js';
import { parseSkus, TEMPLATE_UOMS, type CatalogueLine } from './skus.js';
import {
  TEMPLATE_CEMENT_SUB_CATEGORY,
  TEMPLATE_PREFERRED_CEMENT_SUPPLIER_REF,
  TEMPLATE_SUPPLIER_CAPABILITY_TYPES,
  TEMPLATE_SUPPLIERS,
} from './suppliers.js';

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

  // --- module: tender_methods ------------------------------------------------
  // How a customer may pay, as ORDINARY EDITABLE ROWS (04 §4.8). The platform
  // reads only each row's posting role; the codes and names are this
  // template's vocabulary (see src/seed/tenders.ts).
  {
    const writeId = await moduleWrite(tx, tenantId, 'tender_methods');
    await batchInsert(
      tx,
      'app.tender_method',
      ['tenant_id', 'id', 'write_id', 'hlc', 'code', 'name', 'posting_role', 'requires_reference',
       'is_active', 'sort_order', 'origin_template_id', 'origin_ref'],
      TEMPLATE_TENDER_METHODS.map((m) => [
        tenantId,
        rowId(tenantId, `tender:${m.ref}`),
        writeId,
        hlcClock.next(),
        m.code,
        m.name,
        m.postingRole,
        m.requiresReference,
        true,
        m.sortOrder,
        TEMPLATE_ID,
        `tender:${m.ref}`,
      ]),
    );
  }

  // --- module: suppliers ---------------------------------------------------
  // Tenant #1's cement sources and a carrier, as ORDINARY EDITABLE ROWS.
  //
  // ADR-0001: a HAULIER IS A SUPPLIER holding a capability of kind HAULAGE.
  // There is no carrier table and no vehicle anywhere in this system. The
  // capability's `code`/`name` are the tenant's vocabulary; its `kind` is the
  // platform structure the delivery guard reads (see src/seed/suppliers.ts).
  //
  // Payment terms are seeded as cash on delivery and lead times and prices
  // are left NULL, because the plan states none of them — every row carries a
  // [NEEDS-FOUNDER: …] note rather than a fabricated figure.
  {
    const writeId = await moduleWrite(tx, tenantId, 'suppliers');

    await batchInsert(
      tx,
      'app.supplier_capability_type',
      ['tenant_id', 'id', 'write_id', 'hlc', 'code', 'name', 'kind',
       'origin_template_id', 'origin_ref'],
      TEMPLATE_SUPPLIER_CAPABILITY_TYPES.map((c) => {
        const ref = `supplier_capability_type:${c.ref}`;
        return [tenantId, rowId(tenantId, ref), writeId, hlcClock.next(),
          c.code, c.name, c.kind, TEMPLATE_ID, ref];
      }),
    );

    await batchInsert(
      tx,
      'app.supplier',
      ['tenant_id', 'id', 'write_id', 'hlc', 'code', 'name', 'payment_terms_days',
       'currency_code', 'is_active', 'notes', 'origin_template_id', 'origin_ref'],
      TEMPLATE_SUPPLIERS.map((s) => {
        const ref = `supplier:${s.ref}`;
        return [tenantId, rowId(tenantId, ref), writeId, hlcClock.next(),
          s.code, s.name, s.paymentTermsDays, 'GHS', true, s.notes, TEMPLATE_ID, ref];
      }),
    );

    const capabilityRows: unknown[][] = [];
    for (const s of TEMPLATE_SUPPLIERS) {
      for (const capRef of s.capabilityRefs) {
        const ref = `supplier_capability:${s.ref}:${capRef}`;
        capabilityRows.push([
          tenantId,
          rowId(tenantId, ref),
          writeId,
          hlcClock.next(),
          rowId(tenantId, `supplier:${s.ref}`),
          rowId(tenantId, `supplier_capability_type:${capRef}`),
          TEMPLATE_ID,
          ref,
        ]);
      }
    }
    await batchInsert(
      tx,
      'app.supplier_capability',
      ['tenant_id', 'id', 'write_id', 'hlc', 'supplier_id', 'capability_type_id',
       'origin_template_id', 'origin_ref'],
      capabilityRows,
    );

    // MULTI-SOURCE, as data: every cement SKU gets a supply record from each
    // of the three manufacturers, one of them preferred. `purchase_uom_id` is
    // the product's STOCKING unit, whose product_uom row the catalogue module
    // above already created with can_buy — the 0008 trigger refuses anything
    // that is not a buyable unit of the product, which is the same machinery
    // selling uses, in the opposite direction (§4.10).
    //
    // Buying cement by the TONNE (20 × 50 kg bags) is a further authoring
    // step the founder confirms: it is one more product_uom row with can_buy
    // and a 20/1 factor, and this seeder needs no change to use it.
    const cementSkus = skus.filter((l) => l.subCategory === TEMPLATE_CEMENT_SUB_CATEGORY);
    const goodsSuppliers = TEMPLATE_SUPPLIERS.filter((s) => s.capabilityRefs.includes('GOODS'));
    const supplierProductRows: unknown[][] = [];
    for (const line of cementSkus) {
      for (const s of goodsSuppliers) {
        const ref = `supplier_product:${s.ref}:${line.skuNo}`;
        supplierProductRows.push([
          tenantId,
          rowId(tenantId, ref),
          writeId,
          hlcClock.next(),
          rowId(tenantId, `supplier:${s.ref}`),
          rowId(tenantId, `sku:${line.skuNo}`),
          rowId(tenantId, `uom:${line.stockingUomCode}`),
          s.ref === TEMPLATE_PREFERRED_CEMENT_SUPPLIER_REF,
          true,
          '[NEEDS-FOUNDER: no lead time and no price — the plan states neither. A guessed lead time drives the order-up-to arithmetic; a zero price reads as free.]',
          TEMPLATE_ID,
          ref,
        ]);
      }
    }
    await batchInsert(
      tx,
      'app.supplier_product',
      ['tenant_id', 'id', 'write_id', 'hlc', 'supplier_id', 'product_id', 'purchase_uom_id',
       'is_preferred', 'is_active', 'notes', 'origin_template_id', 'origin_ref'],
      supplierProductRows,
    );
  }

  // --- module: roles -------------------------------------------------------
  // Tenant #1's five roles, as ORDINARY EDITABLE ROWS (ADR-0006). Nothing on
  // the platform knows these names; the access-control decision lives
  // entirely in the permission codes composed onto them, so the two hard
  // prohibitions in the brief are the ABSENCE of two rows on the counter
  // role — see src/seed/roles.ts.
  //
  // Deliberately NOT seeded here: users and role ASSIGNMENTS. Who works for
  // this tenant, and at which node of their tree, is onboarding input, not
  // template content (01 §1.6) — the same rule that keeps locations out.
  {
    const writeId = await moduleWrite(tx, tenantId, 'roles');
    await batchInsert(
      tx,
      'app.role',
      ['tenant_id', 'id', 'write_id', 'hlc', 'name', 'description', 'is_owner',
       'origin_template_id', 'origin_ref'],
      TEMPLATE_ROLES.map((r) => [
        tenantId,
        rowId(tenantId, `role:${r.ref}`),
        writeId,
        hlcClock.next(),
        r.name,
        r.description,
        r.isOwner,
        TEMPLATE_ID,
        `role:${r.ref}`,
      ]),
    );

    const rolePermRows: unknown[][] = [];
    for (const r of TEMPLATE_ROLES) {
      for (const perm of r.permissions) {
        const ref = `roleperm:${r.ref}:${perm.code}`;
        rolePermRows.push([
          tenantId,
          rowId(tenantId, ref),
          writeId,
          hlcClock.next(),
          rowId(tenantId, `role:${r.ref}`),
          perm.code,
          perm.bound ? JSON.stringify(perm.bound) : null,
        ]);
      }
    }
    await batchInsert(
      tx,
      'app.role_permission',
      ['tenant_id', 'id', 'write_id', 'hlc', 'role_id', 'permission_code', 'bound'],
      rolePermRows,
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

/**
 * Receipt-number counters, one per selling location (03 §3.7.5).
 *
 * TEMPLATE DATA, NOT PLATFORM BEHAVIOUR. The format string, the prefix and the
 * block size are ordinary editable rows the tenant owns from here on. There is
 * deliberately no platform default anywhere in the allocation path: a location
 * with no counter row cannot allocate a block, and the API refuses rather than
 * inventing a format. That refusal is what keeps `if (country === 'GH')` out of
 * the code — the numbering rules are data or they are absent (ADR-0007,
 * CLAUDE.md §2.5/§2.9).
 *
 * `{location_code}-{prefix}-{n:06d}` (SUN-RCT-004312) is tenant #1's template
 * format: the location code makes the block boundary invisible to a human and
 * makes a printed receipt self-describing.
 *
 * Block size is per location TYPE, and the sizes are §3.7.5's corrected ones —
 * 500 numbers is three to four days at a flagship till, not "roughly two
 * weeks", so a Flagship-class location ships 2,000. Reading `location_type.code`
 * here is the TEMPLATE reading its own vocabulary, which is what a template is
 * for; platform code never does it (ADR-0006).
 *
 * Idempotent and additive: rows are keyed deterministically and inserted with
 * ON CONFLICT DO NOTHING, so a re-run after the tenant has edited a format
 * changes nothing.
 */
const SEQUENCE_BLOCK_SIZE_BY_TYPE: Record<string, number> = {
  FLAGSHIP: 2000,
  RDC: 1000,
  MICRO: 500,
};
const SEQUENCE_BLOCK_SIZE_DEFAULT = 500;

export async function applySequenceCounters(tx: Queryable, tenantId: string): Promise<number> {
  const writeId = await moduleWrite(tx, tenantId, 'sequence_counters');

  // Selling locations only: a GROUP node has no till and a TRANSIT node is a
  // stock waypoint, not a place a receipt is printed.
  const outlets = await tx.query<{ id: string; code: string; type_code: string | null }>(
    `select l.id, l.code, lt.code as type_code
       from app.location l
       left join app.location_type lt
         on lt.tenant_id = l.tenant_id and lt.id = l.location_type_id and lt.deleted_at is null
      where l.kind = 'OUTLET' and l.deleted_at is null
      order by l.code`,
  );
  if (outlets.rows.length === 0) return 0;

  const cols = ['tenant_id', 'id', 'write_id', 'hlc', 'sequence_key', 'location_id',
    'next_start', 'block_size', 'number_format', 'number_prefix',
    'origin_template_id', 'origin_ref'];
  await batchInsert(
    tx,
    'app.sequence_counter',
    cols,
    outlets.rows.map((o) => {
      const ref = `seqcounter:RECEIPT:${o.code}`;
      const size =
        (o.type_code === null ? undefined : SEQUENCE_BLOCK_SIZE_BY_TYPE[o.type_code]) ??
        SEQUENCE_BLOCK_SIZE_DEFAULT;
      return [
        tenantId,
        rowId(tenantId, ref),
        writeId,
        hlcClock.next(),
        'RECEIPT',
        o.id,
        1,
        size,
        '{location_code}-{prefix}-{n:06d}',
        'RCT',
        TEMPLATE_ID,
        ref,
      ];
    }),
  );
  return outlets.rows.length;
}

/**
 * Low-stock thresholds for the SKUs a location DEMONSTRABLY CARRIES
 * (migration 0007).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS DOES NOT SEED A ROW PER (LOCATION × CATALOGUE)
 * ---------------------------------------------------------------------------
 * 25 locations × 219 SKUs is 5,475 thresholds nobody chose. Every one of them
 * would be breached on the morning of 1 August 2026, because on-hand is zero
 * until the opening stock is loaded — so the pilot's first low-stock screen
 * would be five thousand rows long and would be ignored forever after. An
 * alert list that is always full is not an alert list.
 *
 * So the rule is: a threshold exists where the LEDGER already shows the
 * location holding the product. Run this after the opening balances land
 * (`provisioning.ensureReorderPoints`, or a second applyTemplate) and it seeds
 * exactly the SKUs that location carries, at a level derived from what it
 * actually opened with. Run it at onboarding, before any stock exists, and it
 * correctly seeds nothing.
 *
 * ---------------------------------------------------------------------------
 * THE LEVEL, AND ITS HONEST PROVENANCE
 * ---------------------------------------------------------------------------
 * A reorder point is properly expected demand over the supplier lead time.
 * This system has neither demand history nor lead times on the day a tenant
 * is onboarded — Phase 2 brings suppliers and lead times, and demand needs
 * trading days to exist at all. So the seed uses the one quantity that IS
 * observable: what the location opened with, at REORDER_FRACTION_BP of it,
 * never below one whole stocking unit.
 *
 * That fraction is an ARBITRARY STARTING POINT chosen by the template author,
 * exactly like the assumed 100 m roll in skus.ts, and it is flagged the same
 * way — the applier returns `needsFounderReview` so onboarding can put the
 * list in front of a human rather than let a guessed number look authoritative.
 * It is NOT a computed reorder point and nothing in the platform treats it as
 * one; it is a row the tenant edits (`inventory.setReorderPoint`).
 *
 * Idempotent and additive, like every other module here: the unique index on
 * (tenant, location, product) is the conflict target, so a threshold the
 * tenant has since tuned is NEVER overwritten and a SKU that arrives later
 * gets its row on the next run.
 */
export const REORDER_FRACTION_BP = 2500; // 25% of opening stock. Founder tunes.

export interface ApplyReorderPointsResult {
  /** Rows inserted by this run. Zero on a re-run, and zero before stock exists. */
  seeded: number;
  /**
   * True whenever anything was seeded: the level is a template guess, not a
   * computed figure, and onboarding must show it to a human (§4.16 pattern).
   */
  needsFounderReview: boolean;
}

export async function applyReorderPoints(
  tx: Queryable,
  tenantId: string,
  opts: { locationId?: string } = {},
): Promise<ApplyReorderPointsResult> {
  // Candidates: stock-tracked products with a POSITIVE derived balance at a
  // selling or stock-holding location, that have no live threshold yet.
  //
  // qty_on_hand comes from app.stock_on_hand — SUM over the append-only
  // ledger, never a counter (CLAUDE.md §2.2) — and the unit comes from the
  // product's STOCKING unit, which is the only denomination the ledger and
  // therefore the threshold may be in (04 §4.4.3).
  const candidates = await tx.query<{
    location_id: string;
    location_code: string;
    product_id: string;
    sku_code: string;
    uom_id: string;
    qty_scale: number;
    qty_on_hand: string;
  }>(
    `select l.id      as location_id,
            l.code    as location_code,
            p.id      as product_id,
            p.sku_code,
            p.stocking_uom_id as uom_id,
            u.qty_scale,
            soh.qty_on_hand::text
       from app.stock_on_hand soh
       join app.location l
         on l.tenant_id = soh.tenant_id and l.id = soh.location_id
        and l.deleted_at is null and l.kind in ('OUTLET', 'WAREHOUSE')
       join app.product p
         on p.tenant_id = soh.tenant_id and p.id = soh.product_id
        and p.deleted_at is null and p.stock_tracking = 'STOCKED'
       join app.unit_of_measure u
         on u.tenant_id = p.tenant_id and u.id = p.stocking_uom_id
      where soh.qty_on_hand > 0
        and ($1::uuid is null or l.id = $1::uuid)
        and not exists (
          select 1 from app.reorder_point rp
           where rp.tenant_id = soh.tenant_id
             and rp.location_id = soh.location_id
             and rp.product_id = soh.product_id
             and rp.deleted_at is null
        )
      order by l.code, p.sku_code`,
    [opts.locationId ?? null],
  );
  if (candidates.rows.length === 0) return { seeded: 0, needsFounderReview: false };

  const writeId = await moduleWrite(tx, tenantId, 'reorder_points');
  const cols = ['tenant_id', 'id', 'write_id', 'hlc', 'location_id', 'product_id', 'uom_id',
    'qty_scale', 'reorder_point_qty', 'reorder_up_to_qty', 'is_active', 'notes',
    'origin_template_id', 'origin_ref'];

  const rows = candidates.rows.map((c) => {
    const ref = `reorderpoint:${c.location_code}:${c.sku_code}`;
    // bigint throughout: an opening balance of 400 tonnes at scale 3 is
    // 400_000_000 scaled units and a float64 would already be lying about
    // larger ones (ADR-0004).
    const onHand = BigInt(c.qty_on_hand);
    const scaled = (onHand * BigInt(REORDER_FRACTION_BP)) / 10_000n; // truncating: a LOWER threshold
    const point = scaled > 0n ? scaled : 1n;
    return [
      tenantId,
      rowId(tenantId, ref),
      writeId,
      hlcClock.next(),
      c.location_id,
      c.product_id,
      c.uom_id,           // the stocking unit; the 0007 trigger refuses anything else
      c.qty_scale,
      point.toString(10),
      onHand.toString(10), // order back up to what the location opened with
      true,
      `[NEEDS-FOUNDER: seeded at ${REORDER_FRACTION_BP / 100}% of opening stock — no demand history or lead time exists yet]`,
      TEMPLATE_ID,
      ref,
    ];
  });
  await batchInsert(tx, 'app.reorder_point', cols, rows);
  return { seeded: rows.length, needsFounderReview: true };
}
