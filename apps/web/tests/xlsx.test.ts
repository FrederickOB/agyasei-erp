// @vitest-environment jsdom
/**
 * The dependency-free .xlsx reader and writer (src/lib/xlsx.ts).
 *
 * What must hold: the template this app writes reads back cell for cell; a
 * workbook written the way Excel writes one (deflated parts, a shared-string
 * table, numbers as binary-double text, skipped rows) reads as the person
 * sees it; and number cells become exact decimal TEXT — the one rounding is
 * to Excel's own 15 significant digits, done on the text, never via a float.
 */
import { describe, expect, it } from 'vitest';
import { crc32, numberCellText, readXlsxRows, writeXlsx, XlsxError } from '../src/lib/xlsx';

describe('numberCellText — a double’s text, as the person typed it', () => {
  it.each([
    ['1250.5', '1250.5'],
    ['1.1000000000000001', '1.1'],
    ['0.30000000000000004', '0.3'],
    ['980.125', '980.125'],
    ['1E-3', '0.001'],
    ['1.5E+3', '1500'],
    ['12', '12'],
    ['0', '0'],
    ['-4.25', '-4.25'],
    ['0.99999999999999989', '1'],
    ['123456789012345678', '123456789012346000'],
  ])('%s → %s', (raw, text) => {
    expect(numberCellText(raw)).toBe(text);
  });
});

describe('the template round-trips', () => {
  it('writes text cells that read back exactly, from the sheet asked for', async () => {
    const bytes = writeXlsx([
      { name: 'How to fill', rows: [['Column', 'What'], ['Name', 'The name']] },
      {
        name: 'Products',
        header: true,
        rows: [
          ['Product name *', 'Price: Counter & yard', 'Notes'],
          ['Paint “4L” <white>', '1250.50', 'line one\nline two'],
        ],
        validations: [{ range: 'B2:B10', source: 'Lists!$A$2:$A$3', strict: true }],
      },
    ]);
    const rows = await readXlsxRows(bytes);
    expect(rows).toEqual([
      ['Product name *', 'Price: Counter & yard', 'Notes'],
      ['Paint “4L” <white>', '1250.50', 'line one\nline two'],
    ]);
    expect(await readXlsxRows(bytes, 'How to fill')).toEqual([['Column', 'What'], ['Name', 'The name']]);
  });

  it('refuses something that is not a workbook, in words', async () => {
    await expect(readXlsxRows(new TextEncoder().encode('Name,Price\nX,1'))).rejects.toBeInstanceOf(XlsxError);
  });
});

/** A ZIP whose parts are DEFLATED, as Excel writes them. */
async function zipDeflated(parts: Record<string, string>): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const names = Object.keys(parts);
  for (const n of names) {
    const raw = enc.encode(parts[n]!);
    const source = new ReadableStream<BufferSource>({
      start(c) {
        c.enqueue(raw);
        c.close();
      },
    });
    const stream = source.pipeThrough(new CompressionStream('deflate-raw'));
    const data = new Uint8Array(await new Response(stream).arrayBuffer());
    const name = enc.encode(n);
    const crc = crc32(raw);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, 8, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, data);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(10, 8, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, data.length, true);
    dir.setUint32(24, raw.length, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, names.length, true);
  end.setUint16(10, names.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let at = 0;
  for (const c of all) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

describe('a workbook as Excel writes it', () => {
  it('reads deflated parts, shared strings, rich text, numbers and a skipped row', async () => {
    const bytes = await zipDeflated({
      '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
      'xl/workbook.xml': `<workbook xmlns="${NS}" xmlns:r="${RNS}"><sheets><sheet name="Lists" sheetId="2" r:id="rId2"/><sheet name="products" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels':
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="x"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml" Type="x"/></Relationships>',
      'xl/sharedStrings.xml': `<sst xmlns="${NS}"><si><t>Product name</t></si><si><t>Price</t></si><si><r><t>Blue </t></r><r><t>paint</t></r></si></sst>`,
      'xl/worksheets/sheet1.xml':
        `<worksheet xmlns="${NS}"><sheetData>` +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="3"><c r="A3" t="s"><v>2</v></c><c r="C3"><v>1.1000000000000001</v></c></row>' +
        '<row r="4"><c r="A4" t="inlineStr"><is><t>Gravel</t></is></c><c r="B4"><v>1250.5</v></c><c r="D4" t="b"><v>1</v></c></row>' +
        '</sheetData></worksheet>',
      'xl/worksheets/sheet2.xml': `<worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Units</t></is></c></row></sheetData></worksheet>`,
    });
    // "Products" is found case-insensitively, though it is the second sheet.
    expect(await readXlsxRows(bytes)).toEqual([
      ['Product name', 'Price'],
      [],
      ['Blue paint', '', '1.1'],
      ['Gravel', '1250.5', '', 'TRUE'],
    ]);
    expect(await readXlsxRows(bytes, 'Lists')).toEqual([['Units']]);
  });
});
