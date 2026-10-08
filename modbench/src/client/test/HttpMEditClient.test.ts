import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { createMEditClient } from '../HttpMEditClient';
import type { MEditClient, RecordEditEnvelope } from '../MEditClient';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function neverFetch(): (input: Request) => Promise<Response> {
  return () => new Promise<Response>(() => {});
}

const DEBUG_LEVEL = 2;
const fakeLogChannel = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), logLevel: 3 });

function makeClient(
  fetch: (input: Request) => Promise<Response>,
  { health = 'up', ...deps }: { health?: 'up' | 'down' } & Pick<Parameters<typeof createMEditClient>[0], 'timeoutMs' | 'reconnectDelayMs'> = {},
) {
  return createMEditClient({
    backend: {
      attachPort: 5172, pollIntervalMs: 5, pollTimeoutMs: 20,
      checkHealth: () => Promise.resolve(health === 'up'),
    },
    backendLog: fakeLogChannel(), fetch, ...deps,
  });
}

function openStreamResponse(): Response {
  return new Response(new ReadableStream({ start: () => {} }), { status: 200 });
}

function pushableStreamResponse(): { response: Response; push: (chunk: Uint8Array) => void } {
  let push!: (chunk: Uint8Array) => void;
  const stream = new ReadableStream<Uint8Array>({ start: (c) => { push = (chunk) => c.enqueue(chunk); } });
  return { response: new Response(stream, { status: 200 }), push };
}

function loadOrderStatusTick(loadOrderStatus: {
  totalPlugins: number; indexedPlugins: { name: string; origin: string }[]; conflictsComputed: boolean; failures: unknown[]; version: number;
}): Uint8Array {
  const tick = { kind: 'load-order-status', plugin: '', origin: '', keys: [], sequence: 0, loadOrderStatus };
  return new TextEncoder().encode(`data: ${JSON.stringify(tick)}\n\n`);
}

const readyTickThatSettlesPutLoadOrder = () => loadOrderStatusTick({ totalPlugins: 1, indexedPlugins: [{ name: 'Foo.esp', origin: 'A' }], conflictsComputed: true, failures: [], version: 1 });

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

  it('reads the lifecycle\'s own status, not a cached copy of it, as a cached copy of a push-only event can disagree with the process it describes', async () => {
    const client = makeClient(neverFetch());
    expect(client.status).toBe('starting');

    await client.start();

    expect(client.status).toBe('running');
  });

  it('reports every status change to its listeners', async () => {
    const client = makeClient(neverFetch());
    const seen: string[] = [];
    client.onStatusChanged((s) => seen.push(s));

    await client.start();
    await client.stop();

    expect(seen).toEqual(['running', 'stopped']);
  });

  it('an unsubscribed listener hears nothing more', async () => {
    const client = makeClient(neverFetch());
    const seen: string[] = [];
    const off = client.onStatusChanged((s) => seen.push(s));

    await client.start();
    off();
    await client.stop();

    expect(seen).toEqual(['running']);
  });
});

describe('HttpMEditClient — the load-order status', () => {
  it('is the latest tick the stream carried, and is gone once mEdit is stopped', async () => {
    const { response, push } = pushableStreamResponse();
    const client = makeClient(routedFetch([['/notifications/stream', () => Promise.resolve(response)]]));
    const changes: (boolean | undefined)[] = [];
    client.onLoadOrderStatus((status) => changes.push(status?.conflictsComputed));
    await client.start();

    push(readyTickThatSettlesPutLoadOrder());
    await vi.waitFor(() => expect(client.loadOrderStatus?.conflictsComputed).toBe(true));
    await client.stop();

    expect(client.loadOrderStatus).toBeUndefined();
    expect(changes).toEqual([true, undefined]);
  });
});

describe('HttpMEditClient — the notification stream follows the status', () => {
  beforeEach(() => { vi.resetAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('opens the stream when the backend attaches', async () => {
    const fetch = vi.fn((req: Request) => {
      expect(req.url).toContain('/notifications/stream');
      return Promise.resolve(new Response(new ReadableStream({ start: () => {} }), { status: 200 }));
    });
    const client = makeClient(fetch);

    await client.start();

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  });

  it('closes the stream when the backend stops', async () => {
    let sawSignal: AbortSignal | undefined;
    const fetch = vi.fn((req: Request) => {
      sawSignal = req.signal;
      return new Promise<Response>(() => {});
    });
    const client = makeClient(fetch);
    await client.start();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    await client.stop();

    expect(sawSignal?.aborted).toBe(true);
  });

  it('closes the stream when the backend does not come up', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(new ReadableStream({ start: () => {} }), { status: 200 })));
    const client = makeClient(fetch, { health: 'down' });

    await client.start();

    expect(client.status).toBe('stopped');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('HttpMEditClient — a 503 from a write', () => {
  it('relays the load-order-absent 503 as the backend worded it, 503 having one meaning left: the load order went away, so the client reads no more into the status than the detail says', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(503, { detail: 'No load order has been received.' })));
    const client = makeClient(fetch);

    const result = await client.copyRecords(
      [{ formKey: '000800:MyPatch.esp', plugin: 'MyPatch.esp', origin: 'ModA' }], 'Override',
      [{ name: 'Other.esp', origin: 'ModB' }], false);

    expect(result).toEqual({ refused: true, message: 'Could not copy 1 record — No load order has been received.' });
  });
});

