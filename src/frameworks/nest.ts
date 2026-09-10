import type { Vinktar } from '../client.js';
import { getClient } from '../index.js';
import { describeRequest, markCaptured, wasCaptured, type MinimalRequest, type MinimalResponse } from './shared.js';

/**
 * NestJS, without depending on it: a middleware class for the scope and an exception filter that
 * reports and rethrows. Both are plain classes with the shapes Nest expects, so they can be
 * registered with `app.use(new VinktarMiddleware().use)` or through a module, and
 * `app.useGlobalFilters(new VinktarExceptionFilter())`.
 */
export interface NestOptions {
  readonly client?: Vinktar;
  readonly minimumStatus?: number;
}

type Next = (error?: unknown) => void;

export class VinktarMiddleware {
  constructor(private readonly options: NestOptions = {}) {
    this.use = this.use.bind(this);
  }

  use(req: MinimalRequest, _res: MinimalResponse, next: Next): void {
    const client = this.options.client ?? getClient();
    if (client !== null) {
      const scope = client.enterScope();
      client.scopeFromHeaders(req.headers);
      const info = describeRequest(req);
      scope.setRequest(info);
      scope.setTag('http.method', info.method ?? 'GET');
    }
    next();
  }
}

interface ArgumentsHostLike {
  switchToHttp(): { getRequest<T = MinimalRequest>(): T; getResponse<T = MinimalResponse>(): T };
}

export class VinktarExceptionFilter {
  private readonly minimum: number;

  constructor(private readonly options: NestOptions = {}) {
    this.minimum = options.minimumStatus ?? 500;
  }

  catch(exception: unknown, host: ArgumentsHostLike): never {
    const client = this.options.client ?? getClient();
    const status = statusOf(exception);
    if (client !== null && !wasCaptured(exception) && status >= this.minimum) {
      markCaptured(exception);
      try {
        const req = host.switchToHttp().getRequest<MinimalRequest>();
        client.scopeFromHeaders(req.headers);
        client.scope().setRequest(describeRequest(req));
      } catch {
        // Not an HTTP context; report without the request.
      }
      client.captureException(exception, { handled: false, context: { $response_status: status } });
    }
    // Rethrown, so Nest's own filters (and its default response) still run.
    throw exception;
  }
}

function statusOf(exception: unknown): number {
  const getStatus = (exception as { getStatus?: () => number })?.getStatus;
  if (typeof getStatus === 'function') {
    try {
      const status = getStatus.call(exception);
      if (typeof status === 'number') return status;
    } catch {
      // Fall through.
    }
  }
  const status = (exception as { status?: unknown; statusCode?: unknown })?.status ?? (exception as { statusCode?: unknown })?.statusCode;

  return typeof status === 'number' ? status : 500;
}
