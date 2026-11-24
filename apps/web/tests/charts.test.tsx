// @vitest-environment jsdom
/**
 * The chart primitives, tested for the two ways a chart lies.
 *
 * 1. **A width that is not the figure.** Bars and meters are laid out from a
 *    bigint share; the figure a person reads is whatever the caller
 *    formatted. If those two ever disagree, the chart is a lie with a
 *    confident face — so the share is checked against the figure here.
 * 2. **A `null` drawn as a zero.** The reason there is no charting library:
 *    a withheld ratio must render the WORD, never an empty bar against a
 *    target, and a missing day is a gap in the line, not a dip.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { Bars } from '../src/ui/charts/Bars';
import { Columns } from '../src/ui/charts/Columns';
import { DailyBars } from '../src/ui/charts/DailyBars';
import { SplitBars } from '../src/ui/charts/SplitBars';
import { Meter } from '../src/ui/charts/Meter';
import { Sparkline } from '../src/ui/charts/Sparkline';
import { bpToPercent, maxOf, shareBp } from '../src/ui/charts/scale';

/** jsdom canonicalises `50.0%` to `50%`; compare the number, not the string. */
function pct(el: Element | null | undefined, prop: 'width' | 'left'): number {
  return Number.parseFloat((el as HTMLElement).style[prop]);
}

afterEach(cleanup);

describe('shareBp — the only bigint→pixel conversion', () => {
  it('is a share in basis points, computed in bigint', () => {
    expect(shareBp(2_500n, 10_000n)).toBe(2_500);
    expect(shareBp(1n, 3n)).toBe(3_333);
    // Far beyond double precision: a GH₵ 40m month in pesewas against a total.
    expect(shareBp(4_000_000_000_000_000_001n, 8_000_000_000_000_000_002n)).toBe(5_000);
  });
  it('clamps rather than overflowing the track', () => {
    expect(shareBp(12n, 10n)).toBe(10_000);
    expect(shareBp(-5n, 10n)).toBe(0);
    expect(shareBp(5n, 0n)).toBe(0);
  });
  it('formats to a CSS percentage with one decimal', () => {
    expect(bpToPercent(3_333)).toBe('33.3%');
    expect(bpToPercent(10_000)).toBe('100.0%');
    expect(bpToPercent(-1)).toBe('0.0%');
  });
  it('finds the widest bar for a shared scale', () => {
    expect(maxOf([3n, 9n, 1n])).toBe(9n);
    expect(maxOf([])).toBe(0n);
  });
});

describe('Bars', () => {
  it('ranks, sizes from the share and labels from the caller’s formatter', () => {
    render(
      <Bars
        label="Net revenue by location"
        rows={[
          { key: 'a', label: 'Small', value: 25_000n },
          { key: 'b', label: 'Big', value: 100_000n },
        ]}
        format={(v) => `F${String(v)}`}
      />,
    );
    const list = screen.getByRole('list', { name: 'Net revenue by location' });
    const rows = list.querySelectorAll('.bars-row');
    expect(rows[0]?.textContent).toContain('Big');
    expect(rows[0]?.textContent).toContain('F100000');
    expect(pct(rows[0]?.querySelector('.bars-fill'), 'width')).toBe(100);
    expect(pct(rows[1]?.querySelector('.bars-fill'), 'width')).toBe(25);
  });
  it('keeps the order it was given when told not to rank', () => {
    render(
      <Bars
        label="Buckets"
        ranked={false}
        rows={[
          { key: 'cur', label: 'Current', value: 1n },
          { key: 'late', label: 'Late', value: 9n },
        ]}
        format={(v) => String(v)}
      />,
    );
    const rows = screen.getByRole('list').querySelectorAll('.bars-row');
    expect(rows[0]?.textContent).toContain('Current');
  });
  it('says why a list is short instead of showing a lonely bar', () => {
    render(
      <Bars label="By place" rows={[{ key: 'a', label: 'Only', value: 1n }]} format={String} note="One location is trading." />,
    );
    expect(screen.getByText('One location is trading.')).toBeTruthy();
  });
});

