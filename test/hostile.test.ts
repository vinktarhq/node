import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Vinktar, type Platform } from '../src/client.js';
import { vinktarErrors, vinktarRequest } from '../src/frameworks/express.js';
import { vinktarFastify } from '../src/frameworks/fastify.js';
import { captureNestException, VinktarExceptionFilter, VinktarMiddleware } from '../src/frameworks/nest.js';
import * as sdk from '../src/index.js';
import type { ProcessLike } from '../src/node/handlers.js';
import { makeHarness, tick, type Harness } from './harness.js';

/**
 * `spec/fixtures/hostile.json`: the application is never broken by the SDK, whatever it is handed.
 *
 * Every case runs twice, against a client and against the module-level functions, and asserts the
 * same things: each step returned, nothing was thrown, and nothing rejected unhandled before the
 * client had closed. `host` entries compare a function the SDK wrapped with the same function
 * called directly. A case or a step that does not apply here is skipped by name, and the last test
 * checks those names, so nothing is skipped without this file saying so.
 */
interface Step {
  do: string;
  args?: unknown[];
  steps?: Step[];
  capability?: string;
  withinMs?: number;
  returns?: unknown;
}

interface Case {
  name: string;
  capability: 'common' | 'backend' | 'browser';
  options?: Record<string, unknown> | string;
  steps: Step[];
  host?: string[];
  expect?: {
    sent?: Array<{ endpoint: string; identify?: Record<string, unknown>; item?: Record<string, unknown> }>;
    requests?: Record<string, number>;
    logged?: { level: string; count: number };
  };
}

const { cases } = JSON.parse(readFileSync(new URL('../spec/fixtures/hostile.json', import.meta.url), 'utf8')) as { cases: Case[] };

const KEY = 'vnk_sk_hostile_0001';
const HOST_URL = 'https://app.test/orders';
const SURFACES = ['client', 'facade'] as const;
type Surface = (typeof SURFACES)[number];

// Hostile values --------------------------------------------------------------------------------

function thrower(): never {
  throw new Error('hostile value was read');
}

/** Each kind as JavaScript has it. A kind with two natural renderings runs the case once per rendering. */
const KINDS: Record<string, Array<() => unknown>> = {
  cycle: [
    () => {
      const root: Record<string, unknown> = { list: [] as unknown[], inner: { deeper: {} as Record<string, unknown> } };
      (root['inner'] as { deeper: Record<string, unknown> }).deeper['root'] = root;
      (root['list'] as unknown[]).push([root]);

      return root;
    },
  ],
  throwing_accessor: [
    () => Object.defineProperties({}, { value: { enumerable: true, get: thrower }, toJSON: { enumerable: false, get: thrower } }),
    () =>
      new Proxy(
        {},
        { get: thrower, has: thrower, ownKeys: thrower, getOwnPropertyDescriptor: thrower, getPrototypeOf: thrower, set: thrower, defineProperty: thrower },
      ),
  ],
  self_replicating: [
    () => {
      const make = (): Record<string, unknown> => ({ toJSON: () => make() });

      return make();
    },
  ],
  no_json_form: [() => ({ big: 10n, nan: Number.NaN, inf: Number.POSITIVE_INFINITY, sym: Symbol('s'), fn: () => 1 })],
  deep: [
    () => {
      let value: Record<string, unknown> = {};
      for (let i = 0; i < 20_000; i += 1) value = { child: value };

      return value;
    },
  ],
  huge: [() => 'x'.repeat(5 * 1024 * 1024)],
  bad_text: [() => 'lone \uD800 surrogate'],
  null: [() => null, () => undefined],
  integer: [() => 42],
  object: [() => ({})],
  list_of_null: [() => [null]],
};

function kindsIn(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    const kind = /^hostile\((\w+)\)$/.exec(value)?.[1];
    if (kind !== undefined) found.add(kind);
  } else if (Array.isArray(value)) for (const item of value) kindsIn(item, found);
  else if (typeof value === 'object' && value !== null) for (const item of Object.values(value)) kindsIn(item, found);

  return found;
}

