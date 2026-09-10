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

## What the tests are for

`spec/` is the wire contract the server enforces, and `test/spec.test.ts` runs every fixture in
it: limits, blocked ids, the response state machine, trait parsing, stack parsing per engine, and
deterministic sampling. A number that drifts from the published one fails the build rather than
a customer's request.

`test/api-surface.test.ts` lists the public functions by name, for the Node entry and the edge
entry both. Adding, renaming or removing one fails until the list and the README agree with it.

There is also a CI job that packs the tarball, installs it somewhere else and imports every
entry both ways, including under the `edge-light` condition. `npm test` imports from `src/`, so
it can pass while the published package is unusable.

## House style

- **Zero runtime dependencies.** A test asserts it.
- **Nothing fails silently.** Every drop, refusal and no-op is a warning that names the
  consequence, printed once and rate limited.
- **Never throw into the application.** Every public method and every handler is wrapped. The
  one exception is `init()` without a key, which is a misconfiguration and throws on purpose.
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
