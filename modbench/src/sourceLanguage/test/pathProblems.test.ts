import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { document, host } from './vscodeHost';
import { PATHS_STATUS, pathStandingOf, sourceLanguageOver } from './sourceLanguageOver';
import type { PathStanding } from '../pathProblems';
import type { FilesChanged } from '../../instanceLoader/filesChanged';
import { fileIn } from '../../test/fakeInstanceAdapter';
import type { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { PluginFilePaths } from '../../client';
import { holdsLoadOrder, changeNamesPlugin } from '../../client/test/says';
import { settled as until } from '../../test/eventually';

const changedIn = (name: string, relativePath: string): FilesChanged => {
  const files = [fileIn(`/mods/${name}`, relativePath)];
  return [{ origin: { kind: 'mod', name }, files, gained: files }];
};

const RETRY_AFTER_MS = 1000;
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

function feed(answer: PluginFilePaths[], standing: Partial<PathStanding> = {}, text: string | (() => Promise<string>) = TEXT) {
  const paths = pathStandingOf(standing);
  const made = sourceLanguageOver({
    pathStanding: paths.standing,
    arrange: (client) => { client.setQueryAnswer('getPluginFilePaths', answer); host.files.set(FILE, text); },
  });
  return { ...made, status: () => host.status(PATHS_STATUS), instanceChanged: paths.changed, asked: () => asked(made.client) };
}

const asked = (client: InMemoryMEditClient) => client.calls.filter((call) => call.method === 'getPluginFilePaths').map((call) => call.args.slice(0, 1));
const keysAsked = (client: InMemoryMEditClient) => client.calls.filter((call) => call.method === 'getPluginFilePaths').map((call) => call.args[2]);

afterEach(() => { vi.useRealTimers(); });

describe('the paths a plugin source names that nothing answers, in the Problems panel (source.md, Editing plugin source, story 1)', () => {
  it('puts a path that no file the game gets and no file its mod holds names on the path itself', async () => {
    const { problems } = feed([answerFor()]);

    expect(await problems()).toEqual(new Map([[FILE, [{ message: `"${DATA_PATH}" names no file the game gets or ${PLUGIN.origin} holds.`, start: { line: 0, character: SPAN.start }, end: { line: 0, character: SPAN.end } }]]]));
  });

  it.each([
    ['a file the game gets', { holds: (_plugin: unknown, path: string) => path === DATA_PATH }],
    ['a file its plugin\'s mod holds', { holds: (plugin: { origin: string }) => plugin.origin === PLUGIN.origin }],
  ])('puts nothing on a path that names %s', async (_what, standing) => {
    const { problems } = feed([answerFor()], standing);

    expect(await problems()).toEqual(new Map());
  });

  it('judges no path while the game gets files from outside the workspace', async () => {
    const { problems } = feed([answerFor()], { judged: () => false });

    expect(await problems()).toEqual(new Map());
  });

  it('places a path in the text of the file\'s unsaved document, which VS Code holds over the file on disk', async () => {
    const { problems } = feed([answerFor()], {}, `  ${TEXT}`);
    host.holds([document(FILE, TEXT)]);

    expect((await problems()).get(FILE)?.[0]?.start.character).toBe(SPAN.start);
  });

  it('judges again, without asking mEdit, when the instance changes', async () => {
    let held = false;
    const { problems, client, instanceChanged } = feed([answerFor()], { holds: () => held });
    await problems();

    held = true;
    instanceChanged();

    expect([await problems(), asked(client)]).toEqual([new Map(), [[undefined]]]);
  });

  it('judges again only the paths a change may answer otherwise', async () => {
    const judged: string[] = [];
    const other = named('Textures/Other.dds', { sourceRelativePath: 'Other.esp/Set.json' });
    const { problems, instanceChanged } = feed([answerFor(), answerFor(OTHER, [other])], { holds: (_plugin, path) => { judged.push(path); return false; } });
    await problems();
    judged.splice(0);

    instanceChanged(changedIn('Elsewhere', 'Textures/Other.dds'));
    await problems();

    expect(judged).toEqual(['Textures/Other.dds']);
  });

  it('judges again every path of a plugin whose own mod a change names', async () => {
    const judged: string[] = [];
    const other = named('Textures/Other.dds', { sourceRelativePath: 'Other.esp/Set.json' });
    const { problems, instanceChanged } = feed([answerFor(), answerFor(OTHER, [other])], { holds: (_plugin, path) => { judged.push(path); return false; } });
    await problems();
    judged.splice(0);

    instanceChanged(changedIn(PLUGIN.origin, 'Meshes/Unnamed.nif'));
    await problems();

    expect(judged).toEqual([DATA_PATH]);
  });

  it('keeps no judgement a later change reached before it ended', async () => {
    let held = true;
    let release: (text: string) => void = () => undefined;
    const stalled = new Promise<string>((resolve) => { release = resolve; });
    const { problems, instanceChanged } = feed([answerFor()], { holds: () => held }, () => stalled);
    await problems();
    held = false;
    instanceChanged(changedIn(PLUGIN.origin, 'a.nif'));
    held = true;
    instanceChanged(changedIn(PLUGIN.origin, 'a.nif'));
    release(TEXT);
    await problems();

    instanceChanged(changedIn('Elsewhere', 'b.nif'));

    expect(await problems()).toEqual(new Map());
  });

  it('asks for the whole set at the start, and for the plugin only that a notification names', async () => {
    const { problems, client } = feed([answerFor(), answerFor(OTHER, [named(DATA_PATH, { sourceRelativePath: 'Other.esp/Set.json' })])]);
    await problems();
    client.setQueryAnswer('getPluginFilePaths', [answerFor(PLUGIN, [])]);

    changeNamesPlugin(client, { name: PLUGIN.name, origin: PLUGIN.origin });

    expect([...(await problems()).keys()]).toEqual(['/source/OtherMod/Other.esp/Set.json']);
    expect(asked(client)).toEqual([[undefined], [PLUGIN]]);
  });

  it('drops a plugin that a whole-set answer leaves out', async () => {
    const { problems, client } = feed([answerFor(), answerFor(OTHER, [named(DATA_PATH, { sourceRelativePath: 'Other.esp/Set.json' })])]);
    await problems();
    client.setQueryAnswer('getPluginFilePaths', [answerFor()]);

    holdsLoadOrder(client, { settled: false, version: 2 });
    holdsLoadOrder(client, { version: 3 });

    expect([...(await problems()).keys()]).toEqual([FILE]);
  });

  it('shows each line mEdit could not read and each failure, and still judges the paths it answered', async () => {
    const { problems, reporter, status } = feed([answerFor(PLUGIN, [named()], { unread: ['000801:Names.esp: no schema', 'TextureSet.json: stopped'], failure: 'the source is unreadable' })]);

    const shown = await problems();

    expect([shown.size, reporter.shownFailures.map(({ detail }) => detail), status()]).toEqual([
      1, ['000801:Names.esp: no schema', 'TextureSet.json: stopped', 'the source is unreadable'], expect.stringContaining('the source is unreadable'),
    ]);
  });

  it('keeps the problems it last had, and says so, when mEdit cannot answer', async () => {
    const { problems, client, status } = feed([answerFor()]);
    await problems();
    client.setQueryFailureOnce('getPluginFilePaths', { failed: 'timed-out' });

    changeNamesPlugin(client, { name: PLUGIN.name, origin: PLUGIN.origin });

    expect([[...(await problems()).keys()], status()]).toEqual([[FILE], expect.stringContaining('mEdit did not answer in time.')]);
  });

  it('asks once for a plugin that several notifications of one turn name', async () => {
    const { problems, client } = feed([answerFor()]);
    await problems();

    [[], undefined, []].forEach((keys) => { client.change([{ plugin: { name: PLUGIN.name, origin: PLUGIN.origin }, ...(keys && { keys }) }]); });
    await problems();

    expect(asked(client)).toEqual([[undefined], [PLUGIN]]);
  });

  it('drops a plugin that a notification names and mEdit answers no entry for', async () => {
    const { problems, client } = feed([answerFor()]);
    await problems();
    client.setQueryAnswer('getPluginFilePaths', []);

    changeNamesPlugin(client, { name: PLUGIN.name, origin: PLUGIN.origin });

    expect(await problems()).toEqual(new Map());
  });

  it('asks again after a read that timed out, and publishes its answer', async () => {
    const { problems, client } = feed([answerFor()]);
    await problems();
    client.setQueryFailureOnce('getPluginFilePaths', { failed: 'timed-out' });
    changeNamesPlugin(client, { name: PLUGIN.name, origin: PLUGIN.origin });
    await problems();
    client.setQueryAnswer('getPluginFilePaths', [answerFor(PLUGIN, [])]);

    changeNamesPlugin(client, { name: PLUGIN.name, origin: PLUGIN.origin });

    expect(await problems()).toEqual(new Map());
  });

  it('places against the text of the plugin\'s next answer, which an unsaved edit brings with its notification', async () => {
    const { problems, client } = feed([answerFor()]);
    await problems();
    host.files.set(FILE, `  ${TEXT}`);
    client.setQueryAnswer('getPluginFilePaths', [answerFor()]);

    changeNamesPlugin(client, { name: PLUGIN.name, origin: PLUGIN.origin });

    expect((await problems()).get(FILE)?.[0]?.start.character).toBe(SPAN.start + 2);
  });

  it('is settled only once the judgement of a change is published', async () => {
    let releaseSecond: (text: string) => void = () => undefined;
    const texts = [Promise.resolve(TEXT), new Promise<string>((resolve) => { releaseSecond = resolve; })];
    const { problems, client, language } = feed([answerFor()], {}, () => texts.shift() ?? Promise.resolve(TEXT));
    await problems();
    client.setQueryAnswer('getPluginFilePaths', [answerFor()]);
    changeNamesPlugin(client, { name: PLUGIN.name, origin: PLUGIN.origin });

    let ended = false;
    const waiting = language.problemsCaughtUp().then(() => { ended = true; });
    await until(() => { expect(host.reads).toHaveLength(2); });
    expect(ended).toBe(false);
    releaseSecond(TEXT);
    await waiting;

    expect(host.problems('modbench-source').size).toBe(1);
  });

  it('keeps one ask in flight and at most one pending, however many notifications arrive meanwhile', async () => {
    const { problems, client } = feed([answerFor()]);
    await problems();
    let answerFirst!: (answer: PluginFilePaths[]) => void;
    client.setQueryAnswerOnce('getPluginFilePaths', new Promise<PluginFilePaths[]>((resolve) => { answerFirst = resolve; }));
    const notified = (sequence: number) => { client.hearSequence(sequence); client.change([{ plugin: { name: PLUGIN.name, origin: PLUGIN.origin } }]); };
    notified(1);
    await until(() => { expect(asked(client)).toHaveLength(2); });

    [2, 3, 4, 5].forEach(notified);
    answerFirst([answerFor()]);
    await problems();

    expect(asked(client)).toHaveLength(3);
  });

  it('reads a file once for an answer, however often the instance changes', async () => {
    const { problems, instanceChanged } = feed([answerFor()], { triedPaths: () => [] });
    await problems();

    instanceChanged('every');
    await problems();

    expect(host.reads).toEqual([FILE]);
  });

  it('asks only for the records a notification names, and for the whole plugin when it names none', async () => {
    const { problems, client } = feed([answerFor()]);
    await problems();

    changeNamesPlugin(client, { name: PLUGIN.name, origin: PLUGIN.origin }, [HOLDER]);
    await problems();
    changeNamesPlugin(client, { name: PLUGIN.name, origin: PLUGIN.origin });
    await problems();

    expect(keysAsked(client)).toEqual([undefined, [HOLDER], undefined]);
  });

  it('reads no file again when mEdit answers a plugin as it was', async () => {
    const { problems, client } = feed([answerFor()]);
    await problems();

    changeNamesPlugin(client, { name: PLUGIN.name, origin: PLUGIN.origin });
    await problems();

    expect([asked(client), host.reads]).toEqual([[[undefined], [PLUGIN]], [FILE]]);
  });

  describe.each([
    ['the whole set', (client: InMemoryMEditClient) => { holdsLoadOrder(client, { version: 2 }); }, undefined],
    ['a plugin', (client: InMemoryMEditClient) => { changeNamesPlugin(client, { name: PLUGIN.name, origin: PLUGIN.origin }); }, PLUGIN],
  ] as const)('an ask for %s that failed', (_what, trigger, target) => {
    const failedOnce = async () => {
      const made = feed([answerFor()]);
      await made.problems();
      vi.useFakeTimers();
      made.client.setQueryFailureOnce('getPluginFilePaths', { failed: 'timed-out' });
      trigger(made.client);
      await until(() => { expect(made.status()).toContain('mEdit did not answer in time.'); });
      return made;
    };

    it('is asked again after a delay, with no event between, and its answer is published', async () => {
      const { client, problems } = await failedOnce();
      client.setQueryAnswer('getPluginFilePaths', [answerFor(PLUGIN, [])]);

      const atOnce = asked(client).length;
      await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS);

      expect([atOnce, asked(client).at(-1), await problems()]).toEqual([2, [target], new Map()]);
    });

    it('says the panel shows the last good read until the retry is answered, then says nothing', async () => {
      const { client, status } = await failedOnce();
      const whileWaiting = status();
      client.setQueryAnswer('getPluginFilePaths', [answerFor()]);

      await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS);

      expect([whileWaiting, status()]).toEqual([expect.stringContaining('Showing the last good read'), undefined]);
    });
  });
});
