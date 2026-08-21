/**
 * §8.11: a waiting service worker activates only when the release endpoint
 * sanctions a different build AND the till is at a safe point. An unreachable
 * gate always means "stay on the working build" — offline is normal.
 */
import { describe, expect, it } from 'vitest';
import { decideUpdate, parseReleaseInfo, type ReleaseInfo } from '../src/sw/version-gate';

const RELEASE: ReleaseInfo = {
  build_id: 'build-2',
  min_client_schema: 1,
  max_client_schema: 2,
  cohort: 'pilot',
};

const SAFE = { cartEmpty: true, saleInFlight: false } as const;

describe('decideUpdate', () => {
  it('defers when the gate is unreachable (null release)', () => {
    expect(
      decideUpdate({ currentBuildId: 'build-1', clientSchemaVersion: 1, release: null, ...SAFE }),
    ).toBe('defer');
  });

  it('defers when the sanctioned build is the one already running', () => {
    expect(
      decideUpdate({
        currentBuildId: 'build-2',
        clientSchemaVersion: 1,
        release: RELEASE,
        ...SAFE,
      }),
    ).toBe('defer');
  });

  it('activates a different sanctioned build at a safe point', () => {
    expect(
      decideUpdate({
        currentBuildId: 'build-1',
        clientSchemaVersion: 1,
        release: RELEASE,
        ...SAFE,
      }),
    ).toBe('activate');
  });

  it('never activates under a cashier mid-sale: cart not empty or sale in flight', () => {
    expect(
      decideUpdate({
        currentBuildId: 'build-1',
        clientSchemaVersion: 1,
        release: RELEASE,
        cartEmpty: false,
        saleInFlight: false,
      }),
    ).toBe('defer');
    expect(
      decideUpdate({
        currentBuildId: 'build-1',
        clientSchemaVersion: 1,
        release: RELEASE,
        cartEmpty: true,
        saleInFlight: true,
      }),
    ).toBe('defer');
  });
});

describe('parseReleaseInfo', () => {
  it('accepts the stub shape', () => {
    expect(
      parseReleaseInfo({ build_id: 'dev', min_client_schema: 1, max_client_schema: 1 }),
    ).toEqual({ build_id: 'dev', min_client_schema: 1, max_client_schema: 1 });
  });

  it('rejects malformed payloads instead of guessing', () => {
    expect(parseReleaseInfo(null)).toBeNull();
    expect(parseReleaseInfo('dev')).toBeNull();
    expect(parseReleaseInfo({ build_id: '' })).toBeNull();
    expect(parseReleaseInfo({ build_id: 'dev', min_client_schema: '1', max_client_schema: 1 })).toBeNull();
  });
});
