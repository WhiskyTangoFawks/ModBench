import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { HttpMEditClient, type HttpMEditClientDeps } from '../HttpMEditClient';
import { Readable } from 'node:stream';
import { isUnanswered } from '../MEditClient';

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
  { health = 'up', ...deps }: { health?: 'up' | 'down' } & Pick<HttpMEditClientDeps, 'timeoutMs' | 'reconnectDelayMs'> = {},
) {
  return new HttpMEditClient({
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

  it('closes the stream when the backend goes disconnected', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(new ReadableStream({ start: () => {} }), { status: 200 })));
    const client = makeClient(fetch, { health: 'down' });

    await client.start();

    expect(client.status).toBe('disconnected');
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

    const result = await client.createRecord('MyPatch.esp', 'ModA', 'npc_');

    expect(result).toEqual({ applied: true, formKey: '000900:MyPatch.esp', recordType: 'npc_' });
    const request = fetch.mock.calls[0]?.[0];
    expect(request?.url).toMatch(/\/plugins\/MyPatch\.esp\/records$/);
    expect(await request?.json()).toEqual({ origin: 'ModA', recordType: 'npc_', editorId: null, formKey: null });
  });

  it('answers a full FormID space as a refusal carrying mEdit\'s remedies, asking once, nothing offering to remove the flag and try again', async () => {
    const detail = 'MyPatch.esp has exhausted its ESL FormKey space. Clear the light flag in the header, or change a record\'s FormID.';
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(422, { detail })));
    const client = makeClient(fetch);

    const result = await client.createRecord('MyPatch.esp', 'ModA', 'npc_');

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
      refused: [{ record: untracked, refusal: 'PluginNotTracked', message: 'Other.esp is not tracked.' }],
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

  it('resolves a thrown request the same way, told apart as unanswered, as a request with no answer may have written', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('socket hang up')));
    const client = makeClient(fetch);

    const result = await client.deleteRecords([kept]);

    expect(result).toEqual({ refused: true, unanswered: true, message: 'Could not delete 1 record — socket hang up' });
    expect(isUnanswered(result)).toBe(true);
  });

  it('tells a success with no body apart as unanswered, for create and copy too', async () => {
    const client = makeClient(vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))));
    const thrown = makeClient(vi.fn(() => Promise.reject(new Error('socket hang up'))));

    const answers = [
      await client.deleteRecords([kept]),
      await thrown.createRecord('MyPatch.esp', 'ModA', 'npc_'),
      await thrown.copyRecords([kept], 'New', [{ name: 'Patch.esp', origin: 'PatchMod' }], false),
    ];

    expect(answers.map(isUnanswered)).toEqual([true, true, true]);
    expect(answers[0]).toEqual({ refused: true, unanswered: true, message: 'Could not delete 1 record — no answer' });
  });

  it('never tells a refusal mEdit answered apart as unanswered', async () => {
    const client = makeClient(vi.fn(() => Promise.resolve(jsonResponse(400, 'Bad Request'))));

    expect(isUnanswered(await client.deleteRecords([kept]))).toBe(false);
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

describe('HttpMEditClient — copying records answers per record and destination', () => {
  const npc = { formKey: '000801:MyPatch.esp', plugin: 'MyPatch.esp', origin: 'ModA' };
  const patch = { name: 'Patch.esp', origin: 'PatchMod' };
  const other = { name: 'Other.esp', origin: 'OtherMod' };

  it('sends the records, the mode, the destinations and the replace Option as one call, and reads each item', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, {
      applied: [{ record: npc, destination: patch, newFormKey: null }],
      refused: [{ record: npc, destination: other, refusal: 'DestinationHoldsRecord', message: 'Other.esp already holds it.' }],
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

describe('HttpMEditClient — tracking mods answers per plugin and per mod', () => {
  const first = { name: 'First.esp', origin: 'ModA' };
  const second = { name: 'Second.esp', origin: 'ModA' };

  it('sends the mods as one call and reads what was applied as landed, each refused plugin and refused mod with its message', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, {
      applied: [first],
      refused: [{ plugin: second, refusal: 'RoundTripFailed', message: 'Second.esp does not round-trip.' }],
      refusedMods: [{ mod: 'ModC', refusal: 'ModProvidesNoPlugin', message: 'ModC provides no plugin.' }],
    })));
    const client = makeClient(fetch);

    const outcome = await client.track(['ModA', 'ModC']);

    expect(outcome).toEqual({
      landed: [first],
      refused: [{ item: second, reason: 'Second.esp does not round-trip.' }],
      refusedMods: [{ item: 'ModC', reason: 'ModC provides no plugin.' }],
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
      applied: [{ plugin: first, masters: ['Fallout4.esm'], diagnostics: [diagnostic] }],
      refused: [{ plugin: second, refusal: 'None', message: 'Second.esp is not tracked, so there is no source to compile.' }],
    })));
    const client = makeClient(fetch);

    const outcome = await client.compile([first, second]);

    expect(outcome).toEqual({
      landed: [{ plugin: first, masters: ['Fallout4.esm'], diagnostics: [diagnostic] }],
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
      refused: [{ plugin: second, refusal: 'NotInTrackedMod', message: 'Second.esp is not in a tracked mod.' }],
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

describe('HttpMEditClient — an applied edit', () => {
  it('editRecord carries the new FormKey an edit of the FormID answers with', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(200, {
      applied: true, formKey: '000800:MyPatch.esp', path: 'FormKey', newFormKey: '000900:MyPatch.esp',
    })));
    const client = makeClient(fetch);

    const outcome = await client.editRecord(
      '000800:MyPatch.esp', 'MyPatch.esp', 'ModA',
      { op: 'set', path: [{ kind: 'member', name: 'FormKey' }], value: '000900:MyPatch.esp' },
    );

    expect(outcome).toEqual({ applied: true, newFormKey: '000900:MyPatch.esp' });
  });

  it('editRecord answers no new FormKey for an edit of any other field', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(200, {
      applied: true, formKey: '000800:MyPatch.esp', path: 'EditorID', newFormKey: null,
    })));
    const client = makeClient(fetch);

    const outcome = await client.editRecord(
      '000800:MyPatch.esp', 'MyPatch.esp', 'ModA', { op: 'set', path: [{ kind: 'member', name: 'EditorID' }], value: 'x' },
    );

    expect(outcome).toEqual({ applied: true });
  });
});

