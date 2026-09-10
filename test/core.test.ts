import { describe, expect, it } from 'vitest';

import { Backoff } from '../src/core/backoff.js';
import { byteLength, truncateToBytes } from '../src/core/bytes.js';
import { Dedupe, KeyedValve, Valve } from '../src/core/dedupe.js';
import { decide, parseRateLimitCategories, parseRetryAfter } from '../src/core/decide.js';
import { serverDiagnostics } from '../src/core/diagnostics.js';
import { coerce, exceptionKey, isMeaningless } from '../src/core/exception.js';
import { runHooks, toHookList } from '../src/core/hooks.js';
import { hexId, uuidv7, uuidv7Time } from '../src/core/ids.js';
import { Logger } from '../src/core/logger.js';
import { normalize, normalizeTags, parseJson } from '../src/core/normalize.js';
import { Reports } from '../src/core/reports.js';
import { scrubSecrets } from '../src/core/scrub.js';
import { collapseRecursion, normalizePath, parseStack, type Frame } from '../src/core/stack.js';

describe('bytes', () => {
  it('counts bytes, not characters', () => {
    expect(byteLength('héllo')).toBe(6);
    expect(byteLength('😀')).toBe(4);
  });

  it('never splits a UTF-8 sequence when truncating', () => {
    expect(truncateToBytes('ab😀cd', 5)).toBe('ab');
    expect(truncateToBytes('ab😀cd', 6)).toBe('ab😀');
    expect(truncateToBytes('plain', 100)).toBe('plain');
  });
});

