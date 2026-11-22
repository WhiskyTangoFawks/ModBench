import { EMPTY_SNAPSHOT, IGNORED_THROWS, cancellableToken, loadOrderStatusEventFixture } from './fixtures';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { leveledLog } from '../../test/leveledLog';
import { createMEditClient } from '../HttpMEditClient';
import type { MEditClient, RecordEditEnvelope } from '../MEditClient';
import type { PluginAddress } from '../../wire/pluginAddress';
import { PassThrough, Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { answerOf as read, isReadFailed } from '../../wire/readFailed';
import { answered } from './healthAnswer';
import { diskCheckedBy } from '../../repositoriesLib/writesTold';

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
  { health = 'up', ...deps }: { health?: 'up' | 'down' } & Partial<Pick<Parameters<typeof createMEditClient>[0], 'timeoutMs' | 'reconnectDelayMs' | 'log'>> = {},
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

describe('HttpMEditClient — the record index standing', () => {
  it('is the latest tick the stream carried, and is gone once mEdit is stopped', async () => {
    const { response, push } = pushableStreamResponse();
    const client = makeClient(routedFetch([['/notifications/stream', () => Promise.resolve(response)]]));
    await client.start();

    push(readyTickThatSettlesPutLoadOrder());
    await vi.waitFor(() => expect(client.recordIndexProgress?.settled).toBe(true));
    await client.stop();

    expect(client.recordIndexProgress).toBeUndefined();
  });

  it('is late while the record index is not settled, or refuses the load order, and carries the reason', async () => {
    const { response, push } = pushableStreamResponse();
    const client = makeClient(routedFetch([['/notifications/stream', () => Promise.resolve(response)]]));
    await client.start();

    push(loadOrderStatusTick({ conflictsComputed: false, version: 1 }));
    await vi.waitFor(() => expect(client.recordIndexMayBeLate).toBe(true));
    push(loadOrderStatusTick({ state: 'HeldElsewhere', message: 'another window holds the record index', conflictsComputed: false, version: 1 }));
    await vi.waitFor(() => expect(client.recordIndexProgress?.refusal).toEqual({ kind: 'heldElsewhere', message: 'another window holds the record index' }));
    expect(client.recordIndexMayBeLate).toBe(true);
    push(loadOrderStatusTick({ conflictsComputed: true, version: 2 }));

    await vi.waitFor(() => expect(client.recordIndexMayBeLate).toBe(false));
  });

  it('is gone once the stream reopens, as it may have reattached to another process', async () => {
    const { streams, open } = reopeningStreams();
    const client = makeClient(routedFetch([['/notifications/stream', open]]), { reconnectDelayMs: 0 });
    await client.start();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0]?.push(readyTickThatSettlesPutLoadOrder());
    await vi.waitFor(() => expect(client.recordIndexProgress?.settled).toBe(true));

    streams[0]?.end();

    await vi.waitFor(() => expect(client.recordIndexProgress).toBeUndefined());
    expect(streams).toHaveLength(2);
  });
});

