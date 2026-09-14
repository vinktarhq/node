import { TIMESTAMP_PAST_MS } from '../core/limits.js';
import type { Logger } from '../core/logger.js';
import { parseJson } from '../core/normalize.js';
import type { Entry } from '../core/queue.js';

/**
 * Opt-in: what could not be sent before the process ended, written to a file and read back by the
 * next process. Best effort, and said so: a process killed with SIGKILL or by the OOM killer never
 * runs the write, and delivery after a restore is at least once (the server deduplicates on
 * `event_id`).
 *
 * One spool file belongs to **one process at a time and one project**. The file records a hash of
 * the write key it was written with, and a client configured with a different key leaves it alone
 * rather than sending another project's data under its own key. Two processes pointed at the same
 * path are not supported: give each its own.
 *
 * - **Written atomically**: a temp file unique to this process and write, then a rename, so a crash
 *   mid-write leaves the previous spool intact rather than half a JSON document.
 * - **Private**: created with mode 0600 in a directory created with 0700, because it holds event
 *   payloads.
 * - **Kept until replaced**: restoring does not delete the file. It is rewritten with whatever is
 *   still unsent when this process exits or closes, so a crash between restoring and sending does
 *   not lose what was restored.
 * - **Never someone else's to delete**: an empty write removes the file only if this process
 *   restored or wrote it.
 *
 * The first write that fails turns the spool off with a warning; the in-memory queue carries on.
 */
export interface SpoolFs {
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string, options?: { mode?: number }): void;
  renameSync(from: string, to: string): void;
  mkdirSync(path: string, options: { recursive: true; mode?: number }): unknown;
  unlinkSync(path: string): void;
  dirname(path: string): string;
}

interface SpoolFile {
  readonly v: 1;
  readonly owner: string;
  readonly entries: unknown[];
}

type Restored = Array<Pick<Entry, 'category' | 'item'>>;

const MAX_SPOOLED = 5000;
let writes = 0;

export class Spool {
  private disabled = false;
  private owned = false;
  private restored = false;

  /** @param owner a stable, non-reversible identifier of the write key */
  constructor(
    private readonly path: string,
    private readonly fs: SpoolFs,
    private readonly pid: number,
    private readonly logger: Logger,
    private readonly owner = '',
  ) {}

  /** Read the spool, once, at startup. The file stays until this process rewrites it. */
  restore(): Restored {
    if (this.restored) return [];
    this.restored = true;

    let text: string;
    try {
      text = this.fs.readFileSync(this.path, 'utf8');
    } catch {
      return [];
    }
    const parsed = parseJson(text);
    let list: unknown[];
    if (Array.isArray(parsed)) {
      // Written by an earlier version, which recorded no owner. Adopted once and replaced.
      list = parsed;
    } else if (typeof parsed === 'object' && parsed !== null && (parsed as SpoolFile).v === 1 && Array.isArray((parsed as SpoolFile).entries)) {
      if ((parsed as SpoolFile).owner !== this.owner) {
        this.logger.warn(`the spool at ${this.path} was written for a different write key and was left alone`);

        return [];
      }
      list = (parsed as SpoolFile).entries;
    } else {
      return [];
    }

    this.owned = true;
    // Older than the server accepts is dead weight: it would only be rejected.
    const floor = Date.now() - TIMESTAMP_PAST_MS + 86_400_000;
    const entries = list.filter(
      (entry): entry is Pick<Entry, 'category' | 'item'> =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as Entry).item === 'object' &&
        (entry as Entry).item !== null &&
        ['event', 'identify', 'error'].includes((entry as Entry).category) &&
        !(Date.parse(String(((entry as Entry).item as Record<string, unknown>)['timestamp'] ?? '')) < floor),
    );
    if (entries.length > 0) this.logger.debug('restored spooled items', { count: entries.length });

    return entries.slice(-MAX_SPOOLED).map(({ category, item }) => ({ category, item }));
  }

  /** Synchronous, for the `exit` handler, where nothing asynchronous will ever run. */
  write(entries: readonly Pick<Entry, 'category' | 'item'>[]): void {
    if (this.disabled) return;
    writes += 1;
    const temp = `${this.path}.${this.pid}.${writes}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      if (entries.length === 0) {
        if (this.owned) {
          try {
            this.fs.unlinkSync(this.path);
          } catch {
            // Nothing to remove.
          }
          this.owned = false;
        }

        return;
      }
      this.fs.mkdirSync(this.fs.dirname(this.path), { recursive: true, mode: 0o700 });
      const file: SpoolFile = { v: 1, owner: this.owner, entries: entries.slice(-MAX_SPOOLED).map(({ category, item }) => ({ category, item })) };
      this.fs.writeFileSync(temp, JSON.stringify(file), { mode: 0o600 });
      this.fs.renameSync(temp, this.path);
      this.owned = true;
    } catch (error) {
      this.disabled = true;
      this.logger.warn(`the spool at ${this.path} could not be written and is off for this process`, { error: String(error) });
      try {
        this.fs.unlinkSync(temp);
      } catch {
        // Nothing to clean.
      }
    }
  }
}
