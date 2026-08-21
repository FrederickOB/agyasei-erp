/**
 * Canonical request form and hash (03 §3.3.3).
 *
 * The production contract is RFC 8785 (JCS) computed ON THE DEVICE at
 * enqueue time; this module is the server-side reference implementation the
 * dev clients use: object keys sorted, arrays in order, and every monetary
 * or quantity magnitude serialised as a DECIMAL STRING — a bigint stringifies
 * as its digits, and a JSON *number* is float64 on parse, which is exactly
 * the ADR-0004 trap the decimal-string rule exists to close.
 *
 * The hash is what makes "same key, different payload" detectable: a reused
 * idempotency key with a different canonical form is a client bug and is
 * refused (409 IDEMPOTENCY_KEY_REUSE), never applied.
 */
import { sha256Hex } from '@erp/db';

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  switch (typeof value) {
    case 'bigint':
      // Decimal string of minor units — never a JSON number (ADR-0004).
      return JSON.stringify(value.toString(10));
    case 'number':
      if (!Number.isFinite(value) || !Number.isInteger(value)) {
        throw new Error(`canonicalJson: non-integer number ${value} — magnitudes travel as strings`);
      }
      return JSON.stringify(value);
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new Error(`canonicalJson: cannot canonicalise a ${typeof value}`);
  }
}

/** sha256 hex over (op, canonical input) — the write_log.request_hash value. */
export function requestHashHex(op: string, input: unknown): string {
  return sha256Hex(`${op}\n${canonicalJson(input)}`);
}
