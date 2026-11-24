/**
 * Just enough of the Excel file format (.xlsx) to hand a person a template
 * and read back what they typed into it — no dependency, because a
 * spreadsheet library is the heaviest thing a PWA on a low-end tablet could
 * download for a screen used a few times a year.
 *
 * An .xlsx file is a ZIP of XML parts. WRITING stores the parts uncompressed
 * (method 0, which every reader accepts). READING accepts stored and
 * deflated parts; a deflated part is inflated by the platform's own
 * DecompressionStream, wrapped as a one-member gzip so it works on every
 * browser and Node version that has the stream at all (the ZIP directory
 * already carries the CRC-32 and length a gzip trailer needs).
 *
 * NUMBERS ARE THE ONE BOUNDARY WITH A ROUNDING. Excel stores a typed number
 * as a binary double and writes it out with up to 17 significant digits, so
 * a cell showing 1.1 can arrive as "1.1000000000000001". Such text is
 * rounded, half-up and as TEXT, to 15 significant digits — the precision
 * Excel itself displays — before anything else reads it. Nothing here turns
 * a cell into a JavaScript number (ADR-0004).
 */

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipPart {
  readonly name: string;
  readonly data: Uint8Array;
}

/** A ZIP archive with every part stored (method 0). */
export function zipStore(parts: readonly ZipPart[]): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const part of parts) {
    const name = enc.encode(part.name);
    const crc = crc32(part.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, 0, true);
    local.setUint16(12, 0x21, true); // 1980-01-01
    local.setUint32(14, crc, true);
    local.setUint32(18, part.data.length, true);
    local.setUint32(22, part.data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), name, part.data);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true);
    dir.setUint16(10, 0, true);
    dir.setUint16(12, 0, true);
    dir.setUint16(14, 0x21, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, part.data.length, true);
    dir.setUint32(24, part.data.length, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), name);
    offset += 30 + name.length + part.data.length;
  }
  const dirSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, parts.length, true);
  end.setUint16(10, parts.length, true);
  end.setUint32(12, dirSize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of all) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
}

function zipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxError('This is not an Excel (.xlsx) file.');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new XlsxError('The Excel file is damaged.');
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    out.push({
      name: dec.decode(bytes.subarray(p + 46, p + 46 + nameLen)),
      method: view.getUint16(p + 10, true),
      crc: view.getUint32(p + 16, true),
      compressedSize: view.getUint32(p + 20, true),
      size: view.getUint32(p + 24, true),
      localOffset: view.getUint32(p + 42, true),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflateRaw(data: Uint8Array, crc: number, size: number): Promise<Uint8Array> {
  // One gzip member around the raw DEFLATE data: header, data, CRC-32, size.
  const gz = new Uint8Array(10 + data.length + 8);
  gz.set([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff], 0);
  gz.set(data, 10);
  const tail = new DataView(gz.buffer, 10 + data.length, 8);
  tail.setUint32(0, crc, true);
  tail.setUint32(4, size >>> 0, true);
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(gz);
      controller.close();
    },
  });
  const stream = source.pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readPart(bytes: Uint8Array, entry: ZipEntry): Promise<string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const p = entry.localOffset;
  if (view.getUint32(p, true) !== 0x04034b50) throw new XlsxError('The Excel file is damaged.');
  const start = p + 30 + view.getUint16(p + 26, true) + view.getUint16(p + 28, true);
  const raw = bytes.subarray(start, start + entry.compressedSize);
  let data: Uint8Array;
  if (entry.method === 0) data = raw;
  else if (entry.method === 8) data = await inflateRaw(raw, entry.crc, entry.size);
  else throw new XlsxError('The Excel file uses a compression this screen cannot read. Save it again, or as CSV.');
  return new TextDecoder().decode(data);
}

export class XlsxError extends Error {}

// ---------------------------------------------------------------------------
// Reading a workbook
// ---------------------------------------------------------------------------

const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) throw new XlsxError('The Excel file is damaged.');
  return doc;
}

function elements(parent: Document | Element, local: string): Element[] {
  return Array.from(parent.getElementsByTagNameNS(SHEET_NS, local));
}

/** "AB12" → 27 (0-based column index). */
function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '').toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * A number cell's text as plain decimal text, rounded to at most 15
 * significant digits half-up, exponent expanded, trailing zeros dropped —
 * all on the TEXT, never via a float.
 */
