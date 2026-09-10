import { Breadcrumbs, toBreadcrumb, type Breadcrumb } from './core/breadcrumbs.js';
import { isBlockedId, validUserId } from './core/blocked.js';
import { truncateToBytes } from './core/bytes.js';
import { Dedupe, KeyedValve, Valve } from './core/dedupe.js';
import { Dispatcher } from './core/dispatcher.js';
import { coerce, CORE_COERCERS, exceptionKey, fromMessage, isMeaningless, issueKey, type WireException } from './core/exception.js';
import { isServerSuppressed, matches } from './core/filters.js';
import { runHooks } from './core/hooks.js';
import { hexId, uuidv7 } from './core/ids.js';
import {
  MAX_FINGERPRINT_PART_BYTES, MAX_FINGERPRINT_PARTS, MAX_TAG_KEY_BYTES, MAX_TAG_VALUE_BYTES, MAX_TAGS, TIMESTAMP_FUTURE_MS,
  TIMESTAMP_PAST_MS, type Level, LEVELS,
} from './core/limits.js';
import type { Logger } from './core/logger.js';
import { normalize, normalizeTags, type NormalizeOptions, type Props } from './core/normalize.js';
import type { Entry } from './core/queue.js';
import { sampled } from './core/sampling.js';
import { parseStack } from './core/stack.js';
import { describeTraitDrop, parseTraits, type Traits } from './core/traits.js';
import { baseContext, type RuntimeInfo } from './node/context.js';
import { installCrumbSources } from './node/crumbs.js';
import { inAppFor, shortenPath, SourceContext } from './node/frames.js';
import { installCrashHandlers, installLifecycle, type ProcessLike } from './node/handlers.js';
import { Scope, type ScopeStore } from './node/scope.js';
import { flushIfServerless, type WaitUntilContext } from './node/serverless.js';
import type { Spool } from './node/spool.js';
import { NodeTransport } from './node/transport.js';
import { makeLogger, resolve, type Environment, type Resolved, type VinktarOptions } from './options.js';
import type { CaptureContext, EventOptions, IdentifyOptions, RequestInfo, SourceReader, User } from './types.js';
import { VERSION } from './version.js';

/**
 * The client. One per process, normally reached through the facade in `index.ts` (Node) or
 * `edge.ts` (workers and edge functions), which supply the platform this class runs on.
 *
 * What the platform decides: how to compress, where the current scope lives, whether source can
 * be read from disk, whether there is a `process` to hook, and whether sends may be scheduled at
 * all. An edge function has no background: nothing goes out until `flush()`, or the `waitUntil`
 * helper, is called, because a request started after the handler returned is a request the
 * runtime will kill.
 */
export interface Platform {
  readonly name: 'node' | 'edge';
  readonly runtime: RuntimeInfo;
  readonly environment: Environment;
  readonly compress?: (text: string) => Promise<Uint8Array | null>;
  readonly scopeStore: (root: Scope) => ScopeStore;
  readonly readSource?: SourceReader;
  readonly process?: ProcessLike;
  readonly isMainThread?: boolean;
  readonly spool?: (path: string, logger: Logger) => Spool;
  /** No timers: sends happen only when asked for. */
  readonly deferred: boolean;
}

const PENDING_ERRORS = 200;

/** Headers that are safe to attach to an error without PII enabled. Never cookies or auth. */
const SAFE_HEADERS = new Set(['user-agent', 'referer', 'accept', 'accept-language', 'content-type', 'content-length', 'host', 'x-request-id', 'x-forwarded-proto']);
const NEVER_HEADERS = new Set(['cookie', 'set-cookie', 'authorization', 'proxy-authorization', 'x-api-key', 'x-vinktar-key']);

export class Vinktar {
  readonly version = VERSION;