function variantsOf(c: Case): number {
  return Math.max(1, ...[...kindsIn([c.options, c.steps])].map((kind) => KINDS[kind]!.length));
}

function materialise(value: unknown, variant: number): unknown {
  if (typeof value === 'string') {
    const kind = /^hostile\((\w+)\)$/.exec(value)?.[1];
    if (kind !== undefined) {
      const renderings = KINDS[kind];
      if (renderings === undefined) throw new Error(`hostile.json names a kind this test does not render: ${kind}`);

      return renderings[variant % renderings.length]!();
    }
    const error = /^error\((.*)\)$/.exec(value);
    if (error) return new Error(error[1]);
    if (value === 'rejected(handled)') {
      const rejected = Promise.reject(new Error('the caller handled this'));
      rejected.catch(() => {});

      return rejected;
    }

    return value;
  }
  if (Array.isArray(value)) return value.map((item) => materialise(item, variant));
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, materialise(item, variant)]));

  return value;
}

// The rig ---------------------------------------------------------------------------------------

class FakeProcess implements ProcessLike {
  readonly handlers = new Map<string, Array<(...args: never[]) => void>>();
  exited: number | null = null;
  readonly pid = 42;
  readonly execArgv: string[] = [];
  readonly env: Record<string, string | undefined> = {};

  on(event: string, listener: (...args: never[]) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);

    return this;
  }
  off(event: string, listener: (...args: never[]) => void): this {
    this.handlers.set(event, (this.handlers.get(event) ?? []).filter((l) => l !== listener));

    return this;
  }
  listeners(event: string): unknown[] {
    return this.handlers.get(event) ?? [];
  }
  exit(code?: number): never {
    this.exited = code ?? 0;

    return undefined as never;
  }
  kill(): void {}
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners(event)) (listener as (...a: unknown[]) => void)(...args);
  }
}

interface Rig {
  readonly harness: Harness;
  readonly logs: Array<{ level: string; message: string }>;
  readonly failures: string[];
  readonly unhandled: string[];
  /** What the application's `fetch` and `console.log` are before the SDK wraps them. */
  readonly hostFetch: ReturnType<typeof vi.fn>;
  readonly hostLog: ReturnType<typeof vi.fn>;
}

const executed = new Set<string>();
const skippedCases = new Map<string, string>();
const skippedSteps = new Set<string>();
const skippedHost = new Set<string>();

let rig: Rig;
let client: Vinktar | null = null;
let restoreGlobals: Array<() => void> = [];
const onRejection = (reason: unknown): void => void rig.unhandled.push(`unhandledRejection: ${printable(reason)}`);
const onException = (error: unknown): void => void rig.unhandled.push(`uncaughtException: ${printable(error)}`);

function printable(value: unknown): string {
  try {
    return value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  } catch {
    return 'a value that cannot be printed';
  }
}

beforeEach(() => {
  delete process.env['VINKTAR_KEY'];
  const realFetch = globalThis.fetch;
  const response = new Response('{}', { status: 200 });
  // A request to the application's own URL answers; anything else is whatever the platform does with it.
  const hostFetch = vi.fn((input: unknown, init?: unknown) => (input === HOST_URL ? Promise.resolve(response) : realFetch(input as never, init as never)));
  vi.stubGlobal('fetch', hostFetch);
  const hostLog = vi.fn(() => undefined);
  const realConsole = console;
  const previousLog = realConsole.log;
  realConsole.log = hostLog;
  restoreGlobals = [() => void (realConsole.log = previousLog)];
  rig = { harness: makeHarness(), logs: [], failures: [], unhandled: [], hostFetch, hostLog };
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);
});

afterEach(async () => {
  await sdk.close();
  await client?.close();
  client = null;
  process.off('unhandledRejection', onRejection);
  process.off('uncaughtException', onException);
  for (const restore of restoreGlobals.splice(0).reverse()) restore();
  vi.unstubAllGlobals();
});

