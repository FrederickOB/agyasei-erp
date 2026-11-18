/**
 * Horizontal bars split into two parts — cash vs credit, by location.
 *
 * Each row's length is its total on a shared scale, and the two segments
 * show how that total splits. Two series, so the legend is always drawn
 * (identity is never colour alone), and the first segment's share is written
 * inside it when there is room. Values are `bigint`; only shares become
 * widths (`shareBp`); the total a person reads is the caller's `format`.
 */
import type { ReactNode } from 'react';
import { bpToPercent, maxOf, shareBp } from './scale';

export interface SplitRow {
  readonly key: string;
  readonly label: ReactNode;
  readonly a: bigint;
  readonly b: bigint;
}

export interface SplitBarsProps {
  readonly rows: readonly SplitRow[];
  readonly aName: string;
  readonly bName: string;
  /** Renders the row total. Money → `<Money>`. */
  readonly format: (total: bigint) => ReactNode;
  readonly label: string;
  readonly note?: ReactNode;
}

export function SplitBars({ rows, aName, bName, format, label, note }: SplitBarsProps): ReactNode {
  const totals = rows.map((r) => r.a + r.b);
  const max = maxOf(totals);
  return (
    <div className="splitbars">
      <ul className="splitbars-legend" aria-label={`${label} — legend`}>
        <li>
          <i className="splitbars-swatch-a" />
          {aName}
        </li>
        <li>
          <i className="splitbars-swatch-b" />
          {bName}
        </li>
      </ul>
      <div className="splitbars-rows" role="list" aria-label={label}>
        {rows.map((r) => {
          const total = r.a + r.b;
          const rowBp = shareBp(total, max);
          const aBp = shareBp(r.a, total);
          return (
            <div className="splitbars-row" role="listitem" key={r.key}>
              <span className="splitbars-label">{r.label}</span>
              <span className="splitbars-track" aria-hidden="true">
                <span className="splitbars-bar" style={{ width: bpToPercent(rowBp) }}>
                  <i className="splitbars-a" style={{ width: bpToPercent(aBp) }}>
                    {aBp >= 2_000 ? <span className="splitbars-share tabular">{(aBp / 100).toFixed(0)}%</span> : null}
                  </i>
                  <i className="splitbars-b" style={{ width: bpToPercent(10_000 - aBp) }} />
                </span>
              </span>
              <span className="splitbars-value tabular">
                {format(total)}
                <small>{(aBp / 100).toFixed(0)}% {aName.toLowerCase()}</small>
              </span>
            </div>
          );
        })}
      </div>
      {note === undefined ? null : <p className="bars-note">{note}</p>}
    </div>
  );
}
