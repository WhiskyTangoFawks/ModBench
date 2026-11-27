import { expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createMEditClient } from '..';
import type { components } from '../../wire/generated/api';
import { settled } from '../../test/eventually';
import { IGNORED_THROWS, notificationEventFixture } from './fixtures';
import { answered } from './healthAnswer';

type Deps = Parameters<typeof createMEditClient>[0];
type Backend = NonNullable<Deps['backend']>;
type NotificationEvent = components['schemas']['NotificationEvent'];
export type Route = readonly [match: string, handle: (request: Request) => Promise<Response>];

export const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const noContent = (): Promise<Response> => Promise.resolve(new Response(null, { status: 204 }));

export const neverFetch = () => (): Promise<Response> => new Promise<Response>(() => {});

export const fakeLogChannel = (logLevel = 3) => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), logLevel });

/** Answers each request from the longest route its URL holds, the first of equals, and rejects one no route names. */
export function routedFetch(routes: readonly Route[]) {
  return vi.fn((request: Request) => {
    const route = routes.filter(([match]) => request.url.includes(match)).reduce<Route | undefined>(
      (longest, next) => (longest === undefined || next[0].length > longest[0].length ? next : longest), undefined);
    return route ? route[1](request) : Promise.reject(new Error(`unrouted fetch: ${request.method} ${request.url}`));
  });
}

const encoder = new TextEncoder();

export const sseFrame = (event: NotificationEvent): Uint8Array =>
  encoder.encode(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);

export interface NotificationStream {
  write(bytes: Uint8Array): void;
  end(): void;
  readonly signal: AbortSignal;
}

/** Each notification stream the client opens, which a test writes to and ends. */
export function notificationStreams() {
  const streams: NotificationStream[] = [];
  const open = (request: Request): Promise<Response> => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    streams.push({ write: (bytes) => { controller.enqueue(bytes); }, end: () => { controller.close(); }, signal: request.signal });
    return Promise.resolve(new Response(body, { status: 200 }));
  };
  return { streams, open };
}

export interface BackendProcess {
  readonly executable: string;
  readonly args: readonly string[];
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly killed: readonly string[];
  exit(code: number | null, signal?: NodeJS.Signals | null): void;
  fail(error: Error): void;
}

/** The processes a client spawns. Each exits as its stdin closes, as `--ExitWhenStdinCloses` asks, unless it ignores
 *  that. */
export function backendProcesses({ ignoresStdinClose = false } = {}) {
  const spawned: BackendProcess[] = [];
  const spawn = (executable: string, args: string[]) => {
    const events = new EventEmitter();
    const killed: string[] = [];
    const stdin = new PassThrough();
    const child = Object.assign(events, {
      executable, args, stdin, stdout: new PassThrough(), stderr: new PassThrough(), killed,
      kill: (signal: string) => { killed.push(signal); },
      exit: (code: number | null, signal: NodeJS.Signals | null = null) => { events.emit('exit', code, signal); },
      fail: (error: Error) => { events.emit('error', error); },
    });
    if (!ignoresStdinClose) stdin.on('finish', () => { child.exit(0); });
    spawned.push(child);
    return child;
  };
  return { spawned, spawn };
}

/** A backend the client spawns on port 5172, which answers /health as `healthy` says, at once by default. */
export function spawnedBackend(overrides: Partial<Backend> = {}, processes = backendProcesses()) {
  const backend: Backend = {
    freePort: () => Promise.resolve(5172), executablePath: '/x/backend', spawn: processes.spawn,
    pollIntervalMs: 1, pollTimeoutMs: 60_000, checkHealth: () => Promise.resolve(answered(true)), ...overrides,
  };
  return { backend, spawned: processes.spawned };
}

/** A client over `backend`, which talks to nothing unless `deps` say how it fetches. */
export const clientOver = (backend: Backend, deps: Partial<Omit<Deps, 'backend'>> = {}) =>
  createMEditClient({ listenerThrows: IGNORED_THROWS, backendLog: fakeLogChannel(0), fetch: neverFetch(), backend, ...deps });

const MARKS = '/heard/';

/** Whether a folder told as set aside is one the fake's `fire` marks its frames with. */
export const isMark = (folder: string): boolean => folder.startsWith(MARKS);

type FakeMEditOptions = {
  routes?: readonly Route[];
  backend?: Partial<Backend>;
  /** The processes the client spawns, which a test may wrap in a spawn of its own. */
  processes?: ReturnType<typeof backendProcesses>;
  /** The attempts to open the notification stream, counted from 0, that are refused. */
  refusedOpens?: readonly number[];
} & Partial<Omit<Deps, 'fetch' | 'backend'>>;

/** A client over a spawned backend whose routes a test names, and whose notification streams it writes. */
export function fakeMEdit({ routes = [], backend: overrides, processes = backendProcesses(), refusedOpens = [], ...deps }: FakeMEditOptions = {}) {
  const { streams, open } = notificationStreams();
  let attempts = 0;
  const openUnlessRefused = (request: Request): Promise<Response> =>
    (refusedOpens.includes(attempts++) ? Promise.reject(new Error('ECONNREFUSED')) : open(request));
  const { backend, spawned } = spawnedBackend(overrides, processes);
  const fetch = routedFetch([...routes, ['/notifications/stream', openUnlessRefused],
    ['/load-order/status', () => Promise.resolve(new Response(null, { status: 404 }))],
    ['/load-order/sequence', () => Promise.resolve(jsonResponse(200, 0))],
  ]);
  const client = clientOver(backend, { reconnectDelayMs: 0, fetch, ...deps });
  let marks = 0;

  /** Writes each event to the open stream, and settles once the client has dispatched them. */
  const fire = async (...events: NotificationEvent[]): Promise<void> => {
    const folder = `${MARKS}${++marks}`;
    const heard = new Promise<void>((resolve) => {
      const off = client.onFilesSetAside((setAside) => { if (setAside.folder === folder) { off(); resolve(); } });
    });
    const mark = notificationEventFixture({ kind: 'files-set-aside', folder, setAside: [] });
    for (const event of [...events, mark]) streams.at(-1)?.write(sseFrame(event));
    await heard;
  };

  return {
    client, streams, spawned, fetch, fire,
    /** Starts mEdit, and settles once its notification stream is open. */
    start: async (): Promise<void> => {
      const opened = streams.length;
      await client.start();
      await settled(() => { expect(streams).toHaveLength(opened + 1); });
    },
    /** The open stream ends, and this settles once the client has heard from the one it opens next. */
    reopen: async (): Promise<void> => {
      const opened = streams.length;
      streams.at(-1)?.end();
      await settled(() => { expect(streams).toHaveLength(opened + 1); });
      await fire();
    },
    /** mEdit exits on its own, and this settles once the client has heard it. */
    exit: async (): Promise<void> => {
      spawned.at(-1)?.exit(1);
      await settled(() => { expect(client.status).toBe('stopped'); });
    },
  };
}

/** {@link fakeMEdit}, started. */
export async function runningMEdit(options: FakeMEditOptions = {}) {
  const mEdit = fakeMEdit(options);
  await mEdit.start();
  return mEdit;
}
