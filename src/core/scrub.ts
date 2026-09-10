/**
 * Mask secret-shaped substrings in free text.
 *
 * `normalize` redacts by KEY: a property called `api_key` never leaves. This redacts by VALUE
 * SHAPE, for the places where there is no key to judge: an exception message that interpolated a
 * token (`Stripe request failed: sk_live_…`), a source line with a credential on it.
 *
 * The patterns and their order match what the server applies to error payloads on arrival, so
 * what is masked here is exactly what would have been masked there, only sooner, before it
 * crosses the network. That matters twice over: the analytics path has no server-side scrubbing
 * at all, and a secret that reaches ingest has already been written to somebody's access log.
 */

/**
 * Order is observable where two patterns can cover the same bytes (a `Bearer` header holding a
 * JWT, a card-shaped digit run inside a longer token), so it is fixed.
 */
const PATTERNS: readonly RegExp[] = [
  /\b(?:\d[ -]?){13,19}\b/g,
  /\b[srp]k_(?:live|test)_[A-Za-z0-9]{8,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
];

export const FILTERED = '[Filtered]';

/**
 * A cheap reject before the sweep. Every pattern needs a digit or one of a handful of prefixes,
 * and the overwhelming majority of strings this runs over are ordinary exception messages with
 * neither. This runs on the crash path of somebody's application, so the common case has to be
 * nearly free. Not global, so it carries no `lastIndex` between calls.
 */
const WORTH_SCANNING = /[0-9]|[srp]k_|AKIA|gh[pousr]_|xox|eyJ|bearer/i;

export function scrubSecrets(text: string): string {
  if (text === '' || !WORTH_SCANNING.test(text)) return text;

  let out = text;
  for (const pattern of PATTERNS) out = out.replace(pattern, FILTERED);

  return out;
}
