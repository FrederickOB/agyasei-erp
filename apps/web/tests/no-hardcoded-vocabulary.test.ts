/**
 * §8.9 enforced as a test: no literal currency symbol and no tenant #1
 * vocabulary anywhere in the client source. The currency symbol and
 * minor-unit scale come from configuration (the jurisdiction pack via
 * local_config); "Flagship"/"RDC"/"contractor" are one tenant's words for
 * their own things and live in that tenant's data.
 *
 * Banned tokens are assembled from escapes/pieces so this file cannot match
 * itself if the scan is ever widened to tests.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '../src');
const indexHtml = path.resolve(here, '../index.html');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|css)$/.test(entry)) out.push(p);
  }
  return out;
}

// Tenant #1 vocabulary and jurisdiction terms (§8.9 banned-token list).
const cedi = '₵';
const bannedEverywhere: readonly (string | RegExp)[] = [
  cedi,
  'GH' + cedi,
  'pese' + 'wa',
  'Gha' + 'na',
  'NH' + 'IL',
  'GET' + 'Fund',
  'Flag' + 'ship',
  'Micro-' + 'Outlet',
  new RegExp('\\bGH' + 'S\\b'),
  new RegExp('\\bRD' + 'C\\b'),
  new RegExp('\\bVA' + 'T\\b'),
  new RegExp('\\bcontr' + 'actor\\b', 'i'),
];

// Currency glyphs banned from PRESENTATION files: components and styles. The
// one permitted appearance of a symbol is as configuration DATA (the dev seed
// record), which lives in a plain .ts data file, not a component.
const currencyGlyphs: readonly string[] = [
  '¤', // generic currency sign
  '₵', // cedi sign
  '€', // euro sign
  '£', // pound sign
  '₦', // naira sign
  '¢', // cent sign
];

describe('no hard-coded currency or tenant vocabulary in src/', () => {
  const files = [...walk(srcRoot), indexHtml];

  it('scans a real tree', () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it('contains none of the banned tenant/jurisdiction tokens', () => {
    const offences: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const token of bannedEverywhere) {
        const hit = typeof token === 'string' ? text.includes(token) : token.test(text);
        if (hit) offences.push(`${path.relative(srcRoot, file)}: ${String(token)}`);
      }
    }
    expect(offences).toEqual([]);
  });

  it('has no literal currency glyph in any component or stylesheet', () => {
    const offences: string[] = [];
    for (const file of files.filter((f) => /\.(tsx|css|html)$/.test(f))) {
      const text = readFileSync(file, 'utf8');
      for (const glyph of currencyGlyphs) {
        if (text.includes(glyph)) {
          offences.push(`${path.relative(srcRoot, file)}: U+${glyph.codePointAt(0)?.toString(16)}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it('keeps the placeholder symbol out of everything except the seed config record', () => {
    const generic = '¤';
    for (const file of files) {
      if (file.endsWith(path.join('data', 'seed.ts'))) continue; // the config VALUE
      const text = readFileSync(file, 'utf8');
      expect(text.includes(generic), `literal placeholder symbol in ${file}`).toBe(false);
    }
  });
});
