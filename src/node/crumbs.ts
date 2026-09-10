import type { Breadcrumb } from '../core/breadcrumbs.js';
import { truncateToBytes } from '../core/bytes.js';
import type { Logger } from '../core/logger.js';

/**
 * Where breadcrumbs come from on a server: the console and outbound `fetch`.
 *
 * Both patches are undone by `close()`, and neither observes the SDK itself: console output
 * written while the logger is active is skipped (`isReentrant`), and requests to the ingest host
 * are skipped by URL. Network crumbs carry method, URL, status and duration only, never a body
 * or a header, and the URL loses its query unless PII is allowed.
 */
export interface CrumbOptions {
  readonly console: boolean;
  readonly http: boolean;
  readonly sendDefaultPii: boolean;
  readonly ingestHost: string;
  readonly add: (crumb: Partial<Breadcrumb>) => void;
  readonly logger: Logger;
}

const LEVELS = ['debug', 'info', 'log', 'warn', 'error'] as const;
const TAG = '__vinktar_patched__';

export function installCrumbSources(options: CrumbOptions): () => void {
  const restores: Array<() => void> = [];

  if (options.console) {
    const target = console as unknown as Record<string, (...args: unknown[]) => void>;
    for (const level of LEVELS) {
      const original = target[level];
      if (typeof original !== 'function' || (original as unknown as Record<string, unknown>)[TAG] === true) continue;
      const patched = function (this: unknown, ...args: unknown[]): void {
        if (!options.logger.isReentrant) {
          try {
            options.add({
              category: 'console',
              level: level === 'warn' ? 'warning' : level === 'error' ? 'error' : level === 'debug' ? 'debug' : 'info',
              message: formatArgs(args),
            });
          } catch {
            // A breadcrumb must never break console.log.
          }
        }
        original.apply(this, args);
      };
      Object.defineProperty(patched, TAG, { value: true });
      target[level] = patched;
      restores.push(() => {
        if (target[level] === patched) target[level] = original;
      });
    }
  }

  if (options.http) {
    const g = globalThis as { fetch?: typeof fetch };
    const original = g.fetch;
    if (typeof original === 'function' && (original as unknown as Record<string, unknown>)[TAG] !== true) {
      const patched = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (typeof url !== 'string' || url.startsWith(options.ingestHost)) return original.call(this, input, init);
        const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
        const shown = stripUrl(url, options.sendDefaultPii);
        const started = Date.now();
        const done = (status: number | string): void =>
          options.add({
            category: 'http',
            message: `${method} ${shown}`,
            data: { method, url: shown, status, duration_ms: Date.now() - started },
            ...(typeof status === 'number' && status >= 400 ? { level: 'error' as const } : {}),
          });

        return original.call(this, input, init).then(
          (response) => {
            done(response.status);

            return response;
          },
          (error: unknown) => {
            done('error');
            throw error;
          },
        );
      } as typeof fetch;
      Object.defineProperty(patched, TAG, { value: true });
      g.fetch = patched;
      restores.push(() => {
        if (g.fetch === patched) g.fetch = original;
      });
    }
  }

  return () => {
    for (const restore of restores.splice(0)) restore();
  };
}

export function formatArgs(args: readonly unknown[]): string {
  const parts: string[] = [];
  for (const arg of args.slice(0, 8)) {
    if (typeof arg === 'string') parts.push(arg);
    else if (arg instanceof Error) parts.push(`${arg.name}: ${arg.message}`);
    else if (typeof arg === 'object' && arg !== null) {
      try {
        parts.push(truncateToBytes(JSON.stringify(arg) ?? '[object]', 256));
      } catch {
        parts.push('[object]');
      }
    } else parts.push(String(arg));
  }

  return parts.join(' ');
}

export function stripUrl(url: string, sendDefaultPii: boolean): string {
  if (sendDefaultPii) return url;
  try {
    const parsed = new URL(url);

    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split('?')[0] ?? url;
  }
}
