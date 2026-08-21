import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Pure schema parsing: no database, no wasm, no network.
    environment: 'node',
  },
});
