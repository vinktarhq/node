// A Cloudflare Worker using the edge entry. Bundled by test/runtimes.real.test.ts and run in workerd.
import { AsyncLocalStorage } from 'node:async_hooks';

import { captureException, flushIfServerless, getClient, init, setUser, track, withScope } from '@vinktarhq/node/edge';

const logs = [];

function start(env) {
  if (getClient() !== null) return;
  init({
    writeKey: 'vnk_sk_workerd',
    host: 'https://ingest.test',
    breadcrumbs: false,
    asyncLocalStorage: env.ALS === 'off' ? undefined : AsyncLocalStorage,
    logger: (level, message) => {
      if (level !== 'debug') logs.push(`${level}: ${message}`);
    },
  });
}

// eslint-disable-next-line no-undef
if (GLOBAL_INIT) {
  try {
    start({});
    logs.push('global init ok');
  } catch (error) {
    logs.push(`global init threw: ${error.message}`);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/logs') return Response.json(logs);
    start(env);
    const user = request.headers.get('x-user') ?? 'anonymous';
    await withScope(async () => {
      setUser({ id: user });
      await new Promise((resolve) => setTimeout(resolve, Number(url.searchParams.get('wait') ?? 0)));
      track('edge work', { expected: user });
      if (url.searchParams.has('fail')) captureException(new Error(`edge boom ${user}`));
    });
    await flushIfServerless({ context: ctx });

    return new Response('ok');
  },
};
