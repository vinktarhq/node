import { Backoff, BATCH_CATEGORIES, ERROR_CATEGORIES, MAX_ATTEMPTS, MAX_NETWORK_ATTEMPTS } from './backoff.js';
import { decide, holdCategories, networkFailure, type Decision } from './decide.js';
import { serverDiagnostics } from './diagnostics.js';
import { MAX_BATCH_ITEMS, MAX_ERROR_ITEMS, MAX_REQUEST_BYTES } from './limits.js';
import type { Logger } from './logger.js';
import { Queue, type Entry } from './queue.js';
import { Reports, type Category } from './reports.js';

/**
 * The send loop shared by every runtime: pick a chunk, build a request, send it, act on the
 * answer. The runtime supplies only a `Transport` (bytes in, status and body out) and a clock; the
 * whole policy of what to do with a 413, a 429 or a dropped connection lives here, once.
 *
 * Two queues, two endpoints, one loop. Analytics and errors are held and retried independently so
 * a throttled event stream never delays a crash report.
 *
 * **What `flush()` answers.** True only when every record that was queued when the call started
 * was accepted by the server. A record still held, retrying, refused, rejected inside a 202, or
 * given up on makes it false. Records captured while the flush runs are the next flush's business,
 * which is also what keeps a flush from chasing a capture loop forever.
 */
export type Endpoint = '/v1/batch' | '/v1/errors';

