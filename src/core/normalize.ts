import { byteLength, truncateToBytes } from './bytes.js';
import { MAX_DEPTH, MAX_PROPERTIES_PER_EVENT, MAX_STRING_BYTES } from './limits.js';

/**
 * The one normaliser, for event payloads, event context, error context, breadcrumb data and tags
 * alike. One implementation so a limit configured once applies everywhere: a normaliser that is
 * bypassed for one of those shapes is invisible until a value is rejected in production.
 *
 * Everything here is about not losing the event. The server REJECTS an oversize string rather than
 * truncating it, and rejects the whole event for one bad value, so trimming locally is the
 * difference between a slightly shorter field and no data at all.
 */

export interface NormalizeOptions {
  /** Bytes, not characters. Cannot exceed the server cap; above it the event is refused. */
  readonly maxStringBytes: number;
  readonly maxDepth: number;
  readonly maxProperties: number;
  /** Extra key fragments to redact, on top of the built-in set. */
  readonly redactedKeys: readonly string[];
  /** Top-level keys dropped outright, by exact name. Redaction masks; this omits. */
  readonly propertyDenylist?: readonly string[];
}

export const DEFAULT_NORMALIZE: NormalizeOptions = {
  maxStringBytes: MAX_STRING_BYTES,
  maxDepth: MAX_DEPTH,
  maxProperties: MAX_PROPERTIES_PER_EVENT,
  redactedKeys: [],
};

export type Props = Record<string, unknown>;

export const REDACTED = '[redacted]';
/** A value that threw when it was read: a getter, or a Proxy trap. */
export const UNREADABLE = '[Unreadable]';
export const CIRCULAR = '[Circular]';

/**
 * Values visited in one call, arrays and objects and everything in them. Depth alone does not
 * bound the work: an object three levels deep can still hold a million keys, and the walk runs on
 * the application's thread, inside its `track()` call.
 */
export const MAX_NODES = 10_000;

interface Budget {
  nodes: number;
}

const SENSITIVE = /pass|token|secret|auth|api[-_]?key|cookie|credential|card|cvv|ssn/i;

/**
 * Keys that must never be copied out of untrusted JSON. Persisted state is readable by every
 * script on the origin (and, for a cross-subdomain cookie, by every sibling site), so a parsed
 * `__proto__` key is a prototype-pollution vector, not a property.
 */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export function isUnsafeKey(key: string): boolean {
  return UNSAFE_KEYS.has(key);
}

export type DropReason = 'too_many_properties' | 'truncated' | 'depth';

/**
 * @param onDrop called when something is trimmed or discarded, so the caller can count it and
 *               warn. Nothing here fails silently.
 */
export function normalize(
  props: Props,
  options: NormalizeOptions = DEFAULT_NORMALIZE,
  onDrop?: (key: string, reason: DropReason) => void,
): Props {
  const out: Props = {};
  const budget: Budget = { nodes: MAX_NODES };
  let count = 0;

  for (const key of keysOf(props)) {
    if (isUnsafeKey(key)) continue;
    if (count >= options.maxProperties) {
      onDrop?.(key, 'too_many_properties');
      continue;
    }

    // The user's own instruction, so it is not confessed through onDrop the way a processing limit
    // is. Exact name, top level only: a nested key of the same name survives.
    if (options.propertyDenylist?.includes(key)) continue;

    // A fresh Set per top-level property, tracking the current PATH rather than everything seen: a
    // DAG (the same object referenced twice as siblings) is not a cycle.
    const value = visit(key, () => props[key], 1, options, new Set(), budget, onDrop);
    if (value === undefined) continue;
    out[key] = value;
    count += 1;
  }

  return out;
}

/** The keys of something that may refuse to list them. */
function keysOf(value: unknown): string[] {
  try {
    return typeof value === 'object' && value !== null ? Object.keys(value) : [];
  } catch {
    return [];
  }
}

/**
 * `read` rather than the value: reading a property is the first thing that can throw (a getter, a
 * Proxy), and everything after it asks the value questions that can throw as well (`instanceof`
 * consults a Proxy's prototype trap). One `try` around all of it, so the worst a value can do is
 * be recorded as unreadable.
 */
function visit(
  key: string,
  read: () => unknown,
  depth: number,
  options: NormalizeOptions,
  path: Set<unknown>,
  budget: Budget,
  onDrop?: (key: string, reason: DropReason) => void,
): unknown {
  try {
    return shape(key, read(), depth, options, path, budget, onDrop);
  } catch {
    return UNREADABLE;
  }
}

