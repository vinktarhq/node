import { truncateToBytes } from './bytes.js';
import { MAX_EXCEPTIONS, MAX_MESSAGE_BYTES, MAX_STACK_RAW_BYTES, MAX_TYPE_BYTES } from './limits.js';
import { scrubSecrets } from './scrub.js';
import { parseStack, type Frame, type ParseOptions } from './stack.js';

/**
 * Turns whatever was thrown into the wire's exception chain.
 *
 * **Thrown-FIRST**: `err` comes before `err.cause`. This is the opposite of the frame order inside
 * each exception (crash-last).
 *
 * What gets thrown is not always an `Error`. Promises reject with strings and plain objects,
 * libraries throw `{ code, message }`, and event handlers hand over `ErrorEvent`s. A chain of
 * coercers turns each of those into an exception with the best type, message and stack available,
 * and marks the result `synthetic` when the stack had to be invented, so grouping and display can
 * treat it accordingly. Runtime-specific shapes (DOMException, ErrorEvent) are handled by coercers
 * the runtime prepends; this file knows nothing about the DOM.
 */

export interface WireException {
  type: string;
  value: string;
  stack: Frame[];
  stack_raw?: string;
}

export interface Coerced {
  readonly exceptions: WireException[];
  /** No real stack existed; the frames (if any) were fabricated. */
  readonly synthetic: boolean;
}

export interface CoerceOptions extends ParseOptions {
  /** Send the raw stack alongside the frames, not only when parsing found nothing. */
  readonly includeRawStack?: boolean;
  /** Type for a non-Error value, e.g. `UnhandledRejection` from a rejection handler. */
  readonly fallbackType?: string;
}

/** A coercer claims a value, or returns null to let the next one try. */
export type Coercer = (value: unknown, options: CoerceOptions) => WireException | null;

export interface ErrorLike {
  name?: unknown;
  message?: unknown;
  stack?: unknown;
  cause?: unknown;
  framesToPop?: unknown;
}

export function isErrorLike(value: unknown): value is ErrorLike {
  if (value instanceof Error) return true;

  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ErrorLike).message === 'string' &&
    (typeof (value as ErrorLike).stack === 'string' || typeof (value as ErrorLike).name === 'string')
  );
}

/** Whether this is worth reporting at all, or is the empty noise every app produces. */
export function isMeaningless(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === '') return true;

  return typeof value === 'object' && !isErrorLike(value) && Object.keys(value as object).length === 0;
}

/** An Error, or anything shaped like one. */
export const errorCoercer: Coercer = (value, options) => {
  if (!isErrorLike(value)) return null;

  const rawStack = typeof value.stack === 'string' ? value.stack : undefined;
  let stack = parseStack(rawStack, options);

  // Some libraries mark their own top frames as noise (`invariant`, minified React errors). The
  // stack is crash-last here, so "the first N frames" are the last N.
  const pop = typeof value.framesToPop === 'number' ? Math.min(stack.length, Math.max(0, value.framesToPop)) : 0;
  if (pop > 0) stack = stack.slice(0, stack.length - pop);

  const name = typeof value.name === 'string' && value.name !== '' ? value.name : 'Error';
  const exception: WireException = {
    type: truncateToBytes(name, MAX_TYPE_BYTES),
    // Scrubbed before truncation: a token cut in half is still most of a token.
    value: truncateToBytes(scrubSecrets(typeof value.message === 'string' ? value.message : ''), MAX_MESSAGE_BYTES),
    stack,
  };

  // Only when parsing found nothing, or asked for; otherwise it doubles the payload to repeat what
  // the frames already say.
  if (rawStack !== undefined && (stack.length === 0 || options.includeRawStack === true)) {
    exception.stack_raw = truncateToBytes(scrubSecrets(rawStack), MAX_STACK_RAW_BYTES);
  }

  return exception;
};

/** A plain object carrying an Error somewhere on it (`{ error }`, `{ err }`, `{ originalError }`). */
export const objectWithErrorCoercer: Coercer = (value, options) => {
  if (typeof value !== 'object' || value === null || isErrorLike(value)) return null;

  for (const key of Object.keys(value)) {
    const candidate = (value as Record<string, unknown>)[key];
    if (isErrorLike(candidate)) return errorCoercer(candidate, options);
  }

  return null;
};

