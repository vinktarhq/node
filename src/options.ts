import { toPatterns } from './core/filters.js';
import { isObject, readOptions as readKnown, safeString } from './core/guard.js';
import { toHookList } from './core/hooks.js';
import { MAX_DEPTH, MAX_STRING_BYTES } from './core/limits.js';
import { consoleSink, Logger, type LogSink } from './core/logger.js';
import type { Props } from './core/normalize.js';
import type { AsyncLocalStorageLike } from './node/scope.js';
import type { CrumbHook, EventHook } from './types.js';

/**
 * Everything `init()` accepts. Numbers are clamped with a warning rather than taken verbatim.
 *
 * Nothing here throws, a missing key included. A server process with no key is misconfigured, and
 * it is told so once, at error level, in the first deploy's logs; then the client is inert, exactly
 * as if it had been switched off. Taking the service down over its analytics key would be the SDK
 * breaking the application, which is the one thing it must never do.
 */
export interface VinktarOptions {
  /** The project's write key. Falls back to `VINKTAR_KEY`. */
  writeKey?: string;
  /** Alias of `writeKey`. */
  key?: string;
  /** Ingest host. Falls back to `VINKTAR_HOST`, then `https://in.vinktar.com`. */
  host?: string;
  enabled?: boolean;
  debug?: boolean;

  analytics?: boolean;
  errors?: boolean;

  /** Falls back to `VINKTAR_RELEASE`. */
  release?: string;
  /** Falls back to `VINKTAR_ENVIRONMENT`, then `NODE_ENV`, then `production`. */
  environment?: string;
  enabledEnvironments?: string[];
  /** Names the service on every error. Defaults to the hostname. */
  serverName?: string;

  /**
   * Tags and context for every scope, applied again by `reset()`. An identity given here is set on
   * the root scope once, for work outside any request; fresh request scopes and `reset()` never
   * inherit it.
   */
  initialScope?: { userId?: string; deviceId?: string; sessionId?: string; tags?: Record<string, string>; context?: Props };
  /**
   * The `AsyncLocalStorage` class, for a runtime that has one but does not expose it globally
   * (Cloudflare Workers: `import { AsyncLocalStorage } from 'node:async_hooks'`).
   */
  asyncLocalStorage?: new () => AsyncLocalStorageLike;

  flushAt?: number;
  flushIntervalMs?: number;
  maxQueueSize?: number;
  requestTimeoutMs?: number;
  gzip?: boolean;
  /** Bound on the final flush in `close()` and on the crash path. */
  shutdownTimeout?: number;
  /** Opt-in disk spool for what could not be sent before exit. A file path. */
  spoolPath?: string;
  /** Flush on `beforeExit`. */
  autoFlush?: boolean;
  /**
   * Close on SIGTERM/SIGINT, then re-raise the signal when nothing else is listening. Turn off when
   * the application runs its own shutdown sequence and calls `close()` from it.
   */
  handleSignals?: boolean;

  /** Install process-wide handlers for uncaught exceptions and unhandled rejections. */
  captureErrors?: boolean;
  /** `none` leaves unhandled rejections alone even when `captureErrors` is on. */
  unhandledRejections?: 'auto' | 'none';

  breadcrumbs?: boolean | { console?: boolean; http?: boolean };
  maxBreadcrumbs?: number;

  sampleRate?: number;
  errorSampleRate?: number;
  maxErrorsPerMinute?: number;
  maxEventsPerMinute?: number;
  dedupe?: boolean;
  ignoreErrors?: Array<string | RegExp>;

  superProperties?: Props;
  /** Keep full URLs and request headers beyond the safe set. */
  sendDefaultPii?: boolean;
  redactedKeys?: string[];
  propertyDenylist?: string[];
  maxValueBytes?: number;
  normalizeDepth?: number;
  includeRawStack?: boolean;
  attachStacktrace?: boolean;

  /** Frames under this directory are in-app. Defaults to the working directory. */
  projectRoot?: string;
  /** Lines of source around each in-app frame. 0 turns it off. */
  contextLines?: number;