describe('HttpMEditClient — the notification stream follows the status', () => {
  beforeEach(() => { vi.resetAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('opens the stream when the backend attaches', async () => {
    const stream = vi.fn(() => Promise.resolve(new Response(new ReadableStream({ start: () => {} }), { status: 200 })));
    const client = makeClient(routedFetch([['/notifications/stream', stream], ['/unsaved-document', noContent]]));

    await client.start();

    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(1));
  });

  it('closes the stream when the backend stops', async () => {
    let sawSignal: AbortSignal | undefined;
    const stream = vi.fn((req: Request) => {
      sawSignal = req.signal;
      return new Promise<Response>(() => {});
    });
    const client = makeClient(routedFetch([['/notifications/stream', stream], ['/unsaved-document', noContent]]));
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

const modToVersionInGit = (name: string) => ({
  name, modFolder: `/instance/mods/${name}`, commit: true, sourceFolder: { path: `/instance/source/${name}`, in: 'NewRepository' as const, assets: ['a.dds'], buildFile: '{}' },
});
const modToBuild = (name: string) => ({
  name, sourceFolder: `/instance/source/${name}`, folder: `/instance/mods/${name}`, exclude: ['b.dds'], step: { pack: [{ path: `${name}.ba2`, files: ['a.dds'] }] },
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
  const same = <T>(answer: T) => ({ answer, reads: answer });
  const WRITTEN = ['/mods/ModA/New.esp', '/source/ModA/.git'];
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
    { name: 'createPlugin', verb: (c) => c.createPlugin(newPlugin, '/mods/ModA', '/source/ModA', ['Small']), answer: { plugin: newPlugin, written: WRITTEN }, reads: newPlugin,
      path: '/plugins/create', body: { origin: 'ModA', name: 'New.esp', folder: '/mods/ModA', sourceFolder: '/source/ModA', flags: ['Small'] } },
    { name: 'getRenameSourceChanges', verb: (c) => c.getRenameSourceChanges({ name: 'Old.esp', origin: 'ModA' }, 'New.esp', { namedByFileName: false, sourceFiles: [{ from: 'Old.esp', to: 'New.esp' }] }),
      ...same({ treeName: 'Old.esp', ...editChanges }),
      path: '/plugins/rename-source-changes', body: { origin: 'ModA', name: 'Old.esp', newName: 'New.esp', namedByFileName: false, sourceFiles: [{ from: 'Old.esp', to: 'New.esp' }] } },
    { name: 'getSourceFolderMoveChanges', verb: (c) => c.getSourceFolderMoveChanges('/source/Old', '/source/New', [{ from: 'Old.manifest.json', to: 'New.manifest.json' }]),
      ...same({ moves: [{ from: '/source/Old', to: '/source/New' }], deletions: [], documents: [] }),
      path: '/source-folders/move-changes', body: { sourceFolder: '/source/Old', movedTo: '/source/New', files: [{ from: 'Old.manifest.json', to: 'New.manifest.json' }] } },
    { name: 'getCopyChanges', verb: (c) => c.getCopyChanges([kept], 'Override', [patch, other], true),
      answer: { applied: [copied], refused: [{ item: { record: kept, destination: other }, refusal: 'DestinationHoldsRecord', message: 'Other.esp already holds it.' }] },
      reads: { applied: [copied], refused: [{ item: { record: kept, destination: other }, reason: 'Other.esp already holds it.' }] },
      path: '/records/copy-changes', body: { records: [kept], mode: 'Override', destinations: [patch, other], replace: true } },
    { name: 'getComparison with the document text', verb: (c) => c.getComparison('000801:MyPatch.esp', documentText), ...same(comparison),
      path: '/records/000801%3AMyPatch.esp/compare', body: documentText },
    { name: 'getRecordsComparison', verb: (c) => c.getRecordsComparison(copies), ...same({ compare: comparison, missing: [] }),
      path: '/records/compare', body: { copies } },
    { name: 'versionInGit', verb: (c) => c.versionInGit([modToVersionInGit('ModA'), modToVersionInGit('ModC')]),
      answer: { applied: [{ mod: 'ModA', plugins: [first] }], refused: [{ item: 'ModC', refusal: 'CommitFailed', message: 'ModC was not initialized.' }], written: WRITTEN },
      reads: { landed: [{ mod: 'ModA', plugins: [first] }], refused: [{ item: 'ModC', reason: 'ModC was not initialized.', refusal: 'CommitFailed' }] },
      path: '/version-in-git', body: { mods: [modToVersionInGit('ModA'), modToVersionInGit('ModC')] } },
    { name: 'build', verb: (c) => c.build([modToBuild('ModA'), modToBuild('ModC')], buildFacts),
      answer: {
        applied: [{
          mod: 'ModA', compiled: [{ ...first, diagnostics: [diagnostic] }], refused: [{ item: second, refusal: 'PluginSourceUnreadable', message: 'Second.esp has no readable source.' }],
          archivesRefused: [{ item: 'ModA.ba2', refusal: 'VariantNotWritten', message: 'Modbench packs no archive for this game.' }],
          failure: 'The build stopped at its copy.', made: [{ path: 'a.nif', vouchedFor: true }], packed: ['a.dds'], replaced: [], ignored: ['b.mem'],
        }],
        refused: [{ item: 'ModC', refusal: 'ArchiveFileNotInFolder', message: "'ModC.ba2' takes 'a.dds', which its folder does not hold." }],
        written: WRITTEN,
      },
      reads: {
        landed: [{
          mod: 'ModA', compiled: [{ ...first, diagnostics: [diagnostic] }], refused: [{ item: second, reason: 'Second.esp has no readable source.', refusal: 'PluginSourceUnreadable' }],
          archivesRefused: [{ item: 'ModA.ba2', reason: 'Modbench packs no archive for this game.' }],
          failure: 'The build stopped at its copy.', made: [{ path: 'a.nif', vouchedFor: true }], packed: ['a.dds'], ignored: ['b.mem'],
        }],
        refused: [{ item: 'ModC', reason: "'ModC.ba2' takes 'a.dds', which its folder does not hold." }],
      },
      path: '/build', body: { mods: [modToBuild('ModA'), modToBuild('ModC')], ...buildFacts } },
    { name: 'decompile', verb: (c) => c.decompile([first, second], true),
      answer: { applied: [first], refused: [{ item: second, refusal: 'NotInSourceMod', message: 'Second.esp is not in a source mod.' }], written: WRITTEN },
      reads: { landed: [first], refused: [{ item: second, reason: 'Second.esp is not in a source mod.', refusal: 'NotInSourceMod' }] },
      path: '/plugins/decompile', body: { plugins: [first, second], force: true } },
    { name: 'decompileAndRepair', verb: (c) => c.decompileAndRepair([{ plugin: first, sourceFolder: modToVersionInGit('ModA').sourceFolder }], false),
      answer: { applied: [first], refused: [{ item: second, refusal: 'NotMalformed', message: 'Second.esp is not malformed.' }], written: WRITTEN },
      reads: { landed: [first], refused: [{ item: second, reason: 'Second.esp is not malformed.', refusal: 'NotMalformed' }] },
      path: '/plugins/decompile-and-repair', body: { plugins: [{ plugin: first, sourceFolder: modToVersionInGit('ModA').sourceFolder }], force: false } },
    { name: 'getEditChanges', verb: (c) => c.getEditChanges('000800:MyPatch.esp', myPatch, renamed),
      answer: { formKey: '000800:MyPatch.esp', path: 'EditorID', ...editChanges, newFormKey: null }, reads: { applied: true, ...editChanges },
      path: '/records/000800%3AMyPatch.esp/edit-changes', body: { edit: { plugin: 'MyPatch.esp', origin: 'ModA', ...renamed } } },
    { name: 'getEditChanges of the FormID', verb: (c) => c.getEditChanges('000800:MyPatch.esp', myPatch, formKeyEdit),
      answer: { formKey: '000800:MyPatch.esp', path: 'FormKey', moves: [], deletions: [], documents: [], newFormKey: '000900:MyPatch.esp' },
      reads: { applied: true, moves: [], deletions: [], documents: [], newFormKey: '000900:MyPatch.esp' },
      path: '/records/000800%3AMyPatch.esp/edit-changes', body: { edit: { plugin: 'MyPatch.esp', origin: 'ModA', ...formKeyEdit } } },
    { name: 'moveLastWritten', verb: (c) => c.moveLastWritten({ name: 'Old.esp', origin: 'ModA' }, 'OLD.esp', 'New.esp'),
      answer: { written: WRITTEN }, reads: { moved: true },
      path: '/plugins/move-last-written', body: { origin: 'ModA', name: 'Old.esp', treeName: 'OLD.esp', newName: 'New.esp' } },
    { name: 'followSourceFolderMove', verb: (c) => c.followSourceFolderMove('/source/Old', '/source/New'),
      answer: { written: WRITTEN }, reads: { followed: true }, path: '/source-folders/follow-move', body: { sourceFolder: '/source/Old', movedTo: '/source/New' } },
    { name: 'resolveNames', verb: (c) => c.resolveNames([{ name: 'Shared.esp', origin: 'ModA' }, { name: 'SharedNpc' }]),
      ...same([{ plugin: shared }, { formKey: sharedKey, editorId: 'SharedNpc' }]),
      path: '/names/resolve', body: { names: [{ name: 'Shared.esp', origin: 'ModA' }, { name: 'SharedNpc' }] } },
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

  const answeringChangesOnly = [
    'getCreateChanges', 'getCreateChanges in a container', 'getDeleteChanges', 'getRenameSourceChanges', 'getSourceFolderMoveChanges',
    'getCopyChanges', 'getComparison with the document text', 'getRecordsComparison', 'getEditChanges', 'getEditChanges of the FormID', 'resolveNames',
  ];

  const naming = async (write: () => Promise<unknown>): Promise<{ named: string[]; unnamed: number }> => {
    const named: string[] = [];
    let unnamed = 0;
    diskCheckedBy({ name: (paths) => { named.push(...paths); }, leaveUnnamed: () => { unnamed++; } });
    await write();
    return { named, unnamed };
  };

  it.each(posts)('$name names the files mEdit answers it wrote, unless it only answers changes', async ({ name, verb, answer }) => {
    const client = makeClient(() => answers(200, answer)());

    expect(await naming(() => verb(client))).toEqual({ named: answeringChangesOnly.includes(name) ? [] : WRITTEN, unnamed: 0 });
  });

  const writing = [
    { name: 'createPlugin', verb: (c: MEditClient) => c.createPlugin({ name: 'New.esp', origin: 'ModA' }, '/mods/ModA', undefined, undefined), answer: { written: WRITTEN } },
    { name: 'cloneSubmodules', verb: (c: MEditClient) => c.cloneSubmodules([{ folder: '/source/A', pin: 'abc' }]), answer: { applied: [], refused: [], written: WRITTEN } },
    { name: 'setPluginFileFlags', verb: (c: MEditClient) => c.setPluginFileFlags('Fallout4', []), answer: { applied: [], refused: [], written: WRITTEN } },
  ];

  it.each(writing.slice(1))('$name names the files mEdit answers it wrote', async ({ verb, answer }) => {
    expect(await naming(() => verb(makeClient(() => answers(200, answer)())))).toEqual({ named: WRITTEN, unnamed: 0 });
  });

  it.each(writing)('$name refused leaves the files it may have written unnamed', async ({ verb }) => {
    expect(await naming(() => verb(makeClient(() => answers(500, { detail: 'git failed' })())))).toEqual({ named: [], unnamed: 1 });
  });

  it.each([
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
    { name: 'getPluginIndexing', verb: (c) => c.getPluginIndexing({ name: 'Patch.esp', origin: 'PatchMod' }), answer: { state: 'ReadFailed', reason: 'Patch.esp could not be parsed.' },
      path: '/plugins/Patch.esp/indexed-as-on-disk', query: { origin: 'PatchMod' } },
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

  describe('the problems and file paths of a plugin, asked by record', () => {
    const REFERS = { name: 'Refers.esp', origin: 'ReferringMod' };
    const problemOf = (formKey: string, message = 'names no record') => ({ formKey, sourceRelativePath: 'Refers.esp/Npcs/Npc.json', message });
    const answerOf = (rows: { formKey: string; id: string; unchanged?: boolean; message?: string }[], over: object = {}) => ({
      plugin: REFERS,
      problems: rows.filter(({ unchanged }) => !unchanged).map(({ formKey, message }) => problemOf(formKey, message)),
      records: rows.map(({ formKey, id, unchanged }) => ({ formKey, resultId: id, unchanged: unchanged ?? false, unread: [] })),
      ...over,
    });
    const asking = (...replies: unknown[]) => {
      const queue = [...replies];
      const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, queue.shift())));
      const bodies = () => Promise.all(fetch.mock.calls.map(async ([req]) => { const body: unknown = JSON.parse(await req.clone().text()); return body; }));
      return { client: makeClient(fetch), fetch, bodies };
    };

    it('posts what it asks of the whole plugin, and names the results it holds the next time', async () => {
      const { client, fetch, bodies } = asking([answerOf([{ formKey: 'A', id: '1' }])], [answerOf([{ formKey: 'A', id: '1', unchanged: true }])]);

      await client.getPluginProblems(REFERS);
      await client.getPluginProblems(REFERS);

      expect(fetch.mock.calls.map(([req]) => `${req.method} ${new URL(req.url).pathname}${new URL(req.url).search}`)).toEqual(
        Array(2).fill('POST /plugins/problems?plugin=Refers.esp&origin=ReferringMod'));
      expect(await bodies()).toEqual([{ keys: null, known: [] }, { keys: null, known: [{ plugin: REFERS, formKey: 'A', resultId: '1' }] }]);
    });

    it('answers the held answer itself when every record is unchanged', async () => {
      const { client } = asking([answerOf([{ formKey: 'A', id: '1' }])], [answerOf([{ formKey: 'A', id: '1', unchanged: true }])]);

      const first = await client.getPluginProblems(REFERS);
      const second = await client.getPluginProblems(REFERS);

      expect(second).toEqual(first);
      expect(read(second)[0]).toBe(read(first)[0]);
      expect(read(first)[0]?.problems.map(({ formKey }) => formKey)).toEqual(['A']);
    });

    it('asks only for the records named, and puts what it answers beside the records it holds', async () => {
      const { client, bodies } = asking(
        [answerOf([{ formKey: 'A', id: '1' }, { formKey: 'B', id: '2' }])],
        [answerOf([{ formKey: 'B', id: '3', message: 'changed' }])],
      );

      await client.getPluginProblems(REFERS);
      const merged = await client.getPluginProblems(REFERS, undefined, ['B']);

      expect((await bodies())[1]).toEqual({ keys: ['B'], known: [{ plugin: REFERS, formKey: 'A', resultId: '1' }, { plugin: REFERS, formKey: 'B', resultId: '2' }] });
      expect(read(merged)[0]?.problems.map(({ formKey, message }) => [formKey, message])).toEqual([['A', 'names no record'], ['B', 'changed']]);
    });

    it('drops a record whose answer comes back clean', async () => {
      const { client } = asking([answerOf([{ formKey: 'A', id: '1' }, { formKey: 'B', id: '2' }])], [answerOf([{ formKey: 'B', id: '3', unchanged: false }], { problems: [] })]);

      await client.getPluginProblems(REFERS);
      const merged = await client.getPluginProblems(REFERS, undefined, ['B']);

      expect(read(merged)[0]?.problems.map(({ formKey }) => formKey)).toEqual(['A']);
    });

    it('asks the whole plugin again when the records it named come back failed', async () => {
      const { client, bodies } = asking(
        [answerOf([{ formKey: 'A', id: '1' }])],
        [answerOf([], { failure: 'unreadable', failureKind: 'Placement' })],
        [answerOf([{ formKey: 'A', id: '1', unchanged: true }])],
      );

      await client.getPluginProblems(REFERS);
      await client.getPluginProblems(REFERS, undefined, ['A']);

      expect(await bodies()).toEqual([expect.objectContaining({ keys: null }), expect.objectContaining({ keys: ['A'] }), expect.objectContaining({ keys: null })]);
    });

    it('asks the whole plugin when it holds none of it', async () => {
      const { client, bodies } = asking([answerOf([{ formKey: 'A', id: '1' }])]);

      await client.getPluginProblems(REFERS, undefined, ['A']);

      expect(await bodies()).toEqual([{ keys: null, known: [] }]);
    });

    it('asks again without the results it holds when an answer is unchanged for a record it holds no result of', async () => {
      const { client, bodies } = asking(
        [answerOf([{ formKey: 'A', id: '1' }])],
        [answerOf([{ formKey: 'Z', id: '9', unchanged: true }])],
        [answerOf([{ formKey: 'Z', id: '9' }])],
      );

      await client.getPluginProblems(REFERS);
      const merged = await client.getPluginProblems(REFERS);

      expect((await bodies())[2]).toEqual({ keys: null, known: [] });
      expect(read(merged)[0]?.problems.map(({ formKey }) => formKey)).toEqual(['Z']);
    });

    it('puts the files an unread copy stops beside the lines of the records it holds', async () => {
      const paths = (rows: { formKey: string; id: string; unchanged?: boolean; unread?: string[]; path?: string }[], stopped: string[]) => [{
        plugin: REFERS,
        paths: rows.filter(({ unchanged, path }) => !unchanged && path).map(({ formKey, path }) => ({ formKey, fieldPath: 'F', sourceRelativePath: 'x.json', dataPath: path })),
        scripts: [],
        unread: [...stopped, ...rows.filter(({ unchanged }) => !unchanged).flatMap(({ unread }) => unread ?? [])],
        records: rows.map(({ formKey, id, unchanged, unread }) => ({ formKey, resultId: id, unchanged: unchanged ?? false, unread: unchanged ? [] : unread ?? [] })),
      }];
      const { client } = asking(
        paths([{ formKey: 'A', id: '1', path: 'a.dds' }, { formKey: 'B', id: '2', unread: ['B: refused'] }], ['stray.json: stopped']),
        paths([{ formKey: 'A', id: '1', unchanged: true }], ['stray.json: stopped']),
      );

      await client.getPluginFilePaths(REFERS);
      const merged = await client.getPluginFilePaths(REFERS, undefined, ['A']);

      expect(read(merged)[0]?.unread).toEqual(['stray.json: stopped', 'B: refused']);
      expect(read(merged)[0]?.paths.map(({ dataPath }) => dataPath)).toEqual(['a.dds']);
    });
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

  describe('a write mEdit refuses, or a request that never reaches it', () => {
    const detail = 'No load order has been received.';
    const writes: { name: string; verb: Verb; status: number; body: unknown; text: string; refusal: string }[] = [
      { name: 'getDeleteChanges', verb: (c) => c.getDeleteChanges([kept, gone]), status: 400, body: 'Bad Request', text: 'Bad Request', refusal: 'Could not delete 2 records' },
      { name: 'getCreateChanges', verb: (c) => c.getCreateChanges(myPatch, 'npc_'), status: 422,
        body: { detail: 'MyPatch.esp has no FormKey free after the highest of its own records, up to 0xFFF, the last a light plugin can address. Clear the light flag to draw above it.' },
        text: 'MyPatch.esp has no FormKey free after the highest of its own records, up to 0xFFF, the last a light plugin can address. Clear the light flag to draw above it.',
        refusal: 'Could not create a new npc_ record in "MyPatch.esp"' },
      { name: 'getCopyChanges', verb: (c) => c.getCopyChanges([kept], 'Override', [other], false), status: 503, body: { detail }, text: detail, refusal: 'Could not copy 1 record' },
      { name: 'createPlugin', verb: (c) => c.createPlugin(newPlugin, '/mods/ModA', '/source/ModA', undefined), status: 409,
        body: { detail: 'A file is already at /mods/ModA/New.esp, so New.esp was not created.', refusal: 'FileExists' },
        text: 'A file is already at /mods/ModA/New.esp, so New.esp was not created.', refusal: 'Could not create "New.esp"' },
      { name: 'getRenameSourceChanges', verb: (c) => c.getRenameSourceChanges({ name: 'Old.esp', origin: 'ModA' }, 'New.esp', { namedByFileName: true, sourceFiles: [] }), status: 409,
        body: { detail: 'ModA already holds New.esp.', refusal: 'NameTaken' }, text: 'ModA already holds New.esp.', refusal: 'Could not rename "Old.esp"' },
      { name: 'versionInGit', verb: (c) => c.versionInGit([modToVersionInGit('ModA'), modToVersionInGit('ModB')]), status: 500, body: 'git was not found on PATH.', text: 'git was not found on PATH.', refusal: 'Could not put 2 mods under git' },
      { name: 'versionInGit', verb: (c) => c.versionInGit([modToVersionInGit('ModA')]), status: 500, body: 'git was not found on PATH.', text: 'git was not found on PATH.', refusal: 'Could not put 1 mod under git' },
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
      { what: 'selectRows', verb: (c) => c.selectRows('DROP TABLE x', 1000), status: 400, detail: 'Only a SELECT runs.' },
      { what: 'getCreatableRecordTypes', verb: (c) => c.getCreatableRecordTypes(), status: 503, detail: cannotAnswer, refusal: 'NoLoadOrder', failed: 'no-load-order' },
      { what: 'getChildRecordTypes(Shared.esp, 000800:Shared.esp)', verb: (c) => c.getChildRecordTypes(shared, sharedKey), status: 503, detail: cannotAnswer, refusal: 'NoLoadOrder', failed: 'no-load-order' },
      { what: 'getRenderedDocument(Shared.esp, 000800:Shared.esp)', verb: (c) => c.getRenderedDocument(shared, sharedKey), status: 503, detail: cannotAnswer, refusal: 'NoLoadOrder', failed: 'no-load-order' },
      { what: 'getCopyDocument(Shared.esp, 000800:Shared.esp)', verb: (c) => c.getCopyDocument(shared, sharedKey), status: 503, detail: cannotAnswer, refusal: 'NoLoadOrder', failed: 'no-load-order' },
      { what: `getRecordOfFile(${sourcePath})`, verb: (c) => c.getRecordOfFile(sourcePath), status: 422, detail: `${sourcePath} declares no FormKey, so it is no record's document.` },
      { what: 'getCreatablePluginExtensions', verb: (c) => c.getCreatablePluginExtensions(), status: 503, detail: cannotAnswer, refusal: 'NoLoadOrder', failed: 'no-load-order' },
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


describe('HttpMEditClient — selectRows reads the rows as mEdit streams them', () => {
  const encoded = (text: string) => new TextEncoder().encode(text);
  const lines = (...sent: unknown[]) => sent.map((line) => `${JSON.stringify(line)}\n`).join('');

  function streaming(text: string, chunkLength = 7) {
    const cancelled = vi.fn();
    let at = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (at >= text.length) controller.close();
        else controller.enqueue(encoded(text.slice(at, at += chunkLength)));
      },
      cancel: cancelled,
    });
    return { respond: () => Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })), cancelled };
  }

  it('posts the statement once and reads each row, split across chunks, to the line that ends them', async () => {
    const { respond } = streaming(lines({ row: { n: 1 } }, { row: { editor_id: 'a\nb' } }, { end: true }));

    const { result, request } = await exchange((c) => c.selectRows('SELECT 1', 1000), respond);

    expect(result).toEqual({ rows: [{ n: 1 }, { editor_id: 'a\nb' }], more: false });
    expect(new URL(request.url).pathname).toBe('/records/select');
    expect(await request.json()).toEqual({ sql: 'SELECT 1' });
  });

  it('logs the read once, and answers no answer, when mEdit sends no body', async () => {
    const { result, log } = await exchange((c) => c.selectRows('SELECT 1', 1000), () => Promise.resolve(new Response(null, { status: 200 })));

    expect(result).toEqual({ failed: 'no-answer' });
    expect(log.lines.error).toEqual(['[HttpMEditClient] selectRows: mEdit answered with no body']);
  });

  it('stops reading once the rows\' text passes the length asked for, and answers the rows read before it, with more', async () => {
    const row = { row: { body: 'x'.repeat(40) } };
    const { respond, cancelled } = streaming(lines(row, row, row, { end: true }));

    const { result } = await exchange((c) => c.selectRows('SELECT body FROM records', 100), respond);

    expect(result).toEqual({ rows: [row.row, row.row], more: true });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('fails with mEdit\'s reason when a refusal is the last line', async () => {
    const detail = "mEdit's record index ran out of memory for this read.";
    const { respond } = streaming(lines({ row: { n: 1 } }, { refusal: 'OutOfMemory', detail }));

    const { result, log } = await exchange((c) => c.selectRows('SELECT 1', 1000), respond);

    expect(result).toEqual({ failed: 'refused', refusal: detail });
    expect(log.lines.error).toEqual([`[HttpMEditClient] selectRows stopped: ${detail}`]);
  });

  it('fails when the rows stop before their last line, so part of them never passes for all', async () => {
    const { respond } = streaming(lines({ row: { n: 1 } }));

    const { result } = await exchange((c) => c.selectRows('SELECT 1', 1000), respond);

    expect(result).toEqual({ failed: 'unreadable', cause: "mEdit's rows stopped before their last line, so they may not be every row the SELECT selects." });
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

  it.each([
    ['20, unless told', undefined, '20'],
    ['as many as it is told', 200, '200'],
  ])('asks for at most %s', async (_case, atMost, limit) => {
    const fetch = vi.fn((_req: Request) => Promise.resolve(jsonResponse(200, { items: [], total: 0 })));

    await makeClient(fetch).searchRecords('Lever', [], undefined, atMost);

    expect(new URL(fetch.mock.calls[0]?.[0].url ?? '').searchParams.get('limit')).toBe(limit);
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
    plugins, active, loadedWithNoLine, archives, listedArchives: [], stringsFiles, places: [], mods: [],
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
      ['/load-order/sequence', () => Promise.resolve(jsonResponse(200, 0))],
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
      .resolves.toMatchObject({ outcome: 'applied', version: 1 });
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

    await expect(load).resolves.toMatchObject({ outcome: 'applied', version: 1 });
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
    await vi.waitFor(() => expect(client.recordIndexProgress?.version).toBe(0));
    answerPut(jsonResponse(200, appliedBody));

    await expect(load).resolves.toMatchObject({ outcome: 'applied', version: 1 });
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

describe.each([
  ['getPlugins', (c: MEditClient, asked?: readonly PluginAddress[]) => c.getPlugins(asked), '/plugins/facts', '/plugins'],
  ['getPluginsIndexing', (c: MEditClient, asked?: readonly PluginAddress[]) => c.getPluginsIndexing(asked), '/plugins/indexing', '/plugins/indexing'],
] as const)('HttpMEditClient — %s', (_read, asking, namedPath, everyPath) => {
  it('asks for only the plugins named, each by name and origin', async () => {
    const asked = [{ name: 'Shared.esp', origin: 'ModB' }];
    const { result, request } = await exchange((c) => asking(c, asked), () => Promise.resolve(jsonResponse(200, [])));

    expect(result).toEqual([]);
    expect([request.method, new URL(request.url).pathname, await request.json()]).toEqual(['POST', namedPath, { plugins: asked }]);
  });

  it('asks for every plugin when none are named', async () => {
    const { request } = await exchange((c) => asking(c), () => Promise.resolve(jsonResponse(200, [])));

    expect([request.method, new URL(request.url).pathname]).toEqual(['GET', everyPath]);
  });
});

describe('HttpMEditClient — getArchiveFile', () => {
  const asked = { gameRelease: 'Fallout4', archive: '/mods/A/A - Main.ba2', file: 'scripts/a.pex' };

  it('reads the bytes of a file in an archive', async () => {
    const { result, request } = await exchange((c) => c.getArchiveFile(asked.gameRelease, asked.archive, asked.file),
      () => Promise.resolve(new Response(new Uint8Array([7, 8]), { status: 200, headers: { 'content-type': 'application/octet-stream' } })));

    expect(result).toEqual(new Uint8Array([7, 8]));
    expect([request.method, new URL(request.url).pathname, await request.json()]).toEqual(['POST', '/archives/file', asked]);
  });

  it('fails with a refusal when the archive does not hold the file', async () => {
    const { result } = await exchange((c) => c.getArchiveFile(asked.gameRelease, asked.archive, asked.file), () => Promise.resolve(new Response(null, { status: 404 })));

    expect(isReadFailed(result)).toBe(true);
  });
});

describe('HttpMEditClient — getFlaggedPluginHashes', () => {
  const files = [{ path: '/mods/A/A.esp', flags: { Small: true } }];

  it('posts each plugin file with the flags its manifest sets, and reads the hashes it answers', async () => {
    const answered = [{ path: '/mods/A/A.esp', hashes: ['AAAAAAAAAAA=', 'BBBBBBBBBBA='] }];

    const { result, request } = await exchange((c) => c.getFlaggedPluginHashes('Fallout4', files), answers(200, answered));

    expect(result).toEqual(answered);
    expect([request.method, new URL(request.url).pathname, await request.json()]).toEqual(['POST', '/plugin-files/flagged-hashes', { gameRelease: 'Fallout4', files }]);
  });

  it('fails with mEdit\'s reason when it cannot answer', async () => {
    const { result } = await exchange((c) => c.getFlaggedPluginHashes('Fallout4', files), answers(400, { detail: '/mods/A/A.esp: not a plugin' }));

    expect(result).toEqual({ failed: 'refused', refusal: '/mods/A/A.esp: not a plugin' });
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

describe('HttpMEditClient — the change event', () => {
  it('says everything changed once the stream reopens, since views read again on a change and never on a reconnect', async () => {
    const { streams, open } = reopeningStreams();
    const fetch = routedFetch([
      ['/notifications/stream', open],
      ['/load-order/status', () => Promise.resolve(jsonResponse(200, {
        state: 'Ready', totalPlugins: 1, indexedPlugins: [], conflictsComputed: true, failures: [], version: 1,
      }))],
    ]);
    const client = makeClient(fetch, { reconnectDelayMs: 0 });
    await client.start();
    const heard: unknown[] = [];
    client.onDidChange((change) => heard.push(change));

    streams[0]?.end();

    await vi.waitFor(() => expect(heard).toEqual([undefined]));
  });
});

describe('HttpMEditClient — what a frame names', () => {
  it('names the plugin a frame the stream carries on the change event', async () => {
    const frame = { kind: 'plugin-changed', plugin: 'A.esp', origin: 'ModA', keys: [], sequence: 1 };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`event: plugin-changed\ndata: ${JSON.stringify(frame)}\n\n`));
      },
    });
    const client = makeClient(routedFetch([
      ['/notifications/stream', () => Promise.resolve(new Response(body, { status: 200 }))], ['/unsaved-document', noContent],
    ]));
    const heard: unknown[] = [];
    client.onDidChange((change) => heard.push(change));

    await client.start();

    await vi.waitFor(() => expect(heard).toContainEqual([{ plugin: { name: 'A.esp', origin: 'ModA' } }]));
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
    ['rename source', (client) => client.getRenameSourceChanges(plugin, 'New.esp', { namedByFileName: true, sourceFiles: [] }), '/rename-source-changes'],
  ];

  it.each(gestures)('sends the %s request only once the pending hand-over has answered', async (_name, gesture, route) => {
    let answerHandOver!: () => void;
    const answered = new Promise<void>((resolve) => { answerHandOver = resolve; });
    const handedOver = vi.fn();
    const requests: string[] = [];
    const fetch = routedFetch([
      ['/notifications/stream', () => Promise.resolve(openStreamResponse())],
      ['/unsaved-document', () => { handedOver(); return answered.then(() => new Response(null, { status: 204 })); }],
      [route, (req) => { requests.push(new URL(req.url).pathname); return Promise.resolve(jsonResponse(200, { applied: [], refused: [] })); }],
    ]);
    const client = makeClient(fetch);
    await client.start();
    client.handUnsavedDocument({ path: '/m/plugin-source/MyPatch.esp/Npc.json', text: '{}', version: 1 });
    await vi.waitFor(() => expect(handedOver).toHaveBeenCalled());

    const gesturing = gesture(client);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toEqual([]);

    answerHandOver();
    await gesturing;
    expect(requests).toHaveLength(1);
  });

  const readsOverUnsaved: [string, (client: MEditClient) => Promise<unknown>, route: string][] = [
    ['where a record\'s references are placed', (client) => client.getPlacedReferences(record.formKey), '/placed-references'],
    ['the records side by side', (client) => client.getRecordsComparison([{ formKey: record.formKey, plugin }]), '/records/compare'],
    ['what renaming a script changes', (client) => client.getScriptRenameSourceChanges('Old', 'New'), '/script-names/rename-source-changes'],
  ];

  it.each(readsOverUnsaved)('reads %s only once the pending hand-over has answered, so it reads the text VS Code shows', async (_name, reading, route) => {
    let answerHandOver!: () => void;
    const answered = new Promise<void>((resolve) => { answerHandOver = resolve; });
    const handedOver = vi.fn();
    const requests: string[] = [];
    const fetch = routedFetch([
      ['/notifications/stream', () => Promise.resolve(openStreamResponse())],
      ['/unsaved-document', () => { handedOver(); return answered.then(() => new Response(null, { status: 204 })); }],
      [route, (req) => { requests.push(new URL(req.url).pathname); return Promise.resolve(jsonResponse(200, {})); }],
    ]);
    const client = makeClient(fetch);
    await client.start();
    client.handUnsavedDocument({ path: '/m/plugin-source/MyPatch.esp/Npc.json', text: '{}', version: 1 });
    await vi.waitFor(() => expect(handedOver).toHaveBeenCalled());

    const asking = reading(client);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toEqual([]);

    answerHandOver();
    await asking;
    expect(requests).toHaveLength(1);
  });

  it.each(gestures)('sends the %s request once mEdit has answered the load order sent before it, not once its sweep has finished', async (_name, gesture, route) => {
    let answerPut!: () => void;
    const putAnswered = new Promise<void>((resolve) => { answerPut = resolve; });
    let putLoadOrder = false;
    const requests: string[] = [];
    const fetch = routedFetch([
      ['/notifications/stream', () => Promise.resolve(openStreamResponse())],
      ['/load-order', () => { putLoadOrder = true; return putAnswered.then(() => jsonResponse(200, { applied: true, version: 1 })); }],
      [route, (req) => { requests.push(new URL(req.url).pathname); return Promise.resolve(jsonResponse(200, { applied: [], refused: [] })); }],
    ]);
    const client = makeClient(fetch);
    await client.start();
    void client.sendLoadOrder(EMPTY_SNAPSHOT);
    await vi.waitFor(() => expect(putLoadOrder).toBe(true));

    const gesturing = gesture(client);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toEqual([]);

    answerPut();
    await gesturing;
    expect(requests).toHaveLength(1);
  });

  it('says a load order is applied once mEdit has answered the newest sent, not once its sweep has finished', async () => {
    let answerPut!: () => void;
    const putAnswered = new Promise<void>((resolve) => { answerPut = resolve; });
    const fetch = routedFetch([
      ['/notifications/stream', () => Promise.resolve(openStreamResponse())],
      ['/load-order', () => putAnswered.then(() => jsonResponse(200, { applied: true, version: 1 }))],
    ]);
    const client = makeClient(fetch);
    await client.start();
    await expect(client.loadOrderApplied()).resolves.toBe(false);
    void client.sendLoadOrder(EMPTY_SNAPSHOT);

    const applied = client.loadOrderApplied();
    answerPut();

    await expect(applied).resolves.toBe(true);
  });

  it.each(readsOverUnsaved)('reads %s once mEdit has answered the load order sent before it, not once its sweep has finished', async (_name, reading, route) => {
    let answerPut!: () => void;
    const putAnswered = new Promise<void>((resolve) => { answerPut = resolve; });
    let putLoadOrder = false;
    const requests: string[] = [];
    const fetch = routedFetch([
      ['/notifications/stream', () => Promise.resolve(openStreamResponse())],
      ['/load-order', () => { putLoadOrder = true; return putAnswered.then(() => jsonResponse(200, { applied: true, version: 1 })); }],
      [route, (req) => { requests.push(new URL(req.url).pathname); return Promise.resolve(jsonResponse(200, {})); }],
    ]);
    const client = makeClient(fetch);
    await client.start();
    void client.sendLoadOrder(EMPTY_SNAPSHOT);
    await vi.waitFor(() => expect(putLoadOrder).toBe(true));

    const asking = reading(client);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toEqual([]);

    answerPut();
    await asking;
    expect(requests).toHaveLength(1);
  });

  it('hands one document as a PUT of its path, text and version, opened the first time, and its close as a DELETE of its path', async () => {
    const requests: string[] = [];
    const answerAndNote = async (req: Request) => {
      requests.push(`${req.method} ${new URL(req.url).pathname}${new URL(req.url).search} ${await req.text()}`);
      return new Response(null, { status: 204 });
    };
    const fetch = routedFetch([
      ['/notifications/stream', () => Promise.resolve(openStreamResponse())],
      ['/unsaved-document', answerAndNote],
    ]);
    const client = makeClient(fetch);
    await client.start();

    client.handUnsavedDocument({ path: '/m/Npc.json', text: '{}', version: 3 });
    client.handUnsavedDocument({ path: '/m/Npc.json', closed: true });

    await vi.waitFor(() => { expect(requests).toEqual([
      'PUT /unsaved-document {"path":"/m/Npc.json","text":"{}","version":3,"opened":true}',
      'DELETE /unsaved-document?path=%2Fm%2FNpc.json ',
    ]); });
  });

  it('answers a refused hand-over as a WriteRefused carrying mEdit\'s reason', async () => {
    const fetch = routedFetch([
      ['/notifications/stream', () => Promise.resolve(openStreamResponse())],
      ['/unsaved-document', () => Promise.resolve(jsonResponse(400, { detail: 'Not plugin source.' }))],
    ]);
    const client = makeClient(fetch);
    const settled = vi.fn();
    client.onUnsavedHandOver(settled);
    await client.start();

    client.handUnsavedDocument({ path: '/m/plugin-source/MyPatch.esp/Npc.json', text: '{}', version: 1 });

    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith({ refused: true, message: 'mEdit could not take the unsaved plugin source — Not plugin source.' }));
  });

  it('leaves a hand-over to finish however long it takes, as a write is never timed', async () => {
    let answerHandOver!: () => void;
    const answered = new Promise<void>((resolve) => { answerHandOver = resolve; });
    const handedOver = vi.fn();
    const fetch = routedFetch([
      ['/notifications/stream', () => Promise.resolve(openStreamResponse())],
      ['/unsaved-document', () => { handedOver(); return answered.then(() => new Response(null, { status: 204 })); }],
    ]);
    vi.useFakeTimers();
    try {
      const client = makeClient(fetch, { timeoutMs: 20 });
      const settled = vi.fn();
      client.onUnsavedHandOver(settled);
      await client.start();
      client.handUnsavedDocument({ path: '/m/plugin-source/MyPatch.esp/Npc.json', text: '{}', version: 1 });

      await vi.advanceTimersByTimeAsync(60);
      expect(handedOver).toHaveBeenCalled();
      expect(settled).not.toHaveBeenCalled();

      answerHandOver();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toHaveBeenCalledWith(undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers a thrown request as an unknown refusal in the words for it, never fetch\'s text', async () => {
    const client = makeClient(vi.fn(() => Promise.reject(new Error('fetch failed'))));

    expect(await client.getEditChanges(record.formKey, plugin, envelope)).toEqual({ applied: false, refusal: 'Unknown', message: 'mEdit could not be reached.' });
  });

});

describe('HttpMEditClient — a read whose token is cancelled', () => {
  const cancelled = { failed: 'local', cause: 'The read was cancelled.' };

  it('is never sent when it is cancelled while it is held', async () => {
    let answerHandOver!: () => void;
    const handedOver = new Promise<void>((resolve) => { answerHandOver = resolve; });
    const requests: string[] = [];
    const fetch = routedFetch([
      ['/notifications/stream', () => Promise.resolve(openStreamResponse())],
      ['/unsaved-document', () => handedOver.then(() => new Response(null, { status: 204 }))],
      ['/plugins', (req) => { requests.push(req.url); return Promise.resolve(jsonResponse(200, [])); }],
    ]);
    const client = makeClient(fetch);
    await client.start();
    client.handUnsavedDocument({ path: '/m/plugin-source/MyPatch.esp/Npc.json', text: '{}', version: 1 });
    const { token: held, cancel } = cancellableToken();

    const asking = client.getPlugins(undefined, held);
    cancel();
    expect(await asking).toEqual(cancelled);

    answerHandOver();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toEqual([]);
  });

  it('is aborted when it is cancelled in flight, and logs no failure', async () => {
    let aborted = false;
    let sent = false;
    const fetch = routedFetch([
      ['/notifications/stream', () => Promise.resolve(openStreamResponse())],
      ['/unsaved-document', noContent],
      ['/load-order/status', () => Promise.resolve(jsonResponse(200, loadOrderStatusEventFixture().loadOrderStatus))],
      ['/load-order/sequence', () => Promise.resolve(jsonResponse(200, 0))],
      ['/plugins', (req) => new Promise<Response>((_resolve, reject) => {
        sent = true;
        req.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
      })],
    ]);
    const log = fakeLogChannel();
    const client = makeClient(fetch, { log });
    await client.start();
    const { token: flying, cancel } = cancellableToken();

    const asking = client.getPlugins(undefined, flying);
    await vi.waitFor(() => expect(sent).toBe(true));
    cancel();

    expect(await asking).toEqual(cancelled);
    expect(aborted).toBe(true);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('stops watching the token once it has answered', async () => {
    const fetch = routedFetch([
      ['/notifications/stream', () => Promise.resolve(openStreamResponse())],
      ['/plugins', () => Promise.resolve(jsonResponse(200, []))],
    ]);
    const client = makeClient(fetch);
    await client.start();
    const { token: answered, unsubscribed } = cancellableToken();

    await client.getPlugins(undefined, answered);

    expect(unsubscribed).toHaveBeenCalledOnce();
  });

  it('aborts the rows still streaming, when it is cancelled after their headers arrived', async () => {
    let aborted = false;
    let sentRow = false;
    const fetch = routedFetch([
      ['/notifications/stream', () => Promise.resolve(openStreamResponse())],
      ['/unsaved-document', noContent],
      ['/load-order/status', () => Promise.resolve(jsonResponse(200, loadOrderStatusEventFixture().loadOrderStatus))],
      ['/load-order/sequence', () => Promise.resolve(jsonResponse(200, 0))],
      ['/records/select', (req) => {
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ row: { n: 1 } })}\n`));
            sentRow = true;
            req.signal.addEventListener('abort', () => { aborted = true; controller.error(new Error('aborted')); });
          },
        });
        return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } }));
      }],
    ]);
    const log = fakeLogChannel();
    const client = makeClient(fetch, { log });
    await client.start();
    const { token: streaming, cancel } = cancellableToken();

    const asking = client.selectRows('SELECT 1', 1000, streaming);
    await vi.waitFor(() => expect(sentRow).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    cancel();

    expect(await asking).toEqual(cancelled);
    expect(aborted).toBe(true);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('is not sent when it is cancelled already', async () => {
    const requests: string[] = [];
    const fetch = routedFetch([
      ['/notifications/stream', () => Promise.resolve(openStreamResponse())],
      ['/plugins', (req) => { requests.push(req.url); return Promise.resolve(jsonResponse(200, [])); }],
    ]);
    const client = makeClient(fetch);
    await client.start();

    const answer = await client.getPlugins(undefined, { isCancellationRequested: true, onCancellationRequested: () => ({ dispose: () => undefined }) });

    expect(answer).toEqual(cancelled);
    expect(requests).toEqual([]);
  });
});

describe('HttpMEditClient — whether the record index may be late', () => {
  it('is true from a snapshot handed until its load order has settled', async () => {
    const { response, push } = pushableStreamResponse();
    let answerPut!: () => void;
    const putAnswered = new Promise<void>((resolve) => { answerPut = resolve; });
    const fetch = routedFetch([
      ['/notifications/stream', () => Promise.resolve(response)],
      ['/unsaved-document', noContent],
      ['/load-order/status', () => Promise.resolve(jsonResponse(200, loadOrderStatusEventFixture({ state: 'None', conflictsComputed: false }).loadOrderStatus))],
      ['/load-order', () => putAnswered.then(() => jsonResponse(200, { applied: true, version: 1 }))],
    ]);
    const client = makeClient(fetch);
    await client.start();
    await vi.waitFor(() => { expect(client.recordIndexMayBeLate).toBe(false); });

    void client.sendLoadOrder(EMPTY_SNAPSHOT);
    expect(client.recordIndexMayBeLate).toBe(true);

    answerPut();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.recordIndexMayBeLate).toBe(true);

    push(readyTickThatSettlesPutLoadOrder());
    await vi.waitFor(() => { expect(client.recordIndexMayBeLate).toBe(false); });
  });

  describe('the promise a change signal returns', () => {
    async function signalling() {
      const { response, push } = pushableStreamResponse();
      let status: NonNullable<Parameters<typeof loadOrderStatusEventFixture>[0]> = {};
      const fetch = routedFetch([
        ['/notifications/stream', () => Promise.resolve(response)],
        ['/signal-change', () => { status = { validating: true }; return noContent(); }],
        ['/load-order/status', () => Promise.resolve(jsonResponse(200, loadOrderStatusEventFixture(status).loadOrderStatus))],
      ]);
      const client = makeClient(fetch);
      await client.start();
      await vi.waitFor(() => { expect(client.recordIndexMayBeLate).toBe(false); });
      return { client, push };
    }

    it('settles when the sweep the check started has settled, not when the signal is answered', async () => {
      const { client, push } = await signalling();
      let settled = false;

      const signalled = client.signalChange([]).then(() => { settled = true; });
      await vi.waitFor(() => { expect(client.recordIndexMayBeLate).toBe(true); });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);

      push(loadOrderStatusTick({ conflictsComputed: true, validating: false }));
      await signalled;
      expect(settled).toBe(true);
    });
  });

  describe('whether the client has heard every change mEdit has made', () => {
    const rowsTick = (sequence: number) => new TextEncoder().encode(`data: ${JSON.stringify({
      kind: 'rows-changed', plugin: 'A.esp', origin: 'Mod', keys: ['0001:A.esp'], sequence,
    })}\n\n`);

    async function hearing(mEditSequence: () => number) {
      const { response, push } = pushableStreamResponse();
      const fetch = routedFetch([
        ['/notifications/stream', () => Promise.resolve(response)],
        ['/load-order/sequence', () => Promise.resolve(jsonResponse(200, mEditSequence()))],
      ]);
      const client = makeClient(fetch);
      await client.start();
      await vi.waitFor(() => { expect(client.recordIndexMayBeLate).toBe(false); });
      return { client, push };
    }

    it('is not while mEdit has advanced past the last sequence a notification carried', async () => {
      let sequence = 3;
      const { client, push } = await hearing(() => sequence);
      await client.refreshRecordIndexLateness();
      expect(client.recordIndexMayBeLate).toBe(false);

      sequence = 5;
      push(rowsTick(4));
      await vi.waitFor(async () => { await client.refreshRecordIndexLateness(); expect(client.recordIndexMayBeLate).toBe(true); });
      push(rowsTick(5));
      await vi.waitFor(() => { expect(client.recordIndexMayBeLate).toBe(false); });
    });

    it('hears a process it reconnects to from where that process stands', async () => {
      let sequence = 3;
      const { streams, open } = reopeningStreams();
      const fetch = routedFetch([
        ['/notifications/stream', () => open()],
        ['/load-order/sequence', () => Promise.resolve(jsonResponse(200, sequence))],
      ]);
      const client = makeClient(fetch, { reconnectDelayMs: 1 });
      await client.start();
      await vi.waitFor(() => { expect(streams).toHaveLength(1); });
      await client.refreshRecordIndexLateness();

      sequence = 7;
      streams[0]?.end();
      await vi.waitFor(() => { expect(streams).toHaveLength(2); });

      await vi.waitFor(async () => { await client.refreshRecordIndexLateness(); expect(client.recordIndexMayBeLate).toBe(false); });
    });
  });

  describe('the event of the lateness changing', () => {
    it('tells true when a signal starts a sweep and false when the sweep settles, once each', async () => {
      const { response, push } = pushableStreamResponse();
      let status: NonNullable<Parameters<typeof loadOrderStatusEventFixture>[0]> = {};
      const fetch = routedFetch([
        ['/notifications/stream', () => Promise.resolve(response)],
        ['/signal-change', () => { status = { validating: true }; return noContent(); }],
        ['/load-order/status', () => Promise.resolve(jsonResponse(200, loadOrderStatusEventFixture(status).loadOrderStatus))],
      ]);
      const client = makeClient(fetch);
      await client.start();
      await vi.waitFor(() => { expect(client.recordIndexMayBeLate).toBe(false); });
      const told: boolean[] = [];
      client.onDidChangeRecordIndexMayBeLate((late) => { told.push(late); });

      const signalled = client.signalChange(['/m/Foo.esp']);
      await vi.waitFor(() => { expect(told).toEqual([true]); });
      push(loadOrderStatusTick({ conflictsComputed: true, validating: false }));
      await signalled;

      expect(told).toEqual([true, false]);
    });
  });

  describe('a rebuild of the record index', () => {
    async function rebuilding(holdingALoadOrder: boolean) {
      const { response, push } = pushableStreamResponse();
      let status: NonNullable<Parameters<typeof loadOrderStatusEventFixture>[0]> = { state: 'None', conflictsComputed: false };
      const fetch = routedFetch([
        ['/notifications/stream', () => Promise.resolve(response)],
        ['/index/rebuild', () => { status = { state: 'None', conflictsComputed: false }; return noContent(); }],
        ['/load-order/status', () => Promise.resolve(jsonResponse(200, loadOrderStatusEventFixture(status).loadOrderStatus))],
      ]);
      const client = makeClient(fetch);
      await client.start();
      if (holdingALoadOrder) push(readyTickThatSettlesPutLoadOrder());
      await vi.waitFor(() => { expect(client.recordIndexMayBeLate).toBe(false); });
      if (holdingALoadOrder) await vi.waitFor(() => { expect(client.recordIndexProgress).toBeDefined(); });
      return { client, push };
    }

    it('is late until the refill it starts settles', async () => {
      const { client, push } = await rebuilding(true);

      await expect(client.rebuildIndex('/instance', 'Fallout4')).resolves.toEqual({ rebuilt: true });
      expect(client.recordIndexMayBeLate).toBe(true);

      push(loadOrderStatusTick({ conflictsComputed: true, validating: false, version: 1 }));
      await vi.waitFor(() => { expect(client.recordIndexMayBeLate).toBe(false); });
    });

    it('is not late when mEdit holds no load order to refill', async () => {
      const { client } = await rebuilding(false);

      await client.rebuildIndex('/instance', 'Fallout4');

      expect(client.recordIndexMayBeLate).toBe(false);
    });
  });

  it('is true from unsaved documents handed until their PUT is answered and the status shows nothing validating', async () => {
    let puts = 0;
    let answerPut!: () => void;
    const putAnswered = new Promise<void>((resolve) => { answerPut = resolve; });
    const fetch = routedFetch([
      ['/notifications/stream', () => Promise.resolve(openStreamResponse())],
      ['/unsaved-document', () => (puts++ === 0 ? noContent() : putAnswered.then(() => new Response(null, { status: 204 })))],
      ['/load-order/status', () => Promise.resolve(jsonResponse(200, loadOrderStatusEventFixture().loadOrderStatus))],
    ]);
    const client = makeClient(fetch);
    await client.start();
    await vi.waitFor(() => { expect(client.recordIndexMayBeLate).toBe(false); });

    client.handUnsavedDocument({ path: '/m/plugin-source/MyPatch.esp/Npc.json', text: '{}', version: 1 });
    expect(client.recordIndexMayBeLate).toBe(true);

    answerPut();
    await vi.waitFor(() => { expect(client.recordIndexMayBeLate).toBe(false); });
  });

  describe.each<[string, (client: MEditClient) => void]>([
    ['a change signal', (client) => { void client.signalChange(['/m/Foo.esp']); }],
    ['unsaved documents', (client) => { client.handUnsavedDocument({ path: '/m/plugin-source/MyPatch.esp/Npc.json', text: '{}', version: 1 }); }],
  ])('after %s are answered', (_what, hand) => {
    async function started() {
      const { response, push } = pushableStreamResponse();
      let status: NonNullable<Parameters<typeof loadOrderStatusEventFixture>[0]> = {};
      let statusWhenAnswered: typeof status = {};
      let statusFails = false;
      let statusReads = 0;
      const answerHand = () => { status = statusWhenAnswered; return noContent(); };
      const fetch = routedFetch([
        ['/notifications/stream', () => Promise.resolve(response)],
        ['/unsaved-document', answerHand],
        ['/signal-change', answerHand],
        ['/load-order/status', () => {
          statusReads++;
          return Promise.resolve(statusFails ? new Response(null, { status: 500 }) : jsonResponse(200, loadOrderStatusEventFixture(status).loadOrderStatus));
        }],
      ]);
      const client = makeClient(fetch);
      await client.start();
      await vi.waitFor(() => { expect(client.recordIndexMayBeLate).toBe(false); });
      return {
        client, push,
        hand: async (answeredWith: typeof status, failing = false) => {
          statusWhenAnswered = answeredWith;
          statusFails = failing;
          const reads = statusReads;
          hand(client);
          await vi.waitFor(() => { expect(statusReads).toBeGreaterThan(reads); });
        },
      };
    }

    it('stays true until the sweep it started has settled', async () => {
      const { client, push, hand: handOver } = await started();

      await handOver({ validating: true });
      expect(client.recordIndexMayBeLate).toBe(true);

      push(loadOrderStatusTick({ conflictsComputed: true, validating: false }));
      await vi.waitFor(() => { expect(client.recordIndexMayBeLate).toBe(false); });
    });

    it('is false when mEdit has nothing validating', async () => {
      const { client, hand: handOver } = await started();

      await handOver({ validating: false });

      await vi.waitFor(() => { expect(client.recordIndexMayBeLate).toBe(false); });
    });

    it('is false when mEdit holds no load order, as nothing is then late', async () => {
      const { client, hand: handOver } = await started();

      await handOver({ state: 'None', conflictsComputed: false });

      await vi.waitFor(() => { expect(client.recordIndexMayBeLate).toBe(false); });
    });

    it('keeps waiting on the stream when the status cannot be read', async () => {
      const { client, push, hand: handOver } = await started();

      await handOver({ validating: true }, true);
      expect(client.recordIndexMayBeLate).toBe(true);

      push(loadOrderStatusTick({ conflictsComputed: true, validating: false }));
      await vi.waitFor(() => { expect(client.recordIndexMayBeLate).toBe(false); });
    });
  });
});
