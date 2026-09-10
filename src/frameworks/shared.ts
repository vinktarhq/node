import type { RequestInfo } from '../types.js';

/**
 * What the three adapters have in common: the request shape they read, and the mark that stops
 * the same error being reported by two layers (a route's error handler and then the global one).
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

const captured = new WeakSet<object>();

export function markCaptured(error: unknown): void {
  if (typeof error === 'object' && error !== null) captured.add(error);
}

export function wasCaptured(error: unknown): boolean {
  return typeof error === 'object' && error !== null && captured.has(error);
}

export function describeRequest(req: MinimalRequest): RequestInfo {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers ?? {})) {
    if (typeof value === 'string') headers[key] = value;
    else if (Array.isArray(value) && typeof value[0] === 'string') headers[key] = value[0];
  }
  const path = req.originalUrl ?? req.url ?? '/';
  const host = headers['host'] ?? req.hostname ?? '';
  const protocol = req.protocol ?? (headers['x-forwarded-proto'] ?? 'http');
  const url = host !== '' ? `${protocol}://${host}${path}` : path;
  const query = path.includes('?') ? path.slice(path.indexOf('?') + 1) : undefined;

  return {
    ...(req.method !== undefined ? { method: req.method } : {}),
    url,
    headers,
    ...(query !== undefined ? { query } : {}),
  };
}
