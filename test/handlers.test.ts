import { describe, expect, it, vi } from 'vitest';

import { Logger } from '../src/core/logger.js';
import { installCrashHandlers, installLifecycle, rejectionMode, splitNodeOptions, type ProcessLike } from '../src/node/handlers.js';

class FakeProcess implements ProcessLike {
  readonly handlers = new Map<string, Array<(...args: never[]) => void>>();
  exited: number | null = null;
  killed: string | null = null;
  readonly pid = 42;
  execArgv: string[] = [];
  env: Record<string, string | undefined> = {};

  on(event: string, listener: (...args: never[]) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);

    return this;
  }
  off(event: string, listener: (...args: never[]) => void): this {
    this.handlers.set(event, (this.handlers.get(event) ?? []).filter((l) => l !== listener));

    return this;
  }
  listeners(event: string): unknown[] {
    return this.handlers.get(event) ?? [];
  }
  exit(code?: number): never {
    // A real exit never returns; here it only records, so the handler's promise chain settles.
    this.exited = code ?? 0;

    return undefined as never;
  }
  kill(_pid: number, signal: string): void {
    this.killed = signal;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners(event)) (listener as (...a: unknown[]) => void)(...args);
  }
}

const logger = new Logger(() => {}, false);

describe('uncaughtException', () => {
  it('captures, flushes, and exits only when it is the sole listener', async () => {
    const process = new FakeProcess();
    const captured: string[] = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    installCrashHandlers({
      process,
      isMainThread: true,
      logger,
      shutdownTimeoutMs: 100,
      capture: (error, mechanism) => captured.push(`${mechanism}:${(error as Error).message}`),
      flush: () => Promise.resolve(true),
      onExit: () => {},
      unhandledRejections: 'auto',
    });
    process.emit('uncaughtException', new Error('fatal'));
    await new Promise((r) => setTimeout(r, 10));
    expect(captured).toEqual(['uncaughtException:fatal']);
    expect(process.exited).toBe(1);
  });

  it('does not exit when the application has its own listener', async () => {
    const process = new FakeProcess();
    process.on('uncaughtException', () => {});
    installCrashHandlers({
      process, isMainThread: true, logger, shutdownTimeoutMs: 100, capture: () => {}, flush: () => Promise.resolve(true), onExit: () => {}, unhandledRejections: 'auto',
    });
    process.emit('uncaughtException', new Error('handled elsewhere'));
    await new Promise((r) => setTimeout(r, 10));
    expect(process.exited).toBeNull();
  });

  it('leaves unhandled rejections to node under throw and strict modes', () => {
    const process = new FakeProcess();
    process.execArgv = ['--unhandled-rejections=strict'];
    installCrashHandlers({
      process, isMainThread: true, logger, shutdownTimeoutMs: 100, capture: () => {}, flush: () => Promise.resolve(true), onExit: () => {}, unhandledRejections: 'auto',
    });
    expect(process.listeners('unhandledRejection')).toHaveLength(0);
    const warnProcess = new FakeProcess();
    warnProcess.env['NODE_OPTIONS'] = '--unhandled-rejections=warn';
    installCrashHandlers({
      process: warnProcess, isMainThread: true, logger, shutdownTimeoutMs: 100, capture: () => {}, flush: () => Promise.resolve(true), onExit: () => {}, unhandledRejections: 'auto',
    });
    expect(warnProcess.listeners('unhandledRejection')).toHaveLength(1);
  });
});

