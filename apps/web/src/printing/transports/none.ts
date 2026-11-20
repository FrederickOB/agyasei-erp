/**
 * `none` — the mandatory fallback (§8.8). Every tenant, every device.
 *
 * It sends nothing anywhere. The receipt is shown full-screen with a large
 * receipt number, so a printer that is dead, unpaired or out of paper never
 * stops a customer leaving with proof of the sale: the cashier can read the
 * number aloud, write it down, or let the customer photograph the screen. The
 * UI shows the sheet whenever this transport is active (and on demand for any
 * transport); the transport itself only reports 'shown'.
 */
import {
  guardedPrint,
  type PrintAttempt,
  type PrintJob,
  type ReceiptTransport,
  type TransportDeps,
  type TransportHealth,
} from './types';

export function createNoneTransport(deps: TransportDeps): ReceiptTransport {
  return {
    id: 'none',
    label: 'No printer - show the receipt on screen',
    raw: false,
    probe(): Promise<TransportHealth> {
      return Promise.resolve({ state: 'ready', detail: 'Always available.' });
    },
    print(job: PrintJob, timeoutMs?: number): Promise<PrintAttempt> {
      return guardedPrint('none', timeoutMs ?? 1000, job.bytes.length, deps, () =>
        Promise.resolve({ outcome: 'shown' as const, evidence: 'shown' as const, detail: 'Receipt shown on screen.' }),
      );
    },
  };
}