/** Every global the SDK patches, made read-only in a way the test can undo. */
function freezeGlobals(): void {
  const frozen = Object.create(console) as Console;
  for (const level of ['debug', 'info', 'log', 'warn', 'error'] as const) Object.defineProperty(frozen, level, { value: level === 'log' ? rig.hostLog : () => {}, writable: false });
  vi.stubGlobal('console', Object.freeze(frozen));
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch')!;
  Object.defineProperty(globalThis, 'fetch', { value: rig.hostFetch, writable: false, configurable: true, enumerable: true });
  restoreGlobals.push(() => Object.defineProperty(globalThis, 'fetch', descriptor));
}

function optionsFor(c: Case, variant: number): unknown {
  if (typeof c.options === 'string') return materialise(c.options, variant);
  const { $runtime: runtime, hooks, logger, onError, transport, writeKey, ...rest } = c.options ?? {};
  const throws = (): never => {
    throw new Error('the callback threw');
  };
  const hangs = (_input: unknown, init?: { signal?: AbortSignal }): Promise<Response> =>
    new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));

  return {
    fetch: transport === 'throws' ? throws : runtime === 'unreachableHost' ? hangs : rig.harness.fetch,
    logger: logger === 'throws' ? throws : (level: string, message: string) => void rig.logs.push({ level, message }),
    autoFlush: false,
    flushIntervalMs: 60_000,
    // A server has no device of its own; with one, a bare identify() has something to link.
    initialScope: { deviceId: 'device-1' },
    ...(writeKey === null ? {} : { writeKey: typeof writeKey === 'string' ? writeKey : KEY }),
    ...(hooks === 'allThrow' ? { beforeSend: throws, beforeTrack: throws, beforeBreadcrumb: throws } : {}),
    ...(onError === 'throws' ? { onError: throws } : {}),
    ...(runtime === 'unreachableHost' ? { requestTimeoutMs: 500, shutdownTimeout: 100 } : {}),
    ...(materialise(rest, variant) as Record<string, unknown>),
  };
}

// Steps -----------------------------------------------------------------------------------------

type Callable = (...args: unknown[]) => unknown;

function applies(capability: string | undefined): boolean {
  return capability === undefined || capability === 'common' || capability === 'backend' || capability === 'js';
}

/** The function a step names: the module-level one where the facade is under test and has it. */
function lookup(surface: Surface, name: string): Callable | undefined {
  const exported = (sdk as unknown as Record<string, unknown>)[name];
  if (surface === 'facade' && typeof exported === 'function') return exported as Callable;
  const method = (client as unknown as Record<string, unknown>)[name];

  return typeof method === 'function' ? (method as Callable).bind(client) : undefined;
}

/** `setContext` takes one object here; the fixture's key and value become that object. */
function argsFor(step: Step, variant: number): unknown[] {
  const args = (step.args ?? []).map((value) => materialise(value, variant));
  if (step.do === 'setContext' && typeof args[0] === 'string') return [{ [args[0]]: args[1] }];

  return args;
}

async function attempt(label: string, step: Step, call: () => unknown): Promise<void> {
  const started = Date.now();
  let result: unknown;
  try {
    result = call();
  } catch (error) {
    rig.failures.push(`${label} threw ${printable(error)}`);

    return;
  }
  const blocked = Date.now() - started;
  if (step.withinMs !== undefined && blocked > step.withinMs) rig.failures.push(`${label} blocked for ${blocked} ms, over ${step.withinMs}`);
  if (result instanceof Promise) {
    try {
      result = await result;
    } catch (error) {
      rig.failures.push(`${label} rejected with ${printable(error)}`);

      return;
    }
  }
  if ('returns' in step) expect(result, `${label} returns`).toEqual(step.returns);
  // The argument stood in for the callback: there is nothing to run, and nothing to return.
  if (step.do === 'withScope' && step.args !== undefined) expect(result, `${label} returns`).toBeUndefined();
}

