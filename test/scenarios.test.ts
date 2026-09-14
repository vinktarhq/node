import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { Vinktar } from '../src/client.js';
import { nodePlatform } from '../src/index.js';
import type { VinktarOptions } from '../src/options.js';
import { makeHarness, type Harness } from './harness.js';

/**
 * The behaviour scenarios in `spec/fixtures/scenarios.json`, run against the public API with a
 * scripted ingest. Only what reaches the wire is asserted. Browser-only scenarios (a page's
 * persisted device) do not apply to a server and are skipped.
 */
interface Step {
  do: string;
  args?: unknown[];
  client?: string;
  steps?: Step[];
  branches?: Step[][];
  returns?: unknown;
  throws?: string;
  await?: boolean;
}

interface Match {
  client?: string;
  endpoint: string;
  item?: Record<string, unknown>;
  identify?: Record<string, unknown>;
  maxTopLevelKeys?: { of: string[]; max: number };
}

interface Scenario {
  name: string;
  capability: 'common' | 'backend' | 'browser';
  clients?: string[];
  options?: Record<string, unknown>;
  respond?: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>;
  steps: Step[];
  expect?: {
    sent?: Match[];
    notSent?: Match[];
    requests?: Record<string, number>;
    errorCount?: Record<string, number>;
    report?: Array<{ reason: string; category: string; quantity: number }>;
  };
}

interface WireItem {
  readonly client: string;
  readonly endpoint: string;
  readonly kind: 'item' | 'identify';
  readonly value: Record<string, unknown>;
}

const { scenarios } = JSON.parse(readFileSync(new URL('../spec/fixtures/scenarios.json', import.meta.url), 'utf8')) as { scenarios: Scenario[] };
const keyFor = (name: string): string => `vnk_sk_scenario_${name}`;

const open: Vinktar[] = [];
afterEach(async () => {
  for (const client of open.splice(0)) await client.close();
});

/** Marks the value a nested `value` step asked the enclosing callback to return. */
class Returned {
  constructor(readonly value: unknown) {}
}

function arg(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const error = /^error\((.*)\)$/.exec(value);
  if (error) return new Error(error[1]);
  const props = /^props\((\d+)\)$/.exec(value);
  if (props) return Object.fromEntries(Array.from({ length: Number(props[1]) }, (_, i) => [`p${i}`, 'v']));
  const big = /^bigint\((\d+)\)$/.exec(value);
  if (big) return BigInt(big[1]!);

  return value;
}

function clientOptions(scenario: Scenario, name: string, harness: Harness): VinktarOptions {
  const { hooks, writeKey, ...rest } = scenario.options ?? {};
  const options: Record<string, unknown> = {
    fetch: harness.fetch,
    logger: () => {},
    autoFlush: false,
    breadcrumbs: false,
    flushIntervalMs: 60_000,
    ...(writeKey === null ? {} : { writeKey: keyFor(name) }),
    ...rest,
  };
  if (hooks === 'poisonProperty') {
    options['beforeTrack'] = (event: Record<string, unknown>) => (event['name'] === 'poison' ? { ...event, poison: 10n } : event);
  }

  return options as VinktarOptions;
}

async function runSteps(clients: Map<string, Vinktar>, fallback: string, steps: Step[]): Promise<Returned | undefined> {
  for (const step of steps) {
    const result = await runStep(clients, fallback, step);
    if (result instanceof Returned) return result;
  }

  return undefined;
}

async function runStep(clients: Map<string, Vinktar>, fallback: string, step: Step): Promise<Returned | undefined> {
  const client = clients.get(step.client ?? fallback)!;
  const nested = (): Promise<Returned | undefined> => runSteps(clients, fallback, step.steps ?? []);

  if (step.do === 'value') return new Returned(step.args?.[0]);
  if (step.do === 'throw') throw new Error(String(step.args?.[0]));
  if (step.do === 'yield') {
    await new Promise((resolve) => setImmediate(resolve));

    return undefined;
  }
  if (step.do === 'parallel') {
    await Promise.all((step.branches ?? []).map((branch) => runSteps(clients, fallback, branch)));

    return undefined;
  }
  if (step.do === 'awaitClose') {
    const result = await (clients as unknown as { closing?: Promise<unknown> }).closing;
    if ('returns' in step) expect(result, 'awaitClose returns').toEqual(step.returns);

    return undefined;
  }

  let result: unknown;
  let threw: unknown;
  try {
    if (step.do === 'withScope') {
      result = (await client.withScope(async () => nested()))?.value;
    } else if (step.do === 'enterScope') {
      // A request boundary: entered inside its own async context, as a framework hook would be.
      result = (await client.withScope(async () => {
        client.enterScope();

        return nested();
      }))?.value;
    } else {
      const method = (client as unknown as Record<string, unknown>)[step.do];
      if (typeof method !== 'function') throw new Error(`scenario step "${step.do}" has no server equivalent`);
      // Skipped optional positions are written as null in JSON; identify's traits mean "not given".
      const args = (step.args ?? []).map((value, index) => (step.do === 'identify' && index > 0 && value === null ? undefined : arg(value)));
      const value = (method as (...args: unknown[]) => unknown).apply(client, args);
      if (step.do === 'close' && step.await === false) (clients as unknown as { closing?: unknown }).closing = value;
      result = step.await === false ? undefined : await value;
    }
  } catch (error) {
    threw = error;
  }

  if (step.throws !== undefined) expect((threw as Error | undefined)?.message, `${step.do} throws`).toBe(step.throws);
  else if (threw !== undefined) throw threw;
  if ('returns' in step && step.await !== false) expect(result, `${step.do} returns`).toEqual(step.returns);

  return undefined;
}

