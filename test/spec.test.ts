import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { BLOCKED_IDS, isBlockedId } from '../src/core/blocked.js';
import { decide, networkFailure } from '../src/core/decide.js';
import { DENY_MESSAGES, EXTENSION_SCHEMES } from '../src/core/filters.js';
import * as limits from '../src/core/limits.js';
import { hashUnit } from '../src/core/sampling.js';
import { parseStack } from '../src/core/stack.js';
import { parseTraits, RESERVED_TRAITS, TRAIT_ALIASES } from '../src/core/traits.js';

/**
 * The vendored contract in `spec/` is what the server enforces. Every constant and every fixture
 * case is run here, so a number that drifts from the published one fails a build rather than a
 * customer's request.
 */
const spec = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../spec/${name}`, import.meta.url), 'utf8')) as T;

describe('limits.json', () => {
  const json = spec<Record<string, Record<string, unknown>>>('limits.json');

  it('matches the constants the SDK enforces', () => {
    expect(limits.MAX_REQUEST_BYTES).toBe(json['request']!['maxBodyBytes']);
    expect(limits.MAX_BATCH_ITEMS).toBe(json['batch']!['maxItems']);
    expect(limits.MAX_PROPERTIES_PER_EVENT).toBe(json['batch']!['maxPropertiesPerEvent']);
    expect(limits.MAX_STRING_BYTES).toBe(json['batch']!['maxStringBytes']);
    expect(limits.MAX_DEPTH).toBe(json['batch']!['maxNestingDepth']);
    expect(limits.MAX_TRAIT_VALUE_BYTES).toBe(json['traits']!['maxValueBytes']);
    expect(limits.MAX_TRAIT_KEY_BYTES).toBe(json['traits']!['maxKeyBytes']);
    expect(limits.MAX_TRAITS_PER_REQUEST).toBe(json['traits']!['maxKeysPerRequest']);
    expect(limits.MAX_TRAIT_REQUEST_BYTES).toBe(json['traits']!['maxRequestBytes']);
    const errors = json['errors']!;
    expect(limits.MAX_ERROR_ITEMS).toBe(errors['maxItems']);
    expect(limits.MAX_EXCEPTIONS).toBe(errors['maxExceptions']);
    expect(limits.MAX_FRAMES).toBe(errors['maxFrames']);
    expect(limits.MAX_TYPE_BYTES).toBe(errors['maxTypeBytes']);
    expect(limits.MAX_MESSAGE_BYTES).toBe(errors['maxMessageBytes']);
    expect(limits.MAX_STACK_RAW_BYTES).toBe(errors['maxStackRawBytes']);
    expect(limits.MAX_FRAME_STRING_BYTES).toBe(errors['maxFrameStringBytes']);
    expect(limits.MAX_EXCEPTIONS_BYTES).toBe(errors['maxExceptionsBytes']);
    expect(limits.MAX_BREADCRUMBS).toBe(errors['maxBreadcrumbs']);
    expect(limits.MAX_BREADCRUMBS_BYTES).toBe(errors['maxBreadcrumbsBytes']);
    expect(limits.MAX_TAGS).toBe(errors['maxTags']);
    expect(limits.MAX_TAG_KEY_BYTES).toBe(errors['maxTagKeyBytes']);
    expect(limits.MAX_TAG_VALUE_BYTES).toBe(errors['maxTagValueBytes']);
    expect(limits.MAX_FINGERPRINT_PARTS).toBe(errors['maxFingerprintParts']);
    expect(limits.MAX_FINGERPRINT_PART_BYTES).toBe(errors['maxFingerprintPartBytes']);
    expect([...limits.LEVELS]).toEqual(errors['levels']);
    expect([...limits.MECHANISMS]).toEqual(errors['mechanisms']);
    expect(errors['frameOrder']).toBe('crash-last');
    expect(errors['exceptionOrder']).toBe('thrown-first');
    expect(errors['columnBase']).toBe(0);
  });
});

describe('blocked-ids.json', () => {
  const json = spec<{ blocked: string[] }>('blocked-ids.json');

  it('is the list the SDK refuses', () => {
    expect([...BLOCKED_IDS].sort()).toEqual([...json.blocked].sort());
  });

  it('blocks case-insensitively, trimmed, and the empty string', () => {
    for (const id of json.blocked) expect(isBlockedId(` ${id.toUpperCase()} `)).toBe(true);
    expect(isBlockedId('')).toBe(true);
    expect(isBlockedId('   ')).toBe(true);
    expect(isBlockedId('user_123')).toBe(false);
  });
});

describe('inbound-filter.json', () => {
  const json = spec<{ denyMessageSubstrings: string[]; nonAppFrameSchemes: string[] }>('inbound-filter.json');

  it('mirrors what the server suppresses', () => {
    expect([...DENY_MESSAGES].sort()).toEqual([...json.denyMessageSubstrings].sort());
    expect([...EXTENSION_SCHEMES].sort()).toEqual([...json.nonAppFrameSchemes].sort());
  });
});

describe('reserved-traits.json', () => {
  const json = spec<{ canonical: string[]; aliases: Record<string, string> }>('reserved-traits.json');

  it('matches the canonical keys and aliases', () => {
    expect([...RESERVED_TRAITS].sort()).toEqual([...json.canonical].sort());
    expect(TRAIT_ALIASES).toEqual(json.aliases);
  });
});

describe('fixtures/sampling.json', () => {
  const json = spec<{ cases: Array<{ unit: string; hash: number }> }>('fixtures/sampling.json');

  for (const c of json.cases) {
    it(`hashes ${JSON.stringify(c.unit)} identically to every other SDK`, () => {
      expect(Math.abs(hashUnit(c.unit) - c.hash)).toBeLessThan(1e-12);
    });
  }
});

describe('fixtures/traits.json', () => {
  interface Case {
    name: string;
    in: Record<string, unknown>;
    out: { set: Record<string, string>; setOnce: Record<string, string>; unset: string[]; drops: Array<{ key: string; code: string }> };
  }
  const json = spec<{ cases: Case[] }>('fixtures/traits.json');
  const expand = (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    const m = /^<<(\d+) x( quoted)?>>$/.exec(value);
    if (m === null) return value;
    const text = 'x'.repeat(Number(m[1]));

    return m[2] ? JSON.stringify(text) : text;
  };
  const expandDeep = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(expandDeep)
      : typeof value === 'object' && value !== null
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandDeep(v)]))
        : expand(value);
  const encode = (traits: Record<string, unknown>): Record<string, string> =>
    Object.fromEntries(Object.entries(traits).map(([k, v]) => [k, JSON.stringify(v)]));
  const sortDrops = (drops: Array<{ key: string; code: string }>): string[] => drops.map((d) => `${d.key}|${d.code}`).sort();

  for (const c of json.cases) {
    it(c.name, () => {
      const input = expandDeep(c.in) as Record<string, unknown>;
      const expected = expandDeep(c.out) as Case['out'];
      const result = parseTraits(input);

      expect(encode(result.set)).toEqual(expected.set);
      expect(encode(result.setOnce)).toEqual(expected.setOnce);
      expect(result.unset).toEqual(expected.unset);
      expect(sortDrops(result.drops)).toEqual(sortDrops(expected.drops));
    });
  }
});

describe('fixtures/stacks.json', () => {
  interface Case {
    name: string;
    stack: string;
    frames: Array<{ file: string; function?: string; line: number; col?: number; in_app: boolean }>;
  }
  const json = spec<{ cases: Case[] }>('fixtures/stacks.json');

  for (const c of json.cases) {
    it(c.name, () => {
      expect(parseStack(c.stack)).toEqual(c.frames);
    });
  }
});

describe('fixtures/responses.json', () => {
  interface Case {
    name: string;
    status: number;
    body: unknown;
    action: string;
    degrade?: string;
    holdSeconds?: number | 'escalating';
    retrySeconds?: number;
  }
  const json = spec<{ cases: Case[] }>('fixtures/responses.json');

  for (const c of json.cases) {
    it(c.name, () => {
      const decision = c.status === 0 ? networkFailure() : decide(c.status, c.body, { retryAfter: c.retrySeconds ?? 0 });
      expect(decision.action).toBe(c.action);
      if (c.degrade !== undefined) expect(decision.degrade).toBe(c.degrade);
      if (typeof c.holdSeconds === 'number') expect(decision.wait).toBe(c.holdSeconds);
      if (c.holdSeconds === 'escalating') expect(decision.wait).toBe(0);
      if (c.retrySeconds !== undefined) expect(decision.wait).toBe(c.retrySeconds);
    });
  }
});
