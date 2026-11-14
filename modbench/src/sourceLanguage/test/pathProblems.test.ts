import { describe, it, expect, vi } from 'vitest';
import { problemsAsker } from '../../drivingLib/problemsAsker';
import { feedPathProblems, type PathStanding } from '../pathProblems';
import type { ProblemsByFile } from '../sourceProblems';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { recordingReporter } from '../../test/surfacingDoubles';
import type { PluginFilePaths } from '../../client';
import { loadOrderStatusEventFixture } from '../../client/test/fixtures';
import type { NotificationEvent } from '../../client/apiClient';
import type { SourceFilesOf } from '../../instanceLoader/loadOrderSnapshot';

const HOLDER = '000800:Names.esp';
const PLUGIN = { name: 'Names.esp', origin: 'NamingMod' };
const OTHER = { name: 'Other.esp', origin: 'OtherMod' };
const FILE = '/source/NamingMod/Names.esp/TextureSet.json';
const TEXT = `{ "FormKey": "${HOLDER}", "Diffuse": "Decals\\\\Stain_d.dds" }`;
const SPAN = { start: TEXT.indexOf('Decals'), end: TEXT.indexOf('.dds') + 4 };
const DATA_PATH = 'Textures/Decals/Stain_d.dds';

const named = (dataPath = DATA_PATH, over: Partial<PluginFilePaths['paths'][number]> = {}): PluginFilePaths['paths'][number] =>
  ({ formKey: HOLDER, fieldPath: 'Diffuse', sourceRelativePath: 'Names.esp/TextureSet.json', dataPath, ...over });
const answerFor = (plugin = PLUGIN, paths = [named()], over: Partial<PluginFilePaths> = {}): PluginFilePaths => ({ plugin, paths, scripts: [], unread: [], ...over });

const sourceFolders: SourceFilesOf = (origin) => ({ file: (relativePath) => `/source/${origin}/${relativePath}` });

function feed(answer: PluginFilePaths[], standing: Partial<PathStanding> = {}) {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getPluginFilePaths', answer);
  const published: ProblemsByFile[] = [];
  const reporter = recordingReporter();
  const status: (string | undefined)[] = [];
  const listeners = new Set<() => void>();
  const paths: PathStanding = {
    judged: () => true, holds: () => false,
    subscribe: (listener: () => void) => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
    ...standing,
  };
  feedPathProblems({
    client, ask: problemsAsker(client), sourceFiles: sourceFolders, readText: () => Promise.resolve(TEXT), reporter, paths,
    publish: (problems) => published.push(problems), languageStatus: (text) => status.push(text),
  });
  const latest = () => published[published.length - 1] ?? new Map();
  const settled = async (count: number) => { await vi.waitFor(() => { expect(published.length).toBeGreaterThanOrEqual(count); }); return latest(); };
  return { client, reporter, published, status, latest, settled, instanceChanged: () => { for (const listener of listeners) listener(); } };
}

const asked = (client: InMemoryMEditClient) => client.calls.filter((call) => call.method === 'getPluginFilePaths').map((call) => call.args);

