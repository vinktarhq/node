import 'reflect-metadata';

import { Controller, Get, Module, NotFoundException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express, { type NextFunction, type Request, type Response } from 'express';
import Fastify from 'fastify';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { Vinktar } from '../src/client.js';
import { vinktarErrors, vinktarRequest } from '../src/frameworks/express.js';
import { vinktarFastify } from '../src/frameworks/fastify.js';
import { VinktarExceptionFilter, VinktarMiddleware } from '../src/frameworks/nest.js';
import { nodePlatform } from '../src/index.js';
import { makeHarness, type Harness } from './harness.js';

/**
 * The adapters against the real frameworks, over real HTTP (Fastify through its own inject),
 * because a structural fake proves nothing about which async context a real framework runs a
 * handler in. The frameworks are dev dependencies; the adapters import none of them.
 */
const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
// Fastify 5 and Nest 11 need Node 20; the adapters themselves run on every supported version.
const modern = Number(process.versions.node.split('.')[0]) >= 20;
const clients: Vinktar[] = [];
const closers: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const client of clients.splice(0)) await client.close();
});

function client(key = 'vnk_sk_frameworks'): { client: Vinktar; harness: Harness } {
  const harness = makeHarness();
  const made = new Vinktar({ writeKey: key, fetch: harness.fetch, logger: () => {}, autoFlush: false, breadcrumbs: false, flushIntervalMs: 60_000 }, nodePlatform);
  clients.push(made);

  return { client: made, harness };
}

