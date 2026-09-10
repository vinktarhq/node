# Changelog

## 0.1.0

First release.

### Analytics

- `track`, `page`, `identify` with flat `$set` / `$set_once` / `$unset` traits, `setUser`,
  `reset`, and in-process super properties.
- Per-call identity and timestamps on `track`, with timestamps outside the server's window
  refused locally rather than sent to be rejected.
- Deterministic sampling on the user or device, and per-minute valves.

### Scopes

- A scope per unit of work in `AsyncLocalStorage`: user, device, session, tags, context, request
  and breadcrumbs, forked by value for `withScope` and bound to the rest of an async context by
  `enterScope` for frameworks whose hooks return rather than wrap.
- `scopeFromHeaders` adopts the browser SDK's identity headers after validation, so server events
  and errors stitch to the visit that caused them.

### Errors

- Manual capture, plus opt-in process handlers that exit only when they are the sole listener,
  never from a worker thread, and that read Node's `--unhandled-rejections` mode from the flags
  and `NODE_OPTIONS` before deciding whether hooking rejections would change the process.
- Frames with in-app classification against `projectRoot`, paths made relative to it, and source
  context around the frames nearest the crash, read synchronously with a bounded cache that
  remembers misses and skips minified or generated files.
- The request the error happened in, with a safe header set and never cookies or authorization.
- Breadcrumbs from console output and outbound `fetch`, excluding the SDK's own.
- Errors reported once across framework layers.

### Frameworks

- Express middleware and error handler, a Fastify plugin that applies at the root, and NestJS
  middleware and exception filter, all structurally typed with no framework dependency, with
  optional `$request` events.

### Serverless and edge

- An `edge` entry with no `node:` imports, selected by the `edge-light`, `workerd` and `worker`
  conditions, on which nothing is sent until asked.
- `flushIfServerless` hands the flush to `waitUntil` where one exists (Cloudflare, Vercel Edge),
  awaits inline on platforms known to kill background work, and never rejects through `waitUntil`.

### Transport

- The response state machine the server publishes: durable on 202, retained on 503, held per
  category on 429, halved on 413, stopped on 401/403, backed off with jitter otherwise.
- A deadline of the SDK's own, response bodies always consumed, one retry on a reused socket
  that reset, and a client report of everything dropped in every request.
- `close()` bounded by `shutdownTimeout`, giving up on a queue that cannot drain; flush on
  `beforeExit`; `SIGTERM`/`SIGINT` re-raised after closing when the SDK was the only listener;
  an opt-in atomic disk spool for what could not be sent.

### Packaging

- ESM and CommonJS with types for the root, the `edge` entry and each framework adapter;
  `sideEffects: false`; zero runtime dependencies. Node 18.17+.
