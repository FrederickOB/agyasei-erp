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
 * What a waiting answer LOOKS like, so the skeleton has the shape of what is
 * coming and the page does not jump when it lands:
 *
 *   rows     — generic full-width rows (the old default)
 *   figures  — a few labelled headline figures (a balance, a KPI)
 *   table    — a header and columns of cells
 *   cards    — a list of record cards: a name, a line under it, a figure
 *   chart    — a row of bars over an axis
 *   tiles    — a grid of dashboard cards
 */
export type PendingShape = 'rows' | 'figures' | 'table' | 'cards' | 'chart' | 'tiles';

/** Deterministic widths: a skeleton that changes on every render flickers. */
const WIDTHS = ['72%', '54%', '64%', '46%', '58%', '68%', '50%', '62%'] as const;
const widthAt = (i: number): string => WIDTHS[i % WIDTHS.length] ?? '60%';
const BARS = [46, 70, 38, 82, 60, 92, 54, 76, 44, 66, 88, 58];

function Bone({ w, h, className }: { readonly w?: string; readonly h?: number; readonly className?: string }): ReactNode {
  return (
    <span
      className={`skeleton skeleton-bone${className === undefined ? '' : ` ${className}`}`}
      style={{ width: w, height: h === undefined ? undefined : `${String(h)}px` }}
    />
  );
}

function Shape({ shape, rows }: { readonly shape: PendingShape; readonly rows: number }): ReactNode {
  const n = Array.from({ length: rows }, (_, i) => i);
  switch (shape) {
    case 'figures':
      return (
        <div className="pending-figures">
          {n.map((i) => (
            <div key={i} className="pending-figure">
              <Bone w="48%" h={12} />
              <Bone w={widthAt(i)} h={28} />
              <Bone w="36%" h={10} />
            </div>
          ))}
        </div>
      );
    case 'table':
      return (
        <div className="pending-table">
          <div className="pending-table-row pending-table-head">
            <Bone w="30%" h={10} />
            <Bone w="14%" h={10} />
            <Bone w="14%" h={10} />
            <Bone w="14%" h={10} />
          </div>
          {n.map((i) => (
            <div key={i} className="pending-table-row">
              <Bone w={widthAt(i)} h={14} />
              <Bone w="60%" h={14} />
              <Bone w="70%" h={14} />
              <Bone w="54%" h={14} />
            </div>
          ))}
        </div>
      );
    case 'cards':
      return (
        <ul className="pending-cards">
          {n.map((i) => (
            <li key={i} className="pending-card">
              <span className="pending-card-text">
                <Bone w={widthAt(i)} h={16} />
                <Bone w="38%" h={11} />
              </span>
              <Bone w="88px" h={20} />
            </li>
          ))}
        </ul>
      );
    case 'chart':
      return (
        <div className="pending-chart">
          <Bone w="40%" h={22} />
          <div className="pending-bars">
            {BARS.map((h, i) => (
              <span key={i} className="skeleton pending-bar" style={{ height: `${String(h)}%` }} />
            ))}
          </div>
        </div>
      );
    case 'tiles':
      return (
        <div className="pending-tiles">
          {n.map((i) => (
            <div key={i} className="pending-tile">
              <Bone w="44%" h={14} />
              <Bone w={widthAt(i + 2)} h={30} />
              <Bone w="80%" h={10} />
              <Bone w="62%" h={10} />
            </div>
          ))}
        </div>
      );
    case 'rows':
      return (
        <ul className="server-pending-rows">
          {n.map((i) => (
            <li key={i} className="skeleton skeleton-row" />
          ))}
        </ul>
      );
  }
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
  shape = 'rows',
  what,
}: {
  readonly rows?: number;
  readonly slow?: boolean;
  readonly shape?: PendingShape;
  readonly what: string;
}): ReactNode {
  return (
    <div className="server-pending" data-shape={shape}>
      {slow ? (
        <p className="server-pending-note" role="status">
          <Icon name="sync" size={18} />
          Still asking the server for {what.toLowerCase()}. A server that has been idle can take up to a minute to answer.
        </p>
      ) : null}
      <div aria-hidden="true">
        <Shape shape={shape} rows={rows} />
      </div>
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
