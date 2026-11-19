/**
 * ReceiptDocument -> printable HTML, for `system-print` (the OS print dialog /
 * driver path) and nothing else. Two layouts:
 *
 *  - `58` / `80`: a roll receipt, the SAME fitted lines the ESC/POS encoder
 *    prints, in a monospace block sized to the paper. What the browser prints is
 *    what the thermal printer would have printed.
 *  - `a4`: an invoice for laptops/HQ — header, line table, tax and tender blocks.
 *
 * Money comes from the document's own scale (§8.3). The currency sign is shown
 * as the pack gave it (a browser font has the glyph; there is no printer code
 * page to ask). Every string is HTML-escaped: names are tenant data.
 */
import { SCREEN_PAGE } from './codepage';
import type { ReceiptDocument } from './document';
import { documentHeading, rateBpText } from './document';
import { COLUMNS_FOR_PAPER_MM, labelledAmount, layoutReceipt, plainAmount, type LayoutLine } from './layout';

export type PrintLayout = '58' | '80' | 'a4';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function layoutToPlainText(lines: readonly LayoutLine[], columns: number): string {
  return lines
    .map((l) => {
      switch (l.kind) {
        case 'blank':
          return '';
        case 'rule':
          return l.char.repeat(columns);
        case 'qr':
          return `[QR] ${l.payload}`;
        case 'text': {
          const width = Math.floor(columns / l.wide);
          if (l.align === 'center') return ' '.repeat(Math.max(0, Math.floor((width - l.text.length) / 2))) + l.text;
          if (l.align === 'right') return ' '.repeat(Math.max(0, width - l.text.length)) + l.text;
          return l.text;
        }
      }
    })
    .join('\n');
}

function rollHtml(doc: ReceiptDocument, mm: 58 | 80, isCopy: boolean): string {
  const columns = COLUMNS_FOR_PAPER_MM[mm];
  const lines = layoutReceipt(doc, { columns, page: SCREEN_PAGE, isCopy });
  const body = lines
    .map((l) => {
      if (l.kind === 'blank') return '<div>&nbsp;</div>';
      if (l.kind === 'rule') return `<div>${escapeHtml(l.char.repeat(columns))}</div>`;
      if (l.kind === 'qr') return `<div class="c">[QR] ${escapeHtml(l.payload)}</div>`;
      const cls = [l.align === 'center' ? 'c' : l.align === 'right' ? 'r' : '', l.bold ? 'b' : '', l.wide === 2 ? 'w2' : '', l.tall === 2 ? 't2' : '']
        .filter(Boolean)
        .join(' ');
      return `<div class="${cls}">${escapeHtml(l.text) || '&nbsp;'}</div>`;
    })
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(doc.receiptNo)}</title><style>
@page { size: ${mm}mm auto; margin: 0 }
html,body { margin:0; padding:0; background:#fff; color:#000 }
body { width:${mm}mm; padding:2mm; box-sizing:border-box; font: 12px/1.25 "Courier New", monospace }
div { white-space: pre; overflow:hidden }
.c { text-align:center } .r { text-align:right } .b { font-weight:700 }
.w2 { font-size:24px } .t2 { font-size:15px }
</style></head><body>${body}</body></html>`;
}

function a4Html(doc: ReceiptDocument, isCopy: boolean): string {
  const l = doc.labels;
  const heading = documentHeading(doc);
  const money = (n: bigint): string => labelledAmount(n, doc.currency, SCREEN_PAGE);
  const plain = (n: bigint): string => plainAmount(n, doc.currency);
  const rows = doc.lines
    .map(
      (i) =>
        `<tr><td>${escapeHtml(i.name)}</td><td class="n">${escapeHtml(i.qtyText)} ${escapeHtml(i.uomLabel)}</td><td class="n">${plain(i.unitPriceMinor)}</td><td class="n">${plain(i.amountMinor)}</td></tr>`,
    )
    .join('');
  const tax = doc.taxLines
    .map(
      (t) =>
        `<tr><td colspan="3" class="n">${escapeHtml(t.name)} ${escapeHtml(rateBpText(t.rateBp))}</td><td class="n">${money(t.taxMinor)}</td></tr>`,
    )
    .join('');
  const net =
    !doc.pricesIncludeTax && doc.netMinor !== null && doc.taxLines.length > 0
      ? `<tr><td colspan="3" class="n">${escapeHtml(l.subtotal)}</td><td class="n">${money(doc.netMinor)}</td></tr>`
      : '';
  const tenders = doc.tenders
    .map(
      (t) =>
        `<tr><td colspan="3" class="n">${escapeHtml(t.method)}${t.reference !== null && t.reference.length > 0 ? ` (${escapeHtml(l.reference)}: ${escapeHtml(t.reference)})` : ''}</td><td class="n">${money(t.amountMinor)}</td></tr>`,
    )
    .join('');
  const change =
    doc.changeMinor > 0n ? `<tr><td colspan="3" class="n">${escapeHtml(l.change)}</td><td class="n">${money(doc.changeMinor)}</td></tr>` : '';
  const pack = doc.pack.fields
    .map((f) => `<div>${escapeHtml(f.label)}: ${escapeHtml(f.value)}</div>`)
    .join('');
  const header = [doc.businessName, ...doc.headerLines, doc.locationName]
    .filter((x): x is string => x !== null && x.length > 0)
    .map((x, idx) => (idx === 0 ? `<h1>${escapeHtml(x)}</h1>` : `<div>${escapeHtml(x)}</div>`))
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(doc.receiptNo)}</title><style>
@page { size: A4; margin: 15mm }
body { font: 13px/1.4 system-ui, sans-serif; color:#000; background:#fff }
h1 { font-size: 22px; margin: 0 0 4px }
table { width:100%; border-collapse: collapse; margin-top: 12px }
th,td { padding: 6px 4px; border-bottom: 1px solid #bbb; text-align:left }
.n { text-align:right } .copy { font-weight:700; border:2px solid #000; display:inline-block; padding:2px 8px }
</style></head><body>
${isCopy ? `<div class="copy">${escapeHtml(l.copy)}</div>` : ''}
${header}
${heading === null ? '' : `<h1 class="heading">${escapeHtml(heading)}</h1>`}
<p><strong>${escapeHtml(l.receipt)} ${escapeHtml(doc.receiptNo)}</strong><br>${escapeHtml(l.date)}: ${escapeHtml(doc.issuedAtText)}${doc.originalReceiptNo === undefined || doc.originalReceiptNo === null ? '' : `<br>${escapeHtml(l.originalReceipt ?? 'Original receipt')}: ${escapeHtml(doc.originalReceiptNo)}`}${doc.customerName === null ? '' : `<br>${escapeHtml(l.customer)}: ${escapeHtml(doc.customerName)}`}</p>
<table><thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Unit</th><th class="n">Amount</th></tr></thead><tbody>${rows}
${net}${tax}<tr><td colspan="3" class="n"><strong>${escapeHtml(l.total)}</strong></td><td class="n"><strong>${money(doc.totalMinor)}</strong></td></tr>${tenders}${change}</tbody></table>
${pack}${doc.footerLines.map((f) => `<p>${escapeHtml(f)}</p>`).join('')}
</body></html>`;
}

export function renderReceiptHtml(doc: ReceiptDocument, layout: PrintLayout, isCopy = false): string {
  return layout === 'a4' ? a4Html(doc, isCopy) : rollHtml(doc, layout === '58' ? 58 : 80, isCopy);
}
