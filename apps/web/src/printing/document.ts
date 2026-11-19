/**
 * THE RECEIPT DOCUMENT (§8.8).
 *
 * One plain, serialisable value that every renderer consumes: the ESC/POS
 * encoder, the system-print HTML, the A4 invoice and the full-screen view all
 * read THIS and nothing else. It is derived from the sale's own snapshotted
 * rows and it carries its own currency and money scale, so:
 *
 *   - the formatter takes the scale from the document, never from the live
 *     jurisdiction pack (§8.3) — a redenomination cannot re-render yesterday's
 *     receipt at today's exponent;
 *   - tax lines are the ones the sale was taxed with (ADR-0002) — a reprint
 *     reproduces them exactly and never recomputes against today's rates;
 *   - no tenant word and no currency glyph lives in code (§8.9): the header,
 *     footer, labels, tax names and the pack's statutory fields all arrive as
 *     data.
 *
 * Money is `bigint` minor units throughout. `scale` (digits) is a count, not a
 * magnitude, and is the only `number` that touches an amount's formatting.
 *
 * ─── Q8 SEAM — e-invoice / revenue-authority fields (docs/open-questions.md Q8)
 * What the revenue authority requires on a receipt is NOT SETTLED. `pack`
 * below is the clearly-marked, pack-driven slot: `fields` is an ordered list of
 * label/value lines the jurisdiction pack names, `qr` is the QR payload the
 * pack requires (if any). Nothing here invents a statutory field. While the
 * pack supplies none, `pack.slot` is 'unconfigured' and the receipt says
 * nothing about it. When Q8 resolves, issuance is a SEPARATE document and the
 * pack fills this slot; no renderer changes.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { assertCurrencySpec, divRound, type CurrencySpec } from '@erp/money';
import { formatQtyScaled } from '../lib/quantity';

export interface ReceiptLabels {
  readonly receipt: string;
  readonly date: string;
  readonly location: string;
  readonly customer: string;
  readonly subtotal: string;
  readonly total: string;
  readonly change: string;
  readonly copy: string;
  readonly includesTax: string;
  readonly reference: string;
}

/** Product chrome defaults. A tenant overrides any of them through branding. */
export const DEFAULT_RECEIPT_LABELS: ReceiptLabels = {
  receipt: 'Receipt',
  date: 'Date',
  location: 'Outlet',
  customer: 'Customer',
  subtotal: 'Subtotal',
  total: 'TOTAL',
  change: 'Change',
  copy: 'COPY - REPRINT',
  includesTax: 'Includes',
  reference: 'Ref',
};

export interface ReceiptLineItem {
  readonly name: string;
  /** Exact decimal text of the selling quantity, trailing zeros trimmed. */
  readonly qtyText: string;
  readonly uomLabel: string;
  /** Unit price in minor units, rounded half-up from the e4 price for display. */
  readonly unitPriceMinor: bigint;
  /** The line amount on the list's own convention (gross when tax-inclusive). */
  readonly amountMinor: bigint;
}

export interface ReceiptTaxLine {
  /** The pack's tax code — an identifier. */
  readonly code: string;
  /** The pack's display name for that code; falls back to the code. */
  readonly name: string;
  /** Rate the sale was taxed at, in basis points, from the SALE's own row. */
  readonly rateBp: bigint | null;
  readonly baseMinor: bigint;
  readonly taxMinor: bigint;
}

/** One tender line: a tenant-defined method name, an amount, an optional reference. */
export interface ReceiptTender {
  readonly method: string;
  readonly amountMinor: bigint;
  readonly reference: string | null;
}

export interface ReceiptPackField {
  readonly label: string;
  readonly value: string;
}

export interface ReceiptPackSlot {
  readonly slot: 'unconfigured' | 'configured';
  readonly fields: readonly ReceiptPackField[];
  /** QR payload the pack requires on the receipt, or null. Text, never parsed here. */
  readonly qr: { readonly payload: string } | null;
}

