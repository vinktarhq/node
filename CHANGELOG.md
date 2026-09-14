# Changelog

## 0.2.1

### Fixed

- With `captureErrors`, an uncaught exception in a worker thread no longer leaves the thread
  running. The error is reported and flushed, then thrown again, so the thread stops and its
  `Worker` emits `error` exactly as it does without the SDK.

## 0.2.0

State set for one request or job could reach another, one client's scope could reach another
client's project, and delivery results could report success for data the server never kept. This
release fixes those and changes behaviour your code may rely on: read "Changed" before upgrading.

### Changed

- Every client has its own `AsyncLocalStorage`. A scope entered through one client is invisible to
  another, so a second client in the same process no longer sends the first client's user, tags or
  context to its own project.
- `register()`, `registerOnce()` and `unregister()` act on the current scope. Called inside a request
  or job they no longer reach other requests or jobs; called at startup they still apply to every
  request. Use `superProperties` for values that belong to the whole service.
- `enterScope()` and the framework adapters start a fresh scope per request: the process scope's
  tags, context and registered properties, and never a user, device, session, request or
  breadcrumbs from earlier work.
- `reset()` clears registered properties too, and no longer restores `userId`, `deviceId` or
  `sessionId` from `initialScope`. Service jobs that relied on a constant actor should set it in
  each job's scope.
- An explicit `userId`, `deviceId` or `sessionId` that is not usable no longer falls back to the
  scope's: `track` and `page` refuse the event with a warning, `identify` refuses the call, and an
  error is sent with no identity at all. One validator now applies everywhere, so ids up to 255
  characters that `identify` accepted are also accepted per call.
- `flush()` resolves `true` only when everything queued at the call was accepted. A batch that is
  held, retrying, refused or partly rejected now resolves `false`.
- `close()` refuses new work as soon as it is called, and every call, repeated or concurrent, gets
  the same answer. Records it could not deliver go to the spool when there is one, and are
  otherwise reported as lost.
- The same error for the same user is sent once per five-second window, and the window no longer
  restarts on every repeat. Different users' identical errors are separate occurrences, so error
  counts can rise: those occurrences were real and hidden before. Suppressed repeats are counted in
  client reports as `deduplicated`.
- The Nest filter answers with Nest's default response instead of rethrowing (see Fixed). Pass
  `httpAdapter` from `HttpAdapterHost` for identical behaviour on every platform, or call
  `captureNestException()` from a filter of your own.
- `enabled: false` no longer requires a write key.

### Added

- `asyncLocalStorage` option, for Cloudflare Workers and other runtimes that do not expose it
  globally. Without one, the edge entry warns the first time concurrent requests share a scope.
- `handleSignals` option, to leave `SIGTERM` and `SIGINT` to the application.
- `enterScope` and `flushIfServerless` exported from both entries, as the documentation already
  said.
- `captureNestException(exception, host)` for applications with their own exception filter.

### Fixed

- Redirects are not followed. Native `fetch` sent the write key and the body to wherever a 3xx
  pointed; a redirect now stops sending with one error line and keeps what is queued.
- The request timeout covers compression and reading the response body, and a response that
  stalls after its headers is a failure rather than a delivery.
- Any 2xx counts as accepted, a storage outage backs off exponentially instead of giving up after
  about two minutes, a monthly cap is held until the server's reset time (checking again at most
  every six hours), and a long hold on events no longer delays errors.
- A `beforeTrack` or `beforeSend` hook that returns something unserialisable loses only that
  record, not the batch; hook output is held to the same limits as the SDK's own.
- Payload and context properties together stay within the server's 255-property limit.
- `captureMessage()` honours `handled: false`.
- `unhandledRejections: 'none'` no longer installs a listener, which had stopped Node's default
  crash on an unhandled rejection. A rejection that crashes the process is reported as one.
- Several clients share one set of process listeners, so a crash exits once after every client has
  flushed and a signal is re-raised once.
- The Nest exception filter rethrew, which skipped Nest's default filter: every reported error
  became an HTML 500 from the platform. It now sends Nest's own JSON response.
- The Express and Nest error handlers no longer write the request into the process-wide scope when
  no request middleware ran, and `$request` events keep the request's user.
- `vinktarFastify` compiles against Fastify's own types.
- A disabled client no longer deletes the spool. The spool file is created with mode 0600, records
  which write key wrote it and is left alone by a client with another key, is kept until this
  process rewrites it, and is never deleted by a process that did not write or restore it.
- Serverless detection no longer mistakes an ECS container for AWS Lambda.
- Client reports are kept when the request carrying them is refused, and are sent within a minute
  even when nothing else is queued.
- The default client is shared between the CommonJS and ES module builds.

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
