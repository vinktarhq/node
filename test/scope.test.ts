import { describe, expect, it } from 'vitest';

import { Scope, stackScopeStore } from '../src/node/scope.js';

const tick = (ms = 1): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('scope', () => {
  it('forks registered properties and nested context by value', () => {
    const parent = new Scope(10, { context: { order: { total: 1 } } });
    parent.register({ plan: 'free' });
    const child = parent.fork();
    child.register({ plan: 'pro' });
    (child.context['order'] as { total: number }).total = 2;
    expect(parent.properties).toEqual({ plan: 'free' });
    expect(parent.context).toEqual({ order: { total: 1 } });
  });

  it('detaches a request scope that keeps what was set for the process and nothing about anyone', () => {
    const root = new Scope(10, { userId: 'system', deviceId: 'd', tags: { service: 'api' }, context: { region: 'eu' } });
    root.register({ version: '1.2.3' });
    root.setRequest({ url: '/startup' });
    root.addBreadcrumb({ timestamp: 't', category: 'boot', message: 'started' });
    const request = root.detached();
    expect(request.tags).toEqual({ service: 'api' });
    expect(request.context).toEqual({ region: 'eu' });
    expect(request.properties).toEqual({ version: '1.2.3' });
    expect([request.userId, request.deviceId, request.request]).toEqual([undefined, undefined, undefined]);
    expect(request.breadcrumbs.list()).toEqual([]);
  });

  it('starts a fresh scope from defaults only', () => {
    const fresh = Scope.fresh(10, { tags: { service: 'api' } });
    expect(fresh.tags).toEqual({ service: 'api' });
    expect(fresh.userId).toBeUndefined();
    expect(fresh.properties).toEqual({});
  });
});

describe('the stack store, for runtimes without async context', () => {
  it('never makes a finished scope current again', async () => {
    const root = new Scope(10);
    const store = stackScopeStore(root);
    const a = new Scope(10);
    const b = new Scope(10);

    const first = store.run(a, async () => tick(5));
    const second = store.run(b, async () => tick(10));
    await first;
    await second;

    expect(store.current()).toBe(root);
  });

  it('says so the first time concurrent work shares a scope', async () => {
    let told = 0;
    const store = stackScopeStore(new Scope(10), () => (told += 1));
    const one = store.run(new Scope(10), async () => tick(5));
    const two = store.run(new Scope(10), async () => tick(5));
    await Promise.all([one, two]);
    expect(told).toBeGreaterThanOrEqual(1);
    expect(store.isolated).toBe(false);
  });
});
