import type { Props } from '../core/normalize.js';
import { LIB, VERSION } from '../version.js';

/**
 * What every event says about where it came from. `$lib`, `$release` and `$environment` are the
 * columns the server promotes; the runtime and server name ride as free JSON on the event.
 */
export interface RuntimeInfo {
  readonly name: string;
  readonly version: string;
}

export function detectRuntime(): RuntimeInfo {
  const g = globalThis as Record<string, unknown>;
  const bun = (g['Bun'] as { version?: string } | undefined)?.version;
  if (typeof bun === 'string') return { name: 'bun', version: bun };
  const deno = (g['Deno'] as { version?: { deno?: string } } | undefined)?.version?.deno;
  if (typeof deno === 'string') return { name: 'deno', version: deno };
  const proc = g['process'] as { versions?: { node?: string } } | undefined;
  if (typeof proc?.versions?.node === 'string') return { name: 'node', version: proc.versions.node };
  if (typeof (g['navigator'] as { userAgent?: string } | undefined)?.userAgent === 'string') {
    const ua = (g['navigator'] as { userAgent: string }).userAgent;
    if (ua.includes('Cloudflare-Workers')) return { name: 'workerd', version: '' };
    if (ua.includes('Vercel')) return { name: 'edge-light', version: '' };
  }

  return { name: 'edge', version: '' };
}

export function baseContext(release: string, environment: string, serverName: string, runtime: RuntimeInfo): Props {
  const out: Props = {
    $lib: LIB,
    $lib_version: VERSION,
    $environment: environment,
    $runtime: runtime.name,
  };
  if (runtime.version !== '') out['$runtime_version'] = runtime.version;
  if (release !== '') out['$release'] = release;
  if (serverName !== '') out['$server_name'] = serverName;

  return out;
}
