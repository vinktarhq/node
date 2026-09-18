import { validUserId } from '../core/blocked.js';
import { Breadcrumbs, toBreadcrumb, type Breadcrumb } from '../core/breadcrumbs.js';
import { attempt, isObject, safeString, show } from '../core/guard.js';
import { copyPlain, type Props } from '../core/normalize.js';
import type { RequestInfo } from '../types.js';

/**
 * Who and what an event belongs to, on a server that handles many people at once.
 *
 * A `Scope` holds everything that belongs to one unit of work: the identity (user, device,
 * session), tags, error context, the request, the breadcrumb trail, and the properties registered
 * for analytics. Nothing a request or job sets lives anywhere else, so nothing it sets can reach
 * another request or job. What is configured once for the whole service (`superProperties`,
 * `initialScope` tags and context) lives on the client.
 *
 * Scopes are stored per async context, and per client: two clients in one process never see each
 * other's scope. `fork()` is for nesting (a child inherits a copy of its parent). `detached()` is for
 * a boundary: a new request or job carries what was set for the whole process (tags, context and
 * properties set outside any request, at startup) and never an actor, a request or breadcrumbs.
 *
 * A scope is handed to the application (`scope()`, `withScope`, `enterScope`), so its methods are
 * public entry points like the client's: an argument of the wrong type is refused with a warning,
 * and nothing a value does when it is read (a getter that throws, a Proxy) leaves the method.
 * What is stored is whatever the application passed, cycles included; copying it for a child is
 * bounded (`copyPlain`), and it is normalised when it is sent.
 */
export interface ScopeSeed {
  readonly userId?: string;
  readonly deviceId?: string;
  readonly sessionId?: string;
  readonly tags?: Record<string, string>;
  readonly context?: Props;
}

/** What a fresh scope, or a reset one, starts from: never an identity. */
export interface ScopeDefaults {
  readonly tags?: Record<string, string>;
  readonly context?: Props;
}

export class Scope {
  userId: string | undefined;
  deviceId: string | undefined;
  sessionId: string | undefined;
  tags: Record<string, string> = {};
  context: Props = {};
  /** Registered with `register()`: sent on this scope's analytics events, never on errors. */
  properties: Props = {};
  request: RequestInfo | undefined;
  readonly breadcrumbs: Breadcrumbs;

  constructor(
    private readonly maxBreadcrumbs: number,
    seed?: ScopeSeed,
    /** Where a refused argument is said. The client passes its logger; a scope made by hand is quiet. */
    private readonly warn: (message: string) => void = () => {},
  ) {
    this.breadcrumbs = new Breadcrumbs(maxBreadcrumbs);
    if (seed !== undefined) this.apply(seed);
  }

  /** A scope with configured defaults and nothing else: the start of a request or job. */
  static fresh(maxBreadcrumbs: number, defaults: ScopeDefaults = {}): Scope {
    return new Scope(maxBreadcrumbs, { ...(defaults.tags ? { tags: defaults.tags } : {}), ...(defaults.context ? { context: defaults.context } : {}) });
  }

  apply(seed: ScopeSeed): void {
    this.guard('apply', () => {
      if (!isObject(seed)) return;
      if (typeof seed.userId === 'string') this.userId = seed.userId;
      if (typeof seed.deviceId === 'string') this.deviceId = seed.deviceId;
      if (typeof seed.sessionId === 'string') this.sessionId = seed.sessionId;
      if (isObject(seed.tags)) this.setTags(seed.tags as Record<string, string>);
      if (isObject(seed.context)) Object.assign(this.context, copyPlain(seed.context));
    });
  }

  setTag(key: string, value: string): void {
    this.guard('setTag', () => {
      if (typeof key !== 'string' || key === '') return this.refuse('setTag', 'a key', key);
      this.tags[key] = safeString(value);
    });
  }

  setTags(tags: Record<string, string>): void {
    this.guard('setTags', () => {
      if (!isObject(tags)) return this.refuse('setTags', 'an object of tags', tags);
      for (const key of Object.keys(tags)) this.setTag(key, tags[key] as string);
    });
  }

  /** Merge into the error context; `null` clears it. */
  setContext(context: Props | null): void {
    this.guard('setContext', () => {
      if (context === null) this.context = {};
      else if (isObject(context)) Object.assign(this.context, context);
      else this.refuse('setContext', 'an object or null', context);
    });
  }

  /** `undefined` clears the user only. The device and everything else stay; see `reset()` for the rest. */
  setUser(userId: string | undefined): void {
    this.guard('setUser', () => {
      const id = userId === undefined || userId === null ? undefined : validUserId(userId);
      if (id === null) return this.refuse('setUser', 'a usable user id', userId);
      this.userId = id;
    });
  }

  setRequest(request: RequestInfo | undefined): void {
    this.request = isObject(request) ? request : undefined;
  }

  addBreadcrumb(crumb: Partial<Breadcrumb>): void {
    this.guard('addBreadcrumb', () => {
      const shaped = toBreadcrumb(crumb, Date.now);
      if (shaped !== null) this.breadcrumbs.add(shaped);
    });
  }