  private readonly o: Resolved;
  private readonly logger: Logger;
  private readonly root: Scope;
  private readonly scopes: ScopeStore;
  private readonly dispatcher: Dispatcher;
  private readonly dedupe = new Dedupe();
  private readonly errorValve: Valve;
  private readonly eventValve: Valve;
  private readonly typeValve: KeyedValve;
  private readonly normalizeOptions: NormalizeOptions;
  private readonly inApp: (file: string) => boolean;
  private readonly context: Props;
  private readonly spool: Spool | null;
  private readonly teardowns: Array<() => void> = [];
  private source: SourceContext;
  private readSource: SourceReader;
  private supers: Props = {};
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private handlersInstalled = false;
  private readonly pendingWork = new Set<Promise<unknown>>();

  constructor(options: VinktarOptions | string, private readonly platform: Platform) {
    const resolvedOptions = typeof options === 'string' ? { writeKey: options } : options ?? {};
    this.logger = makeLogger(resolvedOptions);
    this.o = resolve(resolvedOptions, platform.environment, this.logger);
    this.normalizeOptions = {
      maxStringBytes: this.o.maxValueBytes,
      maxDepth: this.o.normalizeDepth,
      maxProperties: 255,
      redactedKeys: this.o.redactedKeys,
      propertyDenylist: this.o.propertyDenylist,
    };
    this.inApp = inAppFor(this.o.projectRoot);
    this.readSource = platform.readSource ?? (() => null);
    this.source = new SourceContext({ projectRoot: this.o.projectRoot, contextLines: this.o.contextLines, readSource: (p) => this.readSource(p) });
    this.context = baseContext(this.o.release, this.o.environment, this.o.serverName, platform.runtime);

    this.root = new Scope(this.o.maxBreadcrumbs, this.o.initialScope);
    this.scopes = platform.scopeStore(this.root);
    this.errorValve = new Valve(this.o.maxErrorsPerMinute);
    this.eventValve = new Valve(this.o.maxEventsPerMinute);
    this.typeValve = new KeyedValve(Math.max(1, Math.floor(this.o.maxErrorsPerMinute / 2)));

    this.dispatcher = new Dispatcher({
      transport: new NodeTransport({
        host: this.o.host,
        writeKey: this.o.writeKey,
        timeoutMs: this.o.requestTimeoutMs,
        logger: this.logger,
        fetch: this.o.fetch,
        compress: this.o.gzip ? platform.compress : undefined,
      }),
      logger: this.logger,
      maxQueueSize: this.o.maxQueueSize,
      maxPendingErrors: PENDING_ERRORS,
      gzip: this.o.gzip,
      onBilling: () => this.o.onError?.(new Error('vinktar: the monthly cap was reached; events are paused')),
    });

    this.spool = this.o.spoolPath !== '' && platform.spool !== undefined ? platform.spool(this.o.spoolPath, this.logger) : null;
    if (this.spool !== null) {
      for (const entry of this.spool.restore()) {
        (entry.category === 'error' ? this.dispatcher.errors : this.dispatcher.events).push(entry.category, entry.item);
      }
    }

    if (this.o.inert !== null) return;

    if (this.o.breadcrumbs.console || this.o.breadcrumbs.http) {
      this.teardowns.push(
        installCrumbSources({
          console: this.o.breadcrumbs.console,
          http: this.o.breadcrumbs.http,
          sendDefaultPii: this.o.sendDefaultPii,
          ingestHost: this.o.host,
          add: (crumb) => this.addBreadcrumb(crumb),
          logger: this.logger,
        }),
      );
    }

    if (platform.process !== undefined) {
      this.teardowns.push(
        installLifecycle({
          process: platform.process,
          logger: this.logger,
          shutdownTimeoutMs: this.o.shutdownTimeout,
          autoFlush: this.o.autoFlush,
          flush: () => this.flush(),
          close: () => this.close(),
          onExit: () => this.spool?.write([...this.dispatcher.errors.peek(), ...this.dispatcher.events.peek()]),
        }),
      );
      if (this.o.captureErrors) this.registerHandlers();
    }

    if (this.dispatcher.pending > 0) this.scheduleFlush(0);
  }

  // Analytics -----------------------------------------------------------------------------------