describe('feedPathProblems (source.md, Editing plugin source, story 1)', () => {
  it('puts a path that no file the game gets and no file its mod holds names on the path itself', async () => {
    const { settled } = feed([answerFor()]);

    expect(await settled(1)).toEqual(new Map([[FILE, [{ message: `"${DATA_PATH}" names no file the game gets or ${PLUGIN.origin} holds.`, start: { line: 0, character: SPAN.start }, end: { line: 0, character: SPAN.end } }]]]));
  });

  it.each([
    ['a file the game gets', { holds: (_plugin: unknown, path: string) => path === DATA_PATH }],
    ['a file its plugin\'s mod holds', { holds: (plugin: { origin: string }) => plugin.origin === PLUGIN.origin }],
  ])('puts nothing on a path that names %s', async (_what, standing) => {
    const { settled } = feed([answerFor()], standing);

    expect(await settled(1)).toEqual(new Map());
  });

  it('judges no path while the game gets files from outside the workspace', async () => {
    const { settled } = feed([answerFor()], { judged: () => false });

    expect(await settled(1)).toEqual(new Map());
  });

  it('judges again, without asking mEdit, when the instance changes', async () => {
    let held = false;
    const { settled, client, instanceChanged, published } = feed([answerFor()], { holds: () => held });
    await settled(1);

    held = true;
    instanceChanged();
    await vi.waitFor(() => { expect(published.length).toBe(2); });

    expect([published[1], asked(client)]).toEqual([new Map(), [[undefined]]]);
  });

  it('asks for the whole set at the start, and for the plugin only that a notification names', async () => {
    const { settled, client, published } = feed([answerFor(), answerFor(OTHER, [named(DATA_PATH, { sourceRelativePath: 'Other.esp/Set.json' })])]);
    await settled(1);
    client.setQueryAnswer('getPluginFilePaths', [answerFor(PLUGIN, [])]);

    client.emit({ kind: 'plugin-changed', plugin: PLUGIN.name, origin: PLUGIN.origin, keys: [], sequence: 1 });
    await vi.waitFor(() => { expect(published.length).toBe(2); });

    expect([asked(client), [...published[1]?.keys() ?? []]]).toEqual([[[undefined], [PLUGIN]], ['/source/OtherMod/Other.esp/Set.json']]);
  });

  it('drops a plugin that a whole-set answer leaves out', async () => {
    const { settled, client, published } = feed([answerFor(), answerFor(OTHER, [named(DATA_PATH, { sourceRelativePath: 'Other.esp/Set.json' })])]);
    await settled(1);
    client.setQueryAnswer('getPluginFilePaths', [answerFor()]);

    client.emit(loadOrderStatusEventFixture({ state: 'Reconciling', conflictsComputed: false, version: 2 }));
    client.emit(loadOrderStatusEventFixture({ state: 'Ready', conflictsComputed: true, version: 3 }));
    await vi.waitFor(() => { expect(published.length).toBe(2); });

    expect([...published[1]?.keys() ?? []]).toEqual([FILE]);
  });

  it('shows each line mEdit could not read and each failure, and still judges the paths it answered', async () => {
    const { settled, reporter, status } = feed([answerFor(PLUGIN, [named()], { unread: ['000801:Names.esp: no schema', 'TextureSet.json: stopped'], failure: 'the source is unreadable' })]);

    const problems = await settled(1);

    expect([problems.size, reporter.shownFailures.map(({ detail }) => detail), status.at(-1)]).toEqual([
      1, ['000801:Names.esp: no schema', 'TextureSet.json: stopped', 'the source is unreadable'], expect.stringContaining('the source is unreadable'),
    ]);
  });

  it('keeps the problems it last had, and says so, when mEdit cannot answer', async () => {
    const { settled, client, status, published } = feed([answerFor()]);
    await settled(1);
    client.setQueryFailureOnce('getPluginFilePaths', { failed: 'timed-out' });

    client.emit({ kind: 'plugin-changed', plugin: PLUGIN.name, origin: PLUGIN.origin, keys: [], sequence: 1 });
    await vi.waitFor(() => { expect(status.at(-1)).toContain('mEdit did not answer in time.'); });

    expect(published).toHaveLength(1);
  });

  it('asks once for a plugin that several notifications of one turn name', async () => {
    const { settled, client } = feed([answerFor()]);
    await settled(1);

    for (const kind of ['rows-changed', 'plugin-changed', 'rows-changed'] as const) client.emit({ kind, plugin: PLUGIN.name, origin: PLUGIN.origin, keys: [], sequence: 1 });
    await vi.waitFor(() => { expect(asked(client)).toHaveLength(2); });
    await Promise.resolve();

    expect(asked(client)).toEqual([[undefined], [PLUGIN]]);
  });

  it('drops a plugin that a notification names and mEdit answers no entry for', async () => {
    const { settled, client } = feed([answerFor()]);
    await settled(1);
    client.setQueryAnswer('getPluginFilePaths', []);

    client.emit({ kind: 'plugin-changed', plugin: PLUGIN.name, origin: PLUGIN.origin, keys: [], sequence: 1 });

    expect(await settled(2)).toEqual(new Map());
  });

  it('asks again after a read that timed out, and publishes its answer', async () => {
    const { settled, client } = feed([answerFor()]);
    await settled(1);
    client.setQueryFailureOnce('getPluginFilePaths', { failed: 'timed-out' });
    client.emit({ kind: 'plugin-changed', plugin: PLUGIN.name, origin: PLUGIN.origin, keys: [], sequence: 1 });
    await vi.waitFor(() => { expect(asked(client)).toHaveLength(2); });
    client.setQueryAnswer('getPluginFilePaths', [answerFor(PLUGIN, [])]);

    client.emit({ kind: 'plugin-changed', plugin: PLUGIN.name, origin: PLUGIN.origin, keys: [], sequence: 2 });

    expect(await settled(2)).toEqual(new Map());
  });

  it('places against the text of the plugin\'s next answer, which an unsaved edit brings with its notification', async () => {
    let text = TEXT;
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPluginFilePaths', [answerFor()]);
    const published: ProblemsByFile[] = [];
    feedPathProblems({
      client, ask: problemsAsker(client), sourceFiles: sourceFolders, readText: () => Promise.resolve(text), reporter: recordingReporter(),
      paths: { judged: () => true, holds: () => false, subscribe: () => ({ dispose: () => undefined }) },
      publish: (problems) => published.push(problems), languageStatus: () => undefined,
    });
    await vi.waitFor(() => { expect(published).toHaveLength(1); });
    text = `  ${TEXT}`;

    client.emit({ kind: 'plugin-changed', plugin: PLUGIN.name, origin: PLUGIN.origin, keys: [], sequence: 1 });
    await vi.waitFor(() => { expect(published).toHaveLength(2); });

    expect(published[1]?.get(FILE)?.[0]?.start.character).toBe(SPAN.start + 2);
  });

  it('keeps one ask in flight and at most one pending, however many notifications arrive meanwhile', async () => {
    const { settled, client } = feed([answerFor()]);
    await settled(1);
    let answerFirst!: (answer: PluginFilePaths[]) => void;
    client.setQueryAnswerOnce('getPluginFilePaths', new Promise<PluginFilePaths[]>((resolve) => { answerFirst = resolve; }));
    const named = (sequence: number): NotificationEvent => ({ kind: 'plugin-changed', plugin: PLUGIN.name, origin: PLUGIN.origin, keys: [], sequence });
    client.emit(named(1));
    await vi.waitFor(() => { expect(asked(client)).toHaveLength(2); });

    for (let sequence = 2; sequence < 6; sequence += 1) client.emit(named(sequence));
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(asked(client)).toHaveLength(2);

    answerFirst([answerFor()]);
    await vi.waitFor(() => { expect(asked(client)).toHaveLength(3); });
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    expect(asked(client)).toHaveLength(3);
  });

  it('reads a file once for an answer, however often the instance changes', async () => {
    const reads: string[] = [];
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPluginFilePaths', [answerFor()]);
    const listeners = new Set<() => void>();
    const published: ProblemsByFile[] = [];
    feedPathProblems({
      client, ask: problemsAsker(client), sourceFiles: sourceFolders, readText: (path) => { reads.push(path); return Promise.resolve(TEXT); }, reporter: recordingReporter(),
      paths: { judged: () => true, holds: () => false, subscribe: (listener) => { listeners.add(listener); return { dispose: () => undefined }; } },
      publish: (problems) => published.push(problems), languageStatus: () => undefined,
    });
    await vi.waitFor(() => { expect(published).toHaveLength(1); });

    for (const listener of listeners) listener();
    await vi.waitFor(() => { expect(published).toHaveLength(2); });

    expect(reads).toEqual([FILE]);
  });

  it('does not ask before the load order settles', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPluginFilePaths', [answerFor()]);
    client.emit(loadOrderStatusEventFixture({ state: 'Reconciling', conflictsComputed: false, version: 1 }));
    feedPathProblems({
      client, ask: problemsAsker(client), sourceFiles: sourceFolders, readText: () => Promise.resolve(TEXT), reporter: recordingReporter(),
      paths: { judged: () => true, holds: () => false, subscribe: () => ({ dispose: () => undefined }) }, publish: () => undefined, languageStatus: () => undefined,
    });
    client.emit({ kind: 'plugin-changed', plugin: PLUGIN.name, origin: PLUGIN.origin, keys: [], sequence: 1 });
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    expect(asked(client)).toEqual([[undefined]]);
  });
});