describe('Meter', () => {
  it('fills to the share and places the target mark on the same scale', () => {
    const { container } = render(<Meter label="Margin" value={500n} max={1_000n} target={750n} />);
    const meter = screen.getByRole('meter', { name: 'Margin' });
    expect(meter.getAttribute('aria-valuenow')).toBe('5000');
    expect(pct(container.querySelector('.meter-fill'), 'width')).toBe(50);
    expect(pct(container.querySelector('.meter-target'), 'left')).toBe(75);
  });
  it('renders null as the word Unavailable with the server’s reason — never an empty bar', () => {
    const { container } = render(
      <Meter label="Inventory days" value={null} max={1n} target={1n} unavailableReason="NO_COST_BASIS" />,
    );
    expect(screen.getByRole('status', { name: 'Inventory days: unavailable' })).toBeTruthy();
    expect(screen.getByText('Unavailable')).toBeTruthy();
    expect(screen.getByText('NO_COST_BASIS')).toBeTruthy();
    expect(container.querySelector('.meter-fill')).toBeNull();
    expect(container.querySelector('.meter-target')).toBeNull();
  });
});

describe('Sparkline', () => {
  it('draws a missing point as a gap, not a dip to the baseline', () => {
    const { container } = render(
      <Sparkline label="Daily revenue" points={[10n, 20n, null, 30n, 40n]} endLabel="40" />,
    );
    const paths = container.querySelectorAll('path.sparkline-line');
    expect(paths.length).toBe(2);
    expect(screen.getByRole('img', { name: 'Daily revenue' })).toBeTruthy();
    expect(screen.getByText('40')).toBeTruthy();
  });
  it('emphasises the last real point, not the last slot', () => {
    const { container } = render(<Sparkline label="Line" points={[10n, 20n, null]} width={100} height={50} />);
    const end = container.querySelector('circle.sparkline-end');
    // Index 1 of 3 on a 100-wide box with 4px padding: 4 + 92 * 1/2 = 50.
    expect(end?.getAttribute('cx')).toBe('50');
  });
  it('scales the reference line on the same axis as the points', () => {
    const { container } = render(<Sparkline label="Line" points={[50n]} reference={100n} width={100} height={54} />);
    const ref = container.querySelector('line.sparkline-reference');
    // Max is the reference (100): it sits at the top pad.
    expect(ref?.getAttribute('y1')).toBe('4');
  });
});

describe('DailyBars', () => {
  it('names the day and its figure under the pointer — and only when asked to', () => {
    const { container, rerender } = render(
      <DailyBars
        label="Days"
        points={[10n, null, 30n]}
        labels={['1 Nov', '2 Nov', '3 Nov']}
        averageWindow={0}
        format={(v) => `${v.toString()} units`}
      />,
    );
    const hits = container.querySelectorAll('.dailybars-hit');
    expect(hits).toHaveLength(3);
    fireEvent.pointerEnter(hits[0]!);
    expect(screen.getByRole('status').textContent).toBe('1 Nov10 units');
    expect(container.querySelector('.dailybars-bar-hover')).not.toBeNull();
    // A gap is named as a gap, never as a zero.
    fireEvent.pointerEnter(hits[1]!);
    expect(screen.getByRole('status').textContent).toBe('2 NovNo figure');
    fireEvent.pointerLeave(container.querySelector('.dailybars-wrap')!);
    expect(screen.queryByRole('status')).toBeNull();

    // Without a formatter there are no targets and no wrapper: the old chart.
    rerender(<DailyBars label="Days" points={[10n]} labels={['1 Nov']} averageWindow={0} />);
    expect(container.querySelector('.dailybars-hit')).toBeNull();
    expect(container.querySelector('.dailybars-wrap')).toBeNull();
  });

  it('draws a zero as a stub on the baseline and a null as nothing', () => {
    const { container } = render(
      <DailyBars label="Days" points={[10n, 0n, null, 30n]} labels={['a', 'b', 'c', 'd']} averageWindow={0} />,
    );
    expect(container.querySelectorAll('rect.dailybars-bar').length).toBe(2);
    expect(container.querySelectorAll('rect.dailybars-zero').length).toBe(1);
    expect(screen.getByRole('img', { name: 'Days' })).toBeTruthy();
  });
  it('emphasises the last real bar and sizes bars from the bigint share', () => {
    const { container } = render(
      <DailyBars label="Days" points={[50n, 100n]} labels={['a', 'b']} averageWindow={0} width={100} height={100} />,
    );
    const bars = container.querySelectorAll('rect.dailybars-bar');
    expect(bars[1]?.classList.contains('dailybars-bar-last')).toBe(true);
    const h0 = Number(bars[0]?.getAttribute('height'));
    const h1 = Number(bars[1]?.getAttribute('height'));
    expect(Math.round((h0 / h1) * 100)).toBe(50);
  });
  it('draws the rolling average only where a full window of real points exists', () => {
    const { container } = render(
      <DailyBars label="Days" points={[1n, 2n, 3n, 4n, 5n]} labels={['a', 'b', 'c', 'd', 'e']} averageWindow={3} />,
    );
    // Windows end at indexes 2, 3, 4 → three points → one path with M + 2 L.
    const d = container.querySelector('path.dailybars-average')?.getAttribute('d') ?? '';
    expect(d.startsWith('M')).toBe(true);
    expect((d.match(/L/g) ?? []).length).toBe(2);
  });
  it('puts the reference line on the same scale as the bars', () => {
    const { container } = render(
      <DailyBars label="Days" points={[50n]} labels={['a']} reference={100n} averageWindow={0} width={100} height={100} />,
    );
    // Max is the reference: it sits at the top pad (16).
    expect(container.querySelector('line.dailybars-reference')?.getAttribute('y1')).toBe('16');
  });
});

