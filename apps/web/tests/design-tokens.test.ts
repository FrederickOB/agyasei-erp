/**
 * The design system's colour contract, checked rather than asserted.
 *
 * WHY THIS IS A TEST AND NOT A NOTE IN A DOC. Every pair below was computed
 * once, by hand, and would have quietly rotted the first time somebody nudged
 * a token to make one screen look better. This counter is read in direct
 * sunlight by people who cannot stop and squint, and one of the four sync
 * states means "your sale has not been sent" — contrast here is not polish.
 *
 * Both schemes are checked independently, because a dark palette is not an
 * inverted light one and a pair that passes in one can fail in the other.
 *
 * Thresholds are WCAG 2.2: 4.5:1 for text (1.4.3), 3:1 for the boundary of an
 * interactive control and for meaningful non-text marks (1.4.11).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cssPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/app.css');
const css = readFileSync(cssPath, 'utf8');

function tokensIn(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6});/g)) {
    out[m[1] as string] = m[2] as string;
  }
  return out;
}

const DARK_AT = '@media (prefers-color-scheme: dark)';
const light = tokensIn(css.slice(0, css.indexOf(DARK_AT)));
const dark = {
  ...light,
  ...tokensIn(css.slice(css.indexOf(DARK_AT), css.indexOf('/* ─── BASE'))),
};

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return ((hi as number) + 0.05) / ((lo as number) + 0.05);
}

/** [what it is, foreground token, background token, minimum ratio] */
const PAIRS: readonly (readonly [string, string, string, number])[] = [
  ['body text on the page', 'text', 'bg', 4.5],
  ['body text on a surface', 'text', 'surface', 4.5],
  ['body text on a sunken surface', 'text', 'surface-2', 4.5],
  ['secondary text on a surface', 'text-muted', 'surface', 4.5],
  ['secondary text on a sunken surface', 'text-muted', 'surface-2', 4.5],
  ['secondary text on the page', 'text-muted', 'bg', 4.5],
  ['the primary action’s label', 'brand-ink', 'brand', 4.5],
  ['brand text on its tint', 'brand-text', 'brand-tint', 4.5],
  ['brand text on a surface', 'brand-text', 'surface', 4.5],
  ['the Saved badge', 'ok-ink', 'ok-tint', 4.5],
  ['the Waiting to send badge', 'wait-ink', 'wait-tint', 4.5],
  ['the Needs checking badge', 'attn-ink', 'attn-tint', 4.5],
  // A disabled control still has to be READ — it is how someone works out why
  // they cannot pay yet.
  ['a disabled action’s label', 'text-muted', 'surface-3', 4.5],
  ['the sync icon, connected', 'ok', 'ok-tint', 3],
  ['the sync icon, needing attention', 'attn', 'attn-tint', 3],
  ['the focus ring on the page', 'brand', 'bg', 3],
  ['the focus ring on a surface', 'brand', 'surface', 3],
  ['a control’s edge on a surface', 'control-border', 'surface', 3],
  ['a control’s edge on the page', 'control-border', 'bg', 3],
  ['a control’s edge on a sunken surface', 'control-border', 'surface-2', 3],
  // The chart series (ui/charts). Slots 1 and 2 must stand on their own as
  // marks; slots 3 and 4 are allowed under 3:1 ONLY because every mark drawn
  // in them carries a direct label (dataviz relief rule) — so they are not
  // listed here, and a chart that uses them without a label is the bug.
  ['the first chart series as a mark on a surface', 'chart-1', 'surface', 3],
  ['the second chart series as a mark on a surface', 'chart-2', 'surface', 3],
  ['the target line on a surface', 'chart-target', 'surface', 3],
  ['the Unavailable word on its tint', 'wait-ink', 'wait-tint', 4.5],
  // The back office's own palette (features/office). Every pill's ink against
  // its own tint, and the two body inks against both card surfaces.
  ['office body text on a card', 'o-text', 'o-card', 4.5],
  ['office secondary text on a card', 'o-text-2', 'o-card', 4.5],
  ['office muted text on a card', 'o-muted', 'o-card', 4.5],
  ['office muted text on a sunken card', 'o-muted', 'o-card-2', 4.5],
  ['office muted text on the canvas', 'o-muted', 'o-canvas', 4.5],
  ['an office "good" pill', 'o-mint-text', 'o-mint-tint', 4.5],
  ['an office "warning" pill', 'o-amber-text', 'o-amber-tint', 4.5],
  ['an office "attention" pill', 'o-red-text', 'o-red-tint', 4.5],
  ['an office "info" pill', 'o-blue-text', 'o-blue-tint', 4.5],
  ['an office link on a card', 'o-violet-text', 'o-card', 4.5],
  ['an office neutral pill', 'o-grey-text', 'o-grey-tint', 4.5],
  ['the first chart series on an office card', 'chart-1', 'o-card', 3],
  ['the second chart series on an office card', 'chart-2', 'o-card', 3],
  ['the office primary button label', 'brand-ink', 'o-violet', 4.5],
  ['the office primary button label, gradient end', 'brand-ink', 'o-violet-2', 4.5],
  // The counter's category key: a card's leading edge and a chip's dot. Marks,
  // not text — but they are how a department is told apart across the grid.
  ...[0, 1, 2, 3, 4, 5, 6, 7].map(
    (i) => [`category colour ${String(i)} as a mark on a surface`, `cat-${String(i)}`, 'surface', 3] as const,
  ),
  // The complete-sale button is green with white words, at large-text size.
  ['the complete-sale label', 'brand-ink', 'ok', 3],
];

describe('the counter’s colour tokens', () => {
  it('parses both schemes out of the one stylesheet', () => {
    expect(Object.keys(light).length).toBeGreaterThan(20);
    expect(dark['bg']).not.toBe(light['bg']);
    expect(dark['text']).not.toBe(light['text']);
  });

  for (const [scheme, tokens] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    it(`meets WCAG contrast on every declared pair — ${scheme}`, () => {
      const failures: string[] = [];
      for (const [what, fg, bg, min] of PAIRS) {
        const front = tokens[fg];
        const back = tokens[bg];
        expect(front, `--${fg} is missing from the ${scheme} scheme`).toBeDefined();
        expect(back, `--${bg} is missing from the ${scheme} scheme`).toBeDefined();
        const ratio = contrast(front as string, back as string);
        if (ratio < min) {
          failures.push(`${what}: ${ratio.toFixed(2)}:1 (needs ${min}:1) — ${front} on ${back}`);
        }
      }
      expect(failures).toEqual([]);
    });
  }

  it('never lets a hover state lower a control’s edge contrast', () => {
    // The bug this catches, which shipped for exactly one commit: hovering a
    // control lightened its border, taking the edge from 3.5:1 to 1.65:1 at
    // the moment someone was aiming at it. Hover changes the FILL now.
    const hoverRule = css.slice(css.indexOf('.pressable:hover'), css.indexOf('/* ─── APP BAR'));
    expect(hoverRule).not.toContain('border-color');
  });

  it('respects reduced motion without hiding work in flight', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('animation-duration: 0.01ms !important');
    // The one exception, deliberately: with the indeterminate line stopped,
    // "sending" and "stuck" look identical to someone waiting on a sale.
    expect(reduced).toContain('.status-progress::after');
  });
});
