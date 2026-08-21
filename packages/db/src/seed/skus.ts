/**
 * Parse docs/source-of-truth/skus.csv (219 rows — tenant #1's catalogue,
 * which ships as TEMPLATE data, never as the platform's product list;
 * ADR-0006) and resolve each line's unit story per 04-data-model §4.4.
 *
 * The unit resolution implements §4.4.2's three classes:
 *   A — genuine dual unit, one stock balance, RATIONAL factor. The rebar
 *       factor is exact arithmetic: bars per tonne = 13500/d² (d = diameter
 *       in mm), stored as a num/den pair, never a decimal.
 *   B — pack break (whole-number factors).
 *   C — under-specified catalogue lines (SKUs 67, 146, 160, 161) that must
 *       NOT be imported as dual units; they are imported as single-unit
 *       products and flagged for the founder (§4.16) before go-live.
 *
 * Dual-unit rows whose factor needs the founder (tile box areas, truck trip
 * capacities, box masses — §4.16 / Q9) are seeded with the STOCKING unit
 * only; the selling unit is listed in `pendingSellUoms` and not invented.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseCsv } from './csv.js';

export const SKUS_CSV_PATH = fileURLToPath(
  new URL('../../../../docs/source-of-truth/skus.csv', import.meta.url),
);

export interface UomDef {
  code: string;
  name: string;
  dimension: 'COUNT' | 'MASS' | 'LENGTH' | 'AREA' | 'VOLUME';
  qtyScale: number;
}

/** The template's unit vocabulary (04 §4.4.3). Scales are IMMUTABLE once used. */
export const TEMPLATE_UOMS: UomDef[] = [
  { code: 'PIECE', name: 'Piece', dimension: 'COUNT', qtyScale: 0 },
  { code: 'BAG', name: 'Bag', dimension: 'COUNT', qtyScale: 0 },
  { code: 'BOX', name: 'Box', dimension: 'COUNT', qtyScale: 0 },
  { code: 'SHEET', name: 'Sheet', dimension: 'COUNT', qtyScale: 0 },
  { code: 'SET', name: 'Set', dimension: 'COUNT', qtyScale: 0 },
  { code: 'ROLL', name: 'Roll', dimension: 'COUNT', qtyScale: 0 },
  { code: 'PAIR', name: 'Pair', dimension: 'COUNT', qtyScale: 0 },
  { code: 'TRIP', name: 'Trip load', dimension: 'COUNT', qtyScale: 0 },
  { code: 'BAR_12M', name: '12m bar', dimension: 'COUNT', qtyScale: 0 },
  { code: 'LENGTH', name: 'Length', dimension: 'COUNT', qtyScale: 0 },
  { code: 'CONTAINER', name: 'Container', dimension: 'COUNT', qtyScale: 0 },
  { code: 'UNIT', name: 'Unit', dimension: 'COUNT', qtyScale: 0 },
  { code: 'PACK', name: 'Pack', dimension: 'COUNT', qtyScale: 0 },
  { code: 'TUBE', name: 'Tube', dimension: 'COUNT', qtyScale: 0 },
  { code: 'KIT', name: 'Kit', dimension: 'COUNT', qtyScale: 0 },
  { code: 'DRUM', name: 'Drum', dimension: 'COUNT', qtyScale: 0 },
  { code: 'KG', name: 'Kilogram', dimension: 'MASS', qtyScale: 3 },
  { code: 'TON', name: 'Tonne', dimension: 'MASS', qtyScale: 3 },
  { code: 'METRE', name: 'Metre', dimension: 'LENGTH', qtyScale: 3 },
  { code: 'SQM', name: 'Square metre', dimension: 'AREA', qtyScale: 4 },
  { code: 'LITRE', name: 'Litre', dimension: 'VOLUME', qtyScale: 3 },
];