  track(name: string, properties?: Props, options?: EventOptions): void {
    this.guarded(() => {
      if (!this.ready('track')) return;
      if (typeof name !== 'string' || name.trim() === '') {
        this.logger.warn('track() needs an event name; nothing was sent');

        return;
      }
      if (!this.o.analytics) {
        this.logger.debug(`analytics is off; "${name}" was not sent`);

        return;
      }
      if (!this.eventValve.take()) {
        this.dispatcher.reports.record('ratelimit', 'event');
        this.logger.warn(`more than ${this.o.maxEventsPerMinute} events in a minute; dropping until the valve refills`);

        return;
      }

      const scope = this.scopes.current();
      const userId = pickId(options?.userId) ?? scope.userId;
      const deviceId = pickId(options?.deviceId) ?? scope.deviceId;
      const sessionId = pickId(options?.sessionId) ?? scope.sessionId;
      const unit = userId ?? deviceId ?? '';
      if (!sampled(unit, this.o.sampleRate)) {
        this.dispatcher.reports.record('sample_rate', 'event');

        return;
      }

      const timestamp = this.timestampFor(options?.timestamp, name);
      if (timestamp === null) return;

      const payload = normalize(
        { ...this.o.superProperties, ...this.supers, ...(typeof properties === 'object' && properties !== null ? properties : {}) },
        this.normalizeOptions,
        (key, reason) => this.logger.warn(`property "${key}" on "${name}" was ${reason === 'truncated' ? 'truncated' : reason === 'depth' ? `flattened past depth ${this.o.normalizeDepth}` : 'dropped: too many properties'}`),
      );
      const event: Record<string, unknown> = {
        name: truncateToBytes(name.trim(), 255),
        event_id: uuidv7(),
        timestamp,
        payload,
        context: { ...this.context },
      };
      if (userId !== undefined) event['user_id'] = userId;
      if (deviceId !== undefined) event['device_id'] = deviceId;
      if (sessionId !== undefined) event['session_id'] = sessionId;

      const hooked = runHooks(this.o.beforeTrack, event);
      if (hooked.value === null) {
        this.dispatcher.reports.record('before_send', 'event');
        if (hooked.threw !== undefined) this.logger.warn('beforeTrack threw; the event was dropped', { error: String(hooked.threw) });

        return;
      }

      this.dispatcher.events.push('event', hooked.value);
      this.afterCapture();
    });
  }

  page(name?: string, properties?: Props, options?: EventOptions): void {
    const props: Props = { ...(properties ?? {}) };
    if (typeof name === 'string' && name !== '') props['$page_name'] = name;
    this.track('$pageview', props, options);
  }

  identify(userId: string, traits?: Traits, traitsOnce?: Traits, options?: IdentifyOptions): void {
    this.guarded(() => {
      if (!this.ready('identify')) return;
      const id = validUserId(userId);
      if (id === null) {
        this.logger.warn(`identify(${JSON.stringify(userId)}) was ignored: not a usable user id`);

        return;
      }
      const parsed = parseTraits({ $set: traits, $set_once: traitsOnce, $unset: options?.unset });
      for (const drop of parsed.drops) this.logger.warn(describeTraitDrop(drop));

      const scope = this.scopes.current();
      scope.setUser(id);
      const deviceId = pickId(options?.deviceId) ?? scope.deviceId;

      const hasOps = Object.keys(parsed.set).length + Object.keys(parsed.setOnce).length + parsed.unset.length > 0;
      if (deviceId === undefined && !hasOps) {
        // The server needs a device to link or a trait to store; a bare user id is a no-op there.
        this.logger.debug(`identify("${id}"): no device to link and no traits; the user is set on the scope only`);

        return;
      }

      const entry: Record<string, unknown> = { user_id: id };
      if (deviceId !== undefined) entry['device_id'] = deviceId;
      if (Object.keys(parsed.set).length > 0) entry['$set'] = parsed.set;
      if (Object.keys(parsed.setOnce).length > 0) entry['$set_once'] = parsed.setOnce;
      if (parsed.unset.length > 0) entry['$unset'] = parsed.unset;

      this.dispatcher.events.push('identify', entry);
      this.afterCapture();
    });
  }

  setTraits(traits: Traits, traitsOnce?: Traits): void {
    this.withUser('setTraits', (id) => this.identify(id, traits, traitsOnce));
  }

