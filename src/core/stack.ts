import { truncateToBytes } from './bytes.js';
import { MAX_FRAME_STRING_BYTES, MAX_FRAMES } from './limits.js';

/**
 * Parses `Error.stack` into wire frames.
 *
 * ## Two things that are easy to get backwards
 *
 * **Frames are crash-LAST.** Every engine prints crash-first; the wire wants the opposite, because
 * the server groups on the last few in-app frames. One `reverse()` at the end.
 *
 * **Columns are 0-BASED on the wire.** Every engine reports 1-based, and the server only adjusts
 * when it parses a raw string itself, so structured frames are shifted here. Sending 1-based
 * columns makes every source-map lookup land one character to the right, which usually still
 * resolves to the right line and quietly to the wrong token.
 *
 * (The *exception chain* is thrown-FIRST, the opposite of frame order, in the same payload.)
 *
 * ## The stack string is untrusted input
 *
 * A stack comes from whatever was thrown, including `new Error(hugeString)` and errors with a
 * hand-built `.stack`. Every line is capped at 1 KiB before any regular expression sees it,
 * because the alternation these patterns need backtracks in time that grows with line length, and
 * a parser that hangs is a denial of service on the customer's own error path.
 */

export interface Frame {
  file: string;
  function?: string;
  line: number;
  col?: number;
  in_app: boolean;
  debug_id?: string;
}

const MAX_LINE_CHARS = 1024;

/**
 * V8 and Chromium: `at fn (url:line:col)`, plus the shapes people forget.
 *
 *   at Object.foo (https://x/app.js:1:2)
 *   at https://x/app.js:1:2
 *   at async Foo.bar (…)                   ← async frames carry the prefix in the name
 *   at new Widget (…)
 *   at Array.forEach (native)
 *   at foo (address at /path/bundle.js:1:2) ← Hermes
 *   at eval (eval at foo (https://x/a.js:1:1), <anonymous>:2:3)
 *   at foo (file:///srv/app/dist/index.js:3:9)
 */
const V8 = /^\s*at (?:(?<fn>.+?)\s+\()?(?:address at )?(?<loc>.+?)(?::(?<line>\d+))?(?::(?<col>\d+))?\)?\s*$/;

/**
 * Gecko, WebKit and Safari: `fn@url:line:col`.
 *
 * Kept separate from V8 rather than merged into one clever regex. WebKit's special frame names
 * (`global code`, `module code`, `eval code`) and Firefox's async markers (`promise callback*fn@`)
 * do not survive a merged pattern, and losing them turns a readable trace into anonymous noise.
 */
const GECKO = /^\s*(?:(?<fn>[^@]*)@)?(?<loc>.+?):(?<line>\d+)(?::(?<col>\d+))?\s*$/;

/** webpack wraps a rethrown frame as `(error: original)`; unwrap so the original parses. */
const WEBPACK_WRAPPER = /\(error: (.*)\)/;

/**
 * Frames whose location says nothing and only add noise.
 *
 * `<anonymous>` is NOT here, on purpose. Bare (`at Array.forEach (<anonymous>)`) it is a native
 * frame and is dropped below for having no line. With a line (`at i.onerror (<anonymous>:2:326171)`)
 * it is code built at runtime (a tag manager, an A/B tool, a `new Function`) and it is the ONLY
 * evidence of where the crash was. Dropping it leaves an empty stack that `allowUrls` cannot
 * judge, so every eval'd third-party crash on the page lands in the customer's issue list.
 */
const USELESS = /^(?:native|\[native code\]|unknown location|\[arguments not available\])$/;

/**
 * Not the customer's code. Matters more than it looks: the server groups on the last in-app
 * frames, so a trace with none of them groups on library internals and every issue from one
 * dependency collapses into a single issue.
 */
const NOT_IN_APP =
  /node_modules|[\\/]vendor[\\/]|polyfill|^(?:chrome|moz|safari-web|safari)-extension:|^chrome:|^about:|^webpack-internal:|^node:|^internal[\\/]|\[native code\]|^<anonymous>$/;

export interface ParseOptions {
  /** Decide `in_app` for a file; the default heuristic is the URL/path patterns above. */
  readonly inApp?: (file: string) => boolean;
}

export function parseStack(stack: string | undefined, options: ParseOptions = {}): Frame[] {
  if (typeof stack !== 'string' || stack === '') return [];

  const frames: Frame[] = [];

  for (const raw of stack.split('\n')) {
    let line = raw.length > MAX_LINE_CHARS ? raw.slice(0, MAX_LINE_CHARS) : raw;
    line = line.trim();
    if (line === '') continue;

    // The header ("TypeError: x is not a function") and V8's async separator ("----") are not
    // frames. `startsWith`/`includes`, not a regex, so a long header cannot cost quadratic time.
    if (!line.startsWith('at ') && !line.includes('@')) continue;

    const unwrapped = WEBPACK_WRAPPER.test(line) ? line.replace(WEBPACK_WRAPPER, '($1)') : line;
    const frame = parseLine(unwrapped, options);
    if (frame !== null) frames.push(frame);

    if (frames.length >= MAX_FRAMES * 4) break; // enough to find a cycle in; never unbounded
  }

  const collapsed = collapseRecursion(frames);

  // Keep the frames NEAREST the crash: the outer frames of a deep framework stack say nothing
  // about which bug this is, and the server groups on the inner ones.
  const kept = collapsed.length > MAX_FRAMES ? collapsed.slice(0, MAX_FRAMES) : collapsed;

  // Engines print crash-first; the wire wants crash-last.
  return kept.reverse();
}

