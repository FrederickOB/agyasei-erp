/**
 * The service-worker VERSION GATE (§8.11) — the seam §9's release rings hang
 * off. A waiting service worker is never activated on its own initiative:
 * before applying an update the client asks a small release endpoint which
 * build this device should run. The endpoint is stubbed in dev as
 * `public/release.json`; in production it is served per cohort (pilot
 * location -> region -> fleet) by the release infrastructure, `no-store`.
 *
 * The build also never activates under a cashier mid-sale: activation waits
 * for a safe point (cart empty, no sale in flight) or the next launch.
 * An unreachable gate means: stay on the working build. Offline is normal.
 */

export interface ReleaseInfo {
  readonly build_id: string;
  readonly min_client_schema: number;
  readonly max_client_schema: number;
  readonly cohort?: string;
}

/**
 * The schema contract THIS build was compiled against. Checked against the
 * sync handshake's supported range at boot and on reconnect; a client outside
 * the range (either direction) enters read-only quarantine — it displays, it
 * drains its queue, it accepts no new writes (§8.11). The quarantine
 * enforcement lives with the sync layer wiring; this constant is the client
 * half of the contract.
 */
export const CLIENT_SCHEMA_VERSION = 1;

export const RELEASE_GATE_PATH = '/release.json';

export function currentBuildId(): string {
  return __BUILD_ID__;
}

export function parseReleaseInfo(value: unknown): ReleaseInfo | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['build_id'] !== 'string' || v['build_id'].length === 0) return null;
  if (!Number.isInteger(v['min_client_schema']) || !Number.isInteger(v['max_client_schema'])) {
    return null;
  }
  const info: ReleaseInfo = {
    build_id: v['build_id'],
    min_client_schema: v['min_client_schema'] as number,
    max_client_schema: v['max_client_schema'] as number,
    ...(typeof v['cohort'] === 'string' ? { cohort: v['cohort'] } : {}),
  };
  return info;
}

export async function fetchReleaseGate(fetchFn: typeof fetch = fetch): Promise<ReleaseInfo | null> {
  try {
    const res = await fetchFn(RELEASE_GATE_PATH, { cache: 'no-store' });
    if (!res.ok) return null;
    return parseReleaseInfo((await res.json()) as unknown);
  } catch {
    return null; // unreachable gate -> stay on the working build
  }
}

export type UpdateDecision = 'activate' | 'defer';

export interface UpdateContext {
  readonly currentBuildId: string;
  readonly clientSchemaVersion: number;
  readonly release: ReleaseInfo | null;
  readonly cartEmpty: boolean;
  readonly saleInFlight: boolean;
}

export function decideUpdate(ctx: UpdateContext): UpdateDecision {
  // Gate unreachable: the working build keeps working. Never activate blind.
  if (ctx.release === null) return 'defer';
  // The endpoint says this device should run what it is already running.
  if (ctx.release.build_id === ctx.currentBuildId) return 'defer';
  // §8.11: never under a cashier mid-sale. Wait for a safe point.
  if (!ctx.cartEmpty || ctx.saleInFlight) return 'defer';
  return 'activate';
}
