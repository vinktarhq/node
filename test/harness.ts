import { gunzipSync } from 'node:zlib';
import { vi } from 'vitest';

/** A stand-in for ingest, injected through `options.fetch`: records every request, answers from a script. */
export interface Recorded {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
  readonly gzip: boolean;
}

export interface Harness {
  readonly fetch: typeof fetch;
  readonly requests: Recorded[];
  respond(status: number, body?: unknown, headers?: Record<string, string>): void;
  fail(error: Error): void;
  batches(): Array<Record<string, unknown>>;
  identifies(): Array<Record<string, unknown>>;
  errors(): Array<Record<string, unknown>>;
  reset(): void;
}

export function makeHarness(): Harness {
  const requests: Recorded[] = [];
  const script: Array<{ status: number; body: unknown; headers: Record<string, string> } | Error> = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[key.toLowerCase()] = value;
    const bytes = typeof init?.body === 'string' ? Buffer.from(init.body) : Buffer.from(init?.body as Uint8Array);
    const gzip = headers['content-encoding'] === 'gzip';
    const raw = gzip ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
    const next = script.shift() ?? { status: 202, body: { received: 1, rejected: 0, errors: [] }, headers: {} };
    if (next instanceof Error) throw next;
    requests.push({ url, headers, body: JSON.parse(raw), gzip });

    return new Response(JSON.stringify(next.body), { status: next.status, headers: next.headers });
  });

  return {
    fetch: fetchMock as unknown as typeof fetch,
    requests,
    respond: (status, body = null, headers = {}) => void script.push({ status, body, headers }),
    fail: (error) => void script.push(error),
    batches: () => requests.filter((r) => r.url.includes('/v1/batch')).flatMap((r) => (r.body['batch'] as Array<Record<string, unknown>>) ?? []),
    identifies: () => requests.filter((r) => r.url.includes('/v1/batch')).flatMap((r) => (r.body['identify'] as Array<Record<string, unknown>>) ?? []),
    errors: () => requests.filter((r) => r.url.includes('/v1/errors')).flatMap((r) => (r.body['errors'] as Array<Record<string, unknown>>) ?? []),
    reset: () => void requests.splice(0),
  };
}

export const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
