import { byteLength } from './bytes.js';
import type { Category, DropReason, Reports } from './reports.js';

/**
 * A bounded, ordered buffer of things waiting to be sent.
 *
 * Bounded by count and by bytes, because a page can be open for days and a process for months: an
 * unbounded queue trades a visible dropped-item counter for an invisible memory leak. Overflow
 * drops the OLDEST; in analytics the newest data is what someone is waiting to see.
 *
 * Events and identify entries share one queue so ordering survives: an identify that arrives after
 * the events it explains must not overtake them. Errors get their own queue, because they go to a
 * different endpoint with a different rate limit.
 *
 * **Sealed on the way in.** Every item is serialised when it is pushed and the queue keeps the
 * parsed copy, never the caller's object. A hook that returns a `BigInt` or a cycle, or a caller
 * that mutates an object after tracking it, can then only ever affect that one item, at the moment
 * it is captured, instead of breaking the request that would have carried its neighbours.
 *
 * **Leased, not taken, while in flight.** A chunk being sent stays in the queue until the server's
 * answer decides its fate, so a failure anywhere between building a request and reading the
 * response cannot lose it, and a persisted copy written meanwhile still contains it. The bounds
 * apply to what is WAITING: a slow request must not push out the records captured while it runs.
 */
export interface Entry {
  readonly category: Category;
  readonly item: Record<string, unknown>;
  /** Serialised size, measured once when the entry was sealed. */
  readonly bytes: number;
  /** Attempts so far, so a chunk that keeps failing is eventually let go. */
  attempts?: number;
}

/** The queue's own copy of an item, or null when it cannot be sent at all. */
export function seal(category: Category, item: unknown): Entry | null {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
  // An async hook returns a promise, which serialises to `{}`: an event with nothing in it.
  if (typeof (item as { then?: unknown }).then === 'function') return null;

  let text: string;
  try {
    text = JSON.stringify(item);
  } catch {
    return null;
  }
  if (typeof text !== 'string') return null;

  return { category, item: JSON.parse(text) as Record<string, unknown>, bytes: byteLength(text) };
}

export class Queue {
  private items: Entry[] = [];
  private readonly leased = new Set<Entry>();
  private size = 0;
  private leasedSize = 0;

  constructor(
    private readonly maxItems: number,
    private readonly reports: Reports,
    private readonly maxBytes: number = Number.POSITIVE_INFINITY,
  ) {}

  get length(): number {
    return this.items.length;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  get bytes(): number {
    return this.size;
  }

  /** Seal and append. False when the item cannot be serialised; nothing is queued then. */
  push(category: Category, item: unknown): boolean {
    const entry = seal(category, item);
    if (entry === null) return false;
    this.items.push(entry);
    this.size += entry.bytes;
    this.trim();

    return true;
  }

  /** Mark these entries in flight. They stay in the queue, and in order, until removed or released. */
  lease(entries: readonly Entry[]): void {
    for (const entry of entries) {
      if (this.leased.has(entry) || !this.items.includes(entry)) continue;
      this.leased.add(entry);
      this.leasedSize += entry.bytes;
    }
  }

  release(entries: readonly Entry[]): void {
    for (const entry of entries) {
      if (!this.leased.delete(entry)) continue;
      this.leasedSize -= entry.bytes;
    }
    // What arrived during the request may now be over the bounds.
    this.trim();
  }

  /** Remove exactly these entries, wherever they are now. Entries already gone are ignored. */
  remove(entries: readonly Entry[]): void {
    if (entries.length === 0) return;
    const gone = new Set(entries);
    this.items = this.items.filter((entry) => {
      if (!gone.has(entry)) return true;
      this.size -= entry.bytes;
      if (this.leased.delete(entry)) this.leasedSize -= entry.bytes;

      return false;
    });
  }

  /** Everything, without removing it. */
  peek(): readonly Entry[] {
    return this.items;
  }

  /**
   * Empty the queue. Counted under `reason`, or not at all when the caller discards on the user's
   * own instruction (opting out) and there is nothing to report.
   */
  discardAll(reason: DropReason | null): number {
    const count = this.items.length;
    if (reason !== null) for (const entry of this.items) this.reports.record(reason, entry.category);
    this.items = [];
    this.leased.clear();
    this.size = 0;
    this.leasedSize = 0;

    return count;
  }

  private trim(): void {
    while (this.items.length - this.leased.size > this.maxItems || this.size - this.leasedSize > this.maxBytes) {
      // The oldest entry not in flight. One that is in flight is decided by the server's answer.
      const index = this.items.findIndex((entry) => !this.leased.has(entry));
      if (index === -1) return;
      const [evicted] = this.items.splice(index, 1);
      if (evicted === undefined) return;
      this.size -= evicted.bytes;
      this.reports.record('queue_overflow', evicted.category);
    }
  }
}
