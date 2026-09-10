import { defineConfig } from 'vitest/config';

/** Everything runs in Node against an in-process HTTP stand-in for ingest; no sockets to the outside. */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