async function runSteps(surface: Surface, steps: Step[], variant: number, on?: { name: string; target: Record<string, unknown> }): Promise<void> {
  for (const step of steps) {
    if (!applies(step.capability)) continue;
    const label = `${on?.name ?? surface}.${step.do}()`;

    if (step.do === 'request' || step.do === 'requestThatThrows') {
      const error = step.do === 'requestThatThrows' ? new Error(String(step.args?.[0])) : undefined;
      for (const adapter of [throughExpress, throughFastify, throughNest]) await attempt(`${adapter.name}`, step, () => adapter(error));
      continue;
    }
    if (step.do === 'scope') {
      let handed: unknown;
      await attempt(label, step, () => (handed = lookup(surface, 'scope')!()));
      if (typeof handed === 'object' && handed !== null) await runSteps(surface, step.steps ?? [], variant, { name: 'scope', target: handed as Record<string, unknown> });
      continue;
    }
    if ((step.do === 'withScope' || step.do === 'enterScope') && step.steps !== undefined) {
      const nested = step.steps;
      await attempt(label, step, () =>
        lookup(surface, 'withScope')!(async () => {
          if (step.do === 'enterScope') lookup(surface, 'enterScope')!();
          await runSteps(surface, nested, variant);
        }),
      );
      continue;
    }

    const found = on !== undefined ? on.target[step.do] : lookup(surface, step.do);
    if (typeof found !== 'function') {
      skippedSteps.add(`${on?.name ?? 'client'}.${step.do}`);
      continue;
    }
    const fn = on !== undefined ? (found as Callable).bind(on.target) : (found as Callable);
    await attempt(label, step, () => fn(...argsFor(step, variant)));
  }
}

// Requests through each adapter -------------------------------------------------------------------

const request = () => ({ method: 'GET', url: '/orders/9?x=1', originalUrl: '/orders/9?x=1', headers: { host: 'api.test', 'x-vinktar-device-id': 'dev-1' } });

function throughExpress(appError: Error | undefined): void {
  const listeners: Array<() => void> = [];
  const res = { statusCode: 200, once: (_event: 'finish', listener: () => void) => listeners.push(listener) };
  const req = request();
  let ran = 0;
  let thrown: unknown;
  try {
    vinktarRequest({ client: client!, trackRequests: true })(req, res, () => {
      ran += 1;
      if (appError !== undefined) throw appError;
      for (const listener of listeners) listener();
    });
  } catch (error) {
    thrown = error;
  }
  expect(ran, 'express: the handler ran once').toBe(1);
  // Express catches what a handler throws one frame up; what reaches it must be the handler's own error.
  expect(thrown, 'express: what the handler threw').toBe(appError);
  if (appError === undefined) return;

  const next = vi.fn();
  vinktarErrors({ client: client! })(appError, req, res, next);
  expect(next.mock.calls, 'express: next(error)').toEqual([[appError]]);
}

function throughFastify(appError: Error | undefined): void {
  const hooks: Record<string, Callable> = {};
  const registered = vi.fn();
  vinktarFastify({ addHook: (name: string, hook: Callable) => (hooks[name] = hook) }, { client: client!, trackRequests: true }, registered);
  expect(registered.mock.calls, 'fastify: done()').toEqual([[]]);
  const req = request();
  const reply = { statusCode: appError === undefined ? 200 : 500 };
  const order = appError === undefined ? ['onRequest', 'onResponse'] : ['onRequest', 'onError', 'onResponse'];
  for (const name of order) {
    const done = vi.fn();
    if (name === 'onError') hooks[name]!(req, reply, appError, done);
    else hooks[name]!(req, reply, done);
    // A hook that passes an error to done() fails the request with it.
    expect(done.mock.calls, `fastify: ${name} done()`).toEqual([[]]);
  }
}

