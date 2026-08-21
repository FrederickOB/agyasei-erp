/**
 * Human-facing document numbers, allocated offline (03-offline-sync §3.7.5).
 *
 * ONE rendering of a tenant's number format, shared by the server, the device
 * and the drills. That sharing is the point: a receipt number is printed on the
 * device and stored on the server, and if the two render differently the paper
 * in a customer's hand stops matching the books — which is the same class of
 * failure conflict #14 is about, arriving by a different road.
 *
 * Nothing here reads a jurisdiction, a country or a tenant. The format string,
 * the prefix and the location code are all VALUES supplied by the caller from
 * `app.sequence_counter` (tenant configuration, defaulted from the
 * jurisdiction pack — ADR-0007, CLAUDE.md §2.5/§2.9). A branch on any of them
 * would mean the pack is under-specified.
 *
 * Numbers are bigint throughout. A receipt number is not money, but it is a
 * magnitude that must survive a JSON round-trip exactly, and float64 stops
 * being exact at 2^53 — the same reasoning as ADR-0004, applied to counters.
 */

/** The tenant's rendering configuration for one (location, sequence_key). */
export interface NumberFormatSpec {
  /** e.g. '{location_code}-{prefix}-{n:06d}'. Tenant configuration. */
  readonly format: string;
  /** The location's own code — makes a printed receipt self-describing. */
  readonly locationCode: string;
  /** e.g. 'RCT'. */
  readonly prefix: string;
}

/**
 * The pack's width was exceeded. §3.7.5: "the platform raises rather than
 * wrapping when `n` exceeds the pack's width" — a wrapped number is a number
 * two customers hold, arriving silently.
 */
export class SequenceOverflowError extends Error {
  constructor(
    readonly n: bigint,
    readonly width: number,
  ) {
    super(
      `sequence number ${n} does not fit the format's ${width}-digit width — ` +
        `the pack's overflow behaviour is to raise, never to wrap (03 §3.7.5)`,
    );
    this.name = 'SequenceOverflowError';
  }
}

export class SequenceFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SequenceFormatError';
  }
}

/** `{n}` or `{n:06d}` — the only placeholder that carries a width. */
const N_PLACEHOLDER = /\{n(?::0(\d+)d)?\}/g;
const KNOWN_PLACEHOLDER = /\{(location_code|prefix|n(?::0\d+d)?)\}/g;
const ANY_PLACEHOLDER = /\{([^}]*)\}/g;

/**
 * The declared width of a format's `{n}` slot, or 0 when it is unpadded (no
 * width declared ⇒ no overflow ceiling).
 */
export function declaredWidth(format: string): number {
  N_PLACEHOLDER.lastIndex = 0;
  const m = N_PLACEHOLDER.exec(format);
  if (m === null) {
    throw new SequenceFormatError(`number format '${format}' has no {n} placeholder`);
  }
  return m[1] === undefined ? 0 : Number(m[1]);
}

/**
 * Render one number. Substitutes `{location_code}`, `{prefix}` and `{n}` /
 * `{n:0Nd}`; an unknown placeholder is an error rather than literal output,
 * because a format typo must surface at the counter, not on a printed receipt.
 */
export function renderNumber(spec: NumberFormatSpec, n: bigint): string {
  if (n < 1n) throw new SequenceFormatError(`sequence number must be >= 1, got ${n}`);

  ANY_PLACEHOLDER.lastIndex = 0;
  for (let m = ANY_PLACEHOLDER.exec(spec.format); m !== null; m = ANY_PLACEHOLDER.exec(spec.format)) {
    KNOWN_PLACEHOLDER.lastIndex = 0;
    if (!KNOWN_PLACEHOLDER.test(`{${m[1] ?? ''}}`)) {
      throw new SequenceFormatError(
        `number format '${spec.format}' has unknown placeholder '{${m[1] ?? ''}}' ` +
          `(known: {location_code}, {prefix}, {n}, {n:0Nd})`,
      );
    }
  }

  const width = declaredWidth(spec.format);
  const digits = n.toString(10);
  if (width > 0 && digits.length > width) throw new SequenceOverflowError(n, width);

  return spec.format
    .replace(/\{location_code\}/g, spec.locationCode)
    .replace(/\{prefix\}/g, spec.prefix)
    .replace(N_PLACEHOLDER, width > 0 ? digits.padStart(width, '0') : digits);
}

