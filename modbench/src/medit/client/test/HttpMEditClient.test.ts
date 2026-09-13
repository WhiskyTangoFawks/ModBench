import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { HttpMEditClient } from '../HttpMEditClient';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// A fetch double that never answers — the health check below (backendLifecycle.ts's own
// injectable) is what actually drives lifecycle in these tests; nothing here calls the API client.
function neverFetch(): (input: Request) => Promise<Response> {
  return () => new Promise<Response>(() => {});
}

function makeClient(fetch: (input: Request) => Promise<Response>, health: 'up' | 'down' = 'up', timeoutMs?: number) {
  return new HttpMEditClient({
    backend: {
      port: 5172, pollIntervalMs: 5, pollTimeoutMs: 20,
      checkHealth: () => Promise.resolve(health === 'up'),
    },
    fetch, timeoutMs,
  });
}

// A stream response that stays open (a reader on it never settles) — for the notification
// stream endpoint, whose connection this suite cares about, never its frames.
function openStreamResponse(): Response {
  return new Response(new ReadableStream({ start: () => {} }), { status: 200 });
}

// Dispatches by URL substring — for a test that scripts both the notification stream and one
// API call through the same injected `fetch`.
function routedFetch(routes: [match: string, handle: (req: Request) => Promise<Response>][]) {
  return vi.fn((req: Request) => {
    const route = routes.find(([match]) => req.url.includes(match));
    if (!route) return Promise.reject(new Error(`unrouted fetch: ${req.method} ${req.url}`));
    return route[1](req);
  });
}

