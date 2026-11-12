import { describe, it, expect, vi } from 'vitest';
import { feedPathProblems, type PathStanding } from '../pathProblems';
import type { ProblemsByFile } from '../sourceProblems';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { recordingReporter } from '../../test/surfacingDoubles';
import type { PluginFilePaths } from '../../client';
import { loadOrderStatusEventFixture } from '../../client/test/fixtures';
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
const answerFor = (plugin = PLUGIN, paths = [named()], over: Partial<PluginFilePaths> = {}): PluginFilePaths => ({ plugin, paths, unread: [], ...over });

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
    client, sourceFiles: sourceFolders, readText: () => Promise.resolve(TEXT), reporter, paths,
    publish: (problems) => published.push(problems), languageStatus: (text) => status.push(text),
  });
  const latest = () => published[published.length - 1] ?? new Map();
  const settled = async (count: number) => { await vi.waitFor(() => { expect(published.length).toBeGreaterThanOrEqual(count); }); return latest(); };
  return { client, reporter, published, status, latest, settled, instanceChanged: () => { for (const listener of listeners) listener(); } };
}

const asked = (client: InMemoryMEditClient) => client.calls.filter((call) => call.method === 'getPluginFilePaths').map((call) => call.args);

describe('feedPathProblems (source.md, In the text editor, story 6)', () => {
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

  it('does not ask before the load order settles', () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPluginFilePaths', [answerFor()]);
    client.emit(loadOrderStatusEventFixture({ state: 'Reconciling', conflictsComputed: false, version: 1 }));
    feedPathProblems({
      client, sourceFiles: sourceFolders, readText: () => Promise.resolve(TEXT), reporter: recordingReporter(),
      paths: { judged: () => true, holds: () => false, subscribe: () => ({ dispose: () => undefined }) }, publish: () => undefined, languageStatus: () => undefined,
    });
    client.emit({ kind: 'plugin-changed', plugin: PLUGIN.name, origin: PLUGIN.origin, keys: [], sequence: 1 });

    expect(asked(client)).toEqual([[undefined]]);
  });
});
