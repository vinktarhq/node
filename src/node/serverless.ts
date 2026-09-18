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
 * housekeeping must never fail a customer's request. The promise returned to the handler never
 * rejects either, whatever the options were and whatever the platform's `waitUntil` did.
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

/**
 * Variables only a function platform sets. `AWS_EXECUTION_ENV` is not one of them: ECS sets it
 * too, and a long-running container would then wait on every flush inline.
 */
export function isServerlessEnvironment(env: (name: string) => string | undefined): boolean {
  return ['FUNCTIONS_WORKER_RUNTIME', 'AWS_LAMBDA_FUNCTION_NAME', 'LAMBDA_TASK_ROOT', 'K_SERVICE', 'CF_PAGES', 'VERCEL', 'NETLIFY'].some((name) => Boolean(env(name)));
}

/**
 * Flush through `waitUntil` where one exists; await inline on a platform known to kill background
 * work; do nothing on a long-lived server, where the timer flush will get there.
 */
export async function flushIfServerless(
  flush: () => Promise<unknown>,
  options: FlushIfServerlessOptions,
  env: (name: string) => string | undefined,
  onFailure: (error: unknown) => void = () => {},
): Promise<void> {
  // One flush, started at most once, that settles either way: it is handed to the platform, and
  // awaited here when the platform will not take it.
  let started: Promise<void> | undefined;
  const bounded = (timeout: number): Promise<void> => (started ??= withTimeout(flush(), timeout).then(() => undefined, () => undefined));

  try {
    const given = typeof options === 'object' && options !== null ? options : {};
    const timeout = typeof given.timeoutMs === 'number' && given.timeoutMs >= 0 ? given.timeoutMs : 2000;
    const context = given.context;
    const waitUntil = typeof context?.waitUntil === 'function' ? context.waitUntil.bind(context) : vercelWaitUntil();
    if (waitUntil !== undefined) {
      try {
        waitUntil(bounded(timeout));

        return;
      } catch (error) {
        // The platform refused the promise (the response has already gone, on some). Wait for it here.
        onFailure(error);
        await bounded(timeout);

        return;
      }
    }
    if (isServerlessEnvironment(env)) await bounded(timeout);
  } catch (error) {
    // The options could not be read. This promise resolves regardless: a handler awaits it.
    try {
      onFailure(error);
    } catch {
      // Nothing left to tell.
    }
  }
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
