import { truncateToBytes } from '../core/bytes.js';
import type { WireException } from '../core/exception.js';
import { scrubSecrets } from '../core/scrub.js';
import type { Frame } from '../core/stack.js';
import type { SourceReader } from '../types.js';

/**
 * Which frames are the application's, and what the source around them looked like.
 *
 * ## In-app
 *
 * A frame is in-app when its file is a real path (absolute, `./`-relative, or a Windows drive
 * path) under the project root and not inside `node_modules`. Everything else (`node:` internals,
 * bare module specifiers, bundler virtual paths) is the platform's. The server groups on the last
 * in-app frames, so getting this wrong collapses every error from one dependency into one issue.
 *
 * ## Context lines
 *
 * A few lines around each in-app frame, read from disk, so an occurrence can be read without
 * opening the repository at that commit. Bounded in every direction: at most five frames per
 * error (the ones nearest the crash), files cached in a small LRU that also remembers misses,
 * minified and generated files skipped (a colno past 1000 or a lineno past 10 000 is a bundle,
 * and its "line" would be the whole program), and every line scrubbed and capped. Synchronous
 * reads: this runs on the crash path, where the alternative is holding the error event open
 * across an async boundary the process may not survive.
 */
export interface FrameOptions {
  readonly projectRoot: string;
  readonly contextLines: number;
  readonly readSource: SourceReader;
}

const MAX_FRAMES_WITH_SOURCE = 5;
const MAX_LINE_BYTES = 256;
const MAX_COLNO_FOR_SOURCE = 1000;
const MAX_LINENO_FOR_SOURCE = 10_000;
const CACHE_SIZE = 64;
const MISS_CACHE_SIZE = 32;

export function inAppFor(projectRoot: string): (file: string) => boolean {
  const root = normalizeSlashes(projectRoot.replace(/[\\/]+$/, ''));

  return (file: string): boolean => {
    if (file === '' || file.startsWith('node:') || file.startsWith('internal/') || file.startsWith('data:')) return false;
    const path = normalizeSlashes(file);
    if (path.includes('/node_modules/')) return false;
    const absolute = path.startsWith('/') || /^[A-Za-z]:\//.test(path);
    if (!absolute && !path.startsWith('./') && !path.startsWith('../')) return false; // a bare specifier
    if (absolute && root !== '' && !path.startsWith(`${root}/`) && path !== root) return false;

    return true;
  };
}

function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, '/');
}

/** Make in-app paths relative to the root, so a release built elsewhere still matches its maps. */
export function shortenPath(file: string, projectRoot: string): string {
  const root = normalizeSlashes(projectRoot.replace(/[\\/]+$/, ''));
  const path = normalizeSlashes(file);
  if (root !== '' && path.startsWith(`${root}/`)) return path.slice(root.length + 1);

  return file;
}

export class SourceContext {
  private readonly cache = new Map<string, string[] | null>();

  constructor(private readonly options: FrameOptions) {}

  /** Attach `pre_context`, `context_line` and `post_context` to the in-app frames nearest the crash. */
  annotate(exceptions: readonly WireException[]): void {
    if (this.options.contextLines <= 0) return;
    let budget = MAX_FRAMES_WITH_SOURCE;

    for (const exception of exceptions) {
      // Crash-last: walk from the end so the frames nearest the throw get the budget.
      for (let i = exception.stack.length - 1; i >= 0 && budget > 0; i -= 1) {
        const frame = exception.stack[i]!;
        if (!frame.in_app || frame.line <= 0) continue;
        if (frame.line > MAX_LINENO_FOR_SOURCE || (frame.col ?? 0) > MAX_COLNO_FOR_SOURCE) continue;
        if (/\.min\.(?:[cm]?js)$/.test(frame.file)) continue;
        const lines = this.linesOf(frame.file);
        if (lines === null) continue;
        this.apply(frame as Frame & Record<string, unknown>, lines);
        budget -= 1;
      }
    }
  }

  private apply(frame: Frame & Record<string, unknown>, lines: readonly string[]): void {
    const index = frame.line - 1;
    if (index < 0 || index >= lines.length) return;
    const n = this.options.contextLines;
    const clean = (line: string): string => truncateToBytes(scrubSecrets(line), MAX_LINE_BYTES);
    frame['pre_context'] = lines.slice(Math.max(0, index - n), index).map(clean);
    frame['context_line'] = clean(lines[index] ?? '');
    frame['post_context'] = lines.slice(index + 1, index + 1 + n).map(clean);
  }

  private linesOf(file: string): string[] | null {
    const cached = this.cache.get(file);
    if (cached !== undefined) {
      // Refresh recency.
      this.cache.delete(file);
      this.cache.set(file, cached);

      return cached;
    }

    let lines: string[] | null = null;
    try {
      const text = this.options.readSource(file);
      lines = typeof text === 'string' ? text.split(/\r?\n/) : null;
    } catch {
      lines = null;
    }

    this.cache.set(file, lines);
    // Misses are cached too, so a frame in a file that does not exist on this machine (a
    // container that shipped only the bundle) does not cost a failed read per error.
    const limit = lines === null ? MISS_CACHE_SIZE : CACHE_SIZE;
    let stored = 0;
    for (const value of this.cache.values()) if ((value === null) === (lines === null)) stored += 1;
    if (stored > limit) {
      for (const [key, value] of this.cache) {
        if ((value === null) === (lines === null)) {
          this.cache.delete(key);
          break;
        }
      }
    }

    return lines;
  }
}