describe('HttpMEditClient — creating a record', () => {
  it('sends the plugin and the type, and reads the new record', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, { applied: true, formKey: '000900:MyPatch.esp', recordType: 'npc_' })));
    const client = makeClient(fetch);

    const result = await client.createRecord({ name: 'MyPatch.esp', origin: 'ModA' }, 'npc_');

    expect(result).toEqual({ applied: true, formKey: '000900:MyPatch.esp', recordType: 'npc_' });
    const request = fetch.mock.calls[0]?.[0];
    expect(request?.url).toMatch(/\/plugins\/MyPatch\.esp\/records$/);
    expect(await request?.json()).toEqual({ origin: 'ModA', recordType: 'npc_' });
  });

  it('sends the container and the grid position it is given', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, { applied: true, formKey: '000900:MyPatch.esp', recordType: 'cell' })));
    const client = makeClient(fetch);

    await client.createRecord({ name: 'MyPatch.esp', origin: 'ModA' }, 'cell', { container: '000800:MyPatch.esp', position: { x: 1, y: -2 } });

    expect(await fetch.mock.calls[0]?.[0].json()).toEqual({
      origin: 'ModA', recordType: 'cell', container: '000800:MyPatch.esp', position: { x: 1, y: -2 },
    });
  });

  it('answers a full FormID space as a refusal carrying mEdit\'s remedies, asking once, nothing offering to remove the flag and try again', async () => {
    const detail = 'MyPatch.esp has exhausted its ESL FormKey space. Clear the light flag in the header, or change a record\'s FormID.';
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(422, { detail })));
    const client = makeClient(fetch);

    const result = await client.createRecord({ name: 'MyPatch.esp', origin: 'ModA' }, 'npc_');

    expect(result).toEqual({ refused: true, message: `Could not create a new npc_ record in "MyPatch.esp" — ${detail}` });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('HttpMEditClient — deleting records answers per record', () => {
  const kept = { formKey: '000801:MyPatch.esp', plugin: 'MyPatch.esp', origin: 'ModA' };
  const gone = { formKey: '000802:MyPatch.esp', plugin: 'MyPatch.esp', origin: 'ModA' };
  const untracked = { formKey: '000900:Other.esp', plugin: 'Other.esp', origin: 'ModB' };

  it('sends the whole selection as one call and reads what was applied as landed, each refusal with its message', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, {
      applied: [kept, gone],
      refused: [{ item: untracked, refusal: 'PluginNotTracked', message: 'Other.esp is not tracked.' }],
    })));
    const client = makeClient(fetch);

    const outcome = await client.deleteRecords([kept, untracked, gone]);

    expect(outcome).toEqual({
      landed: [kept, gone],
      refused: [{ item: untracked, reason: 'Other.esp is not tracked.' }],
    });
    expect(fetch).toHaveBeenCalledOnce();
    const request = fetch.mock.calls[0]?.[0];
    expect(request?.url).toMatch(/\/records\/delete$/);
    expect(await request?.json()).toEqual({ records: [kept, untracked, gone] });
  });

  it('resolves a WriteRefused carrying the count and the server text on a non-ok response', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(400, 'Bad Request')));
    const client = makeClient(fetch);

    const result = await client.deleteRecords([kept, gone]);

    expect(result).toEqual({ refused: true, message: 'Could not delete 2 records — Bad Request' });
  });

  it('resolves a thrown request the same way', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('socket hang up')));
    const client = makeClient(fetch);

    const result = await client.deleteRecords([kept]);

    expect(result).toEqual({ refused: true, message: 'Could not delete 1 record — socket hang up' });
  });

  it('refuses a success with no body, and a thrown create or copy', async () => {
    const client = makeClient(vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))));
    const thrown = makeClient(vi.fn(() => Promise.reject(new Error('socket hang up'))));

    const answers = [
      await client.deleteRecords([kept]),
      await thrown.createRecord({ name: 'MyPatch.esp', origin: 'ModA' }, 'npc_'),
      await thrown.copyRecords([kept], 'New', [{ name: 'Patch.esp', origin: 'PatchMod' }], false),
    ];

    for (const answer of answers) expect(answer).toMatchObject({ refused: true });
    expect(answers[0]).toEqual({ refused: true, message: 'Could not delete 1 record — no answer' });
  });
});

describe('HttpMEditClient — creating a plugin', () => {
  const plugin = { name: 'New.esp', origin: 'ModA' };

  it('sends the origin, the file name and the folder, and reads back the plugin it wrote', async () => {
    const wrote = { name: 'New.esp', origin: 'ModA', path: '/mods/ModA/New.esp' };
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, wrote)));
    const client = makeClient(fetch);

    const result = await client.createPlugin(plugin, '/mods/ModA');

    expect(result).toEqual(wrote);
    const request = fetch.mock.calls[0]?.[0];
    expect(request?.url).toMatch(/\/plugins\/create$/);
    expect(await request?.json()).toEqual({ origin: 'ModA', name: 'New.esp', folder: '/mods/ModA' });
  });

  it('resolves a WriteRefused carrying the name and the server text on a refusal', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(409, {
      detail: 'A file is already at /mods/ModA/New.esp, so New.esp was not created.', refusal: 'FileExists',
    })));
    const client = makeClient(fetch);

    const result = await client.createPlugin(plugin, '/mods/ModA');

    expect(result).toEqual({
      refused: true,
      message: 'Could not create "New.esp" — A file is already at /mods/ModA/New.esp, so New.esp was not created.',
    });
  });
});

describe('HttpMEditClient — renaming a plugin source', () => {
  const plugin = { name: 'Old.esp', origin: 'ModA' };

  it('sends the plugin and the new name, and answers renamed on a 204', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(new Response(null, { status: 204 })));
    const client = makeClient(fetch);

    const result = await client.renameSource(plugin, 'New.esp');

    expect(result).toEqual({ renamed: true });
    const request = fetch.mock.calls[0]?.[0];
    expect(request?.url).toMatch(/\/plugins\/rename-source$/);
    expect(await request?.json()).toEqual({ origin: 'ModA', name: 'Old.esp', newName: 'New.esp' });
  });

  it('resolves a WriteRefused carrying the name and the server text on a refusal', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(409, { detail: 'ModA already holds New.esp.', refusal: 'NameTaken' })));
    const client = makeClient(fetch);

    const result = await client.renameSource(plugin, 'New.esp');

    expect(result).toEqual({ refused: true, message: 'Could not rename the source of "Old.esp" — ModA already holds New.esp.' });
  });
});

describe('HttpMEditClient — copying records answers per record and destination', () => {
  const npc = { formKey: '000801:MyPatch.esp', plugin: 'MyPatch.esp', origin: 'ModA' };
  const patch = { name: 'Patch.esp', origin: 'PatchMod' };
  const other = { name: 'Other.esp', origin: 'OtherMod' };

  it('sends the records, the mode, the destinations and the replace Option as one call, and reads each item', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, {
      applied: [{ record: npc, destination: patch, newFormKey: null }],
      refused: [{ item: { record: npc, destination: other }, refusal: 'DestinationHoldsRecord', message: 'Other.esp already holds it.' }],
    })));
    const client = makeClient(fetch);

    const outcome = await client.copyRecords([npc], 'Override', [patch, other], true);

    expect(outcome).toEqual({
      landed: [{ record: npc, destination: patch, newFormKey: null }],
      refused: [{ item: { record: npc, destination: other }, reason: 'Other.esp already holds it.' }],
    });
    const request = fetch.mock.calls[0]?.[0];
    expect(request?.url).toMatch(/\/records\/copy$/);
    expect(await request?.json()).toEqual({ records: [npc], mode: 'Override', destinations: [patch, other], replace: true });
  });

  it('names the FormKey mEdit minted for a new record\'s copy', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, {
      applied: [{ record: npc, destination: patch, newFormKey: '000900:Patch.esp' }], refused: [],
    })));

    const outcome = await makeClient(fetch).copyRecords([npc], 'New', [patch], false);

    expect(outcome).toEqual({ landed: [{ record: npc, destination: patch, newFormKey: '000900:Patch.esp' }], refused: [] });
  });

  it('asks the record\'s holders by plugin and origin', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, {
      overrides: [{ plugin: 'Patch.esp', origin: 'PatchMod' }, { plugin: 'Patch.esp', origin: 'OtherMod' }],
      diffs: [], conflictAll: 'NoConflict',
    })));
    const client = makeClient(fetch);

    expect(await client.getRecordHolders(npc.formKey)).toEqual([
      { name: 'Patch.esp', origin: 'PatchMod' }, { name: 'Patch.esp', origin: 'OtherMod' },
    ]);
  });
});

