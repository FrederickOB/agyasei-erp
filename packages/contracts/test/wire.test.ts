import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEVICE_OP_KINDS,
  HLC_WIRE_RE,
  MAX_UPLOAD_BATCH,
  mutationEnvelopeSchema,
  uploadBodySchema,
  wire,
  zBusinessDate,
  zScaledInt,
  zScaledIntNonNeg,
  zScaledIntPos,
  zUuid,
  type CreateSaleInput,
} from '../src/index.js';

const KEY = '018f3a1e-0000-7000-8000-0000000000ff';
const HLC = '1755600000000-00001-0123456789abcdef0123456789abcdef';

describe('scaled-integer primitives', () => {
  it('zScaledInt accepts signed magnitudes as bigint', () => {
    expect(zScaledInt.parse('-4200')).toBe(-4200n);
    expect(zScaledInt.parse('0')).toBe(0n);
  });

  it('zScaledIntNonNeg refuses a negative', () => {
    expect(zScaledIntNonNeg.safeParse('-1').success).toBe(false);
    expect(zScaledIntNonNeg.parse('0')).toBe(0n);
  });

  it('zScaledIntPos refuses zero', () => {
    expect(zScaledIntPos.safeParse('0').success).toBe(false);
    expect(zScaledIntPos.parse('1')).toBe(1n);
  });

  it('every primitive refuses a JSON number, a float and an exponent', () => {
    for (const schema of [zScaledInt, zScaledIntNonNeg, zScaledIntPos]) {
      expect(schema.safeParse(1).success).toBe(false);
      expect(schema.safeParse('1.5').success).toBe(false);
      expect(schema.safeParse('1e3').success).toBe(false);
      expect(schema.safeParse('1_000').success).toBe(false);
      expect(schema.safeParse('').success).toBe(false);
    }
  });

  it('wire() is the exact inverse, past float64 range', () => {
    const v = 9007199254740993n;
    expect(zScaledInt.parse(wire(v))).toBe(v);
    expect(wire(-1n)).toBe('-1');
  });
});

describe('zUuid and zBusinessDate', () => {
  it('accepts a UUIDv7 and refuses a non-uuid', () => {
    expect(zUuid.safeParse(KEY).success).toBe(true);
    expect(zUuid.safeParse('not-a-uuid').success).toBe(false);
  });

  it('accepts a calendar day and refuses anything else', () => {
    expect(zBusinessDate.safeParse('2026-08-20').success).toBe(true);
    for (const bad of ['2026-8-20', '20/08/2026', '2026-08-20T00:00:00Z', '']) {
      expect(zBusinessDate.safeParse(bad).success).toBe(false);
    }
  });

  it('refuses a day that does not exist, rather than rolling it over', () => {
    // Date.parse('2026-02-30T00:00:00Z') SUCCEEDS in V8 and yields 2 March.
    // Left unchecked this reaches Postgres as `$1::date`, raises, and comes
    // back as a RETRYABLE INTERNAL_SERVER_ERROR — a definitively bad payload
    // retried forever instead of dead-lettered (03 §3.3.4).
    for (const bad of ['2026-02-30', '2026-04-31', '2026-13-40', '2026-00-10']) {
      expect(zBusinessDate.safeParse(bad).success).toBe(false);
    }
    // …and a real leap day still passes.
    expect(zBusinessDate.safeParse('2028-02-29').success).toBe(true);
  });
});

describe('the mutation envelope (CLAUDE.md §2.2)', () => {
  it('requires the idempotency key and accepts an untrusted clock claim', () => {
    expect(mutationEnvelopeSchema.safeParse({ idempotencyKey: KEY }).success).toBe(true);
    expect(
      mutationEnvelopeSchema.safeParse({ idempotencyKey: KEY, claimedHlc: HLC }).success,
    ).toBe(true);
    expect(mutationEnvelopeSchema.safeParse({}).success).toBe(false);
  });

  it('pins the HLC wire projection: 13ms · 5-counter · 32-hex node', () => {
    expect(HLC_WIRE_RE.source).toBe('^[0-9]{13}-[0-9]{5}-[0-9a-f]{32}$');
    expect(HLC_WIRE_RE.test(HLC)).toBe(true);
    expect(HLC_WIRE_RE.test('1755600000000-1-0123456789abcdef0123456789abcdef')).toBe(false);
  });
});

describe('the /sync/upload envelope', () => {
  const op = { idempotency_key: KEY, kind: 'sale.create', payload: {} };

  it('accepts a batch and refuses an empty one', () => {
    expect(uploadBodySchema.safeParse({ ops: [op] }).success).toBe(true);
    expect(uploadBodySchema.safeParse({ ops: [] }).success).toBe(false);
  });

  it('caps the batch at the one shared limit', () => {
    const fits = Array.from({ length: MAX_UPLOAD_BATCH }, () => op);
    expect(uploadBodySchema.safeParse({ ops: fits }).success).toBe(true);
    expect(uploadBodySchema.safeParse({ ops: [...fits, op] }).success).toBe(false);
  });

  it('refuses an unknown envelope key', () => {
    expect(uploadBodySchema.safeParse({ ops: [op], tenant_id: KEY }).success).toBe(false);
    expect(uploadBodySchema.safeParse({ ops: [{ ...op, tid: KEY }] }).success).toBe(false);
  });

  it('lets an unrecognised kind through the envelope so it is acked per-op, not batch-rejected', () => {
    expect(uploadBodySchema.safeParse({ ops: [{ ...op, kind: 'nonsense.op' }] }).success).toBe(true);
  });

  it('names the uploadable operations without naming a tenant', () => {
    expect(DEVICE_OP_KINDS).toContain('sale.create');
    expect(DEVICE_OP_KINDS.every((k) => k.includes('.'))).toBe(true);
  });
});

describe('the package stays importable from the browser bundle', () => {
  const srcDir = fileURLToPath(new URL('../src/', import.meta.url));

  it('imports nothing but zod and its own siblings', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(`${srcDir}${file}`, 'utf8');
      for (const match of text.matchAll(/from\s+'([^']+)'/g)) {
        const spec = match[1]!;
        if (spec === 'zod' || spec.startsWith('./') || spec.startsWith('../')) continue;
        offenders.push(`${file}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the inferred types give the client compile-time safety', () => {
  it('accepts a typed payload built the way the PWA must build one', () => {
    const payload: CreateSaleInput = {
      idempotencyKey: KEY,
      claimedHlc: HLC,
      locationId: '018f3a1e-0000-7000-8000-000000000001',
      priceListCode: 'RETAIL',
      receiptNo: 'SUN-RCT-004312',
      cashSessionId: '018f3a1e-0000-7000-8000-0000000000aa',
      tenders: [{ methodId: '018f3a1e-0000-7000-8000-0000000000c1', settlement: 'IMMEDIATE', amountMinor: '2550' }],
      clientTotalMinor: '2550',
      lines: [{ productId: '018f3a1e-0000-7000-8000-000000000002', qty: '3000' }],
    };
    expect(mutationEnvelopeSchema.safeParse({ idempotencyKey: payload.idempotencyKey }).success).toBe(
      true,
    );
  });
});