describe('HttpMEditClient — the not-OK response text', () => {

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

  it('editRecord leaves the load-order-absent 503 alone, its outcome carrying this side\'s own Unknown as there is no typed refusal in it', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(503, { detail: 'No load order has been received.' })));
    const client = makeClient(fetch);

    const outcome = await client.editRecord(
      '000800:MyPatch.esp', 'MyPatch.esp', 'ModA', { op: 'set', path: [{ kind: 'member', name: 'EditorID' }], value: 'x' },
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

describe('HttpMEditClient — a group\'s records', () => {
  it('asks for what the record filter hides too, only when told to', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, { items: [], total: 0 })));
    const client = makeClient(fetch);

    await client.getRecords('MyPatch.esp', 'npc_', 0, 10, 'ModA');
    await client.getRecords('MyPatch.esp', 'npc_', 0, 10, 'ModA', { unfiltered: true });

    const queries = fetch.mock.calls.map((call) => new URL(call[0].url).searchParams.get('unfiltered'));
    expect(queries).toEqual([null, 'true']);
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
});

describe('HttpMEditClient — putLoadOrder', () => {
  const plugins = [{ name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', provider: { kind: 'Mod' as const, mod: 'A', folder: '/mods/A' } }];
  const active = [{ name: 'Foo.esp', origin: 'A' }];
  const loadedWithNoLine = [{ name: 'Foo.esp', origin: 'A' }];
  const appliedBody = { applied: true, version: 1 };

  it('PUTs every plugin, the active plugins, the game directory and the instance root', async () => {
    let putBody: unknown;
    const { response, push } = pushableStreamResponse();
    const fetch = routedFetch([
      ['/notifications/stream', () => Promise.resolve(response)],
      ['/load-order', async (req) => { putBody = await req.clone().json(); return jsonResponse(200, appliedBody); }],
    ]);
    const client = makeClient(fetch);
    await client.start();

    const load = client.putLoadOrder(plugins, active, loadedWithNoLine, '/game/Data', '/instance', 'Fallout4');
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

    const load = client.putLoadOrder(plugins, active, loadedWithNoLine, '/game/Data', '/instance', 'Fallout4');
    expect(putFetch).not.toHaveBeenCalled();

    const { response, push } = pushableStreamResponse();
    resolveStream(response);
    await vi.waitFor(() => expect(putFetch).toHaveBeenCalledTimes(1));
    push(readyTickThatSettlesPutLoadOrder());
    await load;
  });

  it('answers a PUT to a process attached again from that process\'s own ticks, never the last one\'s', async () => {
    const streams: { push: (chunk: Uint8Array) => void }[] = [];
    const fetch = routedFetch([
      ['/notifications/stream', () => {
        const stream = pushableStreamResponse();
        streams.push(stream);
        return Promise.resolve(stream.response);
      }],
      ['/load-order/status', () => Promise.resolve(jsonResponse(200, {
        state: 'Reconciling', totalPlugins: 1, indexedPlugins: [], conflictsComputed: false, failures: [], version: 0,
      }))],
      ['/load-order', () => { puts += 1; return Promise.resolve(jsonResponse(200, appliedBody)); }],
    ]);
    let puts = 0;
    const client = makeClient(fetch);
    await client.start();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0]?.push(loadOrderStatusTick({ totalPlugins: 1, indexedPlugins: [], conflictsComputed: true, failures: [], version: 5 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await client.stop();
    await client.start();
    await vi.waitFor(() => expect(streams).toHaveLength(2));

    let settled = false;
    const load = client.putLoadOrder(plugins, active, loadedWithNoLine, '/game/Data', '/instance', 'Fallout4').then((r) => { settled = true; return r; });
    await vi.waitFor(() => expect(puts).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    streams[1]?.push(readyTickThatSettlesPutLoadOrder());
    await expect(load).resolves.toMatchObject({ outcome: 'applied', status: { version: 1 } });
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

    await expect(client.putLoadOrder(plugins, active, loadedWithNoLine, '/game/Data', '/instance', 'Fallout4'))
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

    const load = client.putLoadOrder(plugins, active, loadedWithNoLine, '/game/Data', '/instance', 'Fallout4');
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

    const load = client.putLoadOrder(plugins, active, loadedWithNoLine, '/game/Data', '/instance', 'Fallout4');
    await vi.waitFor(() => expect(answerPut).toBeDefined());
    push(loadOrderStatusTick({ totalPlugins: 1, indexedPlugins: [], conflictsComputed: true, failures: [], version: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    answerPut(jsonResponse(200, appliedBody));

    await expect(load).resolves.toMatchObject({ outcome: 'applied', status: { version: 1 } });
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
      plugins, active, loadedWithNoLine, '/game/Data', '/instance', 'Fallout4', { signal: controller.signal },
    );

    expect(result).toEqual({ outcome: 'abandoned' });
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

describe('HttpMEditClient — whether the game has light plugins', () => {
  it('asks mEdit and reads its answer', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, false)));
    const client = makeClient(fetch);

    await expect(client.getLightPluginsSupported()).resolves.toBe(false);
    expect(fetch.mock.calls[0]?.[0].url).toMatch(/\/plugins\/light-plugins-supported$/);
  });

  it('rejects, naming the reason, when mEdit cannot answer', async () => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(503, { detail: 'No load order has been loaded.' })));
    const client = makeClient(fetch);

    await expect(client.getLightPluginsSupported()).rejects.toThrow(/No load order has been loaded/);
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

    await expect(client.getRecordTypes('MyPatch.esp', 'ModA')).rejects.toThrow(/timed out after 20ms/);
    expect(sawSignal?.aborted).toBe(true);
  });

  it('does not time out a read that answers before the deadline', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(200, [])));
    const client = makeClient(fetch, { timeoutMs: 20 });

    await expect(client.getRecordTypes('MyPatch.esp', 'ModA')).resolves.toEqual([]);
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
    const client = new HttpMEditClient({
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
