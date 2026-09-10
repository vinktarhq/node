import { byteLength } from './bytes.js';
import { MAX_TRAIT_KEY_BYTES, MAX_TRAIT_VALUE_BYTES, MAX_TRAITS_PER_REQUEST } from './limits.js';
import { isUnsafeKey } from './normalize.js';

/**
 * Traits, parsed to exactly what the server stores. `spec/fixtures/traits.json` is the contract
 * and the test runs every case in it.
 *
 * Three operations, flat arguments, never a builder: `$set` (last write wins), `$set_once` (first
 * write wins) and `$unset`. A flat argument cannot express an invalid state, which is the reason
 * for the shape; what it can express, and what this file reports rather than resolves silently:
 *
 *   - **Reserved spellings.** `email` is `$email` on the server. The bare spelling is accepted and
 *     rewritten. An unknown `$`-prefixed key is dropped as `reserved_key`: that namespace has to
 *     stay the server's for future additions to be non-breaking.
 *   - **Scalars only.** A trait is a string, number or boolean. `null` is not storable (it is
 *     indistinguishable from an absent key once read back), so it is `invalid_type` and the caller
 *     is pointed at `$unset`.
 *   - **Oversize values are dropped, not truncated.** A truncated email is a wrong email.
 *   - **Contradictions.** The same key in `$set` and `$set_once`, or in a write and `$unset`, keeps
 *     the `$set` and reports the loser as `conflicting_op`.
 */
export const RESERVED_TRAITS: readonly string[] = ['$email', '$name', '$username', '$avatar', '$created'];

export const TRAIT_ALIASES: Readonly<Record<string, string>> = {
  email: '$email',
  name: '$name',
  username: '$username',
  avatar: '$avatar',
  created: '$created',
  createdat: '$created',
};

export type TraitValue = string | number | boolean;
export type Traits = Record<string, TraitValue>;

export type TraitDropCode =
  | 'reserved_key'
  | 'value_too_large'
  | 'invalid_type'
  | 'conflicting_op'
  | 'key_too_large'
  | 'too_many_keys';

export interface TraitDrop {
  readonly key: string;
  readonly code: TraitDropCode;
}

export interface ParsedTraits {
  readonly set: Traits;
  readonly setOnce: Traits;
  readonly unset: string[];
  readonly drops: TraitDrop[];
}

export interface TraitOps {
  readonly $set?: unknown;
  readonly $set_once?: unknown;
  readonly $unset?: unknown;
}

/** `$email` and `email` both become `$email`; an unknown `$key` is null. */
export function canonicalTraitKey(key: string): string | null {
  if (key.startsWith('$')) return RESERVED_TRAITS.includes(key) ? key : null;

  return TRAIT_ALIASES[key.toLowerCase().replace(/_/g, '')] ?? key;
}

export function parseTraits(ops: TraitOps): ParsedTraits {
  const drops: TraitDrop[] = [];
  const budget = { remaining: MAX_TRAITS_PER_REQUEST };

  const set = parseMap(ops.$set, budget, drops);
  const setOnce = parseMap(ops.$set_once, budget, drops);
  const unset = parseUnset(ops.$unset, budget, drops);

  // `$set` wins every collision. The losing operation is reported, never applied.
  for (const key of Object.keys(setOnce)) {
    if (key in set) {
      delete setOnce[key];
      drops.push({ key, code: 'conflicting_op' });
    }
  }
  const survivingUnset = unset.filter((key) => {
    if (key in set || key in setOnce) {
      drops.push({ key, code: 'conflicting_op' });

      return false;
    }

    return true;
  });

  return { set, setOnce, unset: survivingUnset, drops };
}

function parseMap(input: unknown, budget: { remaining: number }, drops: TraitDrop[]): Traits {
  const out: Traits = {};
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return out;

  for (const rawKey of Object.keys(input)) {
    if (isUnsafeKey(rawKey)) continue;
    const value = (input as Record<string, unknown>)[rawKey];
    if (value === undefined) continue;

    const key = canonicalTraitKey(rawKey);
    if (key === null) {
      drops.push({ key: rawKey, code: 'reserved_key' });
      continue;
    }
    if (byteLength(key) > MAX_TRAIT_KEY_BYTES) {
      drops.push({ key: rawKey, code: 'key_too_large' });
      continue;
    }
    if (typeof value === 'string') {
      if (byteLength(value) > MAX_TRAIT_VALUE_BYTES) {
        drops.push({ key, code: 'value_too_large' });
        continue;
      }
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        drops.push({ key, code: 'invalid_type' });
        continue;
      }
    } else if (typeof value !== 'boolean') {
      drops.push({ key, code: 'invalid_type' });
      continue;
    }
    if (budget.remaining <= 0) {
      drops.push({ key, code: 'too_many_keys' });
      continue;
    }

    out[key] = value;
    budget.remaining -= 1;
  }

  return out;
}

function parseUnset(input: unknown, budget: { remaining: number }, drops: TraitDrop[]): string[] {
  const out: string[] = [];
  if (!Array.isArray(input)) return out;

  for (const raw of input) {
    if (typeof raw !== 'string' || raw === '') {
      drops.push({ key: '', code: 'invalid_type' });
      continue;
    }
    const key = canonicalTraitKey(raw);
    if (key === null) {
      drops.push({ key: raw, code: 'reserved_key' });
      continue;
    }
    if (byteLength(key) > MAX_TRAIT_KEY_BYTES) {
      drops.push({ key: raw, code: 'key_too_large' });
      continue;
    }
    if (budget.remaining <= 0) {
      drops.push({ key, code: 'too_many_keys' });
      continue;
    }
    if (out.includes(key)) continue;

    out.push(key);
    budget.remaining -= 1;
  }

  return out;
}

/** Explain a drop in a sentence, for the warning that always accompanies one. */
export function describeTraitDrop(drop: TraitDrop): string {
  switch (drop.code) {
    case 'reserved_key':
      return `trait "${drop.key}" was dropped: the $ namespace is reserved (${RESERVED_TRAITS.join(', ')})`;
    case 'value_too_large':
      return `trait "${drop.key}" was dropped: values are capped at ${MAX_TRAIT_VALUE_BYTES} bytes and are never truncated`;
    case 'invalid_type':
      return drop.key === ''
        ? 'an $unset entry was dropped: keys must be non-empty strings'
        : `trait "${drop.key}" was dropped: values must be a string, number or boolean (use $unset to remove a key)`;
    case 'conflicting_op':
      return `trait "${drop.key}" appeared in two operations; $set won and the other was dropped`;
    case 'key_too_large':
      return `trait "${drop.key.slice(0, 40)}…" was dropped: keys are capped at ${MAX_TRAIT_KEY_BYTES} bytes`;
    case 'too_many_keys':
      return `trait "${drop.key}" was dropped: at most ${MAX_TRAITS_PER_REQUEST} keys per identify call`;
  }
}
