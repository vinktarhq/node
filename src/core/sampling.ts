import { encodeUtf8 } from './bytes.js';

/**
 * Deterministic sampling.
 *
 * A given unit is consistently kept or dropped, so a sampled funnel is made of whole journeys
 * rather than a scatter of half-observed ones. FNV-1a over UTF-8 BYTES, mapped to [0, 1) exactly
 * this way, because every Vinktar SDK does the same and `spec/fixtures/sampling.json` pins the
 * corpus: the same user must be in or out of the sample from a browser and from a server, or one
 * funnel has two populations. Hashing UTF-16 code units instead is invisible for ASCII ids and
 * silently wrong for any id with an accent in it.
 */
export function hashUnit(unit: string): number {
  const bytes = encodeUtf8(unit);
  let hash = 2166136261;

  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i]!;
    // `Math.imul` keeps the multiply in 32-bit integer space; a plain `*` loses precision past 2^53.
    hash = Math.imul(hash, 16777619) >>> 0;
  }

  return hash / 0xffffffff;
}

export function sampled(unit: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  // Nothing stable to key on. Keeping is the safer failure: dropping unattributed traffic would
  // bias exactly the anonymous funnel people care about.
  if (unit === '') return true;

  return hashUnit(unit) < rate;
}
