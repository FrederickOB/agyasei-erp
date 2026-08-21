import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: {
    // Workspace siblings resolved from source for the hermetic self-test.
    // At integration time pnpm resolves the same names via workspace:*.
    alias: [
      { find: '@erp/db/testing', replacement: p('../../packages/db/src/testing/harness.ts') },
      { find: '@erp/db/seed', replacement: p('../../packages/db/src/seed/index.ts') },
      { find: '@erp/db', replacement: p('../../packages/db/src/index.ts') },
      { find: '@erp/money', replacement: p('../../packages/money/src/index.ts') },
    ],
  },
  test: {
    include: ['test/**/*.test.ts'],
    // PGlite boots a full Postgres in WASM; give it room.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: true,
  },
});
