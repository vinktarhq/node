import type { Props } from './normalize.js';

/**
 * What a `202` body says the server did NOT keep.
 *
 * A `202` means "durably queued", not "everything you sent is stored": per-event rejections,
 * dropped traits, ignored identifies and suppressed errors all ride in the body of a success. The
 * SDK is the only party positioned to say so at the moment it happens, in the developer's own
 * console, and a silently ignored identify is the single most common "my data never arrived"
 * report in this class of product.
 *
 * Pure: takes the parsed body, returns warn-level lines. There is no code for a refused rebind,
 * because that is resolved at read time and is never in this body.
 */
const IDENTIFY_HINTS: Record<string, string> = {
  missing_user_id: 'the entry had no user_id',
  blocked_id: 'that id is on the blocked list and is never a real person',
  blocked_device_id: 'that device id is on the blocked list',
  no_op: 'nothing to do: the link was already known and no traits were sent',
};

/** How many per-event rejections to spell out before summarising. */
const MAX_LISTED = 5;

export function serverDiagnostics(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return [];
  const payload = body as Props;
  const lines: string[] = [];

  for (const entry of list(payload['identify_ignored'])) {
    const code = String(entry['code'] ?? 'unknown');
    lines.push(`server ignored identify("${String(entry['user_id'] ?? '')}"): ${IDENTIFY_HINTS[code] ?? code} (${code})`);
  }

  for (const entry of list(payload['traits_dropped'])) {
    lines.push(
      `server dropped trait "${String(entry['key'] ?? '')}" for "${String(entry['user_id'] ?? '')}" (${String(entry['code'] ?? 'unknown')})`,
    );
  }

  const rejected = Number(payload['rejected'] ?? 0);
  if (rejected > 0) {
    const errors = list(payload['errors']);
    const shown = errors.slice(0, MAX_LISTED).map((entry) => `#${String(entry['index'] ?? '?')} ${String(entry['code'] ?? 'unknown')}`);
    const more = errors.length > MAX_LISTED ? `, and ${errors.length - MAX_LISTED} more` : '';
    lines.push(`server rejected ${rejected} item${rejected === 1 ? '' : 's'}: ${shown.join(', ')}${more}`);
  }

  const suppressed = Number(payload['suppressed'] ?? 0);
  if (suppressed > 0) {
    lines.push(`server suppressed ${suppressed} error${suppressed === 1 ? '' : 's'} as known noise (not stored, not billed)`);
  }

  return lines;
}

function list(value: unknown): Props[] {
  return Array.isArray(value) ? value.filter((item): item is Props => typeof item === 'object' && item !== null) : [];
}
