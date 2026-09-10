import { describe, expect, it, vi } from 'vitest';

import { Logger } from '../src/core/logger.js';
import { installCrashHandlers, rejectionMode, splitNodeOptions, type ProcessLike } from '../src/node/handlers.js';

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
