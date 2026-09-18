# Contributing

Thanks for looking. Bug reports with the Node version, the framework and version, and the lines
the SDK printed (it prints one for everything it refuses to do) are worth a great deal.

## Getting set up

```bash
npm install
npm run typecheck
npm test
```

`npm test` runs everything: the core, the client against an in-process stand-in for ingest, the
process handlers against a fake process, the framework adapters against hand-built requests, and
the edge entry. It should take a few seconds and opens no socket to the outside.

`test/runtimes.real.test.ts` bundles the fixtures in `test/runtimes/` from `src/` and runs them for
real: worker threads, child processes (crash, `SIGTERM`, the spool), a cluster stopped by signal and
by disconnect, and Cloudflare's workerd through Miniflare (Node 22 and up). Each one delivers over
HTTP to an ingest stand-in on `127.0.0.1`.

## What the tests are for

`spec/` is the wire contract the server enforces, and `test/spec.test.ts` runs every fixture in
it: limits, blocked ids, the response state machine, trait parsing, stack parsing per engine, and
deterministic sampling. A number that drifts from the published one fails the build rather than
a customer's request.

`test/hostile.test.ts` runs `spec/fixtures/hostile.json`: cycles, getters that throw, `null` and
numbers where a function belongs, globals that cannot be patched, callbacks that all throw. Every
case runs against a client, the module-level functions and all three adapters, and fails if
anything is thrown, rejects unhandled, or changes what the application's own `fetch`, `console`
or error handler does.

`test/api-surface.test.ts` lists the public functions by name, for the Node entry and the edge
entry both. Adding, renaming or removing one fails until the list and the README agree with it.

There is also a CI job that packs the tarball, installs it somewhere else and imports every
entry both ways, including under the `edge-light` condition. `npm test` imports from `src/`, so
it can pass while the published package is unusable.

## House style

- **Zero runtime dependencies.** A test asserts it.
- **Nothing fails silently.** Every drop, refusal and no-op is a warning that names the
  consequence, printed once and rate limited.
- **Never throw into the application.** Every public method, every scope method, every adapter
  hook and every handler is wrapped, and `init()` is no exception: without a key it logs one error
  and the client is inert. A wrapper around one of the application's functions (`fetch`,
  `console`) calls the original once with the caller's arguments and returns what it returned;
  middleware always hands on, and an error handler hands on the application's error. A promise
  the SDK returns resolves.
- **Never change what the process does without being asked.** Process handlers are opt-in, and
  they defer to any listener the application registered.
- Comments explain *why*, not *what*, and are worth writing where a rule looks arbitrary. Most of
  them here record a failure that a simplification would reintroduce.

## Releasing

Maintainers only. Publishing runs from CI and there is no npm token anywhere: the registry trusts
this repository and this workflow file directly, over the OIDC handshake that also signs the
provenance attestation.

1. Bump `version` in `package.json` and `src/version.ts`, and move the changelog heading.
2. Create a GitHub release tagged `v<version>`.

The workflow refuses to run if the tag disagrees with `package.json`, builds, tests, publishes,
and then installs the published version from the registry to prove it.