export interface ReceiptCurrency {
  readonly code: string;
  readonly symbol: string;
  readonly scale: 0 | 1 | 2 | 3 | 4;
}

export interface ReceiptDocument {
  readonly version: 1;
  readonly saleId: string;
  readonly receiptNo: string;
  readonly issuedAtIso: string;
  /** Local date-time text, fixed at build so a render never depends on the viewer's zone. */
  readonly issuedAtText: string;
  readonly businessDate: string;
  readonly currency: ReceiptCurrency;
  readonly businessName: string | null;
  readonly headerLines: readonly string[];
  readonly locationName: string | null;
  readonly customerName: string | null;
  /** True when line amounts already contain tax. */
  readonly pricesIncludeTax: boolean;
  readonly lines: readonly ReceiptLineItem[];
  /** Net of tax, or null when this device could not state the split. */
  readonly netMinor: bigint | null;
  readonly taxLines: readonly ReceiptTaxLine[];
  /** What the customer owed. */
  readonly totalMinor: bigint;
  readonly tenders: readonly ReceiptTender[];
  readonly changeMinor: bigint;
  readonly pack: ReceiptPackSlot;
  readonly footerLines: readonly string[];
  readonly labels: ReceiptLabels;
}

export const UNCONFIGURED_PACK_SLOT: ReceiptPackSlot = { slot: 'unconfigured', fields: [], qr: null };

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

export interface ReceiptLineInput {
  readonly name: string;
  readonly qtyScaled: bigint;
  readonly qtyScale: number;
  readonly uomLabel: string;
  readonly unitPriceE4: bigint;
  readonly amountMinor: bigint;
}

export interface ReceiptDocumentInput {
  readonly saleId: string;
  readonly receiptNo: string;
  readonly issuedAtIso: string;
  readonly timeZone: string | null;
  readonly businessDate: string;
  readonly currency: CurrencySpec;
  readonly businessName?: string | null;
  readonly headerLines?: readonly string[];
  readonly locationName?: string | null;
  readonly customerName?: string | null;
  readonly pricesIncludeTax: boolean;
  readonly lines: readonly ReceiptLineInput[];
  readonly netMinor: bigint | null;
  readonly taxLines: readonly ReceiptTaxLine[];
  readonly totalMinor: bigint;
  readonly tenders: readonly ReceiptTender[];
  readonly changeMinor: bigint;
  readonly pack?: ReceiptPackSlot;
  readonly footerLines?: readonly string[];
  readonly labels?: Partial<ReceiptLabels>;
}

const E4 = 10_000n;

/** Local `YYYY-MM-DD HH:mm` in the given zone; UTC when the zone is unknown. */
export function formatIssuedAt(iso: string, timeZone: string | null): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const attempt = (tz: string): string | null => {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(date);
      const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
      return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
    } catch {
      return null;
    }
  };
  return (timeZone === null ? null : attempt(timeZone)) ?? attempt('UTC') ?? iso;
}

export function buildReceiptDocument(input: ReceiptDocumentInput): ReceiptDocument {
  assertCurrencySpec(input.currency);
  return {
    version: 1,
    saleId: input.saleId,
    receiptNo: input.receiptNo,
    issuedAtIso: input.issuedAtIso,
    issuedAtText: formatIssuedAt(input.issuedAtIso, input.timeZone),
    businessDate: input.businessDate,
    currency: {
      code: input.currency.code,
      symbol: input.currency.symbol,
      scale: input.currency.scale,
    },
    businessName: input.businessName ?? null,
    headerLines: input.headerLines ?? [],
    locationName: input.locationName ?? null,
    customerName: input.customerName ?? null,
    pricesIncludeTax: input.pricesIncludeTax,
    lines: input.lines.map((l) => ({
      name: l.name,
      qtyText: formatQtyScaled(l.qtyScaled, l.qtyScale),
      uomLabel: l.uomLabel,
      // Display rounding, stated: half-up to the minor unit. The line AMOUNT
      // was extended from the exact e4 price and is not derived from this.
      unitPriceMinor: divRound(l.unitPriceE4, E4, 'half-up'),
      amountMinor: l.amountMinor,
    })),
    netMinor: input.netMinor,
    taxLines: input.taxLines,
    totalMinor: input.totalMinor,
    tenders: input.tenders,
    changeMinor: input.changeMinor,
    pack: input.pack ?? UNCONFIGURED_PACK_SLOT,
    footerLines: input.footerLines ?? [],
    labels: { ...DEFAULT_RECEIPT_LABELS, ...(input.labels ?? {}) },
  };
}