/** Any other object: name it by its keys, which groups far better than by its values. */
export const objectCoercer: Coercer = (value, options) => {
  if (typeof value !== 'object' || value === null) return null;

  const record = value as Record<string, unknown>;
  const constructorName = (record['constructor'] as { name?: unknown } | undefined)?.name;
  const type = typeof constructorName === 'string' && constructorName !== '' && constructorName !== 'Object'
    ? constructorName
    : options.fallbackType ?? 'Error';

  return { type: truncateToBytes(type, MAX_TYPE_BYTES), value: describeObject(record), stack: [] };
};

export const primitiveCoercer: Coercer = (value, options) => ({
  type: truncateToBytes(options.fallbackType ?? 'Error', MAX_TYPE_BYTES),
  value: truncateToBytes(scrubSecrets(describePrimitive(value)), MAX_MESSAGE_BYTES),
  stack: [],
});

export const CORE_COERCERS: readonly Coercer[] = [errorCoercer, objectWithErrorCoercer, objectCoercer, primitiveCoercer];

export function coerce(error: unknown, coercers: readonly Coercer[] = CORE_COERCERS, options: CoerceOptions = {}): Coerced {
  const chain: WireException[] = [];
  const seen = new Set<unknown>();
  let synthetic = false;
  let current: unknown = error;

  while (current !== undefined && current !== null && chain.length < MAX_EXCEPTIONS) {
    if (seen.has(current)) break; // a cyclic `cause` would otherwise loop forever
    seen.add(current);

    const exception = coerceOne(current, coercers, options);
    if (exception === null) break;
    if (!(current instanceof Error) && exception.stack.length === 0) synthetic = true;
    chain.push(exception);

    current = nextInChain(current);
  }

  return { exceptions: chain, synthetic };
}

function coerceOne(value: unknown, coercers: readonly Coercer[], options: CoerceOptions): WireException | null {
  for (const coercer of coercers) {
    const out = coercer(value, options);
    if (out !== null) return out;
  }

  return null;
}

function nextInChain(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return undefined;

  const cause = (value as ErrorLike).cause;
  if (cause !== undefined && cause !== null) return cause;

  // AggregateError has no `cause`; its first member is the closest thing to one.
  const errors = (value as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) return errors[0];

  return undefined;
}

/**
 * A readable summary of a non-Error that was thrown or rejected.
 *
 * Deliberately not the wording other SDKs use for this case: the server suppresses
 * "Non-Error promise rejection captured" as noise, so copying it would silently delete every
 * non-Error rejection, including useful ones like `Promise.reject({ code: 'PAYMENT_FAILED' })`.
 */
function describeObject(record: Record<string, unknown>): string {
  for (const key of ['message', 'error', 'reason', 'code', 'name']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate !== '') {
      return truncateToBytes(scrubSecrets(candidate), MAX_MESSAGE_BYTES);
    }
  }

  const keys = Object.keys(record);
  if (keys.length === 0) return 'Empty object thrown';

  let json: string;
  try {
    json = JSON.stringify(record) ?? '';
  } catch {
    json = '';
  }
  const summary = `Object thrown with keys: ${keys.slice(0, 10).join(', ')}${keys.length > 10 ? ', …' : ''}`;

  return truncateToBytes(scrubSecrets(json === '' || json.length > 512 ? summary : `${summary} ${json}`), MAX_MESSAGE_BYTES);
}

function describePrimitive(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'symbol') return value.toString();

  return String(value);
}

/** A message with no Error behind it, for `captureMessage`. */
export function fromMessage(message: string, stack: Frame[] = []): WireException[] {
  return [{ type: 'Message', value: truncateToBytes(scrubSecrets(message), MAX_MESSAGE_BYTES), stack }];
}

/** Stable key for dedupe: the type, message and crash location, never the whole stack. */
export function exceptionKey(exceptions: readonly WireException[]): string {
  const first = exceptions[0];
  if (first === undefined) return '';
  const crash = first.stack[first.stack.length - 1];

  return `${first.type}|${first.value}|${crash?.file ?? ''}|${crash?.line ?? ''}|${crash?.col ?? ''}`;
}

/** The unit error sampling hashes on: one issue, across occurrences. */
export function issueKey(exceptions: readonly WireException[]): string {
  const first = exceptions[0];
  if (first === undefined) return '';
  const crash = first.stack[first.stack.length - 1];

  return `${first.type}|${crash?.file ?? ''}|${crash?.line ?? ''}`;
}
