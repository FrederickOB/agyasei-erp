/**
 * Service-worker registration and the deliberate update flow (§8.11).
 *
 * vite-plugin-pwa runs Workbox with `skipWaiting` OFF and `registerType:
 * 'prompt'`: a new build downloads fully (atomic precache, SQLite wasm
 * included) and then WAITS. The user-facing affordance is a status-bar chip,
 * never a modal; tapping it consults the version gate before activating.
 */
import { registerSW } from 'virtual:pwa-register';
import {
  CLIENT_SCHEMA_VERSION,
  currentBuildId,
  decideUpdate,
  fetchReleaseGate,
  type UpdateDecision,
} from './version-gate';

type Listener = () => void;

let updateReady = false;
let activate: ((reloadPage?: boolean) => Promise<void>) | null = null;
const listeners = new Set<Listener>();

export function setupServiceWorker(): void {
  try {
    const update = registerSW({
      immediate: true,
      onNeedRefresh() {
        updateReady = true;
        activate = update;
        for (const listener of [...listeners]) listener();
      },
    });
  } catch {
    // No service worker in this context (plain dev serve). The app is fully
    // functional without one; only the install/update story is absent.
  }
}

export function isUpdateReady(): boolean {
  return updateReady;
}

export function subscribeUpdateReady(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export interface SafePoint {
  readonly cartEmpty: boolean;
  readonly saleInFlight: boolean;
}

/** Consult the version gate, then activate the waiting build — or defer. */
export async function applyUpdateIfSanctioned(safePoint: SafePoint): Promise<UpdateDecision> {
  if (activate === null) return 'defer';
  const release = await fetchReleaseGate();
  const decision = decideUpdate({
    currentBuildId: currentBuildId(),
    clientSchemaVersion: CLIENT_SCHEMA_VERSION,
    release,
    cartEmpty: safePoint.cartEmpty,
    saleInFlight: safePoint.saleInFlight,
  });
  if (decision === 'activate') {
    await activate(true);
  }
  return decision;
}
