/**
 * A single-series line: change over time, at a glance.
 *
 * Inline SVG, no library. The three reasons are in the design document and
 * they are all about the device: a charting library is 100–300 KB against a
 * 600 KB all-routes budget (§8.10); its defaults draw a `null` as a zero,
 * which is the one thing a figure from `reports.ts` must never become; and
 * its canvas costs a compositor pass on the GPUs these tablets have.
 *
 * Points are `bigint`; the y-scale is computed in bigint and only the final
 * 0..10 000 share becomes a coordinate (`shareBp`). A `null` point is a GAP in
 * the line, not a dip to the baseline. The last real point is emphasised and
 * carries the caller's formatted label, so the line reads without a legend
 * — a single series needs none; the title names it.
 */
import type { ReactNode } from 'react';
import { maxOf, shareBp } from './scale';

export interface SparklineProps {
  readonly points: readonly (bigint | null)[];
  /** Formatted figure for the emphasised last point. */
  readonly endLabel?: ReactNode;
  /** A dashed reference line at this value, on the same scale. */
  readonly reference?: bigint;
  readonly label: string;
  /** Drawing box. Defaults suit a dashboard tile. */
  readonly width?: number;
  readonly height?: number;
}

const PAD = 4;

export function Sparkline({
  points,
  endLabel,
  reference,
  label,
  width = 240,
  height = 56,
}: SparklineProps): ReactNode {
  const real = points.filter((p): p is bigint => p !== null);
  const max = maxOf(reference === undefined ? real : [...real, reference]);
  const n = points.length;
  const x = (i: number): number => (n <= 1 ? PAD : PAD + ((width - 2 * PAD) * i) / (n - 1));
  const y = (v: bigint): number => height - PAD - ((height - 2 * PAD) * shareBp(v, max)) / 10_000;

  // One path per run of non-null points, so a gap is a gap.
  const runs: string[] = [];
  let current: string[] = [];
  points.forEach((p, i) => {
    if (p === null) {
      if (current.length > 0) runs.push(current.join(' '));
      current = [];
      return;
    }
    current.push(`${current.length === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(p).toFixed(1)}`);
  });
  if (current.length > 0) runs.push(current.join(' '));

  let lastIndex = -1;
  for (let i = n - 1; i >= 0; i -= 1) {
    if (points[i] !== null) {
      lastIndex = i;
      break;
    }
  }
  const last = lastIndex === -1 ? null : (points[lastIndex] as bigint);

  return (
    <figure className="sparkline">
      <svg
        className="sparkline-svg"
        viewBox={`0 0 ${String(width)} ${String(height)}`}
        role="img"
        aria-label={label}
        preserveAspectRatio="none"
      >
        <line className="sparkline-axis" x1={PAD} x2={width - PAD} y1={height - PAD} y2={height - PAD} />
        {reference === undefined ? null : (
          <line
            className="sparkline-reference"
            x1={PAD}
            x2={width - PAD}
            y1={y(reference)}
            y2={y(reference)}
          />
        )}
        {runs.map((d, i) => (
          <path key={i} className="sparkline-line" d={d} />
        ))}
        {last === null ? null : (
          <circle className="sparkline-end" cx={x(lastIndex)} cy={y(last)} r={3.5} />
        )}
      </svg>
      {endLabel === undefined ? null : <figcaption className="sparkline-end-label tabular">{endLabel}</figcaption>}
    </figure>
  );
}