// ---------------------------------------------------------------------------
// The ONE place today's sale shape becomes a tenders array.
// ---------------------------------------------------------------------------

/**
 * The receipt's "paid by" lines, from the sale's own tender lines (tenant-
 * defined methods: cash, mobile money, bank transfer, cheque, on account …).
 *
 * The amounts are what each method SETTLED, so they always sum to the total —
 * the identity the server enforces on `sale_tender`. Change is shown on its
 * own line, never folded into a tender. The method's name is the tenant's own
 * word and is rendered, never compared (CLAUDE.md §2.9).
 */
export interface RecordedReceiptTender {
  readonly name: string;
  readonly amountMinor: bigint;
  readonly reference: string | null;
}

export function receiptTenders(
  recorded: readonly RecordedReceiptTender[],
  changeMinor: bigint | null,
): { readonly tenders: readonly ReceiptTender[]; readonly changeMinor: bigint } {
  return {
    tenders: recorded.map((t) => ({ method: t.name, amountMinor: t.amountMinor, reference: t.reference })),
    changeMinor: changeMinor !== null && changeMinor > 0n ? changeMinor : 0n,
  };
}

// ---------------------------------------------------------------------------
// Serialisation — the snapshot kept for retry and reprint
// ---------------------------------------------------------------------------

const BIGINT_TAG = '$bigint';

/**
 * The tag is decided from the RAW value, `this[key]`, never from the replacer's
 * second argument. JSON.stringify calls a value's own `toJSON` BEFORE the
 * replacer, and @journeyapps/wa-sqlite installs `BigInt.prototype.toJSON`
 * (returning a plain string) in every page that loads the database — so in the
 * shipped bundle a `typeof v === 'bigint'` replacer never saw a bigint, nothing
 * was tagged, and `deserializeDocument` rejected every queued receipt: no
 * on-screen lines, no print, no reprint. jsdom never loads wa-sqlite, so only
 * the browser tests could see it (e2e/sale.spec.ts).
 */
export function serializeDocument(doc: ReceiptDocument): string {
  return JSON.stringify(doc, function (this: Record<string, unknown>, key: string, value: unknown) {
    const raw = this[key];
    return typeof raw === 'bigint' ? { [BIGINT_TAG]: raw.toString() } : value;
  });
}

export function deserializeDocument(json: string): ReceiptDocument | null {
  try {
    const parsed = JSON.parse(json, (_k, v: unknown) => {
      if (typeof v === 'object' && v !== null && BIGINT_TAG in v) {
        return BigInt(String((v as Record<string, unknown>)[BIGINT_TAG]));
      }
      return v;
    }) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const doc = parsed as Partial<ReceiptDocument>;
    if (doc.version !== 1 || typeof doc.receiptNo !== 'string' || typeof doc.totalMinor !== 'bigint') {
      return null;
    }
    assertCurrencySpec(doc.currency as CurrencySpec);
    return parsed as ReceiptDocument;
  } catch {
    return null;
  }
}

/** Basis points as exact percent text: 1250n -> "12.5%", 1500n -> "15%". */
export function rateBpText(bp: bigint | null): string {
  if (bp === null) return '';
  const whole = bp / 100n;
  const frac = (bp % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return `${whole.toString()}${frac.length > 0 ? '.' + frac : ''}%`;
}