export interface SellingUom {
  uomCode: string;
  /** Rational: stocking units per ONE selling unit = factorNum / factorDen. */
  factorNum: bigint;
  factorDen: bigint;
  /**
   * Seed starting tolerance (04 §4.4.4 — the column has NO DDL default; a
   * value must be stated). These are template-authoring starting values on
   * the founder confirmation list (§4.16), not confirmed commercial policy.
   */
  toleranceBp: number;
  /** True where the factor is an ASSUMPTION awaiting the founder (§4.16). */
  assumedFactor: boolean;
}

export interface CatalogueLine {
  skuNo: number;
  category: string;
  subCategory: string;
  description: string;
  unitOfSale: string;
  sizeSpec: string;
  stockedAt: string;
  marginTier: string;
  turnoverSpeed: string;
  notes: string;
  stockingUomCode: string;
  sellingUoms: SellingUom[];
  /** Second units named in the catalogue whose factor needs the founder. */
  pendingSellUoms: string[];
  /** §4.4.2 class C: under-specified line, founder must split/reclassify. */
  underSpecified: boolean;
  nonStocked: boolean;
}

/** Seed starting tolerance for confirmed dual-unit rows; founder confirms (§4.16). */
const SEED_DUAL_TOLERANCE_BP = 50;

function rebarDiameterMm(sizeSpec: string): number {
  const m = /^(\d+)mm/.exec(sizeSpec);
  if (!m) throw new Error(`rebar line without a parsable diameter: ${JSON.stringify(sizeSpec)}`);
  return Number(m[1]);
}

