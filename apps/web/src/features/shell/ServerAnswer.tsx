/**
 * How a screen says "I asked the server and did not get an answer".
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RULE THIS COMPONENT EXISTS TO ENFORCE
 * ═══════════════════════════════════════════════════════════════════════════
 * A screen backed by a server read has exactly three renderings: it is
 * waiting, it has an answer, or it has a REASON. There is no fourth state in
 * which it shows an old answer, an empty list, or a zero. Those all read as
 * information at a glance, and every one of them is a lie about a figure
 * somebody is standing at a counter deciding on.
 *
 * That is why this is a component and not a toast. §8.4 is explicit that
 * offline is a calm, permanent, unmistakable STATE — never a modal, never a
 * red banner, never the word "error" — and the same applies here. The words
 * below are deliberately flat: being offline is the expected condition for
 * hours at a time, and the person reading this has done nothing wrong.
 */
import type { ReactNode } from 'react';
import type { ApiFailure, ApiFailureKind } from '../../data/api/client';
import { headlineFor } from '../../data/api/client';
import { Icon, type IconName } from '../../ui/Icon';

/** Nothing on this list is a fault of the device or of the person holding it. */
const CALM: ReadonlySet<ApiFailureKind> = new Set<ApiFailureKind>([
  'offline',
  'timeout',
  'not-configured',
  'forbidden',
]);

function iconFor(kind: ApiFailureKind): IconName {
  switch (kind) {
    case 'offline':
    case 'not-configured':
      return 'cloud-off';
    case 'timeout':
      return 'clock';
    default:
      return 'alert';
  }
}

/**
 * The second sentence — what this specific "no" means for the thing that is
 * missing. `what` is the screen's own words for what it was going to show,
 * e.g. "Sales by location", so the sentence reads as an answer to the
 * question the person actually asked.
 */
function bodyFor(kind: ApiFailureKind, what: string): string {
  switch (kind) {
    case 'offline':
      return (
        `${what} is held on the server, so this device cannot work it out on its own. ` +
        'Nothing is shown here on purpose: an old figure or an empty list would both read ' +
        'as an answer. It will be here when the connection is.'
      );
    case 'not-configured':
      return (
        `${what} is produced on the server, and this device is set up to run on its own. ` +
        'Selling, and everything else the counter does, is unaffected.'
      );
    case 'timeout':
      return (
        `The connection reached the server but ${what.toLowerCase()} did not come back. ` +
        'Try again; if it keeps happening, tell your manager.'
      );
    case 'unauthenticated':
      return `This device's sign-in is no longer valid, so it cannot ask for ${what.toLowerCase()}.`;
    case 'forbidden':
      return (
        `${what} is not part of what this sign-in is allowed to see. ` +
        'That is a setting somebody at head office controls, not a fault here.'
      );
    case 'refused':
    case 'server-error':
      return `The server did not produce ${what.toLowerCase()}. Nothing has been changed.`;
    case 'invalid-request':
      return (
        `This device did not send the request, because it would not have been accepted. ` +
        'Nothing has been changed. Report the detail below.'
      );
    case 'malformed':
      return (
        `The server answered, but this device could not read the answer, so it is showing ` +
        'nothing rather than part of one. This device may need updating.'
      );
  }
}

export function ServerUnavailable({
  what,
  failure,
  onRetry,
}: {
  /** What the screen was going to show, in its own words. */
  readonly what: string;
  readonly failure: ApiFailure;
  readonly onRetry?: (() => void) | undefined;
}): ReactNode {
  const calm = CALM.has(failure.kind);
  return (
    <section
      className={`server-answer ${calm ? 'server-answer-calm' : 'server-answer-attn'}`}
      role="status"
    >
      <Icon name={iconFor(failure.kind)} size={28} />
      <div className="server-answer-body">
        <h3 className="server-answer-title">{headlineFor(failure.kind)}</h3>
        <p className="server-answer-text">{bodyFor(failure.kind, what)}</p>
        {failure.detail !== null ? (
          <p className="server-answer-detail">
            <span className="server-answer-detail-label">If you call someone, tell them:</span>{' '}
            <span className="tabular">{failure.detail}</span>
          </p>
        ) : null}
        {onRetry !== undefined ? (
          <button type="button" className="secondary-action pressable" onClick={onRetry}>
            Try again
          </button>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Waiting on the server. Skeletons rather than a blank panel — a blank panel
 * where figures belong reads as "nothing sold", which is the one answer this
 * screen must never give by accident (the same rule the sales list follows).
 *
 * Past a couple of seconds it stops implying this is instant and says it is
 * still trying, because a person who has stopped believing a screen starts
 * tapping things.
 */
export function ServerPending({
  rows = 3,
  slow = false,
  what,
}: {
  readonly rows?: number;
  readonly slow?: boolean;
  readonly what: string;
}): ReactNode {
  return (
    <div className="server-pending">
      {slow ? (
        <p className="server-pending-note" role="status">
          <Icon name="sync" size={18} />
          Still asking the server for {what.toLowerCase()}. This connection is slow.
        </p>
      ) : null}
      <ul className="server-pending-rows" aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <li key={i} className="skeleton skeleton-row" />
        ))}
      </ul>
    </div>
  );
}

/**
 * When this answer was taken.
 *
 * Even a successful read is a SNAPSHOT of a server that other locations are
 * still writing to, and the gap between "now" and "when I asked" is exactly
 * where a confident wrong number lives. Every server-backed panel carries one
 * of these.
 */
export function FetchedAt({ atMs }: { readonly atMs: number }): ReactNode {
  const d = new Date(atMs);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return (
    <span className="fetched-at">
      <Icon name="clock" size={16} />
      As at <span className="tabular">{hhmm}</span>
    </span>
  );
}
