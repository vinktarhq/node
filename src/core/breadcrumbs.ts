import { truncateToBytes } from './bytes.js';
import { MAX_BREADCRUMBS } from './limits.js';
import { normalize, type Props } from './normalize.js';
import { scrubSecrets } from './scrub.js';

/**
 * The trail of what happened before an error, as a ring buffer.
 *
 * Bounded twice: in count (the server keeps 50, and the browser default is lower because the
 * payload crosses a metered connection) and per message (1 KiB), so a `console.log` of a large
 * object cannot make one breadcrumb the size of the whole error budget.
 */
export interface Breadcrumb {
  readonly timestamp: string;
  readonly category: string;
  readonly message: string;
  readonly level?: 'debug' | 'info' | 'warning' | 'error';
  readonly data?: Props;
}

export const MAX_BREADCRUMB_MESSAGE_BYTES = 1024;

export class Breadcrumbs {
  private items: Breadcrumb[] = [];

  constructor(private readonly max: number) {
    this.max = Math.max(0, Math.min(max, MAX_BREADCRUMBS));
  }

  add(crumb: Breadcrumb): void {
    if (this.max === 0) return;
    this.items.push(crumb);
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
  }

  list(): Breadcrumb[] {
    return this.items.slice();
  }

  clear(): void {
    this.items = [];
  }
}

/** Shape whatever the caller passed into a breadcrumb the server accepts, or null when it is not one. */
export function toBreadcrumb(input: Partial<Breadcrumb> | undefined, now: () => number): Breadcrumb | null {
  if (typeof input !== 'object' || input === null) return null;

  const message = typeof input.message === 'string' ? input.message : '';
  const category = typeof input.category === 'string' && input.category !== '' ? input.category : 'custom';
  if (message === '' && input.data === undefined) return null;

  const crumb: Breadcrumb = {
    timestamp: typeof input.timestamp === 'string' ? input.timestamp : new Date(now()).toISOString(),
    category: truncateToBytes(category, 64),
    message: truncateToBytes(scrubSecrets(message), MAX_BREADCRUMB_MESSAGE_BYTES),
  };

  const level = input.level;
  const withLevel =
    level === 'debug' || level === 'info' || level === 'warning' || level === 'error' ? { ...crumb, level } : crumb;

  return typeof input.data === 'object' && input.data !== null
    ? { ...withLevel, data: normalize(input.data as Props) }
    : withLevel;
}
