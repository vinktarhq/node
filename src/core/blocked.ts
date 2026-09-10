/**
 * Ids that are never a real person, mirrored from `spec/blocked-ids.json` and pinned to it by a
 * test.
 *
 * Rejected client-side as well as server-side so the mistake surfaces on the first call, in the
 * developer's own console, rather than as a mysteriously enormous user in a chart weeks later.
 * Compared case-insensitively against the trimmed value; the empty string is blocked too.
 */
export const BLOCKED_IDS: readonly string[] = [
  'anonymous', 'guest', 'distinct_id', 'distinctid', 'device_id', 'deviceid', 'user_id', 'userid',
  'id', 'undefined', 'null', 'nan', 'none', 'true', 'false', '0', '[object object]',
];

const BLOCKED: ReadonlySet<string> = new Set(BLOCKED_IDS);

export function isBlockedId(id: string): boolean {
  const trimmed = id.trim();

  return trimmed === '' || BLOCKED.has(trimmed.toLowerCase());
}

/** A user id the server would accept: a non-empty, non-blocked string of at most 255 bytes. */
export function validUserId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (isBlockedId(id) || id.length > 255) return null;

  return id;
}