describe('HttpMEditClient — child records', () => {
  const quest = { formKey: '000801:Source.esp', plugin: 'Source.esp', origin: 'SourceMod' };
  const patch = { name: 'Patch.esp', origin: 'PatchMod' };

  it('asks which records have child records, sending each record as (formKey, plugin, origin)', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, [quest])));

    expect(await makeClient(fetch).getRecordsWithChildren([quest])).toEqual([quest]);

    const request = fetch.mock.calls[0]?.[0];
    expect(request?.url).toMatch(/\/records\/with-children$/);
    expect(await request?.json()).toEqual({ records: [quest] });
  });

  it('asks which destinations hold a record\'s child records, and reads each record with its holders', async () => {
    const holders = [{ record: quest, destinations: [patch] }];
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, holders)));

    expect(await makeClient(fetch).getChildrenInDestinations([quest], [patch])).toEqual(holders);

    const request = fetch.mock.calls[0]?.[0];
    expect(request?.url).toMatch(/\/records\/children-in-destinations$/);
    expect(await request?.json()).toEqual({ records: [quest], destinations: [patch] });
  });

  it.each([
    ['getRecordsWithChildren', (c: MEditClient) => c.getRecordsWithChildren([quest])],
    ['getChildrenInDestinations', (c: MEditClient) => c.getChildrenInDestinations([quest], [patch])],
  ])('fails %s when the service refuses, naming the call', async (name, call) => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(503, { detail: 'The index is not ready.' })));

    await expect(call(makeClient(fetch))).rejects.toThrow(new RegExp(name));
  });
});

describe('HttpMEditClient — getRecordOwner', () => {
  it('answers the plugin holding the record as a plugin address', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, { plugin: 'Patch.esp', origin: 'PatchMod' })));

    expect(await makeClient(fetch).getRecordOwner('000800:Patch.esp')).toEqual({ name: 'Patch.esp', origin: 'PatchMod' });
  });
});

describe('HttpMEditClient — getComparison', () => {
  it('asks the record\'s comparison by FormKey and returns it untransformed', async () => {
    const comparison = {
      overrides: [{ plugin: 'Patch.esp', origin: 'PatchMod', formKey: '000801:MyPatch.esp', editorId: 'MyRecord', fields: [] }],
      diffs: [], conflictAll: 'NoConflict',
    };
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, comparison)));
    const client = makeClient(fetch);

    expect(await client.getComparison('000801:MyPatch.esp')).toEqual(comparison);
    const request = fetch.mock.calls[0]?.[0];
    expect(request?.url).toMatch(/\/records\/000801%3AMyPatch\.esp\/compare$/);
  });

  it('posts the plugin\'s document text and returns the comparison untransformed', async () => {
    const comparison = { overrides: [], diffs: [], conflictAll: 'NoConflict', recordTypeName: 'Weapon' };
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, comparison)));
    const text = { plugin: { name: 'Patch.esp', origin: 'PatchMod' }, documentText: '{}' };

    expect(await makeClient(fetch).getComparison('000801:MyPatch.esp', text)).toEqual(comparison);
    const request = fetch.mock.calls[0]?.[0];
    expect(request?.method).toBe('POST');
    expect(request?.url).toMatch(/\/records\/000801%3AMyPatch\.esp\/compare$/);
    expect(await request?.json()).toEqual(text);
  });

  it('answers null on a 404, a record gone from every active plugin', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(404, { detail: 'No such record.' })));
    const client = makeClient(fetch);

    expect(await client.getComparison('000801:Gone.esp')).toBeNull();
  });

  it('rejects on any other non-OK answer', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(500, { detail: 'boom' })));
    const client = makeClient(fetch);

    await expect(client.getComparison('000801:Broken.esp')).rejects.toThrow(/getComparison.*failed \(500\)/);
  });
});

describe('HttpMEditClient — getRecordsComparison', () => {
  const copies = [
    { formKey: '000801:A.esp', plugin: { name: 'A.esp', origin: 'AMod' }, documentText: '{}' },
    { formKey: '000802:B.esp', plugin: { name: 'B.esp', origin: 'BMod' } },
  ];

  it('posts the copies in order and returns the comparison untransformed', async () => {
    const comparison = { overrides: [], diffs: [], conflictAll: 'NoConflict', recordTypeName: 'Weapon' };
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, comparison)));
    const client = makeClient(fetch);

    expect(await client.getRecordsComparison(copies)).toEqual(comparison);
    const request = fetch.mock.calls[0]?.[0];
    expect(request?.method).toBe('POST');
    expect(request?.url).toMatch(/\/records\/compare$/);
    expect(await request?.json()).toEqual({ copies });
  });

  it('answers null on a 404, a copy no plugin holds', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(404, { detail: 'No such copy.' })));

    expect(await makeClient(fetch).getRecordsComparison(copies)).toBeNull();
  });

  it('rejects on any other non-OK answer', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(400, { detail: 'No records.' })));

    await expect(makeClient(fetch).getRecordsComparison([])).rejects.toThrow(/getRecordsComparison.*failed \(400\)/);
  });
});

describe('HttpMEditClient — tracking mods answers per mod', () => {
  const first = { name: 'First.esp', origin: 'ModA' };

  it('sends the mods as one call and reads each applied mod with the plugins that tracked, and each refused mod, with its message', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, {
      applied: [{ mod: 'ModA', tracked: [first] }],
      refused: [{ item: 'ModC', refusal: 'ModProvidesNoPlugin', message: 'ModC provides no plugin.' }],
    })));
    const client = makeClient(fetch);

    const outcome = await client.track(['ModA', 'ModC']);

    expect(outcome).toEqual({
      landed: [{ mod: 'ModA', tracked: [first] }],
      refused: [{ item: 'ModC', reason: 'ModC provides no plugin.' }],
    });
    const request = fetch.mock.calls.map((call) => call[0]).find((req) => /\/plugins\/track$/.test(req.url));
    expect(await request?.json()).toEqual({ mods: ['ModA', 'ModC'] });
  });

  it('resolves a WriteRefused carrying the count and the server text when the whole selection is refused', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(500, 'git was not found on PATH.')));
    const client = makeClient(fetch);

    const result = await client.track(['ModA', 'ModB']);

    expect(result).toEqual({ refused: true, message: 'Could not track 2 mods — git was not found on PATH.' });
  });
});

