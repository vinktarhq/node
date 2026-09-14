// A plain child process with one client, configured by environment. Bundled by test/runtimes.real.test.ts.
import { init, setUser, track } from '@vinktarhq/node';

const { MODE: mode, HOST: host, LABEL: label = 'p', KEY: key = 'vnk_sk_process', SPOOL: spool = '' } = process.env;
const say = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

init({
  writeKey: key,
  host,
  breadcrumbs: false,
  logger: (level, message) => {
    if (level !== 'debug') say({ log: `${level}: ${message}` });
  },
  captureErrors: mode === 'crash',
  spoolPath: spool,
  flushAt: 1000,
  flushIntervalMs: 300_000,
  requestTimeoutMs: 1000,
  shutdownTimeout: 1000,
});

if (mode === 'crash') {
  setUser({ id: `${label}-crash` });
  setTimeout(() => {
    throw new Error(`process boom ${label}`);
  }, 5);
}

if (mode === 'spool') {
  for (let i = 0; i < 5; i += 1) track('spooled', { label, i });
}

if (mode === 'signal') {
  setUser({ id: `${label}-signal` });
  track('before signal', { label });
  setInterval(() => {}, 1000);
  say({ ready: true });
}
