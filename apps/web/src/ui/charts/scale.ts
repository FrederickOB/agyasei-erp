/**
 * The one place a bigint becomes a pixel.
 *
 * Every chart in `ui/charts` is fed money or a scaled quantity as `bigint`
 * (ADR-0004) and needs a LENGTH out of it. A length is not money: it is a
 * share of the widest bar, in basis points, and it is allowed to be a JS
 * number because nothing downstream ever adds it to a figure or shows it as
 * one. The division happens in bigint so a forty-million month against a twelve-thousand day
 * does not go through a double on the way to the screen.
 *
 * Nothing in this file formats a figure. Labels are the caller's, produced by
 * `<Money>` or `formatQtyScaled`, so the number a person reads is never the
 * number that decided a width.
 */

/** 0..10 000 — `part` as a share of `whole`. Clamped; `whole <= 0` is 0. */
export function shareBp(part: bigint, whole: bigint): number {
  if (whole <= 0n || part <= 0n) return 0;
  if (part >= whole) return 10_000;
  return Number((part * 10_000n) / whole); // lint-money-ignore: a share, not a figure
}

/** Basis points as a CSS percentage string, one decimal. */
export function bpToPercent(bp: number): string {
  const clamped = Math.max(0, Math.min(10_000, bp));
  return `${(clamped / 100).toFixed(1)}%`;
}

/** The largest of a list, for a shared scale; 0n for an empty list. */
export function maxOf(values: readonly bigint[]): bigint {
  let max = 0n;
  for (const v of values) if (v > max) max = v;
  return max;
}
