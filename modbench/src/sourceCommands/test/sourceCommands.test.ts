import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { fakeInstanceAdapter, modFoldersIn, readingFixture, sourceModsOf, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { sourceCommands } from '../sourceCommands';
import { isPluginSourcePath } from '../../instanceAdapter/instanceAdapter';
import { recordingTasks } from '../../test/recordingTasks';
import { manifestIn, writeBuildFileIn, type Manifest, type ManifestStep } from '../../manifestAdapter/manifestAdapter';
import { BUILD_FILE } from '../../wire/sourceMod';
import { readManifest } from '../../manifestAdapter/manifestRead';
import type { DecompileAndCommitMod } from '../../client';
import type { BuildMod } from '../../client/MEditClient';

let root: string;
let SOURCES: { ModA: string; ModB: string };

const buildFileOf = (output: string, over: Partial<Manifest> = {}): Manifest =>
  ({ packages: [], output, exclude: [], archives: [], steps: [], tools: [], files: [], ...over });

const folderOf = (mod: string): string => join(root, 'mods', mod);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'source-commands-'));
  SOURCES = { ModA: join(root, 'ModA'), ModB: join(root, 'Old ModB') };
  for (const [output, folder] of Object.entries(SOURCES)) {
    await mkdir(folder, { recursive: true });
    await mkdir(folderOf(output), { recursive: true });
    await writeBuildFileIn(folder, buildFileOf(output));
  }
});
afterEach(() => rm(root, { recursive: true, force: true }));

const fakeAdapter = (answers: InstanceAnswers = {}, gameRelease = 'Fallout4') =>
  fakeInstanceAdapter(readingFixture({
    gameRelease, modFolders: modFoldersIn(join(root, 'mods'), 'ModA'), sourceMods: sourceModsOf(SOURCES, [], [], { '/source/ModD': 'Other' }),
  }), answers).adapter;

const recorded = async (mod: string): Promise<Manifest | undefined> => {
  const read = await manifestIn(folderOf(mod));
  return read === undefined || 'refused' in read ? undefined : read.manifest;
};

const EXCLUSION_MARK = fakeInstanceAdapter().adapter.exclusionMark;
const savedAll = () => Promise.resolve([]);
const BA2 = { ba2: { version: 1, compressed: true } };

const builtOf = (mod: string) => ({ mod, compiled: [], refused: [], archivesRefused: [], overwritten: [], made: [] });
const landedOf = (mod: string) => ({ mod, compiled: [], refused: [], archivesRefused: [], overwritten: [] });
const buildingEach = (client: InMemoryMEditClient): void => {
  client.setCommandHandler('build', (mods: readonly BuildMod[]) => Promise.resolve({ landed: mods.map((mod) => builtOf(mod.name)), refused: [] }));
};