  setTraitsOnce(traits: Traits): void {
    this.withUser('setTraitsOnce', (id) => this.identify(id, undefined, traits));
  }

  unsetTraits(keys: string[]): void {
    this.withUser('unsetTraits', (id) => this.identify(id, undefined, undefined, { unset: keys }));
  }

  private withUser(method: string, fn: (id: string) => void): void {
    this.guarded(() => {
      const id = this.scopes.current().userId;
      if (id === undefined) {
        this.logger.warn(`${method}() was called with no user on the scope; call identify() first, so nothing was sent`);

        return;
      }
      fn(id);
    });
  }

  setUser(user: User | null): void {
    this.guarded(() => {
      if (user === null) {
        this.scopes.current().setUser(undefined);

        return;
      }
      if (typeof user !== 'object' || typeof user.id !== 'string') {
        this.logger.warn('setUser() needs { id } or null');

        return;
      }
      const { id, ...rest } = user;
      this.identify(id, rest as Traits);
    });
  }

  /** Back to the initial scope: identity, tags, context and breadcrumbs cleared, super properties kept. */
  reset(): void {
    this.guarded(() => this.scopes.current().reset(this.o.initialScope));
  }

  register(properties: Props): void {
    this.guarded(() => {
      if (typeof properties === 'object' && properties !== null) Object.assign(this.supers, properties);
    });
  }

  registerOnce(properties: Props): void {
    this.guarded(() => {
      if (typeof properties !== 'object' || properties === null) return;
      for (const [key, value] of Object.entries(properties)) this.supers[key] ??= value;
    });
  }

  unregister(key: string): void {
    this.guarded(() => {
      delete this.supers[key];
    });
  }

  // Errors --------------------------------------------------------------------------------------

  captureException(error: unknown, hint?: CaptureContext): string {
    return this.guarded(() => this.capture(error, 'manual', hint?.handled ?? true, hint), '');
  }

  captureMessage(message: string, hint?: CaptureContext): string {
    return this.guarded(() => {
      if (!this.ready('captureMessage')) return '';
      const text = typeof message === 'string' ? message : String(message);
      let frames = this.o.attachStacktrace ? parseStack(new Error().stack, { inApp: this.inApp }) : [];
      if (frames.length > 2) frames = frames.slice(0, -2); // this method and the facade
      const exceptions = fromMessage(text, frames);

      return this.emit(exceptions, false, 'manual', true, hint ?? {}, hint?.level ?? 'info');
    }, '');
  }

  private capture(error: unknown, mechanism: 'manual' | 'uncaughtException' | 'unhandledRejection', handled: boolean, hint: CaptureContext | undefined): string {
    if (!this.ready('captureException')) return '';
    if (isMeaningless(error)) {
      this.logger.warn('captureException() was given nothing to report');

      return '';
    }
    const coerced = coerce(error, CORE_COERCERS, {
      includeRawStack: this.o.includeRawStack,
      fallbackType: mechanism === 'unhandledRejection' ? 'UnhandledRejection' : 'Error',
      inApp: this.inApp,
    });
    if (coerced.exceptions.length === 0) return '';

    return this.emit(coerced.exceptions, coerced.synthetic, mechanism, handled, hint ?? {}, hint?.level ?? 'error');
  }

