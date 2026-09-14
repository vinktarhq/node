// A cluster primary with two HTTP workers, each with its own client. Bundled by test/runtimes.real.test.ts.
import cluster from 'node:cluster';
import { createServer } from 'node:http';

import { init, setUser, track, withScope } from '@vinktarhq/node';

const say = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

if (cluster.isPrimary) {
  const workers = [cluster.fork(), cluster.fork()];
  const exits = [];
  let listening = 0;
  cluster.on('listening', (_worker, address) => {
    listening += 1;
    if (listening === workers.length) say({ port: address.port });
  });
  cluster.on('exit', (_worker, code, signal) => {
    exits.push({ code, signal });
    if (exits.length === workers.length) {
      say({ exits });
      process.exit(0);
    }
  });
  process.stdin.on('data', (data) => {
    const command = String(data).trim();
    for (const worker of workers) {
      if (command === 'signal') process.kill(worker.process.pid, 'SIGTERM');
      if (command === 'disconnect') worker.disconnect();
    }
  });
} else {
  init({
    writeKey: 'vnk_sk_cluster',
    host: process.env.HOST,
    breadcrumbs: false,
    logger: () => {},
    flushAt: 1000,
    flushIntervalMs: 300_000,
    superProperties: { pid: process.pid },
  });
  createServer((req, res) =>
    withScope(async () => {
      const user = String(req.headers['x-user']);
      setUser({ id: user });
      await new Promise((resolve) => setTimeout(resolve, Number(new URL(req.url, 'http://local').searchParams.get('wait'))));
      track('cluster work', { expected: user });
      res.end('ok');
    }),
  ).listen(0, '127.0.0.1');
}
