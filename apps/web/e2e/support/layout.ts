/**
 * Layout assertions that catch real defects, not pixels.
 *
 *   · no horizontal page scroll — a counter that pans sideways under a thumb
 *     hides the total or the pay button off one edge;
 *   · primary touch targets at least 44 × 44 CSS px on touch devices (WCAG
 *     2.5.5's target size; the counter's own rule is larger, 56 px);
 *   · essential things not clipped — inside the viewport horizontally, not
 *     truncated by their own box, and not covered by something else at their
 *     centre (a docked bar sitting over the button it is meant to hold).
 *
 * Each failure names the offending elements so the fix starts from the trace.
 */
import { expect, type Locator, type Page } from '@playwright/test';

export const MIN_TOUCH_PX = 44;

/**
 * No sideways scroll: `document.documentElement.scrollWidth` fits the DEVICE's
 * width, with the culprits named.
 *
 * Measured against the configured viewport, not `innerWidth` alone: on a mobile
 * viewport Chromium — like Chrome on an Android phone — zooms the page OUT to
 * fit content wider than the device, and `innerWidth` grows with it. A 360 px
 * phone showing a 759 px counter at 47% reports `scrollWidth === innerWidth`,
 * passes the naive check, and is unusable in a hand.
 */
export async function expectNoHorizontalScroll(page: Page, where: string): Promise<void> {
  const device = page.viewportSize()?.width ?? Number.POSITIVE_INFINITY;
  const result = await page.evaluate((deviceWidth) => {
    const vw = Math.min(window.innerWidth, document.documentElement.clientWidth, deviceWidth);
    const sw = document.documentElement.scrollWidth;
    const inner = window.innerWidth;
    const culprits: string[] = [];
    if (sw > vw || inner > vw) {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right > vw + 0.5) {
          const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
          culprits.push(`${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''} right=${Math.round(r.right)}`);
        }
        if (culprits.length >= 8) break;
      }
    }
    return { vw, sw, inner, culprits };
  }, device);
  const widest = `Widest: ${result.culprits.join(', ')}`;
  expect(
    result.inner,
    `${where}: the browser zoomed out to fit ${result.inner}px of content on a ${result.vw}px device. ${widest}`,
  ).toBeLessThanOrEqual(result.vw);
  expect(
    result.sw,
    `${where}: page is ${result.sw}px wide on a ${result.vw}px device — scrolls sideways. ${widest}`,
  ).toBeLessThanOrEqual(result.vw);
}

/** Every visible match is at least MIN_TOUCH_PX square. */
export async function expectTouchTargets(targets: Locator, what: string, min = MIN_TOUCH_PX): Promise<number> {
  const count = await targets.count();
  const small: string[] = [];
  let checked = 0;
  for (let i = 0; i < count; i += 1) {
    const t = targets.nth(i);
    if (!(await t.isVisible())) continue;
    const box = await t.boundingBox();
    if (box === null) continue;
    checked += 1;
    if (box.width < min - 0.5 || box.height < min - 0.5) {
      const label = ((await t.getAttribute('aria-label')) ?? (await t.innerText())).trim().replace(/\s+/g, ' ');
      small.push(`"${label.slice(0, 40)}" ${Math.round(box.width)}×${Math.round(box.height)}`);
    }
  }
  expect(checked, `${what}: no visible targets to measure`).toBeGreaterThan(0);
  expect(small, `${what}: touch targets under ${min}×${min} CSS px`).toEqual([]);
  return checked;
}

/**
 * Inside the viewport horizontally, not truncated within its own box (or any
 * descendant's), and the topmost thing at its centre once scrolled into view.
 */
export async function expectNotClipped(target: Locator, what: string): Promise<void> {
  await expect(target, `${what} is visible`).toBeVisible();
  const report = await target.evaluate((el) => {
    // Centre it first: something scrolled up under a sticky bar is scrolling,
    // not clipping. What is measured is the element where a person would look.
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    // The layout viewport, not innerWidth, which a zoomed-out mobile page inflates.
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const r = el.getBoundingClientRect();
    const problems: string[] = [];
    if (r.left < -0.5 || r.right > vw + 0.5) {
      problems.push(`spans x ${Math.round(r.left)}..${Math.round(r.right)} in a ${vw}px viewport`);
    }
    for (const node of [el, ...Array.from(el.querySelectorAll<HTMLElement>('*'))]) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (node.scrollWidth > node.clientWidth + 1 && style.overflowX !== 'visible') {
        problems.push(
          `${node.tagName.toLowerCase()}.${String(node.className).split(' ')[0]} truncates its content (${node.scrollWidth} > ${node.clientWidth})`,
        );
      }
    }
    const cx = Math.min(Math.max(r.left + r.width / 2, 0), vw - 1);
    const cy = Math.min(Math.max(r.top + r.height / 2, 0), vh - 1);
    const top = document.elementFromPoint(cx, cy);
    if (top !== null && top !== el && !el.contains(top)) {
      problems.push(`covered at its centre by ${top.tagName.toLowerCase()}.${String((top as HTMLElement).className).split(' ')[0]}`);
    }
    return problems;
  });
  expect(report, `${what} is clipped`).toEqual([]);
}

/** Which form factor a project emulates, from its own config. */
export function formFactor(projectName: string): 'tablet' | 'laptop' | 'phone' {
  if (projectName.startsWith('tablet')) return 'tablet';
  if (projectName.startsWith('phone')) return 'phone';
  return 'laptop';
}
