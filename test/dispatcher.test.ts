import { describe, expect, it } from 'vitest';

import { Dispatcher, type Delivery, type Outbound } from '../src/core/dispatcher.js';
import { Logger } from '../src/core/logger.js';

/** A transport that answers from a script and records what it was asked to send. */
function fake(script: Array<Partial<Delivery> | Error>) {
  const sent: Array<{ out: Outbound; gzip: boolean }> = [];
  const transport = {
    async send(out: Outbound, options: { gzip: boolean }): Promise<Delivery> {
      sent.push({ out, gzip: options.gzip });
      const next = script.shift() ?? { status: 202, body: { received: out.count, rejected: 0, errors: [] } };
      if (next instanceof Error) throw next;

      return { status: 202, body: null, ...next };
    },
  };

  return { transport, sent };
}

function make(script: Array<Partial<Delivery> | Error>, extra: Partial<ConstructorParameters<typeof Dispatcher>[0]> = {}) {
  const lines: string[] = [];
  const { transport, sent } = fake(script);
  const now = { t: 0 };
  const d = new Dispatcher({
    transport,
    logger: new Logger((_, m) => lines.push(m), true),
    maxQueueSize: 100,
    maxPendingErrors: 50,
    gzip: true,
    now: () => now.t,
    random: () => 0.5,
    ...extra,
  });

  return { d, sent, lines, now };
}

describe('dispatcher', () => {
  it('sends events and identifies in one request and commits the client report on 202', async () => {
    const { d, sent } = make([]);
    d.reports.record('sample_rate', 'event', 3);
    d.events.push('event', { name: 'a' });
    d.events.push('identify', { user_id: 'u' });
    expect(await d.flush()).toBe(true);
    const body = JSON.parse(sent[0]!.out.body) as Record<string, unknown>;
    expect(body['batch']).toHaveLength(1);
    expect(body['identify']).toHaveLength(1);
    expect(body['client_report']).toEqual({ discarded: [{ reason: 'sample_rate', category: 'event', quantity: 3 }] });
    expect(d.reports.isEmpty).toBe(true);
  });

  it('keeps the batch on 503 and holds for the server wait', async () => {
    const { d, sent, now } = make([{ status: 503, body: { error: 'storage_unavailable' }, retryAfter: 10 }]);
    d.events.push('event', { name: 'a' });
    expect(await d.flush()).toBe(false);
    expect(d.events.length).toBe(1);
    expect(d.nextRetryIn()).toBe(10_000);
    now.t = 11_000;
    expect(await d.flush()).toBe(true);
    expect(sent).toHaveLength(2);
    expect(d.events.length).toBe(0);
  });

  it('halves on 413 and drops a single item that never fits', async () => {
    const { d, sent, lines } = make([
      { status: 413, body: { error: 'payload_too_large' } },
      { status: 413, body: { error: 'payload_too_large' } },
      { status: 413, body: { error: 'payload_too_large' } },
    ]);
    for (let i = 0; i < 4; i += 1) d.events.push('event', { name: `e${i}` });
    await d.flush();
    // The single item that never fits is dropped; the other three go out together.
    expect(sent.map((s) => s.out.count)).toEqual([4, 2, 1, 3]);
    expect(d.events.length).toBe(0);
    expect(lines.some((l) => l.includes('too large'))).toBe(true);
  });

  it('holds only the throttled endpoint on 429', async () => {
    const { d, sent } = make([{ status: 429, body: { error: 'rate_limited' } }]);
    d.errors.push('error', { event_id: 'x' });
    d.events.push('event', { name: 'a' });
    await d.flush();
    expect(sent.map((s) => s.out.endpoint)).toEqual(['/v1/errors', '/v1/batch']);
    expect(d.errors.length).toBe(1);
    expect(d.events.length).toBe(0);
    expect(d.backoff.isHeld(['error'])).toBe(true);
    expect(d.backoff.isHeld(['event'])).toBe(false);
  });

  it('stops for good on a refused key', async () => {
    let shutdown = '';
    const { d } = make([{ status: 401, body: { error: 'invalid_api_key' } }], { onShutdown: (code) => (shutdown = code) });
    d.events.push('event', { name: 'a' });
    d.errors.push('error', { event_id: 'x' });
    await d.flush();
    expect(shutdown).toBe('invalid_api_key');
    expect(d.isStopped).toBe(true);
    expect(d.pending).toBe(0);
  });

  it('turns compression off after the server cannot inflate a body', async () => {
    const { d, sent } = make([{ status: 400, body: { message: 'Invalid gzip in request body' } }]);
    d.events.push('event', { name: 'a' });
    await d.flush();
    expect(sent.map((s) => s.gzip)).toEqual([true, false]);
    d.events.push('event', { name: 'b' });
    await d.flush();
    expect(sent[2]!.gzip).toBe(false);
  });

  it('gives up on a batch after the network budget and counts it', async () => {
    const { d, now, lines } = make([new Error('Failed to fetch'), new Error('Failed to fetch'), new Error('Failed to fetch')]);
    d.events.push('event', { name: 'a' });
    for (let i = 0; i < 3; i += 1) {
      await d.flush();
      now.t += 60 * 60_000;
    }
    expect(d.events.length).toBe(0);
    expect(d.reports.snapshot()!.body.discarded).toEqual([{ reason: 'send_error', category: 'event', quantity: 1 }]);
    expect(lines.some((l) => l.includes('no answer'))).toBe(true);
  });

  it('surfaces what the 202 body says was not kept', async () => {
    const { d, lines } = make([{ status: 202, body: { received: 1, rejected: 1, errors: [{ index: 0, code: 'missing_name' }] } }]);
    d.events.push('event', { name: '' });
    await d.flush();
    expect(lines.some((l) => l.includes('rejected 1 item'))).toBe(true);
  });

  it('serialises overlapping flushes', async () => {
    const { d, sent } = make([]);
    d.events.push('event', { name: 'a' });
    const first = d.flush();
    d.events.push('event', { name: 'b' });
    const second = d.flush();
    await Promise.all([first, second]);
    expect(sent.map((s) => s.out.count)).toEqual([1, 1]);
  });

  it('warns once about a monthly cap and holds for hours', async () => {
    let billing = '';
    const { d } = make([{ status: 429, body: { error: 'monthly_cap_exceeded' } }], { onBilling: (c) => (billing = c) });
    d.events.push('event', { name: 'a' });
    await d.flush();
    expect(billing).toBe('monthly_cap_exceeded');
    expect(d.nextRetryIn()).toBe(21_600_000);
  });
});