/** Partial deep match. `null` means absent or empty; arrays match element-wise from the start. */
function matches(expected: unknown, actual: unknown): boolean {
  if (expected === null) {
    return actual === undefined || actual === null || actual === '' || (typeof actual === 'object' && Object.keys(actual).length === 0);
  }
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((value, index) => matches(value, actual[index]));
  if (typeof expected === 'object') {
    const record = typeof actual === 'object' && actual !== null ? (actual as Record<string, unknown>) : undefined;
    if (record === undefined) return Object.values(expected).every((value) => value === null);

    return Object.entries(expected).every(([key, value]) => matches(value, record[key]));
  }

  return expected === actual;
}

describe('fixtures/scenarios.json', () => {
  for (const scenario of scenarios.filter((s) => s.capability !== 'browser')) {
    it(scenario.name, async () => {
      const harness = makeHarness();
      for (const response of scenario.respond ?? []) harness.respond(response.status, response.body ?? null, response.headers ?? {});
      const names = scenario.clients ?? ['default'];
      const clients = new Map<string, Vinktar>();
      for (const name of names) {
        const client = new Vinktar(clientOptions(scenario, name, harness), nodePlatform);
        clients.set(name, client);
        open.push(client);
      }

      await runSteps(clients, names[0]!, scenario.steps);

      const clientOf = (key: string | undefined): string => names.find((name) => keyFor(name) === key) ?? names[0]!;
      const items: WireItem[] = [];
      const reports: Array<Record<string, unknown>> = [];
      const carrying: Array<{ client: string; endpoint: string }> = [];
      for (const request of harness.requests) {
        const endpoint = new URL(request.url).pathname;
        const client = clientOf(request.headers['x-vinktar-key']);
        const list = (key: string): Array<Record<string, unknown>> => (Array.isArray(request.body[key]) ? (request.body[key] as Array<Record<string, unknown>>) : []);
        if (endpoint === '/v1/batch') {
          for (const value of list('batch')) items.push({ client, endpoint, kind: 'item', value });
          for (const value of list('identify')) items.push({ client, endpoint, kind: 'identify', value });
        }
        if (endpoint === '/v1/errors') for (const value of list('errors')) items.push({ client, endpoint, kind: 'item', value });
        if (['batch', 'identify', 'errors'].some((key) => list(key).length > 0)) carrying.push({ client, endpoint });
        const discarded = (request.body['client_report'] as { discarded?: unknown } | undefined)?.discarded;
        if (Array.isArray(discarded)) reports.push(...(discarded as Array<Record<string, unknown>>));
      }

      const expectations = scenario.expect ?? {};
      const find = (match: Match): WireItem | undefined =>
        items.find((item) => {
          if (item.endpoint !== match.endpoint || item.client !== (match.client ?? names[0])) return false;
          if (match.identify !== undefined ? item.kind !== 'identify' || !matches(match.identify, item.value) : item.kind !== 'item' || !matches(match.item ?? {}, item.value)) return false;
          if (match.maxTopLevelKeys !== undefined) {
            const keys = new Set(match.maxTopLevelKeys.of.flatMap((field) => Object.keys((item.value[field] as object | undefined) ?? {})));
            if (keys.size > match.maxTopLevelKeys.max) return false;
          }

          return true;
        });

      for (const match of expectations.sent ?? []) expect(find(match), `sent ${JSON.stringify(match)}`).toBeDefined();
      for (const match of expectations.notSent ?? []) expect(find(match), `not sent ${JSON.stringify(match)}`).toBeUndefined();
      for (const [endpoint, count] of Object.entries(expectations.requests ?? {})) {
        expect(carrying.filter((r) => r.endpoint === endpoint && r.client === names[0]), `requests to ${endpoint}`).toHaveLength(count);
      }
      for (const [message, count] of Object.entries(expectations.errorCount ?? {})) {
        const sent = items.filter((i) => i.endpoint === '/v1/errors' && (i.value['exceptions'] as Array<{ value?: string }> | undefined)?.[0]?.value === message);
        expect(sent, `occurrences of "${message}"`).toHaveLength(count);
      }
      for (const entry of expectations.report ?? []) expect(reports, `client report ${JSON.stringify(entry)}`).toContainEqual(entry);
    });
  }
});
