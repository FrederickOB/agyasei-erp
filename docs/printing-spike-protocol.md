# Printing spike protocol

Status: ready to run. Written 18 November 2026 for go-live on 1 January 2027.
Design reference: `docs/architecture/sections/08-client-architecture.md` §8.8.
Decision reference: `ADR-0003` (PWA client; printing is its weakest point).

Nothing in the app was proven against real hardware when this was written. The code
is tested against mocked Web Bluetooth, WebUSB, Web Serial, an intent hand-off and a
print dialog; none of that says a real printer prints. **This document is how the
founder proves it, on the printers they are about to buy, before buying them in
quantity.** Run it before the purchase order, not at the pilot.

## 1. What is being decided

The printer hardware is not chosen. Three families are on the table, and each reaches
the PWA by a different route. The app has one interface (`ReceiptTransport`) and six
routes; the spike decides which route each outlet type uses.

| Hardware at the counter | Route to choose in Printer settings | Notes |
|---|---|---|
| Bluetooth **LE** thermal printer beside an Android tablet | **Bluetooth printer (BLE)** `ble-escpos` | Web Bluetooth reaches BLE GATT printers only. |
| Bluetooth **Classic / SPP** thermal printer beside an Android tablet (most cheap 58 mm units) | **Print app on this Android device** `android-print-bridge` | Web Bluetooth cannot reach SPP at all, on any platform. Needs a print-service app installed (see section 6). |
| Android POS terminal with a **built-in printer** (Sunmi-style "inner printer") | **Print app on this Android device** `android-print-bridge` | The inner printer is normally a serial/SPP device; not reachable by Web Bluetooth. |
| USB printer on a **laptop** (Windows, macOS, ChromeOS) | **Browser print** `system-print` (A4 invoice or roll), or **Serial / Bluetooth-classic** `web-serial` for a raw thermal printer | Web Serial sees a Bluetooth-classic printer paired in the OS as a COM/serial port. |
| USB printer on a tablet with a free OTG port | **USB printer (WebUSB)** `webusb-escpos` | Rarely practical: a charging cheap tablet seldom has a free port. |
| Nothing works / no printer | **No printer** `none` | Receipt shown full screen with a large number. Always available. |

Every outlet always has `none` as the fallback. A dead printer never stops a sale or
a customer leaving with proof of it.

## 2. Equipment

