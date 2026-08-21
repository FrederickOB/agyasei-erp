/**
 * Human-facing receipt numbers, formatted (03-offline-sync §3.7.5).
 *
 * §3.7.5 is explicit that you cannot have all three of {globally sequential,
 * gapless, offline-allocable} and picks the third: per-device blocks,
 * monotonic within a device, gaps expected and reported. This module is the
 * FORMATTING half of that choice; `src/data/sequence.ts` is the allocation
 * half. Both are pure of network — a number is minted with the radio off.
 *
 * ── The uniqueness argument, which is the point of the file ───────────────
 * The server's `app.sale` carries `unique (tenant_id, location_id,
 * receipt_no)`. Two devices at one counter minting the same string is a real
 * dispute — two customers holding "the same" receipt — and, on sync, a hard
 * rejection of a sale whose goods have already left the yard.
 *
 * Disjointness therefore has to come from somewhere, and there are only two
 * places it can come from:
 *
 *   'server'  the server allocated the block under a row lock on a
 *             per-(tenant, location, sequence_key) counter, so the ranges
 *             themselves are disjoint and the printed number carries no
 *             device tag. §3.7.5's steady state.
 *   'device'  no server-allocated block was on hand — the device is new, or
 *             it burned through its block while offline, and §3.7.5 is equally
 *             explicit that "exhaustion must never stop trading". The range
 *             overlaps every other device's, so the IDENTIFIER carries the
 *             disjointness: a stable per-device tag, exactly the shape
 *             §3.7.5 gives its emergency form.
 *
 * `formatReceiptNumber` appends the device tag for a 'device'-sourced number
 * whether or not the tenant's template asked for it. That is deliberate: a
 * tenant's format template is configuration and configuration must not be
 * able to switch off a uniqueness guarantee.
 *
 * ── Nothing here is a platform constant ──────────────────────────────────
 * §3.7.5 makes the format a jurisdiction-pack value with a tenant override,
 * and the `sequence_key` vocabulary pack + tenant data rather than an enum.
 * `DEFAULT_RECEIPT_FORMAT` below is a neutral platform FALLBACK for a device
 * whose configuration has not arrived yet — a template shape, carrying no
 * tenant's prefix, no tenant's location codes and no tenant's words.
 */

export class ReceiptNumberError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptNumberError';
  }
}

/**
 * A receipt-number format, as it arrives in tenant configuration.
 *
 * `template` placeholders:
 *   `{location}`  the location's own code (tenant data, from the synced row)
 *   `{prefix}`    the document prefix the pack/tenant chose (may be empty)
 *   `{seq}`       the block-allocated number, zero-padded to `width`
 *   `{device}`    the device tag — appended automatically when the number is
 *                 device-issued and the template did not place it itself
 */
export interface ReceiptNumberFormat {
  readonly template: string;
  /** Digits the sequence is padded to. Overflow RAISES; it never wraps. */
  readonly width: number;
  /** Document prefix from the pack/tenant. Empty string when unset. */
  readonly prefix: string;
}

/**
 * The platform fallback, used only until the tenant's own format syncs.
 * Location code plus a padded counter: self-describing on a printed receipt,
 * and free of any tenant's vocabulary.
 */
export const DEFAULT_RECEIPT_FORMAT: ReceiptNumberFormat = {
  template: '{location}-{seq}',
  width: 6,
  prefix: '',
};

/** `app.sale.receipt_no` is `text`, and the wire contract caps it at 64. */
export const MAX_RECEIPT_NO_LENGTH = 64;

/**
 * Hex characters of the device's HLC node id used as its tag.
 *
 * Six is chosen against the scope that actually matters: uniqueness is per
 * `(tenant, location)`, and a location runs single-digit tills. Even ten
 * devices at one counter is 45 pairs against a 16.7M space (~3e-6). Node ids
 * are 128 random bits minted per device (`randomDeviceNode`), never derived
 * from anything a second device could reproduce. And the server's unique
 * index is the backstop: a genuine collision is a definitive rejection into
 * the visible attention state, not a silent overwrite.
 */
