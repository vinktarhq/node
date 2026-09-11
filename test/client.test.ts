import { afterEach, describe, expect, it } from 'vitest';

import { Vinktar } from '../src/client.js';
import { nodePlatform } from '../src/index.js';
import type { VinktarOptions } from '../src/options.js';
import { makeHarness, tick, type Harness } from './harness.js';

const KEY = 'vnk_sk_server_key_0001';
const lines: string[] = [];
const logger = (_level: string, message: string): void => void lines.push(message);
const open: Vinktar[] = [];
let harness: Harness;

function make(options: Partial<VinktarOptions> = {}): Vinktar {
  harness = makeHarness();
  lines.splice(0);
  const client = new Vinktar({ writeKey: KEY, logger, fetch: harness.fetch, autoFlush: false, breadcrumbs: false, ...options }, nodePlatform);
  open.push(client);

  return client;
}

afterEach(async () => {
  for (const client of open.splice(0)) await client.close();
});

describe('init', () => {
  it('throws without a key and reads one from the environment', () => {
    expect(() => new Vinktar({ logger, fetch: harness?.fetch }, { ...nodePlatform, environment: { env: () => undefined, hostname: () => 'h', cwd: () => '/' } })).toThrow(/no write key/);
    const client = new Vinktar({ logger, autoFlush: false }, { ...nodePlatform, environment: { env: (n) => (n === 'VINKTAR_KEY' ? KEY : n === 'VINKTAR_RELEASE' ? 'r1' : undefined), hostname: () => 'h', cwd: () => '/' } });
    open.push(client);
    expect(client.version).toBeTypeOf('string');
  });

  it('accepts a bare key string', () => {
    const client = new Vinktar(KEY, nodePlatform);
    open.push(client);
    expect(client.scope()).toBeDefined();
  });
});

describe('analytics', () => {
  it('sends events with the runtime context and the scope identity', async () => {
    const client = make({ release: '2.0.0', serverName: 'api-1' });
    client.scope().setUser('alice');
    client.track('signup', { plan: 'pro' });
    await client.flush();
    const [event] = harness.batches();
    expect(event).toMatchObject({ name: 'signup', user_id: 'alice', payload: { plan: 'pro' } });
    expect(event!['context']).toMatchObject({ $lib: 'vinktar-node', $release: '2.0.0', $runtime: 'node', $server_name: 'api-1' });
    expect(event!['device_id']).toBeUndefined();
    expect(harness.requests[0]!.headers['user-agent']).toMatch(/^vinktar-node\//);
  });

  it('flushes at flushAt and compresses large bodies', async () => {
    const client = make({ flushAt: 5 });
    for (let i = 0; i < 5; i += 1) client.track('bulk', { text: 'x'.repeat(300) });
    for (let waited = 0; harness.requests.length === 0 && waited < 1000; waited += 10) await tick(10);
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]!.gzip).toBe(true);
    expect(harness.batches()).toHaveLength(5);
  });

  it('per-call options override the scope, and bad timestamps are refused', async () => {
    const client = make();
    client.scope().setUser('scope-user');
    client.track('a', {}, { userId: 'call-user', deviceId: 'dev-1', timestamp: new Date('2020-01-01') });
    client.track('b', {}, { userId: 'call-user', timestamp: Date.now() - 1000 });
    await client.flush();
    const events = harness.batches();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ name: 'b', user_id: 'call-user' });
    expect(lines.some((l) => l.includes('outside the window'))).toBe(true);
  });

  it('identify links a device when one is known and stores traits', async () => {
    const client = make();
    client.identify('alice', { email: 'a@b.com' });
    client.scopeFromHeaders({ 'x-vinktar-device-id': 'dev-abc-123', 'x-vinktar-session-id': ['ses-1'] });
    client.identify('alice');
    await client.flush();
    const identifies = harness.identifies();
    expect(identifies).toHaveLength(2);
    expect(identifies[0]).toEqual({ user_id: 'alice', $set: { $email: 'a@b.com' } });
    expect(identifies[1]).toEqual({ user_id: 'alice', device_id: 'dev-abc-123' });
  });

  it('refuses blocked ids and invalid inbound headers', async () => {
    const client = make();
    client.identify('null');
    client.scopeFromHeaders({ 'x-vinktar-device-id': 'not valid!', 'x-vinktar-session-id': 'undefined' });
    expect(client.scope().deviceId).toBeUndefined();
    expect(lines.some((l) => l.includes('not a usable user id'))).toBe(true);
    await client.flush();
    expect(harness.requests).toHaveLength(0);
  });
});

