import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const p = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: '@erp/db/testing', replacement: p('../db/src/testing/harness.ts') },
      { find: '@erp/db/seed', replacement: p('../db/src/seed/index.ts') },
      { find: '@erp/db', replacement: p('../db/src/index.ts') },
      { find: '@erp/money', replacement: p('../money/src/index.ts') },
      { find: '@erp/contracts', replacement: p('../contracts/src/index.ts') },
    ],
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