describe('Bars with a withheld value', () => {
  it('draws no bar, says Unavailable, and sorts the row last', () => {
    const { container } = render(
      <Bars
        label="Margin"
        rows={[
          { key: 'a', label: 'A', value: null },
          { key: 'b', label: 'B', value: 5n },
        ]}
        format={(v) => String(v)}
        mark={10n}
      />,
    );
    const rows = container.querySelectorAll('.bars-row');
    expect(rows[0]?.textContent).toContain('B');
    expect(rows[1]?.textContent).toContain('Unavailable');
    expect(rows[1]?.querySelector('.bars-fill')).toBeNull();
    // The mark sits on the shared scale: 10 is the max, so 100%.
    expect(pct(rows[0]?.querySelector('.bars-mark'), 'left')).toBe(100);
    expect(pct(rows[0]?.querySelector('.bars-fill'), 'width')).toBe(50);
  });
});

describe('Columns', () => {
  it('labels every real column, marks a gap, stubs a zero, emphasises one', () => {
    const { container } = render(
      <Columns
        label="Weeks"
        items={[
          { key: 'a', label: 'w1', value: 10n },
          { key: 'b', label: 'w2', value: null },
          { key: 'c', label: 'w3', value: 0n },
          { key: 'd', label: 'w4', value: 20n, emphasis: true },
        ]}
        format={(v) => `F${String(v)}`}
      />,
    );
    expect(screen.getByRole('img', { name: 'Weeks' })).toBeTruthy();
    expect(container.querySelectorAll('rect.columns-bar').length).toBe(2);
    expect(container.querySelectorAll('rect.columns-bar-emphasis').length).toBe(1);
    expect(container.querySelectorAll('rect.columns-zero').length).toBe(1);
    expect(container.querySelectorAll('text.columns-gap').length).toBe(1);
    expect(screen.getByText('F10')).toBeTruthy();
    expect(screen.getByText('F20')).toBeTruthy();
    expect(screen.queryByText('F0')).toBeTruthy();
  });
});

describe('SplitBars', () => {
  it('always draws the legend and sizes segments as shares of the row and rows of the max', () => {
    const { container } = render(
      <SplitBars
        label="Cash and credit"
        aName="Cash"
        bName="Credit"
        rows={[
          { key: 'a', label: 'A', a: 75n, b: 25n },
          { key: 'b', label: 'B', a: 10n, b: 40n },
        ]}
        format={(v) => `T${String(v)}`}
      />,
    );
    expect(screen.getByLabelText('Cash and credit — legend').textContent).toContain('Credit');
    const rows = container.querySelectorAll('.splitbars-row');
    expect(pct(rows[0]?.querySelector('.splitbars-bar'), 'width')).toBe(100);
    expect(pct(rows[1]?.querySelector('.splitbars-bar'), 'width')).toBe(50);
    expect(pct(rows[0]?.querySelector('.splitbars-a'), 'width')).toBe(75);
    expect(rows[0]?.textContent).toContain('T100');
    expect(rows[0]?.textContent).toContain('75% cash');
  });
});
