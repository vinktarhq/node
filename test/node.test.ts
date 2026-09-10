import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { Logger } from '../src/core/logger.js';
import { inAppFor, shortenPath, SourceContext } from '../src/node/frames.js';
import { installCrumbSources } from '../src/node/crumbs.js';
import { Scope } from '../src/node/scope.js';
import { Spool } from '../src/node/spool.js';
import * as fs from 'node:fs';
import { dirname } from 'node:path';

const logger = new Logger(() => {}, false);

describe('in-app classification', () => {
  const inApp = inAppFor('/srv/app');

  it('keeps project paths and drops platform and dependency frames', () => {
    expect(inApp('/srv/app/src/index.js')).toBe(true);
    expect(inApp('/srv/app/node_modules/x/index.js')).toBe(false);
    expect(inApp('node:internal/process')).toBe(false);
    expect(inApp('internal/modules/cjs')).toBe(false);
    expect(inApp('express')).toBe(false);
    expect(inApp('/other/place/x.js')).toBe(false);
    expect(inApp('C:/srv/app/x.js')).toBe(false);
    expect(inAppFor('C:\\srv\\app')('C:/srv/app/x.js')).toBe(true);
  });

  it('shortens in-app paths to the root', () => {
    expect(shortenPath('/srv/app/src/x.js', '/srv/app')).toBe('src/x.js');
    expect(shortenPath('/elsewhere/x.js', '/srv/app')).toBe('/elsewhere/x.js');
  });
});

describe('source context', () => {
  it('annotates the frames nearest the crash, skips minified code, and caches misses', () => {
    let reads = 0;
    const source = new SourceContext({
      projectRoot: '/srv',
      contextLines: 1,
      readSource: (path) => {
        reads += 1;

        return path === '/srv/a.js' ? 'one\ntwo sk_live_abcdefghijklmnop\nthree' : null;
      },
    });
    const frame = (file: string, line: number, col = 0) => ({ file, line, col, in_app: true });
    const exceptions = [{ type: 'E', value: '', stack: [frame('/srv/missing.js', 1), frame('/srv/big.min.js', 1), frame('/srv/a.js', 2, 5000), frame('/srv/a.js', 2)] }];
    source.annotate(exceptions);
    source.annotate(exceptions);
    const annotated = exceptions[0]!.stack[3] as Record<string, unknown>;
    expect(annotated['context_line']).toBe('two [Filtered]');
    expect(annotated['pre_context']).toEqual(['one']);
    expect(exceptions[0]!.stack[2]).not.toHaveProperty('context_line');
    expect(exceptions[0]!.stack[1]).not.toHaveProperty('context_line');
    expect(reads).toBe(2); // a.js once, missing.js once; misses are remembered
  });
});

describe('spool', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vk-spool-'));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes atomically and restores once', () => {
    const path = join(dir, 'nested', 'spool.json');
    const spool = new Spool(path, { ...fs, dirname }, 1, logger);
    spool.write([{ category: 'event', item: { name: 'a' } }]);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveLength(1);
    const again = new Spool(path, { ...fs, dirname }, 2, logger);
    expect(again.restore()).toEqual([{ category: 'event', item: { name: 'a' } }]);
    expect(again.restore()).toEqual([]);
  });
});

describe('breadcrumb sources', () => {
  it('records console lines and outbound fetches, skipping the SDK\'s own', async () => {
    const crumbs: Array<Record<string, unknown>> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('ok', { status: 201 })) as typeof fetch;
    const restore = installCrumbSources({ console: true, http: true, sendDefaultPii: false, ingestHost: 'https://in.test', add: (c) => crumbs.push(c as Record<string, unknown>), logger });
    console.info('hello', { a: 1 });
    logger.error('sdk line');
    await fetch('https://api.example.com/x?secret=1');
    await fetch('https://in.test/v1/batch');
    restore();
    globalThis.fetch = original;
    expect(crumbs.map((c) => c['category'])).toEqual(['console', 'http']);
    expect(crumbs[0]!['message']).toBe('hello {"a":1}');
    expect((crumbs[1]!['data'] as { url: string; status: number })).toMatchObject({ url: 'https://api.example.com/x', status: 201 });
  });
});

describe('scope', () => {
  it('forks by value', () => {
    const parent = new Scope(10, { tags: { a: '1' } });
    parent.addBreadcrumb({ timestamp: 't', category: 'c', message: 'm' });
    const child = parent.fork();
    child.setTag('b', '2');
    child.addBreadcrumb({ timestamp: 't', category: 'c', message: 'child' });
    expect(parent.tags).toEqual({ a: '1' });
    expect(parent.breadcrumbs.list()).toHaveLength(1);
    expect(child.tags).toEqual({ a: '1', b: '2' });
    expect(child.breadcrumbs.list()).toHaveLength(2);
  });
});