  private emit(
    exceptions: WireException[],
    synthetic: boolean,
    mechanism: 'manual' | 'uncaughtException' | 'unhandledRejection',
    handled: boolean,
    hint: CaptureContext,
    level: Level,
  ): string {
    if (!this.o.errors) {
      this.logger.debug('errors is off; nothing was sent');

      return '';
    }
    const first = exceptions[0]!;
    const message = first.value;

    if (isServerSuppressed(message, first.stack)) return '';
    if (this.o.ignoreErrors.length > 0 && (matches(this.o.ignoreErrors, message) || matches(this.o.ignoreErrors, `${first.type}: ${message}`))) {
      this.logger.debug('ignored by ignoreErrors', { message });

      return '';
    }
    if (this.o.dedupe && this.dedupe.isDuplicate(exceptionKey(exceptions))) return '';
    if (!this.errorValve.take() || !this.typeValve.take(first.type)) {
      this.dispatcher.reports.record('ratelimit', 'error');
      this.logger.warn(`more than ${this.o.maxErrorsPerMinute} errors in a minute; dropping until the valve refills`);

      return '';
    }
    if (!sampled(issueKey(exceptions), this.o.errorSampleRate)) {
      this.dispatcher.reports.record('sample_rate', 'error');

      return '';
    }

    this.source.annotate(exceptions);
    for (const exception of exceptions) {
      for (const frame of exception.stack) if (frame.in_app) frame.file = shortenPath(frame.file, this.o.projectRoot);
    }

    const scope = this.scopes.current();
    const userId = pickId(hint.userId) ?? scope.userId;
    const id = hexId();
    const event: Record<string, unknown> = {
      event_id: id,
      timestamp: new Date().toISOString(),
      level: (LEVELS as readonly string[]).includes(level) ? level : 'error',
      exceptions,
      mechanism: { type: mechanism, handled, synthetic },
      environment: this.o.environment,
      context: normalize({ ...this.context, ...scope.context, ...(hint.context ?? {}) }, this.normalizeOptions),
    };
    if (userId !== undefined) event['user_id'] = userId;
    if (scope.deviceId !== undefined) event['device_id'] = scope.deviceId;
    if (scope.sessionId !== undefined) event['session_id'] = scope.sessionId;
    if (this.o.release !== '') event['release'] = this.o.release;
    const tags = normalizeTags({ ...scope.tags, ...(hint.tags ?? {}) }, MAX_TAGS, MAX_TAG_KEY_BYTES, MAX_TAG_VALUE_BYTES, (key) =>
      this.logger.warn(`tag "${key}" dropped: at most ${MAX_TAGS} tags`),
    );
    if (Object.keys(tags).length > 0) event['tags'] = tags;
    const crumbs = scope.breadcrumbs.list();
    if (crumbs.length > 0) event['breadcrumbs'] = crumbs;
    const request = this.requestBlock(scope.request);
    if (request !== null) event['request'] = request;
    if (Array.isArray(hint.fingerprint) && hint.fingerprint.length > 0) {
      event['fingerprint'] = hint.fingerprint.slice(0, MAX_FINGERPRINT_PARTS).map((part) => truncateToBytes(String(part), MAX_FINGERPRINT_PART_BYTES));
    }

    const hooked = runHooks(this.o.beforeSend, event);
    if (hooked.value === null) {
      this.dispatcher.reports.record('before_send', 'error');
      if (hooked.threw !== undefined) this.logger.warn('beforeSend threw; the error was dropped', { error: String(hooked.threw) });

      return '';
    }

    this.dispatcher.errors.push('error', hooked.value);
    this.afterCapture();

    return id;
  }

  private requestBlock(request: RequestInfo | undefined): Record<string, unknown> | null {
    if (request === undefined) return null;
    const out: Record<string, unknown> = {};
    if (typeof request.method === 'string') out['method'] = request.method.toUpperCase();
    if (typeof request.url === 'string') {
      out['url'] = truncateToBytes(this.o.sendDefaultPii ? request.url : request.url.split('?')[0] ?? request.url, 1024);
      if (this.o.sendDefaultPii && typeof request.query === 'string') out['query'] = truncateToBytes(request.query, 1024);
    }
    if (typeof request.headers === 'object' && request.headers !== null) {
      const headers: Record<string, string> = {};
      let count = 0;
      for (const [key, value] of Object.entries(request.headers)) {
        const name = key.toLowerCase();
        if (NEVER_HEADERS.has(name) || typeof value !== 'string') continue;
        if (!this.o.sendDefaultPii && !SAFE_HEADERS.has(name)) continue;
        if (count >= 50) break;
        headers[truncateToBytes(name, 128)] = truncateToBytes(value, 1024);
        count += 1;
      }
      if (count > 0) out['headers'] = headers;
    }

    return Object.keys(out).length > 0 ? out : null;
  }

