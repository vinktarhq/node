import type { Breadcrumb } from '../core/breadcrumbs.js';
import { truncateToBytes } from '../core/bytes.js';
import { safeString } from '../core/guard.js';
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

  /**
   * Put `patched` where `original` was. A global that refuses (a frozen `console`, a read-only
   * `fetch` in a hardened runtime) is left alone and said out loud; the patches made before it stay.
   */
  const replace = (owner: Record<string, unknown>, name: string, label: string, original: unknown, patched: unknown): void => {
    try {
      Object.defineProperty(patched, TAG, { value: true });
      owner[name] = patched;
    } catch {
      options.logger.warn(`${label} cannot be patched here (it is frozen or read-only), so it leaves no breadcrumbs`);

      return;
    }
    restores.push(() => {
      if (owner[name] === patched) owner[name] = original;
    });
  };

  if (options.console) {
    const target = console as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const level of LEVELS) {
      const original = target[level];
      if (typeof original !== 'function' || (original as unknown as Record<string, unknown>)[TAG] === true) continue;
      const patched = function (this: unknown, ...args: unknown[]): unknown {
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

        return original.apply(this, args);
      };
      replace(target, level, `console.${level}`, original, patched);
    }
  }

  if (options.http) {
    const g = globalThis as unknown as Record<string, unknown>;
    const original = g['fetch'] as ((...args: unknown[]) => unknown) | undefined;
    if (typeof original === 'function' && (original as unknown as Record<string, unknown>)[TAG] !== true) {
      /**
       * Transparent: the original gets the caller's own arguments, once, and fails the way it
       * always did. `fetch(undefined)` is a rejected promise in every runtime and must stay one
       * here, not become a `TypeError` thrown from reading `undefined.url`, so everything the SDK
       * does around the call is in a `try` of its own. The caller gets the original's promise with
       * the breadcrumb attached: same value, same rejection, and still theirs to leave unhandled.
       */
      const patched = function (this: unknown, ...args: unknown[]): unknown {
        let done: ((status: number | string) => void) | undefined;
        try {
          done = observe(args[0], args[1], options);
        } catch {
          // Not a request this can describe. It goes through unobserved.
        }
        const result = original.apply(this, args);
        if (done === undefined || !isThenable(result)) return result;
        const finish = done;

        return result.then(
          (response) => {
            finish(statusOf(response));

            return response;
          },
          (error: unknown) => {
            finish('error');
            throw error;
          },
        );
      };
      replace(g, 'fetch', 'fetch', original, patched);
    }
  }

  return () => {
    for (const restore of restores.splice(0)) {
      try {
        restore();
      } catch {
        // Made read-only since it was patched. The wrapper stays, and stays transparent.
      }
    }
  };
}

/** Starts the clock for one outbound request and returns what records its breadcrumb, or nothing for the SDK's own. */
function observe(input: unknown, init: unknown, options: CrumbOptions): ((status: number | string) => void) | undefined {
  const request = typeof input === 'object' && input !== null ? (input as { url?: unknown; href?: unknown; method?: unknown }) : undefined;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : request?.url;
  if (typeof url !== 'string' || url.startsWith(options.ingestHost)) return undefined;
  const given = (init as { method?: unknown } | null | undefined)?.method ?? request?.method;
  const method = typeof given === 'string' ? given.toUpperCase() : 'GET';
  const shown = stripUrl(url, options.sendDefaultPii);
  const started = Date.now();

  return (status) => {
    try {
      options.add({
        category: 'http',
        message: `${method} ${shown}`,
        data: { method, url: shown, status, duration_ms: Date.now() - started },
        ...(typeof status === 'number' && status >= 400 ? { level: 'error' as const } : {}),
      });
    } catch {
      // A breadcrumb must never reach the request it describes.
    }
  };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  try {
    return typeof (value as PromiseLike<unknown> | null | undefined)?.then === 'function';
  } catch {
    return false;
  }
}

function statusOf(response: unknown): number | string {
  try {
    const status = (response as { status?: unknown } | null | undefined)?.status;

    return typeof status === 'number' ? status : 'unknown';
  } catch {
    return 'unknown';
  }
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
    } else parts.push(safeString(arg));
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
