import { build, type BuildOptions, type Plugin } from 'esbuild';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, get, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Vinktar } from '../src/client.js';
import { nodePlatform } from '../src/index.js';

/**
 * The runtimes the README names, run for real: worker threads, child processes and cluster
 * workers, and Cloudflare's workerd. Each fixture in `test/runtimes/` is bundled from `src/`, run in
 * its own thread, process or isolate, and delivers over HTTP to an ingest stand-in in this process.
 * Nothing here fakes `process`, the scope store or the transport.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const major = Number(process.versions.node.split('.')[0]);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Row = Record<string, unknown>;

interface Ingest {
  readonly host: string;
  events(name?: string): Row[];
  errors(): Row[];
  close(): Promise<void>;
}

function decode(bytes: Buffer, encoding: string | null | undefined): Row {
  return JSON.parse((encoding === 'gzip' ? gunzipSync(bytes) : bytes).toString('utf8')) as Row;
}

function collect(bodies: Array<{ path: string; body: Row }>): Pick<Ingest, 'events' | 'errors'> {
  return {
    events: (name) =>
      bodies
        .filter((r) => r.path.startsWith('/v1/batch'))
        .flatMap((r) => (r.body['batch'] as Row[] | undefined) ?? [])
        .filter((e) => name === undefined || e['name'] === name),
    errors: () => bodies.filter((r) => r.path.startsWith('/v1/errors')).flatMap((r) => (r.body['errors'] as Row[] | undefined) ?? []),
  };
}

async function startIngest(): Promise<Ingest> {
  const bodies: Array<{ path: string; body: Row }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      bodies.push({ path: req.url ?? '', body: decode(Buffer.concat(chunks), req.headers['content-encoding']) });
      res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ received: 1, rejected: 0, errors: [] }));
    });
  });
  const port = await listen(server);

  return { host: `http://127.0.0.1:${port}`, ...collect(bodies), close: () => new Promise((resolve) => server.close(() => resolve())) };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  return typeof address === 'object' && address !== null ? address.port : 0;
}

/** An address that refuses connections: a port that was just released. */
async function deadHost(): Promise<string> {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));

  return `http://127.0.0.1:${port}`;
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for delivery');
    await sleep(20);
  }
}

const payload = (row: Row): Row => (row['payload'] as Row | undefined) ?? {};

// Bundling ------------------------------------------------------------------------------------------

const sdk: Plugin = {
  name: 'vinktar-source',
  setup(bundler) {
    bundler.onResolve({ filter: /^@vinktarhq\/node(\/edge)?$/ }, (args) => ({ path: join(root, 'src', args.path.endsWith('/edge') ? 'edge.ts' : 'index.ts') }));
  },
};

let out = '';
const bundle = (name: string): string => join(out, `${name}.mjs`);

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'vinktar-runtimes-'));
  const common: BuildOptions = { absWorkingDir: root, outdir: out, bundle: true, format: 'esm', outExtension: { '.js': '.mjs' }, plugins: [sdk], logLevel: 'silent' };
  await build({ ...common, entryPoints: { thread: 'test/runtimes/thread.mjs', process: 'test/runtimes/process.mjs', cluster: 'test/runtimes/cluster.mjs' }, platform: 'node', target: 'node18' });
  for (const global of [false, true]) {
    await build({
      ...common,
      entryPoints: { [global ? 'worker-global' : 'worker']: 'test/runtimes/worker.mjs' },
      platform: 'neutral',
      external: ['node:async_hooks'],
      define: { GLOBAL_INIT: String(global) },
    });
  }
}, 60_000);

afterAll(() => {
  rmSync(out, { recursive: true, force: true });
});

// Worker threads ------------------------------------------------------------------------------------

interface ThreadRun {
  readonly code: number;
  readonly error: string | null;
  readonly messages: unknown[];
}

function runThread(workerData: Record<string, unknown>): Promise<ThreadRun> {
  return new Promise((resolve) => {
    const worker = new Worker(bundle('thread'), { workerData, stderr: true });
    const messages: unknown[] = [];
    let error: string | null = null;
    worker.on('message', (message) => messages.push(message));
    worker.on('error', (thrown) => (error = thrown.message));
    worker.on('exit', (code) => resolve({ code, error, messages }));
  });
}

