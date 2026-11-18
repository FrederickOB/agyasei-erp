/**
 * `system-print` — the browser/OS print path (`window.print()`).
 *
 * Right for a LAPTOP with an OS-driver printer (USB, network, PDF), and for the
 * A4 invoice a back office wants. Wrong for a counter queue on an Android
 * tablet: it opens the print framework's dialog, which is a modal a customer is
 * waiting behind (§8.8: "A4 invoices only; too slow for a queue").
 *
 * The receipt is rendered into a hidden iframe so the app's own page is never
 * printed, and `window.print()` runs inside it. `print()` is synchronous and on
 * desktop Chrome blocks until the dialog closes, so the transport settles as
 * soon as the call returns, with `evidence: 'dialog-closed'` — we know the
 * dialog was shown and dismissed, NOT that anything was printed. Nothing about a
 * cancelled dialog is distinguishable from a printed page.
 *
 * Layout: a 58/80 mm roll receipt or an A4 invoice, from device settings.
 */
import { renderReceiptHtml, type PrintLayout } from '../html';
import {
  guardedPrint,
  settleAs,
  DEFAULT_PRINT_TIMEOUT_MS,
  type PrintAttempt,
  type PrintJob,
  type ReceiptTransport,
  type TransportDeps,
  type TransportHealth,
} from './types';

export interface SystemPrintEnv {
  readonly available: () => boolean;
  /** Render and print this HTML. Resolves when the print call has returned. */
  readonly printHtml: (html: string) => Promise<void>;
}

export function defaultSystemPrintEnv(): SystemPrintEnv {
  return {
    available: () => typeof window !== 'undefined' && typeof window.print === 'function' && typeof document !== 'undefined',
    printHtml: (html) =>
      new Promise<void>((resolve, reject) => {
        const frame = document.createElement('iframe');
        frame.setAttribute('aria-hidden', 'true');
        frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
        const cleanup = (): void => {
          setTimeout(() => frame.remove(), 1000);
        };
        frame.onload = () => {
          try {
            const w = frame.contentWindow;
            if (w === null) throw new Error('The print frame has no window.');
            w.focus();
            w.print();
            cleanup();
            resolve();
          } catch (err) {
            cleanup();
            reject(err instanceof Error ? err : new Error('Printing failed.'));
          }
        };
        document.body.appendChild(frame);
        frame.srcdoc = html;
      }),
  };
}

export function createSystemPrintTransport(
  deps: TransportDeps,
  env: SystemPrintEnv = defaultSystemPrintEnv(),
): ReceiptTransport {
  return {
    id: 'system-print',
    label: 'Browser print (A4 or roll)',
    raw: false,

    probe(): Promise<TransportHealth> {
      return Promise.resolve(
        env.available()
          ? { state: 'unknown', detail: 'Uses the device print dialog. Best for a laptop; slow for a queue.' }
          : { state: 'unsupported', detail: 'This browser cannot open a print dialog.' },
      );
    },

    print(job: PrintJob, timeoutMs: number = DEFAULT_PRINT_TIMEOUT_MS): Promise<PrintAttempt> {
      return guardedPrint('system-print', timeoutMs, job.bytes.length, deps, async () => {
        if (!env.available()) settleAs('unavailable', 'This browser cannot open a print dialog.');
        const tuning = deps.tuning();
        const layout: PrintLayout = tuning.systemLayout === 'a4' ? 'a4' : tuning.paperWidthMm === 80 ? '80' : '58';
        await env.printHtml(renderReceiptHtml(job.doc, layout, job.isCopy));
        return { evidence: 'dialog-closed' as const, detail: 'Print dialog was shown and closed.' };
      });
    },
  };
}
