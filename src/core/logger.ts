/**
 * The "nothing fails silently" channel.
 *
 * Every drop, refusal and no-op in the SDK goes through here at warn level. Two things keep that
 * promise from becoming a liability on a page in a render loop:
 *
 *   - **De-duplication.** The same line is printed once. A loop that drops the same event ten
 *     thousand times produces one warning, not ten thousand.
 *   - **Rate limiting.** Distinct lines are capped per minute, so a genuinely chatty failure cannot
 *     drown the console either.
 *
 * `enter`/`leave` mark when the SDK is inside its own logging, so a console breadcrumb source or
 * a console error capture can tell the SDK's output from the application's and skip it. Without
 * that, a warning about a dropped error becomes a breadcrumb on the next error, which mentions the
 * warning, which becomes a breadcrumb, and so on.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogSink {
  (level: LogLevel, message: string, data?: Record<string, unknown>): void;
}

const MAX_REMEMBERED = 200;
const MAX_PER_MINUTE = 30;

export class Logger {
  private readonly seen = new Set<string>();
  private windowStart = 0;
  private inWindow = 0;
  private depth = 0;

  constructor(
    private readonly sink: LogSink,
    private readonly debugEnabled: boolean,
    private readonly now: () => number = Date.now,
  ) {}

  /** True while the SDK is writing to the sink itself. */
  get isReentrant(): boolean {
    return this.depth > 0;
  }

  /** Verbose diagnostics: only with `debug: true`, never deduplicated. */
  debug(message: string, data?: Record<string, unknown>): void {
    if (!this.debugEnabled) return;
    this.emit('debug', message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    if (!this.debugEnabled) return;
    this.emit('info', message, data);
  }

  /** Something was dropped or refused. Once per distinct message, rate limited. */
  warn(message: string, data?: Record<string, unknown>): void {
    if (!this.admit(message)) return;
    this.emit('warn', message, data);
  }

  /** The SDK cannot do its job at all (a bad key, a missing runtime API). Never suppressed. */
  error(message: string, data?: Record<string, unknown>): void {
    this.emit('error', message, data);
  }

  private admit(message: string): boolean {
    if (this.seen.has(message)) return false;

    const now = this.now();
    if (now - this.windowStart > 60_000) {
      this.windowStart = now;
      this.inWindow = 0;
    }
    if (this.inWindow >= MAX_PER_MINUTE) return false;
    this.inWindow += 1;

    if (this.seen.size >= MAX_REMEMBERED) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.add(message);

    return true;
  }

  private emit(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    this.depth += 1;
    try {
      this.sink(level, `[vinktar] ${message}`, data);
    } catch {
      // A sink that throws must not take the application down with it.
    } finally {
      this.depth -= 1;
    }
  }
}

/** The default sink: the console, which every runtime has. */
export function consoleSink(console: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>): LogSink {
  return (level, message, data) => {
    const fn = console[level] ?? console.warn;
    if (data === undefined) fn.call(console, message);
    else fn.call(console, message, data);
  };
}
