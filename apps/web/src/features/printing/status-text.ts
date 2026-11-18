/**
 * What the screen says about a receipt, and — more important — what it does NOT
 * say. There is no back-channel from any printer path (§8.8): the app cannot
 * know that paper came out. So the words are "sent to the printer", "handed to
 * the print app", "print dialog closed" — the weaker thing each path actually
 * knows — and the word "printed" is never used as a claim about a receipt.
 * A test walks every state and fails if it appears.
 */
import type { QueueEntry } from '../../printing/queue';
import type { PrintAttempt } from '../../printing/transports/types';

export type StatusTone = 'ok' | 'wait' | 'attention' | 'plain';

export interface StatusText {
  readonly tone: StatusTone;
  readonly headline: string;
  readonly detail: string | null;
  /** Which action the status offers first. */
  readonly action: 'retry' | 'reprint' | 'settings' | 'none';
}

function clock(iso: string | null): string {
  if (iso === null) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function describePrint(
  entry: QueueEntry | null,
  printing: boolean,
  opts: { readonly autoPrint: boolean },
): StatusText {
  if (printing) {
    return { tone: 'wait', headline: 'Sending to the printer...', detail: null, action: 'none' };
  }
  if (entry === null) {
    return {
      tone: 'plain',
      headline: 'No printer copy on this device',
      detail: 'You can show the receipt on screen, or try a reprint.',
      action: 'reprint',
    };
  }
  const at = clock(entry.lastAttemptAt);
  if (entry.state === 'sent') {
    switch (entry.lastEvidence) {
      case 'handed-off':
        return {
          tone: 'ok',
          headline: `Handed to the print app at ${at}`,
          detail: 'Check the paper. This device cannot see whether it came out.',
          action: 'reprint',
        };
      case 'dialog-closed':
        return {
          tone: 'ok',
          headline: `Print dialog closed at ${at}`,
          detail: 'This device cannot tell whether a page was printed.',
          action: 'reprint',
        };
      case 'shown':
        return { tone: 'ok', headline: 'Receipt shown on screen', detail: null, action: 'reprint' };
      default:
        return {
          tone: 'ok',
          headline: `Sent to the printer at ${at}`,
          detail: 'Check the paper. This device cannot see whether it came out.',
          action: 'reprint',
        };
    }
  }
  // pending
  switch (entry.lastOutcome) {
    case null:
      return {
        tone: 'wait',
        headline: opts.autoPrint ? 'Waiting to send to the printer' : 'Not sent to a printer yet',
        detail: null,
        action: 'retry',
      };
    case 'timeout':
      return {
        tone: 'attention',
        headline: 'The printer did not answer',
        detail: 'The receipt may or may not have come out. Check the printer and the paper, then retry.',
        action: 'retry',
      };
    case 'needs-pairing':
      return {
        tone: 'attention',
        headline: 'No printer is chosen on this device',
        detail: entry.lastDetail,
        action: 'settings',
      };
    case 'unavailable':
      return {
        tone: 'attention',
        headline: 'This device cannot use the chosen printer route',
        detail: entry.lastDetail,
        action: 'settings',
      };
    default:
      return {
        tone: 'attention',
        headline: 'Could not reach the printer',
        detail: entry.lastDetail,
        action: 'retry',
      };
  }
}

/** The same weaker-claim sentences, for a single attempt (the test page). */
export function describeAttempt(a: PrintAttempt): { readonly tone: StatusTone; readonly text: string } {
  switch (a.outcome) {
    case 'sent':
      return {
        tone: 'ok',
        text:
          a.evidence === 'handed-off'
            ? 'Handed to the print app. Look at the paper to see whether it came out.'
            : a.evidence === 'dialog-closed'
              ? 'The print dialog was shown and closed. This device cannot tell whether a page was printed.'
              : 'Sent to the printer. Look at the paper to see whether it came out.',
      };
    case 'shown':
      return { tone: 'ok', text: 'Shown on screen. No printer is used on this route.' };
    case 'timeout':
      return { tone: 'attention', text: 'The printer did not answer in time. It may or may not have printed.' };
    case 'needs-pairing':
      return { tone: 'attention', text: a.detail ?? 'Choose a printer first.' };
    case 'unavailable':
      return { tone: 'attention', text: a.detail ?? 'This route is not available on this device.' };
    default:
      return { tone: 'attention', text: a.detail ?? 'Could not reach the printer.' };
  }
}
