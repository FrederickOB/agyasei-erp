/**
 * PRODUCTS — the catalogue, loaded from a spreadsheet (migration 0032).
 * Laptop-first, online only, office-only.
 *
 *   1. Get the template — Excel or CSV, built from THIS tenant's own price
 *      lists, units, categories, tax codes and suppliers (never a list typed
 *      into this file — CLAUDE.md §2.9).
 *   2. Upload the filled file — Excel is turned into CSV here in the browser;
 *      the server reads one format through the same parser this screen uses.
 *   3. Check it — every row's verdict: ready, a duplicate (of a product you
 *      already have, or of an earlier line), or a problem, each with its
 *      reason. Nothing is written.
 *   4. Import the ready rows — the rest are skipped, and can be downloaded as
 *      a file of exactly those rows with the reason beside each, to fix and
 *      upload again.
 *
 * And, once, before a new list: remove every product. An archive, never a
 * delete — sales history keeps its products — confirmed by typing, and
 * checked by the server against the count this screen showed.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { parseProductCsv, productTemplateHeaders, toCsv, type ParsedProductFile } from '@erp/contracts';
import { divRound } from '@erp/money';
import type { ApiCallOptions } from '../../data/api/client';
import {
  commitProductImport,
  fetchCatalogue,
  fetchProductImportSetup,
  previewProductImport,
  PRODUCT_ISSUE_TEXT,
  removeAllProducts,
  type ImportPreview,
  type ImportPreviewRow,
  type ImportResult,
  type ImportRowStatus,
  type ProductImportSetup,
} from '../../data/api/products';
import { useApiQuery } from '../../data/api/use-api-query';
import { uuidv7 } from '../../lib/uuidv7';
import { readXlsxRows, writeXlsx, XlsxError, type SheetSpec } from '../../lib/xlsx';
import { Money } from '../../money/Money';
import { Icon } from '../../ui/Icon';
import { ServerPending, ServerUnavailable } from '../shell/ServerAnswer';

const NO_OPTIONS: ApiCallOptions = {};
const SHOWN_PRODUCTS = 300;
const TEMPLATE_ROWS = 2000;
const CONFIRM_WORD = 'REMOVE';

/** Minor units × 10⁴ to minor units, for display only — rounded once, half-up. */
function e4ToMinor(v: bigint): bigint {
  return divRound(v, 10_000n, 'half-up');
}

/** A chosen file's contents. FileReader, because it is in every browser this app supports. */
function readFile(file: Blob, as: 'text'): Promise<string>;
function readFile(file: Blob, as: 'buffer'): Promise<ArrayBuffer>;
function readFile(file: Blob, as: 'text' | 'buffer'): Promise<string | ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    if (as === 'text') reader.readAsText(file);
    else reader.readAsArrayBuffer(file);
  });
}