describe('worker threads', () => {
  it('keep every scope to its own thread, beside a client on the main thread', async () => {
    const ingest = await startIngest();
    try {
      const threads = ['a', 'b', 'c'].map((label) => runThread({ host: ingest.host, mode: 'isolation', label }));
      const main = new Vinktar({ writeKey: 'vnk_sk_main', host: ingest.host, breadcrumbs: false, logger: () => {}, autoFlush: false, handleSignals: false, flushAt: 1000, flushIntervalMs: 300_000 }, nodePlatform);
      await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          main.withScope(async () => {
            main.setUser({ id: `main-${i}` });
            await sleep((i * 5) % 11);
            main.track('thread work', { expected: `main-${i}` });
          }),
        ),
      );
      expect(await main.close()).toBe(true);

      for (const run of await Promise.all(threads)) expect(run).toEqual({ code: 0, error: null, messages: [{ closed: true }] });
      const events = ingest.events('thread work');
      expect(events).toHaveLength(100);
      for (const event of events) expect(event['user_id']).toBe(payload(event)['expected']);
    } finally {
      await ingest.close();
    }
  }, 30_000);

  it('end on an uncaught exception, as they do without the SDK, after reporting it', async () => {
    const ingest = await startIngest();
    try {
      const run = await runThread({ host: ingest.host, mode: 'crash', label: 'crashing' });
      // Node's default for a thread: the thread stops, and its Worker emits the error.
      expect(run.messages).not.toContain('still running');
      expect(run.code).toBe(1);
      expect(run.error).toBe('thread boom crashing');
      await until(() => ingest.errors().length === 1);
      const [error] = ingest.errors();
      expect(error!['user_id']).toBe('crashing-crash');
      expect(error!['mechanism']).toMatchObject({ type: 'uncaughtException', handled: false });
    } finally {
      await ingest.close();
    }
  }, 30_000);

  it('deliver what is queued when the thread ends on its own', async () => {
    const ingest = await startIngest();
    try {
      const run = await runThread({ host: ingest.host, mode: 'drain', label: 'drained' });
      expect(run.code).toBe(0);
      await until(() => ingest.events('thread drained').length === 1);
    } finally {
      await ingest.close();
    }
  }, 30_000);
});

// Child processes and cluster -----------------------------------------------------------------------

interface ProcessRun {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly lines: Row[];
  readonly stderr: string;
}

function runProcess(
  file: string,
  env: Record<string, string>,
  onLine: (line: Row, child: ReturnType<typeof spawn>) => void = () => {},
): Promise<ProcessRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bundle(file)], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines: Row[] = [];
    let buffered = '';
    let stderr = '';
    child.stdout!.on('data', (data: Buffer) => {
      buffered += data.toString('utf8');
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const text = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (text.trim() === '') continue;
        const line = JSON.parse(text) as Row;
        lines.push(line);
        onLine(line, child);
      }
    });
    child.stderr!.on('data', (data: Buffer) => (stderr += data.toString('utf8')));
    child.on('exit', (code, signal) => resolve({ code, signal, lines, stderr }));
  });
}

function request(port: number, path: string, user: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // agent: false, so every request is its own connection and the cluster spreads them.
    get({ host: '127.0.0.1', port, path, agent: false, headers: { 'x-user': user } }, (res) => {
      res.resume();
      res.on('end', resolve);
    }).on('error', reject);
  });
}

