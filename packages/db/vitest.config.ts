import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // PGlite boots a full Postgres in WASM; give it room.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Each test file creates its own PGlite instance; files may run in parallel,
    // but tests within a file are sequential (they share one connection).
    fileParallelism: true,
  },
});
