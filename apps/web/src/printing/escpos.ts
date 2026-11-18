/**
 * The ESC/POS encoder. Pure and deterministic: a layout (or a document) and a
 * set of options go in, a byte array comes out, with no clock, no randomness
 * and no I/O — which is what lets golden byte fixtures pin it.
 *
 * Commands used (all from the common subset every commodity thermal printer,
 * and the Android POS terminals' inner printers, implement):
 *
 *   ESC @        initialise              1B 40
 *   ESC t n      select code page        1B 74 n
 *   ESC a n      alignment 0/1/2         1B 61 n
 *   ESC E n      emphasis (bold)         1B 45 n
 *   GS ! n       character size          1D 21 n   (high nibble width-1, low height-1)
 *   ESC d n      print and feed n lines  1B 64 n
 *   GS V m       cut (0 full, 1 partial) 1D 56 m
 *   ESC p m t1 t2  cash-drawer pulse     1B 70 m t1 t2   (times in 2 ms units)
 *   GS ( k ...   QR code (model 2)       function 167/169/180/181/182
 *
 * What this module does NOT know: which printer is attached, how the bytes get
 * there (that is the transport's job), or what the currency is (that was settled
 * in the layout, from the document and the printer's code page).
 */
import { CODE_PAGES, encodeText, type CodePage, type CodePageId } from './codepage';
import type { ReceiptDocument } from './document';
import { COLUMNS_FOR_PAPER_MM, layoutReceipt, type LayoutLine, type PaperWidthMm } from './layout';

export type CutMode = 'none' | 'partial' | 'full';
export type QrErrorLevel = 'L' | 'M' | 'Q' | 'H';

export interface DrawerKick {
  /** 0 = connector pin 2, 1 = pin 5. */
  readonly pin: 0 | 1;
  /** Pulse on-time and off-time, in 2 ms units (ESC p t1 t2). */
  readonly onUnits: number;
  readonly offUnits: number;
}

export const DEFAULT_DRAWER_KICK: DrawerKick = { pin: 0, onUnits: 25, offUnits: 250 };

export interface EncodeOptions {
  readonly paperWidthMm: PaperWidthMm;
  readonly codePage: CodePageId;
  readonly cut: CutMode;
  /** Open the cash drawer with this pulse; null leaves it shut. */
  readonly drawerKick: DrawerKick | null;
  /** QR module size 1..16 dots. */
  readonly qrModuleSize: number;
  readonly qrErrorLevel: QrErrorLevel;
  /** Blank lines fed after the last line so the cut clears the text. */
  readonly trailingLines: number;
  readonly isCopy: boolean;
}

export const DEFAULT_ENCODE_OPTIONS: EncodeOptions = {
  paperWidthMm: 58,
  codePage: 'cp437',
  cut: 'partial',
  drawerKick: null,
  qrModuleSize: 5,
  qrErrorLevel: 'M',
  trailingLines: 3,
  isCopy: false,
};

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

/** A QR payload longer than this is skipped rather than risk overrunning a small printer's buffer. */
export const QR_MAX_BYTES = 1000;

const ALIGN = { left: 0, center: 1, right: 2 } as const;
const QR_LEVEL = { L: 48, M: 49, Q: 50, H: 51 } as const;

class Bytes {
  readonly out: number[] = [];
  push(...b: number[]): this {
    for (const x of b) this.out.push(x & 0xff);
    return this;
  }
  text(page: CodePage, s: string): this {
    for (const b of encodeText(page, s)) this.out.push(b);
    return this;
  }
}

function clampByte(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** GS ( k — store, then print, a QR symbol. Returns nothing if the payload cannot be sent safely. */
function qrBytes(b: Bytes, payload: string, size: number, level: QrErrorLevel): void {
  const data = [...new TextEncoder().encode(payload)];
  if (data.length === 0 || data.length > QR_MAX_BYTES) return;
  const len = data.length + 3;
  b.push(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00); // model 2
  b.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, clampByte(size, 1, 16)); // module size
  b.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, QR_LEVEL[level]); // error correction
  b.push(GS, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 0x31, 0x50, 0x30, ...data); // store
  b.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30); // print
}

/** Encode already-fitted layout lines. */
export function encodeLayout(lines: readonly LayoutLine[], options: EncodeOptions): Uint8Array {
  const page = CODE_PAGES[options.codePage];
  const columns = COLUMNS_FOR_PAPER_MM[options.paperWidthMm];
  const b = new Bytes();

  b.push(ESC, 0x40); // initialise
  b.push(ESC, 0x74, page.escposSelector); // code page
  if (options.drawerKick !== null) {
    const k = options.drawerKick;
    b.push(ESC, 0x70, k.pin, clampByte(k.onUnits, 0, 255), clampByte(k.offUnits, 0, 255));
  }

  let align: number = ALIGN.left;
  let bold = false;
  let size = 0x00;
  const setAlign = (a: number): void => {
    if (a !== align) b.push(ESC, 0x61, a);
    align = a;
  };
  const setBold = (on: boolean): void => {
    if (on !== bold) b.push(ESC, 0x45, on ? 1 : 0);
    bold = on;
  };
  const setSize = (n: number): void => {
    if (n !== size) b.push(GS, 0x21, n);
    size = n;
  };

  for (const line of lines) {
    switch (line.kind) {
      case 'blank':
        b.push(LF);
        break;
      case 'rule':
        setAlign(ALIGN.left);
        setBold(false);
        setSize(0);
        b.text(page, line.char.slice(0, 1).repeat(columns)).push(LF);
        break;
      case 'qr':
        setAlign(ALIGN.center);
        qrBytes(b, line.payload, options.qrModuleSize, options.qrErrorLevel);
        b.push(LF);
        break;
      case 'text':
        setAlign(ALIGN[line.align]);
        setBold(line.bold);
        setSize(((line.wide - 1) << 4) | (line.tall - 1));
        b.text(page, line.text).push(LF);
        break;
    }
  }

  setAlign(ALIGN.left);
  setBold(false);
  setSize(0);
  b.push(ESC, 0x64, clampByte(options.trailingLines, 0, 255)); // feed
  if (options.cut !== 'none') b.push(GS, 0x56, options.cut === 'full' ? 0 : 1);
  return Uint8Array.from(b.out);
}

/** A document straight to printer bytes. */
export function encodeReceipt(doc: ReceiptDocument, options: EncodeOptions): Uint8Array {
  const page = CODE_PAGES[options.codePage];
  const lines = layoutReceipt(doc, {
    columns: COLUMNS_FOR_PAPER_MM[options.paperWidthMm],
    page,
    isCopy: options.isCopy,
  });
  return encodeLayout(lines, options);
}

/** Lowercase hex with no separators — the form the golden fixtures are written in. */
export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const x of bytes) s += x.toString(16).padStart(2, '0');
  return s;
}

export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