function parseLine(line: string, options: ParseOptions): Frame | null {
  const match = V8.exec(line) ?? GECKO.exec(line);
  if (match?.groups === undefined) return null;

  const groups = match.groups;
  let location = (groups['loc'] ?? '').trim();
  if (location === '' || USELESS.test(location)) return null;
  // Eval'd code has a line; a native frame printed as `<anonymous>` does not.
  if (location === '<anonymous>' && groups['line'] === undefined) return null;

  // `eval (eval at foo (https://x/a.js:1:1), <anonymous>)`: the useful location is the inner one.
  const inner = /eval at [^(]+\((.+?):(\d+):(\d+)\)/.exec(location);
  if (inner !== null) location = inner[1] ?? location;

  location = normalizePath(location);

  const fn = (groups['fn'] ?? '').trim();
  const lineNumber = Number(groups['line'] ?? 0);
  const column = groups['col'] === undefined ? undefined : Number(groups['col']);

  const frame: Frame = {
    file: truncateToBytes(location, MAX_FRAME_STRING_BYTES),
    line: Number.isFinite(lineNumber) ? lineNumber : 0,
    in_app: options.inApp ? options.inApp(location) : isInAppByDefault(location),
  };

  if (fn !== '' && fn !== '<anonymous>') {
    frame.function = truncateToBytes(fn, MAX_FRAME_STRING_BYTES);
  }

  // Engines report 1-based; the wire is 0-based. Clamped, because a 0 from a malformed stack must
  // not become -1.
  if (column !== undefined && Number.isFinite(column)) {
    frame.col = Math.max(0, column - 1);
  }

  return frame;
}

export function isInAppByDefault(file: string): boolean {
  return !NOT_IN_APP.test(file);
}

/**
 * `file:///srv/app/x.js` and `/srv/app/x.js` are the same file, printed differently by ESM and
 * CommonJS. Windows adds `file:///C:/…` → `/C:/…`, which needs its leading slash dropped. A
 * `data:` URL is cut to its media type: a worker started from a base64 script would otherwise
 * put the whole script into every frame.
 */
export function normalizePath(location: string): string {
  let out = location;
  if (out.startsWith('file://')) {
    out = out.slice(7);
    if (/^\/[A-Za-z]:/.test(out)) out = out.slice(1);
    try {
      out = decodeURI(out);
    } catch {
      // A percent sign that is not an escape stays as it was.
    }
  }
  if (out.startsWith('data:')) {
    const comma = out.indexOf(',');
    const semicolon = out.indexOf(';');
    const end = Math.min(comma === -1 ? out.length : comma, semicolon === -1 ? out.length : semicolon);
    out = `<${out.slice(0, end)}>`;
  }

  return out;
}

/**
 * Collapse a recursion to one copy of its cycle.
 *
 * A stack overflow spends the whole frame limit on one repeating cycle, so the frames that name
 * the real culprit sit past the cut, and *where the runtime cut* decides which frames survive. One
 * fault then opens several issues, each with a different rotation of the same loop. Keeping a
 * single copy, rotated to a canonical start, makes every throw of the same recursion produce the
 * same frames.
 *
 * Runs on the crash-first list. `MAX_CYCLE` bounds the work: a cycle longer than ten frames is a
 * mutual recursion nobody will read frame by frame anyway.
 */
const MAX_CYCLE = 10;

export function collapseRecursion(frames: readonly Frame[]): Frame[] {
  if (frames.length < 4) return frames.slice();

  const keys = frames.map(frameKey);
  const out: Frame[] = [];
  let i = 0;

  while (i < frames.length) {
    let collapsed = false;

    for (let period = 1; period <= MAX_CYCLE && i + period * 2 <= frames.length; period += 1) {
      let repeats = 1;
      while (i + (repeats + 1) * period <= frames.length && sameRun(keys, i, i + repeats * period, period)) {
        repeats += 1;
      }
      if (repeats >= 2) {
        const cycle = frames.slice(i, i + period);
        out.push(...canonicalRotation(cycle, keys.slice(i, i + period)));
        i += repeats * period;
        // A trailing partial copy of the same cycle is the runtime's cut point, not new information.
        let partial = 0;
        while (partial < period && i + partial < frames.length && keys[i + partial] === keys[i - period + partial]) {
          partial += 1;
        }
        i += partial;
        collapsed = true;
        break;
      }
    }

    if (!collapsed) {
      out.push(frames[i]!);
      i += 1;
    }
  }

  return out;
}

function sameRun(keys: readonly string[], a: number, b: number, length: number): boolean {
  for (let k = 0; k < length; k += 1) {
    if (keys[a + k] !== keys[b + k]) return false;
  }

  return true;
}

function canonicalRotation(cycle: Frame[], keys: string[]): Frame[] {
  let best = 0;
  for (let start = 1; start < cycle.length; start += 1) {
    if (rotationKey(keys, start) < rotationKey(keys, best)) best = start;
  }

  return [...cycle.slice(best), ...cycle.slice(0, best)];
}

function rotationKey(keys: string[], start: number): string {
  return [...keys.slice(start), ...keys.slice(0, start)].join('\n');
}

/** Column included: a minified bundle puts many functions on one line under the same short names. */
function frameKey(frame: Frame): string {
  return `${frame.file}|${frame.function ?? ''}|${frame.line}|${frame.col ?? ''}`;
}

/**
 * A single fabricated frame, for `window.onerror` on a cross-origin script where the browser gives
 * `message/filename/lineno/colno` and no Error object at all.
 */
export function syntheticFrame(file: string, line: number, col: number): Frame[] {
  if (file === '') return [];

  const location = normalizePath(file);

  return [
    {
      file: truncateToBytes(location, MAX_FRAME_STRING_BYTES),
      line,
      col: Math.max(0, col - 1),
      in_app: isInAppByDefault(location),
    },
  ];
}