function shape(
  key: string,
  value: unknown,
  depth: number,
  options: NormalizeOptions,
  path: Set<unknown>,
  budget: Budget,
  onDrop?: (key: string, reason: DropReason) => void,
): unknown {
  if (value === undefined) return undefined;
  if (isSensitiveKey(key, options.redactedKeys)) return REDACTED;
  budget.nodes -= 1;

  if (typeof value === 'string') {
    // Bytes are never fewer than UTF-16 units, so a long string is over without being encoded.
    if (value.length > options.maxStringBytes || byteLength(value) > options.maxStringBytes) onDrop?.(key, 'truncated');

    return truncateToBytes(value, options.maxStringBytes);
  }

  if (typeof value === 'number') {
    // NaN and Infinity are not representable in JSON and would corrupt the whole request body.
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'boolean' || value === null) return value;

  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return '[Function]';
  if (typeof value === 'symbol') return value.toString();

  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof RegExp) return value.toString();

  if (value instanceof Error) {
    return { name: value.name, message: truncateToBytes(value.message, options.maxStringBytes) };
  }

  if (typeof value === 'object') {
    if (path.has(value)) return CIRCULAR;

    // The server counts payload/context itself as depth 1, so a value that would land at depth 4
    // is what it refuses. Collapse rather than lose the event, and say how much was collapsed.
    if (depth >= options.maxDepth || budget.nodes <= 0) {
      onDrop?.(key, depth >= options.maxDepth ? 'depth' : 'truncated');

      return Array.isArray(value) ? `[Array(${value.length})]` : `[Object(${Object.keys(value as Props).length})]`;
    }

    path.add(value);
    try {
      if (Array.isArray(value)) {
        const items: unknown[] = [];
        for (let index = 0; index < value.length && budget.nodes > 0; index += 1) {
          items.push(visit(`${key}[${index}]`, () => value[index], depth + 1, options, path, budget, onDrop) ?? null);
        }
        if (items.length < value.length) onDrop?.(key, 'truncated');

        return items;
      }

      const out: Props = {};
      for (const childKey of Object.keys(value as Props)) {
        if (isUnsafeKey(childKey)) continue;
        if (budget.nodes <= 0) {
          onDrop?.(key, 'truncated');
          break;
        }
        const child = visit(childKey, () => (value as Props)[childKey], depth + 1, options, path, budget, onDrop);
        if (child !== undefined) out[childKey] = child;
      }

      return out;
    } finally {
      // Removed on the way out, so a sibling reference is not mistaken for a cycle.
      path.delete(value);
    }
  }

  return null;
}

export function isSensitiveKey(key: string, extra: readonly string[] = []): boolean {
  if (SENSITIVE.test(key)) return true;

  const lower = key.toLowerCase();
  for (const fragment of extra) {
    if (fragment !== '' && lower.includes(fragment.toLowerCase())) return true;
  }

  return false;
}

/**
 * The server counts an event's payload keys and context keys together against one cap, and
 * refuses the whole event over it. Context is the SDK's own and comes first; payload keys past
 * the room that is left are dropped here, each one reported, rather than losing the event.
 */
export function capCombined(payload: Props, context: Props, max: number = MAX_PROPERTIES_PER_EVENT, onDrop?: (key: string) => void): Props {
  const room = Math.max(0, max - Object.keys(context).length);
  const keys = Object.keys(payload);
  if (keys.length <= room) return payload;

  const out: Props = {};
  keys.forEach((key, index) => {
    if (index < room) out[key] = payload[key];
    else onDrop?.(key);
  });

  return out;
}

/** Tags are their own shape: flat, string-valued, and capped tighter than properties. */
export function normalizeTags(
  tags: Record<string, unknown>,
  maxTags: number,
  maxKeyBytes: number,
  maxValueBytes: number,
  onDrop?: (key: string) => void,
): Record<string, string> {
  const out: Record<string, string> = {};
  let count = 0;

  for (const key of Object.keys(tags)) {
    if (isUnsafeKey(key)) continue;
    if (count >= maxTags) {
      onDrop?.(key);
      continue;
    }

    const value = tags[key];
    if (value === undefined || value === null) continue;
    const text = typeof value === 'string' ? value : String(value);

    out[truncateToBytes(key, maxKeyBytes)] = isSensitiveKey(key) ? REDACTED : truncateToBytes(text, maxValueBytes);
    count += 1;
  }

  return out;
}

/** JSON.parse that never throws and never returns a polluting object. */
export function parseJson(text: string | null | undefined): unknown {
  if (typeof text !== 'string' || text === '') return undefined;

  try {
    return JSON.parse(text, (key, value: unknown) => (isUnsafeKey(key) ? undefined : value));
  } catch {
    return undefined;
  }
}

/** How far down `copyPlain` copies. Below it a value is shared, which `normalize` flattens at send anyway. */
const COPY_DEPTH = 16;

/**
 * A copy of plain objects and arrays, for state that one unit of work inherits from another.
 * Anything else (a Date, a class instance) is kept by reference. It is bounded the way `normalize`
 * is, in depth and in total values, and for the same reason: what it copies was handed over by the
 * application and may contain itself, run 20,000 levels deep, or throw when read. A cycle becomes
 * `[Circular]` and a value that throws becomes `[Unreadable]`, which is what would have been sent.
 */
export function copyPlain<T>(value: T): T {
  return copyValue(value, 0, new Set(), { nodes: MAX_NODES }) as T;
}

function copyValue(value: unknown, depth: number, path: Set<unknown>, budget: Budget): unknown {
  budget.nodes -= 1;
  if (typeof value !== 'object' || value === null || depth >= COPY_DEPTH || budget.nodes <= 0) return value;
  try {
    const array = Array.isArray(value);
    if (!array && Object.getPrototypeOf(value) !== Object.prototype) return value;
    if (path.has(value)) return CIRCULAR;

    path.add(value);
    try {
      if (array) return (value as unknown[]).map((item) => copyValue(item, depth + 1, path, budget));
      const out: Props = {};
      for (const key of Object.keys(value)) {
        if (!isUnsafeKey(key)) out[key] = copyValue((value as Props)[key], depth + 1, path, budget);
      }

      return out;
    } finally {
      path.delete(value);
    }
  } catch {
    return UNREADABLE;
  }
}
