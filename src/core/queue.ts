import type { Category, Reports } from './reports.js';

/**
 * A bounded, ordered buffer of things waiting to be sent.
 *
 * Bounded because a page can be open for days and a process for months: an unbounded queue trades
 * a visible dropped-item counter for an invisible memory leak. Overflow drops the OLDEST; in
 * analytics the newest data is what someone is waiting to see.
 *
 * Events and identify entries share one queue so ordering survives: an identify that arrives after
 * the events it explains must not overtake them. Errors get their own queue, because they go to a
 * different endpoint with a different rate limit.
 */
export interface Entry {
  readonly category: Category;
  readonly item: Record<string, unknown>;
  /** Attempts so far, so a chunk that keeps failing is eventually let go. */
  attempts?: number;
}

export class Queue {
  private items: Entry[] = [];

  constructor(
    private maxSize: number,
    private readonly reports: Reports,
  ) {}

  get length(): number {
    return this.items.length;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  push(category: Category, item: Record<string, unknown>): void {
    this.items.push({ category, item });
    this.trim();
  }

  /** Remove up to `limit` entries from the front. */
  take(limit: number): Entry[] {
    return this.items.splice(0, Math.max(1, limit));
  }

  /** Put a failed chunk back at the FRONT, so a retry preserves order. */
  restore(entries: readonly Entry[]): void {
    this.items = [...entries, ...this.items];
    this.trim();
  }

  /** Everything, for persistence. Leaves the queue empty. */
  drain(): Entry[] {
    const all = this.items;
    this.items = [];

    return all;
  }

  /** Everything, without removing it. */
  peek(): readonly Entry[] {
    return this.items;
  }

  discardAll(reason: 'send_error' | 'ratelimit'): number {
    const count = this.items.length;
    for (const entry of this.items) this.reports.record(reason, entry.category);
    this.items = [];

    return count;
  }

  private trim(): void {
    while (this.items.length > this.maxSize) {
      const evicted = this.items.shift();
      if (evicted !== undefined) this.reports.record('queue_overflow', evicted.category);
    }
  }
}
