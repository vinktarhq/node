import type { Vinktar } from '../client.js';
import { getClient } from '../index.js';
import { describeRequest, markCaptured, wasCaptured, type MinimalRequest, type MinimalResponse } from './shared.js';

/**
 * NestJS, without depending on it: a middleware class for the request scope, and an exception
 * filter that reports and then answers exactly as Nest's own filter would. Both are plain classes
 * with the shapes Nest expects:
 *
 *     const { httpAdapter } = app.get(HttpAdapterHost);
 *     app.use(new VinktarMiddleware().use);
 *     app.useGlobalFilters(new VinktarExceptionFilter({ httpAdapter }));
 *
 * A filter cannot hand an exception on by rethrowing it: Nest does not pass it to its default
 * filter, the platform's last-resort handler answers instead (an HTML 500 on Express), and the
 * JSON body clients expect is gone. So this filter writes Nest's default response itself, through
 * the `httpAdapter` when given (identical on every platform), or directly to an Express or Fastify
 * response otherwise. An application with its own filter extending `BaseExceptionFilter` calls
 * `captureNestException(exception, host)` from it instead.
 */
export interface NestOptions {
  readonly client?: Vinktar;
  readonly minimumStatus?: number;
  /** `app.get(HttpAdapterHost).httpAdapter`: replies exactly as Nest's own filter does, on any platform. */
  readonly httpAdapter?: { reply(response: unknown, body: unknown, statusCode?: number): unknown; isHeadersSent?(response: unknown): boolean };
}

type Next = (error?: unknown) => void;

export class VinktarMiddleware {
  constructor(private readonly options: NestOptions = {}) {
    this.use = this.use.bind(this);
  }

  use(req: MinimalRequest, _res: MinimalResponse, next: Next): void {
    const client = this.options.client ?? getClient();
    if (client !== null) {
      // A fresh scope per request: nothing from an earlier request is inherited.
      const scope = client.enterScope();
      client.scopeFromHeaders(req.headers);
      const info = describeRequest(req);
      scope.setRequest(info);
      scope.setTag('http.method', info.method ?? 'GET');
    }
    next();
  }
}

export interface ArgumentsHostLike {
  getType?(): string;
  switchToHttp(): { getRequest<T = MinimalRequest>(): T; getResponse<T = unknown>(): T };
}

/** Report an exception the way the filter does, for use inside an application's own filter. */
export function captureNestException(exception: unknown, host: ArgumentsHostLike, options: NestOptions = {}): void {
  const client = options.client ?? getClient();
  const status = statusOf(exception);
  if (client === null || wasCaptured(exception) || status < (options.minimumStatus ?? 500)) return;
  markCaptured(exception);
  // In a child scope, so the request is never written into the process-wide root scope.
  client.withScope((scope) => {
    if (isHttp(host)) {
      try {
        const req = host.switchToHttp().getRequest<MinimalRequest>();
        client.scopeFromHeaders(req.headers);
        scope.setRequest(describeRequest(req));
      } catch {
        // No request to describe; report without it.
      }
    }
    client.captureException(exception, { handled: false, context: { $response_status: status } });
  });
}

export class VinktarExceptionFilter {
  constructor(private readonly options: NestOptions = {}) {}

  catch(exception: unknown, host: ArgumentsHostLike): void {
    captureNestException(exception, host, this.options);

    // Not HTTP (microservices, websockets): those transports expect the exception back.
    if (!isHttp(host)) throw exception;

    const response = host.switchToHttp().getResponse<Record<string, unknown>>();
    const { status, body } = defaultResponse(exception);
    const adapter = this.options.httpAdapter;
    if (adapter !== undefined) {
      if (adapter.isHeadersSent?.(response) === true) return;
      adapter.reply(response, body, status);

      return;
    }
    if (response['headersSent'] === true || response['sent'] === true) return;
    if (typeof response['status'] === 'function' && typeof response['json'] === 'function') {
      (response['status'] as (code: number) => { json(body: unknown): unknown })(status).json(body);

      return;
    }
    if (typeof response['code'] === 'function' && typeof response['send'] === 'function') {
      (response['code'] as (code: number) => { send(body: unknown): unknown })(status).send(body);

      return;
    }
    // A platform this does not recognise: hand it back rather than leave the request hanging.
    throw exception;
  }
}

function isHttp(host: ArgumentsHostLike): boolean {
  return typeof host.getType !== 'function' || host.getType() === 'http';
}

/** What Nest's `BaseExceptionFilter` sends: an HttpException's own response, or a generic 500. */
function defaultResponse(exception: unknown): { status: number; body: unknown } {
  const http = exception as { getStatus?: () => unknown; getResponse?: () => unknown };
  if (typeof http?.getStatus === 'function' && typeof http.getResponse === 'function') {
    try {
      const status = http.getStatus();
      const response = http.getResponse();
      if (typeof status === 'number') {
        return { status, body: typeof response === 'object' && response !== null ? response : { statusCode: status, message: response } };
      }
    } catch {
      // Fall through to the generic answer.
    }
  }

  return { status: 500, body: { statusCode: 500, message: 'Internal server error' } };
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
