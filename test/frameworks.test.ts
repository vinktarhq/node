import { afterEach, describe, expect, it } from 'vitest';

import { Vinktar } from '../src/client.js';
import { vinktarErrors, vinktarRequest } from '../src/frameworks/express.js';
import { vinktarFastify } from '../src/frameworks/fastify.js';
import { VinktarExceptionFilter, VinktarMiddleware } from '../src/frameworks/nest.js';
import { nodePlatform } from '../src/index.js';
import { makeHarness, tick, type Harness } from './harness.js';

const open: Vinktar[] = [];
let harness: Harness;

function make(): Vinktar {
  harness = makeHarness();
  const client = new Vinktar({ writeKey: 'vnk_sk_x', fetch: harness.fetch, logger: () => {}, autoFlush: false, breadcrumbs: false }, nodePlatform);
  open.push(client);

  return client;
}

afterEach(async () => {
  for (const client of open.splice(0)) await client.close();
});

type Listener = () => void;
const response = () => {
  const listeners: Listener[] = [];

  return { statusCode: 200, once: (_e: 'finish', l: Listener) => listeners.push(l), finish: () => listeners.forEach((l) => l()) };
};

describe('express', () => {
  it('scopes a request, tracks it, and reports an error once', async () => {
    const client = make();
    const req = { method: 'GET', url: '/orders/9?x=1', originalUrl: '/orders/9?x=1', headers: { host: 'api.test', 'x-vinktar-device-id': 'dev-1' }, baseUrl: '', route: { path: '/orders/:id' } };
    const res = response();
    await new Promise<void>((resolve) => {
      vinktarRequest({ client, trackRequests: true })(req, res, () => {
        client.captureMessage('inside');
        res.statusCode = 500;
        res.finish();
        const error = new Error('handler failed');
        vinktarErrors({ client })(error, req, res, () => {
          vinktarErrors({ client })(error, req, res, () => resolve());
        });
      });
    });
    await client.flush();
    const [request] = harness.batches();
    expect(request).toMatchObject({ name: '$request', device_id: 'dev-1', payload: { $route: '/orders/:id', $method: 'GET', $status: 500 } });
    const errors = harness.errors();
    expect(errors).toHaveLength(2);
    expect(errors[0]!['request']).toMatchObject({ method: 'GET', url: 'http://api.test/orders/9' });
    expect((errors[1]!['mechanism'] as { handled: boolean }).handled).toBe(false);
  });
});

describe('fastify', () => {
  it('registers root hooks that scope and report', async () => {
    const client = make();
    const hooks: Record<string, (...args: unknown[]) => void> = {};
    vinktarFastify({ addHook: (name: string, hook: (...args: unknown[]) => void) => (hooks[name] = hook) } as never, { client, trackRequests: true, minimumStatus: 400 });
    expect((vinktarFastify as unknown as Record<symbol, boolean>)[Symbol.for('skip-override')]).toBe(true);
    const request = { method: 'POST', url: '/items?q=1', headers: { host: 'h' }, routeOptions: { url: '/items' } };
    const reply = { statusCode: 422 };
    hooks['onRequest']!(request, reply, () => {});
    hooks['onError']!(request, reply, new Error('validation'), () => {});
    hooks['onResponse']!(request, reply, () => {});
    await client.flush();
    expect(harness.errors()).toHaveLength(1);
    expect(harness.batches()[0]).toMatchObject({ name: '$request', payload: { $route: '/items', $status: 422 } });
    await tick();
  });
});

describe('nest', () => {
  it('reports through the filter and rethrows', async () => {
    const client = make();
    const middleware = new VinktarMiddleware({ client });
    const req = { method: 'GET', url: '/x', headers: {} };
    middleware.use(req, { statusCode: 200 }, () => {});
    const filter = new VinktarExceptionFilter({ client });
    const exception = Object.assign(new Error('nope'), { getStatus: () => 503 });
    expect(() => filter.catch(exception, { switchToHttp: () => ({ getRequest: () => req as never, getResponse: () => ({ statusCode: 503 }) as never }) })).toThrow('nope');
    await client.flush();
    expect(harness.errors()).toHaveLength(1);
    expect((harness.errors()[0]!['context'] as { $response_status: number }).$response_status).toBe(503);
  });
});
