/**
 * The permanent connection-state indicator (§8.4): persistent chrome, calm,
 * icon + text + count — never a toast, never a modal, colour never the only
 * channel. Also hosts the update affordance (§8.11): a chip, applied only
 * through the version gate at a safe point.
 *
 * The four states are told apart by SHAPE first (a live ring, a struck-out
 * cloud, a cycle, a warning triangle), then by colour, then by words. The
 * glyphs this replaced — a filled dot and a triangle from whatever font the
 * tablet happened to have — were indistinguishable at arm's length in
 * daylight, which is the only lighting this bar is ever read in.
 *
 * `syncing` also gets an indeterminate line: the one looping animation in the
 * whole interface, because it is reporting work genuinely in flight, and
 * without it "sending" and "stuck" look identical while the queue drains.
 */
import type { ReactNode } from 'react';
import { Icon, type IconName } from '../../ui/Icon';
import { statusLine, type SyncUiState } from '../../state/sync-status';

const ICONS: Record<SyncUiState['kind'], IconName> = {
  online_synced: 'live',
  offline: 'cloud-off',
  syncing: 'sync',
  stuck: 'alert',
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
    <div className={`status-bar status-${state.kind}`} role="status" aria-live="polite">
      <span className="status-dot">
        <Icon name={ICONS[state.kind]} size={20} />
      </span>
      <span className="status-text">{statusLine(state, { localOnly })}</span>
      {updateReady ? (
        <button type="button" className="update-chip pressable" onClick={onApplyUpdate}>
          <Icon name="download" size={18} />
          Update ready · tap to apply
        </button>
      ) : null}
      {state.kind === 'syncing' ? <span className="status-progress" aria-hidden="true" /> : null}
    </div>
  );
}