export function numberCellText(v: string): string {
  const m = /^(-?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(v.trim());
  if (!m) return v.trim();
  const sign = m[1]!;
  let digits = (m[2] ?? '') + (m[3] ?? '');
  // Position of the decimal point within `digits`.
  let point = (m[2] ?? '').length + Number(m[4] ?? '0');
  // Strip leading zeros, keeping the point where it belongs.
  const lead = /^0*/.exec(digits)![0].length;
  digits = digits.slice(lead);
  point -= lead;
  if (digits === '' || /^0+$/.test(digits)) return '0';
  if (digits.length > 15) {
    const keep = digits.slice(0, 15).split('').map(Number);
    if (Number(digits[15]) >= 5) {
      let i = keep.length - 1;
      while (i >= 0) {
        const bumped = (keep[i] ?? 0) + 1;
        if (bumped < 10) {
          keep[i] = bumped;
          break;
        }
        keep[i] = 0;
        i -= 1;
      }
      if (i < 0) {
        keep.unshift(1);
        point += 1;
      }
    }
    digits = keep.join('').slice(0, 15 + (keep.length > 15 ? 1 : 0));
  }
  let whole: string;
  let frac: string;
  if (point <= 0) {
    whole = '0';
    frac = '0'.repeat(-point) + digits;
  } else if (point >= digits.length) {
    whole = digits + '0'.repeat(point - digits.length);
    frac = '';
  } else {
    whole = digits.slice(0, point);
    frac = digits.slice(point);
  }
  frac = frac.replace(/0+$/, '');
  return `${sign}${whole}${frac === '' ? '' : `.${frac}`}`;
}

function textOf(el: Element | undefined): string {
  if (!el) return '';
  // Rich text: every <t> run, skipping phonetic guides (<rPh>).
  return elements(el, 't')
    .filter((t) => t.parentElement?.localName !== 'rPh')
    .map((t) => t.textContent ?? '')
    .join('');
}

/**
 * The rows of the sheet named `preferred` (case-insensitive), else the first
 * sheet, as text. Row positions are kept — a blank row in the sheet is a
 * blank row here — so a line number means the same row the person sees.
 */
export async function readXlsxRows(input: ArrayBuffer | Uint8Array, preferred = 'Products'): Promise<string[][]> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const entries = new Map(zipEntries(bytes).map((e) => [e.name.replace(/^\//, ''), e]));
  const read = async (name: string): Promise<string | null> => {
    const e = entries.get(name);
    return e === undefined ? null : readPart(bytes, e);
  };

  const workbookXml = await read('xl/workbook.xml');
  if (workbookXml === null) throw new XlsxError('This file is not an Excel workbook. Save it as .xlsx or as CSV.');
  const workbook = parseXml(workbookXml);
  const sheets = elements(workbook, 'sheet').map((s) => ({
    name: s.getAttribute('name') ?? '',
    rid:
      s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ??
      s.getAttribute('r:id') ??
      '',
  }));
  if (sheets.length === 0) throw new XlsxError('The workbook has no sheets.');
  const sheet = sheets.find((s) => s.name.toLowerCase() === preferred.toLowerCase()) ?? sheets[0]!;

  const relsXml = await read('xl/_rels/workbook.xml.rels');
  let target = 'worksheets/sheet1.xml';
  if (relsXml !== null) {
    const rels = new DOMParser().parseFromString(relsXml, 'application/xml');
    const rel = Array.from(rels.getElementsByTagName('Relationship')).find((r) => r.getAttribute('Id') === sheet.rid);
    if (rel) target = rel.getAttribute('Target') ?? target;
  }
  const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  const sheetXml = await read(sheetPath);
  if (sheetXml === null) throw new XlsxError('The workbook’s first sheet is missing.');

  const sharedXml = await read('xl/sharedStrings.xml');
  const shared = sharedXml === null ? [] : elements(parseXml(sharedXml), 'si').map((si) => textOf(si));

  const rows: string[][] = [];
  for (const row of elements(parseXml(sheetXml), 'row')) {
    const r = Number(row.getAttribute('r') ?? String(rows.length + 1)) - 1;
    const cells: string[] = [];
    for (const c of elements(row, 'c')) {
      const ref = c.getAttribute('r');
      const col = ref === null ? cells.length : columnIndex(ref);
      const type = c.getAttribute('t') ?? 'n';
      const v = elements(c, 'v')[0]?.textContent ?? '';
      let text: string;
      if (type === 's') text = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') text = textOf(elements(c, 'is')[0]);
      else if (type === 'str' || type === 'e' || type === 'd') text = v;
      else if (type === 'b') text = v === '1' ? 'TRUE' : 'FALSE';
      else text = v === '' ? '' : numberCellText(v);
      while (cells.length < col) cells.push('');
      cells[col] = text;
    }
    while (rows.length < r) rows.push([]);
    rows[r] = cells;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Writing a workbook
// ---------------------------------------------------------------------------

export interface SheetValidation {
  /** Cells it applies to, e.g. "C2:C2000". */
  readonly range: string;
  /** A list source, e.g. "Lists!$A$2:$A$9". */
  readonly source: string;
  /** Strict refuses other values; otherwise Excel only suggests. */
  readonly strict: boolean;
  readonly prompt?: string;
}

export interface SheetSpec {
  readonly name: string;
  readonly rows: readonly (readonly string[])[];
  /** Character widths, one per column. */
  readonly widths?: readonly number[];
  /** Bold, shaded first row, frozen in place. */
  readonly header?: boolean;
  readonly validations?: readonly SheetValidation[];
}

function esc(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function columnName(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function sheetXml(spec: SheetSpec): string {
  const cols =
    spec.widths && spec.widths.length > 0
      ? `<cols>${spec.widths.map((w, i) => `<col min="${String(i + 1)}" max="${String(i + 1)}" width="${String(w)}" customWidth="1"/>`).join('')}</cols>`
      : '';
  const view = spec.header
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    : '';
  const rows = spec.rows
    .map((row, r) => {
      const style = spec.header && r === 0 ? ' s="1"' : '';
      const cells = row
        .map((v, c) => (v === '' ? '' : `<c r="${columnName(c)}${String(r + 1)}" t="inlineStr"${style}><is><t xml:space="preserve">${esc(v)}</t></is></c>`))
        .join('');
      return `<row r="${String(r + 1)}">${cells}</row>`;
    })
    .join('');
  const validations =
    spec.validations && spec.validations.length > 0
      ? `<dataValidations count="${String(spec.validations.length)}">${spec.validations
          .map(
            (v) =>
              `<dataValidation type="list" allowBlank="1" showInputMessage="${v.prompt ? '1' : '0'}" showErrorMessage="1"` +
              `${v.strict ? '' : ' errorStyle="information"'} sqref="${v.range}"` +
              `${v.prompt ? ` prompt="${esc(v.prompt)}"` : ''}><formula1>${esc(v.source)}</formula1></dataValidation>`,
          )
          .join('')}</dataValidations>`
      : '';
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<worksheet xmlns="${SHEET_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `${view}${cols}<sheetData>${rows}</sheetData>${validations}</worksheet>`
  );
}

const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  `<styleSheet xmlns="${SHEET_NS}">` +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFFFF1E6"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

/** A workbook of text cells, as the bytes of an .xlsx file. */
export function writeXlsx(sheets: readonly SheetSpec[]): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const part = (name: string, xml: string): ZipPart => ({ name, data: enc.encode(xml) });
  const sheetEntries = sheets.map((s, i) => ({ spec: s, file: `sheet${String(i + 1)}.xml`, rid: `rId${String(i + 1)}` }));
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    sheetEntries
      .map((s) => `<Override PartName="/xl/worksheets/${s.file}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
      .join('') +
    '</Types>';
  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';
  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<workbook xmlns="${SHEET_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>${sheetEntries.map((s, i) => `<sheet name="${esc(s.spec.name)}" sheetId="${String(i + 1)}" r:id="${s.rid}"/>`).join('')}</sheets>` +
    '</workbook>';
  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheetEntries
      .map((s) => `<Relationship Id="${s.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/${s.file}"/>`)
      .join('') +
    `<Relationship Id="rId${String(sheetEntries.length + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    '</Relationships>';
  return zipStore([
    part('[Content_Types].xml', contentTypes),
    part('_rels/.rels', rootRels),
    part('xl/workbook.xml', workbook),
    part('xl/_rels/workbook.xml.rels', workbookRels),
    part('xl/styles.xml', STYLES),
    ...sheetEntries.map((s) => part(`xl/worksheets/${s.file}`, sheetXml(s.spec))),
  ]);
}
