/**
 * Column bars over time — one bar per business day, a rolling average
 * drawn across them, and an optional reference line.
 *
 * This is the office dashboard's main chart (docs/design/mockups/
 * office-dashboard.html). Why columns and not a line: a day's takings is a
 * discrete amount, a dark day is a real zero that a line would smooth over,
 * and columns take direct labels without a legend. The rolling average is
 * the line, because that IS continuous.
 *
 * Every value is a `bigint` (ADR-0004). Only shares become coordinates
 * (`shareBp`); the average is an integer division in bigint used as a
 * SHAPE, never shown as a figure — the figure a person reads is the caller's
 * `endLabel`, formatted by `<Money>`.
 *
 * `null` is a gap (nothing drawn). `0n` is a zero: a low stub on the
 * baseline, so a closed day reads as "closed", not "no data".
 */
import type { ReactNode } from 'react';
import { maxOf, shareBp } from './scale';

export interface DailyBarsProps {
  readonly points: readonly (bigint | null)[];
  /** One per point; only some are drawn as ticks (every `tickEvery`). */
  readonly labels: readonly string[];
  /** Dashed reference on the same scale — a plan, or the range's average. */
  readonly reference?: bigint;
  /** Window for the rolling average line. 0 disables it. */
  readonly averageWindow?: number;
  /** Formatted figure for the last real point, set above its bar. */
  readonly endLabel?: ReactNode;
  readonly label: string;
  readonly tickEvery?: number;
  readonly width?: number;
  readonly height?: number;
}

const LEFT = 30;
const TOP = 16;
const BOTTOM = 26;

export function DailyBars({
  points,
  labels,
  reference,
  averageWindow = 7,
  endLabel,
  label,
  tickEvery = 5,
  width = 760,
  height = 210,
}: DailyBarsProps): ReactNode {
  const real = points.filter((p): p is bigint => p !== null);
  const max = maxOf(reference === undefined ? real : [...real, reference]);
  const n = points.length;
  const plotW = width - LEFT - 6;
  const base = height - BOTTOM;
  const slot = n === 0 ? plotW : plotW / n;
  const bw = slot * 0.58;
  const x = (i: number): number => LEFT + i * slot + (slot - bw) / 2;
  const y = (v: bigint): number => base - ((base - TOP) * shareBp(v, max)) / 10_000;

  let lastIndex = -1;
  for (let i = n - 1; i >= 0; i -= 1) {
    if (points[i] !== null) {
      lastIndex = i;
      break;
    }
  }

  // Rolling average as a path. Integer division in bigint: a shape only.
  const avg: string[] = [];
  if (averageWindow > 1) {
    for (let i = averageWindow - 1; i < n; i += 1) {
      const window = points.slice(i - averageWindow + 1, i + 1);
      if (window.some((p) => p === null)) continue;
      const sum = (window as bigint[]).reduce((a, b) => a + b, 0n);
      const mean = sum / BigInt(averageWindow);
      avg.push(`${avg.length === 0 ? 'M' : 'L'}${(x(i) + bw / 2).toFixed(1)} ${y(mean).toFixed(1)}`);
    }
  }

  const gridValues = max > 0n ? [max, (max * 2n) / 3n, max / 3n] : [];

  return (
    <svg className="dailybars" viewBox={`0 0 ${String(width)} ${String(height)}`} role="img" aria-label={label}>
      {gridValues.map((g, i) => (
        <line key={i} className="dailybars-grid" x1={LEFT} x2={width - 6} y1={y(g)} y2={y(g)} />
      ))}
      <line className="dailybars-axis" x1={LEFT} x2={width - 6} y1={base} y2={base} />
      {points.map((p, i) => {
        if (p === null) return null;
        if (p === 0n) {
          return <rect key={i} className="dailybars-zero" x={x(i)} y={base - 3} width={bw} height={3} rx={1.5} />;
        }
        const top = y(p);
        return (
          <rect
            key={i}
            className={i === lastIndex ? 'dailybars-bar dailybars-bar-last' : 'dailybars-bar'}
            x={x(i)}
            y={top}
            width={bw}
            height={base - top}
            rx={4}
          />
        );
      })}
      {reference === undefined ? null : (
        <line className="dailybars-reference" x1={LEFT} x2={width - 6} y1={y(reference)} y2={y(reference)} />
      )}
      {avg.length > 1 ? <path className="dailybars-average" d={avg.join(' ')} /> : null}
      {labels.map((l, i) =>
        i === n - 1 || (i % tickEvery === 0 && n - 1 - i >= Math.max(2, Math.ceil(tickEvery / 2))) ? (
          <text key={i} className="dailybars-tick" x={x(i) + bw / 2} y={height - 6} textAnchor="middle">
            {l}
          </text>
        ) : null,
      )}
      {lastIndex >= 0 && endLabel !== undefined ? (
        <foreignObject x={x(lastIndex) + bw / 2 - 60} y={Math.max(0, y(points[lastIndex] as bigint) - 20)} width={120} height={18}>
          <div className="dailybars-end tabular">{endLabel}</div>
        </foreignObject>
      ) : null}
    </svg>
  );
}
