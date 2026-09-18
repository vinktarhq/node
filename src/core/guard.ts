/**
 * What "never break the application" rests on.
 *
 * Every public entry point takes whatever it is handed: `null` for the options, a number for a
 * callback, an object whose getters throw, a Proxy that refuses every question. Coercing such a
 * value is itself a call into code the SDK does not own (`String(Object.create(null))` throws), so
 * the helpers here are the only way the SDK turns a foreign value into text, and `attempt` is the
 * one shape every guarded call has.
 */

/** `String(value)`, for a value whose `toString` may be missing or may throw. */
export function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '[unprintable]';
  }
}

/** A value as it should appear in a warning: short, quoted when it is a string, never walked and never a throw. */
export function show(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value.slice(0, 64));

  return typeof value === 'object' && value !== null ? (Array.isArray(value) ? '[array]' : '[object]') : safeString(value);
}

/** Run SDK work. What it throws goes to `report`, which may not throw either, and the caller gets `fallback`. */
export function attempt<T>(work: () => T, fallback: T, report?: (error: unknown) => void): T {
  try {
    return work();
  } catch (error) {
    try {
      report?.(error);
    } catch {
      // The report failed too. The application still gets its answer.
    }

    return fallback;
  }
}

/** A plain object the SDK can read keys from. Arrays, functions and everything else are not. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The options as a plain object holding only the known keys, each read once and on its own, so an
 * option whose getter throws costs that option and nothing else. Whatever `init()` was handed
 * that is not an object is no options at all.
 */
export function readOptions(given: unknown, known: ReadonlySet<string>): { options: Record<string, unknown>; problems: string[] } {
  const options: Record<string, unknown> = {};
  const problems: string[] = [];
  if (given === undefined) return { options, problems };
  if (!isObject(given)) return { options, problems: [`init() needs an options object, not ${show(given)}; it was ignored`] };

  for (const key of known) {
    try {
      const value = given[key];
      if (value !== undefined) options[key] = value;
    } catch {
      problems.push(`option "${key}" could not be read and was ignored`);
    }
  }
  try {
    for (const key of Object.keys(given)) if (!known.has(key)) problems.push(`unknown option "${key}" was ignored`);
  } catch {
    // The keys cannot be listed; the known ones were read above.
  }

  return { options, problems };
}
