import { Scope } from './node/scope.js';
import type { Platform, Vinktar } from './client.js';
import { Vinktar as Client } from './client.js';
import type { VinktarOptions } from './options.js';
import type { WaitUntilContext } from './node/serverless.js';
import type { Breadcrumb, CaptureContext, EventOptions, IdentifyOptions, Props, SourceReader, Traits, User } from './types.js';

/**
 * The module-level facade: one default client per process, and a function per method.
 *
 * No buffer before `init()` on a server. A call before init is a programming error that a
 * warning surfaces on the first run, where a buffer would hide it and replay stale events with
 * the wrong scope later. `withScope` is the one exception: the work still runs, on a throwaway
 * scope, because the callback is the application's code and must not be skipped.
 *
 * The default client is held on `globalThis`, so an application that ends up loading both the
 * CommonJS and the ES module build of this package (a dependency requires one, the app imports
 * the other) still has one client, not two that each think they are the only one.
 */
export interface Facade {
  init(options?: VinktarOptions | string): Vinktar;
  getClient(): Vinktar | null;
  track(name: string, properties?: Props, options?: EventOptions): void;
  page(name?: string, properties?: Props, options?: EventOptions): void;
  identify(userId: string, traits?: Traits, traitsOnce?: Traits, options?: IdentifyOptions): void;
  setTraits(traits: Traits, traitsOnce?: Traits): void;
  setTraitsOnce(traits: Traits): void;
  unsetTraits(keys: string[]): void;
  setUser(user: User | null): void;
  reset(): void;
  register(properties: Props): void;
  registerOnce(properties: Props): void;
  unregister(key: string): void;
  captureException(error: unknown, hint?: CaptureContext): string;
  captureMessage(message: string, hint?: CaptureContext): string;
  addBreadcrumb(crumb: Partial<Breadcrumb>): void;
  setTag(key: string, value: string): void;
  setTags(tags: Record<string, string>): void;
  setContext(context: Props | null): void;
  scope(): Scope;
  withScope<T>(work: (scope: Scope) => T): T;
  enterScope(): Scope;
  scopeFromHeaders(headers: Record<string, string | string[] | undefined> | Headers | undefined): Scope;
  registerHandlers(): void;
  setSourceReader(reader: SourceReader): void;
  flush(): Promise<boolean>;
  flushIfServerless(options?: { context?: WaitUntilContext | undefined; timeoutMs?: number }): Promise<void>;
  close(): Promise<boolean>;
}

interface State {
  client: Vinktar | null;
}

export function createFacade(platform: Platform, warn: (message: string) => void): Facade {
  const key = Symbol.for(`vinktar.${platform.name}.facade`);
  const holder = globalThis as unknown as Record<symbol, State | undefined>;
  const state = (holder[key] ??= { client: null });

  const need = (method: string): Vinktar | null => {
    if (state.client === null) warn(`${method}() was called before init(); nothing happened`);

    return state.client;
  };

  return {
    init(options = {}) {
      if (state.client !== null) {
        warn('init() was called twice; the first client is kept');

        return state.client;
      }
      state.client = new Client(options, platform);

      return state.client;
    },
    getClient: () => state.client,
    track: (name, properties, options) => need('track')?.track(name, properties, options),
    page: (name, properties, options) => need('page')?.page(name, properties, options),
    identify: (userId, traits, traitsOnce, options) => need('identify')?.identify(userId, traits, traitsOnce, options),
    setTraits: (traits, traitsOnce) => need('setTraits')?.setTraits(traits, traitsOnce),
    setTraitsOnce: (traits) => need('setTraitsOnce')?.setTraitsOnce(traits),
    unsetTraits: (keys) => need('unsetTraits')?.unsetTraits(keys),
    setUser: (user) => need('setUser')?.setUser(user),
    reset: () => need('reset')?.reset(),
    register: (properties) => need('register')?.register(properties),
    registerOnce: (properties) => need('registerOnce')?.registerOnce(properties),
    unregister: (key) => need('unregister')?.unregister(key),
    captureException: (error, hint) => need('captureException')?.captureException(error, hint) ?? '',
    captureMessage: (message, hint) => need('captureMessage')?.captureMessage(message, hint) ?? '',
    addBreadcrumb: (crumb) => need('addBreadcrumb')?.addBreadcrumb(crumb),
    setTag: (key, value) => need('setTag')?.setTag(key, value),
    setTags: (tags) => need('setTags')?.setTags(tags),
    setContext: (context) => need('setContext')?.setContext(context),
    scope: () => need('scope')?.scope() ?? new Scope(0),
    withScope: (work) => (state.client !== null ? state.client.withScope(work) : work(new Scope(0))),
    enterScope: () => need('enterScope')?.enterScope() ?? new Scope(0),
    scopeFromHeaders: (headers) => need('scopeFromHeaders')?.scopeFromHeaders(headers) ?? new Scope(0),
    registerHandlers: () => need('registerHandlers')?.registerHandlers(),
    setSourceReader: (reader) => need('setSourceReader')?.setSourceReader(reader),
    flush: () => state.client?.flush() ?? Promise.resolve(true),
    flushIfServerless: (options) => state.client?.flushIfServerless(options) ?? Promise.resolve(),
    close: () => {
      const current = state.client;
      state.client = null;

      return current?.close() ?? Promise.resolve(true);
    },
  };
}
