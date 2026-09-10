import { Backoff, BATCH_CATEGORIES, ERROR_CATEGORIES, MAX_ATTEMPTS, MAX_NETWORK_ATTEMPTS } from './backoff.js';
import { byteLength } from './bytes.js';
import { decide, networkFailure, type Decision } from './decide.js';
import { serverDiagnostics } from './diagnostics.js';
import { MAX_BATCH_ITEMS, MAX_ERROR_ITEMS, MAX_REQUEST_BYTES } from './limits.js';
import type { Logger } from './logger.js';
import { Queue, type Entry } from './queue.js';
import { Reports, type Category } from './reports.js';

/**
 * The send loop shared by every runtime: take a chunk, build a request, send it, act on the
 * answer. The runtime supplies only a `Transport` (bytes in, status and body out) and a clock; the
 * whole policy of what to do with a 413, a 429 or a dropped connection lives here, once.
 *
 * Two queues, two endpoints, one loop. Analytics and errors are held and retried independently so
 * a throttled event stream never delays a crash report.
 */
export type Endpoint = '/v1/batch' | '/v1/errors';

export interface Outbound {
  readonly endpoint: Endpoint;
  readonly body: string;
  readonly categories: readonly Category[];
  readonly count: number;
}

export interface Delivery {
  /** 0 when the request never got an HTTP answer. */
  readonly status: number;
  readonly body: unknown;
  /** Seconds, already parsed. */
  readonly retryAfter?: number;
  readonly rateLimitCategories?: string;
}

export interface SendOptions {
  readonly gzip: boolean;
}

export interface Transport {
  send(out: Outbound, options: SendOptions): Promise<Delivery>;
}

export interface DispatcherOptions {
  readonly transport: Transport;
  readonly logger: Logger;
  readonly maxQueueSize: number;
  readonly maxPendingErrors: number;
  readonly gzip: boolean;
  /** Request-level defaults, sent once per request. */
  readonly context?: () => Record<string, unknown>;
  readonly now?: () => number;
  readonly random?: () => number;
  /** A 401/403 was seen. The client stops accepting work. */
  readonly onShutdown?: (code: string) => void;
  /** A hold of hours: a monthly cap. Surfaced once, loudly. */
  readonly onBilling?: (code: string) => void;
  /** Bytes that could not be sent in an unload/beacon context. Never blocks. */
  readonly onDeliveryFailed?: (endpoint: Endpoint, count: number) => void;
}

export class Dispatcher {
  readonly events: Queue;
  readonly errors: Queue;
  readonly reports = new Reports();
  readonly backoff: Backoff;

  private gzip: boolean;
  private stopped = false;
  private inFlight: Promise<boolean> | null = null;
  private billingWarned = false;
  private readonly now: () => number;

  constructor(private readonly options: DispatcherOptions) {
    this.events = new Queue(options.maxQueueSize, this.reports);
    this.errors = new Queue(options.maxPendingErrors, this.reports);
    this.now = options.now ?? Date.now;
    this.backoff = new Backoff(this.now, options.random);
    this.gzip = options.gzip;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  get pending(): number {
    return this.events.length + this.errors.length;
  }

  /** Nothing else will ever be sent. Used after a 401/403 and by `close()`. */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Send everything sendable. Serialised: a second call while one is running waits for it, then
   * runs, so two flushes never interleave chunks of the same queue.
   */
  flush(): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      try {
        return await this.drain();
      } catch (error) {
        this.options.logger.warn('flush failed unexpectedly', { error: String(error) });

        return false;
      }
    };

    const chained = this.inFlight === null ? run() : this.inFlight.then(run, run);
    this.inFlight = chained;
    void chained.finally(() => {
      if (this.inFlight === chained) this.inFlight = null;
    });

