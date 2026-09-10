import type { Logger } from '../core/logger.js';

/**
 * Process-wide handlers, installed only when asked (`captureErrors: true` or `registerHandlers()`),
 * because attaching one changes how the process behaves.
 *
 * ## uncaughtException
 *
 * Node exits on an uncaught exception unless a listener exists, and the listener's existence is
 * what stops the exit. So this handler reproduces the default (print, exit 1) after a bounded
 * flush, but ONLY when it is the sole listener: if the application registered its own, it has
 * decided what the process does, and the SDK only observes. The handler is tagged so it can
 * exclude itself from that count. Worker threads never exit the process from here.
 *
 * ## unhandledRejection
 *
 * Node's behaviour depends on `--unhandled-rejections` (a flag or `NODE_OPTIONS`), and installing
 * a listener silently switches every mode to "handled". Under `throw` (the default since 15) a
 * rejection becomes an uncaught exception, which the handler above already sees, so nothing is
 * installed. Under `strict` and `warn-with-error-code` the process semantics belong to the
 * operator and are left alone. Only `warn` and `none`, where Node would merely log, get a listener.
 *
 * ## Signals and exit
 *
 * SIGTERM/SIGINT flush within the shutdown bound and then re-raise the signal if this was the only
 * listener, so the exit code stays what the platform expects. `beforeExit` flushes when the loop
 * drains naturally. `exit` runs the synchronous spool write and nothing else, because nothing
 * asynchronous will ever run again.
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

const TAG = '__vinktar_handler__';

type Tagged = ((...args: never[]) => void) & { [TAG]?: true };

function tag<T extends (...args: never[]) => void>(fn: T): T {
  (fn as Tagged)[TAG] = true;

  return fn;
}

function othersListening(process: ProcessLike, event: string): boolean {
  return process.listeners(event).some((listener) => (listener as Tagged)[TAG] !== true && (listener as { name?: string }).name !== 'domainUncaughtExceptionClear');
}

export function installCrashHandlers(options: HandlerOptions): () => void {
  const { process, logger } = options;
  const restores: Array<() => void> = [];
  let handling = false;

  const onUncaught = tag((error: unknown) => {
    if (handling) return; // an error while reporting an error: let the runtime's default decide
    handling = true;
    options.capture(error, 'uncaughtException');
    const exit = !othersListening(process, 'uncaughtException') && options.isMainThread;
    void withBound(options.flush(), options.shutdownTimeoutMs).finally(() => {
      handling = false;
      if (exit) {
        // Node's own behaviour, reproduced: print the error and exit 1.
        console.error(error);
        process.exit(1);
      }
    });
  });
  process.on('uncaughtException', onUncaught);
  restores.push(() => process.off('uncaughtException', onUncaught));

  const mode = options.unhandledRejections === 'none' ? 'none' : rejectionMode(process);
  if (mode === 'warn' || mode === 'none') {
    const onRejection = tag((reason: unknown) => {
      options.capture(reason, 'unhandledRejection');
      if (mode === 'warn' && !othersListening(process, 'unhandledRejection')) {
        console.warn('(vinktar) UnhandledPromiseRejection:', reason);
      }
    });
    process.on('unhandledRejection', onRejection);
    restores.push(() => process.off('unhandledRejection', onRejection));
  } else {
    logger.debug(`unhandled rejections are left to node (--unhandled-rejections=${mode}); they reach uncaughtException when fatal`);
  }

  return () => {
    for (const restore of restores.splice(0)) restore();
  };
}

export function installLifecycle(options: Pick<HandlerOptions, 'process' | 'flush' | 'shutdownTimeoutMs' | 'onExit' | 'logger'> & { autoFlush: boolean; close: () => Promise<unknown> }): () => void {
  const { process } = options;
  const restores: Array<() => void> = [];

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    const onSignal = tag(() => {
      const sole = !othersListening(process, signal);
      void withBound(options.close(), options.shutdownTimeoutMs).finally(() => {
        // Only the last listener standing re-raises: the platform then sees the signal it sent.
        if (sole) {
          process.off(signal, onSignal);
          process.kill(process.pid, signal);
        }
      });
    });
    process.on(signal, onSignal);
    restores.push(() => process.off(signal, onSignal));
  }

  if (options.autoFlush) {
    const onBeforeExit = tag(() => {
      void options.flush();
    });
    process.on('beforeExit', onBeforeExit);
    restores.push(() => process.off('beforeExit', onBeforeExit));
  }

  const onExit = tag(() => options.onExit());
  process.on('exit', onExit);
  restores.push(() => process.off('exit', onExit));

  return () => {
    for (const restore of restores.splice(0)) restore();
  };
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