/**
 * The device-derived suffix §3.7.5 specifies for the emergency form
 * (`SUN-RCT-004999-D3F`). Three hex characters of the device id: enough to
 * separate the tills at one location, short enough to read aloud over a phone.
 */
export function deviceSuffix(deviceId: string): string {
  const hex = deviceId.replace(/[^0-9a-fA-F]/g, '');
  if (hex.length < 3) throw new SequenceFormatError(`device id '${deviceId}' has too few hex digits`);
  return hex.slice(0, 3).toUpperCase();
}

/**
 * The emergency form: a number issued outside a live block, marked as such on
 * the receipt AND on the record. §3.7.5 — "Exhaustion must never stop trading",
 * and the exceptional case is visibly exceptional.
 *
 * `discriminator` disambiguates two emergency numbers from the same device
 * (the collision path uses the sale id): without it, one device issuing two
 * emergency numbers from the same base would collide with itself.
 */
export function emergencyNumber(
  base: string,
  deviceId: string,
  discriminator?: string,
): string {
  const suffix = deviceSuffix(deviceId);
  if (discriminator === undefined) return `${base}-${suffix}`;
  const tail = discriminator.replace(/[^0-9a-fA-F]/g, '').slice(-4).toUpperCase();
  return `${base}-${suffix}${tail}`;
}

// ---------------------------------------------------------------------------
// Block arithmetic. One definition, so the device and the server agree on what
// "exhausted" and "remaining" mean.
// ---------------------------------------------------------------------------

export interface BlockRange {
  readonly blockStart: bigint;
  /** Count of numbers in the block; always >= 1. */
  readonly blockSize: number;
}

/** Last number in the block, inclusive. */
export function blockEnd(block: BlockRange): bigint {
  return block.blockStart + BigInt(block.blockSize) - 1n;
}

/**
 * The next number to issue, or null when the block is spent.
 * `consumedUpto` is the highest number ALREADY issued; null means none.
 */
export function nextNumber(block: BlockRange, consumedUpto: bigint | null): bigint | null {
  const next = consumedUpto === null ? block.blockStart : consumedUpto + 1n;
  return next > blockEnd(block) ? null : next;
}

/** How many numbers are left. */
export function remaining(block: BlockRange, consumedUpto: bigint | null): bigint {
  const next = consumedUpto === null ? block.blockStart : consumedUpto + 1n;
  const left = blockEnd(block) - next + 1n;
  return left < 0n ? 0n : left;
}

/**
 * Is it time to ask for a replacement? §3.7.5, corrected on review: the trigger
 * is DAYS OF OBSERVED THROUGHPUT, not a fixed percentage — 500 numbers is three
 * to four days at a flagship till, not "roughly two weeks". Callers pass the
 * location's observed daily rate; the percentage fallback exists only for a
 * till with no observed history yet.
 */
export function needsReplacement(
  block: BlockRange,
  consumedUpto: bigint | null,
  opts: { readonly observedPerDay?: number; readonly minDays?: number } = {},
): boolean {
  const left = remaining(block, consumedUpto);
  if (left === 0n) return true;
  const perDay = opts.observedPerDay;
  if (perDay !== undefined && perDay > 0) {
    const minDays = opts.minDays ?? 3;
    return left < BigInt(Math.ceil(perDay * minDays));
  }
  return left * 5n <= BigInt(block.blockSize); // no history yet: the 20% fallback
}
