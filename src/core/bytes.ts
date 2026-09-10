/**
 * Byte-accurate string handling.
 *
 * The server counts BYTES, not characters. A name with an emoji in it is four bytes per emoji, so
 * a 100-character string can be 400 bytes and get rejected outright; the server does not truncate,
 * it refuses the whole event. Comparing `string.length` against a byte threshold is wrong for any
 * non-ASCII payload, and it is wrong silently.
 */

const encoder = /*#__PURE__*/ new TextEncoder();

export function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/**
 * Truncate to a byte budget without splitting a UTF-8 sequence.
 *
 * `encodeInto` never writes a partial character and reports how many UTF-16 units it consumed,
 * which is exactly the cut point. One allocation, no loop, no mojibake at a surrogate pair.
 */
export function truncateToBytes(value: string, maxBytes: number): string {
  if (value.length * 3 <= maxBytes) return value;
  if (encoder.encode(value).length <= maxBytes) return value;

  const scratch = new Uint8Array(Math.max(0, maxBytes));
  const { read } = encoder.encodeInto(value, scratch);

  return value.slice(0, read);
}

export function encodeUtf8(value: string): Uint8Array {
  return encoder.encode(value);
}
