import { byteLength } from '../core/bytes.js';
import { parseRetryAfter } from '../core/decide.js';
import type { Delivery, Outbound, SendOptions, Transport } from '../core/dispatcher.js';
import type { Logger } from '../core/logger.js';
import { parseJson } from '../core/normalize.js';
import { LIB, VERSION } from '../version.js';

/**
 * HTTP for a server or an edge runtime, over whatever `fetch` the platform provides.
 *
 * What the platform makes necessary:
 *
 *   - **One deadline covers the whole send**: compression, the request, and reading the body. It
 *     is the SDK's own, raced against each step rather than delegated to an `AbortSignal`, because
 *     an injected `fetch` (a proxy wrapper, a test double) may ignore the signal, and a response
 *     that sends its headers and then stalls must not hold a flush past its bound. A send that
 *     runs out of time is a failure, even if the server may have stored it; `event_id` makes the
 *     resend safe.
 *   - **Redirects are never followed.** Native `fetch` follows them and re-sends the body and the
 *     `X-Vinktar-Key` header to wherever `Location` points, which is a key leak. A 3xx is reported
 *     as it is, and the dispatcher stops on it.
 *   - **The response body is always consumed or cancelled.** Cloudflare Workers require it, and a
 *     leaked body on Node keeps a socket from returning to the pool.
 *   - **A connection reset on a reused socket gets one retry.** Keep-alive sockets go stale while a
 *     serverless instance is frozen, and the first request after a thaw fails with ECONNRESET. The
 *     retry is safe because every item carries an `event_id` the server dedupes on.
 */
export interface NodeTransportOptions {
  readonly host: string;
  readonly writeKey: string;
  readonly timeoutMs: number;
  readonly logger: Logger;
  readonly fetch: typeof fetch | undefined;
  /** gzip the text, or null to send it uncompressed. */
  readonly compress: ((text: string) => Promise<Uint8Array | null>) | undefined;
  /** Timers that must not keep a process alive. */
  readonly unref?: boolean;
}

export const GZIP_THRESHOLD_BYTES = 1024;

const TIMED_OUT = Symbol('timed out');

export class NodeTransport implements Transport {
  constructor(private readonly options: NodeTransportOptions) {}

  async send(out: Outbound, { gzip }: SendOptions): Promise<Delivery> {
    const fetchFn = this.options.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (typeof fetchFn !== 'function') {
      this.options.logger.error('no fetch is available in this runtime; pass { fetch } to init()');

      return { status: 0, body: null };
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        controller?.abort(new Error('vinktar: request timed out'));
        resolve(TIMED_OUT);
      }, this.options.timeoutMs);
      if (this.options.unref !== false) (timer as { unref?: () => void }).unref?.();
    });

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Vinktar-Key': this.options.writeKey,
        'User-Agent': `${LIB}/${VERSION}`,
      };
      let body: string | Uint8Array = out.body;
      if (gzip && this.options.compress !== undefined && byteLength(out.body) >= GZIP_THRESHOLD_BYTES) {
        const compressed = await Promise.race([this.options.compress(out.body), deadline]);
        if (compressed === TIMED_OUT) return this.timedOut(out);
        if (compressed !== null) {
          body = compressed;
          headers['Content-Encoding'] = 'gzip';
        }
      }

      return await this.attempt(fetchFn, out, headers, body, controller, deadline, true);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async attempt(
    fetchFn: typeof fetch,
    out: Outbound,
    headers: Record<string, string>,
    body: string | Uint8Array,
    controller: AbortController | undefined,
    deadline: Promise<typeof TIMED_OUT>,
    mayRetry: boolean,
  ): Promise<Delivery> {
    try {
      const request = fetchFn(`${this.options.host}${out.endpoint}`, {
        method: 'POST',
        headers,
        body: body as BodyInit,
        redirect: 'manual',
        ...(controller !== undefined ? { signal: controller.signal } : {}),
      });
      const response = await Promise.race([request, deadline]);
      if (response === TIMED_OUT) {
        // The fetch may still settle later; consume it quietly so nothing is left dangling.
        request.then((r) => r.body?.cancel().catch(() => {})).catch(() => {});

        return this.timedOut(out);
      }

      const text = await Promise.race([response.text().catch(() => ''), deadline]);
      if (text === TIMED_OUT) {
        response.body?.cancel().catch(() => {});

        return this.timedOut(out);
      }

      return {
        status: response.status,
        body: parseJson(text) ?? null,
        retryAfter: parseRetryAfter(response.headers.get('Retry-After')),
        rateLimitCategories: response.headers.get('X-RateLimit-Categories') ?? '',
      };
    } catch (error) {
      if (mayRetry && isStaleSocket(error)) {
        this.options.logger.debug('connection reset on a reused socket; retrying once');

        return this.attempt(fetchFn, out, headers, body, controller, deadline, false);
      }
      this.options.logger.debug('request failed', { endpoint: out.endpoint, error: describe(error) });

      return { status: 0, body: null };
    }
  }

  private timedOut(out: Outbound): Delivery {
    this.options.logger.debug('request timed out', { endpoint: out.endpoint });

    return { status: 0, body: null };
  }
}

function isStaleSocket(error: unknown): boolean {
  const cause = (error as { cause?: unknown })?.cause ?? error;
  const code = (cause as { code?: unknown })?.code;

  return code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'EPIPE';
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error.cause as { code?: unknown })?.code ?? (error as { code?: unknown }).code;

    return code !== undefined ? `${error.message} (${String(code)})` : error.message;
  }

  return String(error);
}
