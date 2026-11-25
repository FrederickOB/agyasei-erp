/**
 * The offline states (§8.4), as a small explicit state machine.
 *
 * Offline is the EXPECTED condition for hours at a time. It is presented
 * calmly, permanently and unmistakably — never a modal, never a toast, never
 * a red banner, never the word "error". The fourth state — stuck — is the one
 * that is usually missing: connectivity is present but the ordered upload
 * queue is not draining (a poison message blocks everything behind it), so
 * past a threshold the client stops calling it "pending" and says, in plain
 * words, that it is not sending and since when.
 *
 * Stuck can ONLY be entered while connectivity is present: an offline queue
 * is normal, not stuck.
 *
 * CONNECTING is the honest name for the gap between "this tablet has a
 * network" and "the sync stream is up": the first seconds after the app
 * opens, the tablet waking from sleep, the stream re-handshaking for a fresh
 * token, or the API waking from its free-tier sleep (≈30 s, measured). The
 * stream's `connected` flag is false through all of it, and calling that
 * "Offline" told a cashier with full signal that they were offline. So: while
 * the browser reports a network and the stream has been down for less than
 * CONNECTING_GRACE_MS, it is "Connecting". Past the grace — or the moment the
 * browser reports no network at all — it is Offline, exactly as before.
 */

export type SyncUiState =
  | { readonly kind: 'online_synced' }
  | { readonly kind: 'offline'; readonly pendingCount: number }
  | { readonly kind: 'connecting'; readonly pendingCount: number }
  | {
      readonly kind: 'syncing';
      readonly pendingCount: number;
      readonly progress: SendProgress | null;
    }
  | {
      readonly kind: 'stuck';
      readonly pendingCount: number;
      readonly oldestQueuedAtMs: number;
    };

export interface SendProgress {
  readonly sentCount: number;
  readonly batchSize: number;
}

export interface SyncInputs {
  /** The sync stream is connected (the server is actually reachable). */
  readonly online: boolean;
  /** The browser reports a network (`navigator.onLine`). Absent = unknown, treated as none. */
  readonly network?: boolean;
  /** When the stream was last seen going down, or a reconnect attempt began. */
  readonly downSinceMs?: number | null;
  readonly pendingCount: number;
  readonly oldestQueuedAtMs: number | null;
  readonly nowMs: number;
  readonly progress: SendProgress | null;
}

/** Default threshold after which a non-draining queue with connectivity is called stuck. */
export const DEFAULT_STUCK_THRESHOLD_MS = 15 * 60_000;

/**
 * How long a tablet WITH a network may be reconnecting before it is called
 * offline. Covers a cold API (≈30 s on the free tier), PowerSync's 5 s retry,
 * and the handshake, with room to spare.
 */
export const CONNECTING_GRACE_MS = 90_000;

export function deriveSyncUiState(
  inputs: SyncInputs,
  stuckThresholdMs: number = DEFAULT_STUCK_THRESHOLD_MS,
): SyncUiState {
  if (!inputs.online) {
    const since = inputs.downSinceMs ?? null;
    if (inputs.network === true && since !== null && inputs.nowMs - since < CONNECTING_GRACE_MS) {
      return { kind: 'connecting', pendingCount: inputs.pendingCount };
    }
    return { kind: 'offline', pendingCount: inputs.pendingCount };
  }
  if (inputs.pendingCount === 0) {
    return { kind: 'online_synced' };
  }
  if (
    inputs.oldestQueuedAtMs !== null &&
    inputs.nowMs - inputs.oldestQueuedAtMs >= stuckThresholdMs
  ) {
    return {
      kind: 'stuck',
      pendingCount: inputs.pendingCount,
      oldestQueuedAtMs: inputs.oldestQueuedAtMs,
    };
  }
  return { kind: 'syncing', pendingCount: inputs.pendingCount, progress: inputs.progress };
}

export type SyncEvent =
  | { readonly type: 'connectivity'; readonly online: boolean; readonly atMs?: number }
  /** The browser's own network signal. Its return starts a fresh reconnect window. */
  | { readonly type: 'network'; readonly online: boolean; readonly atMs?: number }
  | {
      readonly type: 'queue';
      readonly pendingCount: number;
      readonly oldestQueuedAtMs: number | null;
    }
  | { readonly type: 'progress'; readonly progress: SendProgress | null }
  | { readonly type: 'tick'; readonly nowMs: number };

