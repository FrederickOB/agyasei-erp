/**
 * THE SEAM IS NOT IN PRODUCTION — proved on the bytes, with a control.
 *
 * e2e/build.mjs builds `dist-guard/` the way the web image does (mode
 * production, device path, no token) and `dist-e2e/` with the seam. This spec
 * greps both:
 *
 *   · the CONTROL: the e2e build must contain the seam's marker. A grep that
 *     cannot find the marker where it is known to be proves nothing.
 *   · the GUARD: no file the production build emits — HTML, JS, the service
 *     worker and its precache manifest, the web manifest — may contain the
 *     marker, the seam's chunk name or the fixture global it reads.
 *
 * Source maps are checked for the marker too. They legitimately carry
 * main.tsx's source text, so the chunk NAME appears there (the import path is
 * in the dead branch's source); the marker lives only in the seam module and
 * must not. The web image deletes *.map before it ships regardless.
 *
 * Node-only: no browser, no page.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = 'erp-e2e-download-seam:v1';
const TRACES = [MARKER, 'download-seam', '__erp_e2e_download__', 'applyE2eDownload'];

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) files(p, out);
    else out.push(p);
  }
  return out;
}

const TEXT = /\.(js|mjs|html|json|webmanifest|css|map)$/;

function hits(dir: string, needle: string, opts: { maps: boolean }): string[] {
  return files(dir)
    .filter((f) => TEXT.test(f) && (opts.maps || !f.endsWith('.map')))
    .filter((f) => readFileSync(f, 'utf8').includes(needle))
    .map((f) => path.relative(appDir, f));
}

test('the production build carries no trace of the e2e download seam', () => {
  const prod = path.join(appDir, 'dist-guard');
  const e2e = path.join(appDir, 'dist-e2e');
  expect(existsSync(path.join(prod, 'index.html')), 'dist-guard/ built (node e2e/build.mjs)').toBe(true);
  expect(existsSync(path.join(e2e, 'index.html')), 'dist-e2e/ built (node e2e/build.mjs)').toBe(true);

  // Control: the grep finds the seam where it is known to be.
  expect(hits(e2e, MARKER, { maps: false }).length, 'marker present in the e2e build').toBeGreaterThan(0);
  expect(hits(e2e, 'download-seam', { maps: false }).length, 'seam chunk present in the e2e build').toBeGreaterThan(0);

  // Guard: nothing shipped names it.
  for (const trace of TRACES) {
    expect(hits(prod, trace, { maps: false }), `"${trace}" in the production build`).toEqual([]);
  }
  expect(hits(prod, MARKER, { maps: true }), 'marker in a production source map').toEqual([]);

  // And the production build is the device path, not a dev bearer.
  const index = files(prod).filter((f) => f.endsWith('.js') && !f.endsWith('.map'));
  expect(index.some((f) => readFileSync(f, 'utf8').includes('e2e-fixture-not-a-signature'))).toBe(false);
});
