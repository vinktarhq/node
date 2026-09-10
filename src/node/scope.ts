import { Breadcrumbs, type Breadcrumb } from '../core/breadcrumbs.js';
import type { Props } from '../core/normalize.js';
import type { RequestInfo } from '../types.js';

/**
 * Who and what an event belongs to, on a server that handles many people at once.
 *
 * A `Scope` holds the identity (user, device, session), tags, context, the request, and the
 * breadcrumb trail for one unit of work. Scopes are stored per async context, so an error thrown
 * deep inside a request handler finds the user that request set, and a breadcrumb logged while
 * serving request A never appears on an error from request B.
 *
 * `run()` forks by value: the child starts as a copy of its parent and changes made inside stay
 * inside. `enter()` is for frameworks whose hooks return instead of wrapping (Fastify, Nest), and
 * binds the scope to the current async context from here onwards.
 */
export interface ScopeSeed {
  readonly userId?: string;
  readonly deviceId?: string;
  readonly sessionId?: string;
  readonly tags?: Record<string, string>;
  readonly context?: Props;
}

export class Scope {
  userId: string | undefined;
  deviceId: string | undefined;
  sessionId: string | undefined;
  tags: Record<string, string> = {};
  context: Props = {};
  request: RequestInfo | undefined;
  readonly breadcrumbs: Breadcrumbs;

  constructor(maxBreadcrumbs: number, seed?: ScopeSeed) {
    this.breadcrumbs = new Breadcrumbs(maxBreadcrumbs);
    if (seed !== undefined) this.apply(seed);
  }

  apply(seed: ScopeSeed): void {
    if (seed.userId !== undefined) this.userId = seed.userId;
    if (seed.deviceId !== undefined) this.deviceId = seed.deviceId;
    if (seed.sessionId !== undefined) this.sessionId = seed.sessionId;
    if (seed.tags !== undefined) Object.assign(this.tags, seed.tags);
    if (seed.context !== undefined) Object.assign(this.context, seed.context);
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

  setUser(userId: string | undefined): void {
    this.userId = userId;
  }

  setRequest(request: RequestInfo | undefined): void {
    this.request = request;
  }

  addBreadcrumb(crumb: Breadcrumb): void {
    this.breadcrumbs.add(crumb);
  }

  /** A copy, breadcrumbs included, for a child context. */
  fork(): Scope {
    const child = new Scope(this.breadcrumbs['max'], { tags: this.tags, context: this.context });
    child.userId = this.userId;
    child.deviceId = this.deviceId;
    child.sessionId = this.sessionId;
    child.request = this.request;
    for (const crumb of this.breadcrumbs.list()) child.breadcrumbs.add(crumb);

    return child;
  }

  /** Back to the seed: identity, tags, context, crumbs all cleared. */
  reset(seed: ScopeSeed): void {
    this.userId = undefined;
    this.deviceId = undefined;
    this.sessionId = undefined;
    this.tags = {};
    this.context = {};
    this.request = undefined;
    this.breadcrumbs.clear();
    this.apply(seed);
  }
}

/** Where the current scope lives: `AsyncLocalStorage` on Node, a plain stack where there is none. */
export interface ScopeStore {
  current(): Scope;
  run<T>(scope: Scope, fn: () => T): T;
  enter(scope: Scope): void;
}

/** A scope store over any `AsyncLocalStorage`-shaped object. */
export function asyncScopeStore(
  storage: { getStore(): Scope | undefined; run<T>(store: Scope, fn: () => T): T; enterWith(store: Scope): void },
  root: Scope,
): ScopeStore {
  return {
    current: () => storage.getStore() ?? root,
    run: (scope, fn) => storage.run(scope, fn),
    enter: (scope) => storage.enterWith(scope),
  };
}

/**
 * The fallback for runtimes without async context: a single current scope. `run()` swaps it for
 * the synchronous part of `fn` and for the rest of a returned promise; concurrent async work
 * shares one scope, which is what such a runtime offers.
 */
export function stackScopeStore(root: Scope): ScopeStore {
  let current = root;

  return {
    current: () => current,
    run: (scope, fn) => {
      const previous = current;
      current = scope;
      let result: unknown;
      try {
        result = fn();
      } catch (error) {
        current = previous;
        throw error;
      }
      if (typeof (result as Promise<unknown>)?.then === 'function') {
        return (result as Promise<unknown>).finally(() => {
          current = previous;
        }) as ReturnType<typeof fn>;
      }
      current = previous;

      return result as ReturnType<typeof fn>;
    },
    enter: (scope) => {
      current = scope;
    },
  };
}
