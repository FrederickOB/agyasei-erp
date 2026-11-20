/**
 * Which credential this build speaks with — decided ONCE, from configuration.
 *
 *   none        no API configured: the local-only rehearsal (§8.1).
 *   device      THE PRODUCTION PATH. An enrolled device, an IdP sign-in, a
 *               per-user PIN, DPoP-bound tokens, the offline lease
 *               (device-auth.ts). Selected whenever an API is configured and
 *               no dev bearer is.
 *   dev-bearer  DEV ONLY. `VITE_API_TOKEN` — a static HS256 bearer minted by
 *               `pnpm dev:token` against the local stack, kept so the live
 *               drills and the dev workflow keep working. A production build
 *               never sets it, and the API refuses HS256 entirely unless it was
 *               started with a dev secret (apps/api/src/identity/config.ts).
 */
import type { ActiveSession } from './device-auth';
import { DeviceAuth } from './device-auth';
import { indexedDbStore } from './store';
import { b64urlJson } from './webcrypto';

export type AuthMode = 'none' | 'dev-bearer' | 'device';

function env(name: 'VITE_API_URL' | 'VITE_API_TOKEN'): string | null {
  const v = (import.meta.env as Record<string, unknown>)[name];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function authMode(): AuthMode {
  if (env('VITE_API_URL') === null) return 'none';
  return env('VITE_API_TOKEN') !== null ? 'dev-bearer' : 'device';
}

let singleton: DeviceAuth | null = null;

/** The device's identity controller, or null when this build is not in device mode. */
export function deviceAuth(): DeviceAuth | null {
  if (singleton) return singleton;
  if (authMode() !== 'device') return null;
  const apiUrl = env('VITE_API_URL')!;
  singleton = new DeviceAuth({
    apiUrl: apiUrl.endsWith('/') ? apiUrl.slice(0, -1) : apiUrl,
    store: indexedDbStore(),
    ...(typeof sessionStorage !== 'undefined' ? { pendingStore: sessionStorage } : {}),
  });
  return singleton;
}

/** Tests only. */
export function setDeviceAuthForTests(auth: DeviceAuth | null): void {
  singleton = auth;
}

/**
 * A LOCAL, UNSIGNED description of the unlocked session, in the claim format
 * the self-configuration modules already read (`session/bearer-claims.ts`:
 * `uid` and `locs`). It is NEVER sent anywhere — requests carry the DPoP-bound
 * token from `DeviceAuth.authorize` — and it decides nothing the server does
 * not re-decide: it tells this till which counter it stands at and whose
 * cached capability list to show, exactly as the dev bearer's claims did.
 */
export function sessionDescriptor(session: ActiveSession | null): string | null {
  if (!session) return null;
  return `${b64urlJson({ alg: 'none', typ: 'erp-session-descriptor' })}.${b64urlJson({
    uid: session.userId,
    locs: session.locationIds,
  })}.`;
}