describe('several clients in one process', () => {
  const options = (process: FakeProcess, flush: () => Promise<unknown>, extra: Partial<Parameters<typeof installCrashHandlers>[0]> = {}) => ({
    process,
    isMainThread: true,
    logger,
    shutdownTimeoutMs: 200,
    capture: () => {},
    flush,
    onExit: () => {},
    unhandledRejections: 'auto' as const,
    ...extra,
  });

  it('share one listener, and exit once after every client has flushed', async () => {
    const process = new FakeProcess();
    const exit = vi.spyOn(process, 'exit');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const flushed: string[] = [];
    const captured: string[] = [];
    installCrashHandlers(options(process, async () => { await new Promise((r) => setTimeout(r, 30)); flushed.push('slow'); }, { capture: () => captured.push('slow') }));
    installCrashHandlers(options(process, async () => { flushed.push('fast'); }, { capture: () => captured.push('fast') }));
    expect(process.listeners('uncaughtException')).toHaveLength(1);

    process.emit('uncaughtException', new Error('fatal'));
    await new Promise((r) => setTimeout(r, 60));

    expect(captured.sort()).toEqual(['fast', 'slow']);
    expect(flushed.sort()).toEqual(['fast', 'slow']);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('installs no rejection listener for a client that asked for none', () => {
    const process = new FakeProcess();
    process.execArgv = ['--unhandled-rejections=warn'];
    installCrashHandlers(options(process, () => Promise.resolve(), { unhandledRejections: 'none' }));
    expect(process.listeners('unhandledRejection')).toHaveLength(0);
  });

  it('labels a rejection that reached uncaughtException as a rejection', async () => {
    const process = new FakeProcess();
    process.on('uncaughtException', () => {}); // the application's own: no exit
    const mechanisms: string[] = [];
    installCrashHandlers(options(process, () => Promise.resolve(), { capture: (_error, mechanism) => mechanisms.push(mechanism) }));
    process.emit('uncaughtException', new Error('rejected'), 'unhandledRejection');
    await new Promise((r) => setTimeout(r, 10));
    expect(mechanisms).toEqual(['unhandledRejection']);
  });

  it('leaves signals alone for an application that runs its own shutdown', () => {
    const process = new FakeProcess();
    installLifecycle({ process, logger, shutdownTimeoutMs: 200, autoFlush: false, signals: false, flush: () => Promise.resolve(), close: () => Promise.resolve(), onExit: () => {} });
    expect(process.listeners('SIGTERM')).toHaveLength(0);
    expect(process.listeners('exit')).toHaveLength(1);
  });

  it('removes the listeners when the last client goes', () => {
    const process = new FakeProcess();
    const one = installCrashHandlers(options(process, () => Promise.resolve()));
    const two = installCrashHandlers(options(process, () => Promise.resolve()));
    one();
    expect(process.listeners('uncaughtException')).toHaveLength(1);
    two();
    expect(process.listeners('uncaughtException')).toHaveLength(0);
  });

  it('closes every client on a signal and re-raises it once', async () => {
    const process = new FakeProcess();
    const kill = vi.spyOn(process, 'kill');
    const closed: string[] = [];
    for (const name of ['a', 'b']) {
      installLifecycle({ process, logger, shutdownTimeoutMs: 200, autoFlush: false, flush: () => Promise.resolve(), close: async () => void closed.push(name), onExit: () => {} });
    }
    process.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 20));
    expect(closed.sort()).toEqual(['a', 'b']);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(42, 'SIGTERM');
  });
});

describe('node flags', () => {
  it('reads the last --unhandled-rejections from argv over NODE_OPTIONS', () => {
    expect(rejectionMode({ execArgv: [], env: {} })).toBe('throw');
    expect(rejectionMode({ execArgv: ['--unhandled-rejections', 'warn'], env: { NODE_OPTIONS: '--unhandled-rejections=strict' } })).toBe('warn');
    expect(rejectionMode({ execArgv: [], env: { NODE_OPTIONS: '--max-old-space-size=4096 --unhandled_rejections=none' } })).toBe('none');
  });

  it('splits NODE_OPTIONS like a shell', () => {
    expect(splitNodeOptions(`--require "/path with space/x.js" --flag='a b' c\\ d`)).toEqual(['--require', '/path with space/x.js', '--flag=a b', 'c d']);
  });
});