describe('ids', () => {
  it('mints RFC 9562 v7 uuids that sort by time and carry their timestamp', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
    expect(uuidv7Time(a)).toBe(1_700_000_000_000);
    expect(uuidv7Time('not-an-id')).toBeNull();
  });

  it('keeps order within one millisecond', () => {
    const a = uuidv7(5);
    const b = uuidv7(5);
    expect(a).not.toBe(b);
    expect(a < b).toBe(true);
  });

  it('makes 32-hex error ids', () => {
    expect(hexId()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('normalize', () => {
  it('redacts by key, truncates by bytes, collapses depth with a count, and reports each', () => {
    const drops: string[] = [];
    const out = normalize(
      { password: 'x', apiKey: 'y', long: 'é'.repeat(200), deep: { a: { b: { c: 1 } } }, nan: NaN, ok: 1 },
      { maxStringBytes: 255, maxDepth: 3, maxProperties: 255, redactedKeys: [] },
      (key, reason) => drops.push(`${key}:${reason}`),
    );
    expect(out['password']).toBe('[redacted]');
    expect(out['apiKey']).toBe('[redacted]');
    expect(byteLength(out['long'] as string)).toBeLessThanOrEqual(255);
    expect(out['deep']).toEqual({ a: { b: '[Object(1)]' } });
    expect(out['nan']).toBeNull();
    expect(drops).toEqual(['long:truncated', 'b:depth']);
  });

  it('distinguishes a DAG from a cycle', () => {
    const shared = { n: 1 };
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const out = normalize({ a: shared, b: shared, c: cyclic }, { maxStringBytes: 255, maxDepth: 5, maxProperties: 255, redactedKeys: [] });
    expect(out['a']).toEqual({ n: 1 });
    expect(out['b']).toEqual({ n: 1 });
    expect(out['c']).toEqual({ self: '[Circular]' });
  });

  it('drops denylisted keys and prototype-polluting keys', () => {
    const polluted = JSON.parse('{"__proto__": {"x": 1}, "keep": 1, "gone": 2}') as Record<string, unknown>;
    const out = normalize(polluted, { maxStringBytes: 255, maxDepth: 3, maxProperties: 255, redactedKeys: [], propertyDenylist: ['gone'] });
    expect(Object.keys(out)).toEqual(['keep']);
  });

  it('parses JSON without polluting prototypes and without throwing', () => {
    expect(parseJson('{"__proto__":{"polluted":1},"a":1}')).toEqual({ a: 1 });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(parseJson('not json')).toBeUndefined();
  });

  it('caps tags and redacts sensitive tag keys', () => {
    const out = normalizeTags({ token: 'abc', a: 'b', c: 1 }, 2, 32, 200);
    expect(out).toEqual({ token: '[redacted]', a: 'b' });
  });
});

describe('scrub', () => {
  it('masks secret-shaped values and leaves ordinary text alone', () => {
    expect(scrubSecrets('key sk_live_abcdefghijklmnop failed')).toBe('key [Filtered] failed');
    expect(scrubSecrets('card 4111 1111 1111 1111')).toBe('card [Filtered]');
    expect(scrubSecrets('Bearer abcdefghijklmnopqrstuvwxyz')).toBe('[Filtered]');
    expect(scrubSecrets('Cannot read properties of null')).toBe('Cannot read properties of null');
  });
});

describe('dedupe and valves', () => {
  it('remembers more than one recent error', () => {
    let t = 0;
    const d = new Dedupe(20, 5000, () => t);
    expect(d.isDuplicate('a')).toBe(false);
    expect(d.isDuplicate('b')).toBe(false);
    expect(d.isDuplicate('a')).toBe(true);
    t = 6000;
    expect(d.isDuplicate('a')).toBe(false);
  });

  it('lets a burst through and refills over time', () => {
    let t = 0;
    const v = new Valve(3, () => t);
    expect([v.take(), v.take(), v.take(), v.take()]).toEqual([true, true, true, false]);
    t = 20_000;
    expect(v.take()).toBe(true);
  });

  it('valves per key without letting one key spend the others', () => {
    const v = new KeyedValve(1, 2, () => 0);
    expect(v.take('TypeError')).toBe(true);
    expect(v.take('TypeError')).toBe(false);
    expect(v.take('RangeError')).toBe(true);
  });
});

describe('backoff', () => {
  it('escalates with jitter, caps at thirty minutes, and holds per category', () => {
    const b = new Backoff(() => 0, () => 0.5);
    expect(b.schedule(1)).toBe(3000);
    expect(b.schedule(2)).toBe(6000);
    expect(b.schedule(20)).toBe(30 * 60_000);
    b.hold(['error']);
    expect(b.isHeld(['error'])).toBe(true);
    expect(b.isHeld(['event', 'identify'])).toBe(false);
  });

  it('prefers the server wait when given one', () => {
    let now = 0;
    const b = new Backoff(() => now);
    b.hold(['event'], 10);
    expect(b.remaining(['event'])).toBe(10_000);
    now = 10_001;
    expect(b.isHeld(['event'])).toBe(false);
  });
});

describe('decide headers', () => {
  it('reads Retry-After as delta seconds or an HTTP date', () => {
    expect(parseRetryAfter('10')).toBe(10);
    expect(parseRetryAfter(new Date(1000 * 60 + 5000).toUTCString(), 5000)).toBe(60);
    expect(parseRetryAfter('garbage')).toBe(0);
    expect(parseRetryAfter(null)).toBe(0);
  });

  it('narrows a hold to the categories the server names', () => {
    expect(parseRateLimitCategories('30:event;identify')).toEqual({ seconds: 30, categories: ['event', 'identify'] });
    expect(decide(429, { error: 'rate_limited' }, { rateLimitCategories: '30:event' })).toMatchObject({ action: 'hold', wait: 30, categories: ['event'] });
  });

  it('holds a monthly cap for hours regardless of the header', () => {
    expect(decide(429, { error: 'monthly_cap_exceeded' }, { retryAfter: 2_000_000 })).toMatchObject({ action: 'hold', wait: 21_600, billing: true });
  });
});

describe('server diagnostics', () => {
  it('turns every surface of a 202 body into a warning', () => {
    const lines = serverDiagnostics({
      received: 3,
      rejected: 1,
      errors: [{ index: 0, code: 'missing_name' }],
      traits_dropped: [{ user_id: 'u', key: 'bio', code: 'value_too_large' }],
      identify_ignored: [{ user_id: 'bob', code: 'no_op' }],
      suppressed: 2,
    });
    expect(lines).toHaveLength(4);
    expect(lines.join('\n')).toContain('suppressed 2 errors');
  });
});

describe('reports', () => {
  it('subtracts what was delivered rather than clearing', () => {
    const r = new Reports();
    r.record('queue_overflow', 'event', 2);
    const snap = r.snapshot()!;
    r.record('queue_overflow', 'event', 1);
    r.commit(snap.taken);
    expect(r.snapshot()!.body.discarded).toEqual([{ reason: 'queue_overflow', category: 'event', quantity: 1 }]);
  });
});

describe('hooks', () => {
  it('runs left to right, drops on null, and treats a throw as a drop', () => {
    const hooks = toHookList<{ n: number }>([(v) => ({ n: v.n + 1 }), (v) => ({ n: v.n * 2 })], () => {});
    expect(runHooks(hooks, { n: 1 }).value).toEqual({ n: 4 });
    expect(runHooks([() => null], { n: 1 }).value).toBeNull();
    const thrown = runHooks([() => { throw new Error('x'); }], { n: 1 });
    expect(thrown.value).toBeNull();
    expect(thrown.threw).toBeInstanceOf(Error);
  });
});

describe('logger', () => {
  it('prints a warning once, rate limits distinct ones, and knows when it is re-entered', () => {
    const lines: string[] = [];
    const log = new Logger((_, m) => lines.push(m), false, () => 0);
    log.warn('same');
    log.warn('same');
    expect(lines).toHaveLength(1);
    for (let i = 0; i < 40; i += 1) log.warn(`distinct ${i}`);
    expect(lines.length).toBeLessThanOrEqual(31);
    let reentrant = false;
    const probe = new Logger(() => { reentrant = probe.isReentrant; }, false);
    probe.error('x');
    expect(reentrant).toBe(true);
    expect(probe.isReentrant).toBe(false);
  });
});

describe('exceptions', () => {
  it('walks the cause chain thrown-first and stops at a cycle', () => {
    const inner = new TypeError('inner');
    const outer = new Error('outer', { cause: inner });
    (inner as { cause?: unknown }).cause = outer;
    const { exceptions } = coerce(outer);
    expect(exceptions.map((e) => e.type)).toEqual(['Error', 'TypeError']);
  });

  it('coerces objects, strings and error-carrying objects', () => {
    expect(coerce({ code: 'PAYMENT_FAILED' }, undefined, { fallbackType: 'UnhandledRejection' }).exceptions[0]).toMatchObject({
      type: 'UnhandledRejection',
      value: 'PAYMENT_FAILED',
    });
    expect(coerce('boom').exceptions[0]).toMatchObject({ type: 'Error', value: 'boom' });
    expect(coerce({ error: new RangeError('inside') }).exceptions[0]).toMatchObject({ type: 'RangeError', value: 'inside' });
    expect(coerce({ a: 1, b: 2 }).exceptions[0]!.value).toContain('keys: a, b');
    expect(coerce({}).synthetic).toBe(true);
  });

  it('never emits the wording the server suppresses', () => {
    const { exceptions } = coerce(undefined as unknown as object, undefined, { fallbackType: 'UnhandledRejection' });
    expect(exceptions).toEqual([]);
    const value = coerce(42, undefined, { fallbackType: 'UnhandledRejection' }).exceptions[0]!.value;
    expect(value).not.toContain('Non-Error');
  });

  it('honours framesToPop and scrubs the message', () => {
    const err = new Error('token sk_live_abcdefghijklmnop');
    err.stack = 'Error: x\n    at helper (https://x/app.js:1:1)\n    at real (https://x/app.js:2:2)';
    (err as { framesToPop?: number }).framesToPop = 1;
    const { exceptions } = coerce(err);
    expect(exceptions[0]!.value).toBe('token [Filtered]');
    expect(exceptions[0]!.stack.map((f) => f.function)).toEqual(['real']);
  });

  it('flags meaningless throws', () => {
    expect(isMeaningless(undefined)).toBe(true);
    expect(isMeaningless({})).toBe(true);
    expect(isMeaningless(new Error('x'))).toBe(false);
    expect(exceptionKey(coerce(new Error('x')).exceptions)).toContain('Error|x');
  });
});

describe('stack parser hardening', () => {
  it('normalises file URLs, Windows drive paths and data URLs', () => {
    expect(normalizePath('file:///srv/app/x.js')).toBe('/srv/app/x.js');
    expect(normalizePath('file:///C:/app/x.js')).toBe('C:/app/x.js');
    expect(normalizePath('file:///srv/my%20app/x.js')).toBe('/srv/my app/x.js');
    expect(normalizePath('data:application/javascript;base64,AAAA')).toBe('<data:application/javascript>');
  });

  it('parses node async frames and skips the async separator', () => {
    const frames = parseStack('Error: x\n    at async load (file:///srv/app.js:3:5)\n    ----\n    at Object.<anonymous> (/srv/index.js:1:1)');
    expect(frames.map((f) => f.file)).toEqual(['/srv/index.js', '/srv/app.js']);
    expect(frames[1]!.function).toBe('async load');
  });

  it('survives a pathological line without hanging', () => {
    const line = `    at ${'a'.repeat(50_000)} (${'b'.repeat(50_000)}:1:1)`;
    const start = Date.now();
    parseStack(`Error: x\n${line}`);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('collapses a recursion to one canonical copy of its cycle', () => {
    const f = (fn: string): Frame => ({ file: 'app.js', function: fn, line: 1, col: 0, in_app: true });
    const cycle = [f('a'), f('b'), f('c')];
    const stackA = [...cycle, ...cycle, ...cycle, f('a'), f('main')];
    const stackB = [f('b'), f('c'), ...[f('a'), f('b'), f('c')], ...[f('a'), f('b'), f('c')], f('main')];
    const collapsedA = collapseRecursion(stackA).map((x) => x.function);
    const collapsedB = collapseRecursion(stackB).map((x) => x.function);
    expect(collapsedA).toEqual(['a', 'b', 'c', 'main']);
    expect(collapsedB).toEqual(collapsedA);
  });

  it('unwraps webpack error wrappers', () => {
    expect(parseStack('Error: x\n    at f (error: https://x/app.js:1:2)')[0]!.file).toBe('https://x/app.js');
  });
});
