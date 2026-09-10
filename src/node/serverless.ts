/**
 * Getting the last batch out of a function that is about to be frozen or torn down.
 *
 * Every serverless platform ends an invocation the moment the handler returns, and a flush left
 * running in the background is killed with it. The platforms that offer `waitUntil` accept a
 * promise to keep the instance alive for; the ones that do not have to be awaited inline. This
 * detects which situation the code is in and does the right one.
 *
 * A flush handed to `waitUntil` never rejects: on some platforms a rejected `waitUntil` promise
 * marks the whole invocation as failed, even though the handler itself succeeded, and the SDK's
 * housekeeping must never fail a customer's request.
 */
export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface FlushIfServerlessOptions {
  /** Cloudflare's `ctx`, or anything with a `waitUntil`. */
  readonly context?: WaitUntilContext | undefined;
  /** Bound on the flush. */
  readonly timeoutMs?: number;
}

const VERCEL_REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

function vercelWaitUntil(): ((promise: Promise<unknown>) => void) | undefined {
  const holder = (globalThis as Record<symbol, unknown>)[VERCEL_REQUEST_CONTEXT] as { get?: () => { waitUntil?: (p: Promise<unknown>) => void } } | undefined;
  const ctx = holder?.get?.();

  return typeof ctx?.waitUntil === 'function' ? ctx.waitUntil.bind(ctx) : undefined;
}

export function isServerlessEnvironment(env: (name: string) => string | undefined): boolean {
  return ['FUNCTIONS_WORKER_RUNTIME', 'LAMBDA_TASK_ROOT', 'K_SERVICE', 'CF_PAGES', 'VERCEL', 'NETLIFY', 'AWS_EXECUTION_ENV'].some(
    (name) => Boolean(env(name)),
  );
}

/**
 * Flush through `waitUntil` where one exists; await inline on a platform known to kill background
 * work; do nothing on a long-lived server, where the timer flush will get there.
 */
export async function flushIfServerless(
  flush: () => Promise<unknown>,
  options: FlushIfServerlessOptions,
  env: (name: string) => string | undefined,
): Promise<void> {
  const timeout = options.timeoutMs ?? 2000;
  const bounded = (): Promise<void> => withTimeout(flush(), timeout).then(() => undefined, () => undefined);

  if (typeof options.context?.waitUntil === 'function') {
    options.context.waitUntil(bounded());

    return;
  }
  const vercel = vercelWaitUntil();
  if (vercel !== undefined) {
    vercel(bounded());

    return;
  }
  if (isServerlessEnvironment(env)) await bounded();
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    (timer as { unref?: () => void }).unref?.();
  });

  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
