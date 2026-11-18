// @vitest-environment jsdom
/**
 * The device-path screens: enrolment, the shared-tablet lock screen, the
 * lease banner, the lease narrowing what the shell OFFERS, and the back-office
 * device screen issuing a one-time code. The controller and the API are
 * faked; the cryptography is proven in auth-core.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ApiCallOptions, ApiEndpoint, ApiFetch } from '../src/data/api/client';
import type { PermissionsState } from '../src/data/api/session';
import { DeviceAuth } from '../src/data/auth/device-auth';
import { memoryStore } from '../src/data/auth/store';
import { DevicesAdmin } from '../src/features/admin/Admin';
import { AuthGate, LeaseBanner } from '../src/features/auth/AuthGate';
import { ALLOW_ALL, applyLease, type LeaseGate } from '../src/features/auth/lease-gate';
import { DESTINATIONS } from '../src/features/shell/destinations';

afterEach(cleanup);

describe('the front door', () => {
  it('an unenrolled device asks for the one-time code, and only accepts 8 characters', async () => {
    const auth = new DeviceAuth({ apiUrl: 'http://api.test', store: memoryStore() });
    render(<AuthGate auth={auth}>{() => <p>APP</p>}</AuthGate>);
    expect(await screen.findByText('Set up this device')).toBeTruthy();
    const input = screen.getByLabelText('Enrolment code') as HTMLInputElement;
    const button = screen.getByRole('button', { name: 'Set up' }) as HTMLButtonElement;
    fireEvent.change(input, { target: { value: 'abcd-12' } });
    expect(button.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'abcd-1234' } });
    expect(input.value).toBe('ABCD-1234');
    expect(button.disabled).toBe(false);
    expect(screen.queryByText('APP')).toBeNull(); // never the app behind the gate
  });

  it('an enrolled tablet with people on it offers them by name, then a PIN pad — never the app', async () => {
    const store = memoryStore();
    await store.set('device', { deviceId: 'd', tenantId: 't', label: 'Counter 1', formFactor: 'tablet', locationIds: [], jkt: 'x' });
    await store.set('user/u1', { userId: 'u1', displayName: 'Ama', sealed: false, failedAttempts: 0, locationIds: [] });
    await store.set('user/u2', { userId: 'u2', displayName: 'Kofi', sealed: true, failedAttempts: 5, locationIds: [] });
    const auth = new DeviceAuth({ apiUrl: 'http://api.test', store });
    render(<AuthGate auth={auth}>{() => <p>APP</p>}</AuthGate>);
    expect(await screen.findByText('Who is at the counter?')).toBeTruthy();
    expect(screen.getByText('Sign in online to unlock')).toBeTruthy(); // Kofi is sealed, not deleted
    fireEvent.click(screen.getByRole('button', { name: /Ama/ }));
    expect(await screen.findByText('Ama — enter your PIN')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^[0-9]$/ })).toHaveLength(10);
    expect(screen.queryByText('APP')).toBeNull();
  });
});

describe('the lease (§2.7) on screen', () => {
  const restricted: LeaseGate = {
    mode: 'restricted',
    allows: (c) => c === 'sale.record' || c === 'stock.view',
    secondsLeft: 3 * 3600,
    reason: 'past_full_until',
  };
  const sealed: LeaseGate = { mode: 'sealed', allows: () => false, secondsLeft: null, reason: 'past_hard_stop' };

  it('restricted says cash and lookups only, with the time left; sealed says read-only and nothing lost', () => {
    render(<LeaseBanner gate={restricted} onReconnect={() => undefined} />);
    expect(screen.getByRole('status').textContent).toMatch(/cash sales and lookups only — 3 h 0 min left/);
    cleanup();
    render(<LeaseBanner gate={sealed} onReconnect={() => undefined} />);
    expect(screen.getByRole('status').textContent).toMatch(/Read-only.*Nothing has been lost/);
    cleanup();
    render(<LeaseBanner gate={ALLOW_ALL} onReconnect={() => undefined} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('narrows what the shell offers: restricted keeps `always` codes only, sealed keeps none', () => {
    const live: PermissionsState = {
      status: 'live',
      asOfMs: 0,
      snapshot: {
        userId: 'u',
        grants: [
          { code: 'sale.record', locationId: 'L' },
          { code: 'stock.view', locationId: 'L' },
          { code: 'stock.adjust', locationId: 'L' },
          { code: 'sale.record.credit', locationId: 'L' },
        ],
        codes: ['sale.record', 'sale.record.credit', 'stock.adjust', 'stock.view'],
        locationIds: ['L'],
      },
    };
    const r = applyLease(live, restricted);
    expect(r.status === 'live' && r.snapshot.codes).toEqual(['sale.record', 'stock.view']);
    const s = applyLease(live, sealed);
    expect(s.status === 'live' && s.snapshot.codes).toEqual([]);
    expect(applyLease(live, ALLOW_ALL)).toBe(live);
    // "Could not ask the server" never re-opens what the lease closed.
    const unknown: PermissionsState = {
      status: 'unknown',
      failure: { kind: 'offline', message: '', detail: null, status: null },
    };
    const u = applyLease(unknown, sealed, ['L']);
    expect(u.status).toBe('remembered');
  });

  it('administration is office-only: never on the counter\'s rail', () => {
    const admin = DESTINATIONS.filter((d) => ['people', 'devices', 'roles'].includes(d.id));
    expect(admin).toHaveLength(3);
    expect(admin.every((d) => d.officeOnly === true && !d.counterWork)).toBe(true);
  });
});

describe('the back office issues a one-time code', () => {
  const ENDPOINT: ApiEndpoint = { url: 'http://api.test', bearer: 'dev' };
  function options(): ApiCallOptions {
    const fetchFn: ApiFetch = (url, init) => {
      const path = new URL(url).pathname.replace('/trpc/', '');
      const reply = (json: unknown) =>
        Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ result: { data: { json } } }) });
      if (path === 'admin.devices.list') return reply([]);
      if (path === 'admin.locations') {
        return reply([{ id: '018f3a1e-0000-7000-8000-00000000aaaa', code: 'OUT-01', name: 'Techiman', kind: 'OUTLET', parentId: null }]);
      }
      if (path === 'admin.devices.issueCode') {
        const body = JSON.parse(String(init.body)) as { json: { label: string; locationId: string | null } };
        expect(body.json.label).toBe('Counter 2');
        expect('tenantId' in body.json).toBe(false);
        return reply({ codeId: '018f3a1e-0000-7000-8000-00000000cccc', expiresAt: new Date(Date.now() + 900_000).toISOString(), code: 'K7QM-2XRB' });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    };
    return { endpoint: ENDPOINT, fetchFn };
  }

  it('shows the code once, with how long it lasts and that it is not stored', async () => {
    render(<DevicesAdmin apiOptions={options()} />);
    fireEvent.change(await screen.findByPlaceholderText('e.g. Counter 2'), { target: { value: 'Counter 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Issue a code' }));
    await waitFor(() => expect(screen.getByText('K7QM-2XRB')).toBeTruthy());
    expect(screen.getByRole('status').textContent).toMatch(/15 minutes.*not stored anywhere/);
  });
});
