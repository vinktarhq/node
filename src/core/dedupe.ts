/**
 * Stops one broken render loop from consuming a month's error budget in an afternoon.
 *
 * Three guards, because they catch different failures:
 *
 *   - **Dedupe** removes the *same* error repeating within a few seconds. A bounded map, not a
 *     single last-seen slot: two errors alternating defeat a single slot entirely, and that is
 *     exactly what a render loop produces. What counts as "the same" is the caller's key, so a
 *     server runtime can keep two users' identical failures apart. Every suppression is counted.
 *   - **The valve** caps the *rate* of everything. Dedupe cannot help when every error is
 *     genuinely different, and the server has a per-minute valve of its own; an unbounded client
 *     earns a 429 and loses the interesting errors along with the noise.
 *   - **The keyed valve** caps one *kind* of error so a single noisy type cannot spend the whole
 *     valve. Anything not currently flooding is untouched.
 */
export class Dedupe {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly size = 20,
    private readonly windowMs = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * True when this is a repeat and should not be sent.
   *
   * The window is FIXED from the first sighting. A repeat does not extend it: if it did, an error
   * recurring every few seconds would refresh its own window forever and never be reported again,
   * which hides exactly the failure that is still happening.
   */
  isDuplicate(key: string): boolean {
    const at = this.seen.get(key);
    const now = this.now();

    if (at !== undefined && now - at < this.windowMs) return true;

    // Re-inserted, so a key seen again after its window expired is the newest, not the next evicted.
    this.seen.delete(key);
    this.seen.set(key, now);
    while (this.seen.size > this.size) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }

    return false;
  }
}

/** Token bucket. Capacity equals the refill rate, so a burst passes and a sustained storm does not. */
export class Valve {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = perMinute;
    this.lastRefill = now();
  }

  /** True when there was budget for this one. */
  take(): boolean {
    const now = this.now();
    const elapsed = now - this.lastRefill;

    if (elapsed > 0) {
      this.tokens = Math.min(this.perMinute, this.tokens + (elapsed / 60_000) * this.perMinute);
      this.lastRefill = now;
    }

    if (this.tokens < 1) return false;
    this.tokens -= 1;

    return true;
  }
}

/** One valve per key, bounded in how many keys it remembers. */
export class KeyedValve {
  private readonly valves = new Map<string, Valve>();

  constructor(
    private readonly perMinute: number,
    private readonly maxKeys = 50,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string): boolean {
    let valve = this.valves.get(key);
    if (valve === undefined) {
      if (this.valves.size >= this.maxKeys) {
        const oldest = this.valves.keys().next().value;
        if (oldest !== undefined) this.valves.delete(oldest);
      }
      valve = new Valve(this.perMinute, this.now);
      this.valves.set(key, valve);
    }

    return valve.take();
  }
}
