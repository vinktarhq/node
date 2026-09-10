import type { Platform } from './client.js';
import { createFacade } from './facade.js';
import { detectRuntime } from './node/context.js';
import { asyncScopeStore, Scope, stackScopeStore } from './node/scope.js';
import type { WaitUntilContext } from './node/serverless.js';

/**
 * The edge entry: Cloudflare Workers, Vercel Edge, Deno Deploy, Next.js middleware and anything
 * else that runs a handler per request with no process and no background.
 *
 * Nothing here imports a `node:` module. Compression is `CompressionStream`; the scope store is
 * `AsyncLocalStorage` when the runtime exposes one (Workers do, behind a flag; Vercel Edge does)
 * and a plain stack otherwise; and **sends are deferred**: nothing goes out until `flush()` or
 * `flushIfServerless()` asks, because a request the runtime finds running after the handler
 * returned is a request it will kill.
 *
 *     export default {
 *       async fetch(request, env, ctx) {
 *         const response = await handle(request);
 *         await vinktar.flushIfServerless({ context: ctx });   // hands the flush to ctx.waitUntil
 *         return response;
 *       },
 *     };
 */
export { Vinktar } from './client.js';
export { Scope } from './node/scope.js';
export { VERSION, LIB } from './version.js';
export type { VinktarOptions } from './options.js';
export type {
  Breadcrumb, CaptureContext, CrumbHook, EventHook, EventOptions, Frame, IdentifyOptions, Level, LogLevel, LogSink, Props,
  RequestInfo, SourceReader, Traits, User, WireException,
} from './types.js';
export type { WaitUntilContext } from './node/serverless.js';

type Als = { getStore(): Scope | undefined; run<T>(store: Scope, fn: () => T): T; enterWith(store: Scope): void };

function asyncLocalStorage(): Als | null {
  const ctor = (globalThis as { AsyncLocalStorage?: new () => Als }).AsyncLocalStorage;
  if (typeof ctor !== 'function') return null;
  try {
    return new ctor();
  } catch {
    return null;
  }
}

function env(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;

  return proc?.env?.[name];
}

async function compress(text: string): Promise<Uint8Array | null> {
  if (typeof CompressionStream !== 'function') return null;
  try {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));

    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

const als = asyncLocalStorage();

export const edgePlatform: Platform = {
  name: 'edge',
  runtime: detectRuntime(),
  environment: { env, hostname: () => '', cwd: () => '' },
  compress,
  scopeStore: (root) => (als !== null ? asyncScopeStore(als, root) : stackScopeStore(root)),
  deferred: true,
};

const facade = createFacade(edgePlatform, (message) => console.warn(`[vinktar] ${message}`));

export const init = facade.init;
export const getClient = facade.getClient;
export const track = facade.track;
export const page = facade.page;
export const identify = facade.identify;
export const setTraits = facade.setTraits;
export const setTraitsOnce = facade.setTraitsOnce;
export const unsetTraits = facade.unsetTraits;
export const setUser = facade.setUser;
export const reset = facade.reset;
export const register = facade.register;
export const registerOnce = facade.registerOnce;
export const unregister = facade.unregister;
export const captureException = facade.captureException;
export const captureMessage = facade.captureMessage;
export const addBreadcrumb = facade.addBreadcrumb;
export const setTag = facade.setTag;
export const setTags = facade.setTags;
export const setContext = facade.setContext;
export const scope = facade.scope;
export const withScope = facade.withScope;
export const scopeFromHeaders = facade.scopeFromHeaders;
export const registerHandlers = facade.registerHandlers;
export const setSourceReader = facade.setSourceReader;
export const flush = facade.flush;
export const close = facade.close;

/** Flush through the platform's `waitUntil` when there is one, inline when there is not. */
export function flushIfServerless(options: { context?: WaitUntilContext | undefined; timeoutMs?: number } = {}): Promise<void> {
  return facade.getClient()?.flushIfServerless(options) ?? Promise.resolve();
}
