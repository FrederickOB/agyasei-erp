/**
 * The suppliers that ship with the "construction-materials-gh" template.
 *
 * THIS FILE IS DATA, NOT LOGIC (ADR-0006; CLAUDE.md §2.9). applyTemplate()
 * inserts these once as ORDINARY EDITABLE ROWS; afterwards the tenant owns
 * them — rename them, deactivate them, add the four more it actually buys
 * from. There is no live inheritance and no "reset to template", and NO
 * PLATFORM CODE ANYWHERE READS A SUPPLIER CODE OR A CAPABILITY CODE.
 *
 * ---------------------------------------------------------------------------
 * A HAULIER IS A SUPPLIER (ADR-0001)
 * ---------------------------------------------------------------------------
 * There is no carrier table, no vehicle, no driver. A haulier is a supplier
 * holding a capability whose `kind` is HAULAGE: it invoices and is paid on
 * terms, which is a supplier in every way the books care about, and it puts
 * haulage spend in AP where distribution cost as a percentage of revenue can
 * be measured — which is what ADR-0001 owes open-questions Q1 now that
 * Lever 3's owned-fleet mechanism is gone.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS A GUESS HERE, AND SAID SO
 * ---------------------------------------------------------------------------
 * The business plan names GHACEM, Dangote and CIMAF as the three cement
 * sources (§141, "multi-source from at least two ... to preserve negotiating
 * leverage") and names NO haulier at all. It states no payment terms, no lead
 * times and no prices for any of them.
 *
 * So every one of those numbers is either absent or flagged. `payment_terms_days`
 * is 0 — cash on delivery — because 0 is the conservative reading and a
 * fabricated 30 would look like a term somebody had negotiated. Lead times
 * and prices are NULL rather than invented: a zero price reads as "free" and
 * a guessed lead time silently drives Phase 2's order-up-to arithmetic. Every
 * seeded row carries a `[NEEDS-FOUNDER: …]` note, the same way skus.ts flags
 * an assumed roll length and applyReorderPoints flags its opening fraction.
 */

/** A capability the template defines. `kind` is the only PLATFORM half. */
export interface TemplateSupplierCapabilityType {
  /** Stable provenance key. Never read by business logic (01 §1.6). */
  ref: string;
  /** TENANT vocabulary — the tenant's own word. Never branched on. */
  code: string;
  name: string;
  /** PLATFORM structure. The only column platform code may read. */
  kind: 'GOODS' | 'HAULAGE';
}

export interface TemplateSupplier {
  /** Stable provenance key. Never read by business logic (01 §1.6). */
  ref: string;
  code: string;
  name: string;
  /** Refs into TEMPLATE_SUPPLIER_CAPABILITY_TYPES. Several is normal. */
  capabilityRefs: readonly string[];
  /** Cash on delivery until the founder confirms otherwise. */
  paymentTermsDays: number;
  notes: string;
}

export const TEMPLATE_SUPPLIER_CAPABILITY_TYPES: readonly TemplateSupplierCapabilityType[] = [
  {
    ref: 'GOODS',
    code: 'GOODS',
    name: 'Goods supply',
    kind: 'GOODS',
  },
  {
    // A tenant may rename this "Trucking" tomorrow and everything keeps
    // working, because the delivery guard reads `kind`, never `code`.
    ref: 'HAULAGE',
    code: 'HAULAGE',
    name: 'Haulage',
    kind: 'HAULAGE',
  },
];

const FOUNDER_TERMS =
  '[NEEDS-FOUNDER: payment terms seeded as cash on delivery — the business plan states none; confirm before go-live]';

export const TEMPLATE_SUPPLIERS: readonly TemplateSupplier[] = [
  {
    ref: 'GHACEM',
    code: 'GHACEM',
    name: 'GHACEM',
    capabilityRefs: ['GOODS'],
    paymentTermsDays: 0,
    notes: `Cement manufacturer. Business plan §87: primary cement supply relationship target. ${FOUNDER_TERMS}`,
  },
  {
    ref: 'DANGOTE',
    code: 'DANGOTE',
    name: 'Dangote Cement',
    capabilityRefs: ['GOODS'],
    paymentTermsDays: 0,
    notes: `Cement manufacturer. Business plan §88: alternative supply source, procurement leverage. ${FOUNDER_TERMS}`,
  },
  {
    ref: 'CIMAF',
    code: 'CIMAF',
    name: 'CIMAF',
    capabilityRefs: ['GOODS'],
    paymentTermsDays: 0,
    notes: `Cement manufacturer. Business plan §89: third supply option, northern-Ghana distribution. ${FOUNDER_TERMS}`,
  },
  {
    // ADR-0001: the company owns no trucks, so somebody else's have to be
    // bookable from day one. The plan names no haulier, so this row is a
    // PLACEHOLDER and says so — a delivery cannot be planned without a
    // carrier that holds a HAULAGE capability, and shipping the template
    // without one would mean the first dispatch fails at a constraint nobody
    // could see coming.
    ref: 'HAULIER-GENERAL',
    code: 'HAUL-01',
    name: 'General haulage contractor',
    capabilityRefs: ['HAULAGE'],
    paymentTermsDays: 0,
    notes:
      '[NEEDS-FOUNDER: placeholder carrier — replace with the contracted haulier(s) before go-live. ADR-0001: third-party haulage only, no owned fleet.] ' +
      FOUNDER_TERMS,
  },
];

/**
 * The sub-category whose SKUs get a supply record from each cement
 * manufacturer, so MULTI-SOURCE is real data on day one rather than a
 * capability nobody has exercised: five cement SKUs × three manufacturers is
 * fifteen rows, one of them preferred.
 *
 * This string is the TEMPLATE reading its OWN catalogue vocabulary — the same
 * thing applySequenceCounters does with `location_type.code`, and what a
 * template is for. No platform code reads it (CLAUDE.md §2.9).
 */
export const TEMPLATE_CEMENT_SUB_CATEGORY = 'Cement';

/** The manufacturer whose rows are seeded preferred (business plan §87). */
export const TEMPLATE_PREFERRED_CEMENT_SUPPLIER_REF = 'GHACEM';
