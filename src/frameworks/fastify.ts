import type { Vinktar } from '../client.js';
import { getClient } from '../index.js';
import { describeRequest, markCaptured, wasCaptured, type MinimalRequest } from './shared.js';

/**
 * Fastify, as a plugin whose hooks return rather than wrap, so it uses `enterScope()`.
 *
 *     app.register(vinktarFastify, { trackRequests: true });
 *
 * The plugin skips Fastify's encapsulation (`Symbol.for('skip-override')`) so the hooks apply to
 * every route regardless of where it is registered.
 */
export interface FastifyOptions {
  readonly client?: Vinktar;
  readonly trackRequests?: boolean;
  readonly minimumStatus?: number;
}

interface FastifyLike {
  addHook(name: 'onRequest', hook: (request: FastifyRequest, reply: FastifyReply, done: () => void) => void): unknown;
  addHook(name: 'onError', hook: (request: FastifyRequest, reply: FastifyReply, error: unknown, done: () => void) => void): unknown;
  addHook(name: 'onResponse', hook: (request: FastifyRequest, reply: FastifyReply, done: () => void) => void): unknown;
}

type FastifyRequest = MinimalRequest & { routeOptions?: { url?: string }; routerPath?: string };
interface FastifyReply {
  statusCode: number;
  elapsedTime?: number;
}

/**
 * The first parameter is typed loosely on purpose: Fastify's own instance type is far richer than
 * the three hooks used here, and a narrower structural type would make `app.register(vinktarFastify)`
 * fail to compile against the real one.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function vinktarFastify(instance: any, options: FastifyOptions = {}, done?: (error?: Error) => void): void {
  const app = instance as FastifyLike;
  const minimum = options.minimumStatus ?? 500;
  const started = new WeakMap<object, number>();

  app.addHook('onRequest', (request, _reply, next) => {
    const client = options.client ?? getClient();
    if (client !== null) {
      const scope = client.enterScope();
      client.scopeFromHeaders(request.headers);
      const info = describeRequest(request);
      scope.setRequest(info);
      scope.setTag('http.method', info.method ?? 'GET');
      started.set(request, Date.now());
    }
    next();
  });

  app.addHook('onError', (request, reply, error, next) => {
    const client = options.client ?? getClient();
    if (client !== null && !wasCaptured(error) && reply.statusCode >= minimum) {
      markCaptured(error);
      client.captureException(error, { handled: false, context: { $response_status: reply.statusCode } });
    }
    next();
  });

  app.addHook('onResponse', (request, reply, next) => {
    const client = options.client ?? getClient();
    if (client !== null) {
      const route = request.routeOptions?.url ?? request.routerPath ?? request.url?.split('?')[0] ?? '/';
      client.scope().setTag('route', route);
      if (options.trackRequests) {
        const from = started.get(request);
        client.track('$request', {
          $route: route,
          $method: (request.method ?? 'GET').toUpperCase(),
          $status: reply.statusCode,
          $duration_ms: from !== undefined ? Date.now() - from : Math.round(reply.elapsedTime ?? 0),
        });
      }
    }
    next();
  });

  done?.();
}

// Fastify reads this symbol to apply the plugin at the root rather than in an encapsulated child.
(vinktarFastify as unknown as Record<symbol, boolean>)[Symbol.for('skip-override')] = true;