export interface Outbound {
  readonly endpoint: Endpoint;
  readonly body: string;
  readonly categories: readonly Category[];
  readonly count: number;
  /** The client-report counts this body carries, to commit once it is accepted. */
  readonly reportTaken?: ReadonlyMap<string, number>;
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

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface DispatcherOptions {
  readonly transport: Transport;
  readonly logger: Logger;
  readonly maxQueueSize: number;
  readonly maxPendingErrors: number;
  readonly maxQueueBytes?: number;
  readonly maxPendingErrorBytes?: number;
  readonly gzip: boolean;
  /** Request-level defaults, sent once per request. */
  readonly context?: () => Record<string, unknown>;
  readonly now?: () => number;
  readonly random?: () => number;
  /**
   * The longest one send may take before it counts as unanswered, whatever the transport does.
   * A transport with its own deadline still gets this as a backstop: a custom `fetch` that ignores
   * its abort signal must not stall every later flush behind it.
   */
  readonly sendTimeoutMs?: number;
  readonly timers?: Timers;
  /** False while the runtime knows it is offline. Failures then do not spend the retry budget. */
  readonly isOnline?: () => boolean;
  /**
   * A 401/403 or a redirect was seen, and nothing more will be sent. After a refused key the queue
   * has already been discarded. After a redirect it is kept: the host is misconfigured, not the
   * data, and a persisted queue or a spool can deliver it once the host is fixed.
   */
  readonly onShutdown?: (code: string) => void;
  /** A monthly cap. Surfaced once, loudly. */
  readonly onBilling?: (code: string) => void;
}

type ChunkResult =
  /** The server answered for these entries; `accepted` are the ones it kept. */
  | { readonly kind: 'answered'; readonly accepted: readonly Entry[] }
  | { readonly kind: 'split' }
  | { readonly kind: 'retry' }
  | { readonly kind: 'stop' };

const defaultTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class Dispatcher {
  readonly events: Queue;
  readonly errors: Queue;
  readonly reports = new Reports();
  readonly backoff: Backoff;

  private gzip: boolean;
  private stopped = false;
  private inFlight: Promise<boolean> | null = null;
  private billingWarned = false;
  private readonly timers: Timers;

  constructor(private readonly options: DispatcherOptions) {
    this.events = new Queue(options.maxQueueSize, this.reports, options.maxQueueBytes);
    this.errors = new Queue(options.maxPendingErrors, this.reports, options.maxPendingErrorBytes);
    this.backoff = new Backoff(options.now ?? Date.now, options.random);
    this.gzip = options.gzip;
    this.timers = options.timers ?? defaultTimers;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  get pending(): number {
    return this.events.length + this.errors.length;
  }

  /** Nothing else will ever be sent. Used after a 401/403/redirect and by `close()`. */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Send everything that was queued when the call started. Serialised: a second call while one is
   * running waits for it, then runs, so two flushes never interleave chunks of the same queue.
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

  /**
   * Milliseconds until the earliest queue with something in it may send again. A long hold on one
   * category never delays the other: a six-hour monthly hold on events is no reason to sit on an
   * error that could go now.
   */
  nextRetryIn(): number {
    const waits: number[] = [];
    if (!this.events.isEmpty) waits.push(this.backoff.remaining(BATCH_CATEGORIES));
    if (!this.errors.isEmpty) waits.push(this.backoff.remaining(ERROR_CATEGORIES));

    return waits.length === 0 ? 0 : Math.min(...waits);
  }

  /** Give up on everything queued, counted under `reason`. Returns how many records that was. */
  abandon(reason: 'send_error'): number {
    return this.errors.discardAll(reason) + this.events.discardAll(reason);
  }

  /**
   * One request per queue, for an unload path where there is time for exactly one attempt. The
   * caller's transport decides how (beacon, keepalive). Only the first request carries the client
   * report, so a page that sends several on the way out does not report the same drops several
   * times.
   */
  buildAll(): Array<{ out: Outbound; entries: readonly Entry[] }> {
    const all: Array<{ out: Outbound; entries: readonly Entry[] }> = [];
    if (!this.errors.isEmpty) all.push({ out: this.build('/v1/errors', this.errors.peek(), all.length === 0), entries: this.errors.peek() });
    if (!this.events.isEmpty) all.push({ out: this.build('/v1/batch', this.events.peek(), all.length === 0), entries: this.events.peek() });

    return all;
  }

  /** A request for exactly these entries, for a caller splitting an unload send. */
  buildRequest(endpoint: Endpoint, entries: readonly Entry[], withReport = false): Outbound {
    return this.build(endpoint, entries, withReport);
  }

  /**
   * The browser accepted an unload request, and that is all it will ever say. Its report is taken
   * as delivered, because the alternative is sending the same counts again from the next page.
   */
  commitReport(out: Outbound): void {
    if (out.reportTaken !== undefined) this.reports.commit(new Map(out.reportTaken));
  }

  private async drain(): Promise<boolean> {
    if (this.stopped) return false;

    // What this flush answers for, taken before the first await so a capture made right after the
    // call belongs to the next flush.
    const owedErrors = new Set(this.errors.peek());
    const owedEvents = new Set(this.events.peek());

    // Nothing queued, but drops to report: a page where every error was a suppressed repeat, or
    // every event was sampled out, is exactly the page whose counts matter. An explicit flush
    // delivers them on their own; a timer never flushes an empty queue, so this costs no requests.
    if (owedErrors.size === 0 && owedEvents.size === 0) return this.reports.isEmpty ? true : this.sendReport();

    // Errors first: they are rarer, smaller, and the thing someone is paged about.
    const errors = await this.drainQueue(this.errors, owedErrors, '/v1/errors', ERROR_CATEGORIES, MAX_ERROR_ITEMS);
    const events = await this.drainQueue(this.events, owedEvents, '/v1/batch', BATCH_CATEGORIES, MAX_BATCH_ITEMS);

    return errors && events && !this.stopped;
  }

  /** An empty batch carrying only the client report. True when there was nothing else to answer for. */
  private async sendReport(): Promise<boolean> {
    if (this.backoff.isHeld(BATCH_CATEGORIES)) return true;
    const out = this.build('/v1/batch', [], true);
    const delivery = await this.send(out, this.gzip);
    if (delivery.status >= 200 && delivery.status < 300) this.commitReport(out);

    return true;
  }

  private async drainQueue(queue: Queue, owed: ReadonlySet<Entry>, endpoint: Endpoint, categories: readonly Category[], maxItems: number): Promise<boolean> {
    if (owed.size === 0) return true;

    const accepted = new Set<Entry>();
    let limit = maxItems;

    while (!this.stopped && !this.backoff.isHeld(categories)) {
      const remaining = queue.peek().filter((entry) => owed.has(entry));
      if (remaining.length === 0) break;

      const chunk = fitBytes(remaining.slice(0, limit));
      const result = await this.sendChunk(queue, chunk, endpoint, categories);

      if (result.kind === 'answered') {
        for (const entry of result.accepted) accepted.add(entry);
        limit = maxItems;
        continue;
      }

      if (result.kind === 'split') {
        if (chunk.length === 1) {
          // One item that will never fit. Nothing to halve; let it go, and say so.
          queue.remove(chunk);
          this.reports.record('invalid', chunk[0]!.category);
          this.options.logger.warn(`dropped one ${endpoint} item the server refused as too large`);
          limit = maxItems;
          continue;
        }
        limit = Math.max(1, Math.floor(chunk.length / 2));
        continue;
      }

      // 'retry' (held, or backing off) and 'stop': whatever is left is not delivered.
      break;
    }

    for (const entry of owed) if (!accepted.has(entry)) return false;

    return true;
  }

  private async sendChunk(queue: Queue, entries: readonly Entry[], endpoint: Endpoint, categories: readonly Category[]): Promise<ChunkResult> {
    // A request that would exceed the byte ceiling is split BEFORE it is sent. The ceiling is on
    // compressed bytes, so this only fires for pathological chunks, but a 413 costs a round trip.
    if (entries.length > 1 && entries.reduce((sum, entry) => sum + entry.bytes, 0) > MAX_REQUEST_BYTES) return { kind: 'split' };

    queue.lease(entries);
    try {
      const out = this.build(endpoint, entries, true);
      let attemptGzip = this.gzip;

      for (;;) {
        const delivery = await this.send(out, attemptGzip);
        const decision: Decision =
          delivery.status === 0
            ? networkFailure()
            : decide(delivery.status, delivery.body, { retryAfter: delivery.retryAfter ?? 0, rateLimitCategories: delivery.rateLimitCategories ?? '' });

        switch (decision.action) {
          case 'drop': {
            this.backoff.succeeded(categories);
            queue.remove(entries);

            if (decision.code === 'ok') {
              this.commitReport(out);
              for (const line of serverDiagnostics(delivery.body)) this.options.logger.warn(line);
              const rejected = rejectedEntries(endpoint, entries, delivery.body);
              for (const entry of rejected) this.reports.record('invalid', entry.category);

              return { kind: 'answered', accepted: entries.filter((entry) => !rejected.has(entry)) };
            }

            // Refused outright. The report rode in the refused body, so it is not committed.
            this.options.logger.warn(`server refused a ${endpoint} request (${decision.code}); ${entries.length} item(s) dropped`);
            for (const entry of entries) this.reports.record('invalid', entry.category);

            return { kind: 'answered', accepted: [] };
          }

          case 'degrade': {
            if (attemptGzip) {
              this.options.logger.warn('server could not inflate a compressed request; compression is off for this session');
              this.gzip = false;
              attemptGzip = false;
              continue;
            }
            // Already uncompressed and still "invalid gzip": the body is the problem, not the coding.
            this.backoff.succeeded(categories);
            queue.remove(entries);
            this.options.logger.warn(`server refused a ${endpoint} request (${decision.code}); ${entries.length} item(s) dropped`);
            for (const entry of entries) this.reports.record('invalid', entry.category);

            return { kind: 'answered', accepted: [] };
          }

          case 'shutdown': {
            this.stopped = true;
            const redirect = decision.code === 'redirect';
            this.options.logger.error(
              redirect
                ? `the ingest host answered with a redirect (${delivery.status}); it was not followed, and nothing more will be sent from here. Point host at the ingest URL itself; what is queued is kept`
                : `the write key was refused (${decision.code}); nothing more will be sent`,
            );
            // A key that is refused will never work, so its queue can never be delivered.
            if (!redirect) this.abandon('send_error');
            this.options.onShutdown?.(decision.code);

            return { kind: 'stop' };
          }

          case 'split':
            return { kind: 'split' };

          case 'hold': {
            const held = holdCategories(categories, decision.categories);
            this.backoff.hold(held, decision.wait);
            if (decision.billing) {
              if (!this.billingWarned) {
                this.billingWarned = true;
                this.options.logger.error(`the monthly cap was reached (${decision.code}); sending pauses, checking again at most every six hours`);
                this.options.onBilling?.(decision.code);
              }
            } else {
              this.options.logger.debug(`rate limited on ${endpoint} (${decision.code}); holding ${held.join(', ')}`);
            }

            return { kind: 'retry' };
          }

          case 'retry': {
            const network = decision.code === 'network';
            // Offline is not the server failing, and an hour on a train must not use up the budget.
            const counts = !network || this.options.isOnline?.() !== false;
            let attempts = 0;
            for (const entry of entries) {
              if (counts) entry.attempts = (entry.attempts ?? 0) + 1;
              attempts = Math.max(attempts, entry.attempts ?? 0);
            }
            const budget = network ? MAX_NETWORK_ATTEMPTS : MAX_ATTEMPTS;
            if (attempts >= budget) {
              this.options.logger.warn(
                network
                  ? `${entries.length} item(s) dropped after ${attempts} attempts with no answer from the server (a blocker in the way, or the host is unreachable)`
                  : `${entries.length} item(s) dropped after ${attempts} failed attempts (${decision.code})`,
              );
              for (const entry of entries) this.reports.record('send_error', entry.category);
              queue.remove(entries);
              this.backoff.succeeded(categories);

              return { kind: 'answered', accepted: [] };
            }
            this.backoff.hold(categories, decision.wait, 'floor');

            return { kind: 'retry' };
          }
        }
      }
    } finally {
      queue.release(entries);
    }
  }

  /** One attempt, bounded, never throwing. */
  private async send(out: Outbound, gzip: boolean): Promise<Delivery> {
    let handle: unknown;
    try {
      const attempt = this.options.transport.send(out, { gzip });
      const limit = this.options.sendTimeoutMs;
      if (limit === undefined) return await attempt;

      // The late answer, if one ever comes, is ignored; it must not surface as an unhandled rejection.
      attempt.catch(() => {});
      const timeout = new Promise<Delivery>((resolve) => {
        handle = this.timers.set(() => resolve({ status: 0, body: null }), limit);
      });

      return await Promise.race([attempt, timeout]);
    } catch (error) {
      this.options.logger.debug('transport threw', { error: String(error) });

      return { status: 0, body: null };
    } finally {
      if (handle !== undefined) this.timers.clear(handle);
    }
  }

  private build(endpoint: Endpoint, entries: readonly Entry[], withReport: boolean): Outbound {
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

    let context: Record<string, unknown> | undefined;
    try {
      context = this.options.context?.();
    } catch (error) {
      this.options.logger.debug('request context failed; sent without it', { error: String(error) });
    }
    if (context !== undefined && Object.keys(context).length > 0) body['context'] = context;

    let reportTaken: ReadonlyMap<string, number> | undefined;
    if (withReport) {
      const report = this.reports.snapshot();
      if (report !== null) {
        body['client_report'] = report.body;
        reportTaken = report.taken;
      }
    }

    return {
      endpoint,
      body: JSON.stringify(body),
      categories: endpoint === '/v1/errors' ? ERROR_CATEGORIES : BATCH_CATEGORIES,
      count: entries.length,
      ...(reportTaken !== undefined ? { reportTaken } : {}),
    };
  }
}

/** At most as many leading entries as fit the request ceiling, and always at least one. */
function fitBytes(entries: readonly Entry[]): Entry[] {
  let bytes = 0;
  let count = 0;
  for (const entry of entries) {
    if (count > 0 && bytes + entry.bytes > MAX_REQUEST_BYTES) break;
    bytes += entry.bytes;
    count += 1;
  }

  return entries.slice(0, count);
}

/**
 * The entries a 202 says were not kept. `errors[].index` counts positions in the body's `batch`
 * array (identify entries are reported separately, under `identify_ignored`) or its `errors` array.
 */
function rejectedEntries(endpoint: Endpoint, entries: readonly Entry[], body: unknown): Set<Entry> {
  const out = new Set<Entry>();
  if (typeof body !== 'object' || body === null) return out;
  const list = (body as Record<string, unknown>)['errors'];
  if (!Array.isArray(list)) return out;

  const positional = endpoint === '/v1/batch' ? entries.filter((entry) => entry.category !== 'identify') : entries;
  for (const rejection of list) {
    const index = Number((rejection as { index?: unknown } | null)?.index);
    const entry = Number.isInteger(index) ? positional[index] : undefined;
    if (entry !== undefined) out.add(entry);
  }

  return out;
}
