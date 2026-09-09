import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { EventEmitter } from 'node:events';

vi.mock('node:http');

import { HttpMEditClient } from '../HttpMEditClient';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// A fetch double that never answers — the health check below (mocked `http.get`) is what
// actually drives lifecycle in these tests; nothing here calls the API client.
function neverFetch(): (input: Request) => Promise<Response> {
  return () => new Promise<Response>(() => {});
}

function makeClient(fetch: (input: Request) => Promise<Response>, health: 'up' | 'down' = 'up') {
  vi.mocked(http.get).mockImplementation((_url: any, cb: any) => {
    const req = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    if (health === 'up') cb(Object.assign(new EventEmitter(), { statusCode: 200 }));
    else process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')));
    return req as any;
  });
  return new HttpMEditClient({ backend: { port: 5172, pollIntervalMs: 5, pollTimeoutMs: 20 }, fetch });
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

// ADR-0046 invariant 12: the notification stream follows the status, and only this module drives
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

// ADR-0026: the adapter's own logic — transport, timeouts and error mapping — with the per-verb
// wiring left to the backend's own handler tests. Every case here is named in fix-826's ticket.
describe('HttpMEditClient — write-gate contention', () => {
  it('says the write is retryable, not that the load order went away', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(503, {
      writeGateTimeout: true, detail: 'Another write to the record index is still in progress after 5s.',
    })));
    const client = makeClient(fetch);

    const result = await client.renumberRecord('000800:MyPatch.esp', 'MyPatch.esp', 'ModA');

    expect(result).toEqual({
      refused: true,
      message: 'mEdit: Could not renumber 000800:MyPatch.esp — another change is still being written. Try again in a moment.',
    });
  });

  // The rival this guards against: keying off the 503 status, or off the detail text, rather
  // than off the extension. A load order that genuinely went away is also a 503.
  it('leaves the load-order-absent 503 exactly as it was', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(503, { detail: 'No load order has been received.' })));
    const client = makeClient(fetch);

    const result = await client.renumberRecord('000800:MyPatch.esp', 'MyPatch.esp', 'ModA');

    expect(result).toEqual({ refused: true, message: 'mEdit: Could not renumber 000800:MyPatch.esp — No load order has been received.' });
  });

  it('editRecord reports the same gate timeout, in the same words every other write uses', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(503, {
      writeGateTimeout: true, detail: 'Another write to the record index is still in progress after 5s.',
    })));
    const client = makeClient(fetch);

    const outcome = await client.editRecord(
      '000800:MyPatch.esp', 'MyPatch.esp', 'ModA', { op: 'set', path: [{ kind: 'member', name: 'EditorID' }], value: 'x' },
    );

    expect(outcome).toEqual({
      applied: false, refusal: 'WriteGateBusy',
      message: 'Could not edit this record — another change is still being written. Try again in a moment.',
    });
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

  // A 503 with no extension at all: the load order genuinely went away, not a busy gate.
  it('editRecord leaves the load-order-absent 503 alone', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(503, { detail: 'No load order has been received.' })));
    const client = makeClient(fetch);

    const outcome = await client.editRecord(
      '000800:MyPatch.esp', 'MyPatch.esp', 'ModA', { op: 'set', path: [{ kind: 'member', name: 'EditorID' }], value: 'x' },
    );

    expect(outcome).toEqual({ applied: false, refusal: 'Unknown', message: 'No load order has been received.' });
  });
});
