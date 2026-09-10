import { toHookList } from './core/hooks.js';
import { MAX_DEPTH, MAX_STRING_BYTES } from './core/limits.js';
import { consoleSink, Logger, type LogSink } from './core/logger.js';
import type { Props } from './core/normalize.js';
import type { CrumbHook, EventHook } from './types.js';

/**
 * Everything `init()` accepts. Numbers are clamped with a warning rather than taken verbatim.
 *
 * Unlike the browser, a missing key here is a thrown `TypeError`: a server process with no key
 * is misconfigured, not a visitor who has not consented, and a silent no-op would be found in a
 * dashboard weeks later rather than in the first deploy's logs.
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

  /** Seeded on the root scope and re-applied by `reset()`. */
  initialScope?: { userId?: string; deviceId?: string; sessionId?: string; tags?: Record<string, string>; context?: Props };

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
  'spoolPath', 'autoFlush', 'captureErrors', 'unhandledRejections', 'breadcrumbs', 'maxBreadcrumbs', 'sampleRate',
  'errorSampleRate', 'maxErrorsPerMinute', 'maxEventsPerMinute', 'dedupe', 'ignoreErrors', 'superProperties',
  'sendDefaultPii', 'redactedKeys', 'propertyDenylist', 'maxValueBytes', 'normalizeDepth', 'includeRawStack',
  'attachStacktrace', 'projectRoot', 'contextLines', 'beforeSend', 'beforeTrack', 'beforeBreadcrumb', 'onError', 'logger',
  'fetch',
]);

export function makeLogger(options: VinktarOptions): Logger {
  const sink: LogSink = typeof options.logger === 'function' ? options.logger : consoleSink(console);

  return new Logger(sink, options.debug === true);
}

export function resolve(options: VinktarOptions, environment: Environment, logger: Logger): Resolved {
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
    logger.warn(message);
  };

  for (const key of Object.keys(options)) {
    if (!KNOWN.has(key as keyof VinktarOptions)) warn(`unknown option "${key}" was ignored`);
  }

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
  const hooks = <T>(name: string, value: T | T[] | undefined): T[] =>
    toHookList(value as never, (index) => warn(`${name}[${index}] is not a function and was dropped`)) as T[];
  const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value.trim() : fallback);

  const writeKey = text(options.writeKey ?? options.key ?? environment.env('VINKTAR_KEY'));
  if (writeKey === '') {
    throw new TypeError('[vinktar] no write key: pass { writeKey } to init() or set VINKTAR_KEY');
  }
  if (!writeKey.startsWith('vnk_pk_') && !writeKey.startsWith('vnk_sk_')) {
    warn('the write key does not look like a Vinktar key (vnk_pk_… or vnk_sk_…)');
  }

  let inert: string | null = null;
  const enabled = options.enabled ?? true;
  if (!enabled) inert = 'enabled is false';

  const environmentName = text(options.environment) || text(environment.env('VINKTAR_ENVIRONMENT')) || text(environment.env('NODE_ENV')) || 'production';
  const enabledEnvironments = list<string>('enabledEnvironments', options.enabledEnvironments).map(String);
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
  const initial = options.initialScope ?? {};

  const resolved: Resolved = {
    writeKey,
    host: normalizeHost(options.host ?? environment.env('VINKTAR_HOST'), warn),
    enabled,
    debug: options.debug === true,
    analytics: options.analytics ?? true,
    errors: options.errors ?? true,
    release: text(options.release) || text(environment.env('VINKTAR_RELEASE')),
    environment: environmentName,
    enabledEnvironments,
    serverName: text(options.serverName) || environment.hostname(),
    initialScope: {
      ...(typeof initial.userId === 'string' ? { userId: initial.userId } : {}),
      ...(typeof initial.deviceId === 'string' ? { deviceId: initial.deviceId } : {}),
      ...(typeof initial.sessionId === 'string' ? { sessionId: initial.sessionId } : {}),
      tags: { ...(initial.tags ?? {}) },
      context: { ...(initial.context ?? {}) },
    },
    flushAt,
    flushIntervalMs: clamp('flushIntervalMs', options.flushIntervalMs, 100, 300_000, 10_000),
    maxQueueSize,
    requestTimeoutMs: clamp('requestTimeoutMs', options.requestTimeoutMs, 500, 60_000, 5_000),
    gzip: options.gzip ?? true,
    shutdownTimeout: clamp('shutdownTimeout', options.shutdownTimeout, 100, 60_000, 2_000),
    spoolPath: text(options.spoolPath),
    autoFlush: options.autoFlush ?? true,
    captureErrors: options.captureErrors ?? false,
    unhandledRejections: options.unhandledRejections === 'none' ? 'none' : 'auto',
    breadcrumbs: typeof crumbs === 'object' ? { console: crumbs.console ?? true, http: crumbs.http ?? true } : { console: crumbs, http: crumbs },
    maxBreadcrumbs: clamp('maxBreadcrumbs', options.maxBreadcrumbs, 0, 50, 50),
    sampleRate: clamp('sampleRate', options.sampleRate, 0, 1, 1),
    errorSampleRate: clamp('errorSampleRate', options.errorSampleRate, 0, 1, 1),
    maxErrorsPerMinute: clamp('maxErrorsPerMinute', options.maxErrorsPerMinute, 1, 10_000, 100),
    maxEventsPerMinute: clamp('maxEventsPerMinute', options.maxEventsPerMinute, 1, 600_000, 6000),
    dedupe: options.dedupe ?? true,
    ignoreErrors: list('ignoreErrors', options.ignoreErrors),
    superProperties: typeof options.superProperties === 'object' && options.superProperties !== null ? options.superProperties : {},
    sendDefaultPii: options.sendDefaultPii ?? false,
    redactedKeys: list<string>('redactedKeys', options.redactedKeys).map(String),
    propertyDenylist: list<string>('propertyDenylist', options.propertyDenylist).map(String),
    maxValueBytes: clamp('maxValueBytes', options.maxValueBytes, 16, MAX_STRING_BYTES, MAX_STRING_BYTES),
    normalizeDepth: clamp('normalizeDepth', options.normalizeDepth, 1, MAX_DEPTH, MAX_DEPTH),
    includeRawStack: options.includeRawStack ?? false,
    attachStacktrace: options.attachStacktrace ?? false,
    projectRoot: text(options.projectRoot) || environment.cwd(),
    contextLines: clamp('contextLines', options.contextLines, 0, 20, 5),
    beforeSend: hooks('beforeSend', options.beforeSend),
    beforeTrack: hooks('beforeTrack', options.beforeTrack),
    beforeBreadcrumb: hooks('beforeBreadcrumb', options.beforeBreadcrumb),
    onError: typeof options.onError === 'function' ? options.onError : undefined,
    fetch: typeof options.fetch === 'function' ? options.fetch : undefined,
    inert,
    warnings,
  };

  if (inert !== null) logger.warn(`inert: ${inert}`);

  return resolved;
}

function normalizeHost(host: unknown, warn: (m: string) => void): string {
  if (host === undefined || host === '') return DEFAULT_HOST;
  const text = String(host).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(text)) {
    warn(`host "${text}" is not an http(s) URL; using ${DEFAULT_HOST}`);

    return DEFAULT_HOST;
  }

  return text;
}
