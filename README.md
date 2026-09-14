# @vinktarhq/node

[![npm](https://img.shields.io/npm/v/@vinktarhq/node.svg)](https://www.npmjs.com/package/@vinktarhq/node)
[![CI](https://github.com/vinktarhq/node/actions/workflows/ci.yml/badge.svg)](https://github.com/vinktarhq/node/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@vinktarhq/node.svg)](https://nodejs.org)
[![licence](https://img.shields.io/npm/l/@vinktarhq/node.svg)](./LICENSE)

Product analytics and error tracking for Node.js and edge runtimes, with the identity of the
request that is being served.

Events and errors from a server carry the user, device and session of the visitor they were
served for, so a backend error sits next to the browser events that led to it in
[Vinktar](https://vinktar.com). Every request gets a scope of its own, and so does every client:
nothing one request or job sets reaches another, and nothing one client sets reaches another
client's project.

```ts
import { init, track, captureException } from '@vinktarhq/node';
import { vinktarRequest, vinktarErrors } from '@vinktarhq/node/express';

init({ writeKey: process.env.VINKTAR_KEY });

app.use(vinktarRequest());       // one scope per request, identity from the browser SDK's headers
app.post('/orders', (req, res) => {
  track('order_created', { total: 42 });   // attributed to this request's user
  res.json({ ok: true });
});
app.use(vinktarErrors());        // reports, then hands the error on
```

That is the whole setup. Set `VINKTAR_KEY` and the call to `init()` needs no arguments at all.

**Node 18+, Bun, Deno, Cloudflare Workers and Vercel Edge. Zero runtime dependencies. Never
throws into your code.** Everything the SDK cannot send is said out loud in the logs once.

---

## Contents

- [Getting a key](#getting-a-key)
- [Analytics](#analytics)
- [Scopes and identity](#scopes-and-identity)
- [Errors](#errors)
- [Frameworks](#frameworks)
- [Serverless and edge](#serverless-and-edge)
- [Shutting down](#shutting-down)
- [Options](#options)
- [Environment variables](#environment-variables)
- [Nothing is showing up?](#nothing-is-showing-up)
- [How it works](#how-it-works)
- [Compatibility](#compatibility)
- [Licence](#licence)

---

## Getting a key

A server can use either the project's write key (`vnk_pk_…`) or a secret key (`vnk_sk_…`); both
can append events. Keys are created in the project settings. Without a key, `init()` throws:
a server with no key is misconfigured, and that belongs in the first deploy's logs rather than in a
dashboard weeks later. The one exception is `enabled: false`, which needs no key and does nothing.

## Analytics

```ts
track('order_created', { total: 42 });
track('imported', { rows: 1200 }, { userId: 'user_42', timestamp: row.createdAt });
page('/pricing');                     // a server-rendered route is a pageview
identify('user_42', { email: 'ada@example.com', plan: 'pro' }, { signed_up: '2026-01-15' });
register({ plan: 'pro' });            // on this scope's events: this request or job only
```

`register()` adds properties to the current scope's analytics events. Inside a request or a job
they stay there; called at startup, outside any request, they apply to every request that follows.
For values that belong to the whole service, `superProperties` in `init()` says so explicitly.
Registered properties go on events, not on errors; error context is `setContext()`.

The third argument to `track` and `page` names the person when the call site knows better than
the scope, and takes a `timestamp` for events that happened earlier (an import, a queue job). An id
given there applies to that call only. One that is not usable (blank, a placeholder such as
`guest`, or too long) refuses the event with a warning rather than sending it as the scope's user.
Timestamps outside the window the server accepts, seven days back and an hour ahead, are refused
with a warning rather than sent to be rejected.

Traits are flat values: the second argument is set every time, the third only the first time.
Reserved traits (`email`, `name`, `username`, `avatar`, `created`) are stored under their
canonical `$`-prefixed names; spell them either way.

## Scopes and identity

A **scope** holds the user, device, session, tags, context, registered properties, the request and
the breadcrumb trail for one unit of work. On Node it lives in an `AsyncLocalStorage` that belongs
to that client, so everything that runs within a request, however deep and however asynchronous,
sees that request's scope, and a second client in the same process never sees it at all.

```ts
withScope(async (scope) => {
  scope.setUser('user_42');
  scope.setTag('job', 'nightly-export');
  await runExport();                 // errors and events inside carry the user and the tag
});

scope().setContext({ tenant: 'acme' });
setUser({ id: 'user_42', plan: 'pro' });
setUser(null);                       // the user only; see below
reset();                             // everything on this scope
```

`withScope` forks the current scope for the callback and the promise it returns: changes inside
stay inside, it returns what the callback returns, and an exception thrown inside comes straight
back out, unreported. `enterScope()` starts a **fresh** scope for the rest of the current async
context, for frameworks whose hooks return rather than wrap the handler. A fresh scope carries the
tags, context and properties set for the whole process, and never a user, device, session, request
or breadcrumbs from anything that ran before. The framework adapters start one per request.

`setUser(null)` clears the user and nothing else. A device adopted from the browser stays, and the
server resolves events carrying a device it has linked to a user back to that user, so clearing the
user does not make later events anonymous. To forget an actor, give the work a fresh scope, or call
`reset()`, which clears the whole scope, registered properties included, and puts back only the
configured tags and context: an identity in `initialScope` is never restored.

**Stitching to the browser.** The browser SDK can stamp `X-Vinktar-Device-Id` and
`X-Vinktar-Session-Id` on requests to your own origin (`propagateIdentity`). `scopeFromHeaders`
adopts them after validation, so this request's events and errors resolve to the same visit.
The adapters call it for you.

## Errors

```ts
captureException(error, { tags: { area: 'billing' }, context: { invoice: 9 } });
captureMessage('Webhook retried 5 times', { level: 'warning' });
addBreadcrumb({ category: 'queue', message: 'job started', data: { id } });
```

Uncaught exceptions and unhandled rejections are reported when you ask:

```ts
init({ writeKey, captureErrors: true });   // or registerHandlers() later
```

This is opt-in because attaching a listener changes what the process does. The handler reports
the error, flushes within `shutdownTimeout`, and then reproduces Node's default (print, exit 1),
but **only if it is the only listener**: if you registered your own `uncaughtException` handler,
the process is yours and the SDK only observes. Worker threads never exit the process from here.
Unhandled rejections are hooked only in Node's `warn` and `none` modes; under the default `throw`
they already reach the exception handler and are reported as rejections, and `strict` and
`warn-with-error-code` are left to the operator. Several clients in one process share one set of
listeners, so a crash exits once, after every client has flushed.

Errors carry the cause chain, parsed frames with in-app frames marked and made relative to
`projectRoot`, five lines of source around each in-app frame nearest the crash (read from disk,
cached, scrubbed), the request (method, URL without its query, and a safe set of headers; never
cookies or authorization), the scope's user, tags, context and breadcrumbs, and the runtime and
server name. Breadcrumbs come from console output and outbound `fetch` calls (method, URL, status,
duration; never a body or a header).

The same error for the same user within five seconds is sent once and the repeats are counted;
two users hitting one bug are two occurrences. `ignoreErrors` is honoured, and per-minute valves
(100 in all, half that per error type, by default) stop a loop from spending the quota. Secret-shaped values are scrubbed from messages
and source lines before they leave the process.

Source maps: `@vinktarhq/cli` uploads them and stamps bundles with debug ids that the server
matches frames against.

## Frameworks

Every adapter is a subpath export with no dependency on the framework, typed structurally.

### Express

```ts
import { vinktarRequest, vinktarErrors } from '@vinktarhq/node/express';

app.use(vinktarRequest({ trackRequests: true }));   // first
…
app.use(vinktarErrors({ minimumStatus: 500 }));     // last; always calls next(error)
```

`trackRequests` sends a `$request` event per response with route, method, status and duration.
It is off by default: an event per request is a line on a bill.

### Fastify

```ts
import { vinktarFastify } from '@vinktarhq/node/fastify';

app.register(vinktarFastify, { trackRequests: true });
```

### NestJS

```ts
import { HttpAdapterHost } from '@nestjs/core';
import { VinktarMiddleware, VinktarExceptionFilter } from '@vinktarhq/node/nest';

const { httpAdapter } = app.get(HttpAdapterHost);
app.use(new VinktarMiddleware().use);
app.useGlobalFilters(new VinktarExceptionFilter({ httpAdapter }));
```

The filter reports the error and then answers exactly as Nest's own filter would: an
`HttpException`'s response, or `{ statusCode: 500, message: 'Internal server error' }`. It cannot
hand the error on by rethrowing it, because Nest does not pass a rethrown exception to its default
filter. If you already have a filter extending `BaseExceptionFilter`, call
`captureNestException(exception, host)` from its `catch` instead.

An error is reported once even when it passes through several layers.

## Serverless and edge

```ts
import { init, track, flushIfServerless } from '@vinktarhq/node/edge';

init({ writeKey: env.VINKTAR_KEY });

export default {
  async fetch(request, env, ctx) {
    const response = await handle(request);
    await flushIfServerless({ context: ctx });   // hands the flush to ctx.waitUntil
    return response;
  },
};
```

On Cloudflare Workers, pass `AsyncLocalStorage` in, or concurrent requests share one scope (the
SDK says so the first time it sees them overlap):

```ts
import { AsyncLocalStorage } from 'node:async_hooks';   // with the nodejs_als or nodejs_compat flag

init({ writeKey: env.VINKTAR_KEY, asyncLocalStorage: AsyncLocalStorage });
```

The `edge` entry imports no `node:` modules and is what bundlers select under the `edge-light`,
`workerd` and `worker` conditions (Vercel Edge, Cloudflare, Next.js middleware). On it,
**nothing is sent until asked**: a request the runtime finds running after the handler returned is
a request it kills, so there is no background timer. `flushIfServerless` uses the platform's
`waitUntil` when given one, finds Vercel's on its own, awaits inline on AWS Lambda, Cloud Run,
Azure Functions and Netlify, and does nothing on a long-lived server. A flush handed to
`waitUntil` never rejects, because on some platforms that would fail the whole invocation.

On Node in a Lambda-style function, call the same helper from the Node entry at the end of the
handler.

## Shutting down

```ts
const delivered = await flush();   // true when everything queued was accepted
await close();                     // once, before the process exits
```

`flush()` resolves `true` only when everything queued when it was called was accepted by the
server. A batch waiting out a rate limit, retrying after a failure, or refused (in whole, or one
record inside an accepted batch) resolves `false`; the SDK keeps retrying on its own. Unlike some
SDKs, `true` does not just mean "nothing is in flight any more". A `false` is about telemetry, not
your application: never retry your own work because of it.

`close()` refuses new work at once, delivers what it can within `shutdownTimeout` (2 s), and tears
every patch down. Every call, including one made while the first is still running, resolves with
the same answer. On Node the SDK also flushes on `beforeExit`, and on `SIGTERM`/`SIGINT` closes and
then re-raises the signal if nothing else is listening, so the exit code stays what the platform
expects. An application with its own shutdown sequence sets `handleSignals: false` and calls
`close()` from it. Timers are unreferenced, so a script is never kept alive by a pending flush.

`spoolPath` keeps what could not be delivered in a file the next process sends. It is best effort:
nothing is written when a process is killed outright, and delivery after a restore is at least once
(the server deduplicates on the event id). The file is private (0600), records which write key wrote
it, and belongs to one process: give each process its own path.

## Options

| Option | Default | |
|---|---|---|
| `writeKey` | `$VINKTAR_KEY` | Required. |
| `host` | `$VINKTAR_HOST`, `https://in.vinktar.com` | |
| `enabled` / `debug` | `true` / `false` | |
| `analytics` / `errors` | `true` | Either half can be turned off. |
| `release` | `$VINKTAR_RELEASE` | |
| `environment` | `$VINKTAR_ENVIRONMENT`, `$NODE_ENV`, `production` | |
| `enabledEnvironments` | `[]` | Send only from these. |
| `serverName` | hostname | Names the service on every error. |
| `initialScope` | `{}` | `{ tags, context }` for every scope, and put back by `reset()`. An identity given here applies only outside any request and is never restored. |
| `flushAt` / `flushIntervalMs` | `20` / `10000` | |
| `maxQueueSize` | `1000` | Oldest dropped past this, and counted. |
| `requestTimeoutMs` | `5000` | |
| `gzip` | `true` | Bodies of 1 KiB and over. |
| `shutdownTimeout` | `2000` | Bound on `close()` and on the crash path. |
| `spoolPath` | `''` | Opt-in disk spool, one per process. |
| `autoFlush` | `true` | Flush on `beforeExit`. |
| `handleSignals` | `true` | Close on `SIGTERM`/`SIGINT`. |
| `captureErrors` | `false` | Process-wide handlers. |
| `unhandledRejections` | `'auto'` | `'none'` never installs a rejection listener. |
| `breadcrumbs` | `true` | Or `{ console, http }`. |
| `maxBreadcrumbs` | `50` | |
| `sampleRate` / `errorSampleRate` | `1` | Per user or device / per issue. |
| `maxEventsPerMinute` / `maxErrorsPerMinute` | `6000` / `100` | |
| `dedupe` | `true` | The same error for the same user once per five seconds; repeats are counted. |
| `ignoreErrors` | `[]` | Strings (substring) or regular expressions. |
| `superProperties` | `{}` | On every event. |
| `sendDefaultPii` | `false` | Full URLs, query strings, and request headers beyond the safe set. |
| `redactedKeys` / `propertyDenylist` | `[]` | |
| `maxValueBytes` / `normalizeDepth` | `255` / `3` | The server's caps. |
| `includeRawStack` / `attachStacktrace` | `false` | |
| `projectRoot` | `process.cwd()` | Frames under it are in-app. |
| `contextLines` | `5` | `0` turns source context off. |
| `beforeTrack` / `beforeSend` / `beforeBreadcrumb` | | A function or a list: return the value, or `null` to drop it. |
| `onError` | | Called when the SDK itself fails at something. |
| `logger` | console | `(level, message, data) => void`. |
| `fetch` | global | The `fetch` to send with: a proxy (`undici`'s `EnvHttpProxyAgent` through a wrapper), or a test double. |
| `asyncLocalStorage` | global | The `AsyncLocalStorage` class, for a runtime that does not expose it globally. |

## Environment variables

| | |
|---|---|
| `VINKTAR_KEY` | The write key. |
| `VINKTAR_HOST` | Ingest host. |
| `VINKTAR_RELEASE` | The release; the same value the source maps were uploaded under. |
| `VINKTAR_ENVIRONMENT` | Overrides `NODE_ENV`. |

## Nothing is showing up?

Read the logs. The SDK never fails silently: a missing key throws, an option out of range warns,
a dropped property, a refused trait, a rejected batch and a rate limit each print one line that
says what happened. `debug: true` adds the rest.

The three usual causes: the process exited before the batch went out (call `close()`, or use
`flushIfServerless` in a function); a proxy in the way (pass a `fetch` that knows about it); or
`enabledEnvironments` not including this one.

## How it works

Events are batched and sent as JSON, compressed over 1 KiB, to `/v1/batch`; errors to
`/v1/errors`. Any `2xx` means the batch was accepted and the SDK forgets it. A `503` means it was
**not** stored and the SDK keeps it, backing off from the server's `Retry-After`. `429` pauses only
the throttled category; a monthly cap pauses sending and checks again at most every six hours.
`413` halves the batch. `401`/`403` stop the SDK for good with one loud line. A redirect is never
followed, because following it would send the write key somewhere else: it stops sending too, and
keeps what is queued. Everything else backs off exponentially with jitter, capped at thirty
minutes. What was dropped is counted and reported to the project, within a minute even when
nothing else is being sent.

The transport gives each send one deadline, covering compression, the request and reading the
response, raced against each step rather than trusting an `AbortSignal` (an injected `fetch` may
ignore one). It always consumes or cancels the response body, and retries once when a reused
keep-alive socket resets (they go stale while a serverless instance is frozen); the retry is safe
because every item carries an id the server deduplicates on.

The wire contract the tests run against (limits, blocked ids, the response state machine, trait
parsing, stack parsing across engines, deterministic sampling) is vendored in `spec/` and
published at [vinktar.com/api.md](https://vinktar.com/api.md).

## Compatibility

| | Supported |
|---|---|
| Node | 18.17 and newer. |
| Bun, Deno | Through the Node entry; `$runtime` on every event says which. |
| Cloudflare Workers, Vercel Edge, Next.js middleware | Through the `edge` entry, selected automatically by the `edge-light` / `workerd` / `worker` conditions. |
| Frameworks | Express 4 and 5, Fastify 4 and 5, NestJS 10 and 11 adapters, tested against Express 5, Fastify 5 and NestJS 11 on Node 20 and newer; anything else through `withScope` / `enterScope`. |
| Modules | ESM and CommonJS with types, `sideEffects: false`. |

## Licence

MIT. © Vinktar.