function throughNest(appError: Error | undefined): void {
  const req = request();
  const next = vi.fn();
  new VinktarMiddleware({ client: client! }).use(req, { statusCode: 200 }, next);
  expect(next.mock.calls, 'nest: next()').toEqual([[]]);
  if (appError === undefined) return;

  const json = vi.fn();
  const response: { json: typeof json; status: ReturnType<typeof vi.fn> } = { json, status: vi.fn(() => response) };
  const http = { getType: () => 'http', switchToHttp: () => ({ getRequest: () => req as never, getResponse: () => response as never }) };
  new VinktarExceptionFilter({ client: client! }).catch(appError, http);
  expect(response.status.mock.calls, 'nest: the status Nest would send').toEqual([[500]]);
  expect(json.mock.calls, 'nest: the body Nest would send').toEqual([[{ statusCode: 500, message: 'Internal server error' }]]);

  // Another transport expects its exception back, and a host that cannot be read changes nothing.
  const rpc = { getType: () => 'rpc', switchToHttp: thrower };
  expect(() => new VinktarExceptionFilter({ client: client! }).catch(appError, rpc)).toThrow(appError);
  expect(() => captureNestException(appError, { switchToHttp: thrower }, { client: client! })).not.toThrow();
}

// Host functions ----------------------------------------------------------------------------------

interface Outcome {
  how: 'returned' | 'threw' | 'resolved' | 'rejected';
  value: unknown;
}

async function outcome(call: () => unknown): Promise<Outcome> {
  let value: unknown;
  try {
    value = call();
  } catch (error) {
    return { how: 'threw', value: error };
  }
  if (!(value instanceof Promise)) return { how: 'returned', value };

  return value.then(
    (resolved): Outcome => ({ how: 'resolved', value: resolved }),
    (error: unknown): Outcome => ({ how: 'rejected', value: error }),
  );
}

/** The wrapped call against the same call on the original: same way out, same value, original called once. */
async function same(label: string, original: ReturnType<typeof vi.fn>, wrapped: Callable, thisArg: unknown, args: unknown[]): Promise<void> {
  const expected = await outcome(() => (original as unknown as Callable).apply(thisArg, args));
  original.mockClear();
  const actual = await outcome(() => wrapped.apply(thisArg, args));
  expect(actual.how, `${label}: how it ended`).toBe(expected.how);
  if (expected.value instanceof Error) {
    expect((actual.value as Error).constructor, `${label}: error type`).toBe(expected.value.constructor);
    expect((actual.value as Error).message, `${label}: error message`).toBe(expected.value.message);
  } else expect(actual.value, `${label}: value`).toBe(expected.value);
  expect(original.mock.calls, `${label}: the original was called once, with what the caller passed`).toHaveLength(1);
  expect(original.mock.calls[0], `${label}: argument count`).toHaveLength(args.length);
  args.forEach((arg, index) => expect(original.mock.calls[0]![index], `${label}: argument ${index}`).toBe(arg));
  expect(original.mock.contexts[0], `${label}: this`).toBe(thisArg);
}

async function checkHost(entry: string, variant: number, fake: FakeProcess | null, hostListener: ReturnType<typeof vi.fn>): Promise<void> {
  const fetchNow = globalThis.fetch as unknown as Callable;
  if (entry === 'fetch') {
    await same('fetch', rig.hostFetch, fetchNow, undefined, [HOST_URL, { method: 'POST', body: 'a=1' }]);
  } else if (entry === 'fetch(invalid)') {
    const invalid: unknown[][] = [[undefined], [null], [HOST_URL, { method: 5 }], [42], [KINDS['throwing_accessor']![variant % 2]!()], [HOST_URL, KINDS['throwing_accessor']![1]!()]];
    for (const [index, args] of invalid.entries()) await same(`fetch(invalid ${index})`, rig.hostFetch, fetchNow, undefined, args);
  } else if (entry === 'console') {
    const cyclic = KINDS['cycle']![0]!();
    rig.hostLog.mockImplementation(() => 'what the host console returns');
    await same('console.log', rig.hostLog, console.log as Callable, console, ['checkout', cyclic, KINDS['throwing_accessor']![variant % 2]!()]);
    rig.hostLog.mockImplementation(() => {
      throw new Error('the host console threw');
    });
    await same('console.log that throws', rig.hostLog, console.log as Callable, console, ['again']);
    rig.hostLog.mockImplementation(() => undefined);
  } else if (entry === 'errorHandler(levels)') {
    // The application listens for uncaught exceptions and nothing else. It hears each one once, as
    // it would without the SDK, is never called for a rejection, and still decides what the process does.
    if (fake === null) return void skippedHost.add(`${entry}: the module-level client hooks the real process`);
    fake.emit('unhandledRejection', new Error('rejected'), Promise.resolve());
    expect(hostListener.mock.calls, 'a rejection does not reach the exception listener').toHaveLength(0);
    const fatal = new Error('fatal');
    fake.emit('uncaughtException', fatal, 'uncaughtException');
    await tick(20);
    expect(hostListener.mock.calls, 'the exception listener').toEqual([[fatal, 'uncaughtException']]);
    expect(fake.exited, 'the process was left to the application').toBeNull();
  } else {
    // XMLHttpRequest and the History API belong to a page.
    skippedHost.add(entry);
  }
}

