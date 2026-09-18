import type { Vinktar } from '../client.js';
import { clientFor, describeRequest, markCaptured, quietly, wasCaptured, type MinimalRequest, type MinimalResponse } from './shared.js';

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
    const client = clientFor(options);
    if (client === null) {
      next();

      return;
    }
    // A fresh scope per request: nothing from an earlier request, or from code outside any request,
    // is inherited. `next()` runs inside it whatever happens to the lines before it, and what the
    // application throws from there is the application's.
    client.isolate((scope) => {
      quietly('vinktarRequest()', () => {
        client.scopeFromHeaders(req.headers);
        const info = describeRequest(req);
        scope.setRequest(info);
        scope.setTag('http.method', info.method ?? 'GET');
        const started = Date.now();
        // A listener on the application's response: what it throws would surface inside `res.end()`.
        res.once?.('finish', () =>
          quietly('vinktarRequest()', () => {
            const route = `${req.baseUrl ?? ''}${req.route?.path ?? req.path ?? ''}` || info.url?.split('?')[0] || '/';
            scope.setTag('route', route);
            if (options.trackRequests) {
              // `finish` fires from the socket, outside the request's async context: put the scope back.
              client.within(scope, () =>
                client.track('$request', { $route: route, $method: info.method ?? 'GET', $status: res.statusCode, $duration_ms: Date.now() - started }),
              );
            }
          }),
        );
      });
      next();
    });
  };
}

export function vinktarErrors(options: ErrorOptions = {}) {
  return function vinktarErrorMiddleware(error: unknown, req: ExpressRequest, res: MinimalResponse, next: Next): void {
    quietly('vinktarErrors()', () => {
      const client = clientFor(options);
      const status = statusOf(error, res);
      if (client === null || wasCaptured(error) || status < (options.minimumStatus ?? 500)) return;
      markCaptured(error);
      // In a child scope, so an app without vinktarRequest() does not write this request into the
      // process-wide root scope.
      client.withScope((scope) => {
        client.scopeFromHeaders(req.headers);
        scope.setRequest(describeRequest(req));
        client.captureException(error, { handled: false, context: { $response_status: status } });
      });
    });
    // Always, and always the application's error.
    next(error);
  };
}

function statusOf(error: unknown, res: MinimalResponse): number {
  const candidate = (error as { status?: unknown; statusCode?: unknown })?.status ?? (error as { statusCode?: unknown })?.statusCode;
  if (typeof candidate === 'number' && candidate >= 400) return candidate;

  return res.statusCode >= 400 ? res.statusCode : 500;
}
