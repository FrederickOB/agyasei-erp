/**
 * A handful of categorical columns — weeks, weekdays, hours — each carrying
 * its own direct label, so no axis and no legend are needed.
 *
 * Twelve columns at most: past that the labels collide and the form is
 * wrong (use `DailyBars` for a time series, `Bars` for a ranking). Values
 * are `bigint`; only shares become heights (`shareBp`). `null` is a gap
 * marked "—"; `0n` is a stub on the baseline. One column may be emphasised
 * (the current week, the best day).
 */
import type { ReactNode } from 'react';
import { maxOf, shareBp } from './scale';

export interface ColumnItem {
  readonly key: string;
  readonly label: string;
  readonly value: bigint | null;
  readonly emphasis?: boolean;
}

export interface ColumnsProps {
  readonly items: readonly ColumnItem[];
  /** The figure above each column. Money → `<Money>`; never a raw bigint. */
  readonly format: (value: bigint) => ReactNode;
  readonly label: string;
  readonly width?: number;
  readonly height?: number;
}

const TOP = 22;
const BOTTOM = 22;

export function Columns({ items, format, label, width = 360, height = 150 }: ColumnsProps): ReactNode {
  const real = items.map((i) => i.value).filter((v): v is bigint => v !== null);
  const max = maxOf(real);
  const n = Math.max(1, items.length);
  const slot = (width - 8) / n;
  const bw = Math.min(slot * 0.62, 48);
  const base = height - BOTTOM;
  const x = (i: number): number => 4 + i * slot + (slot - bw) / 2;
  const y = (v: bigint): number => base - ((base - TOP) * shareBp(v, max)) / 10_000;

  return (
    <svg className="columns" viewBox={`0 0 ${String(width)} ${String(height)}`} role="img" aria-label={label}>
      <line className="columns-axis" x1={4} x2={width - 4} y1={base} y2={base} />
      {items.map((it, i) => {
        const cx = x(i) + bw / 2;
        let mark: ReactNode;
        if (it.value === null) {
          mark = (
            <text className="columns-gap" x={cx} y={base - 6} textAnchor="middle">
              —
            </text>
          );
        } else if (it.value === 0n) {
          mark = <rect className="columns-zero" x={x(i)} y={base - 3} width={bw} height={3} rx={1.5} />;
        } else {
          const top = y(it.value);
          mark = (
            <rect
              className={it.emphasis === true ? 'columns-bar columns-bar-emphasis' : 'columns-bar'}
              x={x(i)}
              y={top}
              width={bw}
              height={base - top}
              rx={4}
            />
          );
        }
        return (
          <g key={it.key}>
            {mark}
            {it.value === null ? null : (
              <foreignObject x={cx - slot / 2} y={Math.max(0, (it.value === 0n ? base - 3 : y(it.value)) - 20)} width={slot} height={18}>
                <div className="columns-value tabular">{format(it.value)}</div>
              </foreignObject>
            )}
            <text className="columns-tick" x={cx} y={height - 6} textAnchor="middle">
              {it.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