describe('HttpMEditClient — compiling plugins answers per plugin', () => {
  const first = { name: 'First.esp', origin: 'ModA' };
  const second = { name: 'Second.esp', origin: 'ModB' };
  const diagnostic = { formKey: '000800:First.esp', sourceRelativePath: 'First.esp/Npc/A.json', message: 'Race: points at nothing' };

  it('sends the whole selection as one call, and reads each compiled plugin and each refusal with its message', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, {
      applied: [{ ...first, diagnostics: [diagnostic] }],
      refused: [{ item: second, refusal: 'PluginNotTracked', message: 'Second.esp is not tracked, so there is no source to compile.' }],
    })));
    const client = makeClient(fetch);

    const outcome = await client.compile([first, second]);

    expect(outcome).toEqual({
      landed: [{ ...first, diagnostics: [diagnostic] }],
      refused: [{ item: second, reason: 'Second.esp is not tracked, so there is no source to compile.' }],
    });
    const request = fetch.mock.calls.map((call) => call[0]).find((req) => /\/plugins\/compile$/.test(req.url));
    expect(await request?.json()).toEqual({ plugins: [first, second] });
  });

  it('resolves a WriteRefused carrying the count and the server text when the whole selection is refused', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(503, 'No load order has been received.')));
    const client = makeClient(fetch);

    const result = await client.compile([first, second]);

    expect(result).toEqual({ refused: true, message: 'Could not compile 2 plugins — No load order has been received.' });
  });
});

describe('HttpMEditClient — decompiling plugins answers per plugin', () => {
  const first = { name: 'First.esp', origin: 'ModA' };
  const second = { name: 'Second.esp', origin: 'ModB' };

  it('sends the whole selection as one call, and reads each decompiled plugin and each refusal with its message', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, {
      applied: [first],
      refused: [{ item: second, refusal: 'NotInTrackedMod', message: 'Second.esp is not in a tracked mod.' }],
    })));
    const client = makeClient(fetch);

    const outcome = await client.decompile([first, second]);

    expect(outcome).toEqual({ landed: [first], refused: [{ item: second, reason: 'Second.esp is not in a tracked mod.' }] });
    const request = fetch.mock.calls.map((call) => call[0]).find((req) => /\/plugins\/decompile$/.test(req.url));
    expect(await request?.json()).toEqual({ plugins: [first, second] });
  });

  it('resolves a WriteRefused carrying the count and the server text when the whole selection is refused', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(500, 'git was not found on PATH.')));
    const client = makeClient(fetch);

    const result = await client.decompile([first, second]);

    expect(result).toEqual({ refused: true, message: 'Could not decompile 2 plugins — git was not found on PATH.' });
  });
});

describe('HttpMEditClient — an edit answered as its source changes', () => {
  const plugin = { name: 'MyPatch.esp', origin: 'ModA' };
  const renamed: RecordEditEnvelope = { op: 'set', path: [{ kind: 'member', name: 'EditorID' }], value: 'Renamed' };

  it('getEditChanges posts the envelope and the document\'s text, and reads each move and document', async () => {
    const to = 'plugin-source/MyPatch.esp/Npcs/Renamed - 000800_MyPatch.esp.json';
    const moves = [{ from: 'plugin-source/MyPatch.esp/Npcs/Old - 000800_MyPatch.esp.json', to }];
    const documents = [{ path: to, text: '{"EditorID": "Renamed"}' }];
    let seen: Request | undefined;
    const fetch = vi.fn((req: Request) => {
      seen = req;
      return Promise.resolve(jsonResponse(200, { formKey: '000800:MyPatch.esp', path: 'EditorID', moves, documents, newFormKey: null }));
    });

    const outcome = await makeClient(fetch).getEditChanges('000800:MyPatch.esp', plugin, renamed, '{"EditorID": "Old"}');

    expect(outcome).toEqual({ applied: true, moves, documents });
    expect(new URL(seen?.url ?? '').pathname).toBe('/records/000800%3AMyPatch.esp/edit-changes');
    expect(await seen?.json()).toEqual({ edit: { plugin: 'MyPatch.esp', origin: 'ModA', ...renamed }, text: '{"EditorID": "Old"}' });
  });

  it('getEditChanges carries the new FormKey an edit of the FormID answers with', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(200, {
      formKey: '000800:MyPatch.esp', path: 'FormKey', moves: [], documents: [], newFormKey: '000900:MyPatch.esp',
    })));

    const outcome = await makeClient(fetch).getEditChanges(
      '000800:MyPatch.esp', plugin, { op: 'set', path: [{ kind: 'member', name: 'FormKey' }], value: '000900:MyPatch.esp' }, '{}');

    expect(outcome).toEqual({ applied: true, moves: [], documents: [], newFormKey: '000900:MyPatch.esp' });
  });

  it('getEditChanges answers the edit\'s typed refusal as the backend worded it', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(409, {
      refusal: 'PluginNotTracked', detail: 'MyPatch.esp is not tracked, so it is read-only.',
    })));

    const outcome = await makeClient(fetch).getEditChanges('000800:MyPatch.esp', plugin, renamed, '{}');

    expect(outcome).toEqual({ applied: false, refusal: 'PluginNotTracked', message: 'MyPatch.esp is not tracked, so it is read-only.' });
  });
});

describe('HttpMEditClient — the not-OK response text', () => {

  it('getEditChanges answers a 422 refusal with its cause, in the backend\'s words', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(422, {
      refusal: 'PluginNotTracked', detail: 'MyPatch.esp is not tracked, so it is read-only.',
    })));
    const client = makeClient(fetch);

    const outcome = await client.getEditChanges(
      '000800:MyPatch.esp', { name: 'MyPatch.esp', origin: 'ModA' }, { op: 'set', path: [{ kind: 'member', name: 'EditorID' }], value: 'x' }, '{}',
    );

    expect(outcome).toEqual({
      applied: false, refusal: 'PluginNotTracked', message: 'MyPatch.esp is not tracked, so it is read-only.',
    });
  });

  it('getEditChanges answers a refused disk read with its cause, SourceAccessFailed', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(422, {
      refusal: 'SourceAccessFailed', detail: 'Could not write the source file for 000800:MyPatch.esp: Access denied.',
    })));
    const client = makeClient(fetch);

    const outcome = await client.getEditChanges(
      '000800:MyPatch.esp', { name: 'MyPatch.esp', origin: 'ModA' }, { op: 'set', path: [{ kind: 'member', name: 'EditorID' }], value: 'x' }, '{}',
    );

    expect(outcome).toEqual({
      applied: false, refusal: 'SourceAccessFailed', message: 'Could not write the source file for 000800:MyPatch.esp: Access denied.',
    });
  });

  it('getEditChanges answers a 503 that names no cause as Unknown, in the backend\'s words', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(503, { detail: 'No load order has been received.' })));
    const client = makeClient(fetch);

    const outcome = await client.getEditChanges(
      '000800:MyPatch.esp', { name: 'MyPatch.esp', origin: 'ModA' }, { op: 'set', path: [{ kind: 'member', name: 'EditorID' }], value: 'x' }, '{}',
    );

    expect(outcome).toEqual({ applied: false, refusal: 'Unknown', message: 'No load order has been received.' });
  });
});

