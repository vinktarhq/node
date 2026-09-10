import type { Breadcrumb } from './core/breadcrumbs.js';
import type { Level } from './core/limits.js';
import type { Props } from './core/normalize.js';
import type { Traits } from './core/traits.js';

export type { Breadcrumb, Level, Props, Traits };
export type { Frame } from './core/stack.js';
export type { WireException } from './core/exception.js';
export type { LogLevel, LogSink } from './core/logger.js';

/** Extra detail for one `captureException` / `captureMessage` call. */
export interface CaptureContext {
  readonly level?: Level;
  readonly tags?: Record<string, string>;
  readonly context?: Props;
  /** Group this occurrence under these parts instead of the server's fingerprint. Never per-occurrence. */
  readonly fingerprint?: readonly string[];
  /** `false` for an error the application did not catch. Defaults to `true` for manual captures. */
  readonly handled?: boolean;
  /** The person, when the call site knows better than the scope. */
  readonly userId?: string;
}

/** Per-call identity for `track` / `page`, overriding whatever the scope holds. */
export interface EventOptions {
  readonly userId?: string;
  readonly deviceId?: string;
  readonly sessionId?: string;
  /** ISO string, epoch milliseconds or a Date. Defaults to now. */
  readonly timestamp?: string | number | Date;
}

export interface IdentifyOptions {
  /** Trait keys to remove. */
  readonly unset?: readonly string[];
  /** The browser device this person was seen on, when the server knows it (an inbound header). */
  readonly deviceId?: string;
}

/** What `setUser` accepts: an id plus any traits. */
export type User = { id: string } & Record<string, unknown>;

/** The HTTP request an error happened in, as attached by a framework adapter. */
export interface RequestInfo {
  readonly url?: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly query?: string;
}

/** Event hooks receive the wire event; return it (rewritten or not) or `null` to drop it. */
export type EventHook = (event: Record<string, unknown>) => Record<string, unknown> | null | undefined;
export type CrumbHook = (crumb: Breadcrumb) => Breadcrumb | null | undefined;

/** Reads a source file for context lines; the test seam, and the place to plug in a virtual FS. */
export type SourceReader = (path: string) => string | null;