function resolveUnits(line: {
  unitOfSale: string;
  sizeSpec: string;
  skuNo: number;
}): Pick<CatalogueLine, 'stockingUomCode' | 'sellingUoms' | 'pendingSellUoms' | 'underSpecified' | 'nonStocked'> {
  const u = line.unitOfSale;
  const single: Record<string, string> = {
    Piece: 'PIECE',
    Length: 'LENGTH',
    Container: 'CONTAINER',
    Sheet: 'SHEET',
    Bag: 'BAG',
    Set: 'SET',
    Roll: 'ROLL',
    Box: 'BOX',
    Unit: 'UNIT',
    Kg: 'KG',
    Pack: 'PACK',
    Pair: 'PAIR',
    Tube: 'TUBE',
    Kit: 'KIT',
    Drum: 'DRUM',
    Sqm: 'SQM',
  };
  const s = single[u];
  if (s) {
    return { stockingUomCode: s, sellingUoms: [], pendingSellUoms: [], underSpecified: false, nonStocked: false };
  }

  switch (u) {
    case 'Length (12m) / Ton': {
      // Class A. Stock the countable bar; sell also by the tonne.
      // Bars per tonne is EXACTLY 13500/d² (04 §4.4.1) — mill-tolerance
      // confirmation is on the founder list, but the arithmetic is standard.
      const d = rebarDiameterMm(line.sizeSpec);
      return {
        stockingUomCode: 'BAR_12M',
        sellingUoms: [
          {
            uomCode: 'TON',
            factorNum: 13500n,
            factorDen: BigInt(d * d),
            toleranceBp: SEED_DUAL_TOLERANCE_BP,
            assumedFactor: false,
          },
        ],
        pendingSellUoms: [],
        underSpecified: false,
        nonStocked: false,
      };
    }
    case 'Roll / Meter':
      // Class A. Stock the metre; the roll is 100 m — ASSUMED, founder confirms.
      return {
        stockingUomCode: 'METRE',
        sellingUoms: [
          { uomCode: 'ROLL', factorNum: 100n, factorDen: 1n, toleranceBp: SEED_DUAL_TOLERANCE_BP, assumedFactor: true },
        ],
        pendingSellUoms: [],
        underSpecified: false,
        nonStocked: false,
      };
    case 'Roll / kg':
      // Class A. Stock the kg; a binding-wire roll is 20 kg — ASSUMED.
      return {
        stockingUomCode: 'KG',
        sellingUoms: [
          { uomCode: 'ROLL', factorNum: 20n, factorDen: 1n, toleranceBp: SEED_DUAL_TOLERANCE_BP, assumedFactor: true },
        ],
        pendingSellUoms: [],
        underSpecified: false,
        nonStocked: false,
      };
    case 'Piece / Pair':
      // Class B pack break: 2 pieces per pair, exact.
      return {
        stockingUomCode: 'PIECE',
        sellingUoms: [{ uomCode: 'PAIR', factorNum: 2n, factorDen: 1n, toleranceBp: 0, assumedFactor: false }],
        pendingSellUoms: [],
        underSpecified: false,
        nonStocked: false,
      };
    // Duals whose factor needs the founder (§4.16 / Q9): seed the stocking
    // unit; DO NOT invent the factor.
    case 'Sqm / Box':
      return { stockingUomCode: 'BOX', sellingUoms: [], pendingSellUoms: ['SQM'], underSpecified: false, nonStocked: false };
    case 'Sqm / Piece':
      return { stockingUomCode: 'PIECE', sellingUoms: [], pendingSellUoms: ['SQM'], underSpecified: false, nonStocked: false };
    case 'Ton / Trip load':
      return { stockingUomCode: 'TON', sellingUoms: [], pendingSellUoms: ['TRIP'], underSpecified: false, nonStocked: false };
    case 'Kg / Box':
      return { stockingUomCode: 'KG', sellingUoms: [], pendingSellUoms: ['BOX'], underSpecified: false, nonStocked: false };
    case 'Piece / Box':
      return { stockingUomCode: 'PIECE', sellingUoms: [], pendingSellUoms: ['BOX'], underSpecified: false, nonStocked: false };
    case 'Sheet / Pack':
      return { stockingUomCode: 'SHEET', sellingUoms: [], pendingSellUoms: ['PACK'], underSpecified: false, nonStocked: false };
    // §4.4.2 class C — under-specified catalogue lines. Imported as
    // single-unit products, flagged; the founder splits/reclassifies them
    // BEFORE go-live (retrofitting a product split once movements exist
    // means splitting a stock balance per location, 04 §4.15).
    case 'Container / Bag': // SKU 146 — a 20L bucket and a 25kg bag are two products
      return { stockingUomCode: 'CONTAINER', sellingUoms: [], pendingSellUoms: [], underSpecified: true, nonStocked: false };
    case 'Length / Piece': // SKUs 160, 161 — a sub-catalogue on one line
      return { stockingUomCode: 'LENGTH', sellingUoms: [], pendingSellUoms: [], underSpecified: true, nonStocked: false };
    case 'Set/Sqm': // SKU 67 — made-to-order; priced by area, never stocked
      return { stockingUomCode: 'SET', sellingUoms: [], pendingSellUoms: [], underSpecified: true, nonStocked: true };
    default:
      throw new Error(`skus.csv sku ${line.skuNo}: unhandled unit_of_sale ${JSON.stringify(u)}`);
  }
}

export async function parseSkus(csvPath: string = SKUS_CSV_PATH): Promise<CatalogueLine[]> {
  const raw = parseCsv(await readFile(csvPath, 'utf8'));
  const lines = raw.map((r) => {
    const base = {
      skuNo: Number(r['sku_no']),
      category: r['category'] ?? '',
      subCategory: r['sub_category'] ?? '',
      description: r['description'] ?? '',
      unitOfSale: r['unit_of_sale'] ?? '',
      sizeSpec: r['size_spec'] ?? '',
      stockedAt: r['stocked_at'] ?? '',
      marginTier: r['margin_tier'] ?? '',
      turnoverSpeed: r['turnover_speed'] ?? '',
      notes: r['notes'] ?? '',
    };
    return { ...base, ...resolveUnits(base) };
  });
  if (lines.length !== 219) {
    throw new Error(`skus.csv: expected 219 catalogue lines, parsed ${lines.length}`);
  }
  return lines;
}