describe('HttpMEditClient — rebuildIndex', () => {
  it('POSTs the instance root and game release, and resolves rebuilt on success', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(new Response(null, { status: 204 })));
    const client = makeClient(fetch);

    const outcome = await client.rebuildIndex('/instance', 'Fallout4');

    expect(outcome).toEqual({ rebuilt: true });
    const request = fetch.mock.calls[0]?.[0];
    expect(request?.url).toMatch(/\/index\/rebuild$/);
    expect(await request?.json()).toEqual({ instanceRoot: '/instance', gameRelease: 'Fallout4' });
  });

  it('answers a 423 as heldElsewhere, not in the generic-failure shape a non-ok response otherwise gets', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(423, {
      detail: 'This instance\'s index is open in another Modbench window (/instance/modbench/index.duckdb). '
        + 'Close mEdit there first, or open a different instance here.',
    })));
    const client = makeClient(fetch);

    const outcome = await client.rebuildIndex('/instance', 'Fallout4');

    expect(outcome).toEqual({ rebuilt: false, heldElsewhere: true });
  });

  it('answers any other non-ok response as a plain failure, carrying the backend detail', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(500, { detail: 'Failed to rebuild the store.' })));
    const client = makeClient(fetch);

    const outcome = await client.rebuildIndex('/instance', 'Fallout4');

    expect(outcome).toEqual({ rebuilt: false, heldElsewhere: false, detail: 'Failed to rebuild the store.' });
  });

  it('answers a thrown request as a plain failure, never a rejection', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('fetch failed')));
    const client = makeClient(fetch);

    const outcome = await client.rebuildIndex('/instance', 'Fallout4');

    expect(outcome).toEqual({ rebuilt: false, heldElsewhere: false, detail: 'fetch failed' });
  });
});

describe('HttpMEditClient — the record filter', () => {
  it('POSTs the SQL with its source', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, { sql: 'SELECT 1', source: 'armor.sql' })));
    const client = makeClient(fetch);

    const error = await client.setFilter({ sql: 'SELECT 1', source: 'armor.sql' });

    expect(error).toBeNull();
    expect(await fetch.mock.calls[0]?.[0].json()).toEqual({ sql: 'SELECT 1', source: 'armor.sql' });
  });

  it('reads the filter in force with its source', async () => {
    const client = makeClient(vi.fn(() => Promise.resolve(jsonResponse(200, { sql: 'SELECT 1', source: 'armor.sql' }))));

    expect(await client.getActiveFilter()).toEqual({ sql: 'SELECT 1', source: 'armor.sql' });
  });

  it('reads no filter when mEdit holds none', async () => {
    const client = makeClient(vi.fn(() => Promise.resolve(jsonResponse(200, { sql: null, source: null }))));

    expect(await client.getActiveFilter()).toBeNull();
  });

  it('answers a refused clear with the backend detail', async () => {
    const client = makeClient(vi.fn(() => Promise.resolve(jsonResponse(503, { detail: 'No load order has been received yet.' }))));

    expect(await client.clearFilter()).toBe('No load order has been received yet.');
  });

  it('answers a thrown clear with its reason, never a rejection', async () => {
    const client = makeClient(vi.fn(() => Promise.reject(new Error('fetch failed'))));

    expect(await client.clearFilter()).toBe('fetch failed');
  });

  it('answers a clear mEdit took with null', async () => {
    const client = makeClient(vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))));

    expect(await client.clearFilter()).toBeNull();
  });
});

describe('HttpMEditClient — searchRecords', () => {
  it('searches among every record type the field allows', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, { items: [], total: 0 })));
    const client = makeClient(fetch);

    await client.searchRecords('Lever', ['acti', 'furn']);

    const [request] = fetch.mock.calls.map((call) => call[0]);
    expect(new URL(request?.url ?? '').searchParams.getAll('type')).toEqual(['acti', 'furn']);
  });

  it('searches one plugin, named whole', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, { items: [], total: 0 })));
    const client = makeClient(fetch);

    await client.searchRecords('Lever', [], { name: 'A.esp', origin: 'ModA' });

    const [request] = fetch.mock.calls.map((call) => call[0]);
    const params = new URL(request?.url ?? '').searchParams;
    expect([params.get('search'), params.get('plugin'), params.get('origin')]).toEqual(['Lever', 'A.esp', 'ModA']);
  });
});

