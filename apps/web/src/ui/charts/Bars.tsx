/**
 * Ranked horizontal bars — "where is the money, by place".
 *
 * One hue, sorted, every bar DIRECT-LABELLED with the caller's formatted
 * figure. That is what lets it stay one hue: identity is in the row label,
 * magnitude is in the length, the exact figure is in the text, and colour is
 * left free to mean nothing — so the status colours keep meaning something
 * everywhere else on the page.
 *
 * A `null` value is a row whose figure the server withheld. It is still a
 * row — the place exists — drawn with no bar and the word "Unavailable", and
 * it sorts last. It is never a zero-length bar, which would read as zero.
 *
 * Laid out for the list it will hold (25 outlets in FY10), not the list it
 * has (1 today). With a single row it renders that row and, if the caller
 * says so, a sentence about why the list is short — never a lonely bar in a
 * field of nothing.
 *
 * Widths are shares (`shareBp`); the figure a person reads is `format(value)`,
 * which is always a `<Money>` or a quantity formatter upstream.
 */
import type { ReactNode } from 'react';
import { bpToPercent, maxOf, shareBp } from './scale';

export interface BarRow {
  readonly key: string;
  readonly label: ReactNode;
  readonly value: bigint | null;
  /** A second colour for rows the caller marks — below a target, past terms. */
  readonly tone?: 'default' | 'warn' | 'bad';
}

export interface BarsProps {
  readonly rows: readonly BarRow[];
  /** Renders the figure beside each bar. Money → `<Money>`; never a raw bigint. */
  readonly format: (value: bigint) => ReactNode;
  /** Accessible name for the list. */
  readonly label: string;
  /** Shown under a short list: why it is short. Optional. */
  readonly note?: ReactNode;
  /** Sort descending by value, unavailable last. Default true — this is a ranking. */
  readonly ranked?: boolean;
  /** A mark on every track at this value, on the shared scale — a target. */
  readonly mark?: bigint;
}

function compare(a: BarRow, b: BarRow): number {
  if (a.value === null) return b.value === null ? 0 : 1;
  if (b.value === null) return -1;
  return a.value === b.value ? 0 : a.value > b.value ? -1 : 1;
}

export function Bars({ rows, format, label, note, ranked = true, mark }: BarsProps): ReactNode {
  const ordered = ranked ? [...rows].sort(compare) : rows;
  const real = ordered.map((r) => r.value).filter((v): v is bigint => v !== null);
  const max = maxOf(mark === undefined ? real : [...real, mark]);
  return (
    <div className="bars" role="list" aria-label={label}>
      {ordered.map((r) => (
        <div className="bars-row" role="listitem" key={r.key}>
          <span className="bars-label">{r.label}</span>
          <span className="bars-track" aria-hidden="true">
            {r.value === null ? null : (
              <i
                className={`bars-fill${r.tone === 'warn' ? ' bars-fill-warn' : r.tone === 'bad' ? ' bars-fill-bad' : ''}`}
                style={{ width: bpToPercent(shareBp(r.value, max)) }}
              />
            )}
            {mark === undefined ? null : <em className="bars-mark" style={{ left: bpToPercent(shareBp(mark, max)) }} />}
          </span>
          <span className="bars-value tabular">
            {r.value === null ? <span className="bars-unavailable">Unavailable</span> : format(r.value)}
          </span>
        </div>
      ))}
      {note === undefined ? null : <p className="bars-note">{note}</p>}
    </div>
  );
}
