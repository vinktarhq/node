import { afterEach, describe, expect, it } from 'vitest';

import { Vinktar } from '../src/client.js';
import { edgePlatform } from '../src/edge.js';
import { makeHarness, tick, type Harness } from './harness.js';

const open: Vinktar[] = [];
let harness: Harness;

function make(): Vinktar {
  harness = makeHarness();
  const client = new Vinktar({ writeKey: 'vnk_sk_edge', fetch: harness.fetch, logger: () => {}, breadcrumbs: false }, edgePlatform);
  open.push(client);

  return client;
}

afterEach(async () => {
  for (const client of open.splice(0)) await client.close();
});

describe('the edge platform', () => {
  it('sends nothing until asked', async () => {
    const client = make();
    for (let i = 0; i < 50; i += 1) client.track('deferred');
    await tick(20);
    expect(harness.requests).toHaveLength(0);
    await client.flush();
    expect(harness.batches()).toHaveLength(50);
  });

  it('hands the flush to waitUntil and never rejects through it', async () => {
    const client = make();
    harness.fail(new Error('network down'));
    client.track('a');
    const promises: Promise<unknown>[] = [];
    await client.flushIfServerless({ context: { waitUntil: (p) => promises.push(p) } });
    expect(promises).toHaveLength(1);
    await expect(promises[0]).resolves.toBeUndefined();
  });

  it('flushes inline on a platform known to kill background work', async () => {
    const client = new Vinktar({ writeKey: 'vnk_sk_edge', fetch: makeHarness().fetch, logger: () => {} }, { ...edgePlatform, environment: { env: (n) => (n === 'VERCEL' ? '1' : undefined), hostname: () => '', cwd: () => '' } });
    open.push(client);
    client.track('a');
    await client.flushIfServerless();
    expect((client as unknown as { dispatcher: { pending: number } }).dispatcher.pending).toBe(0);
  });

  it('keeps a scope per request with the stack store when there is no async context', async () => {
    const client = make();
    const result = client.withScope((scope) => {
      scope.setUser('edge-user');

      return client.scope().userId;
    });
    expect(result).toBe('edge-user');
    expect(client.scope().userId).toBeUndefined();
  });
});