Minimum matrix (from §8.8, widened by the founder's device decision):

- **Two representative tablets**: about 2 GB RAM, Android 11 to 13, current Chrome,
  installed as the PWA. Prefer the actual model the outlets will use.
- **One laptop** (Chrome or Edge) for the HQ/back-office case.
- **At least three printer models actually purchasable in Ghana**, including:
  - at least one known **BLE GATT** model,
  - at least one commodity **SPP / Bluetooth-classic** model,
  - **one Android POS terminal with an integrated printer**.
- A cash drawer on the RJ11 port of one printer, if drawers will be used.
- Both 58 mm and 80 mm paper if both are in play.

Record the exact model, firmware, Android version and Chrome version for every cell.

## 3. Setup per device/printer pair

1. Open the PWA on the device. Go to **Printer** in the main navigation.
2. Choose the route from section 1. The screen lists every route and says why an
   unavailable one is unavailable: write that sentence down for each device. It is
   evidence (for example "This browser has no Web Bluetooth").
3. For BLE, USB and Serial routes, tap **Choose printer** and pick the printer.
   Restart the app (close it fully, reopen). Tap **Check connection**. The printer
   must still be chosen with **no chooser dialog** — that is the persistent-permission
   criterion. If the screen says the browser does not remember printers, record it.
4. Set the paper width (58 or 80 mm). Print the **test page**. Confirm by eye:
   - all 12 lines are readable and not wrapped mid-word at the paper edge,
   - the text is not garbled (a garbled page means the character set is wrong: try
     "Plain ASCII only" under Advanced and note which setting the model needs),
   - the last line of the test page deliberately tries to print the pack's currency
     sign beside its code. On a printer whose character set lacks the sign it prints
     as `?` there: that is expected and is the diagnostic. What matters is the money
     lines above it: they must show the sign (if the printer has it) or the currency
     code, never a `?`. Note which one each model gives.
5. If the printer has a cutter, confirm it cuts after the page. If it has a drawer,
   tick the drawer option and confirm the drawer opens on a new receipt and does
   **not** open on a reprint.
6. For `android-print-bridge`: install and configure the print app first (section 6),
   choose the printer inside the app, then print the test page. The PWA cannot see
   whether the app is installed; the test page is the only way to know.

## 4. The run (200 receipts, with interruptions)

Use **Printer, Hardware test (spike)**. It sends synthetic 12-line receipts through the
chosen route and records every attempt. It does not record sales, touch the outbox or
queue anything.

For each device/printer pair:

1. Set **Receipts: 200**, **Pause between: 1500 ms**. Tap **Start run**.
2. **Baseline.** Let about 50 receipts print untouched.
3. **Power cycle.** Tap **Printer power-cycled** and, at the same moment, switch the
   printer off, wait 5 seconds, switch it on. Do nothing else. The first successful
   receipt afterwards reports the **recovery time** under "Recovery after a mark".
   There must be no human step (no re-choosing the printer, no restart).
4. **Screen lock.** Tap **Screen locked**, lock the tablet, wait 30 seconds, unlock.
   Note whether receipts resume by themselves.
5. **Background.** Tap **App backgrounded**, switch to another app for 30 seconds,
   return. Note whether receipts resume by themselves. "While backgrounded" counts
   attempts made with the page hidden.
6. Let the run finish (or **Stop run**). Tap into **Results (CSV)** and **Copy
   results**; paste into the sheet for that pair.
7. **Chrome update.** After a Chrome update on the device, repeat steps 1 to 6.
8. Repeat the whole thing with the printer **out of paper** for 10 receipts. This
   device cannot detect it (there is no back-channel); confirm the screen still says
   only "Sent to the printer" and never "printed". That wording is the correct
   behaviour, not a defect.

Also, once per pair, **ring a real sale** (counter, cash) with the route selected,
confirm the receipt screen says "Sent to the printer at HH:MM" (or the route's
equivalent), switch the printer off, ring a second sale, and confirm: the sale
completes immediately, the receipt screen says it could not reach the printer and
offers **Retry print** and **Show receipt**, and the receipt prints by itself after
the printer is switched back on. Then confirm **Reprint** produces a copy marked
"COPY - REPRINT" with the original tax lines.

## 5. Pass criteria (from §8.8)

A device/printer/route cell passes when, over the 200 receipts:

| Criterion | Target | Where to read it |
|---|---|---|
| First-try success, with no device-chooser dialog | at least 99.5 % | "First-try success" |
| Median time per 12-line 58 mm receipt | under 3 s | "Median" |
| 95th percentile time | under 5 s | "95th percentile" |
| Automatic reconnect after a printer power cycle | under 5 s, no human step | "Recovery after a mark" |
| Hangs (an attempt that did not settle within the timeout) | exactly 0 | "Hangs (must be 0)" |
| Print outcome altering, delaying or duplicating a sale record | exactly 0 | the real-sale test in section 4 |

Notes on reading the numbers:

- "Sent" means the bytes were accepted by the link (or handed to the print app, or the
  print dialog closed). It is the strongest claim any of these routes can make. The
  paper is the only proof; keep a person watching the printer for a sample of each run
  and count paper receipts against "Sent".
- `android-print-bridge` times are time to hand off, not time to print. Time a
  stopwatch on a sample of 10 from tap to paper and record that too.
- A hang is a bug in the app, not a hardware finding: report it immediately with the
  CSV, whatever the hardware did.

## 6. The print-app dependency (`android-print-bridge`)

This route hands the receipt's raw bytes to an installed Android print-service app via
an `intent:` URL, the same mechanism web POS products use to reach Bluetooth-classic
and built-in printers. It is the concession §8.8 calls `companion-bridge`, taken with
an existing app instead of our own APK. Read the risks before choosing it for an outlet:

- **Third-party app on every device.** It must be installed, kept installed, set up
  with the right printer and paper width, and allowed to run in the background. Its
  updates, licence terms and Play Store availability are not ours. The default package
  name is `ru.a402d.rawbtprinter` (RawBT) and is editable per device under Printer
  settings, Print app package.
- **The URL scheme is the app's, not ours.** If the app changes it, printing breaks
  until we ship a client change. Verify the exact intent form against the installed
  app version in the spike and record the version.
- **No install detection, no result.** The PWA cannot tell whether the app is
  installed or whether it printed. The screen says "Handed to the print app", the
  weakest wording of any route.
- **No mixed-content or Private Network Access problem.** An intent navigation makes no
  network request, which is why this beats a loopback `127.0.0.1` shim on Chrome for
  Android. Record this as a finding if it holds on your Chrome builds.
- **Android only.** On any other platform the route reports unavailable.
- The built-in printer of a POS terminal is usually exposed to such an app as a printer
  option inside the app. Confirm that on the actual terminal; it is a spike cell.

## 7. What can only be proven on real hardware

Everything below is **unproven** until this protocol is run. The automated tests cannot
say any of it, and none of it is claimed:

- the GATT service/characteristic UUIDs in `printing/transports/ble.ts` match the
  printers actually bought (the list is a starting point; "no writable characteristic"
  on a connected printer is a finding to record, with the model),
- Web Bluetooth `getDevices()` persistent permission exists and survives an app
  restart on the target Chrome builds,
- the working MTU/chunk size and inter-chunk pause per model (Advanced settings),
- WebUSB claims the interface (on Windows the OS driver usually has it already),
- Web Serial sees the paired printer as a port on the laptop OS in use,
- the `intent:` URL form is accepted by the installed print app version,
- ESC/POS compatibility per model: code page, bold, double size, partial cut, the QR
  command (a printer without GS ( k support prints nothing or garbage for the QR),
  and the cash-drawer pulse,
- recovery after power cycle, screen lock and backgrounding (Android drops BLE GATT
  connections; whether the app recovers without a human is exactly what is being
  measured),
- print speed against the criteria above.

## 8. Triggers that reopen the native-Android question (`ADR-0003`)

Any one of these, raised the day it is observed, not at the pilot:

1. **The printers procurable in the market are SPP-only** and the outlet cannot or will
   not rely on a third-party print app, so neither Web Bluetooth nor an acceptable
   bridge reaches them.
2. **The print-app route fails its criteria or its risk is unacceptable**: first-try
   success below 99 %, the app cannot be kept installed and configured across the
   outlets, or its intent scheme changes under us.
3. **Persistent device permission is unavailable** on the target Chrome builds, forcing
   a chooser dialog per receipt (BLE/USB/Serial paths).
4. **First-try success below 99 %**, or reconnect after a power cycle needing a human.
5. **Backgrounding or screen lock reliably kills the connection** with no recovery
   inside the PWA.
6. **Any hang**, or any case where a print outcome altered, delayed or duplicated a
   sale record. (These are app defects first; a native shell only if they cannot be
   fixed in the PWA.)
7. The Android POS terminal's built-in printer cannot be reached by any route above.

Taking the print-app route is itself a partial concession (a third-party app on every
device). If more than a handful of outlets end up depending on it, say so and decide
deliberately between that and a native shell of our own, rather than accumulating the
dependency by degrees.

## 9. Where the results go

One row per device/printer/route cell in the spike matrix: model, firmware, Android and
Chrome versions, route, paper width, the six numbers from section 5, the printer's
GATT service UUID if BLE, the setting changes needed (character set, chunk size), and a
pass/fail. Keep the copied CSVs. Raise any trigger from section 8 with the CSV attached.

## 10. How the implementation differs from the §8.8 sketch

Recorded so the next reader is not surprised:

- The transport set is `ble-escpos`, `webusb-escpos`, `web-serial`,
  `android-print-bridge`, `system-print`, `none`. `android-print-bridge` takes the
  place of the sketch's `companion-bridge`; `web-serial` is new (the laptop case).
- `print()` takes a `PrintJob` (the document plus its pre-rendered bytes) rather than
  the bare `ReceiptDocument`, so raw transports send exactly what the queue cached and
  document transports (`system-print`, `none`) render from the document. Both still
  never reject and never hang (default 12 s, enforced in one place: `guardedPrint`).
- **The receipt snapshot is stored.** §8.8 says the document "is not stored a second
  time". For a sale rung offline that cannot hold: the server has not priced it, so
  there are no `sale_line` or `sale_tax_line` rows on the device yet, and the cart
  that held the product names is deleted at checkout. The document is therefore built
  after commit from the committed outbox row plus the priced cart, and kept (with the
  rendered bytes of an outstanding print) in the local-only `local_print_queue` for 7
  days. Once the server's rows have synced, a reprint after expiry rebuilds from them,
  using the sale's own `currency_code`, `money_scale` and tax rows, never today's.
  `local_print_queue` is droppable: losing it loses a retry and a convenience reprint,
  never a sale.
- Tenant branding (business name, header and footer lines, label overrides) and the
  jurisdiction pack's statutory receipt fields and QR payload are read from device
  `local_config` records (`receipt_branding`, `receipt_pack_slot`). **Nothing syncs
  those records to a device yet.** Until something does, a receipt has no header and
  an unconfigured statutory slot. This is deliberate: what the revenue authority
  requires on a Ghana receipt (open question Q8) is not settled, and no field is
  invented here. The slot, including a QR code, is wired through the encoder and the
  views and prints when the pack supplies it.