// The cases ---------------------------------------------------------------------------------------

describe('fixtures/hostile.json', () => {
  for (const c of cases) {
    if (c.capability === 'browser') {
      skippedCases.set(c.name, 'browser only');
      it.skip(`${c.name} (browser only)`, () => {});
      continue;
    }

    for (const surface of SURFACES) {
      for (let variant = 0; variant < variantsOf(c); variant += 1) {
        it(`${c.name} [${surface}${variantsOf(c) > 1 ? `, rendering ${variant + 1}` : ''}]`, async () => {
          const runtime = typeof c.options === 'object' ? c.options['$runtime'] : undefined;
          if (runtime === 'frozenGlobals') freezeGlobals();

          const wantsHandler = (c.host ?? []).includes('errorHandler(levels)');
          const fake = wantsHandler && surface === 'client' ? new FakeProcess() : null;
          const hostListener = vi.fn();
          fake?.on('uncaughtException', hostListener as never);

          const options = optionsFor(c, variant);
          try {
            if (surface === 'facade') client = sdk.init(options as never);
            else {
              const platform: Platform = fake === null ? sdk.nodePlatform : { ...sdk.nodePlatform, process: fake };
              client = new Vinktar((fake === null ? options : { ...(options as object), captureErrors: true }) as never, platform);
            }
          } catch (error) {
            rig.failures.push(`init threw ${printable(error)}`);
          }
          expect(rig.failures).toEqual([]);

          await runSteps(surface, c.steps, variant);
          for (const entry of c.host ?? []) await checkHost(entry, variant, fake, hostListener);
          if (runtime === 'frozenGlobals') {
            const said = rig.logs.filter((line) => /cannot be patched/.test(line.message)).map((line) => line.message);
            expect(said.some((line) => line.includes('fetch')), 'fetch was skipped out loud').toBe(true);
            expect(said.some((line) => line.includes('console')), 'console was skipped out loud').toBe(true);
          }

          const closed = await outcome(() => (surface === 'facade' ? sdk.close() : client!.close()));
          expect(closed.how, 'close()').toBe('resolved');
          // A rejection nobody handled is reported after the microtasks drain, not before.
          await tick(20);

          expect(rig.failures).toEqual([]);
          expect(rig.unhandled).toEqual([]);

          const carrying = rig.harness.requests.filter((r) => ['batch', 'identify', 'errors'].some((key) => Array.isArray(r.body[key]) && (r.body[key] as unknown[]).length > 0));
          for (const [endpoint, count] of Object.entries(c.expect?.requests ?? {})) {
            expect(carrying.filter((r) => new URL(r.url).pathname === endpoint), `requests to ${endpoint}`).toHaveLength(count);
          }
          for (const match of c.expect?.sent ?? []) {
            const list = match.identify !== undefined ? rig.harness.identifies() : match.endpoint === '/v1/errors' ? rig.harness.errors() : rig.harness.batches();
            expect(list, `sent ${JSON.stringify(match)}`).toContainEqual(expect.objectContaining(match.identify ?? match.item ?? {}));
          }
          if (c.expect?.logged !== undefined) {
            expect(rig.logs.filter((line) => line.level === c.expect!.logged!.level), `lines at ${c.expect.logged.level}`).toHaveLength(c.expect.logged.count);
          }
          executed.add(c.name);
        });
      }
    }
  }

  afterAll(() => {
    expect(cases).toHaveLength(28);
    expect(executed.size, 'cases that ran').toBe(27);
    expect([...skippedCases]).toEqual([['a key the SDK refuses: inert, logged once, never thrown', 'browser only']]);
    // Every method the fixture names exists here.
    expect([...skippedSteps]).toEqual([]);
    expect([...skippedHost].sort()).toEqual(['errorHandler(levels): the module-level client hooks the real process', 'history', 'xhr', 'xhr(invalid)']);
  });
});