  addBreadcrumb(crumb: Partial<Breadcrumb>): void {
    this.guarded(() => {
      if (this.closed || this.o.inert !== null) return;
      const shaped = toBreadcrumb(crumb, Date.now);
      if (shaped === null) return;
      const hooked = runHooks(this.o.beforeBreadcrumb, shaped);
      if (hooked.value === null) return;
      this.scopes.current().addBreadcrumb(hooked.value);
    });
  }

  setTag(key: string, value: string): void {
    this.guarded(() => this.scopes.current().setTag(key, value));
  }

  setTags(tags: Record<string, string>): void {
    this.guarded(() => this.scopes.current().setTags(tags));
  }

  setContext(context: Props | null): void {
    this.guarded(() => this.scopes.current().setContext(context));
  }

  /** The scope for the current async context. */
  scope(): Scope {
    return this.scopes.current();
  }

  /** Run `work` in a child scope: changes inside stay inside. Async work keeps the scope until it settles. */
  withScope<T>(work: (scope: Scope) => T): T {
    const child = this.scopes.current().fork();

    return this.scopes.run(child, () => work(child));
  }

  /**
   * Fork the current scope and make it the scope of everything that follows in this async
   * context. For frameworks whose hooks return rather than wrap the handler. A scope entered this
   * way is not left; it is replaced by the next request's.
   */
  enterScope(): Scope {
    const child = this.scopes.current().fork();
    this.scopes.enter(child);

    return child;
  }

  /**
   * Adopt the browser SDK's identity from an inbound request's headers, so this request's events
   * and errors stitch to the visitor that made it. Validated: an id is at most 64 characters of
   * `[A-Za-z0-9._-]`, and never a blocked value.
   */
  scopeFromHeaders(headers: Record<string, string | string[] | undefined> | Headers | undefined): Scope {
    const scope = this.scopes.current();
    if (headers === undefined || headers === null) return scope;
    const read = (name: string): string | undefined => {
      let value: unknown;
      if (typeof (headers as Headers).get === 'function') value = (headers as Headers).get(name) ?? undefined;
      else value = (headers as Record<string, string | string[] | undefined>)[name] ?? (headers as Record<string, string | string[] | undefined>)[name.toLowerCase()];
      if (Array.isArray(value)) value = value[0];

      return pickId(value);
    };
    const device = read('x-vinktar-device-id');
    const session = read('x-vinktar-session-id');
    if (device !== undefined) scope.deviceId = device;
    if (session !== undefined) scope.sessionId = session;

    return scope;
  }

  /** Install the process-wide handlers for uncaught exceptions and unhandled rejections. */
  registerHandlers(): void {
    this.guarded(() => {
      if (this.handlersInstalled || this.closed) return;
      const process = this.platform.process;
      if (process === undefined) {
        this.logger.warn('registerHandlers(): this runtime has no process to hook; wrap your handler and call captureException instead');

        return;
      }
      this.handlersInstalled = true;
      this.teardowns.push(
        installCrashHandlers({
          process,
          isMainThread: this.platform.isMainThread ?? true,
          logger: this.logger,
          shutdownTimeoutMs: this.o.shutdownTimeout,
          capture: (error, mechanism) => this.guarded(() => void this.capture(error, mechanism, false, undefined)),
          flush: () => this.flush(),
          onExit: () => {},
          unhandledRejections: this.o.unhandledRejections,
        }),
      );
    });
  }

  /** Replace how source files are read for context lines. */
  setSourceReader(reader: SourceReader): void {
    if (typeof reader === 'function') this.readSource = reader;
  }

  /** Get the queue out of a function that is about to be frozen. See `serverless.ts`. */
  flushIfServerless(options: { context?: WaitUntilContext | undefined; timeoutMs?: number } = {}): Promise<void> {
    return flushIfServerless(() => this.flush(), options, this.platform.environment.env);
  }

  // Lifecycle -----------------------------------------------------------------------------------

  async flush(): Promise<boolean> {
    if (this.o.inert !== null) return true;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pendingWork.size > 0) await Promise.allSettled([...this.pendingWork]);
    const ok = await this.dispatcher.flush();
    if (!this.platform.deferred && this.dispatcher.pending > 0 && !this.closed) {
      this.scheduleFlush(Math.max(this.dispatcher.nextRetryIn(), this.o.flushIntervalMs));
    }

