/**
 * Errors the SDK made or caught while sending, marked so the global handlers do not report them
 * as the application's. The `fetch` the SDK sends through may be another script's wrapper, and
 * one that leaves a derived promise unhandled turns the SDK's own abort into an unhandled
 * rejection on the page ("vinktar: request timed out", reported from a customer's storefront).
 * By identity, never by message: an application may throw an error that reads the same.
 */
const own = new WeakSet<object>();

export function markOwn(error: unknown): void {
  if (typeof error === 'object' && error !== null) own.add(error);
}

export function isOwn(value: unknown): boolean {
  return typeof value === 'object' && value !== null && own.has(value);
}
