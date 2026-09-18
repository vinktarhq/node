import type { Vinktar } from '../client.js';
import { safeString } from '../core/guard.js';
import { getClient } from '../index.js';
import type { RequestInfo } from '../types.js';

/**
 * What the three adapters have in common: the request shape they read, the mark that stops the
 * same error being reported by two layers (a route's error handler and then the global one), and
 * the rule every hook follows.
 *
 * The rule: a hook always hands on. Whatever the SDK does inside one runs through `quietly`, so a
 * request the SDK cannot describe, or a client that fails, costs the request its breadcrumbs and
 * never its response; and an error hook hands on the application's error, never one of the SDK's.
 */
export interface MinimalRequest {
  method?: string;
  url?: string;
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
  protocol?: string;
  hostname?: string;
}

export interface MinimalResponse {
  statusCode: number;
  once?(event: 'finish', listener: () => void): unknown;
}

/** The client a hook should use, or null: the one in its options, else the one `init()` made. */
export function clientFor(options: { readonly client?: Vinktar } | null | undefined): Vinktar | null {
  try {
    const client = options?.client ?? getClient();

    return typeof client?.isolate === 'function' ? client : null;
  } catch {
    return null;
  }
}

/** Run the SDK's part of a hook. What it throws is printed and goes no further. */
export function quietly(hook: string, work: () => void): void {
  try {
    work();
  } catch (error) {
    try {
      console.warn(`[vinktar] ${hook} failed and the request went on without it`, safeString(error));
    } catch {
      // No console to say it on.
    }
  }
}

const captured = new WeakSet<object>();
/** Also on the error itself, so a second copy of this package in the same process sees the mark. */
const MARK = Symbol.for('vinktar.captured');

export function markCaptured(error: unknown): void {
  if (typeof error !== 'object' || error === null) return;
  captured.add(error);
  try {
    Object.defineProperty(error, MARK, { value: true, enumerable: false, configurable: true });
  } catch {
    // A frozen error: the WeakSet still covers this copy.
  }
}

export function wasCaptured(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (captured.has(error) || (error as Record<symbol, unknown>)[MARK] === true);
}

export function describeRequest(req: MinimalRequest): RequestInfo {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(typeof req.headers === 'object' && req.headers !== null ? req.headers : {})) {
    if (typeof value === 'string') headers[key] = value;
    else if (Array.isArray(value) && typeof value[0] === 'string') headers[key] = value[0];
  }
  const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
  const path = text(req.originalUrl) ?? text(req.url) ?? '/';
  const host = headers['host'] ?? text(req.hostname) ?? '';
  const protocol = text(req.protocol) ?? headers['x-forwarded-proto'] ?? 'http';
  const url = host !== '' ? `${protocol}://${host}${path}` : path;
  const query = path.includes('?') ? path.slice(path.indexOf('?') + 1) : undefined;

  return {
    ...(typeof req.method === 'string' ? { method: req.method } : {}),
    url,
    headers,
    ...(query !== undefined ? { query } : {}),
  };
}
