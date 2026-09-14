import type { Vinktar } from '../client.js';
import { getClient } from '../index.js';
import { describeRequest, markCaptured, wasCaptured, type MinimalRequest, type MinimalResponse } from './shared.js';

/**
 * Express, structurally typed so the package depends on nothing.
 *
 *     app.use(vinktarRequest());           // first: one scope per request
 *     …routes…
 *     app.use(vinktarErrors());            // last: reports, then always calls next(error)
 */
export interface RequestOptions {
  readonly client?: Vinktar;
  /** Emit a `$request` event per response, with route, method, status and duration. Off: it is a line on a bill. */
  readonly trackRequests?: boolean;
}

export interface ErrorOptions {
  readonly client?: Vinktar;
  /** Report only errors that map to at least this status. Default 500. */
  readonly minimumStatus?: number;
}

type Next = (error?: unknown) => void;
type ExpressRequest = MinimalRequest & { route?: { path?: string }; baseUrl?: string; path?: string; originalUrl?: string };

export function vinktarRequest(options: RequestOptions = {}) {
  return function vinktarRequestMiddleware(req: ExpressRequest, res: MinimalResponse, next: Next): void {
    const client = options.client ?? getClient();
    if (client === null) {
      next();

      return;
    }
    // A fresh scope per request: nothing from an earlier request, or from code outside any request,
    // is inherited.
    client.isolate((scope) => {
      client.scopeFromHeaders(req.headers);
      const info = describeRequest(req);
      scope.setRequest(info);
      scope.setTag('http.method', info.method ?? 'GET');
      const started = Date.now();
      res.once?.('finish', () => {
        const route = `${req.baseUrl ?? ''}${req.route?.path ?? req.path ?? ''}` || info.url?.split('?')[0] || '/';
        scope.setTag('route', route);
        if (options.trackRequests) {
          // `finish` fires from the socket, outside the request's async context: put the scope back.
          client.within(scope, () =>
            client.track('$request', { $route: route, $method: info.method ?? 'GET', $status: res.statusCode, $duration_ms: Date.now() - started }),
          );
        }
      });
      next();
    });
  };
}

export function vinktarErrors(options: ErrorOptions = {}) {
  const minimum = options.minimumStatus ?? 500;

  return function vinktarErrorMiddleware(error: unknown, req: ExpressRequest, res: MinimalResponse, next: Next): void {
    const client = options.client ?? getClient();
    if (client !== null && !wasCaptured(error) && statusOf(error, res) >= minimum) {
      markCaptured(error);
      // In a child scope, so an app without vinktarRequest() does not write this request into the
      // process-wide root scope.
      client.withScope((scope) => {
        client.scopeFromHeaders(req.headers);
        scope.setRequest(describeRequest(req));
        client.captureException(error, { handled: false, context: { $response_status: statusOf(error, res) } });
      });
    }
    next(error);
  };
}

function statusOf(error: unknown, res: MinimalResponse): number {
  const candidate = (error as { status?: unknown; statusCode?: unknown })?.status ?? (error as { statusCode?: unknown })?.statusCode;
  if (typeof candidate === 'number' && candidate >= 400) return candidate;

  return res.statusCode >= 400 ? res.statusCode : 500;
}