function download(name: string, bytes: BlobPart, type: string): void {
  const blob = new Blob([bytes], { type });
  if (typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** "A".."Z", "AA"… for a 0-based column. */
function col(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** The Excel template: an empty Products sheet with drop-downs, a guide, and the lists behind them. */
function templateWorkbook(setup: ProductImportSetup): Uint8Array<ArrayBuffer> {
  const headers = productTemplateHeaders(setup.priceLists.map((l) => l.name));
  const lists: string[][] = [['Units', 'Categories', 'Tax', 'Suppliers', 'Price lists']];
  const columns = [
    setup.units.map((u) => u.name),
    [...setup.categories],
    setup.taxCodes.map((t) => t.name),
    [...setup.suppliers],
    setup.priceLists.map((l) => `${l.name}${l.isTaxInclusive ? ' (prices include tax)' : ' (prices before tax)'}`),
  ];
  const depth = Math.max(...columns.map((c) => c.length));
  for (let r = 0; r < depth; r += 1) lists.push(columns.map((c) => c[r] ?? ''));

  const at = (h: string): number => headers.findIndex((x) => x.startsWith(h));
  const range = (i: number): string => `${col(i)}2:${col(i)}${String(TEMPLATE_ROWS)}`;
  const source = (listCol: number, n: number): string => `Lists!$${col(listCol)}$2:$${col(listCol)}$${String(n + 1)}`;
  const validations: SheetSpec['validations'] = [
    ...(columns[0]!.length > 0 ? [{ range: range(at('Unit')), source: source(0, columns[0]!.length), strict: true, prompt: 'Pick a unit from the list.' }] : []),
    ...(columns[1]!.length > 0 ? [{ range: range(at('Category')), source: source(1, columns[1]!.length), strict: false }] : []),
    ...(columns[2]!.length > 0 ? [{ range: range(at('Tax')), source: source(2, columns[2]!.length), strict: true }] : []),
    ...(columns[3]!.length > 0 ? [{ range: range(at('Supplier')), source: source(3, columns[3]!.length), strict: false }] : []),
  ];

  const guide: string[][] = [
    ['Column', 'Required?', 'What to put in it'],
    ['Product name', 'Yes', 'The name the counter shows and the receipt prints. Each product once — a name you already have is skipped as a duplicate.'],
    ['Category', 'Yes', 'Pick one from the list, or type a new one: a new category is created for you.'],
    ['Unit', 'Yes', 'The unit you sell and count it in — pick one from the list.'],
    ...setup.priceLists.map((l, i) => [
      `Price: ${l.name}`,
      i === 0 ? 'Yes' : 'No',
      `Selling price for one unit on the “${l.name}” list, ${l.isTaxInclusive ? 'including' : 'before'} tax. Numbers only, e.g. 1250.50.`,
    ]),
    ['Cost price', 'No', 'What one unit costs you. Used for your profit figures; never shown at the counter.'],
    ['Supplier', 'No', 'Who you buy it from. Pick one, or type a new name: a new supplier is created for you.'],
    ['Product code', 'No', 'Your own code. Leave it empty and one is made for you (P-00001, P-00002 …).'],
    ['Tax', 'No', setup.defaultTaxCode === null ? 'Pick one from the list.' : `Leave empty for the usual (${setup.taxCodes.find((t) => t.code === setup.defaultTaxCode)?.name ?? setup.defaultTaxCode}).`],
    ['Notes', 'No', 'Anything else worth keeping about the product.'],
    [],
    ['Fill the “Products” sheet, one product per row, starting on row 2. Keep the first row as it is.'],
    ['Then upload this file on the Products screen and press “Check file”. Rows with a problem are skipped, never guessed at.'],
  ];

  return writeXlsx([
    { name: 'Products', rows: [headers], header: true, widths: headers.map((h) => Math.max(14, h.length + 4)), validations },
    { name: 'How to fill', rows: guide, header: true, widths: [24, 11, 100] },
    { name: 'Lists', rows: lists, header: true, widths: [22, 28, 28, 28, 44] },
  ]);
}

const STATUS_WORD: Readonly<Record<ImportRowStatus, string>> = {
  ready: 'Ready',
  duplicate: 'Duplicate',
  problem: 'Problem',
};

type Filter = 'all' | ImportRowStatus;

function PriceCells({ row }: { readonly row: ImportPreviewRow }): ReactNode {
  if (row.prices.length === 0) return <span className="muted">—</span>;
  return (
    <span className="pi-prices">
      {row.prices.map((p) => (
        <span key={p.priceListId} title={p.priceListName}>
          <Money amount={e4ToMinor(p.priceE4)} />
        </span>
      ))}
    </span>
  );
}

function ImportPanel({
  setup,
  options,
  onImported,
}: {
  readonly setup: ProductImportSetup;
  readonly options: ApiCallOptions;
  readonly onImported: () => void;
}): ReactNode {
  const [fileName, setFileName] = useState<string | null>(null);
  const [csv, setCsv] = useState('');
  const [readError, setReadError] = useState<string | null>(null);
  // Minted when a file is chosen, held across retries: a double click or a
  // retry after a timeout is ONE import.
  const [key, setKey] = useState(uuidv7());
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const local: ParsedProductFile | null = useMemo(() => (csv.length === 0 ? null : parseProductCsv(csv)), [csv]);

  const reset = (): void => {
    setPreview(null);
    setResult(null);
    setFailure(null);
    setReadError(null);
    setFilter('all');
  };

  const onFile = async (file: File | undefined): Promise<void> => {
    reset();
    setCsv('');
    setFileName(null);
    if (file === undefined) return;
    setFileName(file.name);
    setKey(uuidv7());
    const lower = file.name.toLowerCase();
    try {
      if (lower.endsWith('.xlsx')) {
        setCsv(toCsv(await readXlsxRows(await readFile(file, 'buffer'))));
      } else if (lower.endsWith('.xls') || lower.endsWith('.ods') || lower.endsWith('.numbers')) {
        setReadError('This screen reads Excel .xlsx and CSV files. In your spreadsheet, choose “Save as” → Excel Workbook (.xlsx) or CSV.');
      } else {
        setCsv(await readFile(file, 'text'));
      }
    } catch (err) {
      setReadError(err instanceof XlsxError ? err.message : 'The file could not be read. Save it again as .xlsx or CSV and retry.');
    }
  };

  const check = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    const r = await previewProductImport({ csv, ...(fileName === null ? {} : { fileName }) }, options);
    setBusy(false);
    if (!r.ok) setFailure(r.failure.message);
    else {
      setPreview(r.data);
      setFilter('all');
    }
  };

  const commit = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    const r = await commitProductImport({ idempotencyKey: key, csv, ...(fileName === null ? {} : { fileName }) }, options);
    setBusy(false);
    if (!r.ok) setFailure(r.failure.message);
    else {
      setResult(r.data);
      onImported();
    }
  };

  /** The refused rows as the person gave them, with the reason beside each. */
  const skippedFile = (rejected: readonly { lineNo: number; issues: readonly string[] }[]): void => {
    if (local === null) return;
    const byLine = new Map(local.rows.map((r) => [r.lineNo, r]));
    const rows = [
      [...local.headers, 'Why it was skipped'],
      ...rejected.map((x) => {
        const raw = byLine.get(x.lineNo)?.raw ?? [];
        const padded = local.headers.map((_, i) => raw[i] ?? '');
        return [...padded, x.issues.map((i) => PRODUCT_ISSUE_TEXT[i as keyof typeof PRODUCT_ISSUE_TEXT] ?? i).join('; ')];
      }),
    ];
    download(`${(fileName ?? 'products').replace(/\.[^.]+$/, '')}-skipped.csv`, toCsv(rows), 'text/csv;charset=utf-8');
  };

  const summary = preview?.summary ?? null;
  const shown = preview === null ? [] : preview.rows.filter((r) => filter === 'all' || r.status === filter);
  const notReady = preview === null ? [] : preview.rows.filter((r) => r.status !== 'ready');

  return (
    <section className="pi-card" aria-label="Import products from a file">
      <ol className="pi-steps">
        <li className="pi-step">
          <span className="pi-step-no" aria-hidden="true">1</span>
          <div className="pi-step-body">
            <h2>Get the template</h2>
            <p className="pi-help">
              One product per row. It already knows your price lists, units, categories and suppliers.
            </p>
            <div className="pi-actions">
              <button
                type="button"
                className="secondary-action pressable"
                onClick={() => download('products-template.xlsx', templateWorkbook(setup), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')}
              >
                <Icon name="download" size={20} /> Excel template
              </button>
              <button
                type="button"
                className="secondary-action pressable"
                onClick={() => download('products-template.csv', toCsv([productTemplateHeaders(setup.priceLists.map((l) => l.name))]), 'text/csv;charset=utf-8')}
              >
                <Icon name="download" size={20} /> CSV template
              </button>
            </div>
          </div>
        </li>

        <li className="pi-step">
          <span className="pi-step-no" aria-hidden="true">2</span>
          <div className="pi-step-body">
            <h2>Upload your filled file</h2>
            <label className="pi-drop pressable">
              <Icon name="up" size={22} />
              <span>{fileName ?? 'Choose an Excel (.xlsx) or CSV file'}</span>
              <input
                className="visually-hidden"
                type="file"
                aria-label="Product file"
                accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(e) => void onFile(e.target.files?.[0])}
              />
            </label>
            {readError !== null || (local !== null && local.fileError !== null) ? (
              <p className="sale-refused" role="alert">
                <Icon name="alert" size={22} />
                <span>{readError ?? local?.fileError}</span>
              </p>
            ) : local !== null ? (
              <p className="pi-help" role="status">
                {local.rows.length === 1 ? '1 row' : `${String(local.rows.length)} rows`} found.
              </p>
            ) : null}
            <div className="pi-actions">
              <button
                type="button"
                className="primary-action pressable"
                disabled={busy || local === null || local.fileError !== null || result !== null}
                onClick={() => void check()}
              >
                <Icon name="search" size={20} /> {busy && preview === null ? 'Checking…' : 'Check file'}
              </button>
            </div>
          </div>
        </li>
      </ol>

      {failure !== null ? (
        <p className="sale-refused" role="alert">
          <Icon name="alert" size={22} />
          <span>{failure}</span>
        </p>
      ) : null}

      {preview !== null && preview.fileError !== null ? (
        <p className="sale-refused" role="alert">
          <Icon name="alert" size={22} />
          <span>{preview.fileError}</span>
        </p>
      ) : null}

      {result !== null ? (
        <div className="pi-result" role="status">
          <Icon name="check" size={28} />
          <div>
            <strong>
              {result.importedCount === 1 ? '1 product added' : `${String(result.importedCount)} products added`}
              {result.rejectedCount > 0 ? `, ${String(result.rejectedCount)} skipped` : ''}.
            </strong>
            <p className="pi-help">
              {result.createdCategoryCount > 0 ? `${String(result.createdCategoryCount)} new categor${result.createdCategoryCount === 1 ? 'y' : 'ies'}. ` : ''}
              {result.createdSupplierCount > 0 ? `${String(result.createdSupplierCount)} new supplier${result.createdSupplierCount === 1 ? '' : 's'}. ` : ''}
              Counters pick the new products up at their next sync.
            </p>
            <div className="pi-actions">
              {result.rejectedCount > 0 ? (
                <button type="button" className="secondary-action pressable" onClick={() => skippedFile(result.rejected)}>
                  <Icon name="download" size={20} /> Download the skipped rows
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {preview !== null && summary !== null && result === null ? (
        <div className="pi-preview">
          <div className="pi-summary" role="status">
            <span className="pi-pill pi-ready">
              <strong className="tabular">{summary.readyCount}</strong> ready
            </span>
            <span className="pi-pill pi-duplicate">
              <strong className="tabular">{summary.duplicateCount}</strong> duplicate{summary.duplicateCount === 1 ? '' : 's'}
            </span>
            <span className="pi-pill pi-problem">
              <strong className="tabular">{summary.problemCount}</strong> with a problem
            </span>
          </div>
          {summary.newCategories.length > 0 || summary.newSuppliers.length > 0 || preview.ignoredColumns.length > 0 ? (
            <ul className="pi-notes">
              {summary.newCategories.length > 0 ? <li>New categories to create: {summary.newCategories.join(', ')}</li> : null}
              {summary.newSuppliers.length > 0 ? <li>New suppliers to create: {summary.newSuppliers.join(', ')}</li> : null}
              {preview.ignoredColumns.length > 0 ? <li>Columns not used: {preview.ignoredColumns.join(', ')}</li> : null}
            </ul>
          ) : null}

          <div className="pi-filters" role="group" aria-label="Show rows">
            {(['all', 'ready', 'duplicate', 'problem'] as const).map((f) => (
              <button key={f} type="button" className="chip pressable" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {f === 'all' ? 'All rows' : STATUS_WORD[f]}
              </button>
            ))}
          </div>

          <div className="pi-table-wrap">
            <table className="pi-table">
              <thead>
                <tr>
                  <th className="numeric">Row</th>
                  <th>Product</th>
                  <th>Category</th>
                  <th>Unit</th>
                  <th className="numeric">{preview.priceColumns.length > 1 ? 'Prices' : 'Price'}</th>
                  <th className="numeric">Cost</th>
                  <th>Supplier</th>
                  <th>Check</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.lineNo} className={`pi-row-${r.status}`}>
                    <td className="numeric tabular">{r.lineNo}</td>
                    <td>
                      <span className="pi-name">{r.name === '' ? '—' : r.name}</span>
                      {r.code !== '' ? <span className="pi-sub tabular">{r.code}</span> : null}
                    </td>
                    <td>
                      {r.category}
                      {r.categoryIsNew && r.status === 'ready' ? <span className="pi-new">new</span> : null}
                    </td>
                    <td>{r.unit}</td>
                    <td className="numeric">
                      <PriceCells row={r} />
                    </td>
                    <td className="numeric">{r.costE4 === null ? <span className="muted">—</span> : <Money amount={e4ToMinor(r.costE4)} />}</td>
                    <td>
                      {r.supplier ?? <span className="muted">—</span>}
                      {r.supplierIsNew && r.status === 'ready' ? <span className="pi-new">new</span> : null}
                    </td>
                    <td>
                      <span className={`pi-status pi-status-${r.status}`}>{STATUS_WORD[r.status]}</span>
                      {r.issues.length > 0 ? (
                        <span className="pi-reason">{r.issues.map((i) => PRODUCT_ISSUE_TEXT[i]).join(' · ')}</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {shown.length === 0 ? <p className="pi-help pi-empty">No rows here.</p> : null}
          </div>

          <div className="pi-commit">
            <p className="pi-help">
              {summary.readyCount === 0
                ? 'No row is ready to import. Fix the file and check it again.'
                : notReady.length > 0
                  ? `${String(notReady.length)} row${notReady.length === 1 ? '' : 's'} will be skipped. You can download ${notReady.length === 1 ? 'it' : 'them'} to fix.`
                  : 'Every row is ready.'}
            </p>
            <div className="pi-actions">
              {notReady.length > 0 ? (
                <button
                  type="button"
                  className="secondary-action pressable"
                  onClick={() => skippedFile(notReady.map((r) => ({ lineNo: r.lineNo, issues: r.issues })))}
                >
                  <Icon name="download" size={20} /> Skipped rows
                </button>
              ) : null}
              <button type="button" className="primary-action pressable" disabled={busy || summary.readyCount === 0} onClick={() => void commit()}>
                <Icon name="check" size={20} />
                {busy ? 'Importing…' : `Import ${String(summary.readyCount)} product${summary.readyCount === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function RemoveAllDialog({
  count,
  options,
  onClose,
  onRemoved,
}: {
  readonly count: number;
  readonly options: ApiCallOptions;
  readonly onClose: () => void;
  readonly onRemoved: (n: number) => void;
}): ReactNode {
  const [typed, setTyped] = useState('');
  const [key] = useState(uuidv7());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const ok = typed.trim().toUpperCase() === CONFIRM_WORD;

  const remove = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    const r = await removeAllProducts({ idempotencyKey: key, expectedCount: count }, options);
    setBusy(false);
    if (!r.ok) setFailure(r.failure.message);
    else onRemoved(r.data.archivedCount);
  };

  return (
    <>
      <div className="sheet-scrim" aria-hidden="true" onClick={busy ? undefined : onClose} />
      <div className="modal-sheet pi-dialog" role="dialog" aria-modal="true" aria-label="Remove all products">
        <div className="modal-sheet-head">
          <h2 className="modal-sheet-title">Remove all {count} products?</h2>
          <button type="button" className="sheet-close pressable" aria-label="Close" onClick={onClose} disabled={busy}>
            <Icon name="close" size={20} />
          </button>
        </div>
        <div className="modal-sheet-body">
          <ul className="pi-notes">
            <li>They leave every counter at its next sync, and can no longer be sold.</li>
            <li>Past sales, receipts and stock history stay exactly as they are.</li>
            <li>Categories, suppliers and price lists stay, ready for your new list.</li>
          </ul>
          <label className="tender-field">
            <span>Type {CONFIRM_WORD} to confirm</span>
            <input
              className="tender-input"
              type="text"
              autoComplete="off"
              autoCapitalize="characters"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              data-autofocus
            />
          </label>
          {failure !== null ? (
            <p className="sale-refused" role="alert">
              <Icon name="alert" size={22} />
              <span>{failure}</span>
            </p>
          ) : null}
          <div className="modal-sheet-actions">
            <button type="button" className="secondary-action pressable" onClick={onClose} disabled={busy}>
              Keep them
            </button>
            <button type="button" className="primary-action danger pressable" disabled={!ok || busy} onClick={() => void remove()}>
              <Icon name="trash" size={20} /> {busy ? 'Removing…' : `Remove ${String(count)} products`}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function CatalogueTable({ setup, options, version }: { readonly setup: ProductImportSetup; readonly options: ApiCallOptions; readonly version: number }): ReactNode {
  const { state, refresh } = useApiQuery(() => fetchCatalogue(options), [options, version]);
  const [query, setQuery] = useState('');
  if (state.status === 'loading') return <ServerPending shape="table" what="Products" rows={6} slow={state.slow} />;
  if (state.status === 'failed') return <ServerUnavailable what="Products" failure={state.failure} onRetry={refresh} />;
  const q = query.trim().toLowerCase();
  const matched = q === '' ? state.data : state.data.filter((p) => [p.name, p.code, p.category ?? '', p.supplier ?? ''].some((t) => t.toLowerCase().includes(q)));
  const rows = matched.slice(0, SHOWN_PRODUCTS);
  return (
    <section className="pi-card" aria-label="Your products">
      <div className="pi-list-head">
        <h2>Your products</h2>
        <div className="search-field pi-search">
          <Icon name="search" size={20} className="search-icon" />
          <input
            className="search-input"
            type="search"
            placeholder="Search products"
            aria-label="Search your products"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      {state.data.length === 0 ? (
        <div className="empty-state">
          <Icon name="box" size={36} />
          <span className="empty-title">No products yet</span>
          <p className="empty-body">Download the template above, fill it in, and import it.</p>
        </div>
      ) : (
        <div className="pi-table-wrap">
          <table className="pi-table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Category</th>
                <th>Unit</th>
                {setup.priceLists.map((l) => (
                  <th key={l.id} className="numeric">{l.name}</th>
                ))}
                <th className="numeric">Cost</th>
                <th>Supplier</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.productId}>
                  <td>
                    <span className="pi-name">{p.name}</span>
                    <span className="pi-sub tabular">{p.code}</span>
                  </td>
                  <td>{p.category ?? '—'}</td>
                  <td>{p.unit}</td>
                  {setup.priceLists.map((l) => {
                    const price = p.prices.find((x) => x.priceListId === l.id);
                    return (
                      <td key={l.id} className="numeric">
                        {price === undefined ? <span className="muted">—</span> : <Money amount={e4ToMinor(price.priceE4)} />}
                      </td>
                    );
                  })}
                  <td className="numeric">{p.costE4 === null ? <span className="muted">—</span> : <Money amount={e4ToMinor(p.costE4)} />}</td>
                  <td>{p.supplier ?? <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {matched.length > rows.length ? (
            <p className="pi-help pi-empty">
              Showing {rows.length} of {matched.length}. Search to narrow it down.
            </p>
          ) : null}
          {matched.length === 0 ? <p className="pi-help pi-empty">Nothing matches “{query}”.</p> : null}
        </div>
      )}
    </section>
  );
}

export function Products({ apiOptions = NO_OPTIONS }: { readonly apiOptions?: ApiCallOptions }): ReactNode {
  const [version, setVersion] = useState(0);
  const setupQuery = useApiQuery(() => fetchProductImportSetup(apiOptions), [apiOptions, version]);
  const [removing, setRemoving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [importKey, setImportKey] = useState(0);
  // Kept across a refresh: re-reading the counts after an import must not
  // unmount the import panel and throw away the result it is showing.
  const lastSetup = useRef<ProductImportSetup | null>(null);
  if (setupQuery.state.status === 'ready') lastSetup.current = setupQuery.state.data;
  const setup = lastSetup.current;

  if (setup === null) {
    if (setupQuery.state.status === 'failed') {
      return <ServerUnavailable what="Products" failure={setupQuery.state.failure} onRetry={setupQuery.refresh} />;
    }
    return <ServerPending shape="cards" what="Products" rows={3} slow={setupQuery.state.status === 'loading' && setupQuery.state.slow} />;
  }

  return (
    <section className="products-screen" aria-label="Products">
      <header className="pi-head">
        <div>
          <h1>Products</h1>
          <p className="pi-help">
            {setup.productCount === 1 ? '1 product' : `${String(setup.productCount)} products`} in your catalogue · {setup.priceLists.length} price list
            {setup.priceLists.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="pi-actions">
          {setup.productCount > 0 ? (
            <button type="button" className="secondary-action danger-outline pressable" onClick={() => { setNotice(null); setRemoving(true); }}>
              <Icon name="trash" size={20} /> Remove all products
            </button>
          ) : null}
        </div>
      </header>

      {notice !== null ? (
        <p className="pi-notice" role="status">
          <Icon name="check" size={20} /> {notice}
        </p>
      ) : null}

      <ImportPanel key={importKey} setup={setup} options={apiOptions} onImported={() => setVersion((v) => v + 1)} />
      <CatalogueTable setup={setup} options={apiOptions} version={version} />

      {removing ? (
        <RemoveAllDialog
          count={setup.productCount}
          options={apiOptions}
          onClose={() => setRemoving(false)}
          onRemoved={(n) => {
            setRemoving(false);
            setNotice(`${String(n)} products removed. Counters drop them at their next sync. You can import your new list now.`);
            setImportKey((k) => k + 1);
            setVersion((v) => v + 1);
          }}
        />
      ) : null}
    </section>
  );
}