describe('HttpMEditClient — sendLoadOrder', () => {
  const plugins = [{ name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', provider: { kind: 'Mod' as const, mod: 'A', folder: '/mods/A' } }];
  const active = [{ name: 'Foo.esp', origin: 'A' }];
  const loadedWithNoLine = [{ name: 'Foo.esp', origin: 'A' }];
  const appliedBody = { applied: true, version: 1 };
  const snapshot = { plugins, active, loadedWithNoLine, gameDirectory: '/game/Data', instanceRoot: '/instance', gameRelease: 'Fallout4' };

  it('PUTs every plugin, the active plugins, the game directory and the instance root', async () => {
    let putBody: unknown;
    const { response, push } = pushableStreamResponse();
    const fetch = routedFetch([
      ['/notifications/stream', () => Promise.resolve(response)],
      ['/load-order', async (req) => { putBody = await req.clone().json(); return jsonResponse(200, appliedBody); }],
    ]);
    const client = makeClient(fetch);
    await client.start();

    const load = client.sendLoadOrder(snapshot);
    await vi.waitFor(() => expect(putBody).toBeDefined());
    push(readyTickThatSettlesPutLoadOrder());
    await load;

    expect(putBody).toEqual({ plugins, active, loadedWithNoLine, gameDirectory: '/game/Data', instanceRoot: '/instance', gameRelease: 'Fallout4' });
  });

  it('holds the PUT until the notification stream has connected, as the backend publishes its first tick as the PUT lands and a PUT that outran the stream would lose every tick published before it connects', async () => {
    let resolveStream!: (r: Response) => void;
    const streamPromise = new Promise<Response>((r) => { resolveStream = r; });
    const putFetch = vi.fn(() => Promise.resolve(jsonResponse(200, appliedBody)));
    const fetch = routedFetch([
      ['/notifications/stream', () => streamPromise],
      ['/load-order/status', () => Promise.reject(new Error('no status read in this test'))],
      ['/load-order', putFetch],
    ]);
    const client = makeClient(fetch);
    await client.start();

    const load = client.sendLoadOrder(snapshot);
    expect(putFetch).not.toHaveBeenCalled();

    const { response, push } = pushableStreamResponse();
    resolveStream(response);
    await vi.waitFor(() => expect(putFetch).toHaveBeenCalledTimes(1));
    push(readyTickThatSettlesPutLoadOrder());
    await load;
  });

  it('answers a PUT whose version is already Ready from the process\'s own status, with no tick, a snapshot identical to the one held reconciling nothing and publishing no tick', async () => {
    const fetch = routedFetch([
      ['/notifications/stream', () => Promise.resolve(openStreamResponse())],
      ['/load-order/status', () => Promise.resolve(jsonResponse(200, {
        state: 'Ready', totalPlugins: 1, indexedPlugins: [], conflictsComputed: true, failures: [], version: 1,
      }))],
      ['/load-order', () => Promise.resolve(jsonResponse(200, appliedBody))],
    ]);
    const client = makeClient(fetch);
    await client.start();

    await expect(client.sendLoadOrder(snapshot))
      .resolves.toMatchObject({ outcome: 'applied', status: { version: 1, conflictsComputed: true } });
  });

  it('settles a PUT whose terminal tick was lost to a stream reopening, from the status read then, a reopened stream carrying none of the ticks published while it was down', async () => {
    const streams: { push: (chunk: Uint8Array) => void; end: () => void }[] = [];
    let status = { state: 'Reconciling', totalPlugins: 1, indexedPlugins: [], conflictsComputed: false, failures: [], version: 0 };
    const fetch = routedFetch([
      ['/notifications/stream', () => {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
        streams.push({ push: (chunk) => controller.enqueue(chunk), end: () => controller.close() });
        return Promise.resolve(new Response(body, { status: 200 }));
      }],
      ['/load-order/status', () => Promise.resolve(jsonResponse(200, status))],
      ['/load-order', () => Promise.resolve(jsonResponse(200, appliedBody))],
    ]);
    const client = makeClient(fetch, { reconnectDelayMs: 0 });
    await client.start();
    await vi.waitFor(() => expect(streams).toHaveLength(1));

    const load = client.sendLoadOrder(snapshot);
    await new Promise((resolve) => setTimeout(resolve, 20));
    status = { ...status, state: 'Ready', conflictsComputed: true, version: 1 };
    streams[0]?.end();

    await expect(load).resolves.toMatchObject({ outcome: 'applied', status: { version: 1 } });
  });

  it('answers a PUT that heard only an older version\'s tick from the process\'s own status', async () => {
    const { response: stream, push } = pushableStreamResponse();
    let answerPut!: (r: Response) => void;
    const fetch = routedFetch([
      ['/notifications/stream', () => Promise.resolve(stream)],
      ['/load-order/status', () => Promise.resolve(jsonResponse(200, {
        state: 'Ready', totalPlugins: 1, indexedPlugins: [], conflictsComputed: true, failures: [], version: 1,
      }))],
      ['/load-order', () => new Promise<Response>((resolve) => { answerPut = resolve; })],
    ]);
    const client = makeClient(fetch);
    await client.start();

    const load = client.sendLoadOrder(snapshot);
    await vi.waitFor(() => expect(answerPut).toBeDefined());
    push(loadOrderStatusTick({ totalPlugins: 1, indexedPlugins: [], conflictsComputed: true, failures: [], version: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    answerPut(jsonResponse(200, appliedBody));

    await expect(load).resolves.toMatchObject({ outcome: 'applied', status: { version: 1 } });
  });

  it('stays stopped after a crash: a snapshot answers backendFailed, with no second child spawned and nothing launched or killed', async () => {
    const kills: number[] = [];
    const children: EventEmitter[] = [];
    const client = createMEditClient({
      backend: {
        freePort: () => Promise.resolve(5172), executablePath: '/x/backend',
        spawn: () => {
          const child = Object.assign(new EventEmitter(), { kill: () => { kills.push(children.length); } });
          children.push(child);
          return child;
        },
        pollIntervalMs: 3, pollTimeoutMs: 20, checkHealth: () => Promise.resolve(true),
      },
      backendLog: fakeLogChannel(), fetch: routedFetch([['/notifications/stream', () => Promise.resolve(openStreamResponse())]]),
    });
    await client.start();
    const launches: unknown[] = [];
    const exits: unknown[] = [];
    client.onLaunch((launched) => launches.push(launched));
    client.onExit(() => exits.push('exit'));

    children[0]?.emit('exit', 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(client.status).toBe('stopped');
    expect(exits).toHaveLength(1);
    await expect(client.sendLoadOrder(snapshot)).resolves.toEqual({ outcome: 'backendFailed' });
    expect(launches).toEqual([]);
    expect(kills).toEqual([]);
    expect(children).toHaveLength(1);
  });

  it.each([
    ['claiming a port throws', { freePort: () => Promise.reject(new Error('no port')) }],
    ['the spawn throws', { freePort: () => Promise.resolve(5172), spawn: () => { throw new Error('no spawn'); } }],
  ])('is stopped when the launch fails because %s', async (_name, backend) => {
    const client = createMEditClient({
      backend: { executablePath: '/x/backend', pollIntervalMs: 3, checkHealth: () => Promise.resolve(true), ...backend },
      backendLog: fakeLogChannel(), fetch: routedFetch([]),
    });

    await client.start();

    expect(client.status).toBe('stopped');
  });

  it('answers a snapshot backendFailed after a launch whose child exited before it answered, and launches nothing again', async () => {
    const children: EventEmitter[] = [];
    const client = createMEditClient({
      backend: {
        freePort: () => Promise.resolve(5172), executablePath: '/x/backend',
        spawn: () => {
          const child: EventEmitter & { kill: () => void } = Object.assign(new EventEmitter(), {
            kill: () => { child.emit('exit', 0); },
          });
          children.push(child);
          process.nextTick(() => child.emit('exit', 1));
          return child;
        },
        pollIntervalMs: 3, pollTimeoutMs: 300, checkHealth: () => Promise.resolve(false),
      },
      backendLog: fakeLogChannel(), fetch: routedFetch([['/notifications/stream', () => Promise.resolve(openStreamResponse())]]),
    });
    await client.start();

    await expect(client.sendLoadOrder(snapshot)).resolves.toEqual({ outcome: 'backendFailed' });
    expect(children).toHaveLength(1);
  });

  it('aborts the PUT in flight before it kills the mEdit it spawned, and answers it abandoned, not a failure', async () => {
    let putSignal: AbortSignal | undefined;
    let abortedAtKill: boolean | undefined;
    const fetch = routedFetch([
      ['/notifications/stream', () => Promise.resolve(openStreamResponse())],
      ['/load-order', (req) => new Promise<Response>((_resolve, reject) => {
        putSignal = req.signal;
        req.signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
      })],
    ]);
    const child = Object.assign(new EventEmitter(), {
      kill: () => { abortedAtKill = putSignal?.aborted; child.emit('exit', 0); },
    });
    const client = createMEditClient({
      backend: {
        freePort: () => Promise.resolve(5172), spawn: () => child, executablePath: '/x/backend',
        pollIntervalMs: 5, pollTimeoutMs: 20, checkHealth: () => Promise.resolve(true),
      },
      backendLog: fakeLogChannel(), fetch,
    });
    await client.start();
    const sent = client.sendLoadOrder(snapshot);
    await vi.waitFor(() => expect(putSignal).toBeDefined());

    await client.stop();

    expect(abortedAtKill).toBe(true);
    await expect(sent).resolves.toEqual({ outcome: 'abandoned' });
  });
});

describe('HttpMEditClient — the record types the game can create', () => {
  it('asks mEdit for them and reads each type with its name', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, [
      { type: 'acti', displayName: 'Activator' }, { type: 'npc_', displayName: 'Non-Player Character' },
    ])));
    const client = makeClient(fetch);

    const types = await client.getCreatableRecordTypes();

    expect(types).toEqual([{ type: 'acti', displayName: 'Activator' }, { type: 'npc_', displayName: 'Non-Player Character' }]);
    expect(fetch.mock.calls[0]?.[0].url).toMatch(/\/record-types\/creatable$/);
  });

  it('rejects, naming the reason, when mEdit cannot answer', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(503, { detail: 'No load order has been loaded.' })));
    const client = makeClient(fetch);

    await expect(client.getCreatableRecordTypes()).rejects.toThrow(/No load order has been loaded/);
  });
});

