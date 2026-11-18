/**
 * The ESC/POS encoder, pinned with golden bytes. The two `.hex` fixtures were
 * decoded by hand when first generated (ESC @, code page, centred bold 2x2
 * header, 32/48-column rules, two-column money lines, feed, partial cut); a
 * change to them is a change to what a printer receives and must be deliberate.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CODE_PAGES, canEncode, toPrintable } from '../src/printing/codepage';
import { DEFAULT_ENCODE_OPTIONS, encodeLayout, encodeReceipt, toHex, QR_MAX_BYTES } from '../src/printing/escpos';
import { COLUMNS_FOR_PAPER_MM, layoutReceipt, pairLines, wrapText } from '../src/printing/layout';
import { sampleDoc } from './helpers/receipt-fixtures';

const here = path.dirname(fileURLToPath(import.meta.url));
const golden = (name: string): string => readFileSync(path.join(here, 'golden', name), 'utf8').trim();

describe('golden bytes', () => {
  it('58 mm (32 columns) receipt', () => {
    const bytes = encodeReceipt(sampleDoc(), { ...DEFAULT_ENCODE_OPTIONS, codePage: 'ascii' });
    expect(toHex(bytes)).toBe(golden('receipt-58mm-ascii.hex'));
  });

  it('80 mm (48 columns) receipt', () => {
    const bytes = encodeReceipt(sampleDoc(), { ...DEFAULT_ENCODE_OPTIONS, codePage: 'ascii', paperWidthMm: 80 });
    expect(toHex(bytes)).toBe(golden('receipt-80mm-ascii.hex'));
  });

  it('is deterministic: the same document encodes to the same bytes every time', () => {
    const a = toHex(encodeReceipt(sampleDoc(), DEFAULT_ENCODE_OPTIONS));
    const b = toHex(encodeReceipt(sampleDoc(), DEFAULT_ENCODE_OPTIONS));
    expect(a).toBe(b);
  });

  it('bold, size, alignment, rule, QR, drawer kick and full cut', () => {
    const bytes = encodeLayout(
      [
        { kind: 'text', text: 'Hi', align: 'right', bold: true, wide: 2, tall: 1 },
        { kind: 'qr', payload: 'ABC' },
        { kind: 'rule', char: '=' },
      ],
      {
        ...DEFAULT_ENCODE_OPTIONS,
        codePage: 'ascii',
        cut: 'full',
        drawerKick: { pin: 1, onUnits: 10, offUnits: 20 },
        qrModuleSize: 6,
        qrErrorLevel: 'H',
        trailingLines: 1,
      },
    );
    expect(toHex(bytes)).toBe(
      [
        '1b40', // ESC @
        '1b7400', // ESC t 0
        '1b70010a14', // ESC p pin1 10 20 — drawer pulse
        '1b6102', // right
        '1b4501', // bold on
        '1d2110', // GS ! width x2
        '4869', '0a', // "Hi" LF
        '1b6101', // centre for the QR
        '1d286b04003141320' + '0', // QR model 2
        '1d286b0300314306', // module size 6
        '1d286b0300314533', // error correction H
        '1d286b06003150304142' + '43', // store "ABC"
        '1d286b0300315130', // print
        '0a',
        '1b6100', '1b4500', '1d2100', // back to left, plain, 1x1
        '3d'.repeat(32), '0a', // 32-column rule of '='
        '1b6401', // feed 1
        '1d5600', // full cut
      ].join(''),
    );
  });

  it('cut modes: none emits no cut, partial is GS V 1', () => {
    const none = toHex(encodeLayout([], { ...DEFAULT_ENCODE_OPTIONS, cut: 'none', trailingLines: 0 }));
    const partial = toHex(encodeLayout([], { ...DEFAULT_ENCODE_OPTIONS, cut: 'partial', trailingLines: 0 }));
    expect(none.endsWith('1d5601')).toBe(false);
    expect(partial.endsWith('1d5601')).toBe(true);
  });

  it('a drawer kick is only emitted when asked for', () => {
    const off = toHex(encodeReceipt(sampleDoc(), { ...DEFAULT_ENCODE_OPTIONS, drawerKick: null }));
    const on = toHex(encodeReceipt(sampleDoc(), { ...DEFAULT_ENCODE_OPTIONS, drawerKick: { pin: 0, onUnits: 25, offUnits: 250 } }));
    expect(off.includes('1b70')).toBe(false);
    expect(on.includes('1b700019fa')).toBe(true);
  });

  it('refuses to send an oversized QR rather than overrun a small printer buffer', () => {
    const big = 'x'.repeat(QR_MAX_BYTES + 1);
    const hex = toHex(
      encodeLayout([{ kind: 'qr', payload: big }], { ...DEFAULT_ENCODE_OPTIONS, cut: 'none', trailingLines: 0 }),
    );
    expect(hex.includes('1d286b')).toBe(false);
  });
});

describe('code pages and the currency sign', () => {
  it('encodes accented text through CP437 and substitutes ? for the unprintable', () => {
    const bytes = encodeLayout(
      [{ kind: 'text', text: 'Café £ 中', align: 'left', bold: false, wide: 1, tall: 1 }],
      { ...DEFAULT_ENCODE_OPTIONS, cut: 'none', trailingLines: 0 },
    );
    expect(toHex(bytes)).toBe('1b401b740043616682209c203f0a1b6400');
  });

  it('prints the pack currency CODE when its sign is not in the printer code page', () => {
    // The sample pack's sign is U+20B5, which neither table has.
    expect(canEncode(CODE_PAGES.cp437, '₵')).toBe(false);
    const lines = layoutReceipt(sampleDoc(), { columns: 32, page: CODE_PAGES.cp437 });
    const total = lines.find((l) => l.kind === 'text' && l.text.startsWith('TOTAL'));
    expect(total?.kind === 'text' && total.text).toBe('TOTAL               TST 14260.00');
    expect(toHex(encodeReceipt(sampleDoc(), DEFAULT_ENCODE_OPTIONS)).includes('e282b5')).toBe(false);
  });

  it('prints the sign itself when the code page has it (no assumption about which sign)', () => {
    const doc = sampleDoc({ currency: { code: 'TST', symbol: '£', scale: 2 } });
    const hex = toHex(encodeReceipt(doc, DEFAULT_ENCODE_OPTIONS));
    expect(hex.includes('9c31343236302e3030')).toBe(true); // 0x9c = pound sign, then 14260.00
  });

  it('toPrintable strips diacritics to their base letter where the page lacks them', () => {
    expect(toPrintable(CODE_PAGES.ascii, 'café')).toBe('cafe');
    expect(toPrintable(CODE_PAGES.cp437, 'café')).toBe('café');
  });
});

describe('money formatting comes from the document, not a constant', () => {
  it('renders at the document scale (0, 2 and 3 digits) without assuming 100', () => {
    for (const [scale, expected] of [
      [0, '14260'],
      [2, '142.60'],
      [3, '14.260'],
    ] as const) {
      const doc = sampleDoc({
        currency: { code: 'TST', symbol: 'T', scale },
        totalMinor: 14260n,
        taxLines: [],
        netMinor: null,
        tenders: [{ method: 'Cash', amountMinor: 14260n, reference: null }],
        changeMinor: 0n,
        lines: [],
      });
      const lines = layoutReceipt(doc, { columns: 48, page: CODE_PAGES.ascii });
      const total = lines.find((l) => l.kind === 'text' && l.text.startsWith('TOTAL'));
      expect(total?.kind === 'text' && total.text.endsWith(`T${expected}`)).toBe(true);
    }
  });
});

describe('text wrapping and columns', () => {
  it('wraps on words and hard-breaks a word longer than the line', () => {
    expect(wrapText('twelve millimetre reinforcement bar', 16)).toEqual(['twelve', 'millimetre', 'reinforcement', 'bar']);
    expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrapText('', 10)).toEqual(['']);
  });

  it('pairs two columns flush left and right, and wraps the left when they collide', () => {
    expect(pairLines('Total', '12.00', 20)).toEqual(['Total          12.00']);
    expect(pairLines('A very long product name', '9.00', 16)).toEqual(['A very long', 'product', 'name        9.00']);
  });

  it('no layout row exceeds the paper width, at either width', () => {
    const doc = sampleDoc({
      lines: Array.from({ length: 5 }, (_, i) => ({
        name: 'Extremely long product description number ' + String(i),
        qtyScaled: 1234n,
        qtyScale: 3,
        uomLabel: 'metre',
        unitPriceE4: 999_999_999n,
        amountMinor: 123_456_789n,
      })),
    });
    for (const mm of [58, 80] as const) {
      const cols = COLUMNS_FOR_PAPER_MM[mm];
      for (const line of layoutReceipt(doc, { columns: cols, page: CODE_PAGES.cp437 })) {
        if (line.kind === 'text') expect(line.text.length).toBeLessThanOrEqual(Math.floor(cols / line.wide));
      }
    }
  });
});

describe('what a reprint reproduces', () => {
  it('shows the original tax lines and totals, and only adds a copy marker', () => {
    const doc = sampleDoc();
    const original = layoutReceipt(doc, { columns: 32, page: CODE_PAGES.cp437 });
    const copy = layoutReceipt(doc, { columns: 32, page: CODE_PAGES.cp437, isCopy: true });
    const text = (ls: typeof original): string[] => ls.flatMap((l) => (l.kind === 'text' ? [l.text] : []));
    expect(text(copy)).toContain('COPY - REPRINT');
    expect(text(copy).filter((t) => t !== 'COPY - REPRINT')).toEqual(text(original));
    expect(text(original).some((t) => t.startsWith('Tax one 15%'))).toBe(true);
  });

  it('prints the pack slot only when the pack configured one (no invented statutory fields)', () => {
    const plain = layoutReceipt(sampleDoc(), { columns: 32, page: CODE_PAGES.ascii });
    expect(plain.some((l) => l.kind === 'qr')).toBe(false);
    const withSlot = layoutReceipt(
      sampleDoc({
        pack: { slot: 'configured', fields: [{ label: 'Pack field', value: 'XYZ' }], qr: { payload: 'https://example.invalid/r/1' } },
      }),
      { columns: 32, page: CODE_PAGES.ascii },
    );
    expect(withSlot.some((l) => l.kind === 'qr')).toBe(true);
    expect(withSlot.some((l) => l.kind === 'text' && l.text.startsWith('Pack field'))).toBe(true);
  });
});
