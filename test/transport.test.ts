import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { Logger } from '../src/core/logger.js';
import { NodeTransport } from '../src/node/transport.js';

/** Real HTTP over the loopback interface, with the platform's own fetch: no injected test double. */
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`);
    });
  });
}

const out = { endpoint: '/v1/batch' as const, body: '{"batch":[]}', categories: ['event' as const], count: 0 };
const transport = (host: string, extra: Partial<ConstructorParameters<typeof NodeTransport>[0]> = {}) =>
  new NodeTransport({ host, writeKey: 'vnk_sk_secret_key', timeoutMs: 150, logger: new Logger(() => {}, false), fetch: undefined, compress: undefined, ...extra });

describe('node transport', () => {
  it('never follows a redirect, so the write key and body stay with the host they were meant for', async () => {
    const seen: IncomingHttpHeaders[] = [];
    const elsewhere = await serve((req, res) => {
      seen.push(req.headers);
      res.writeHead(202).end('{}');
    });
    const ingest = await serve((_req, res) => {
      res.writeHead(307, { Location: `${elsewhere}/v1/batch` }).end();
    });

    const delivery = await transport(ingest).send(out, { gzip: false });

    expect(delivery.status).toBe(307);
    expect(seen).toHaveLength(0);
  });

  it('times out a response whose body never finishes', async () => {
    const ingest = await serve((_req, res) => {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.write('{"received":');
      // ...and never ends.
    });

    const started = Date.now();
    const delivery = await transport(ingest).send(out, { gzip: false });

    expect(delivery.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('counts compression against the same deadline', async () => {
    const ingest = await serve((_req, res) => {
      res.writeHead(202).end('{}');
    });
    const never = () => new Promise<Uint8Array | null>(() => {});

    const started = Date.now();
    const delivery = await transport(ingest, { compress: never }).send({ ...out, body: 'x'.repeat(4096) }, { gzip: true });

    expect(delivery.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('reads an ordinary answer, headers included', async () => {
    const ingest = await serve((req, res) => {
      expect(req.headers['x-vinktar-key']).toBe('vnk_sk_secret_key');
      res.writeHead(429, { 'Retry-After': '12', 'X-RateLimit-Categories': '12:event;identify' }).end('{"error":"rate_limited"}');
    });

    const delivery = await transport(ingest).send(out, { gzip: false });

    expect(delivery).toEqual({ status: 429, body: { error: 'rate_limited' }, retryAfter: 12, rateLimitCategories: '12:event;identify' });
  });
});
