import type { Logger } from '../core/logger.js';
import { parseJson } from '../core/normalize.js';
import type { Entry } from '../core/queue.js';

/**
 * Opt-in: what could not be sent before the process ended, written to a file and read back by the
 * next process.
 *
 * Written atomically (a temp file named for this pid, then a rename) so a crash mid-write leaves
 * the previous spool intact rather than half a JSON document. The first write that fails turns
 * the spool off with a warning; the in-memory queue carries on, and an unwritable path is not a
 * reason to lose the events that can still be sent.
 */
export interface SpoolFs {
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string): void;
  renameSync(from: string, to: string): void;
  mkdirSync(path: string, options: { recursive: true }): unknown;
  unlinkSync(path: string): void;
  dirname(path: string): string;
}

const MAX_SPOOLED = 5000;

export class Spool {
  private disabled = false;

  constructor(
    private readonly path: string,
    private readonly fs: SpoolFs,
    private readonly pid: number,
    private readonly logger: Logger,
  ) {}

  /** Read and remove the spool, once, at startup. */
  restore(): Entry[] {
    let text: string;
    try {
      text = this.fs.readFileSync(this.path, 'utf8');
    } catch {
      return [];
    }
    try {
      this.fs.unlinkSync(this.path);
    } catch {
      // A spool that cannot be removed would be replayed by the next process too. Dedupe covers it.
    }
    const parsed = parseJson(text);
    if (!Array.isArray(parsed)) return [];
    const entries = parsed.filter(
      (entry): entry is Entry =>
        typeof entry === 'object' && entry !== null && typeof (entry as Entry).item === 'object' && ['event', 'identify', 'error'].includes((entry as Entry).category),
    );
    if (entries.length > 0) this.logger.debug('restored spooled items', { count: entries.length });

    return entries.slice(-MAX_SPOOLED);
  }

  /** Synchronous, for the `exit` handler, where nothing asynchronous will ever run. */
  write(entries: readonly Entry[]): void {
    if (this.disabled) return;
    const temp = `${this.path}.${this.pid}.tmp`;
    try {
      if (entries.length === 0) {
        try {
          this.fs.unlinkSync(this.path);
        } catch {
          // Nothing to remove.
        }

        return;
      }
      this.fs.mkdirSync(this.fs.dirname(this.path), { recursive: true });
      this.fs.writeFileSync(temp, JSON.stringify(entries.slice(-MAX_SPOOLED)));
      this.fs.renameSync(temp, this.path);
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
