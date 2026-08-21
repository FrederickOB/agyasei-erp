/**
 * The permanent connection-state indicator (§8.4): persistent chrome, calm,
 * text + icon + count — never a toast, never a modal, colour never the only
 * channel. Also hosts the update affordance (§8.11): a chip, applied only
 * through the version gate at a safe point.
 */
import type { ReactNode } from 'react';
import { statusLine, type SyncUiState } from '../../state/sync-status';

const ICONS: Record<SyncUiState['kind'], string> = {
  online_synced: '●',
  offline: '◌',
  syncing: '↑',
  stuck: '▲',
};

export function StatusBar({
  state,
  localOnly,
  updateReady,
  onApplyUpdate,
}: {
  readonly state: SyncUiState;
  readonly localOnly: boolean;
  readonly updateReady: boolean;
  readonly onApplyUpdate: () => void;
}): ReactNode {
  return (
    <header className={`status-bar status-${state.kind}`} role="status" aria-live="polite">
      <span className="status-icon" aria-hidden="true">
        {ICONS[state.kind]}
      </span>
      <span className="status-text">{statusLine(state, { localOnly })}</span>
      {updateReady ? (
        <button type="button" className="update-chip" onClick={onApplyUpdate}>
          Update ready · tap to apply
        </button>
      ) : null}
    </header>
  );
}