/** Event-driven wrapper: feed it observations, read the derived state. */
export class SyncStatusMachine {
  private inputs: SyncInputs;

  constructor(
    initial?: Partial<SyncInputs>,
    private readonly stuckThresholdMs: number = DEFAULT_STUCK_THRESHOLD_MS,
  ) {
    this.inputs = {
      online: false,
      network: false,
      pendingCount: 0,
      oldestQueuedAtMs: null,
      nowMs: 0,
      progress: null,
      ...initial,
    };
    // Starting up without the stream is the first reconnect attempt.
    if (!this.inputs.online && this.inputs.downSinceMs === undefined) {
      this.inputs = { ...this.inputs, downSinceMs: this.inputs.nowMs };
    }
  }

  apply(event: SyncEvent): SyncUiState {
    switch (event.type) {
      case 'connectivity': {
        const at = event.atMs ?? this.inputs.nowMs;
        const wasOnline = this.inputs.online;
        this.inputs = {
          ...this.inputs,
          online: event.online,
          nowMs: Math.max(this.inputs.nowMs, at),
          downSinceMs: event.online ? null : wasOnline ? at : (this.inputs.downSinceMs ?? at),
        };
        break;
      }
      case 'network': {
        const at = event.atMs ?? this.inputs.nowMs;
        const back = event.online && this.inputs.network !== true;
        this.inputs = {
          ...this.inputs,
          network: event.online,
          nowMs: Math.max(this.inputs.nowMs, at),
          // The network returning is a new reconnect attempt: a fresh window.
          downSinceMs: back && !this.inputs.online ? at : (this.inputs.downSinceMs ?? null),
        };
        break;
      }
      case 'queue':
        this.inputs = {
          ...this.inputs,
          pendingCount: event.pendingCount,
          oldestQueuedAtMs: event.oldestQueuedAtMs,
        };
        break;
      case 'progress':
        this.inputs = { ...this.inputs, progress: event.progress };
        break;
      case 'tick':
        this.inputs = { ...this.inputs, nowMs: event.nowMs };
        break;
    }
    return this.state;
  }

  get state(): SyncUiState {
    return deriveSyncUiState(this.inputs, this.stuckThresholdMs);
  }
}

export interface StatusLineOptions {
  /** True when no sync endpoint is configured (dev local-only mode). */
  readonly localOnly?: boolean;
  readonly formatClock?: (ms: number) => string;
}

function defaultClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * The queue holds every device write, not only sales — stock adjustments,
 * goods receipts, delivery updates, credit entries and sequence-block reports
 * all sit in the same outbox, and `readOutboxQueue` counts them all without
 * filtering by kind. This line used to call every one of them a "sale", so a
 * wedged stock adjustment read "1 sale waiting" and sent whoever escalated it
 * looking for a sale that did not exist. The noun has to cover what is
 * actually being counted.
 */
function plural(n: number): string {
  return n === 1 ? 'record' : 'records';
}

/**
 * The status bar's one line of calm product copy. Text + count; colour is
 * never the only channel, and none of these lines contains the word "error".
 */
export function statusLine(state: SyncUiState, options: StatusLineOptions = {}): string {
  if (options.localOnly === true) {
    // Honest wording for a device with no sync service configured: nothing is
    // being sent anywhere, and that is not an alarm.
    const n = state.kind === 'online_synced' ? 0 : state.pendingCount;
    return n === 0
      ? 'Local only · all saved on this device'
      : `Local only · ${n} ${plural(n)} saved on this device`;
  }
  switch (state.kind) {
    case 'online_synced':
      return 'Online · all saved';
    case 'offline':
      return state.pendingCount === 0
        ? 'Offline · nothing waiting'
        : `Offline · ${state.pendingCount} ${plural(state.pendingCount)} waiting`;
    case 'connecting':
      return state.pendingCount === 0
        ? 'Connecting · nothing waiting'
        : `Connecting · ${state.pendingCount} ${plural(state.pendingCount)} waiting`;
    case 'syncing':
      return state.progress !== null
        ? `Sending · ${state.progress.sentCount} of ${state.progress.batchSize}`
        : `Sending · ${state.pendingCount} waiting`;
    case 'stuck': {
      const clock = (options.formatClock ?? defaultClock)(state.oldestQueuedAtMs);
      return `Not sending · ${state.pendingCount} ${plural(state.pendingCount)} waiting since ${clock} — tell your manager`;
    }
  }
}
