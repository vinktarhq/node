import { byteLength } from '../core/bytes.js';
import { parseRetryAfter } from '../core/decide.js';
import type { Delivery, Outbound, SendOptions, Transport } from '../core/dispatcher.js';
import type { Logger } from '../core/logger.js';
import { parseJson } from '../core/normalize.js';
import { LIB, VERSION } from '../version.js';

/**
 * HTTP for a server or an edge runtime, over whatever `fetch` the platform provides.
 *
 * Three things the platform makes necessary:
 *
 *   - **The deadline is the SDK's own**, raced against the request, not delegated to an
 *     `AbortSignal`: an injected `fetch` (a proxy wrapper, a test double) may ignore the signal
 *     and the send must still finish on time.
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

export class NodeTransport implements Transport {
  constructor(private readonly options: NodeTransportOptions) {}

  async send(out: Outbound, { gzip }: SendOptions): Promise<Delivery> {
    const fetchFn = this.options.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (typeof fetchFn !== 'function') {
      this.options.logger.error('no fetch is available in this runtime; pass { fetch } to init()');

      return { status: 0, body: null };
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Vinktar-Key': this.options.writeKey,
      'User-Agent': `${LIB}/${VERSION}`,
    };
    let body: string | Uint8Array = out.body;
    if (gzip && this.options.compress !== undefined && byteLength(out.body) >= GZIP_THRESHOLD_BYTES) {
      const compressed = await this.options.compress(out.body);
      if (compressed !== null) {
        body = compressed;
        headers['Content-Encoding'] = 'gzip';
      }
    }

    return this.attempt(fetchFn, out, headers, body, true);
  }

  private async attempt(fetchFn: typeof fetch, out: Outbound, headers: Record<string, string>, body: string | Uint8Array, mayRetry: boolean): Promise<Delivery> {
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        controller?.abort(new Error('vinktar: request timed out'));
        resolve('timeout');
      }, this.options.timeoutMs);
      if (this.options.unref !== false) (timer as { unref?: () => void }).unref?.();
    });

    try {
      const request = fetchFn(`${this.options.host}${out.endpoint}`, {
        method: 'POST',
        headers,
        body: body as BodyInit,
        ...(controller !== undefined ? { signal: controller.signal } : {}),
      });
      const outcome = await Promise.race([request.then((response) => ({ response })), deadline]);
      if (outcome === 'timeout') {
        // The fetch may still settle later; consume it quietly so nothing is left dangling.
        request.then((r) => r.body?.cancel().catch(() => {})).catch(() => {});
        this.options.logger.debug('request timed out', { endpoint: out.endpoint });

        return { status: 0, body: null };
      }

      const { response } = outcome;
      let text = '';
      try {
        text = await response.text();
      } catch {
        try {
          await response.body?.cancel();
        } catch {
          // Already gone.
        }
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

        return this.attempt(fetchFn, out, headers, body, false);
      }
      this.options.logger.debug('request failed', { endpoint: out.endpoint, error: describe(error) });

      return { status: 0, body: null };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
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
