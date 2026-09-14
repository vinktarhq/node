import type { Platform } from './client.js';
import { createFacade } from './facade.js';
import { detectRuntime } from './node/context.js';
import { asyncScopeStore, stackScopeStore, type AsyncLocalStorageLike } from './node/scope.js';

/**
 * The edge entry: Cloudflare Workers, Vercel Edge, Deno Deploy, Next.js middleware and anything
 * else that runs a handler per request with no process and no background.
 *
 * Nothing here imports a `node:` module. Compression is `CompressionStream`. The scope store is an
 * `AsyncLocalStorage` of this client's own: the one passed as `asyncLocalStorage` to `init()`, or
 * the runtime's global one where it exposes it (Vercel Edge does). Cloudflare Workers expose it
 * only through `import { AsyncLocalStorage } from 'node:async_hooks'` with the `nodejs_als` or
 * `nodejs_compat` flag, so pass it in there. Without one, concurrent requests share a scope; the
 * SDK says so once, the first time it sees them overlap. **Sends are deferred**: nothing goes out
 * until `flush()` or `flushIfServerless()` asks, because a request the runtime finds running after
 * the handler returned is a request it will kill.
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

function asyncLocalStorage(ctor: (new () => AsyncLocalStorageLike) | undefined): AsyncLocalStorageLike | null {
  const found = ctor ?? (globalThis as { AsyncLocalStorage?: new () => AsyncLocalStorageLike }).AsyncLocalStorage;
  if (typeof found !== 'function') return null;
  try {
    return new found();
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

export const edgePlatform: Platform = {
  name: 'edge',
  runtime: detectRuntime(),
  environment: { env, hostname: () => '', cwd: () => '' },
  compress,
  scopeStore: (root, options) => {
    const storage = asyncLocalStorage(options.asyncLocalStorage);

    return storage !== null ? asyncScopeStore(storage, root) : stackScopeStore(root, options.onOverlap);
  },
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
export const enterScope = facade.enterScope;
export const scopeFromHeaders = facade.scopeFromHeaders;
export const registerHandlers = facade.registerHandlers;
export const setSourceReader = facade.setSourceReader;
export const flush = facade.flush;
/** Flush through the platform's `waitUntil` when there is one, inline when there is not. */
export const flushIfServerless = facade.flushIfServerless;
export const close = facade.close;