const DEVICE_TAG_HEX = 6;

const NODE_RE = /^[0-9a-f]{32}$/;

/** The stable, human-transcribable tag for a device. Uppercase hex. */
export function deviceTag(node32hex: string): string {
  if (!NODE_RE.test(node32hex)) {
    throw new ReceiptNumberError(`device node must be 32 lowercase hex chars, got: ${node32hex}`);
  }
  return node32hex.slice(0, DEVICE_TAG_HEX).toUpperCase();
}

export interface ReceiptNumberParts {
  /** The location's own code — tenant data, never a constant in this app. */
  readonly locationCode: string;
  /** The number drawn from the block. */
  readonly seq: bigint;
  /** This device's 32-hex node id. */
  readonly deviceNode: string;
  /** Where the block came from — see the file header. */
  readonly source: 'server' | 'device';
}

/**
 * Render one receipt number. Pure: same inputs, same string, no clock, no
 * database, no network.
 */
export function formatReceiptNumber(
  format: ReceiptNumberFormat,
  parts: ReceiptNumberParts,
): string {
  if (!Number.isInteger(format.width) || format.width < 1) {
    throw new ReceiptNumberError(`receipt number width must be a positive integer`);
  }
  if (parts.seq <= 0n) {
    throw new ReceiptNumberError(`receipt sequence must be positive, got ${parts.seq.toString()}`);
  }
  const digits = parts.seq.toString(10);
  if (digits.length > format.width) {
    // §3.7.5: "the platform raises rather than wrapping when n exceeds the
    // pack's width". A wrapped number is a silent duplicate.
    throw new ReceiptNumberError(
      `receipt sequence ${digits} exceeds the configured width of ${format.width}`,
    );
  }
  const tag = deviceTag(parts.deviceNode);
  const seq = digits.padStart(format.width, '0');

  let out = format.template
    .replaceAll('{location}', parts.locationCode)
    .replaceAll('{prefix}', format.prefix)
    .replaceAll('{seq}', seq)
    .replaceAll('{device}', parts.source === 'device' ? tag : '');

  // Collapse the separators a blank {prefix} or a blank {device} left behind,
  // so an unset prefix reads as `TKM-000123`, not `TKM--000123`.
  out = out.replace(/-{2,}/g, '-').replace(/^-+/, '').replace(/-+$/, '');

  if (parts.source === 'device' && !out.endsWith(tag)) {
    // Configuration cannot switch off the uniqueness guarantee: a self-issued
    // number ALWAYS carries the tag that makes it un-collidable.
    out = `${out}-${tag}`;
  }

  if (out.length === 0) {
    throw new ReceiptNumberError('receipt number template produced an empty string');
  }
  if (out.length > MAX_RECEIPT_NO_LENGTH) {
    throw new ReceiptNumberError(
      `receipt number "${out}" is ${out.length} chars; the contract caps it at ${MAX_RECEIPT_NO_LENGTH}`,
    );
  }
  return out;
}

/** Parse a stored configuration record into a format, tolerating partials. */
export function parseReceiptFormat(raw: unknown): ReceiptNumberFormat {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_RECEIPT_FORMAT;
  const rec = raw as Record<string, unknown>;
  const template = typeof rec['template'] === 'string' && rec['template'].length > 0
    ? rec['template']
    : DEFAULT_RECEIPT_FORMAT.template;
  const widthRaw = rec['width'];
  const width =
    typeof widthRaw === 'number' && Number.isInteger(widthRaw) && widthRaw > 0
      ? widthRaw
      : DEFAULT_RECEIPT_FORMAT.width;
  const prefix = typeof rec['prefix'] === 'string' ? rec['prefix'] : DEFAULT_RECEIPT_FORMAT.prefix;
  return { template, width, prefix };
}
