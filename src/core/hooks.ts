/**
 * User hooks: `beforeTrack`, `beforeSend`, `beforeBreadcrumb`.
 *
 * Each accepts a function or a list of functions, run left to right; return the (possibly
 * rewritten) value, or `null` to drop it. A hook that throws counts as a drop rather than as a
 * crash: user code runs on the application's own error path, and an exception there would be
 * reported by the very handler that just called the hook, forever.
 */
export type Hook<T> = (value: T) => T | null | undefined;

export function toHookList<T>(value: Hook<T> | Hook<T>[] | undefined, onInvalid: (index: number) => void): Hook<T>[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  const out: Hook<T>[] = [];

  list.forEach((hook, index) => {
    if (typeof hook === 'function') out.push(hook);
    else onInvalid(index);
  });

  return out;
}

export interface HookOutcome<T> {
  readonly value: T | null;
  /** Set when a hook threw; the value is null in that case. */
  readonly threw?: unknown;
}

export function runHooks<T>(hooks: readonly Hook<T>[], initial: T): HookOutcome<T> {
  let value: T = initial;

  for (const hook of hooks) {
    let next: T | null | undefined;
    try {
      next = hook(value);
    } catch (threw) {
      return { value: null, threw };
    }
    if (next === null || next === undefined) return { value: null };
    value = next;
  }

  return { value };
}