describe('sourceCommands build', () => {
  it('hands mEdit each mod with the source folder that builds it, its folder, what its build file excludes and packs, the exclusion mark and the release\'s archive variants', async () => {
    await writeBuildFileIn(SOURCES.ModA, buildFileOf('ModA', { exclude: ['b.dds'], archives: [{ path: 'ModA - Main.ba2', files: ['a.nif'] }] }));
    const client = new InMemoryMEditClient();
    buildingEach(client);

    await sourceCommands({ client, adapter: fakeAdapter(), saveUnsaved: savedAll, tasks: recordingTasks() }).build(['ModA', 'ModB']);

    const facts = { exclusionMark: EXCLUSION_MARK, archives: { general: BA2, textures: BA2 } };
    expect(client.calls).toEqual([
      { method: 'build', args: [[{ name: 'ModA', sourceFolder: SOURCES.ModA, folder: folderOf('ModA'), exclude: ['b.dds'], taken: [], archives: [{ path: 'ModA - Main.ba2', files: ['a.nif'] }] }], facts] },
      { method: 'build', args: [[{ name: 'ModB', sourceFolder: SOURCES.ModB, folder: folderOf('ModB'), exclude: [], taken: [], archives: [] }], facts] },
    ]);
  });

  it('saves each mod\'s source folder, and refuses a mod whose file VS Code leaves unsaved, naming the file, while the rest build', async () => {
    const client = new InMemoryMEditClient();
    buildingEach(client);
    const saved: string[] = [];
    const predicates: ((path: string) => boolean)[] = [];
    const saveUnsaved = (folder: string, isPluginSource: (path: string) => boolean) => {
      saved.push(folder);
      predicates.push(isPluginSource);
      return Promise.resolve(folder.endsWith('Old ModB') ? [`${folder}/plugin-source/B.esp/Cell.json`] : []);
    };

    const outcome = await sourceCommands({ client, adapter: fakeAdapter(), saveUnsaved, tasks: recordingTasks() }).build(['ModA', 'ModB']);

    expect(saved).toEqual([SOURCES.ModA, SOURCES.ModB]);
    expect(predicates).toEqual([isPluginSourcePath, isPluginSourcePath]);
    expect(client.calls.map((call) => call.args[0])).toMatchObject([[{ name: 'ModA' }]]);
    expect(outcome).toMatchObject({ refused: [{ item: 'ModB', reason: `VS Code did not save its plugin source: ${SOURCES.ModB}/plugin-source/B.esp/Cell.json` }] });
  });

  it('hands mEdit no archive variant for a release the table names none for', async () => {
    const client = new InMemoryMEditClient();
    buildingEach(client);

    await sourceCommands({ client, adapter: fakeAdapter({}, 'SkyrimSE'), saveUnsaved: savedAll, tasks: recordingTasks() }).build(['ModA']);

    expect(client.calls.map((call) => call.args[1])).toEqual([{ exclusionMark: EXCLUSION_MARK, archives: null }]);
  });

  it.each<[string, InstanceAnswers, readonly string[], string, string, string]>([
    ['whose metadata cannot be read', { unreadableMetadata: new Map([['ModA', 'EISDIR: meta.ini']]) }, ['ModA', 'ModB'],
      'ModA', 'its metadata could not be read: EISDIR: meta.ini', 'ModB'],
    ['no repository builds', {}, ['ModA', 'ModC'], 'ModC', 'no repository in the source folder builds it', 'ModA'],
    ['whose repository\'s build file builds another mod', {}, ['ModA', 'ModD'], 'ModD', 'its folder is "ModD", but its repository\'s build file builds "Other"', 'ModA'],
  ])('refuses a mod %s, naming why, and builds the rest', async (_case, answers, mods, item, reason, sent) => {
    const client = new InMemoryMEditClient();
    buildingEach(client);

    const outcome = await sourceCommands({ client, adapter: fakeAdapter(answers), saveUnsaved: savedAll, tasks: recordingTasks() }).build(mods);

    expect(client.calls).toMatchObject([{ args: [[{ name: sent }], expect.anything()] }]);
    expect(outcome).toEqual({ landed: [landedOf(sent)], refused: [{ item, reason }] });
  });

  it('refuses a mod whose remote cannot be read, naming why', async () => {
    const client = new InMemoryMEditClient();
    const adapter = fakeAdapter({ hosts: new Map([[SOURCES.ModA, { kind: 'unreadable', reason: 'git remote failed' }]]) });

    const outcome = await sourceCommands({ client, adapter, saveUnsaved: savedAll, tasks: recordingTasks() }).build(['ModA']);

    expect([client.calls, outcome]).toEqual([[], { landed: [], refused: [{ item: 'ModA', reason: 'its remote could not be read: git remote failed' }] }]);
  });

  it.each<[string, () => Promise<void>, string, Record<string, true>]>([
    ['holds no build file', () => rm(join(SOURCES.ModA, BUILD_FILE)), 'was not built: \'<ModA>\' holds no build file.', {}],
    ['names another output folder', () => writeBuildFileIn(SOURCES.ModA, buildFileOf('Other')),
      'was not built: its build file names the output folder \'Other\', not its folder \'ModA\'.', {}],
    ['runs a tool this machine has no task for', () => writeBuildFileIn(SOURCES.ModA, buildFileOf('ModA', {
      steps: [{ task: 'Zip', args: [] }], tools: [{ task: 'Zip', page: 'https://example.com/zip' }],
    })).then(() => undefined), 'was not built: this machine has no task for its tool \'Zip\' (https://example.com/zip).', { lacksATask: true }],
    ['takes a file from an installation file the downloads folder lacks', () => writeBuildFileIn(SOURCES.ModA, buildFileOf('ModA', {
      packages: [{ kind: 'installationFile', name: 'Pack.7z', size: 7, hash: 'H' }], files: [{ path: 'a.dds', entry: { kind: 'held' } }],
    })).then(() => undefined), 'was not built: installation file \'Pack.7z\' is missing.', {}],
  ])('refuses a mod whose repository %s, naming why, before anything is written', async (_case, arrange, reason, flags) => {
    await arrange();
    const client = new InMemoryMEditClient();
    const fake = fakeInstanceAdapter(readingFixture({ sourceMods: sourceModsOf(SOURCES) }));

    const outcome = await sourceCommands({ client, adapter: fake.adapter, saveUnsaved: savedAll, tasks: recordingTasks() }).build(['ModA']);

    expect([client.calls, fake.calls, outcome]).toEqual([[], [], { landed: [], refused: [{ item: 'ModA', reason: reason.replace('<ModA>', SOURCES.ModA), ...flags }] }]);
  });
});

