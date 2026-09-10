import { defineConfig } from 'tsup';

/**
 * ESM + CJS with declarations for every entry. `edge` is built for a platform with no `node:`
 * modules at all, so an edge bundler that resolves the `edge-light` / `workerd` condition never
 * sees `async_hooks`, `fs` or `zlib`. `scripts/postbuild.mjs` marks the source maps as SDK code
 * and strips embedded sources.
 *
 * The Node entries are SPLIT into shared chunks, not bundled one by one: the framework adapters
 * read the default client through `getClient()`, and a private copy of the facade inside each
 * adapter would always see no client and quietly do nothing. One chunk, one client.
 */
export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      'frameworks/express': 'src/frameworks/express.ts',
      'frameworks/fastify': 'src/frameworks/fastify.ts',
      'frameworks/nest': 'src/frameworks/nest.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    target: 'node18',
    platform: 'node',
    clean: true,
    splitting: true,
    treeshake: true,
  },
  {
    entry: { edge: 'src/edge.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    target: 'es2022',
    platform: 'neutral',
    splitting: false,
    treeshake: true,
  },
]);
