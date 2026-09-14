import type { Category } from './reports.js';

/**
 * Per-category holds and retry timing.
 *
 * Categories come from the ENDPOINT: `event` and `identify` for /v1/batch, `error` for /v1/errors.
 * The server can narrow a hold with `X-RateLimit-Categories`, never widen it. Holding per category
 * is what stops a throttled analytics batch from stalling a crash report; they are separate
 * products with separate budgets.
 *
 * Two kinds of wait, because two answers look alike and are not:
 *
 *   - A **hold** (429) waits exactly as long as the server said, or on the local schedule when it
 *     said nothing. The server knows its own bucket.
 *   - A **retry** (503, 5xx, no answer) treats the server's wait as a floor under an exponential
 *     schedule with ±50% jitter, capped at thirty minutes. Ten fixed ten-second retries would give
 *     up on a storage outage in under two minutes; this schedule keeps a batch for about half an hour.
 *     Without jitter every tab that failed at the same instant retries at the same instant, which
 *     is how a recovering server gets knocked over again.
 *
 * A request that never got an answer at all is, on a real page, usually an ad blocker, and that
 * is not fixed by trying harder: it gets a short budget. A runtime that knows it is offline says
 * so, and those attempts are not counted (see the dispatcher).
 */
export const BATCH_CATEGORIES: readonly Category[] = ['event', 'identify'];
export const ERROR_CATEGORIES: readonly Category[] = ['error'];

export const MAX_ATTEMPTS = 10;
export const MAX_NETWORK_ATTEMPTS = 3;
const BASE_MS = 3_000;
const CAP_MS = 30 * 60_000;
/** The longest any server-supplied wait is honoured for. */
const SERVER_CAP_MS = 6 * 3_600_000;

export class Backoff {
  private readonly until = new Map<Category, number>();
  private readonly strikes = new Map<Category, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {}

  isHeld(categories: readonly Category[]): boolean {
    const now = this.now();

    return categories.some((category) => (this.until.get(category) ?? 0) > now);
  }

  /** Milliseconds remaining on the longest hold covering these categories. */
  remaining(categories: readonly Category[]): number {
    const now = this.now();
    let max = 0;
    for (const category of categories) max = Math.max(max, (this.until.get(category) ?? 0) - now);

    return Math.max(0, max);
  }

  /**
   * @param seconds the server's wait when it gave one; 0 to use the local schedule.
   * @param mode `exact` honours the server's wait as given; `floor` never waits less than the
   *             local schedule either.
   */
  hold(categories: readonly Category[], seconds = 0, mode: 'exact' | 'floor' = 'exact'): void {
    const now = this.now();

    for (const category of categories) {
      const strikes = (this.strikes.get(category) ?? 0) + 1;
      this.strikes.set(category, strikes);

      const server = seconds > 0 ? Math.min(seconds * 1000, SERVER_CAP_MS) : 0;
      const wait = mode === 'floor' ? Math.max(server, this.schedule(strikes)) : server > 0 ? server : this.schedule(strikes);
      this.until.set(category, Math.max(this.until.get(category) ?? 0, now + wait));
    }
  }

  succeeded(categories: readonly Category[]): void {
    for (const category of categories) {
      this.strikes.delete(category);
      this.until.delete(category);
    }
  }

  /** Coming back online is a reason to stop waiting: the cause of the failure is gone. */
  clear(): void {
    this.until.clear();
    this.strikes.clear();
  }

  /** 3 s, 6 s, 12 s … capped at 30 min, each ±50%. */
  schedule(strikes: number): number {
    const raw = Math.min(CAP_MS, BASE_MS * 2 ** Math.max(0, strikes - 1));
    const jitter = (this.random() - 0.5) * raw; // ±50%

    return Math.max(BASE_MS / 2, Math.ceil(raw + jitter));
  }
}
