import type { Frame } from './stack.js';

/**
 * Local noise filtering, applied before anything costs a request or a rate-limit token.
 *
 * The deny list MIRRORS the server's (`spec/inbound-filter.json`, asserted set-equal by a test),
 * and that cuts both ways: the server silently suppresses these strings, so the SDK must never
 * emit one of them for an error the customer wanted kept.
 */

/** Suppressed server-side. Mirrored so known noise costs nothing. */
export const DENY_MESSAGES: readonly string[] = [
  'ResizeObserver loop limit exceeded',
  'ResizeObserver loop completed with undelivered notifications',
  'Script error.',
  'Non-Error promise rejection captured',
  'Non-Error exception captured',
];

/** A stack made entirely of these is a browser extension, not the customer's application. */
export const EXTENSION_SCHEMES: readonly string[] = [
  'chrome-extension://',
  'moz-extension://',
  'safari-extension://',
  'safari-web-extension://',
  'chrome://',
  'about:',
];

/**
 * Browser noise nobody can action, shipped as the default ignore list: ad blockers, wallet
 * extensions, in-app webviews, tag managers. Each of these is something a page produces that its
 * author cannot fix.
 */
export const DEFAULT_IGNORE: readonly RegExp[] = [
  /^Script error\.?$/,
  /^ResizeObserver loop/,
  /^Cannot redefine property: googletag$/,
  /^Can't find variable: gmo$/,
  /^undefined is not an object \(evaluating 'a\.[A-Z]'\)$/,
  /^vv\(\)\.getRestrictions is not a function$/,
  /_AutofillCallbackHandler/,
  /^Object Not Found Matching Id:\d+/,
  /^Java exception was raised during method invocation$/,
  /Cannot redefine property: (?:ethereum|solana)/,
  /^Non-Error promise rejection captured with value: Object Not Found Matching Id/,
  /^Blocked a frame with origin/,
  /^Loading (?:CSS )?chunk \d+ failed/,
];

export function isServerSuppressed(message: string, frames: readonly Frame[]): boolean {
  for (const deny of DENY_MESSAGES) {
    if (message.includes(deny)) return true;
  }

  return frames.length > 0 && frames.every((frame) => isExtensionFile(frame.file));
}

export function isExtensionFile(file: string): boolean {
  return EXTENSION_SCHEMES.some((scheme) => file.startsWith(scheme));
}

/**
 * True when any pattern matches. This runs inside the application's own `fetch` and XHR calls, so
 * an entry that is neither a string nor a RegExp, or a RegExp whose `test` throws, matches nothing
 * rather than failing the request it was asked about.
 */
export function matches(patterns: ReadonlyArray<string | RegExp>, value: string): boolean {
  for (const pattern of patterns) {
    try {
      if (typeof pattern === 'string' ? value.includes(pattern) : pattern instanceof RegExp && pattern.test(value)) return true;
    } catch {
      // Not a pattern that can be asked.
    }
  }

  return false;
}

/** The usable entries of a pattern list from the options, with `onInvalid` told about each one dropped. */
export function toPatterns(value: unknown, onInvalid: (index: number) => void): Array<string | RegExp> {
  const out: Array<string | RegExp> = [];
  (Array.isArray(value) ? value : []).forEach((pattern: unknown, index) => {
    if ((typeof pattern === 'string' && pattern !== '') || pattern instanceof RegExp) out.push(pattern);
    else onInvalid(index);
  });

  return out;
}

/**
 * `denyUrls` / `allowUrls` are tested against the CRASH frame, the last one, nearest the throw,
 * not whichever frame happens to come first. Testing the wrong end judges a third-party script
 * that calls into the application by the application's filename, and vice versa.
 */
export function crashFile(frames: readonly Frame[]): string {
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const file = frames[i]?.file;
    if (file !== undefined && file !== '') return file;
  }

  return '';
}