describe('sourceCommands build, in mod order', () => {
  const ORDER = [{ kind: 'mod', name: 'ModA', enabled: true }, { kind: 'separator', name: 'Group', enabled: true }, { kind: 'mod', name: 'ModB', enabled: true }] as const;
  const winningFirst = () => fakeInstanceAdapter(readingFixture({ mods: [...ORDER], modFolders: modFoldersIn(join(root, 'mods'), 'ModA'), sourceMods: sourceModsOf(SOURCES) })).adapter;

  it('builds the mods from the losing end of mod order, the winning mod last, whatever order they were asked in', async () => {
    const client = new InMemoryMEditClient();
    buildingEach(client);

    const outcome = await sourceCommands({ client, adapter: winningFirst(), saveUnsaved: savedAll, tasks: recordingTasks() }).build(['ModA', 'ModB']);

    expect(client.calls.map((call) => call.args[0])).toMatchObject([[{ name: 'ModB' }], [{ name: 'ModA' }]]);
    expect(outcome).toMatchObject({ landed: [{ mod: 'ModB' }, { mod: 'ModA' }] });
  });

  it('builds every source mod the adapter reads now, in mod order, when asked for every source', async () => {
    const client = new InMemoryMEditClient();
    buildingEach(client);

    const outcome = await sourceCommands({ client, adapter: winningFirst(), saveUnsaved: savedAll, tasks: recordingTasks() }).build([], true);

    expect(outcome).toMatchObject({ landed: [{ mod: 'ModB' }, { mod: 'ModA' }] });
  });

  it('reports the mods that built when mEdit refuses a later mod, and refuses that mod and the rest, naming why', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandHandler('build', (mods: readonly BuildMod[]) =>
      Promise.resolve(mods[0]?.name === 'ModB' ? { landed: [builtOf('ModB')], refused: [] } : { refused: true as const, message: 'mEdit stopped' }));

    const outcome = await sourceCommands({ client, adapter: winningFirst(), saveUnsaved: savedAll, tasks: recordingTasks() }).build(['ModA', 'ModB']);

    expect(outcome).toEqual({ landed: [landedOf('ModB')], refused: [{ item: 'ModA', reason: 'was not built: mEdit stopped' }] });
  });

  it('runs a mod\'s steps in its folder once mEdit built it, and writes its manifest, before the next mod builds', async () => {
    const steps: ManifestStep[] = [{ task: 'Patch', args: ['a'] }];
    await writeBuildFileIn(SOURCES.ModB, buildFileOf('ModB', { steps, tools: [{ task: 'Patch', page: 'https://example.com/patch' }] }));
    const log: string[] = [];
    const client = new InMemoryMEditClient();
    client.setCommandHandler('build', (mods: readonly BuildMod[]) => {
      log.push(`build ${mods[0]?.name ?? ''}`);
      return Promise.resolve({ landed: mods.map((mod) => builtOf(mod.name)), refused: [] });
    });
    const tasks = recordingTasks(['Patch']);
    const logging = {
      ...tasks,
      whyStepsFailed: async (ran: readonly ManifestStep[], folder: string) => {
        log.push(`steps in ${folder === folderOf('ModB') ? 'ModB' : folder} ${await recorded('ModB') === undefined ? 'before' : 'after'} its manifest`);
        return tasks.whyStepsFailed(ran, folder);
      },
    };

    await sourceCommands({ client, adapter: winningFirst(), saveUnsaved: savedAll, tasks: logging }).build(['ModA', 'ModB']);

    expect(log).toEqual(['build ModB', 'steps in ModB before its manifest', 'build ModA']);
    expect(tasks.runs).toEqual([{ steps, folder: folderOf('ModB') }]);
    expect(await recorded('ModB')).toMatchObject({ packages: [{ kind: 'sourceRepository', name: 'Old ModB' }] });
  });

  it('names a mod whose manifest could not be written', async () => {
    await rm(folderOf('ModA'), { recursive: true });
    const client = new InMemoryMEditClient();
    buildingEach(client);

    const outcome = await sourceCommands({ client, adapter: fakeAdapter(), saveUnsaved: savedAll, tasks: recordingTasks() }).build(['ModA']);

    expect(outcome).toEqual({
      landed: [{ ...landedOf('ModA'), failure: expect.stringMatching(/^The build could not write its manifest: /) as unknown }], refused: [],
    });
  });

  it('names a mod whose step failed, and writes no manifest', async () => {
    await writeBuildFileIn(SOURCES.ModA, buildFileOf('ModA', { steps: [{ task: 'Optimise', args: [] }], tools: [{ task: 'Optimise', page: 'https://example.com/o' }] }));
    const client = new InMemoryMEditClient();
    buildingEach(client);
    const tasks = recordingTasks(['Optimise'], { [folderOf('ModA')]: 'step \'Optimise\' exited with code 2' });

    const outcome = await sourceCommands({ client, adapter: fakeAdapter(), saveUnsaved: savedAll, tasks }).build(['ModA']);

    expect(outcome).toEqual({
      landed: [{ ...landedOf('ModA'), failure: 'The build stopped as its step \'Optimise\' exited with code 2, so its manifest was not written.' }], refused: [],
    });
    expect(await readdir(folderOf('ModA'))).toEqual([]);
  });
});

