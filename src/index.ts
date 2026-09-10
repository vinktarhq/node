import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { isMainThread } from 'node:worker_threads';
import { gzip } from 'node:zlib';

import type { Platform } from './client.js';
import { createFacade } from './facade.js';
import { detectRuntime } from './node/context.js';
import { asyncScopeStore, Scope } from './node/scope.js';
import { Spool } from './node/spool.js';

/**
 * The Node entry: a real async context, gzip on the thread pool, source read from disk, and a
 * process to hook. Everything here that touches `node:` lives in this file and in the platform it
 * builds; the client itself does not know which runtime it is on.
 */
export { Vinktar } from './client.js';
export { Scope } from './node/scope.js';
export { VERSION, LIB } from './version.js';
export type { VinktarOptions } from './options.js';
export type {
  Breadcrumb, CaptureContext, CrumbHook, EventHook, EventOptions, Frame, IdentifyOptions, Level, LogLevel, LogSink, Props,
  RequestInfo, SourceReader, Traits, User, WireException,
} from './types.js';
export type { WaitUntilContext } from './node/serverless.js';

const storage = new AsyncLocalStorage<Scope>();

export const nodePlatform: Platform = {
  name: 'node',
  runtime: detectRuntime(),
  environment: {
    env: (name) => process.env[name],
    hostname: () => {
      try {
        return hostname();
      } catch {
        return '';
      }
    },
    cwd: () => process.cwd(),
  },
  compress: (text) =>
    new Promise((resolve) => {
      gzip(text, (error, result) => resolve(error ? null : new Uint8Array(result.buffer, result.byteOffset, result.byteLength)));
    }),
  scopeStore: (root) => asyncScopeStore(storage, root),
  readSource: (path) => readFileSync(path, 'utf8'),
  process: process as unknown as NonNullable<Platform['process']>,
  isMainThread,
  spool: (path, logger) => new Spool(path, { ...fs, dirname }, process.pid, logger),
  deferred: false,
};

const facade = createFacade(nodePlatform, (message) => console.warn(`[vinktar] ${message}`));

export const init = facade.init;
export const getClient = facade.getClient;
export const track = facade.track;
export const page = facade.page;
export const identify = facade.identify;
export const setTraits = facade.setTraits;
export const setTraitsOnce = facade.setTraitsOnce;
export const unsetTraits = facade.unsetTraits;
export const setUser = facade.setUser;
export const reset = facade.reset;
export const register = facade.register;
export const registerOnce = facade.registerOnce;
export const unregister = facade.unregister;
export const captureException = facade.captureException;
export const captureMessage = facade.captureMessage;
export const addBreadcrumb = facade.addBreadcrumb;
export const setTag = facade.setTag;
export const setTags = facade.setTags;
export const setContext = facade.setContext;
export const scope = facade.scope;
export const withScope = facade.withScope;
export const scopeFromHeaders = facade.scopeFromHeaders;
export const registerHandlers = facade.registerHandlers;
export const setSourceReader = facade.setSourceReader;
export const flush = facade.flush;
export const close = facade.close;