    return ok;
  }

  /**
   * Flush what can be flushed within `shutdownTimeout`, then stop. Once per process; `flush()` is
   * the per-request call. A second call is a no-op.
   */
  async close(): Promise<boolean> {
    if (this.closed) return true;
    this.closed = true;
    let ok = false;
    try {
      ok = (await withBound(this.drainAll(), this.o.shutdownTimeout)) ?? false;
    } finally {
      if (this.flushTimer !== null) clearTimeout(this.flushTimer);
      this.flushTimer = null;
      for (const teardown of this.teardowns.splice(0)) {
        try {
          teardown();
        } catch {
          // Keep tearing down.
        }
      }
      this.spool?.write([...this.dispatcher.errors.peek(), ...this.dispatcher.events.peek()]);
      this.dispatcher.stop();
    }

    return ok;
  }

  /** Register work `close()` should wait for (a capture in a middleware that runs after the response). */
  addPendingWork(promise: Promise<unknown>): void {
    this.pendingWork.add(promise);
    void promise.finally(() => this.pendingWork.delete(promise));
  }

  // Internals -----------------------------------------------------------------------------------

  private async drainAll(): Promise<boolean> {
    // Loop until empty, but never on a flush that sent nothing: a queue that cannot drain (held
    // categories, a dead network) would otherwise keep this waiting until the bound expires.
    for (let round = 0; round < 10 && this.dispatcher.pending > 0; round += 1) {
      const before = this.dispatcher.pending;
      const ok = await this.flush();
      if (!ok || this.dispatcher.pending >= before) return false;
    }

    return this.dispatcher.pending === 0;
  }

  private ready(method: string): boolean {
    if (this.closed) {
      this.logger.warn(`${method}() after close() does nothing`);

      return false;
    }
    if (this.o.inert !== null) {
      this.logger.debug(`${method}(): inert (${this.o.inert})`);

      return false;
    }

    return true;
  }

  private afterCapture(): void {
    if (this.platform.deferred) return;
    if (this.dispatcher.events.length >= this.o.flushAt || this.dispatcher.errors.length >= this.o.flushAt) void this.flush();
    else this.scheduleFlush(this.o.flushIntervalMs);
  }

  private scheduleFlush(ms: number): void {
    if (this.closed || this.flushTimer !== null || this.platform.deferred) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, ms);
    // A pending flush must never keep a script alive past its own work.
    (this.flushTimer as { unref?: () => void }).unref?.();
  }

  private timestampFor(value: EventOptions['timestamp'], name: string): string | null {
    if (value === undefined) return new Date().toISOString();
    const date = value instanceof Date ? value : new Date(value);
    const ms = date.getTime();
    if (!Number.isFinite(ms)) {
      this.logger.warn(`"${name}" has an unreadable timestamp; using now`);

      return new Date().toISOString();
    }
    const now = Date.now();
    if (ms < now - TIMESTAMP_PAST_MS || ms > now + TIMESTAMP_FUTURE_MS) {
      this.logger.warn(`"${name}" was dropped: its timestamp is outside the window the server accepts (7 days back, 1 hour ahead)`);
      this.dispatcher.reports.record('invalid', 'event');

      return null;
    }

    return date.toISOString();
  }

  private guarded<T>(fn: () => T, fallback?: T): T {
    try {
      return fn();
    } catch (error) {
      this.logger.error('internal failure', { error: String(error) });
      try {
        this.o.onError?.(error instanceof Error ? error : new Error(String(error)));
      } catch {
        // The customer's handler threw. Nothing more can be done about that here.
      }

      return fallback as T;
    }
  }
}

/** An id worth sending: 1–64 characters of `[A-Za-z0-9._-]`, never a blocked value. */
function pickId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  if (id.length === 0 || id.length > 64 || !/^[A-Za-z0-9._-]+$/.test(id) || isBlockedId(id)) return undefined;

  return id;
}

function withBound<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    (timer as { unref?: () => void }).unref?.();
  });

  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export type { Entry };
