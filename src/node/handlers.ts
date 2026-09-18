import type { Logger } from '../core/logger.js';

/**
 * Process-wide handlers, installed only when asked (`captureErrors: true` or `registerHandlers()`),
 * because attaching one changes how the process behaves.
 *
 * ## One set of listeners per process
 *
 * Every client registers with a single coordinator for its process, and the coordinator owns the
 * listeners. Two clients therefore produce one exit after a crash (after both have flushed), and
 * one re-raised signal (after both have closed), instead of the first client to finish exiting
 * the process under the second. The coordinator lives on `globalThis`, so the CommonJS and ES
 * module builds of this package, loaded side by side, share it too.
 *
 * ## uncaughtException
 *
 * Node exits on an uncaught exception unless a listener exists, and the listener's existence is
 * what stops the exit. So this handler reproduces the default (print, exit 1) after a bounded
 * flush, but ONLY when no listener outside the SDK exists: if the application registered its own,
 * it has decided what the process does, and the SDK only observes. In a worker thread, where the
 * default is that the thread stops and its `Worker` emits the error, the handler removes itself
 * and throws the error again, so the thread ends the way it would have without the SDK.
 *
 * ## unhandledRejection
 *
 * Node's behaviour depends on `--unhandled-rejections` (a flag or `NODE_OPTIONS`), and installing
 * a listener silently switches every mode to "handled". Under `throw` (the default since 15) a
 * rejection becomes an uncaught exception, which the handler above already sees, so nothing is
 * installed. Under `strict` and `warn-with-error-code` the process semantics belong to the
 * operator and are left alone. Only where Node would merely log (`warn`, `none`) is a listener
 * installed, and never for a client configured with `unhandledRejections: 'none'`.
 *
 * ## Signals and exit
 *
 * SIGTERM/SIGINT close every client within the shutdown bound and then re-raise the signal if no
 * listener outside the SDK exists, so the exit code stays what the platform expects.
 * `beforeExit` flushes when the loop drains naturally. `exit` runs the synchronous spool writes and
 * nothing else, because nothing asynchronous will ever run again.
 */
export interface ProcessLike {
  on(event: string, listener: (...args: never[]) => void): unknown;
  off(event: string, listener: (...args: never[]) => void): unknown;
  listeners(event: string): unknown[];
  exit(code?: number): never;
  kill(pid: number, signal: string): unknown;
  readonly pid: number;
  readonly execArgv: readonly string[];
  readonly env: Record<string, string | undefined>;
}

export interface HandlerOptions {
  readonly process: ProcessLike;
  readonly isMainThread: boolean;
  readonly logger: Logger;
  readonly shutdownTimeoutMs: number;
  readonly capture: (error: unknown, mechanism: 'uncaughtException' | 'unhandledRejection') => void;
  /** Bounded flush; resolves when done or when the bound is hit. */
  readonly flush: () => Promise<unknown>;
  readonly onExit: () => void;
  readonly unhandledRejections: 'auto' | 'none';
}

export interface LifecycleOptions {
  readonly process: ProcessLike;
  readonly logger: Logger;
  readonly shutdownTimeoutMs: number;
  readonly autoFlush: boolean;
  /** Close on SIGTERM/SIGINT. Off for an application that runs its own shutdown and calls close() itself. */
  readonly signals?: boolean;
  readonly flush: () => Promise<unknown>;
  readonly close: () => Promise<unknown>;
  readonly onExit: () => void;
}

const TAG = '__vinktar_handler__';
const REGISTRY = Symbol.for('vinktar.node.process-handlers');
const SIGNALS = ['SIGTERM', 'SIGINT'] as const;

type Listener = ((...args: never[]) => void) & { [TAG]?: true };

function tag<T extends (...args: never[]) => void>(fn: T): T {
  (fn as Listener)[TAG] = true;

  return fn;
}

function othersListening(process: ProcessLike, event: string): boolean {
  return process.listeners(event).some((listener) => (listener as Listener)[TAG] !== true && (listener as { name?: string }).name !== 'domainUncaughtExceptionClear');
}

class Coordinator {
  private readonly crash = new Set<HandlerOptions>();
  private readonly lifecycle = new Set<LifecycleOptions>();
  private readonly installed = new Map<string, Listener>();
  private handling = false;
  private warnedRejection = false;

  constructor(private readonly process: ProcessLike) {}

  addCrash(options: HandlerOptions): () => void {
    this.crash.add(options);
    this.sync(options.logger);

    return () => {
      this.crash.delete(options);
      this.sync(options.logger);
    };
  }

  addLifecycle(options: LifecycleOptions): () => void {
    this.lifecycle.add(options);
    this.sync(options.logger);

    return () => {
      this.lifecycle.delete(options);
      this.sync(options.logger);
    };
  }

  private sync(logger: Logger): void {
    this.toggle('uncaughtException', this.crash.size > 0, () => tag((error: unknown, origin?: unknown) => this.onUncaught(error, origin)));

    const mode = rejectionMode(this.process);
    const wantsRejections = [...this.crash].some((options) => options.unhandledRejections !== 'none');
    const rejectionsApply = mode === 'warn' || mode === 'none';
    if (wantsRejections && !rejectionsApply && !this.installed.has('unhandledRejection')) {
      logger.debug(`unhandled rejections are left to node (--unhandled-rejections=${mode}); they reach uncaughtException when fatal`);
    }
    this.toggle('unhandledRejection', wantsRejections && rejectionsApply, () => tag((reason: unknown) => this.onRejection(reason, mode)));

    const signalled = [...this.lifecycle].some((options) => options.signals !== false);
    for (const signal of SIGNALS) this.toggle(signal, signalled, () => tag(() => this.onSignal(signal)));
    this.toggle('beforeExit', [...this.lifecycle].some((options) => options.autoFlush), () =>
      tag(() => {
        for (const options of this.lifecycle) if (options.autoFlush) void options.flush();
      }),
    );
    this.toggle('exit', this.lifecycle.size > 0, () =>
      tag(() => {
        for (const options of this.lifecycle) {
          try {
            options.onExit();
          } catch {
            // The next client's spool still gets written.
          }
        }
      }),
    );
  }