describe('HttpMEditClient — the process is the client\'s own', () => {
  beforeEach(() => { vi.resetAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  // A cached copy of a push-only event can disagree with the process it describes; the lifecycle
  // is inside this client, so the read is the process's own.
  it('reads the lifecycle\'s own status, not a cached copy of it', async () => {
    const client = makeClient(neverFetch());
    expect(client.status).toBe('starting');

    await client.start();

    expect(client.status).toBe('attached');
  });

  it('reports every status change to its listeners', async () => {
    const client = makeClient(neverFetch());
    const seen: string[] = [];
    client.onStatusChanged((s) => seen.push(s));

    await client.start();
    await client.stop();

    expect(seen).toEqual(['attached', 'stopped']);
  });

  it('an unsubscribed listener hears nothing more', async () => {
    const client = makeClient(neverFetch());
    const seen: string[] = [];
    const off = client.onStatusChanged((s) => seen.push(s));

    await client.start();
    off();
    await client.stop();

    expect(seen).toEqual(['attached']);
  });
});

// ADR-0014 invariant 2: the notification stream follows the status, and only this module drives
// it — scripted here through the injected `fetch`, the same seam production wires to `undici`.
describe('HttpMEditClient — the notification stream follows the status', () => {
  beforeEach(() => { vi.resetAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('opens the stream when the backend attaches', async () => {
    const fetch = vi.fn((req: Request) => {
      expect(req.url).toContain('/notifications/stream');
      return Promise.resolve(new Response(new ReadableStream({ start: () => {} }), { status: 200 })); // stays open
    });
    const client = makeClient(fetch);

    await client.start();

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  });

  it('closes the stream when the backend stops', async () => {
    let sawSignal: AbortSignal | undefined;
    const fetch = vi.fn((req: Request) => {
      sawSignal = req.signal;
      return new Promise<Response>(() => {}); // never resolves — stop() must abort it directly
    });
    const client = makeClient(fetch);
    await client.start();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    await client.stop();

    expect(sawSignal?.aborted).toBe(true);
  });

  it('closes the stream when the backend goes disconnected', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(new ReadableStream({ start: () => {} }), { status: 200 })));
    const client = makeClient(fetch, 'down');

    await client.start();

    expect(client.status).toBe('disconnected');
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ADR-0019: the adapter's own logic — transport, timeouts and error mapping — with the per-verb
// wiring left to the backend's own handler tests.
describe('HttpMEditClient — a 503 from a write', () => {
  // 503 has one meaning left: the load order went away. The rival is a client that reads more
  // into the status than the detail says.
  it('relays the load-order-absent 503 as the backend worded it', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(503, { detail: 'No load order has been received.' })));
    const client = makeClient(fetch);

    const result = await client.renumberRecord('000800:MyPatch.esp', 'MyPatch.esp', 'ModA');

    expect(result).toEqual({ refused: true, message: 'mEdit: Could not renumber 000800:MyPatch.esp — No load order has been received.' });
  });
});

describe('HttpMEditClient — the ESL contradiction detail', () => {
  it('an eslContradiction refusal calls the hook with the refusal detail, skipping the generic refusal', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(422, {
      eslContradiction: true, detail: 'MyPatch.esp has exhausted its ESL FormKey space',
    })));
    const client = makeClient(fetch);
    const onEslContradiction = vi.fn().mockResolvedValue(false);

    const result = await client.createRecord('MyPatch.esp', 'ModA', 'npc_', undefined, undefined, onEslContradiction);

    expect(result).toBeUndefined();
    expect(onEslContradiction).toHaveBeenCalledWith('MyPatch.esp has exhausted its ESL FormKey space');
  });

  it('accepting the hook retries the create once and resolves the retry\'s own response', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(422, { eslContradiction: true, detail: 'exhausted' }))
      .mockResolvedValueOnce(jsonResponse(200, { applied: true, formKey: '001000:MyPatch.esp', recordType: 'npc_' }));
    const client = makeClient(fetch);
    const onEslContradiction = vi.fn().mockResolvedValue(true);

    const result = await client.createRecord('MyPatch.esp', 'ModA', 'npc_', undefined, undefined, onEslContradiction);

    expect(result).toEqual({ applied: true, formKey: '001000:MyPatch.esp', recordType: 'npc_' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('HttpMEditClient — the not-OK response text', () => {
  it('resolves a WriteRefused carrying the identity and the server text on a non-ok response', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(404, 'Not Found')));
    const client = makeClient(fetch);

    const result = await client.deleteRecord('000801:MyPatch.esp', 'MyPatch.esp', 'ModA');

    expect(result).toEqual({ refused: true, message: 'mEdit: Could not delete 000801:MyPatch.esp — Not Found' });
  });

  it('resolves a WriteRefused the same way for a thrown request', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('socket hang up')));
    const client = makeClient(fetch);

    const result = await client.deleteRecord('000801:MyPatch.esp', 'MyPatch.esp', 'ModA');

    expect(result).toEqual({ refused: true, message: 'mEdit: Could not delete 000801:MyPatch.esp — socket hang up' });
  });

  it('editRecord leaves an ordinary typed refusal exactly as the backend worded it', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(422, {
      refusal: 'PluginNotTracked', detail: 'MyPatch.esp is not tracked, so it is read-only.',
    })));
    const client = makeClient(fetch);

    const outcome = await client.editRecord(
      '000800:MyPatch.esp', 'MyPatch.esp', 'ModA', { op: 'set', path: [{ kind: 'member', name: 'EditorID' }], value: 'x' },
    );

    expect(outcome).toEqual({
      applied: false, refusal: 'PluginNotTracked', message: 'MyPatch.esp is not tracked, so it is read-only.',
    });
  });

  // 503 has one meaning: the load order went away. There is no typed refusal in it, so the
  // outcome carries this side's own 'Unknown'.
  it('editRecord leaves the load-order-absent 503 alone', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(503, { detail: 'No load order has been received.' })));
    const client = makeClient(fetch);

    const outcome = await client.editRecord(
      '000800:MyPatch.esp', 'MyPatch.esp', 'ModA', { op: 'set', path: [{ kind: 'member', name: 'EditorID' }], value: 'x' },
    );

    expect(outcome).toEqual({ applied: false, refusal: 'Unknown', message: 'No load order has been received.' });
  });
});

