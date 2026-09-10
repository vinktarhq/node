import { describe, expect, it } from 'vitest';

import * as edge from '../src/edge.js';
import * as facade from '../src/index.js';
import { Vinktar } from '../src/client.js';

/**
 * The public surface, spelled out. A method added, renamed or removed fails here until this list
 * and the README agree with it.
 */
const FACADE = [
  'addBreadcrumb',
  'captureException',
  'captureMessage',
  'close',
  'flush',
  'getClient',
  'identify',
  'init',
  'page',
  'register',
  'registerHandlers',
  'registerOnce',
  'reset',
  'scope',
  'scopeFromHeaders',
  'setContext',
  'setSourceReader',
  'setTag',
  'setTags',
  'setTraits',
  'setTraitsOnce',
  'setUser',
  'track',
  'unregister',
  'unsetTraits',
  'withScope',
];

const CLIENT = [...FACADE.filter((name) => !['init', 'getClient'].includes(name)), 'enterScope', 'flushIfServerless'];

const functions = (module: Record<string, unknown>): string[] =>
  Object.keys(module)
    .filter((key) => typeof module[key] === 'function')
    .filter((key) => key !== 'Vinktar' && key !== 'Scope')
    .sort();

describe('the public API surface', () => {
  it('exports exactly the documented functions', () => {
    expect(functions(facade as Record<string, unknown>)).toEqual(FACADE);
  });

  it('exports the same surface from the edge entry, plus the waitUntil helper', () => {
    expect(functions(edge as Record<string, unknown>)).toEqual([...FACADE, 'flushIfServerless'].sort());
  });

  it('carries every documented method on the class too', () => {
    const methods = new Set(Object.getOwnPropertyNames(Vinktar.prototype));
    for (const name of CLIENT) expect(methods.has(name), `Vinktar#${name}`).toBe(true);
  });

  it('spells teardown close()', () => {
    expect('destroy' in facade).toBe(false);
    expect('shutdown' in facade).toBe(false);
  });

  it('takes identify options by name, so the fourth argument cannot mean two things', () => {
    expect(facade.identify.length).toBe(4);
  });
});
