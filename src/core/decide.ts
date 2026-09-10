/**
 * HTTP response → what to do about it.
 *
 * A pure function, so the whole transport policy is testable without a socket and identical in
 * every runtime. `spec/fixtures/responses.json` is the table, and three of its rows lose data when
 * wrong: 202 means durably stored (drop the batch), 503 means NOT stored (keep it), and 429 is
 * never retried inline (hold the categories, drain later).
 *
 * The decision is driven by the response BODY first: the error code says *why*, where a header
 * only says *how long*. `Retry-After` and `X-RateLimit-Categories` are read when present and
 * refine the wait and the scope of a hold; the policy never depends on them being there.
 */
export type Action =
  /** Durably queued, or permanently rejected. Either way, forget it. */
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
  readonly code: string;
  /** For `hold`: the categories named by the server, when it named any. */
  readonly categories?: readonly string[];
  /** A monthly cap: hold for hours and tell the developer, do not sleep on the header. */
  readonly billing?: boolean;
}

/** Retrying before the month rolls over cannot succeed, so it gets hours rather than seconds. */
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

  if (status === 202) return { action: 'drop', wait: 0, code: 'ok' };

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

    return {
      action: 'hold',
      wait: billing ? MONTHLY_HOLD_SECONDS : Math.max(0, named?.seconds ?? retryAfter),
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

/** `X-RateLimit-Categories: <seconds>:<cat>;<cat>` */
export function parseRateLimitCategories(header: string | null | undefined): { seconds: number; categories: string[] } | null {
  if (header === null || header === undefined || header.trim() === '') return null;
  const [rawSeconds = '', rawCategories = ''] = header.split(':', 2);
  const seconds = Number(rawSeconds);

  return {
    seconds: Number.isFinite(seconds) ? Math.max(0, seconds) : 0,
    categories: rawCategories.split(';').map((c) => c.trim()).filter((c) => c !== ''),
  };
}