    return chained;
  }

  /** Milliseconds until the earliest held category frees up, or 0 when nothing is held. */
  nextRetryIn(): number {
    const waits: number[] = [];
    if (!this.events.isEmpty) waits.push(this.backoff.remaining(BATCH_CATEGORIES));
    if (!this.errors.isEmpty) waits.push(this.backoff.remaining(ERROR_CATEGORIES));

    return waits.length === 0 ? 0 : Math.max(...waits);
  }

  /**
   * One request per queue, for an unload path where there is time for exactly one attempt. The
   * caller's transport decides how (beacon, keepalive); no retries, no restore, and the persisted
   * copy is what survives if the attempt does not.
   */
  buildAll(): Array<{ out: Outbound; entries: readonly Entry[] }> {
    const all: Array<{ out: Outbound; entries: readonly Entry[] }> = [];
    if (!this.errors.isEmpty) all.push({ out: this.build('/v1/errors', this.errors.peek(), ERROR_CATEGORIES), entries: this.errors.peek() });
    if (!this.events.isEmpty) all.push({ out: this.build('/v1/batch', this.events.peek(), BATCH_CATEGORIES), entries: this.events.peek() });

    return all;
  }

  /** A request for exactly these entries, for a caller splitting an unload send. */
  buildRequest(endpoint: Endpoint, entries: readonly Entry[]): Outbound {
    return this.build(endpoint, entries, endpoint === '/v1/errors' ? ERROR_CATEGORIES : BATCH_CATEGORIES);
  }

  private async drain(): Promise<boolean> {
    if (this.stopped) return false;
    let ok = true;

    // Errors first: they are rarer, smaller, and the thing someone is paged about.
    if (!this.errors.isEmpty && !this.backoff.isHeld(ERROR_CATEGORIES)) {
      ok = (await this.sendQueue(this.errors, '/v1/errors', ERROR_CATEGORIES, MAX_ERROR_ITEMS)) && ok;
    }
    if (!this.events.isEmpty && !this.backoff.isHeld(BATCH_CATEGORIES)) {
      ok = (await this.sendQueue(this.events, '/v1/batch', BATCH_CATEGORIES, MAX_BATCH_ITEMS)) && ok;
    }

    return ok;
  }

  private async sendQueue(queue: Queue, endpoint: Endpoint, categories: readonly Category[], maxItems: number): Promise<boolean> {
    let limit = maxItems;

    while (!queue.isEmpty && !this.stopped && !this.backoff.isHeld(categories)) {
      const entries = queue.take(limit);
      const outcome = await this.sendChunk(entries, endpoint, categories);

      if (outcome === 'split') {
        queue.restore(entries);
        if (entries.length === 1) {
          // One item that will never fit. Nothing to halve; let it go, and say so.
          const gone = queue.take(1);
          for (const entry of gone) this.reports.record('invalid', entry.category);
          this.options.logger.warn(`dropped one ${endpoint} item the server refused as too large`);
          limit = maxItems;
          continue;
        }
        limit = Math.max(1, Math.floor(entries.length / 2));
        continue;
      }

      if (outcome === 'retry') {
        queue.restore(entries);

        return false;
      }

      if (outcome === 'stop') return false;

      limit = maxItems;
    }

    return true;
  }

  private async sendChunk(entries: Entry[], endpoint: Endpoint, categories: readonly Category[]): Promise<'sent' | 'split' | 'retry' | 'stop'> {
    // A request that would exceed the byte ceiling is split BEFORE it is sent. The ceiling is on
    // compressed bytes, so this only fires for pathological chunks, but a 413 costs a round trip.
    let out = this.build(endpoint, entries, categories);
    if (entries.length > 1 && byteLength(out.body) > MAX_REQUEST_BYTES) return 'split';

    const snapshot = this.reports.snapshot();
    let attemptGzip = this.gzip;

    for (;;) {
      let delivery: Delivery;
      try {
        delivery = await this.options.transport.send(out, { gzip: attemptGzip });
      } catch (error) {
        this.options.logger.debug('transport threw', { error: String(error) });
        delivery = { status: 0, body: null };
      }

      const decision: Decision = delivery.status === 0
        ? networkFailure()
        : decide(delivery.status, delivery.body, { retryAfter: delivery.retryAfter ?? 0, rateLimitCategories: delivery.rateLimitCategories ?? '' });

      switch (decision.action) {
        case 'drop': {
          if (snapshot !== null) this.reports.commit(snapshot.taken);
          this.backoff.succeeded(categories);
          if (decision.code === 'ok') {
            for (const line of serverDiagnostics(delivery.body)) this.options.logger.warn(line);
          } else {
            this.options.logger.warn(`server refused a ${endpoint} request (${decision.code}); ${entries.length} item(s) dropped`);
            for (const entry of entries) this.reports.record('invalid', entry.category);
          }

          return 'sent';
        }

        case 'degrade': {
          if (!attemptGzip) {
            // Already uncompressed and still "invalid gzip": the body is the problem, not the coding.
            for (const entry of entries) this.reports.record('invalid', entry.category);

            return 'sent';
          }
          this.options.logger.warn('server could not inflate a compressed request; compression is off for this session');
          this.gzip = false;
          attemptGzip = false;
          continue;
        }

        case 'shutdown': {
          this.stopped = true;
          this.options.logger.error(`the write key was refused (${decision.code}); nothing more will be sent`);
          this.events.discardAll('send_error');
          this.errors.discardAll('send_error');
          this.options.onShutdown?.(decision.code);

          return 'stop';
        }

        case 'split':
          return 'split';

        case 'hold': {
          const held = narrow(categories, decision.categories);
          this.backoff.hold(held, decision.wait);
          if (decision.billing) {
            if (!this.billingWarned) {
              this.billingWarned = true;
              this.options.logger.error(`the monthly cap was reached (${decision.code}); sending pauses for six hours at a time until the plan allows more`);
              this.options.onBilling?.(decision.code);
            }
          } else {
            this.options.logger.debug(`rate limited on ${endpoint} (${decision.code}); holding ${held.join(', ')}`);
          }

          return 'retry';
        }

        case 'retry': {
          const attempts = Math.max(...entries.map((entry) => (entry.attempts = (entry.attempts ?? 0) + 1)));
          const budget = decision.code === 'network' ? MAX_NETWORK_ATTEMPTS : MAX_ATTEMPTS;
          if (attempts >= budget) {
            this.options.logger.warn(
              decision.code === 'network'
                ? `${entries.length} item(s) dropped after ${attempts} attempts with no answer from the server (offline, or a blocker in the way)`
                : `${entries.length} item(s) dropped after ${attempts} failed attempts (${decision.code})`,
            );
            for (const entry of entries) this.reports.record('send_error', entry.category);
            this.backoff.succeeded(categories);

            return 'sent';
          }
          this.backoff.hold(categories, decision.wait);

          return 'retry';
        }
      }
    }
  }

  private build(endpoint: Endpoint, entries: readonly Entry[], categories: readonly Category[]): Outbound {
    const body: Record<string, unknown> = {};

    if (endpoint === '/v1/batch') {
      const batch: Array<Record<string, unknown>> = [];
      const identify: Array<Record<string, unknown>> = [];
      for (const entry of entries) (entry.category === 'identify' ? identify : batch).push(entry.item);
      body['batch'] = batch;
      if (identify.length > 0) body['identify'] = identify;
    } else {
      body['errors'] = entries.map((entry) => entry.item);
    }

    const context = this.options.context?.();
    if (context !== undefined && Object.keys(context).length > 0) body['context'] = context;

    const report = this.reports.snapshot();
    if (report !== null) body['client_report'] = report.body;

    return { endpoint, body: JSON.stringify(body), categories, count: entries.length };
  }
}

/** The server may narrow a hold to fewer categories than the endpoint governs, never widen it. */
function narrow(endpointCategories: readonly Category[], named: readonly string[] | undefined): Category[] {
  if (named === undefined || named.length === 0) return [...endpointCategories];
  const narrowed = endpointCategories.filter((category) => named.includes(category));

  return narrowed.length > 0 ? narrowed : [...endpointCategories];
}