  beforeSend?: EventHook | EventHook[];
  beforeTrack?: EventHook | EventHook[];
  beforeBreadcrumb?: CrumbHook | CrumbHook[];
  onError?: (error: Error) => void;
  logger?: LogSink;
  /** The `fetch` to send with, for a proxy or a test double. */
  fetch?: typeof fetch;
}

export interface Resolved {
  readonly writeKey: string;
  readonly host: string;
  readonly enabled: boolean;
  readonly debug: boolean;
  readonly analytics: boolean;
  readonly errors: boolean;
  readonly release: string;
  readonly environment: string;
  readonly enabledEnvironments: readonly string[];
  readonly serverName: string;
  readonly initialScope: { userId?: string; deviceId?: string; sessionId?: string; tags: Record<string, string>; context: Props };
  readonly flushAt: number;
  readonly flushIntervalMs: number;
  readonly maxQueueSize: number;
  readonly requestTimeoutMs: number;
  readonly gzip: boolean;
  readonly shutdownTimeout: number;
  readonly spoolPath: string;
  readonly autoFlush: boolean;
  readonly handleSignals: boolean;
  readonly captureErrors: boolean;
  readonly unhandledRejections: 'auto' | 'none';
  readonly breadcrumbs: { console: boolean; http: boolean };
  readonly maxBreadcrumbs: number;
  readonly sampleRate: number;
  readonly errorSampleRate: number;
  readonly maxErrorsPerMinute: number;
  readonly maxEventsPerMinute: number;
  readonly dedupe: boolean;
  readonly ignoreErrors: ReadonlyArray<string | RegExp>;
  readonly superProperties: Props;
  readonly sendDefaultPii: boolean;
  readonly redactedKeys: readonly string[];
  readonly propertyDenylist: readonly string[];
  readonly maxValueBytes: number;
  readonly normalizeDepth: number;
  readonly includeRawStack: boolean;
  readonly attachStacktrace: boolean;
  readonly projectRoot: string;
  readonly contextLines: number;
  readonly beforeSend: readonly EventHook[];
  readonly beforeTrack: readonly EventHook[];
  readonly beforeBreadcrumb: readonly CrumbHook[];
  readonly onError: ((error: Error) => void) | undefined;
  readonly fetch: typeof fetch | undefined;
  readonly asyncLocalStorage: (new () => AsyncLocalStorageLike) | undefined;
  /** Why the SDK will not send, when it will not. */
  readonly inert: string | null;
  readonly warnings: readonly string[];
}

export const DEFAULT_HOST = 'https://in.vinktar.com';

/** What the runtime can tell `resolve()` about itself. */
export interface Environment {
  readonly env: (name: string) => string | undefined;
  readonly hostname: () => string;
  readonly cwd: () => string;
}

const KNOWN = new Set<keyof VinktarOptions>([
  'writeKey', 'key', 'host', 'enabled', 'debug', 'analytics', 'errors', 'release', 'environment', 'enabledEnvironments',
  'serverName', 'initialScope', 'flushAt', 'flushIntervalMs', 'maxQueueSize', 'requestTimeoutMs', 'gzip', 'shutdownTimeout',
  'spoolPath', 'autoFlush', 'handleSignals', 'captureErrors', 'unhandledRejections', 'breadcrumbs', 'maxBreadcrumbs', 'sampleRate',
  'errorSampleRate', 'maxErrorsPerMinute', 'maxEventsPerMinute', 'dedupe', 'ignoreErrors', 'superProperties',
  'sendDefaultPii', 'redactedKeys', 'propertyDenylist', 'maxValueBytes', 'normalizeDepth', 'includeRawStack',
  'attachStacktrace', 'projectRoot', 'contextLines', 'beforeSend', 'beforeTrack', 'beforeBreadcrumb', 'onError', 'logger',
  'fetch', 'asyncLocalStorage',
]);

/** What `init()` was handed, as options that are safe to read. A bare string is the write key. */
export function readOptions(given: unknown): { options: VinktarOptions; problems: string[] } {
  return typeof given === 'string' ? { options: { writeKey: given }, problems: [] } : readKnown(given, KNOWN);
}

