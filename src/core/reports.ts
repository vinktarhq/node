/**
 * The tally of what the SDK itself threw away, sent as `client_report` so a customer can see
 * "the SDK dropped N events for reason R" in the product rather than wondering where they went.
 *
 * **Snapshot/commit, not drain.** Taking the tally before a request and clearing it loses the
 * counts on any failure between the two, and the report of a struggling client is exactly the one
 * worth having. `commit()` SUBTRACTS what was delivered, so outcomes recorded while a request was
 * in flight are neither lost nor double-counted.
 */
export const DROP_REASONS = ['queue_overflow', 'sample_rate', 'event_processor', 'before_send', 'send_error', 'ratelimit', 'invalid', 'deduplicated'] as const;
export type DropReason = (typeof DROP_REASONS)[number];

export const CATEGORIES = ['event', 'identify', 'error'] as const;

export type Category = (typeof CATEGORIES)[number];

export interface ClientReport {
  discarded: Array<{ reason: string; category: string; quantity: number }>;
}

export class Reports {
  private readonly counts = new Map<string, number>();

  record(reason: DropReason, category: Category, quantity = 1): void {
    if (quantity < 1) return;

    const key = `${reason}|${category}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + quantity);
  }

  get isEmpty(): boolean {
    return this.counts.size === 0;
  }

  /** Does NOT clear. See commit(). */
  snapshot(): { body: ClientReport; taken: Map<string, number> } | null {
    if (this.counts.size === 0) return null;

    const discarded = [...this.counts].map(([key, quantity]) => {
      const [reason = '', category = ''] = key.split('|');

      return { reason, category, quantity };
    });

    return { body: { discarded }, taken: new Map(this.counts) };
  }

  /**
   * Only when the request carrying the snapshot was ACCEPTED. A body the server refused took the
   * report with it, so the counts stay for the next request.
   */
  commit(taken: Map<string, number>): void {
    for (const [key, quantity] of taken) {
      const remaining = (this.counts.get(key) ?? 0) - quantity;
      if (remaining > 0) this.counts.set(key, remaining);
      else this.counts.delete(key);
    }
  }
}
