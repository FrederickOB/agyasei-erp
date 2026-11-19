#!/usr/bin/env node
/**
 * Production build: esbuild bundles each entry point into ONE self-contained
 * ES module under dist/bin/, and copies the migrations beside it.
 *
 * WHY A BUNDLE, NOT `tsc`: the workspace packages (@erp/db, @erp/ops) export
 * TypeScript SOURCE. A tsc build would need every package to grow a dist/
 * and dual exports — a second resolution path to keep in sync across the
 * repo, for no benefit at runtime. esbuild is already in the dependency graph
 * (tsx uses it), compiles in well under a second, and type checking stays
 * where it is: `tsc --noEmit` in CI. The runtime image then needs Node and
 * these files — no node_modules, no pnpm, no source.
 *
 * NO CODE SPLITTING, deliberately: @erp/db finds its migrations relative to
 * the file its code lands in (`new URL('../migrations/', import.meta.url)`),
 * so every entry must be a single file in dist/bin/ for dist/migrations/ to
 * be where that URL points.
 */
import { cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

rmSync(here('./dist'), { recursive: true, force: true });

const result = await build({
  entryPoints: {
    main: here('./src/main.ts'),
    migrate: here('./src/cli/migrate.ts'),
    jobs: here('./src/cli/jobs.ts'),
    ops: here('./src/cli/ops.ts'),
  },
  outdir: here('./dist/bin'),
  bundle: true,
  splitting: false,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  keepNames: true,
  sourcemap: false,
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
  // pg's optional native binding is never loaded (we use the pure-JS client);
  // PGlite is the test harness and must never reach a production bundle.
  external: ['pg-native', '@electric-sql/pglite'],
  // CommonJS dependencies call require(); an ES module has none of its own.
  banner: {
    js: "import { createRequire as __erpCreateRequire } from 'node:module'; const require = __erpCreateRequire(import.meta.url);",
  },
});

for (const [file, meta] of Object.entries(result.metafile.outputs)) {
  for (const imp of meta.imports) {
    if (imp.external && imp.path === '@electric-sql/pglite') {
      throw new Error(`${file} imports the PGlite test harness: a test-only path leaked into production code`);
    }
  }
}

cpSync(here('../../packages/db/migrations'), here('./dist/migrations'), { recursive: true });

const sizes = Object.entries(result.metafile.outputs)
  .map(([f, m]) => `${f.replace(/^.*dist\//, 'dist/')} ${(m.bytes / 1024).toFixed(0)} KiB`)
  .join(', ');
console.log(`@erp/api build: ${sizes}; migrations copied to dist/migrations`);