async function listen(app: express.Express): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();

  return `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
}

const names = (harness: Harness) => harness.batches().map((e) => [e['name'], e['user_id'] ?? null, e['device_id'] ?? null]);

describe.runIf(modern)('express', () => {
  function app(vk: Vinktar) {
    const server = express();
    server.use(vinktarRequest({ client: vk }));
    server.get('/work', async (req: Request, res: Response) => {
      const user = req.header('x-user');
      if (user !== undefined) vk.setUser({ id: user });
      await tick(Number(req.query['wait'] ?? 0));
      vk.track('work');
      res.send('ok');
    });
    server.get('/boom', () => {
      throw Object.assign(new Error('express boom'), { status: 500 });
    });
    server.use(vinktarErrors({ client: vk }));
    server.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => void res.status(500).send('failed'));

    return server;
  }

  it('gives every request a fresh scope, in sequence and overlapping', async () => {
    const { client: vk, harness } = client();
    const url = await listen(app(vk));

    await fetch(`${url}/work`, { headers: { 'x-user': 'alice', 'x-vinktar-device-id': 'device-alice' } });
    await fetch(`${url}/work`);
    await Promise.all([
      fetch(`${url}/work?wait=30`, { headers: { 'x-user': 'carol' } }),
      fetch(`${url}/work?wait=5`, { headers: { 'x-user': 'dave' } }),
    ]);
    await vk.flush();

    expect(names(harness)).toEqual([
      ['work', 'alice', 'device-alice'],
      ['work', null, null],
      ['work', 'dave', null],
      ['work', 'carol', null],
    ]);
  });

  it('reports an error once and never writes the request into the root scope', async () => {
    const { client: vk, harness } = client();
    const server = express();
    server.get('/boom', () => {
      throw new Error('no request middleware');
    });
    server.use(vinktarErrors({ client: vk }));
    server.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => void res.status(500).send('failed'));
    const url = await listen(server);

    const response = await fetch(`${url}/boom`, { headers: { 'x-vinktar-device-id': 'device-x' } });
    await vk.flush();

    expect(response.status).toBe(500);
    expect(harness.errors()).toHaveLength(1);
    expect(harness.errors()[0]!['device_id']).toBe('device-x');
    expect(vk.scope().request).toBeUndefined();
    expect(vk.scope().deviceId).toBeUndefined();
  });

  it('keeps two clients apart inside one app', async () => {
    const a = client('vnk_sk_project_a');
    const b = client('vnk_sk_project_b');
    const server = express();
    server.use(vinktarRequest({ client: a.client }));
    server.get('/both', (req: Request, res: Response) => {
      a.client.setUser({ id: String(req.header('x-user')) });
      a.client.setTag('project', 'a');
      b.client.track('from b');
      b.client.captureMessage('b failed');
      res.send('ok');
    });
    const url = await listen(server);

    await fetch(`${url}/both`, { headers: { 'x-user': 'alice' } });
    await b.client.flush();

    expect(b.harness.batches()[0]!['user_id']).toBeUndefined();
    expect(b.harness.errors()[0]!['user_id']).toBeUndefined();
    expect(b.harness.errors()[0]!['tags']).toBeUndefined();
  });

  it('survives a client that disconnects mid-request, and the next request starts clean', async () => {
    const { client: vk, harness } = client();
    const url = await listen(app(vk));

    const controller = new AbortController();
    const aborted = fetch(`${url}/work?wait=50`, { headers: { 'x-user': 'gone' }, signal: controller.signal }).catch(() => 'aborted');
    await tick(10);
    controller.abort();
    expect(await aborted).toBe('aborted');
    await tick(60);
    await fetch(`${url}/work`);
    await vk.flush();

    expect(names(harness)).toContainEqual(['work', null, null]);
  });
});

describe.runIf(modern)('fastify', () => {
  it('scopes sequential and concurrent requests', async () => {
    const { client: vk, harness } = client();
    const app = Fastify();
    await app.register(vinktarFastify, { client: vk });
    app.get('/work', async (request) => {
      const user = request.headers['x-user'];
      if (typeof user === 'string') vk.setUser({ id: user });
      await tick(Number((request.query as { wait?: string }).wait ?? 0));
      vk.track('work');

      return 'ok';
    });
    closers.push(() => app.close());

    await app.inject({ method: 'GET', url: '/work', headers: { 'x-user': 'alice' } });
    await app.inject({ method: 'GET', url: '/work' });
    await Promise.all([
      app.inject({ method: 'GET', url: '/work?wait=30', headers: { 'x-user': 'carol' } }),
      app.inject({ method: 'GET', url: '/work?wait=5', headers: { 'x-user': 'dave' } }),
    ]);
    await vk.flush();

    expect(names(harness)).toEqual([
      ['work', 'alice', null],
      ['work', null, null],
      ['work', 'dave', null],
      ['work', 'carol', null],
    ]);
  });
});

describe.runIf(modern)('nest', () => {
  async function nestApp(vk: Vinktar): Promise<string> {
    class WorkController {
      work(): string {
        vk.track('nest work');

        return 'ok';
      }

      boom(): never {
        throw new Error('nest boom');
      }

      missing(): never {
        throw new NotFoundException();
      }
    }
    Controller()(WorkController);
    Get('work')(WorkController.prototype, 'work', Object.getOwnPropertyDescriptor(WorkController.prototype, 'work')!);
    Get('boom')(WorkController.prototype, 'boom', Object.getOwnPropertyDescriptor(WorkController.prototype, 'boom')!);
    Get('missing')(WorkController.prototype, 'missing', Object.getOwnPropertyDescriptor(WorkController.prototype, 'missing')!);
    class AppModule {}
    Module({ controllers: [WorkController] })(AppModule);

    const app = await NestFactory.create(AppModule, { logger: false });
    app.use(new VinktarMiddleware({ client: vk }).use);
    app.useGlobalFilters(new VinktarExceptionFilter({ client: vk }));
    await app.listen(0, '127.0.0.1');
    closers.push(() => app.close());

    return (await app.getUrl()).replace('[::1]', '127.0.0.1');
  }

  it('scopes a request through the middleware', async () => {
    const { client: vk, harness } = client();
    const url = await nestApp(vk);
    await fetch(`${url}/work`, { headers: { 'x-vinktar-device-id': 'device-n' } });
    await fetch(`${url}/work`);
    await vk.flush();
    expect(names(harness)).toEqual([
      ['nest work', null, 'device-n'],
      ['nest work', null, null],
    ]);
  });

  it('reports an unhandled error once and still answers with Nest\'s own 500', async () => {
    const { client: vk, harness } = client();
    const url = await nestApp(vk);
    const response = await fetch(`${url}/boom`);
    await vk.flush();

    expect(harness.errors()).toHaveLength(1);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ statusCode: 500, message: 'Internal server error' });
  });

  it('passes an HttpException through with Nest\'s body, unreported below the minimum status', async () => {
    const { client: vk, harness } = client();
    const url = await nestApp(vk);
    const response = await fetch(`${url}/missing`);
    await vk.flush();

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ statusCode: 404, message: 'Not Found' });
    expect(harness.errors()).toHaveLength(0);
  });
});
