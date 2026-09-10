/**
 * Identifiers.
 *
 * UUIDv7 everywhere an id is minted here. It is time-ordered, which makes a device id or a session
 * id carry its own creation time, so a session's start can be recovered from the id alone and a
 * sorted list of ids is a timeline. Random bits come from `crypto.getRandomValues` where it
 * exists; the arithmetic fallback is for the odd embedded runtime without it, and is flagged so a
 * test can tell which path ran.
 */

const HEX = '0123456789abcdef';

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const c = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;

  if (typeof c?.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }

  return bytes;
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i] ?? 0;
    out += HEX[b >> 4]! + HEX[b & 15]!;
  }

  return out;
}

let lastMs = 0;
let sequence = 0;

/** RFC 9562 UUIDv7: 48-bit unix ms, 12-bit monotonic counter, 62 random bits. */
export function uuidv7(now: number = Date.now()): string {
  // Monotonic within a millisecond, so two ids minted back to back still sort in mint order.
  if (now === lastMs) {
    sequence = (sequence + 1) & 0xfff;
  } else {
    lastMs = now;
    sequence = randomBytes(2)[0]! & 0xfff;
  }

  const bytes = randomBytes(16);
  const ms = Math.max(0, Math.floor(now));
  bytes[0] = (ms / 2 ** 40) & 0xff;
  bytes[1] = (ms / 2 ** 32) & 0xff;
  bytes[2] = (ms / 2 ** 24) & 0xff;
  bytes[3] = (ms / 2 ** 16) & 0xff;
  bytes[4] = (ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = 0x70 | (sequence >> 8);
  bytes[7] = sequence & 0xff;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const h = hex(bytes);

  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The creation time encoded in a UUIDv7, or null for anything else. */
export function uuidv7Time(id: string): number | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return null;

  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

/** 32 lowercase hex characters, the error-event id shape. */
export function hexId(): string {
  return hex(randomBytes(16));
}

/** Loose check for anything shaped like an id we minted, so a persisted value can be trusted. */
export function looksLikeId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 64 && /^[A-Za-z0-9._-]+$/.test(value);
}
