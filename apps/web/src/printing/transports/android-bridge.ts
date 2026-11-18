/**
 * `android-print-bridge` — hand the ESC/POS bytes to an installed Android
 * print-service app through an `intent:` URL.
 *
 * WHY THIS EXISTS. It is the only route from a PWA to a Bluetooth Classic (SPP)
 * printer, or to the "inner printer" of an Android POS terminal (Sunmi-style),
 * from a tablet: neither is reachable by Web Bluetooth (§8.8 point 1). Web POS
 * products in the wild use exactly this mechanism with a free third-party app
 * (RawBT is the well-known one): the page navigates to a URL like
 *
 *     intent:base64,<payload>#Intent;scheme=rawbt;package=<app>;end;
 *
 * Chrome resolves it, launches the app, and the app writes the bytes to
 * whichever printer the operator selected inside it.
 *
 * THIS IS §8.8's `companion-bridge` CONCESSION, taken with an existing app
 * instead of our own APK. That choice has costs that must be read, not skipped:
 *
 *  - IT IS A THIRD-PARTY DEPENDENCY on 25 outlets' devices. The app must be
 *    installed, configured (printer chosen, paper width) and kept running by
 *    someone. Its release cycle, licence and Play Store listing are not ours.
 *  - THE URL SCHEME IS THEIRS. If the app changes it, printing breaks until we
 *    ship a client update. The package name is therefore device configuration,
 *    not a constant, and the exact URL form is a spike-matrix cell to verify on
 *    the real app version.
 *  - NO BACK-CHANNEL AND NO INSTALL DETECTION. A web page cannot tell whether
 *    the app is installed, nor whether it printed. 'sent' here means only
 *    "the OS was asked to open the app" — `evidence: 'handed-off'`, the weakest
 *    claim of any transport, and the UI words it that way.
 *  - NO MIXED-CONTENT OR PNA PROBLEM. Unlike a loopback HTTP shim, an intent
 *    navigation involves no network request at all; that is why this beats our
 *    own `127.0.0.1` shim on Chrome for Android (§8.8 point 5).
 *  - Android only. On other platforms the transport reports 'unavailable'.
 */
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
import { toBase64 } from '../escpos';

export const DEFAULT_BRIDGE_PACKAGE = 'ru.a402d.rawbtprinter';
/** An intent URL carries the whole receipt; refuse anything unreasonable rather than truncate. */
export const BRIDGE_MAX_URL_CHARS = 400_000;

export interface BridgeEnv {
  readonly userAgent: () => string;
  /** Perform the navigation. Injected so tests can capture the URL. */
  readonly open: (url: string) => void;
}

export function defaultBridgeEnv(): BridgeEnv {
  return {
    userAgent: () => (typeof navigator === 'undefined' ? '' : navigator.userAgent),
    open: (url) => {
      const a = document.createElement('a');
      a.href = url;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
    },
  };
}

export function buildBridgeUrl(bytes: Uint8Array, packageName: string): string {
  return `intent:base64,${toBase64(bytes)}#Intent;scheme=rawbt;package=${packageName};end;`;
}

export function createAndroidBridgeTransport(
  deps: TransportDeps,
  env: BridgeEnv = defaultBridgeEnv(),
): ReceiptTransport {
  const isAndroid = (): boolean => /Android/i.test(env.userAgent());
  return {
    id: 'android-print-bridge',
    label: 'Print app on this Android device',
    raw: true,

    probe(): Promise<TransportHealth> {
      return Promise.resolve(
        isAndroid()
          ? {
              state: 'unknown',
              detail:
                'Cannot detect whether the print app is installed. Print the test page to find out.',
            }
          : { state: 'unsupported', detail: 'This route only exists on Android devices.' },
      );
    },

    print(job: PrintJob, timeoutMs: number = DEFAULT_PRINT_TIMEOUT_MS): Promise<PrintAttempt> {
      return guardedPrint('android-print-bridge', timeoutMs, job.bytes.length, deps, () => {
        if (!isAndroid()) settleAs('unavailable', 'The print-app route only works on Android.');
        const url = buildBridgeUrl(job.bytes, deps.tuning().bridgePackage || DEFAULT_BRIDGE_PACKAGE);
        if (url.length > BRIDGE_MAX_URL_CHARS) settleAs('failed', 'This receipt is too large to hand to the print app.');
        env.open(url);
        return Promise.resolve({
          evidence: 'handed-off' as const,
          detail: 'Handed to the print app. Check the paper.',
        });
      });
    },
  };
}
