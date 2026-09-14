import type { Category } from './reports.js';

/**
 * HTTP response → what to do about it.
 *
 * A pure function, so the whole transport policy is testable without a socket and identical in
 * every runtime. `spec/fixtures/responses.json` is the table, and four of its rows lose data when
 * wrong: any 2xx means accepted (drop the batch), 503 means NOT stored (keep it), 429 is never
 * retried inline (hold the categories, drain later), and a redirect is never followed (it would
 * carry the write key and the body to wherever it points).
 *
 * The decision is driven by the response BODY first: the error code says *why*, where a header
 * only says *how long*. `Retry-After` and `X-RateLimit-Categories` are read when present and
 * refine the wait and the scope of a hold; the policy never depends on them being there.
 */
export type Action =
  /** Accepted, or permanently refused. Either way, forget it. */
  | 'drop'
  /** Keep it and try again later. */
  | 'retry'
  /** Too many bytes or items. Halve and resend. */
  | 'split'
  /** Pause this endpoint's categories. */
  | 'hold'
  /** Configuration is wrong. Stop sending entirely. */
  | 'shutdown'
  /** Change a setting and try once more. */
  | 'degrade';

export interface Decision {
  readonly action: Action;
  /** Seconds. 0 when not applicable or when the local schedule should decide. */
  readonly wait: number;
  /** Set when action is `degrade`. */
  readonly degrade?: 'disableGzip';
  /** `ok` for an acceptance, `redirect` for a 3xx, otherwise the server's code. */
  readonly code: string;
  /** For `hold`: the categories named by the server, when it named any. */
  readonly categories?: readonly string[];
  /** A monthly cap: surfaced to the developer once. */
  readonly billing?: boolean;
}

/**
 * The longest a monthly cap is held at a time. The server's `Retry-After` points at the next
 * month; sleeping that long would also sleep through a plan upgrade, and one refused request every
 * six hours costs nothing.
 */
export const MONTHLY_HOLD_SECONDS = 21_600;

export interface ResponseHeaders {
  /** `Retry-After`, already resolved to seconds (delta or HTTP-date). 0 when absent. */
  readonly retryAfter?: number;
  /** `X-RateLimit-Categories`, raw. */
  readonly rateLimitCategories?: string;
}

export function decide(status: number, body: unknown, headers: ResponseHeaders = {}): Decision {
  const payload = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const retryAfter = headers.retryAfter ?? 0;

  // Two 400s come from a pre-controller listener and use `message`; everything else uses `error`.
  // An SDK that reads only `error` sees an empty code and mishandles its own bad gzip.
  const code = String(payload['error'] ?? payload['message'] ?? '') || `http_${status}`;

  // Ingest answers 202. A proxy in front of it may answer 200 or 204, and resending what was
  // accepted counts it twice.
  if (status >= 200 && status < 300) return { action: 'drop', wait: 0, code: 'ok' };

  // Following a redirect re-sends the body and the write key to another location. The host is
  // misconfigured; nothing sent to it will ever land where it should.
  if (status >= 300 && status < 400) return { action: 'shutdown', wait: 0, code: 'redirect' };

  if (status === 400) {
    // Our own compression produced something the server could not inflate. Retrying in the clear
    // recovers the batch; dropping it loses data for a bug on our side.
    if (/gzip/i.test(code)) return { action: 'degrade', wait: 0, degrade: 'disableGzip', code };

    // Anything else at 400 is our payload being wrong. The same bytes will fail identically.
    return { action: 'drop', wait: 0, code };
  }

  // A bad key is a config error, not a transient one. Continuing to buffer against a key that will
  // never work is a memory leak that never drains.
  if (status === 401 || status === 403) return { action: 'shutdown', wait: 0, code };

  if (status === 413) return { action: 'split', wait: 0, code };

  if (status === 429) {
    const billing = code === 'monthly_cap_exceeded' || code === 'monthly_error_cap_exceeded';
    const named = parseRateLimitCategories(headers.rateLimitCategories);
    // A category header without its seconds part is not a zero wait.
    const serverWait = named !== null && named.seconds > 0 ? named.seconds : retryAfter;
    const wait = billing ? (serverWait > 0 ? Math.min(serverWait, MONTHLY_HOLD_SECONDS) : MONTHLY_HOLD_SECONDS) : serverWait;

    return {
      action: 'hold',
      wait,
      code,
      billing,
      ...(named !== null && named.categories.length > 0 ? { categories: named.categories } : {}),
    };
  }

  // Other 4xx: the request itself is wrong; the same bytes fail identically.
  if (status >= 400 && status < 500) return { action: 'drop', wait: 0, code };

  // THE BATCH WAS NOT STORED. An SDK that treats 503 as success loses data.
  if (status === 503) return { action: 'retry', wait: retryAfter > 0 ? retryAfter : 10, code };

  return { action: 'retry', wait: retryAfter, code };
}

/** A request that never reached the server, or never got an answer. */
export function networkFailure(): Decision {
  return { action: 'retry', wait: 0, code: 'network' };
}

/**
 * The categories a hold actually covers. It starts from what the endpoint governs; the server may
 * narrow that to the categories it names, and never widen it. A header naming nothing the endpoint
 * governs is ignored rather than trusted: a batch response must not pause error reporting.
 */
export function holdCategories(endpoint: readonly Category[], named: readonly string[] | undefined): Category[] {
  if (named === undefined || named.length === 0) return [...endpoint];
  const narrowed = endpoint.filter((category) => named.includes(category));

  return narrowed.length > 0 ? narrowed : [...endpoint];
}

/**
 * `Retry-After` is either delta-seconds or an HTTP-date. Both are legal, and a server behind a
 * CDN can produce either. Anything unparseable is 0 (use the local schedule).
 */
export function parseRetryAfter(header: string | null | undefined, now: number = Date.now()): number {
  if (header === null || header === undefined || header.trim() === '') return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);

  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.max(0, Math.ceil((at - now) / 1000));

  return 0;
}

/** `X-RateLimit-Categories: <seconds>:<cat>;<cat>`. A missing or bad seconds part is 0. */
export function parseRateLimitCategories(header: string | null | undefined): { seconds: number; categories: string[] } | null {
  if (header === null || header === undefined || header.trim() === '') return null;
  const [rawSeconds = '', rawCategories = ''] = header.split(':', 2);
  const seconds = rawSeconds.trim() === '' ? 0 : Number(rawSeconds);

  return {
    seconds: Number.isFinite(seconds) ? Math.max(0, seconds) : 0,
    categories: rawCategories.split(';').map((c) => c.trim()).filter((c) => c !== ''),
  };
}
