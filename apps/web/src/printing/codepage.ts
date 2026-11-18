/**
 * Printer code pages, and the honest answer to "can this printer print that
 * character?".
 *
 * Thermal printers do not speak Unicode. They hold one 256-entry table at a
 * time, selected with `ESC t n`. The question the layout asks is therefore not
 * "what is the currency symbol" (that is the jurisdiction pack's business and
 * never a constant in this app, ADR-0007) but "is the glyph the pack gave us
 * in the table this printer is set to?". If it is not, the layout prints the
 * pack's display CODE instead, so a receipt never carries a `?` where the
 * tenant's currency sign should be.
 *
 * Only two tables are modelled: plain ASCII, which every printer ever sold can
 * do, and CP437, the factory default of most commodity ESC/POS units. A table
 * a printer would have to be told about explicitly (CP858, CP1252...) is a
 * per-model finding for the hardware spike, not a guess made here.
 */

export type CodePageId = 'ascii' | 'cp437';

export interface CodePage {
  readonly id: CodePageId;
  /** The `n` of `ESC t n`. */
  readonly escposSelector: number;
  /** char -> byte for the non-ASCII half of the table. */
  readonly high: ReadonlyMap<string, number>;
  /** A screen or browser-print target: every printable character is available. */
  readonly unrestricted?: boolean;
}

// 0x80-0xFF of IBM code page 437, in order.
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅ' +
  'ÉæÆôöòûùÿÖÜ¢£¥₧ƒ' +
  'áíóúñÑªº¿⌐¬½¼¡«»' +
  '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
  '└┴┬├─┼╞╟╚╔╩╦╠═╬╧' +
  '╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩' +
  '≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function buildHigh(table: string): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  [...table].forEach((ch, i) => map.set(ch, 0x80 + i));
  return map;
}

export const CODE_PAGES: Readonly<Record<CodePageId, CodePage>> = {
  ascii: { id: 'ascii', escposSelector: 0, high: new Map() },
  cp437: { id: 'cp437', escposSelector: 0, high: buildHigh(CP437_HIGH) },
};

/** For on-screen and browser-print rendering, where the font decides, not a printer table. */
export const SCREEN_PAGE: CodePage = {
  id: 'cp437',
  escposSelector: 0,
  high: new Map(),
  unrestricted: true,
};

/** Whether one character survives the trip to this printer unchanged. */
export function canEncode(page: CodePage, ch: string): boolean {
  const code = ch.codePointAt(0);
  if (code === undefined) return false;
  if (page.unrestricted === true) return code >= 0x20 && code !== 0x7f;
  if (code >= 0x20 && code <= 0x7e) return true;
  return page.high.has(ch);
}

const PUNCTUATION: Readonly<Record<string, string>> = {
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '–': '-',
  '—': '-',
  '…': '...',
  '×': 'x',
  '\t': ' ',
};

/**
 * Make arbitrary text printable on this page: keep what the page has, strip
 * diacritics where the base letter is printable, map typographic punctuation to
 * ASCII, and show `?` for anything else. Never throws, never drops a character
 * silently (a `?` is a visible, honest substitution).
 */
export function toPrintable(page: CodePage, text: string): string {
  let out = '';
  for (const ch of text) {
    if (canEncode(page, ch)) {
      out += ch;
      continue;
    }
    const mapped = PUNCTUATION[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (base !== ch && [...base].every((b) => canEncode(page, b))) {
      out += base;
      continue;
    }
    out += /[\r\n\v\f]/.test(ch) ? ' ' : '?';
  }
  return out;
}

/** Bytes for text. Runs {@link toPrintable} first, so it cannot emit a byte the page lacks. */
export function encodeText(page: CodePage, text: string): number[] {
  const bytes: number[] = [];
  for (const ch of toPrintable(page, text)) {
    const code = ch.codePointAt(0) ?? 0x3f;
    if (code >= 0x20 && code <= 0x7e) bytes.push(code);
    else bytes.push(page.high.get(ch) ?? 0x3f);
  }
  return bytes;
}