export function makeLogger(options: VinktarOptions): Logger {
  const sink: LogSink = typeof options.logger === 'function' ? options.logger : consoleSink(console);

  return new Logger(sink, options.debug === true);
}

/**
 * @param options what `readOptions` returned, never what the application passed
 * @param broken set when the options could not be resolved at all: the client is inert for that reason
 */
export function resolve(options: VinktarOptions, environment: Environment, logger: Logger, broken?: string): Resolved {
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
    logger.warn(message);
  };
  const env = (name: string): string | undefined => {
    try {
      const value = environment.env(name);

      return typeof value === 'string' ? value : undefined;
    } catch {
      return undefined;
    }
  };

  const clamp = (name: string, value: unknown, min: number, max: number, fallback: number): number => {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      warn(`${name} must be a number; using ${fallback}`);

      return fallback;
    }
    if (value < min || value > max) {
      const clamped = Math.min(max, Math.max(min, value));
      warn(`${name} ${value} is outside ${min}–${max}; using ${clamped}`);

      return clamped;
    }

    return value;
  };
  const list = <T>(name: string, value: unknown): T[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      warn(`${name} must be an array; ignored`);

      return [];
    }

    return value as T[];
  };
  /** Strings only: `String(null)` in a list of key fragments would redact every key containing "null". */
  const strings = (name: string, value: unknown): string[] =>
    list<unknown>(name, value).filter((entry, index): entry is string => {
      if (typeof entry !== 'string') warn(`${name}[${index}] is not a string and was dropped`);

      return typeof entry === 'string';
    });
  const patterns = (name: string, value: unknown): Array<string | RegExp> =>
    toPatterns(list(name, value), (index) => warn(`${name}[${index}] is not a string or a RegExp and was dropped`));
  const hooks = <T>(name: string, value: T | T[] | undefined): T[] =>
    toHookList(value as never, (index) => warn(`${name}[${index}] is not a function and was dropped`)) as T[];
  const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value.trim() : fallback);

  const enabled = options.enabled ?? true;
  const writeKey = text(options.writeKey ?? options.key ?? env('VINKTAR_KEY'));
  if (writeKey !== '' && !writeKey.startsWith('vnk_pk_') && !writeKey.startsWith('vnk_sk_')) {
    warn('the write key does not look like a Vinktar key (vnk_pk_… or vnk_sk_…)');
  }

  let inert: string | null = broken ?? null;
  if (!enabled) inert ??= 'enabled is false';
  // A client switched off on purpose needs no key. One that is meant to send and has none is a
  // deployment mistake: said once, at error level, where someone is looking, and then the client
  // is as inert as a disabled one.
  const keyless = inert === null && writeKey === '';
  if (keyless) inert = 'no write key';

  const environmentName = text(options.environment) || text(env('VINKTAR_ENVIRONMENT')) || text(env('NODE_ENV')) || 'production';
  const enabledEnvironments = strings('enabledEnvironments', options.enabledEnvironments);
  if (enabledEnvironments.length > 0 && !enabledEnvironments.includes(environmentName)) {
    inert ??= `environment "${environmentName}" is not in enabledEnvironments`;
  }

  const flushAt = clamp('flushAt', options.flushAt, 1, 1000, 20);
  let maxQueueSize = clamp('maxQueueSize', options.maxQueueSize, 1, 100_000, 1000);
  if (maxQueueSize < flushAt) {
    warn(`maxQueueSize ${maxQueueSize} is below flushAt ${flushAt}; raised to match`);
    maxQueueSize = flushAt;
  }
  const crumbs = options.breadcrumbs ?? true;
  const initial = isObject(options.initialScope) ? options.initialScope : {};

  const resolved: Resolved = {
    writeKey,
    host: normalizeHost(options.host ?? env('VINKTAR_HOST'), warn),
    enabled,
    debug: options.debug === true,
    analytics: options.analytics ?? true,
    errors: options.errors ?? true,
    release: text(options.release) || text(env('VINKTAR_RELEASE')),
    environment: environmentName,
    enabledEnvironments,
    serverName: text(options.serverName) || from(environment.hostname),
    initialScope: {
      ...(typeof initial.userId === 'string' ? { userId: initial.userId } : {}),
      ...(typeof initial.deviceId === 'string' ? { deviceId: initial.deviceId } : {}),
      ...(typeof initial.sessionId === 'string' ? { sessionId: initial.sessionId } : {}),
      tags: isObject(initial.tags) ? { ...initial.tags } : {},
      context: isObject(initial.context) ? { ...initial.context } : {},
    },
    flushAt,
    flushIntervalMs: clamp('flushIntervalMs', options.flushIntervalMs, 100, 300_000, 10_000),
    maxQueueSize,
    requestTimeoutMs: clamp('requestTimeoutMs', options.requestTimeoutMs, 500, 60_000, 5_000),
    gzip: options.gzip ?? true,
    shutdownTimeout: clamp('shutdownTimeout', options.shutdownTimeout, 100, 60_000, 2_000),
    spoolPath: text(options.spoolPath),
    autoFlush: options.autoFlush ?? true,
    handleSignals: options.handleSignals ?? true,
    captureErrors: options.captureErrors ?? false,
    unhandledRejections: options.unhandledRejections === 'none' ? 'none' : 'auto',
    breadcrumbs: typeof crumbs === 'object' ? { console: crumbs.console ?? true, http: crumbs.http ?? true } : { console: crumbs, http: crumbs },
    maxBreadcrumbs: clamp('maxBreadcrumbs', options.maxBreadcrumbs, 0, 50, 50),
    sampleRate: clamp('sampleRate', options.sampleRate, 0, 1, 1),
    errorSampleRate: clamp('errorSampleRate', options.errorSampleRate, 0, 1, 1),
    maxErrorsPerMinute: clamp('maxErrorsPerMinute', options.maxErrorsPerMinute, 1, 10_000, 100),
    maxEventsPerMinute: clamp('maxEventsPerMinute', options.maxEventsPerMinute, 1, 600_000, 6000),
    dedupe: options.dedupe ?? true,
    ignoreErrors: patterns('ignoreErrors', options.ignoreErrors),
    superProperties: isObject(options.superProperties) ? options.superProperties : {},
    sendDefaultPii: options.sendDefaultPii ?? false,
    redactedKeys: strings('redactedKeys', options.redactedKeys),
    propertyDenylist: strings('propertyDenylist', options.propertyDenylist),
    maxValueBytes: clamp('maxValueBytes', options.maxValueBytes, 16, MAX_STRING_BYTES, MAX_STRING_BYTES),
    normalizeDepth: clamp('normalizeDepth', options.normalizeDepth, 1, MAX_DEPTH, MAX_DEPTH),
    includeRawStack: options.includeRawStack ?? false,
    attachStacktrace: options.attachStacktrace ?? false,
    projectRoot: text(options.projectRoot) || from(environment.cwd),
    contextLines: clamp('contextLines', options.contextLines, 0, 20, 5),
    beforeSend: hooks('beforeSend', options.beforeSend),
    beforeTrack: hooks('beforeTrack', options.beforeTrack),
    beforeBreadcrumb: hooks('beforeBreadcrumb', options.beforeBreadcrumb),
    onError: typeof options.onError === 'function' ? options.onError : undefined,
    fetch: typeof options.fetch === 'function' ? options.fetch : undefined,
    asyncLocalStorage: typeof options.asyncLocalStorage === 'function' ? options.asyncLocalStorage : undefined,
    inert,
    warnings,
  };

  if (keyless) logger.error('no write key: pass { writeKey } to init() or set VINKTAR_KEY. Nothing will be sent until there is one');
  else if (inert !== null) logger.warn(`inert: ${inert}`);

  return resolved;
}

/** What the runtime says about itself, or nothing: `process.cwd()` throws when the directory is gone. */
function from(read: () => string): string {
  try {
    const value = read();

    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

function normalizeHost(host: unknown, warn: (m: string) => void): string {
  if (host === undefined || host === '') return DEFAULT_HOST;
  const text = safeString(host).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(text)) {
    warn(`host "${text}" is not an http(s) URL; using ${DEFAULT_HOST}`);

    return DEFAULT_HOST;
  }

  return text;
}
