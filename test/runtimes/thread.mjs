// A worker thread with its own client. Bundled by test/runtimes.real.test.ts.
import { parentPort, workerData } from 'node:worker_threads';

import { close, init, setUser, track, withScope } from '@vinktarhq/node';

const { host, mode, label } = workerData;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

init({
  writeKey: 'vnk_sk_thread',
  host,
  breadcrumbs: false,
  logger: () => {},
  captureErrors: mode === 'crash',
  flushAt: 1000,
  flushIntervalMs: 300_000,
});

if (mode === 'isolation') {
  await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      withScope(async () => {
        setUser({ id: `${label}-${i}` });
        await sleep((i * 7) % 13);
        track('thread work', { expected: `${label}-${i}` });
      }),
    ),
  );
  parentPort.postMessage({ closed: await close() });
}

if (mode === 'crash') {
  setUser({ id: `${label}-crash` });
  setTimeout(() => {
    throw new Error(`thread boom ${label}`);
  }, 5);
  // A thread that survived its own uncaught exception would say so.
  setTimeout(() => parentPort.postMessage('still running'), 1500);
}

if (mode === 'drain') {
  // No close(): the thread ends when its loop drains.
  track('thread drained', { expected: label });
}