  private toggle(event: string, wanted: boolean, make: () => Listener): void {
    const existing = this.installed.get(event);
    if (wanted && existing === undefined) {
      const listener = make();
      this.installed.set(event, listener);
      this.process.on(event, listener);
    } else if (!wanted && existing !== undefined) {
      this.installed.delete(event);
      this.process.off(event, existing);
    }
  }

  private onUncaught(error: unknown, origin: unknown): void {
    if (this.handling) {
      // A second one while the first is still being flushed. It is not reported (the process is
      // already on its way out), but it is printed, as node would have printed it.
      try {
        console.error(error);
      } catch {
        // No console to print to.
      }

      return;
    }
    this.handling = true;
    const clients = [...this.crash];
    // Under Node's default --unhandled-rejections=throw, a rejection nobody handled arrives here.
    const mechanism = origin === 'unhandledRejection' ? 'unhandledRejection' : 'uncaughtException';
    for (const options of clients) options.capture(error, mechanism);
    const sole = !othersListening(this.process, 'uncaughtException');
    const mainThread = clients.some((options) => options.isMainThread);
    const bound = Math.max(0, ...clients.map((options) => options.shutdownTimeoutMs));

    void withBound(Promise.allSettled(clients.map((options) => options.flush())), bound).finally(() => {
      this.handling = false;
      if (!sole) return;
      if (mainThread) {
        // Node's own behaviour, reproduced: print the error and exit 1.
        console.error(error);
        this.process.exit(1);

        return;
      }
      // In a worker thread the default is not an exit: the thread stops and its Worker emits the
      // error to the parent. Stepping aside and throwing the same error again is exactly that.
      const listener = this.installed.get('uncaughtException');
      if (listener !== undefined) {
        this.installed.delete('uncaughtException');
        this.process.off('uncaughtException', listener);
      }
      setImmediate(() => {
        throw error;
      });
    });
  }

  private onRejection(reason: unknown, mode: string): void {
    for (const options of this.crash) if (options.unhandledRejections !== 'none') options.capture(reason, 'unhandledRejection');
    if (mode === 'warn' && !othersListening(this.process, 'unhandledRejection') && !this.warnedRejection) {
      this.warnedRejection = true;
      console.warn('(vinktar) UnhandledPromiseRejection:', reason);
    }
  }

  private onSignal(signal: (typeof SIGNALS)[number]): void {
    const clients = [...this.lifecycle].filter((options) => options.signals !== false);
    const sole = !othersListening(this.process, signal);
    const bound = Math.max(0, ...clients.map((options) => options.shutdownTimeoutMs));

    void withBound(Promise.allSettled(clients.map((options) => options.close())), bound).finally(() => {
      // Re-raised once, and only when nothing else is listening: the platform then sees the signal it sent.
      if (!sole) return;
      const listener = this.installed.get(signal);
      if (listener !== undefined) {
        this.installed.delete(signal);
        this.process.off(signal, listener);
      }
      this.process.kill(this.process.pid, signal);
    });
  }
}

function coordinatorFor(process: ProcessLike): Coordinator {
  const holder = globalThis as unknown as Record<symbol, WeakMap<object, Coordinator> | undefined>;
  const registry = (holder[REGISTRY] ??= new WeakMap<object, Coordinator>());
  let coordinator = registry.get(process);
  if (coordinator === undefined) {
    coordinator = new Coordinator(process);
    registry.set(process, coordinator);
  }

  return coordinator;
}

/** Register a client's crash handling. Returns the teardown. */
export function installCrashHandlers(options: HandlerOptions): () => void {
  return coordinatorFor(options.process).addCrash(options);
}

/** Register a client's signal, `beforeExit` and `exit` handling. Returns the teardown. */
export function installLifecycle(options: LifecycleOptions): () => void {
  return coordinatorFor(options.process).addLifecycle(options);
}

/** Node's effective `--unhandled-rejections` mode: flags win over NODE_OPTIONS, last one wins. */
export function rejectionMode(process: Pick<ProcessLike, 'execArgv' | 'env'>): 'throw' | 'strict' | 'warn' | 'warn-with-error-code' | 'none' {
  const values: string[] = [];
  for (const source of [splitNodeOptions(process.env['NODE_OPTIONS'] ?? ''), process.execArgv]) {
    for (let i = 0; i < source.length; i += 1) {
      const arg = source[i]!;
      const match = /^--unhandled[-_]rejections(?:=(.*))?$/.exec(arg);
      if (match === null) continue;
      const value = match[1] ?? source[i + 1] ?? '';
      values.push(value);
    }
  }
  const last = values[values.length - 1];
  switch (last) {
    case 'strict':
    case 'warn':
    case 'none':
    case 'warn-with-error-code':
      return last;
    default:
      return 'throw';
  }
}

/** NODE_OPTIONS is a shell-ish string: quotes group, backslashes escape. */
export function splitNodeOptions(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && i + 1 < text.length) current += text[++i];
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === '\\' && i + 1 < text.length) {
      current += text[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) out.push(current);
      current = '';
      has = false;
    } else {
      current += ch;
      has = true;
    }
  }
  if (has) out.push(current);

  return out;
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