describe('HttpMEditClient — the record types a container record can hold', () => {
  it('asks mEdit for the plugin\'s copy of the record and reads each type with its name', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, [{ type: 'dial', displayName: 'Dialog Topic' }])));
    const client = makeClient(fetch);

    const types = await client.getChildRecordTypes({ name: 'Shared.esp', origin: 'ModA' }, '000800:Shared.esp');

    expect(types).toEqual([{ type: 'dial', displayName: 'Dialog Topic' }]);
    const url = new URL(fetch.mock.calls[0]?.[0].url ?? '');
    expect(url.pathname).toBe('/plugins/Shared.esp/records/000800%3AShared.esp/child-record-types');
    expect(url.searchParams.get('origin')).toBe('ModA');
  });

  it('rejects, naming the reason, when mEdit cannot answer', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(503, { detail: 'No load order has been loaded.' })));
    const client = makeClient(fetch);

    await expect(client.getChildRecordTypes({ name: 'Shared.esp', origin: 'ModA' }, '000800:Shared.esp'))
      .rejects.toThrow(/No load order has been loaded/);
  });
});

describe('HttpMEditClient — a copy rendered as its document', () => {
  it('asks mEdit for the plugin\'s copy of the record and reads its name and text', async () => {
    const rendered = { fileName: 'SharedNpc - 000800_Shared.esp.json', text: '{ "FormKey": "000800:Shared.esp" }' };
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, rendered)));
    const client = makeClient(fetch);

    const document = await client.getRenderedDocument({ name: 'Shared.esp', origin: 'ModA' }, '000800:Shared.esp');

    expect(document).toEqual(rendered);
    const url = new URL(fetch.mock.calls[0]?.[0].url ?? '');
    expect(url.pathname).toBe('/plugins/Shared.esp/records/000800%3AShared.esp/rendered-document');
    expect(url.searchParams.get('origin')).toBe('ModA');
  });

  it('answers null when the plugin holds no such record', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(404, { detail: 'The plugin holds no such record.' })));
    const client = makeClient(fetch);

    await expect(client.getRenderedDocument({ name: 'Shared.esp', origin: 'ModA' }, '000800:Shared.esp')).resolves.toBeNull();
  });

  it('rejects, naming the reason, when mEdit cannot answer', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(503, { detail: 'No load order has been loaded.' })));
    const client = makeClient(fetch);

    await expect(client.getRenderedDocument({ name: 'Shared.esp', origin: 'ModA' }, '000800:Shared.esp'))
      .rejects.toThrow(/No load order has been loaded/);
  });
});

describe('HttpMEditClient — the file holding a copy of a record', () => {
  it('asks mEdit for the file of the plugin\'s copy of the record and reads its path', async () => {
    const file = { path: '/mods/ModA/plugin-source/Shared.esp/Npcs/SharedNpc - 000800_Shared.esp.json' };
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, file)));
    const client = makeClient(fetch);

    await expect(client.getRecordFile({ name: 'Shared.esp', origin: 'ModA' }, '000800:Shared.esp')).resolves.toEqual(file);
    const url = new URL(fetch.mock.calls[0]?.[0].url ?? '');
    expect(url.pathname).toBe('/plugins/Shared.esp/records/000800%3AShared.esp/file');
    expect(url.searchParams.get('origin')).toBe('ModA');
  });

  it('answers null when the plugin holds no such record', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(404, { detail: 'The plugin holds no such record.' })));
    const client = makeClient(fetch);

    await expect(client.getRecordFile({ name: 'Shared.esp', origin: 'ModA' }, '000800:Shared.esp')).resolves.toBeNull();
  });

  it('rejects, naming the reason, when mEdit cannot answer', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(503, { detail: 'No load order has been loaded.' })));
    const client = makeClient(fetch);

    await expect(client.getRecordFile({ name: 'Shared.esp', origin: 'ModA' }, '000800:Shared.esp'))
      .rejects.toThrow(/No load order has been loaded/);
  });
});

describe('HttpMEditClient — the record a file holds', () => {
  const path = '/mods/ModA/plugin-source/Shared.esp/Npcs/SharedNpc - 000800_Shared.esp.json';

  it('asks mEdit for the record whose own document the file is', async () => {
    const record = { formKey: '000800:Shared.esp', plugin: 'Shared.esp', origin: 'ModA' };
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, record)));
    const client = makeClient(fetch);

    await expect(client.getRecordOfFile(path)).resolves.toEqual(record);
    const url = new URL(fetch.mock.calls[0]?.[0].url ?? '');
    expect(url.pathname).toBe('/plugin-source/record');
    expect(url.searchParams.get('path')).toBe(path);
  });

  it('answers null when mEdit answers the file holds no record', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(new Response(null, { status: 204 })));
    const client = makeClient(fetch);

    await expect(client.getRecordOfFile(path)).resolves.toBeNull();
  });

  it('rejects with mEdit\'s reason when it cannot read the file', async () => {
    const detail = `${path} declares no FormKey, so it is no record's document.`;
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(422, { detail })));
    const client = makeClient(fetch);

    await expect(client.getRecordOfFile(path)).rejects.toThrow(detail);
  });
});

describe('HttpMEditClient — the extensions a new plugin may take', () => {
  it('asks mEdit and reads its answer', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, ['.esp', '.esm'])));
    const client = makeClient(fetch);

    await expect(client.getCreatablePluginExtensions()).resolves.toEqual(['.esp', '.esm']);
    expect(fetch.mock.calls[0]?.[0].url).toMatch(/\/plugins\/creatable-extensions$/);
  });

  it('rejects, naming the reason, when mEdit cannot answer', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(503, { detail: 'No load order has been loaded.' })));
    const client = makeClient(fetch);

    await expect(client.getCreatablePluginExtensions()).rejects.toThrow(/No load order has been loaded/);
  });
});

describe('HttpMEditClient — the plugins that list a plugin as a master', () => {
  it('answers the dependants and the plugins whose masters could not be read', async () => {
    const answer = { dependants: [{ name: 'Child.esp', origin: 'ChildMod' }], unreadable: [{ name: 'Bad.esp', origin: 'BadMod' }] };
    const client = makeClient(vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, answer))));

    await expect(client.getPluginDependants({ name: 'Base.esm', origin: 'BaseMod' })).resolves.toEqual(answer);
  });

  it('rejects a response with no body, so a rename never goes ahead unasked on no answer', async () => {
    const client = makeClient(vi.fn((_req: Request) => Promise.resolve(new Response(null, { status: 200 }))));

    await expect(client.getPluginDependants({ name: 'Base.esm', origin: 'BaseMod' })).rejects.toThrow(/no answer/);
  });

  it('rejects, naming the reason, while mEdit has not finished indexing', async () => {
    const client = makeClient(vi.fn((_req: Request) =>
      Promise.resolve(jsonResponse(503, { detail: 'mEdit has not finished indexing the plugins.' }))));

    await expect(client.getPluginDependants({ name: 'Base.esm', origin: 'BaseMod' })).rejects.toThrow(/not finished indexing/);
  });
});