// putLoadOrder's own transport: the wire shape, the wait for the stream, the tick subscription's
// lifetime, and the deliberate-abort outcome ('abandoned') that is not a WriteRefused-shaped
// failure.
describe('HttpMEditClient — putLoadOrder', () => {
  const plugins = [
    { name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', slot: 0, enabled: true, winning: true },
  ];
  const appliedBody = { applied: true };

  it('PUTs the ordered plugin list, game directory and instance root', async () => {
    let putBody: unknown;
    const fetch = routedFetch([
      ['/notifications/stream', () => Promise.resolve(openStreamResponse())],
      ['/load-order', async (req) => { putBody = await req.clone().json(); return jsonResponse(200, appliedBody); }],
    ]);
    const client = makeClient(fetch);
    await client.start();

    await client.putLoadOrder(plugins, '/game/Data', '/instance', 'Fallout4');

    expect(putBody).toEqual({ plugins, gameDirectory: '/game/Data', instanceRoot: '/instance', gameRelease: 'Fallout4' });
  });

  // The backend publishes its first tick as the PUT lands, so a PUT that outran the stream
  // would lose every tick published before it connects.
  it('holds the PUT until the notification stream has connected', async () => {
    let resolveStream!: (r: Response) => void;
    const streamPromise = new Promise<Response>((r) => { resolveStream = r; });
    const putFetch = vi.fn(() => Promise.resolve(jsonResponse(200, appliedBody)));
    const fetch = routedFetch([['/notifications/stream', () => streamPromise], ['/load-order', putFetch]]);
    const client = makeClient(fetch);
    await client.start();

    const load = client.putLoadOrder(plugins, '/game/Data', '/instance', 'Fallout4');
    await new Promise((r) => setTimeout(r, 10));
    expect(putFetch).not.toHaveBeenCalled();

    resolveStream(openStreamResponse());
    await vi.waitFor(() => expect(putFetch).toHaveBeenCalledTimes(1));
    await load;
  });

  it('subscribes to load-order-status while the PUT is in flight, and unsubscribes once it settles', async () => {
    let pushFrame!: (chunk: Uint8Array) => void;
    const stream = new ReadableStream<Uint8Array>({ start: (c) => { pushFrame = (chunk) => c.enqueue(chunk); } });
    let resolvePut!: (r: Response) => void;
    const putPromise = new Promise<Response>((r) => { resolvePut = r; });
    const fetch = routedFetch([
      ['/notifications/stream', () => Promise.resolve(new Response(stream, { status: 200 }))],
      ['/load-order', () => putPromise],
    ]);
    const client = makeClient(fetch);
    await client.start();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());

    const onProgress = vi.fn();
    const load = client.putLoadOrder(plugins, '/game/Data', '/instance', 'Fallout4', { onProgress });
    const tick = {
      kind: 'load-order-status', plugin: '', origin: '', keys: [], sequence: 0,
      loadOrderStatus: { totalPlugins: 1, indexedPlugins: [{ name: 'Foo.esp', origin: 'A' }], conflictsComputed: false, failures: [] },
    };
    pushFrame(new TextEncoder().encode(`data: ${JSON.stringify(tick)}\n\n`));
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledTimes(1));

    resolvePut(jsonResponse(200, appliedBody));
    await load;

    pushFrame(new TextEncoder().encode(`data: ${JSON.stringify(tick)}\n\n`));
    await new Promise((r) => setTimeout(r, 10));
    expect(onProgress).toHaveBeenCalledTimes(1); // still 1 — the settled PUT's subscription is gone
  });

  it('reports a deliberately aborted PUT as abandoned, not a failure', async () => {
    const controller = new AbortController();
    const fetch = routedFetch([
      ['/notifications/stream', () => Promise.resolve(openStreamResponse())],
      ['/load-order', () => {
        controller.abort();
        return Promise.reject(new DOMException('This operation was aborted', 'AbortError'));
      }],
    ]);
    const client = makeClient(fetch);
    await client.start();

    const result = await client.putLoadOrder(
      plugins, '/game/Data', '/instance', 'Fallout4', { signal: controller.signal },
    );

    expect(result).toEqual({ outcome: 'abandoned' });
  });
});

describe('HttpMEditClient — implicitMasters', () => {
  it('answers the names the backend reports', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(200, ['Fallout4.esm', 'ccTest.esl'])));
    const client = makeClient(fetch);

    await expect(client.implicitMasters('/game/Data', 'Fallout4')).resolves.toEqual(['Fallout4.esm', 'ccTest.esl']);
  });

  // The rival this guards: degrading to [] on a refusal would read as "no implicit masters" —
  // indistinguishable from a genuine empty answer, and the reconcile writes on the difference.
  it('answers undefined, never an empty list, when the backend refuses', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(400, { detail: 'Game directory not found' })));
    const client = makeClient(fetch);

    await expect(client.implicitMasters('/no/such/Data', 'Fallout4')).resolves.toBeUndefined();
  });

  it('answers undefined, never an empty list, when the backend is unreachable', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('fetch failed')));
    const client = makeClient(fetch);

    await expect(client.implicitMasters('/game/Data', 'Fallout4')).resolves.toBeUndefined();
  });
});

// withTimeout: the race every spatial/record read verb shares. getRecordTypes stands in for all six.
describe('HttpMEditClient — read timeout', () => {
  it('rejects a hung read after the configured timeout, aborting the request', async () => {
    let sawSignal: AbortSignal | undefined;
    const fetch = vi.fn((req: Request) => {
      sawSignal = req.signal;
      return new Promise<Response>(() => {}); // never resolves
    });
    const client = makeClient(fetch, 'up', 20);

    await expect(client.getRecordTypes('MyPatch.esp')).rejects.toThrow(/timed out after 20ms/);
    expect(sawSignal?.aborted).toBe(true);
  });

  it('does not time out a read that answers before the deadline', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(200, [])));
    const client = makeClient(fetch, 'up', 20);

    await expect(client.getRecordTypes('MyPatch.esp')).resolves.toEqual([]);
  });
});