describe('sourceCommands decompileAndCommit', () => {
  const modsAt = (answers: InstanceAnswers = {}) => fakeInstanceAdapter(readingFixture({ sourceMods: sourceModsOf(SOURCES) }), answers).adapter;
  const FOLDER = '/instance/mods/ModA';
  const hashed = (files: Record<string, string>, folder = FOLDER): InstanceAnswers => ({
    folderFiles: new Map([[folder, Object.keys(files)]]),
    hashes: new Map(Object.entries(files).map(([path, hash]) => [join(folder, path), { size: 1, hash }])),
  });
  const committing = () => {
    const client = new InMemoryMEditClient();
    const handed: DecompileAndCommitMod[] = [];
    client.setCommandHandler('decompileAndCommit', (mods) => { handed.push(...mods); return Promise.resolve({ landed: [], refused: [] }); });
    return { client, handed };
  };
  const buildFileHanded = (mod: DecompileAndCommitMod | undefined): Manifest => {
    const read = readManifest(mod?.repository.buildFile ?? '');
    if ('refused' in read) throw new Error(read.refused);
    return read.manifest;
  };

  it('hands mEdit each mod\'s repository: as its assets each file its installation file does not yield with its bytes but those compile writes, and its build file naming its folder as its output and taking from its packages each file they give', async () => {
    const { client, handed } = committing();
    const pack = { path: '/downloads/Pack.7z', page: undefined, size: 7, hash: 'H', entries: [{ path: 'textures/a.dds', hash: 'A' }] };
    const adapter = modsAt({
      ...hashed({ 'ModA.esp': 'P', 'Strings/ModA_en.strings': 'S', 'meta.ini': 'M', 'textures/a.dds': 'A', 'scripts/b.pex': 'B', 'ModA.manifest.json': 'X' }),
      installations: new Map([['ModA', { kind: 'read', answer: pack }]]), metadata: new Map([['ModA', { version: '1.2.3' }]]),
    });

    await sourceCommands({ client, adapter, saveUnsaved: savedAll, tasks: recordingTasks() }).decompileAndCommit(['ModA']);

    const [mod] = handed;
    expect(mod).toMatchObject({ name: 'ModA', repository: { sourceFolder: '/source/ModA', assets: ['scripts/b.pex'] } });
    expect(buildFileHanded(mod)).toEqual({
      ...buildFileOf('ModA'), packages: [{ kind: 'installationFile', name: 'Pack.7z', size: 7, hash: 'H' }], files: [{ path: 'textures/a.dds', entry: { kind: 'held' } }],
    });
  });

  it('commits as an asset a file its installation file holds with other bytes', async () => {
    const { client, handed } = committing();
    const pack = { path: '/downloads/Pack.7z', page: undefined, size: 7, hash: 'H', entries: [{ path: 'textures/a.dds', hash: 'A' }] };
    const adapter = modsAt({ ...hashed({ 'textures/a.dds': 'edited' }), installations: new Map([['ModA', { kind: 'read', answer: pack }]]) });

    await sourceCommands({ client, adapter, saveUnsaved: savedAll, tasks: recordingTasks() }).decompileAndCommit(['ModA']);

    expect(handed[0]?.repository.assets).toEqual(['textures/a.dds']);
  });

  it('takes from the game folder each file it holds with its bytes, naming it as a package, and commits no asset for it', async () => {
    const { client, handed } = committing();
    const file = { path: 'Data/textures/a.dds', hash: 'G', pathInFolder: 'textures/a.dds' };
    const adapter = modsAt({
      ...hashed({ 'textures/a.dds': 'G', 'scripts/b.pex': 'B' }, '/instance/mods/ModC'),
      places: [{ root: '/game', holdsDataFiles: true, depots: [], depotProblems: [], gameFilesTaken: new Map([['ModC', { kind: 'read', answer: { gameFiles: [file], notes: [] } }]]) }],
    });

    await sourceCommands({ client, adapter, saveUnsaved: savedAll, tasks: recordingTasks() }).decompileAndCommit(['ModC']);

    const [mod] = handed;
    expect(mod?.repository.assets).toEqual(['scripts/b.pex']);
    expect(buildFileHanded(mod)).toMatchObject({ packages: [{ kind: 'gameFolder', name: 'Fallout4' }], files: [{ path: 'textures/a.dds', entry: { kind: 'heldAt', path: 'Data/textures/a.dds' } }] });
  });

  it.each<[string, { kind: 'unreadable'; reason: string } | { kind: 'read'; answer: { gameFiles: []; notes: string[] } }, string]>([
    ['cannot be read', { kind: 'unreadable', reason: 'EACCES' }, 'EACCES'],
    ['come with a note', { kind: 'read', answer: { gameFiles: [], notes: ['a game file differs in case'] } }, 'a game file differs in case'],
  ])('refuses a mod whose game files %s, naming why, and commits the rest', async (_case, taken, reason) => {
    const { client, handed } = committing();
    const adapter = modsAt({ places: [{ root: '/game', holdsDataFiles: true, depots: [], depotProblems: [], gameFilesTaken: new Map([['ModC', taken]]) }] });

    const outcome = await sourceCommands({ client, adapter, saveUnsaved: savedAll, tasks: recordingTasks() }).decompileAndCommit(['ModC', 'ModF']);

    expect(handed).toMatchObject([{ name: 'ModF' }]);
    expect(outcome).toMatchObject({ refused: [{ item: 'ModC', reason }] });
  });

  it.each<[string, InstanceAnswers, string]>([
    ['whose installation file cannot be read', { installations: new Map([['ModA', { kind: 'unreadable', reason: 'EACCES' }]]) }, 'EACCES'],
    ['a file of whose folder cannot be read', { folderFiles: new Map([[FOLDER, ['a.dds']]]) }, `a file of its folder could not be read: no answer fixed for ${join(FOLDER, 'a.dds')}`],
  ])('refuses a mod %s, naming why, and commits the rest', async (_case, answers, reason) => {
    const { client, handed } = committing();

    const outcome = await sourceCommands({ client, adapter: modsAt(answers), saveUnsaved: savedAll, tasks: recordingTasks() }).decompileAndCommit(['ModA', 'ModB']);

    expect(handed).toMatchObject([{ name: 'ModB' }]);
    expect(outcome).toMatchObject({ refused: [{ item: 'ModA', reason }] });
  });

  it('refuses a mod whose name gives it no source folder, naming why', async () => {
    const client = new InMemoryMEditClient();

    const outcome = await sourceCommands({ client, adapter: modsAt({ unsourcedMods: new Set(['Mods/ModA']) }), saveUnsaved: savedAll, tasks: recordingTasks() }).decompileAndCommit(['Mods/ModA']);

    expect(client.calls).toEqual([]);
    expect(outcome).toEqual({ landed: [], refused: [{ item: 'Mods/ModA', reason: 'its name gives it no source folder' }] });
  });

  it('says it is reading each mod\'s files before mEdit decompiles it', async () => {
    const { client } = committing();
    const heard: unknown[] = [];

    await sourceCommands({ client, adapter: modsAt(), saveUnsaved: savedAll, tasks: recordingTasks() })
      .decompileAndCommit(['ModA', 'ModB'], { onProgress: (status) => { heard.push(status); } });

    expect(heard).toEqual([
      { mod: 'ModA', modsDone: 0, modsTotal: 2, phase: 'ReadingFiles' }, { mod: 'ModB', modsDone: 1, modsTotal: 2, phase: 'ReadingFiles' },
    ]);
  });
});
