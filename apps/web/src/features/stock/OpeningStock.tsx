/**
 * OPENING STOCK — HQ's one-time load before go-live (migration 0031; Q20).
 * Laptop-first, online only, office-only.
 *
 *   choose a CSV → set the cut-over date → Check the file (a dry run: every
 *   row's verdict, nothing written) → Load (all or nothing, once).
 *
 * What it is NOT, said on the screen: it is the stock, not the books. The GL
 * opening balance is the accountant's (Track B) and nothing here posts.
 *
 * The file is read as TEXT and sent as text; every quantity is parsed exactly
 * on the server into the stocking unit's scale and comes back as the scaled
 * integer that would be stored, so what the preview shows is what lands.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { parseOpeningStockCsv } from '@erp/contracts';
import type { ApiCallOptions } from '../../data/api/client';
import {
  commitOpeningStock,
  OPENING_ISSUE_TEXT,
  previewOpeningStock,
  type OpeningCommit,
  type OpeningPreview,
} from '../../data/api/opening-stock';
import { formatQtyScaled } from '../../lib/quantity';
import { uuidv7 } from '../../lib/uuidv7';
import { Icon } from '../../ui/Icon';

export function OpeningStock({ apiOptions }: { readonly apiOptions?: ApiCallOptions }): ReactNode {
  const options = useMemo(() => apiOptions ?? {}, [apiOptions]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [csv, setCsv] = useState('');
  const [asOfDate, setAsOfDate] = useState('');
  // Minted when a file is chosen and held across retries: a double click or a
  // retry after a timeout is ONE import, never two (the server also refuses
  // the same content twice under any key).
  const [key, setKey] = useState(uuidv7());
  const [preview, setPreview] = useState<OpeningPreview | null>(null);
  const [result, setResult] = useState<OpeningCommit | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const local = useMemo(() => (csv.length === 0 ? null : parseOpeningStockCsv(csv)), [csv]);
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(asOfDate);

  const onFile = async (file: File | undefined): Promise<void> => {
    setPreview(null);
    setResult(null);
    setFailure(null);
    if (file === undefined) return;
    setFileName(file.name);
    setCsv(await file.text());
    setKey(uuidv7());
  };

  const check = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    const r = await previewOpeningStock({ csv, asOfDate, ...(fileName === null ? {} : { fileName }) }, options);
    setBusy(false);
    if (!r.ok) setFailure(r.failure.message);
    else setPreview(r.data);
  };

  const load = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    const r = await commitOpeningStock({ idempotencyKey: key, csv, asOfDate, ...(fileName === null ? {} : { fileName }) }, options);
    setBusy(false);
    if (!r.ok) setFailure(r.failure.message);
    else setResult(r.data);
  };

  const clean = preview !== null && preview.fileError === null && preview.summary !== null && preview.summary.badCount === 0;

  return (
    <section className="opening-stock" aria-label="Opening stock">
      <header className="report-panel-head">
        <h2>Opening stock</h2>
      </header>
      <p className="report-note">
        Load what each location holds on the day the system starts, once. This is the stock only — the opening
        balances in the books are the accountant’s and nothing here posts to them. The file needs the columns
        <code> sku_code, location_code, quantity</code> and optionally <code>unit_cost_minor</code>; quantities are in
        each product’s stocking unit.
      </p>

      <label className="tender-label" htmlFor="opening-file">File (CSV)</label>
      <input id="opening-file" type="file" accept=".csv,text/csv" onChange={(e) => void onFile(e.target.files?.[0])} />
      <label className="tender-label" htmlFor="opening-date">Stock as at (the cut-over date)</label>
      <input id="opening-date" className="tender-input" type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />

      {local !== null && local.fileError !== null ? (
        <p className="sale-refused" role="alert"><Icon name="alert" size={22} /><span>{local.fileError}</span></p>
      ) : null}

      <div className="tender-actions">
        <button type="button" className="secondary-action pressable" disabled={busy || csv.length === 0 || !dateOk || local?.fileError != null} onClick={() => void check()}>
          <Icon name="search" size={20} /> Check the file
        </button>
        <button type="button" className="primary-action pressable" disabled={busy || !clean || result !== null} onClick={() => void load()}>
          <Icon name="download" size={20} /> {busy ? 'Working…' : 'Load the opening stock'}
        </button>
      </div>

      {failure !== null ? (
        <p className="sale-refused" role="alert"><Icon name="alert" size={22} /><span>{failure}</span></p>
      ) : null}

      {result !== null ? (
        <p className="report-note" role="status">
          {result.alreadyImported
            ? `This stock was already loaded (${String(result.rowCount)} rows, as at ${result.asOfDate}). Nothing was loaded again.`
            : `Loaded ${String(result.movementCount)} opening balance${result.movementCount === 1 ? '' : 's'} as at ${result.asOfDate}.`}
        </p>
      ) : null}

      {preview !== null && preview.summary !== null ? (
        <>
          <p className="report-note" role="status">
            {preview.previous !== null
              ? `This exact stock was already loaded as at ${preview.previous.asOfDate}. Loading it again changes nothing.`
              : `${String(preview.summary.goodCount)} of ${String(preview.summary.rowCount)} rows are ready, across ${String(preview.summary.locationCount)} location(s) and ${String(preview.summary.productCount)} product(s).`}
            {preview.summary.badCount > 0 ? ` ${String(preview.summary.badCount)} row(s) need fixing first — nothing loads until every row is good.` : ''}
          </p>
          <div className="opening-stock-scroll">
            <table>
              <thead>
                <tr><th>Line</th><th>Product</th><th>Location</th><th>Quantity</th><th>Check</th></tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.lineNo} className={r.issues.length > 0 ? 'row-bad' : ''}>
                    <td className="tabular">{r.lineNo}</td>
                    <td>{r.skuCode}</td>
                    <td>{r.locationCode}</td>
                    <td className="tabular">
                      {r.qtyScaled !== null && r.qtyScale !== null
                        ? `${formatQtyScaled(r.qtyScaled, r.qtyScale)} ${r.uomCode ?? ''}`
                        : r.quantityText}
                    </td>
                    <td>{r.issues.length === 0 ? 'Ready' : r.issues.map((i) => OPENING_ISSUE_TEXT[i]).join('; ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}