// What the fixture cannot say in JSON ---------------------------------------------------------------

describe('the same rule, where only this runtime can break it', () => {
  const make = (options: Record<string, unknown> = {}, platform: Platform = sdk.nodePlatform): Vinktar => {
    client = new Vinktar({ writeKey: KEY, fetch: rig.harness.fetch, autoFlush: false, logger: (level: string, message: string) => void rig.logs.push({ level, message }), ...options } as never, platform);

    return client;
  };

  it('constructs when the working directory, the hostname and the environment cannot be read', () => {
    const environment = { env: thrower, hostname: thrower, cwd: thrower };
    expect(() => make({}, { ...sdk.nodePlatform, environment })).not.toThrow();
    expect(() => make({ asyncLocalStorage: thrower })).not.toThrow();
    expect(() => client!.withScope(() => client!.track('still_scoped'))).not.toThrow();
  });

  it('reads headers that throw, and reports an internal failure that cannot be printed', () => {
    const errors: unknown[] = [];
    make({ onError: (error: unknown) => errors.push(error), beforeTrack: () => {
      throw Object.create(null);
    } });
    expect(client!.scopeFromHeaders({ get: thrower } as never)).toBe(client!.scope());
    expect(() => client!.track('dropped')).not.toThrow();
    expect(() => client!.captureException(Object.create(null))).not.toThrow();
  });

  it('resolves flushIfServerless when the platform refuses the promise', async () => {
    make();
    client!.track('queued');
    await expect(client!.flushIfServerless({ context: { waitUntil: thrower } })).resolves.toBeUndefined();
    await expect(client!.flushIfServerless({ context: KINDS['throwing_accessor']![1]!() as never })).resolves.toBeUndefined();
    expect(rig.harness.batches()).toHaveLength(1);
  });

  it('keeps a response that finishes when the request cannot be tracked', () => {
    make();
    const listeners: Array<() => void> = [];
    const req = { ...request(), get route(): never {
      return thrower();
    } };
    const next = vi.fn();
    vinktarRequest({ client: client!, trackRequests: true })(req, { statusCode: 200, once: (_event: 'finish', listener: () => void) => listeners.push(listener) }, next);
    expect(next.mock.calls).toEqual([[]]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => listeners.forEach((listener) => listener())).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('hands on when the adapter was given options and a request that are not what it expects', () => {
    make();
    for (const options of [null, 42, { client: {} }, { client }, KINDS['throwing_accessor']![1]!()]) {
      const next = vi.fn();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vinktarRequest(options as never)(null as never, null as never, next);
      vinktarErrors(options as never)(new Error('app'), null as never, null as never, next);
      new VinktarMiddleware(options as never).use(null as never, null as never, next);
      expect(next.mock.calls).toHaveLength(3);
      expect(next.mock.calls[1]![0]).toEqual(new Error('app'));
      const done = vi.fn();
      vinktarFastify({ addHook: thrower }, options as never, done);
      expect(done.mock.calls).toEqual([[]]);
      warn.mockRestore();
    }
  });

  it('prints a second uncaught exception that arrives while the first is being flushed', async () => {
    const fake = new FakeProcess();
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
    make({ captureErrors: true, breadcrumbs: false }, { ...sdk.nodePlatform, process: fake });
    const second = new Error('second');
    fake.emit('uncaughtException', new Error('first'), 'uncaughtException');
    fake.emit('uncaughtException', second, 'uncaughtException');
    expect(printed).toHaveBeenCalledWith(second);
    await tick(20);
    printed.mockRestore();
  });
});