  register(properties: Props): void {
    this.guard('register', () => {
      if (!isObject(properties)) return this.refuse('register', 'an object of properties', properties);
      Object.assign(this.properties, properties);
    });
  }

  registerOnce(properties: Props): void {
    this.guard('registerOnce', () => {
      if (!isObject(properties)) return this.refuse('registerOnce', 'an object of properties', properties);
      for (const key of Object.keys(properties)) if (!(key in this.properties)) this.properties[key] = properties[key];
    });
  }

  unregister(key: string): void {
    if (typeof key === 'string') delete this.properties[key];
    else this.refuse('unregister', 'a property name', key);
  }

  /**
   * A copy for a nested context. Plain nested values are copied too, so a child that changes
   * `context.order.total` does not change its parent's.
   */
  fork(): Scope {
    const child = new Scope(this.maxBreadcrumbs, { tags: this.tags, context: this.context }, this.warn);
    child.userId = this.userId;
    child.deviceId = this.deviceId;
    child.sessionId = this.sessionId;
    child.request = this.request;
    child.properties = copyPlain(this.properties);
    for (const crumb of this.breadcrumbs.list()) child.breadcrumbs.add(crumb);

    return child;
  }

  /**
   * A new scope for a request or job: this scope's tags, context and registered properties, copied,
   * and nothing that identifies anyone or belongs to earlier work.
   */
  detached(): Scope {
    const scope = new Scope(this.maxBreadcrumbs, { tags: this.tags, context: this.context }, this.warn);
    scope.properties = copyPlain(this.properties);

    return scope;
  }

  /** Everything cleared, registered properties included, then the configured defaults applied. */
  reset(defaults: ScopeDefaults = {}): void {
    this.userId = undefined;
    this.deviceId = undefined;
    this.sessionId = undefined;
    this.tags = {};
    this.context = {};
    this.properties = {};
    this.request = undefined;
    this.breadcrumbs.clear();
    this.apply({ ...(isObject(defaults?.tags) ? { tags: defaults.tags } : {}), ...(isObject(defaults?.context) ? { context: defaults.context } : {}) });
  }

  private guard(method: string, work: () => void): void {
    attempt(work, undefined, (error) => this.warn(`scope.${method}() was given a value that could not be read, and ignored it: ${safeString(error)}`));
  }

  private refuse(method: string, wanted: string, got: unknown): void {
    this.warn(`scope.${method}() needs ${wanted}, not ${show(got)}; nothing was set`);
  }
}

/** Where the current scope lives. */
export interface ScopeStore {
  current(): Scope;
  run<T>(scope: Scope, fn: () => T): T;
  enter(scope: Scope): void;
  /** False where concurrent async work shares one scope. */
  readonly isolated: boolean;
}

export type AsyncLocalStorageLike = { getStore(): Scope | undefined; run<T>(store: Scope, fn: () => T): T; enterWith(store: Scope): void };

/** A scope store over an `AsyncLocalStorage` that belongs to one client and nothing else. */
export function asyncScopeStore(storage: AsyncLocalStorageLike, root: Scope): ScopeStore {
  return {
    current: () => storage.getStore() ?? root,
    run: (scope, fn) => storage.run(scope, fn),
    enter: (scope) => storage.enterWith(scope),
    isolated: true,
  };
}

/**
 * The fallback for a runtime without async context. It is correct for synchronous work and for
 * async work that does not overlap. Overlapping async work shares whichever scope was entered
 * last, which is all such a runtime can offer, so `onOverlap` is told the first time it happens.
 * A scope whose work has finished is never made current again.
 */
export function stackScopeStore(root: Scope, onOverlap: () => void = () => {}): ScopeStore {
  const active: Scope[] = [];
  let entered: Scope | undefined;
  let pending = 0;

  const current = (): Scope => active[active.length - 1] ?? entered ?? root;
  const leave = (scope: Scope): void => {
    const index = active.lastIndexOf(scope);
    if (index !== -1) active.splice(index, 1);
  };

  return {
    current,
    run: (scope, fn) => {
      if (pending > 0) onOverlap();
      active.push(scope);
      let result: unknown;
      try {
        result = fn();
      } catch (error) {
        leave(scope);
        throw error;
      }
      if (isThenable(result)) {
        pending += 1;
        const settled = (): void => {
          pending -= 1;
          leave(scope);
        };

        // The same value or the same rejection, once the scope has been left.
        return result.then(
          (value) => {
            settled();

            return value;
          },
          (error: unknown) => {
            settled();
            throw error;
          },
        ) as ReturnType<typeof fn>;
      }
      leave(scope);

      return result as ReturnType<typeof fn>;
    },
    enter: (scope) => {
      entered = scope;
    },
    isolated: false,
  };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  try {
    return typeof (value as PromiseLike<unknown> | undefined)?.then === 'function';
  } catch {
    return false;
  }
}
