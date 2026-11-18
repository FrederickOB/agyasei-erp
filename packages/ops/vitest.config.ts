import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: '@erp/db/testing', replacement: p('../db/src/testing/harness.ts') },
      { find: '@erp/db/seed', replacement: p('../db/src/seed/index.ts') },
      { find: '@erp/db', replacement: p('../db/src/index.ts') },
    ],
  },
  test: {
    include: ['test/**/*.test.ts'],
    // PGlite boots a full Postgres in WASM; give it room.
    pool: 'forks',
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: true,
  },
});
