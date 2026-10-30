import { IGNORED_THROWS, loadOrderStatusEventFixture } from './fixtures';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { leveledLog } from '../../test/leveledLog';
import { createMEditClient } from '../HttpMEditClient';
import type { MEditClient, RecordEditEnvelope } from '../MEditClient';
import { PassThrough, Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { answered } from './healthAnswer';

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
  { health = 'up', ...deps }: { health?: 'up' | 'down' } & Pick<Parameters<typeof createMEditClient>[0], 'timeoutMs' | 'reconnectDelayMs' | 'log'> = {},
) {
  return createMEditClient({ listenerThrows: IGNORED_THROWS,
    backend: {
      attachPort: 5172, pollIntervalMs: 5, pollTimeoutMs: 20,
      checkHealth: () => Promise.resolve(answered(health === 'up')),
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

function reopeningStreams() {
  const streams: { push: (chunk: Uint8Array) => void; end: () => void }[] = [];
  const open = () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    streams.push({ push: (chunk) => controller.enqueue(chunk), end: () => controller.close() });
    return Promise.resolve(new Response(body, { status: 200 }));
  };
  return { streams, open };
}

function loadOrderStatusTick(loadOrderStatus: Parameters<typeof loadOrderStatusEventFixture>[0]): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(loadOrderStatusEventFixture(loadOrderStatus))}\n\n`);
}

const readyTickThatSettlesPutLoadOrder = () => loadOrderStatusTick({ totalPlugins: 1, indexedPlugins: [{ name: 'Foo.esp', origin: 'A' }], conflictsComputed: true, failures: [], version: 1 });

const noContent = () => Promise.resolve(new Response(null, { status: 204 }));

function routedFetch(routes: [match: string, handle: (req: Request) => Promise<Response>][]) {
  return vi.fn((req: Request) => {
    const route = routes.find(([match]) => req.url.includes(match));
    if (!route) return Promise.reject(new Error(`unrouted fetch: ${req.method} ${req.url}`));
    return route[1](req);
  });
}

const EMPTY_SNAPSHOT = {
  plugins: [], active: [], loadedWithNoLine: [], archives: [], stringsFiles: [], places: [], mods: [], statCache: '/instance/stat-cache',
  dataFolder: '/game/Data', instanceRoot: '/instance', gameRelease: 'Fallout4', stringsLanguage: 'English',
};

describe('HttpMEditClient — the process is the client\'s own', () => {
  it('reports the backend\'s status changes to its listeners, until one unsubscribes', async () => {
    const client = makeClient(neverFetch());
    const kept: string[] = [];
    const dropped: string[] = [];
    client.onStatusChanged((s) => kept.push(s));
    client.onStatusChanged((s) => dropped.push(s))();

    await client.start();
    await client.stop();

    expect({ kept, dropped }).toEqual({ kept: ['running', 'stopped'], dropped: [] });
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

  it('is gone once the stream reopens, as it may have reattached to another process', async () => {
    const { streams, open } = reopeningStreams();
    const client = makeClient(routedFetch([['/notifications/stream', open]]), { reconnectDelayMs: 0 });
    await client.start();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0]?.push(readyTickThatSettlesPutLoadOrder());
    await vi.waitFor(() => expect(client.loadOrderStatus?.conflictsComputed).toBe(true));

    streams[0]?.end();

    await vi.waitFor(() => expect(client.loadOrderStatus).toBeUndefined());
    expect(streams).toHaveLength(2);
  });
});

describe('HttpMEditClient — the notification stream follows the status', () => {
  beforeEach(() => { vi.resetAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('opens the stream when the backend attaches', async () => {
    const stream = vi.fn(() => Promise.resolve(new Response(new ReadableStream({ start: () => {} }), { status: 200 })));
    const client = makeClient(routedFetch([['/notifications/stream', stream], ['/unsaved-documents', noContent]]));

    await client.start();

    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(1));
  });

  it('closes the stream when the backend stops', async () => {
    let sawSignal: AbortSignal | undefined;
    const stream = vi.fn((req: Request) => {
      sawSignal = req.signal;
      return new Promise<Response>(() => {});
    });
    const client = makeClient(routedFetch([['/notifications/stream', stream], ['/unsaved-documents', noContent]]));
    await client.start();
    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(1));

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

type Verb = (client: MEditClient) => Promise<unknown>;

const answers = (status: number, body?: unknown) => () =>
  Promise.resolve(body === undefined ? new Response(null, { status }) : jsonResponse(status, body));
const rejects = (message: string) => () => Promise.reject(new Error(message));

async function exchange(verb: Verb, respond: () => Promise<Response>) {
  const log = leveledLog();
  const fetch = vi.fn((_req: Request) => respond());
  const result = await verb(makeClient(fetch, { log }));
  const request = fetch.mock.calls[0]?.[0];
  if (!request) throw new Error('no request sent');
  return { result, log, fetch, request };
}

const modToDecompileAndCommit = (name: string) => ({
  name, repository: { sourceFolder: `/instance/source/${name}`, assets: ['a.dds'], manifestName: `${name}.manifest.json`, manifest: '{}' },
});
const modToBuild = (name: string) => ({
  name, sourceFolder: `/instance/source/${name}`, folder: `/instance/mods/${name}`, exclude: ['b.dds'], taken: ['a.dds'],
  archives: [{ path: `${name}.ba2`, files: ['a.dds'] }],
});
const buildFacts = {
  exclusionMark: '.mohidden', archives: { general: { ba2: { version: 1, compressed: true } }, textures: { ba2: { version: 1, compressed: true } } },
};

describe('HttpMEditClient — what each verb sends and reads', () => {
  const myPatch = { name: 'MyPatch.esp', origin: 'ModA' };
  const shared = { name: 'Shared.esp', origin: 'ModA' };
  const sharedKey = '000800:Shared.esp';
  const first = { name: 'First.esp', origin: 'ModA' };
  const second = { name: 'Second.esp', origin: 'ModB' };
  const repairPreview = {
    plugin: first, hash: 'abc',
    diagnoses: [{ diagnosis: { anchor: 'REGN 00000800', defectClass: 'short', message: 'RDAT is 6 bytes' }, change: { description: 'pads RDAT', dropsData: false } }],
  };
  const kept = { formKey: '000801:MyPatch.esp', plugin: { name: 'MyPatch.esp', origin: 'ModA' } };
  const gone = { formKey: '000802:MyPatch.esp', plugin: { name: 'MyPatch.esp', origin: 'ModA' } };
  const nonCompiledPlugin = { formKey: '000900:Other.esp', plugin: { name: 'Other.esp', origin: 'ModB' } };
  const patch = { name: 'Patch.esp', origin: 'PatchMod' };
  const other = { name: 'Other.esp', origin: 'OtherMod' };
  const newPlugin = { name: 'New.esp', origin: 'ModA' };
  const changes = { moves: [], deletions: [], documents: [{ path: '/source/ModA/plugin-source/MyPatch.esp/Npcs/000900_MyPatch.esp.json', text: '{}' }] };
  const keptChanges = { record: kept, moves: [], deletions: ['/source/ModA/plugin-source/MyPatch.esp/Npcs/Kept'], documents: [] };
  const goneChanges = { record: gone, moves: [], deletions: [], documents: [{ path: '/source/ModA/plugin-source/MyPatch.esp/Cell.json', text: '{"cut": true}' }] };
  const copied = { record: kept, destination: patch, moves: [], deletions: [], documents: [{ path: '/source/PatchMod/plugin-source/Patch.esp/Header.json', text: '{"h":1}' }] };
  const diagnostic = { formKey: '000800:First.esp', sourceRelativePath: 'First.esp/Npc/A.json', message: 'Race: points at nothing' };
  const renamed: RecordEditEnvelope = { op: 'set', path: [{ kind: 'member', name: 'EditorID' }], value: 'Renamed' };
  const editChanges = {
    moves: [{ from: 'plugin-source/MyPatch.esp/Npcs/Old - 000800_MyPatch.esp.json', to: 'plugin-source/MyPatch.esp/Npcs/Renamed - 000800_MyPatch.esp.json' }],
    deletions: ['plugin-source/MyPatch.esp/Npcs/Gone'],
    documents: [{ path: 'plugin-source/MyPatch.esp/Npcs/Renamed - 000800_MyPatch.esp.json', text: '{"EditorID": "Renamed"}' }],
  };
  const comparison = { overrides: [], diffs: [], conflictAll: 'NoConflict', recordTypeName: 'Weapon' };
  const copies = [
    { formKey: '000801:A.esp', plugin: { name: 'A.esp', origin: 'AMod' }, documentText: '{}' },
    { formKey: '000802:B.esp', plugin: { name: 'B.esp', origin: 'BMod' } },
  ];
  const documentText = { plugin: patch, documentText: '{}', alone: false };
  const sharedFile = { kind: 'OwnFile', location: '/source/ModA/plugin-source/Shared.esp/Npcs/SharedNpc - 000800_Shared.esp.json' };
  const fileRecord = { formKey: sharedKey, plugin: 'Shared.esp', origin: 'ModA' };
  const sourcePath = '/source/ModA/plugin-source/Shared.esp/Npcs/SharedNpc - 000800_Shared.esp.json';
  const problems = [{
    plugin: { name: 'Refers.esp', origin: 'ReferringMod' },
    problems: [{ formKey: '000800:Refers.esp', targetFormKey: '000ABC:Absent.esp', sourceRelativePath: 'Refers.esp/Npcs/Npc.json', message: 'Race: 000ABC:Absent.esp is held by no active plugin' }],
  }];
  const same = <T>(answer: T) => ({ answer, reads: answer });
  const createdRecord = { formKey: '000900:MyPatch.esp', ...changes };
  const formKeyEdit: RecordEditEnvelope = { op: 'set', path: [{ kind: 'member', name: 'FormKey' }], value: '000900:MyPatch.esp' };

  const posts: {
    name: string; verb: Verb; answer: unknown; reads: unknown; path: string; body: unknown;
  }[] = [
    { name: 'getCreateChanges', verb: (c) => c.getCreateChanges(myPatch, 'npc_'), ...same(createdRecord),
      path: '/plugins/MyPatch.esp/create-record-changes', body: { origin: 'ModA', recordType: 'npc_' } },
    { name: 'getCreateChanges in a container', verb: (c) => c.getCreateChanges(myPatch, 'cell', { container: '000800:MyPatch.esp', position: { x: 1, y: -2 } }),
      ...same(createdRecord), path: '/plugins/MyPatch.esp/create-record-changes',
      body: { origin: 'ModA', recordType: 'cell', container: '000800:MyPatch.esp', position: { x: 1, y: -2 } } },
    { name: 'getDeleteChanges', verb: (c) => c.getDeleteChanges([kept, nonCompiledPlugin, gone]),
      answer: { applied: [keptChanges, goneChanges], refused: [{ item: nonCompiledPlugin, refusal: 'PluginNotCompiledPlugin', message: 'Other.esp is not a compiled plugin.' }] },
      reads: { applied: [keptChanges, goneChanges], refused: [{ item: nonCompiledPlugin, reason: 'Other.esp is not a compiled plugin.' }] },
      path: '/records/delete-changes', body: { records: [kept, nonCompiledPlugin, gone] } },
    { name: 'createPlugin', verb: (c) => c.createPlugin(newPlugin, '/mods/ModA', '/source/ModA'), ...same({ ...newPlugin, path: '/mods/ModA/New.esp' }),
      path: '/plugins/create', body: { origin: 'ModA', name: 'New.esp', folder: '/mods/ModA', sourceFolder: '/source/ModA' } },
    { name: 'getRenameSourceChanges', verb: (c) => c.getRenameSourceChanges({ name: 'Old.esp', origin: 'ModA' }, 'New.esp'),
      ...same({ treeName: 'Old.esp', ...editChanges }),
      path: '/plugins/rename-source-changes', body: { origin: 'ModA', name: 'Old.esp', newName: 'New.esp' } },
    { name: 'getCopyChanges', verb: (c) => c.getCopyChanges([kept], 'Override', [patch, other], true),
      answer: { applied: [copied], refused: [{ item: { record: kept, destination: other }, refusal: 'DestinationHoldsRecord', message: 'Other.esp already holds it.' }] },
      reads: { applied: [copied], refused: [{ item: { record: kept, destination: other }, reason: 'Other.esp already holds it.' }] },
      path: '/records/copy-changes', body: { records: [kept], mode: 'Override', destinations: [patch, other], replace: true } },
    { name: 'getComparison with the document text', verb: (c) => c.getComparison('000801:MyPatch.esp', documentText), ...same(comparison),
      path: '/records/000801%3AMyPatch.esp/compare', body: documentText },
    { name: 'getRecordsComparison', verb: (c) => c.getRecordsComparison(copies), ...same({ compare: comparison, missing: [] }),
      path: '/records/compare', body: { copies } },
    { name: 'decompileAndCommit', verb: (c) => c.decompileAndCommit([modToDecompileAndCommit('ModA'), modToDecompileAndCommit('ModC')]),
      answer: { applied: [{ mod: 'ModA', plugins: [first] }], refused: [{ item: 'ModC', refusal: 'ModProvidesNoPlugin', message: 'ModC provides no plugin.' }] },
      reads: { landed: [{ mod: 'ModA', plugins: [first] }], refused: [{ item: 'ModC', reason: 'ModC provides no plugin.' }] },
      path: '/decompile-and-commit', body: { mods: [modToDecompileAndCommit('ModA'), modToDecompileAndCommit('ModC')] } },
    { name: 'build', verb: (c) => c.build([modToBuild('ModA'), modToBuild('ModC')], buildFacts),
      answer: {
        applied: [{
          mod: 'ModA', compiled: [{ ...first, diagnostics: [diagnostic] }], refused: [{ item: second, refusal: 'PluginSourceUnreadable', message: 'Second.esp has no readable source.' }],
          archivesRefused: [{ item: 'ModA.ba2', refusal: 'VariantNotWritten', message: 'Modbench packs no archive for this game.' }], overwritten: ['a.nif'],
          failure: 'The build stopped before compiling.', made: [{ path: 'a.nif', vouchedFor: true }],
        }],
        refused: [{ item: 'ModC', refusal: 'ArchiveFileNotAnAsset', message: "'ModC.ba2' takes 'a.dds', which is not an asset of its source." }],
      },
      reads: {
        landed: [{
          mod: 'ModA', compiled: [{ ...first, diagnostics: [diagnostic] }], refused: [{ item: second, reason: 'Second.esp has no readable source.' }],
          archivesRefused: [{ item: 'ModA.ba2', reason: 'Modbench packs no archive for this game.' }], overwritten: ['a.nif'],
          failure: 'The build stopped before compiling.', made: [{ path: 'a.nif', vouchedFor: true }],
        }],
        refused: [{ item: 'ModC', reason: "'ModC.ba2' takes 'a.dds', which is not an asset of its source." }],
      },
      path: '/build', body: { mods: [modToBuild('ModA'), modToBuild('ModC')], ...buildFacts } },
    { name: 'decompile', verb: (c) => c.decompile([first, second], true),
      answer: { applied: [first], refused: [{ item: second, refusal: 'NotInSourceMod', message: 'Second.esp is not in a source mod.' }] },
      reads: { landed: [first], refused: [{ item: second, reason: 'Second.esp is not in a source mod.' }] },
      path: '/plugins/decompile', body: { plugins: [first, second], force: true } },
    { name: 'repairPreviews', verb: (c) => c.repairPreviews([first, second]),
      answer: { applied: [repairPreview], refused: [{ item: second, refusal: 'NotMalformed', message: 'Second.esp is not malformed.' }] },
      reads: { landed: [repairPreview], refused: [{ item: second, reason: 'Second.esp is not malformed.' }] },
      path: '/plugins/repair-previews', body: { plugins: [first, second] } },
    { name: 'decompileAndRepair', verb: (c) => c.decompileAndRepair([{ plugin: first, hash: 'abc', newRepository: modToDecompileAndCommit('ModA').repository }], false, true),
      answer: { applied: [first], refused: [] },
      reads: { landed: [first], refused: [] },
      path: '/plugins/decompile-and-repair', body: { plugins: [{ plugin: first, hash: 'abc', newRepository: modToDecompileAndCommit('ModA').repository }], force: false, agreedDrops: true } },
    { name: 'getEditChanges', verb: (c) => c.getEditChanges('000800:MyPatch.esp', myPatch, renamed),
      answer: { formKey: '000800:MyPatch.esp', path: 'EditorID', ...editChanges, newFormKey: null }, reads: { applied: true, ...editChanges },
      path: '/records/000800%3AMyPatch.esp/edit-changes', body: { edit: { plugin: 'MyPatch.esp', origin: 'ModA', ...renamed } } },
    { name: 'getEditChanges of the FormID', verb: (c) => c.getEditChanges('000800:MyPatch.esp', myPatch, formKeyEdit),
      answer: { formKey: '000800:MyPatch.esp', path: 'FormKey', moves: [], deletions: [], documents: [], newFormKey: '000900:MyPatch.esp' },
      reads: { applied: true, moves: [], deletions: [], documents: [], newFormKey: '000900:MyPatch.esp' },
      path: '/records/000800%3AMyPatch.esp/edit-changes', body: { edit: { plugin: 'MyPatch.esp', origin: 'ModA', ...formKeyEdit } } },
    { name: 'resolveNames', verb: (c) => c.resolveNames([{ name: 'Shared.esp', origin: 'ModA' }, { name: 'SharedNpc' }]),
      ...same([{ plugin: shared }, { formKey: sharedKey, editorId: 'SharedNpc' }]),
      path: '/names/resolve', body: { names: [{ name: 'Shared.esp', origin: 'ModA' }, { name: 'SharedNpc' }] } },
    { name: 'selectRows', verb: (c) => c.selectRows('SELECT 1'), answer: { rows: [{ n: 1 }] }, reads: [{ n: 1 }],
      path: '/records/select', body: { sql: 'SELECT 1' } },
  ];

  it.each(posts)('$name posts $path once and reads the answer', async ({ verb, answer, reads, path, body }) => {
    const { result, request, fetch } = await exchange(verb, answers(200, answer));

    expect(result).toEqual(reads);
    expect(fetch).toHaveBeenCalledOnce();
    const url = new URL(request.url);
    expect(request.method).toBe('POST');
    expect(url.pathname).toBe(path);
    expect([...url.searchParams]).toEqual([]);
    expect(await request.json()).toEqual(body);
  });

  it.each([
    { name: 'moveLastWritten', verb: (c: MEditClient) => c.moveLastWritten({ name: 'Old.esp', origin: 'ModA' }, 'OLD.esp', 'New.esp'),
      reads: { moved: true }, path: '/plugins/move-last-written', body: { origin: 'ModA', name: 'Old.esp', treeName: 'OLD.esp', newName: 'New.esp' } },
    { name: 'rebuildIndex', verb: (c: MEditClient) => c.rebuildIndex('/instance', 'Fallout4'),
      reads: { rebuilt: true }, path: '/index/rebuild', body: { instanceRoot: '/instance', gameRelease: 'Fallout4' } },
  ])('$name posts $path and reads a 204 as done', async ({ verb, reads, path, body }) => {
    const { result, request } = await exchange(verb, answers(204));

    expect(result).toEqual(reads);
    expect(request.method).toBe('POST');
    expect(new URL(request.url).pathname).toBe(path);
    expect(await request.json()).toEqual(body);
  });

  const gets: {
    name: string; verb: Verb; answer: unknown; path: string; query: Record<string, string>;
  }[] = [
    { name: 'getComparison', verb: (c) => c.getComparison('000801:MyPatch.esp'), answer: comparison,
      path: '/records/000801%3AMyPatch.esp/compare', query: {} },
    { name: 'getCreatableRecordTypes', verb: (c) => c.getCreatableRecordTypes(),
      answer: [{ type: 'acti', displayName: 'Activator' }, { type: 'npc_', displayName: 'Non-Player Character' }],
      path: '/record-types/creatable', query: {} },
    { name: 'getChildRecordTypes', verb: (c) => c.getChildRecordTypes(shared, sharedKey), answer: [{ type: 'dial', displayName: 'Dialog Topic' }],
      path: '/plugins/Shared.esp/records/000800%3AShared.esp/child-record-types', query: { origin: 'ModA' } },
    { name: 'getRenderedDocument', verb: (c) => c.getRenderedDocument(shared, sharedKey),
      answer: { fileName: 'SharedNpc - 000800_Shared.esp.json', text: '{ "FormKey": "000800:Shared.esp" }' },
      path: '/plugins/Shared.esp/records/000800%3AShared.esp/rendered-document', query: { origin: 'ModA' } },
    { name: 'getCopyDocument', verb: (c) => c.getCopyDocument(shared, sharedKey), answer: sharedFile,
      path: '/plugins/Shared.esp/records/000800%3AShared.esp/document', query: { origin: 'ModA' } },
    { name: 'getRecordOfFile', verb: (c) => c.getRecordOfFile(sourcePath), answer: fileRecord,
      path: '/plugin-source/record', query: { path: sourcePath } },
    { name: 'getCreatablePluginExtensions', verb: (c) => c.getCreatablePluginExtensions(), answer: ['.esp', '.esm'],
      path: '/plugins/creatable-extensions', query: {} },
    { name: 'getPluginDependants', verb: (c) => c.getPluginDependants({ name: 'Base.esm', origin: 'BaseMod' }),
      answer: { dependants: [{ name: 'Child.esp', origin: 'ChildMod' }], unreadable: [{ name: 'Bad.esp', origin: 'BadMod' }] },
      path: '/plugins/Base.esm/dependants', query: { origin: 'BaseMod' } },
    { name: 'getPluginIndexing', verb: (c) => c.getPluginIndexing({ name: 'Patch.esp', origin: 'PatchMod' }), answer: { state: 'ReadFailed', reason: 'Patch.esp could not be parsed.' },
      path: '/plugins/Patch.esp/indexed-as-on-disk', query: { origin: 'PatchMod' } },
    { name: 'getPluginProblems', verb: (c) => c.getPluginProblems(), answer: problems,
      path: '/plugins/problems', query: {} },
    { name: 'getActiveFilter', verb: (c) => c.getActiveFilter(), answer: { sql: 'SELECT 1', source: 'armor.sql' },
      path: '/load-order/filter', query: {} },
  ];

  it.each(gets)('$name gets $path and reads the answer untransformed', async ({ verb, answer, path, query }) => {
    const { result, request } = await exchange(verb, answers(200, answer));

    expect(result).toEqual(answer);
    const url = new URL(request.url);
    expect(request.method).toBe('GET');
    expect(url.pathname).toBe(path);
    expect(Object.fromEntries(url.searchParams)).toEqual(query);
  });

  it('getRecordsComparison returns the copies no plugin gave, each with its reason, and no comparison', async () => {
    const missing = {
      compare: null,
      missing: [{ formKey: '000801:A.esp', plugin: { name: 'A.esp', origin: 'AMod' }, reason: 'RecordGone', message: 'held by no plugin' }],
    };

    const { result } = await exchange((c) => c.getRecordsComparison(copies), answers(200, missing));

    expect(result).toEqual(missing);
  });

  it.each([
    ['getRecordOfFile, when the file holds no record', (c: MEditClient) => c.getRecordOfFile(sourcePath)],
    ['getActiveFilter, when mEdit holds no filter', (c: MEditClient) => c.getActiveFilter()],
  ])('%s, reads a 204 as null', async (_, verb) => {
    const { result } = await exchange(verb, answers(204));

    expect(result).toBeNull();
  });

  it('getRecordHolders asks the record\'s holders by plugin and origin', async () => {
    const { result } = await exchange((c) => c.getRecordHolders(kept.formKey), answers(200, {
      overrides: [{ plugin: 'Patch.esp', origin: 'PatchMod' }, { plugin: 'Patch.esp', origin: 'OtherMod' }],
      diffs: [], conflictAll: 'NoConflict',
    }));

    expect(result).toEqual([{ name: 'Patch.esp', origin: 'PatchMod' }, { name: 'Patch.esp', origin: 'OtherMod' }]);
  });

  it('getRecordOwner answers the plugin holding the record as a plugin address', async () => {
    const { result } = await exchange((c) => c.getRecordOwner('000800:Patch.esp'), answers(200, { plugin: 'Patch.esp', origin: 'PatchMod' }));

    expect(result).toEqual(patch);
  });

  describe('a write mEdit refuses, or a request that never reaches it', () => {
    const detail = 'No load order has been received.';
    const writes: { name: string; verb: Verb; status: number; body: unknown; text: string; refusal: string }[] = [
      { name: 'getDeleteChanges', verb: (c) => c.getDeleteChanges([kept, gone]), status: 400, body: 'Bad Request', text: 'Bad Request', refusal: 'Could not delete 2 records' },
      { name: 'getCreateChanges', verb: (c) => c.getCreateChanges(myPatch, 'npc_'), status: 422,
        body: { detail: 'MyPatch.esp has no FormKey free at or above its Next Object ID, up to 0xFFF, the last a light plugin can address. Clear the light flag in the header to draw above it.' },
        text: 'MyPatch.esp has no FormKey free at or above its Next Object ID, up to 0xFFF, the last a light plugin can address. Clear the light flag in the header to draw above it.',
        refusal: 'Could not create a new npc_ record in "MyPatch.esp"' },
      { name: 'getCopyChanges', verb: (c) => c.getCopyChanges([kept], 'Override', [other], false), status: 503, body: { detail }, text: detail, refusal: 'Could not copy 1 record' },
      { name: 'createPlugin', verb: (c) => c.createPlugin(newPlugin, '/mods/ModA', '/source/ModA'), status: 409,
        body: { detail: 'A file is already at /mods/ModA/New.esp, so New.esp was not created.', refusal: 'FileExists' },
        text: 'A file is already at /mods/ModA/New.esp, so New.esp was not created.', refusal: 'Could not create "New.esp"' },
      { name: 'getRenameSourceChanges', verb: (c) => c.getRenameSourceChanges({ name: 'Old.esp', origin: 'ModA' }, 'New.esp'), status: 409,
        body: { detail: 'ModA already holds New.esp.', refusal: 'NameTaken' }, text: 'ModA already holds New.esp.', refusal: 'Could not rename the source of "Old.esp"' },
      { name: 'decompileAndCommit', verb: (c) => c.decompileAndCommit([modToDecompileAndCommit('ModA'), modToDecompileAndCommit('ModB')]), status: 500, body: 'git was not found on PATH.', text: 'git was not found on PATH.', refusal: 'Could not decompile and commit 2 mods' },
      { name: 'build', verb: (c) => c.build([modToBuild('ModA'), modToBuild('ModB')], buildFacts), status: 503, body: detail, text: detail, refusal: 'Could not build 2 mods' },
      { name: 'decompile', verb: (c) => c.decompile([first, second], true), status: 500, body: 'git was not found on PATH.', text: 'git was not found on PATH.', refusal: 'Could not decompile 2 plugins' },
    ];

    it.each(writes)('$name resolves a WriteRefused with the server text, asking once', async ({ verb, status, body, text, refusal }) => {
      const { result, log, fetch } = await exchange(verb, answers(status, body));

      expect(result).toEqual({ refused: true, message: `${refusal} — ${text}` });
      expect(fetch).toHaveBeenCalledOnce();
      expect(log.lines.error).toEqual([expect.stringContaining(`failed (${status})`)]);
    });

    it.each(writes)('$name resolves a thrown request the same way, as one that never reached mEdit', async ({ verb, refusal }) => {
      const { result, log } = await exchange(verb, rejects('socket hang up'));

      expect(result).toEqual({ refused: true, message: `${refusal} — mEdit could not be reached.`, unreachable: true });
      expect(log.lines.error).toEqual([expect.stringContaining('socket hang up')]);
    });

    it('getDeleteChanges refuses a success with no body', async () => {
      const { result } = await exchange((c) => c.getDeleteChanges([kept]), answers(200));

      expect(result).toEqual({ refused: true, message: 'Could not delete 1 record — no answer' });
    });
  });

  describe('a read mEdit refuses', () => {
    const cannotAnswer = 'No load order has been loaded.';
    const notIndexed = 'mEdit has not finished indexing the plugins.';
    const refusedReads: { what: string; verb: Verb; status: number; detail: string; refusal?: string; failed?: 'no-load-order' }[] = [
      { what: 'getComparison(000801:Broken.esp)', verb: (c) => c.getComparison('000801:Broken.esp'), status: 500, detail: 'boom' },
      { what: 'getRecordsComparison', verb: (c) => c.getRecordsComparison([]), status: 400, detail: 'No records.' },
      { what: 'resolveNames', verb: (c) => c.resolveNames([{ name: 'Gone' }]), status: 400, detail: 'Nothing is named "Gone".' },
      { what: 'selectRows', verb: (c) => c.selectRows('DROP TABLE x'), status: 400, detail: 'Only a SELECT runs.' },
      { what: 'getCreatableRecordTypes', verb: (c) => c.getCreatableRecordTypes(), status: 503, detail: cannotAnswer, refusal: 'NoLoadOrder', failed: 'no-load-order' },
      { what: 'getChildRecordTypes(Shared.esp, 000800:Shared.esp)', verb: (c) => c.getChildRecordTypes(shared, sharedKey), status: 503, detail: cannotAnswer, refusal: 'NoLoadOrder', failed: 'no-load-order' },
      { what: 'getRenderedDocument(Shared.esp, 000800:Shared.esp)', verb: (c) => c.getRenderedDocument(shared, sharedKey), status: 503, detail: cannotAnswer, refusal: 'NoLoadOrder', failed: 'no-load-order' },
      { what: 'getCopyDocument(Shared.esp, 000800:Shared.esp)', verb: (c) => c.getCopyDocument(shared, sharedKey), status: 503, detail: cannotAnswer, refusal: 'NoLoadOrder', failed: 'no-load-order' },
      { what: `getRecordOfFile(${sourcePath})`, verb: (c) => c.getRecordOfFile(sourcePath), status: 422, detail: `${sourcePath} declares no FormKey, so it is no record's document.` },
      { what: 'getCreatablePluginExtensions', verb: (c) => c.getCreatablePluginExtensions(), status: 503, detail: cannotAnswer, refusal: 'NoLoadOrder', failed: 'no-load-order' },
      { what: 'getPluginDependants(Base.esm)', verb: (c) => c.getPluginDependants({ name: 'Base.esm', origin: 'BaseMod' }), status: 503, detail: notIndexed, refusal: 'IndexNotReady' },
      { what: 'getPluginProblems', verb: (c) => c.getPluginProblems(), status: 503, detail: notIndexed, refusal: 'IndexNotReady' },
    ];

    it.each(refusedReads)('$what fails with mEdit\'s reason alone, and files the verb and status in the log', async ({ what, verb, status, detail, refusal, failed = 'refused' }) => {
      const { result, log } = await exchange(verb, answers(status, { detail, refusal }));

      expect(result).toEqual({ failed, refusal: detail });
      expect(log.lines.error).toEqual([`[HttpMEditClient] ${what} failed (${status}): ${detail}`]);
    });

    it.each([
      ['NoLoadOrder', 'no-load-order'],
      ['IndexNotReady', 'refused'],
      ['OutOfMemory', 'refused'],
    ])('reads a 503 naming %s as a %s failure', async (refusal, failed) => {
      const detail = 'mEdit cannot answer.';
      const { result } = await exchange((c) => c.getComparison('000801:A.esp'), answers(503, { detail, refusal }));

      expect(result).toEqual({ failed, refusal: detail });
    });

    it.each([
      ['getComparison', (c: MEditClient) => c.getComparison('000801:Gone.esp')],
      ['getRenderedDocument', (c: MEditClient) => c.getRenderedDocument(shared, sharedKey)],
      ['getCopyDocument', (c: MEditClient) => c.getCopyDocument(shared, sharedKey)],
    ])('%s answers null on a 404, a record held by no plugin', async (_name, verb) => {
      const { result } = await exchange(verb, answers(404, { detail: 'No such record.' }));

      expect(result).toBeNull();
    });

    it.each([
      ['getPluginDependants, so a rename never goes ahead unasked on no answer', (c: MEditClient) => c.getPluginDependants({ name: 'Base.esm', origin: 'BaseMod' })],
      ['getPluginProblems, so no plugin reads as clean on no answer', (c: MEditClient) => c.getPluginProblems()],
    ])('%s fails a response with no body', async (_name, verb) => {
      const { result } = await exchange(verb, answers(200));

      expect(result).toEqual({ failed: 'no-answer' });
    });
  });

  describe('getEditChanges answered with a refusal', () => {
    const notCompiledPlugin = 'MyPatch.esp is not a compiled plugin, so it is read-only.';
    const detail = 'No load order has been received.';
    const refusals = [
      [409, { refusal: 'PluginNotCompiledPlugin', detail: notCompiledPlugin }, 'PluginNotCompiledPlugin', notCompiledPlugin],
      [422, { refusal: 'PluginNotCompiledPlugin', detail: notCompiledPlugin }, 'PluginNotCompiledPlugin', notCompiledPlugin],
      [422, { refusal: 'SourceAccessFailed', detail: 'Could not write the source file for 000800:MyPatch.esp: Access denied.' }, 'SourceAccessFailed', 'Could not write the source file for 000800:MyPatch.esp: Access denied.'],
      [503, { detail, refusal: 'NoLoadOrder' }, 'NoLoadOrder', detail],
    ] as const;

    it.each(refusals)('answers a %s as its cause in the backend\'s words, a warning and no error', async (status, body, refusal, message) => {
      const { result, log } = await exchange((c) => c.getEditChanges('000800:MyPatch.esp', myPatch, renamed), answers(status, body));

      expect(result).toEqual({ applied: false, refusal, message });
      expect(log.lines.warn).toEqual([expect.stringContaining(refusal)]);
      expect(log.lines.error).toEqual([]);
    });
  });

  describe('rebuildIndex answered with a failure', () => {
    const heldBody = {
      detail: 'This instance\'s record index is open in another Modbench window (/instance/modbench/index.duckdb). '
        + 'Close that window, then refresh.',
    };
    it.each([
      ['a 423 as heldElsewhere', answers(423, heldBody), { rebuilt: false, heldElsewhere: true }],
      ['any other non-ok response as a plain failure carrying the backend detail', answers(500, { detail: 'Failed to rebuild the store.' }), { rebuilt: false, heldElsewhere: false, detail: 'Failed to rebuild the store.' }],
      ['a thrown request as a plain failure, never a rejection', rejects('fetch failed'), { rebuilt: false, heldElsewhere: false, detail: 'mEdit could not be reached.' }],
    ])('answers %s', async (_name, respond, expected) => {
      const { result } = await exchange((c) => c.rebuildIndex('/instance', 'Fallout4'), respond);

      expect(result).toEqual(expected);
    });
  });

  describe('clearFilter', () => {
    it.each([
      ['a refusal with the backend detail', answers(503, { detail: 'No load order has been received yet.' }), 'No load order has been received yet.'],
      ['a thrown request with its reason, never a rejection', rejects('fetch failed'), 'mEdit could not be reached.'],
      ['a clear mEdit took with null', answers(204), null],
    ])('answers %s', async (_name, respond, expected) => {
      const { result } = await exchange((c) => c.clearFilter(), respond);

      expect(result).toBe(expected);
    });
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
  const plugins = [{ name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', provider: { kind: 'Mod' as const, mod: 'A', folder: '/mods/A' }, line: 3, lineNamesIt: true, archives: [], stringsFiles: [] }];
  const active = [{ name: 'Foo.esp', origin: 'A' }];
  const loadedWithNoLine = [{ name: 'Foo.esp', origin: 'A' }];
  const appliedBody = { applied: true, version: 1 };
  const archives = [{ path: '/game/Data/Foo - Main.ba2', stamp: '1/2/3' }];
  const stringsFiles = [{ path: '/mods/A/Strings/Foo_en.STRINGS', stamp: '4/5/6' }];
  const snapshot = {
    plugins, active, loadedWithNoLine, archives, stringsFiles, places: [], mods: [], statCache: '/instance/stat-cache',
    dataFolder: '/game/Data', instanceRoot: '/instance', gameRelease: 'Fallout4', stringsLanguage: 'English',
  };

  it('PUTs every plugin with its line, the active plugins, the archives and strings files, the Data folder and the instance root', async () => {
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

    expect(putBody).toEqual(snapshot);
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
    const { streams, open } = reopeningStreams();
    let status = { state: 'Reconciling', totalPlugins: 1, indexedPlugins: [], conflictsComputed: false, failures: [], version: 0 };
    let put = false;
    const fetch = routedFetch([
      ['/notifications/stream', open],
      ['/load-order/status', () => Promise.resolve(jsonResponse(200, status))],
      ['/load-order', () => { put = true; return Promise.resolve(jsonResponse(200, appliedBody)); }],
    ]);
    const client = makeClient(fetch, { reconnectDelayMs: 0 });
    await client.start();
    await vi.waitFor(() => expect(streams).toHaveLength(1));

    const load = client.sendLoadOrder(snapshot);
    await vi.waitFor(() => expect(put).toBe(true));
    status = { ...status, state: 'Ready', conflictsComputed: true, version: 1 };
    streams[0]?.end();

    await expect(load).resolves.toMatchObject({ outcome: 'applied', status: { version: 1 } });
  });

  it('announces every plugin it put again as changed once a reopened stream\'s process has applied it, since views read it again on a change and never on a reconnect', async () => {
    const { streams, open } = reopeningStreams();
    const fetch = routedFetch([
      ['/notifications/stream', open],
      ['/load-order/status', () => Promise.resolve(jsonResponse(200, {
        state: 'Ready', totalPlugins: 1, indexedPlugins: [], conflictsComputed: true, failures: [], version: 1,
      }))],
      ['/load-order', () => Promise.resolve(jsonResponse(200, appliedBody))],
    ]);
    const client = makeClient(fetch, { reconnectDelayMs: 0 });
    await client.start();
    const heard: unknown[] = [];
    client.onNotification('plugin-changed', ({ plugin }) => heard.push(plugin));
    await client.sendLoadOrder(snapshot);
    expect(heard).toEqual([]);

    streams[0]?.end();

    await vi.waitFor(() => expect(heard).toEqual([{ name: 'Foo.esp', origin: 'A' }]));
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
    await vi.waitFor(() => expect(client.loadOrderStatus?.version).toBe(0));
    answerPut(jsonResponse(200, appliedBody));

    await expect(load).resolves.toMatchObject({ outcome: 'applied', status: { version: 1 } });
  });

  it('stays stopped after a crash, telling its exit once: a snapshot answers backendFailed', async () => {
    const children: EventEmitter[] = [];
    const client = createMEditClient({ listenerThrows: IGNORED_THROWS,
      backend: {
        freePort: () => Promise.resolve(5172), executablePath: '/x/backend',
        spawn: () => {
          const child = Object.assign(new EventEmitter(), { kill: () => undefined, stdin: new PassThrough() });
          children.push(child);
          return child;
        },
        pollIntervalMs: 3, pollTimeoutMs: 20, checkHealth: () => Promise.resolve(answered(true)),
      },
      backendLog: fakeLogChannel(), fetch: routedFetch([['/notifications/stream', () => Promise.resolve(openStreamResponse())]]),
    });
    await client.start();
    const exits: string[] = [];
    client.onExit(() => exits.push('exit'));

    children[0]?.emit('exit', 1);
    await vi.waitFor(() => expect(client.status).toBe('stopped'));

    expect(exits).toEqual(['exit']);
    await expect(client.sendLoadOrder(snapshot)).resolves.toEqual({ outcome: 'backendFailed' });
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
    const child = Object.assign(new EventEmitter(), { kill: () => undefined, stdin: new PassThrough() });
    child.stdin.on('finish', () => { abortedAtKill = putSignal?.aborted; child.emit('exit', 0); });
    const client = createMEditClient({ listenerThrows: IGNORED_THROWS,
      backend: {
        freePort: () => Promise.resolve(5172), spawn: () => child, executablePath: '/x/backend',
        pollIntervalMs: 5, pollTimeoutMs: 20, checkHealth: () => Promise.resolve(answered(true)),
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

describe('HttpMEditClient — a read the request never reaches mEdit with', () => {
  it('fails as unreachable, and files the fetch error in the log alone', async () => {
    const log = leveledLog();
    const client = makeClient(vi.fn(() => Promise.reject(new Error('fetch failed'))), { log });

    await expect(client.getPlugins()).resolves.toEqual({ failed: 'unreachable' });
    expect(log.lines.error).toEqual([expect.stringContaining('fetch failed')]);
  });
});

describe('HttpMEditClient — a read before mEdit has started', () => {
  it('fails as unreachable, and files the reason in the log alone', async () => {
    const log = leveledLog();
    const fetch = vi.fn();
    const client = createMEditClient({ listenerThrows: IGNORED_THROWS, backendLog: fakeLogChannel(), fetch, log });

    await expect(client.getPlugins()).resolves.toEqual({ failed: 'unreachable' });
    expect(fetch).not.toHaveBeenCalled();
    expect(log.lines.error).toEqual([expect.stringContaining('mEdit has not started')]);
  });
});

describe('HttpMEditClient — read timeout, checked through getRecordTypes, standing in for the read verbs that share the race', () => {
  it('fails a hung read after the configured timeout, aborting the request', async () => {
    let sawSignal: AbortSignal | undefined;
    const fetch = vi.fn((req: Request) => {
      sawSignal = req.signal;
      return new Promise<Response>(() => {});
    });
    const client = makeClient(fetch, { timeoutMs: 20 });

    await expect(client.getRecordTypes({ name: 'MyPatch.esp', origin: 'ModA' })).resolves.toEqual({ failed: 'timed-out' });
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
      return { kill: vi.fn(), on: vi.fn(), stdin: new PassThrough(), stdout: Readable.from(['[10:00:00 WRN] slow\n']), stderr: null };
    });
    const client = createMEditClient({ listenerThrows: IGNORED_THROWS,
      backend: {
        freePort: () => Promise.resolve(5172), pollIntervalMs: 5, spawn, executablePath: '/x/backend',
        checkHealth: () => Promise.resolve(answered(state.healthy)),
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
    const client = makeClient(routedFetch([
      ['/notifications/stream', () => Promise.resolve(new Response(body, { status: 200 }))], ['/unsaved-documents', noContent],
    ]));
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
});

describe('HttpMEditClient — a changes request reads the documents mEdit holds', () => {
  const plugin = { name: 'MyPatch.esp', origin: 'ModA' };
  const record = { formKey: '000800:MyPatch.esp', plugin: { name: 'MyPatch.esp', origin: 'ModA' } };
  const envelope: RecordEditEnvelope = { op: 'set', path: [{ kind: 'member', name: 'EditorID' }], value: 'Renamed' };

  const gestures: [string, (client: MEditClient) => Promise<unknown>, route: string][] = [
    ['edit', (client) => client.getEditChanges(record.formKey, plugin, envelope), '/edit-changes'],
    ['create', (client) => client.getCreateChanges(plugin, 'npc_'), '/create-record-changes'],
    ['delete', (client) => client.getDeleteChanges([record]), '/delete-changes'],
    ['copy', (client) => client.getCopyChanges([record], 'Override', [plugin], false), '/copy-changes'],
    ['rename source', (client) => client.getRenameSourceChanges(plugin, 'New.esp'), '/rename-source-changes'],
  ];

  it.each(gestures)('sends the %s request only once the pending hand-over has answered', async (_name, gesture, route) => {
    let answerHandOver!: () => void;
    const answered = new Promise<void>((resolve) => { answerHandOver = resolve; });
    const handedOver = vi.fn();
    const requests: string[] = [];
    const fetch = routedFetch([
      ['/notifications/stream', () => Promise.resolve(openStreamResponse())],
      ['/unsaved-documents', () => { handedOver(); return answered.then(() => new Response(null, { status: 204 })); }],
      [route, (req) => { requests.push(new URL(req.url).pathname); return Promise.resolve(jsonResponse(200, { applied: [], refused: [] })); }],
    ]);
    const client = makeClient(fetch);
    await client.start();
    client.handUnsavedDocuments([{ path: '/m/plugin-source/MyPatch.esp/Npc.json', text: '{}' }]);
    await vi.waitFor(() => expect(handedOver).toHaveBeenCalled());

    const gesturing = gesture(client);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toEqual([]);

    answerHandOver();
    await gesturing;
    expect(requests).toHaveLength(1);
  });

  it.each(gestures)('sends the %s request only once the load order sent before it has settled', async (_name, gesture, route) => {
    const { response, push } = pushableStreamResponse();
    let putLoadOrder = false;
    const requests: string[] = [];
    const fetch = routedFetch([
      ['/notifications/stream', () => Promise.resolve(response)],
      ['/load-order', () => { putLoadOrder = true; return Promise.resolve(jsonResponse(200, { applied: true, version: 1 })); }],
      [route, (req) => { requests.push(new URL(req.url).pathname); return Promise.resolve(jsonResponse(200, { applied: [], refused: [] })); }],
    ]);
    const client = makeClient(fetch);
    await client.start();
    void client.sendLoadOrder(EMPTY_SNAPSHOT);
    await vi.waitFor(() => expect(putLoadOrder).toBe(true));

    const gesturing = gesture(client);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toEqual([]);

    push(readyTickThatSettlesPutLoadOrder());
    await gesturing;
    expect(requests).toHaveLength(1);
  });

  it('fails a refused hand-over with mEdit\'s reason alone', async () => {
    const fetch = routedFetch([
      ['/notifications/stream', () => Promise.resolve(openStreamResponse())],
      ['/unsaved-documents', () => Promise.resolve(jsonResponse(400, { detail: 'Not plugin source.' }))],
    ]);
    const client = makeClient(fetch);
    const settled = vi.fn();
    client.onUnsavedHandOver(settled);
    await client.start();

    client.handUnsavedDocuments([{ path: '/m/plugin-source/MyPatch.esp/Npc.json', text: '{}' }]);

    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith({ failed: 'refused', refusal: 'Not plugin source.' }));
  });

  it('answers a thrown request as an unknown refusal in the words for it, never fetch\'s text', async () => {
    const client = makeClient(vi.fn(() => Promise.reject(new Error('fetch failed'))));

    expect(await client.getEditChanges(record.formKey, plugin, envelope)).toEqual({ applied: false, refusal: 'Unknown', message: 'mEdit could not be reached.' });
  });

});
