// @vitest-environment jsdom
/**
 * The status bar is persistent chrome (§8.4): a live status region, never an
 * alert, never a dialog — and the stuck state names the escalation in words.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { StatusBar } from '../src/features/shell/StatusBar';

afterEach(cleanup);

describe('<StatusBar>', () => {
  it('renders offline as a calm status region with the count', () => {
    render(
      <StatusBar
        state={{ kind: 'offline', pendingCount: 14 }}
        localOnly={false}
        updateReady={false}
        onApplyUpdate={() => undefined}
      />,
    );
    const region = screen.getByRole('status');
    expect(region.textContent).toContain('Offline · 14 sales waiting');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders stuck with the manager escalation in plain words', () => {
    render(
      <StatusBar
        state={{
          kind: 'stuck',
          pendingCount: 14,
          oldestQueuedAtMs: Date.parse('2026-08-21T09:12:00'),
        }}
        localOnly={false}
        updateReady={false}
        onApplyUpdate={() => undefined}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain('tell your manager');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the update affordance as a chip in the bar, never a modal', () => {
    render(
      <StatusBar
        state={{ kind: 'online_synced' }}
        localOnly={false}
        updateReady={true}
        onApplyUpdate={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: /update ready/i })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
