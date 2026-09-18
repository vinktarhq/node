/**
 * Byte-accurate string handling.
 *
 * The server counts BYTES, not characters. A name with an emoji in it is four bytes per emoji, so
 * a 100-character string can be 400 bytes and get rejected outright; the server does not truncate,
 * it refuses the whole event. Comparing `string.length` against a byte threshold is wrong for any
 * non-ASCII payload, and it is wrong silently.
 */

let cached: TextEncoder | null | undefined;

/**
 * Made on first use, not when the module loads: importing the SDK must work in a runtime that has
 * no `TextEncoder` (or whose `TextEncoder` throws), and it is the import that an application
 * cannot wrap in a `try`.
 */
function encoder(): TextEncoder | null {
  if (cached === undefined) {
    try {
      cached = new TextEncoder();
    } catch {
      cached = null;
    }
  }

  return cached;
}

export function byteLength(value: string): number {
  return encodeUtf8(value).length;
}

/**
 * Truncate to a byte budget without splitting a UTF-8 sequence.
 *
 * `encodeInto` never writes a partial character and reports how many UTF-16 units it consumed,
 * which is exactly the cut point. One allocation the size of the budget, no loop, no mojibake at a
 * surrogate pair, and a string far over the budget is never encoded whole to find that out.
 */
export function truncateToBytes(value: string, maxBytes: number): string {
  if (value.length * 3 <= maxBytes) return value;
  const utf8 = encoder();
  if (utf8 === null) {
    let kept = '';
    let bytes = 0;
    for (const character of value) {
      bytes += encodeUtf8(character).length;
      if (bytes > maxBytes) break;
      kept += character;
    }

    return kept;
  }
  // A UTF-16 unit is at least one byte, so only a string this short can still fit.
  if (value.length <= maxBytes && utf8.encode(value).length <= maxBytes) return value;

  const scratch = new Uint8Array(Math.max(0, maxBytes));
  const { read } = utf8.encodeInto(value, scratch);

  return value.slice(0, read);
}

export function encodeUtf8(value: string): Uint8Array {
  const utf8 = encoder();
  if (utf8 !== null) return utf8.encode(value);

  // By hand, with a lone surrogate as U+FFFD, which is what `TextEncoder` makes of one.
  const bytes: number[] = [];
  for (const character of value) {
    let point = character.codePointAt(0) ?? 0;
    if (point >= 0xd800 && point <= 0xdfff) point = 0xfffd;
    if (point < 0x80) bytes.push(point);
    else if (point < 0x800) bytes.push(0xc0 | (point >> 6), 0x80 | (point & 63));
    else if (point < 0x10000) bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 63), 0x80 | (point & 63));
    else bytes.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 63), 0x80 | ((point >> 6) & 63), 0x80 | (point & 63));
  }

  return Uint8Array.from(bytes);
}