describe('HttpMEditClient — the problems in each tracked plugin\'s source', () => {
  it('answers each plugin with its problems, on the file that holds the record', async () => {
    const answer = [{
      plugin: { name: 'Refers.esp', origin: 'ReferringMod' },
      problems: [{ formKey: '000800:Refers.esp', targetFormKey: '000ABC:Absent.esp', sourceRelativePath: 'Refers.esp/Npcs/Npc.json', message: 'Race: 000ABC:Absent.esp is held by no active plugin' }],
    }];
    let asked: Request | undefined;
    const client = makeClient(vi.fn((req: Request) => {
      asked = req;
      return Promise.resolve(jsonResponse(200, answer));
    }));

    await expect(client.getPluginProblems()).resolves.toEqual(answer);
    expect(new URL(asked?.url ?? '').pathname).toBe('/plugins/problems');
  });

  it('rejects a response with no body, so no plugin reads as clean on no answer', async () => {
    const client = makeClient(vi.fn((_req: Request) => Promise.resolve(new Response(null, { status: 200 }))));

    await expect(client.getPluginProblems()).rejects.toThrow(/no answer/);
  });

  it('rejects, naming the reason, while mEdit has not finished indexing', async () => {
    const client = makeClient(vi.fn((_req: Request) =>
      Promise.resolve(jsonResponse(503, { detail: 'mEdit has not finished indexing the plugins.' }))));

    await expect(client.getPluginProblems()).rejects.toThrow(/not finished indexing/);
  });
});

describe('HttpMEditClient — read timeout, checked through getRecordTypes, standing in for the read verbs that share the race', () => {
  it('rejects a hung read after the configured timeout, aborting the request', async () => {
    let sawSignal: AbortSignal | undefined;
    const fetch = vi.fn((req: Request) => {
      sawSignal = req.signal;
      return new Promise<Response>(() => {});
    });
    const client = makeClient(fetch, { timeoutMs: 20 });

    await expect(client.getRecordTypes({ name: 'MyPatch.esp', origin: 'ModA' })).rejects.toThrow(/timed out after 20ms/);
    expect(sawSignal?.aborted).toBe(true);
  });

  it('does not time out a read that answers before the deadline', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(200, [])));
    const client = makeClient(fetch, { timeoutMs: 20 });

    await expect(client.getRecordTypes({ name: 'MyPatch.esp', origin: 'ModA' })).resolves.toEqual([]);
  });
});

describe('HttpMEditClient, the backend process it hides', () => {
  it('files the spawned backend\'s output in the log channel at its own level, and spawns it at the channel\'s level', async () => {
    const channel = { ...fakeLogChannel(), logLevel: DEBUG_LEVEL };
    const state = { healthy: false };
    const spawn = vi.fn(() => {
      state.healthy = true;
      return { kill: vi.fn(), on: vi.fn(), stdout: Readable.from(['[10:00:00 WRN] slow\n']), stderr: null };
    });
    const client = createMEditClient({
      backend: {
        freePort: () => Promise.resolve(5172), pollIntervalMs: 5, spawn, executablePath: '/x/backend',
        checkHealth: () => Promise.resolve(state.healthy),
      },
      backendLog: channel,
      fetch: neverFetch(),
    });

    await client.start();

    expect(spawn).toHaveBeenCalledWith('/x/backend', ['--urls', 'http://localhost:5172', '--Serilog:MinimumLevel:Default', 'Debug']);
    await vi.waitFor(() => expect(channel.warn).toHaveBeenCalledWith('[backend] slow'));
  });
});

describe('HttpMEditClient — onNotification', () => {
  it('hands a typed listener the payload of a frame the stream carries', async () => {
    const frame = { kind: 'plugin-changed', plugin: 'A.esp', origin: 'ModA', keys: [], sequence: 1 };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`event: plugin-changed\ndata: ${JSON.stringify(frame)}\n\n`));
      },
    });
    const client = makeClient(() => Promise.resolve(new Response(body, { status: 200 })));
    const heard: unknown[] = [];
    client.onNotification('plugin-changed', (p) => heard.push(p));

    await client.start();

    await vi.waitFor(() => expect(heard).toEqual([{ plugin: { name: 'A.esp', origin: 'ModA' } }]));
    await client.stop();
  });
});

describe('HttpMEditClient — a plugin address on the wire', () => {
  const plugin = { name: 'Shared.esp', origin: 'ModA' };

  async function requestOf(call: (client: MEditClient) => Promise<unknown>, answer: unknown = []): Promise<Request> {
    let seen: Request | undefined;
    const fetch = vi.fn((req: Request) => { seen = req; return Promise.resolve(jsonResponse(200, answer)); });
    await call(makeClient(fetch));
    if (!seen) throw new Error('no request sent');
    return seen;
  }

  it.each([
    ['getRecordTypes', (c: MEditClient) => c.getRecordTypes(plugin), []],
    ['getPluginDependants', (c: MEditClient) => c.getPluginDependants(plugin), { dependants: [], unreadable: [] }],
    ['getWorldspaces', (c: MEditClient) => c.getWorldspaces(plugin), []],
    ['getWorldspaceBlocks', (c: MEditClient) => c.getWorldspaceBlocks(plugin, '000800:Shared.esp'), { topCells: [], blocks: [] }],
    ['getCellChildRecords', (c: MEditClient) => c.getCellChildRecords(plugin, '000800:Shared.esp'), { persistent: [], temporary: [] }],
    ['getInteriorCells', (c: MEditClient) => c.getInteriorCells(plugin), []],
    ['getContainerChildren', (c: MEditClient) => c.getContainerChildren(plugin, '000800:Shared.esp'), []],
    ['getWorkingTreeStatesBeneath', (c: MEditClient) => c.getWorkingTreeStatesBeneath(plugin), { plugin: [], recordTypes: {}, records: {} }],
  ])('%s asks for the plugin by filename in the path and by origin in the query', async (_name, call, answer) => {
    const request = await requestOf(call, answer);

    expect(new URL(request.url).pathname).toContain('/plugins/Shared.esp/');
    expect(new URL(request.url).searchParams.get('origin')).toBe('ModA');
  });

  it('answers the working-tree states beneath each row as mEdit sends them', async () => {
    const beneath = {
      plugin: ['Modified', 'Added'],
      recordTypes: { wrld: ['Modified', 'Added'] },
      records: { '000800:Shared.esp': ['Added'] },
    };
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(200, beneath)));

    await expect(makeClient(fetch).getWorkingTreeStatesBeneath(plugin)).resolves.toEqual(beneath);
  });
});