describe('scopes', () => {
  it('isolates concurrent requests through the async context', async () => {
    const client = make();
    await Promise.all(
      ['a', 'b', 'c'].map((user) =>
        client.withScope(async (scope) => {
          scope.setUser(user);
          await tick(Math.random() * 5);
          scope.setTag('user', user);
          client.track('inside');
          await tick(1);
          client.captureMessage(`from ${user}`);
        }),
      ),
    );
    await client.flush();
    for (const event of harness.batches()) expect(event['user_id']).toBeTypeOf('string');
    for (const error of harness.errors()) {
      const user = (error['tags'] as { user: string }).user;
      expect(error['user_id']).toBe(user);
      expect((error['exceptions'] as Array<{ value: string }>)[0]!.value).toBe(`from ${user}`);
    }
    expect(client.scope().userId).toBeUndefined();
  });

  it('reset() returns the scope to the initial one', () => {
    const client = make({ initialScope: { tags: { service: 'api' }, userId: 'system' } });
    client.setTag('extra', 'x');
    client.setUser({ id: 'bob' });
    client.reset();
    expect(client.scope().tags).toEqual({ service: 'api' });
    expect(client.scope().userId).toBe('system');
  });

  it('enterScope() binds the rest of the async context', async () => {
    const client = make();
    await client.withScope(async () => {
      const entered = client.enterScope();
      entered.setUser('entered');
      await tick(1);
      expect(client.scope().userId).toBe('entered');
    });
  });
});

describe('errors', () => {
  it('reports with request data, safe headers only, and in-app frames relative to the root', async () => {
    const client = make({ projectRoot: '/srv/app', contextLines: 2 });
    client.setSourceReader((path) => (path === '/srv/app/src/x.js' ? 'l1\nl2\nthrow here\nl4\nl5' : null));
    client.scope().setRequest({ url: 'https://api.example.com/orders?id=9', method: 'post', headers: { 'user-agent': 'ua', cookie: 'secret', authorization: 'Bearer x', 'x-custom': 'y' } });
    const err = new Error('boom');
    err.stack = 'Error: boom\n    at handler (/srv/app/src/x.js:3:5)\n    at run (/srv/app/node_modules/lib/index.js:1:1)\n    at node:internal/main:1:1';
    client.captureException(err, { tags: { area: 'orders' } });
    await client.flush();
    const [error] = harness.errors();
    expect(error!['request']).toEqual({ method: 'POST', url: 'https://api.example.com/orders', headers: { 'user-agent': 'ua' } });
    const frames = (error!['exceptions'] as Array<{ stack: Array<Record<string, unknown>> }>)[0]!.stack;
    expect(frames.map((f) => [f['file'], f['in_app']])).toEqual([
      ['node:internal/main', false],
      ['/srv/app/node_modules/lib/index.js', false],
      ['src/x.js', true],
    ]);
    expect(frames[2]).toMatchObject({ context_line: 'throw here', pre_context: ['l1', 'l2'], post_context: ['l4', 'l5'] });
    expect(error!['mechanism']).toEqual({ type: 'manual', handled: true, synthetic: false });
  });

  it('dedupes and ignores', async () => {
    const client = make({ ignoreErrors: ['ignored'] });
    const err = new Error('same');
    client.captureException(err);
    client.captureException(err);
    client.captureException(new Error('please ignored'));
    await client.flush();
    expect(harness.errors()).toHaveLength(1);
  });

  it('non-Error rejections get a readable value under a type the server keeps', async () => {
    const client = make();
    client.registerHandlers();
    await client.flush();
    const id = client.captureException({ code: 'E_THING' });
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    await client.flush();
    expect((harness.errors()[0]!['exceptions'] as Array<{ type: string; value: string }>)[0]).toMatchObject({ type: 'Error', value: 'E_THING' });
  });
});

describe('transport policy', () => {
  it('retries a stale-socket reset once, then treats network failure as retryable', async () => {
    const client = make();
    const reset = new TypeError('fetch failed');
    (reset as { cause?: unknown }).cause = { code: 'ECONNRESET' };
    harness.fail(reset);
    client.track('a');
    await client.flush();
    expect(harness.batches()).toHaveLength(1);
  });

  it('close() drains within the bound and stops', async () => {
    const client = make({ shutdownTimeout: 500 });
    client.track('a');
    client.captureMessage('b');
    expect(await client.close()).toBe(true);
    expect(harness.batches()).toHaveLength(1);
    expect(harness.errors()).toHaveLength(1);
    client.track('after');
    expect(lines.some((l) => l.includes('after close()'))).toBe(true);
  });

  it('close() gives up on a queue that cannot drain instead of spinning', async () => {
    const client = make({ shutdownTimeout: 300 });
    harness.respond(503, { error: 'storage_unavailable' }, { 'Retry-After': '30' });
    client.track('stuck');
    expect(await client.close()).toBe(false);
  });
});