describe('child processes', () => {
  it('report an uncaught exception and exit 1', async () => {
    const ingest = await startIngest();
    try {
      const run = await runProcess('process', { MODE: 'crash', HOST: ingest.host, LABEL: 'child' });
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('process boom child');
      const [error] = ingest.errors();
      expect(error!['user_id']).toBe('child-crash');
      expect(error!['mechanism']).toMatchObject({ type: 'uncaughtException', handled: false });
    } finally {
      await ingest.close();
    }
  }, 30_000);

  it('close on SIGTERM, deliver, and end by the same signal', async () => {
    const ingest = await startIngest();
    try {
      const run = await runProcess('process', { MODE: 'signal', HOST: ingest.host, LABEL: 'child' }, (line, child) => {
        if (line['ready'] === true) child.kill('SIGTERM');
      });
      expect(run.signal).toBe('SIGTERM');
      expect(ingest.events('before signal').map((e) => e['user_id'])).toEqual(['child-signal']);
    } finally {
      await ingest.close();
    }
  }, 30_000);

  it('spool what could not be sent, one private file per process, restored by the next process with the same key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinktar-spool-'));
    const ingest = await startIngest();
    try {
      const dead = await deadHost();
      const paths = ['one', 'two'].map((label) => join(dir, label, 'spool.json'));
      // Two processes at once, each with its own path, both unable to reach ingest.
      const runs = await Promise.all(paths.map((path, i) => runProcess('process', { MODE: 'spool', HOST: dead, LABEL: `p${i}`, SPOOL: path })));
      for (const run of runs) expect(run.code).toBe(0);
      for (const [i, path] of paths.entries()) {
        expect(statSync(path).mode & 0o777).toBe(0o600);
        const file = JSON.parse(readFileSync(path, 'utf8')) as { entries: Array<{ item: Row }> };
        expect(file.entries.map((entry) => payload(entry.item)['label'])).toEqual(Array(5).fill(`p${i}`));
      }

      // A process with another project's key leaves the file alone.
      const stranger = await runProcess('process', { MODE: 'idle', HOST: ingest.host, KEY: 'vnk_sk_other', SPOOL: paths[0]! });
      expect(stranger.code).toBe(0);
      expect(stranger.lines.map((line) => line['log'])).toContainEqual(expect.stringContaining('different write key'));
      expect(existsSync(paths[0]!)).toBe(true);
      expect(ingest.events()).toHaveLength(0);

      // The next process with the same key sends it, and removes the file once nothing is left.
      const next = await runProcess('process', { MODE: 'idle', HOST: ingest.host, SPOOL: paths[0]! });
      expect(next.code).toBe(0);
      expect(ingest.events('spooled').map((e) => payload(e)['label'])).toEqual(Array(5).fill('p0'));
      expect(existsSync(paths[0]!)).toBe(false);
      expect(existsSync(paths[1]!)).toBe(true);
    } finally {
      await ingest.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe.each(['signal', 'disconnect'] as const)('cluster workers stopped by %s', (stop) => {
  it('keep each request to its own scope and deliver before they exit', async () => {
    const ingest = await startIngest();
    try {
      let exits: unknown;
      await runProcess('cluster', { HOST: ingest.host }, (line, child) => {
        if (typeof line['port'] === 'number') {
          const port = line['port'];
          void Promise.all(Array.from({ length: 40 }, (_, i) => request(port, `/work?wait=${(i * 7) % 23}`, `user-${i}`))).then(() => child.stdin!.write(`${stop}\n`));
        }
        if (line['exits'] !== undefined) exits = line['exits'];
      });

      expect(exits).toEqual(Array(2).fill(stop === 'signal' ? { code: null, signal: 'SIGTERM' } : { code: 0, signal: null }));
      const events = ingest.events('cluster work');
      expect(events).toHaveLength(40);
      for (const event of events) expect(event['user_id']).toBe(payload(event)['expected']);
      expect(new Set(events.map((e) => payload(e)['pid'])).size).toBe(2);
    } finally {
      await ingest.close();
    }
  }, 30_000);
});

// Cloudflare Workers (workerd) ----------------------------------------------------------------------

// Miniflare needs Node 22.
describe.runIf(major >= 22)('cloudflare workers (workerd)', () => {
  async function worker(script: 'worker' | 'worker-global', bindings: Record<string, string> = {}) {
    const { Miniflare } = await import('miniflare');
    const bodies: Array<{ path: string; body: Row }> = [];
    const mf = new Miniflare({
      modules: true,
      scriptPath: bundle(script),
      modulesRoot: out,
      compatibilityDate: '2026-07-01',
      compatibilityFlags: ['nodejs_als'],
      bindings,
      outboundService: async (req: Request) => {
        bodies.push({ path: new URL(req.url).pathname, body: decode(Buffer.from(await req.arrayBuffer()), req.headers.get('content-encoding')) });

        return new Response(JSON.stringify({ received: 1, rejected: 0, errors: [] }), { status: 202, headers: { 'content-type': 'application/json' } });
      },
    });
    await mf.ready;

    return {
      ...collect(bodies),
      fetch: (path: string, user?: string) => mf.dispatchFetch(`http://worker${path}`, { headers: user === undefined ? {} : { 'x-user': user } }),
      logs: async () => (await (await mf.dispatchFetch('http://worker/logs')).json()) as string[],
      dispose: () => mf.dispose(),
    };
  }

  it('keeps overlapping requests apart with an injected AsyncLocalStorage, and flushes through waitUntil', async () => {
    const w = await worker('worker');
    try {
      const responses = await Promise.all(Array.from({ length: 30 }, (_, i) => w.fetch(`/work?wait=${(i * 7) % 23}${i % 5 === 0 ? '&fail' : ''}`, `user-${i}`)));
      for (const response of responses) expect(await response.text()).toBe('ok');
      await until(() => w.events('edge work').length === 30 && w.errors().length === 6);
      for (const event of w.events('edge work')) expect(event['user_id']).toBe(payload(event)['expected']);
      for (const error of w.errors()) expect(JSON.stringify(error['exceptions'])).toContain(`edge boom ${String(error['user_id'])}`);
      expect((await w.logs()).filter((line) => !line.startsWith('debug'))).toEqual([]);
    } finally {
      await w.dispose();
    }
  }, 60_000);

  it('says once that overlapping requests share a scope when no AsyncLocalStorage is given', async () => {
    const w = await worker('worker', { ALS: 'off' });
    try {
      await Promise.all(Array.from({ length: 10 }, (_, i) => w.fetch(`/work?wait=${(i * 7) % 23}`, `user-${i}`)));
      await until(() => w.events('edge work').length === 10);
      const warnings = (await w.logs()).filter((line) => line.startsWith('warn'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/AsyncLocalStorage/);
    } finally {
      await w.dispose();
    }
  }, 60_000);

  it('can be initialised at global scope, where workerd forbids timers and random values', async () => {
    const w = await worker('worker-global');
    try {
      expect(await (await w.fetch('/work', 'global-user')).text()).toBe('ok');
      await until(() => w.events('edge work').length === 1);
      expect(w.events('edge work')[0]!['user_id']).toBe('global-user');
      expect((await w.logs())[0]).toBe('global init ok');
    } finally {
      await w.dispose();
    }
  }, 60_000);
});
