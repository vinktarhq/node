import { Breadcrumbs, type Breadcrumb } from '../core/breadcrumbs.js';
import type { Props } from '../core/normalize.js';
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
  ) {
    this.breadcrumbs = new Breadcrumbs(maxBreadcrumbs);
    if (seed !== undefined) this.apply(seed);
  }

  /** A scope with configured defaults and nothing else: the start of a request or job. */
  static fresh(maxBreadcrumbs: number, defaults: ScopeDefaults = {}): Scope {
    return new Scope(maxBreadcrumbs, { ...(defaults.tags ? { tags: defaults.tags } : {}), ...(defaults.context ? { context: defaults.context } : {}) });
  }

  apply(seed: ScopeSeed): void {
    if (seed.userId !== undefined) this.userId = seed.userId;
    if (seed.deviceId !== undefined) this.deviceId = seed.deviceId;
    if (seed.sessionId !== undefined) this.sessionId = seed.sessionId;
    if (seed.tags !== undefined) Object.assign(this.tags, seed.tags);
    if (seed.context !== undefined) Object.assign(this.context, copy(seed.context));
  }

  setTag(key: string, value: string): void {
    if (typeof key === 'string' && key !== '') this.tags[key] = String(value);
  }

  setTags(tags: Record<string, string>): void {
    if (typeof tags === 'object' && tags !== null) for (const [key, value] of Object.entries(tags)) this.setTag(key, value);
  }

  /** Merge into the error context; `null` clears it. */
  setContext(context: Props | null): void {
    if (context === null) this.context = {};
    else if (typeof context === 'object') Object.assign(this.context, context);
  }

  /** Clears the user only. The device and everything else stay; see `reset()` for the rest. */
  setUser(userId: string | undefined): void {
    this.userId = userId;
  }

  setRequest(request: RequestInfo | undefined): void {
    this.request = request;
  }

  addBreadcrumb(crumb: Breadcrumb): void {
    this.breadcrumbs.add(crumb);
  }

  register(properties: Props): void {
    Object.assign(this.properties, properties);
  }

  registerOnce(properties: Props): void {
    for (const [key, value] of Object.entries(properties)) if (!(key in this.properties)) this.properties[key] = value;
  }

  unregister(key: string): void {
    delete this.properties[key];
  }

  /**
   * A copy for a nested context. Plain nested values are copied too, so a child that changes
   * `context.order.total` does not change its parent's.
   */
  fork(): Scope {
    const child = new Scope(this.maxBreadcrumbs, { tags: this.tags, context: this.context });
    child.userId = this.userId;
    child.deviceId = this.deviceId;
    child.sessionId = this.sessionId;
    child.request = this.request;
    child.properties = copy(this.properties);
    for (const crumb of this.breadcrumbs.list()) child.breadcrumbs.add(crumb);

    return child;
  }

  /**
   * A new scope for a request or job: this scope's tags, context and registered properties, copied,
   * and nothing that identifies anyone or belongs to earlier work.
   */
  detached(): Scope {
    const scope = new Scope(this.maxBreadcrumbs, { tags: this.tags, context: this.context });
    scope.properties = copy(this.properties);

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
    if (defaults.tags !== undefined) Object.assign(this.tags, defaults.tags);
    if (defaults.context !== undefined) Object.assign(this.context, copy(defaults.context));
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
      if (typeof (result as Promise<unknown>)?.then === 'function') {
        pending += 1;

        return (result as Promise<unknown>).finally(() => {
          pending -= 1;
          leave(scope);
        }) as ReturnType<typeof fn>;
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

/** A copy of plain objects and arrays, all the way down; anything else is kept by reference. */
function copy<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copy) as T;
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, copy(inner)])) as T;
  }

  return value;
}
