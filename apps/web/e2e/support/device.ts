/**
 * A device in a testable state, without the live stack — and how honest that is.
 *
 *   1. The build is `dist-e2e/` (e2e/build.mjs): the production code on the
 *      DEV-BEARER path, with a fixture bearer whose `locs` claim names one
 *      location. No auth gate is bypassed; that path is the one the drills use.
 *   2. The API is Playwright routes on a reserved `.invalid` origin
 *      (api-mock.ts), answering with fixtures shaped to the client's own
 *      mappers. Uploads fail at the network layer unless a test says otherwise.
 *   3. PowerSync is pointed at a closed local port and is GENUINELY
 *      unreachable. That is the offline case, not a stub of it.
 *   4. What PowerSync would have downloaded is applied by the e2e-only seam
 *      (src/e2e/download-seam.ts) as rows in PowerSync's own backing tables —
 *      synced tables only, never local ones — before the app's gates run. The
 *      gates then provision the device from those rows exactly as they would
 *      from a download: location from the token, price list, currency.
 *
 * Everything local — the till, the cart, the outbox, receipt numbers, the
 * print queue — is produced by the real UI in the test.
 */
import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { ApiMock } from './api-mock';
import { defaultProcedures } from './api-fixtures';
import { downloadFixture } from './download';

export class Device {
  constructor(
    readonly page: Page,
    readonly api: ApiMock,
  ) {}

  /** The persistent connection status (§8.4), wherever the visible room puts it. */
  get status(): Locator {
    return this.page.locator('.status-bar:visible').first();
  }

  /** Load the app and wait until the shell is up and the seam has applied. */
  async open(): Promise<void> {
    await this.page.goto('/');
    await this.waitForShell();
  }

  /** Airplane mode: the browser's network AND the fixture API (see ApiMock.offline). */
  async setOffline(offline: boolean): Promise<void> {
    this.api.offline = offline;
    await this.page.context().setOffline(offline);
  }

  async waitForShell(): Promise<void> {
    // Cold wasm SQLite + the PowerSync worker in a fresh context. Generous,
    // because a loaded CI runner (or dev machine) is not a measurement.
    await expect(this.status).toBeVisible({ timeout: 90_000 });
    const seam = await this.page.evaluate(
      () => (window as unknown as { __erp_e2e_seam__?: { applied: Record<string, number> } }).__erp_e2e_seam__,
    );
    expect(seam, 'the e2e download seam ran').toBeTruthy();
  }

  /** The counter room's own chrome; null-safe for the office. */
  get counterRoom(): Locator {
    return this.page.locator('.app-shell');
  }

  async goToCounter(): Promise<void> {
    const back = this.page.getByRole('button', { name: /^Open counter/ });
    if (await back.isVisible()) await back.click();
    await expect(this.counterRoom).toBeVisible();
    await this.page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Counter/ }).click();
  }

  async goToOffice(): Promise<void> {
    const door = this.page.getByRole('button', { name: 'Open the office' });
    if (await door.isVisible()) await door.click();
    await expect(this.page.getByRole('navigation', { name: 'Office' })).toBeVisible();
  }

  /** Open the till with a float, through the real open-till screen. */
  async openTill(floatText = '200.00'): Promise<void> {
    const screen = this.page.getByRole('region', { name: 'Open the till' });
    await expect(screen).toBeVisible({ timeout: 30_000 });
    // The date is read from the device before the button enables.
    await expect(screen.locator('.till-date')).not.toHaveText('…');
    await screen.getByLabel(/Opening float/).fill(floatText);
    await screen.getByRole('button', { name: 'Open the till' }).click();
    await expect(this.tillBar).toBeVisible({ timeout: 30_000 });
  }

  get tillBar(): Locator {
    return this.page.locator('.till-bar');
  }

  product(name: string): Locator {
    return this.page.getByRole('list', { name: 'Products' }).getByRole('button', { name: new RegExp(`^${escape(name)}`) });
  }

  async addProduct(name: string, times = 1): Promise<void> {
    for (let i = 0; i < times; i += 1) await this.product(name).click();
  }

  /** The visible "Take payment" — the dock's on a wide screen, the bar's on a narrow one. */
  get takePayment(): Locator {
    return this.page.getByRole('button', { name: 'Take payment' }).locator('visible=true').first();
  }

  get payment(): Locator {
    return this.page.getByRole('region', { name: 'Payment' });
  }

  get completeSale(): Locator {
    return this.payment.getByRole('button', { name: 'Complete sale' });
  }

  get receipt(): Locator {
    return this.page.getByRole('region', { name: 'Sale recorded' });
  }

  /** Lines in the open cart, as the shell counts them. */
  async expectCartLines(n: number): Promise<void> {
    const counterTab = this.page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Counter/ });
    if (n === 0) await expect(counterTab).toHaveAccessibleName('Counter');
    else await expect(counterTab).toHaveAccessibleName(new RegExp(`${n} lines? in the cart`));
  }
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface DeviceFixtures {
  readonly api: ApiMock;
  readonly device: Device;
}

export const test = base.extend<DeviceFixtures>({
  api: async ({ context }, use) => {
    const api = new ApiMock(defaultProcedures());
    await api.install(context);
    await use(api);
  },
  device: async ({ page, context, api }, use) => {
    await context.addInitScript((fixture) => {
      (window as unknown as Record<string, unknown>)['__erp_e2e_download__'] = fixture;
    }, downloadFixture());
    // A browser error on the page is a finding, not noise.
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await use(new Device(page, api));
    expect(errors, 'uncaught page errors').toEqual([]);
  },
});

export { expect };
