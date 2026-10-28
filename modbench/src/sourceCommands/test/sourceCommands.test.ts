import { describe, it, expect } from 'vitest';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { fakeInstanceAdapter, readingFixture, sourceModsOf, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { sourceCommands } from '../sourceCommands';
import { isPluginSourcePath } from '../../instanceAdapter/instanceAdapter';
import { recordingTasks } from '../../test/recordingTasks';
import type { BuildMod, BuildOutcome, ManifestStep } from '../../client';

const SOURCES = { ModA: '/instance/source/ModA', ModB: '/instance/source/Old ModB' };

const fakeAdapter = (answers: InstanceAnswers = {}, gameRelease = 'Fallout4') =>
  fakeInstanceAdapter(readingFixture({ gameRelease, sourceMods: sourceModsOf(SOURCES, [], [], { '/source/ModD': 'Other', '/source/ModE': 'MODE' }) }), answers).adapter;

const EXCLUSION_MARK = fakeAdapter().exclusionMark;
const savedAll = () => Promise.resolve([]);

const BUILT = { landed: [{ mod: 'ModA', compiled: [], refused: [], archivesRefused: [], overwritten: [], steps: [], made: [] }], refused: [] };

describe('sourceCommands build', () => {
  it('hands mEdit each mod with the source folder that builds it, whether that is a submodule, its folder and its metadata files, the exclusion mark, the release\'s archive variants, the stat cache\'s folder and the label of each task this machine has', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', BUILT);
    const adapter = fakeAdapter({
      metadata: new Map([['ModA', { version: '1.2.3' }]]),
      hosts: new Map([['/instance/source/ModA', { kind: 'read', answer: { kind: 'host', url: 'https://example.test/a.git' } }]]),
    });

    await sourceCommands({ client, adapter, saveUnsaved: savedAll, tasks: recordingTasks(['Optimise textures']) }).build(['ModA', 'ModB']);

    const ba2 = { ba2: { version: 1, compressed: true } };
    const facts = { exclusionMark: EXCLUSION_MARK, archives: { general: ba2, textures: ba2 }, statCache: '/instance/stat-cache', tasks: ['Optimise textures'] };
    expect(client.calls).toEqual([
      { method: 'build', args: [[{ name: 'ModA', sourceFolder: '/instance/source/ModA', folder: '/instance/mods/ModA', metadataFiles: ['meta.ini'], version: '1.2.3', isSubmodule: true }], facts] },
      { method: 'build', args: [[{ name: 'ModB', sourceFolder: '/instance/source/Old ModB', folder: '/instance/mods/ModB', metadataFiles: ['meta.ini'], isSubmodule: false }], facts] },
    ]);
  });

  it('saves each mod\'s source folder, and refuses a mod whose file VS Code leaves unsaved, naming the file, while the rest build', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', BUILT);
    const saved: string[] = [];
    const predicates: ((path: string) => boolean)[] = [];
    const saveUnsaved = (folder: string, isPluginSource: (path: string) => boolean) => {
      saved.push(folder);
      predicates.push(isPluginSource);
      return Promise.resolve(folder.endsWith('Old ModB') ? ['/instance/source/Old ModB/plugin-source/B.esp/Cell.json'] : []);
    };

    const outcome = await sourceCommands({ client, adapter: fakeAdapter(), saveUnsaved, tasks: recordingTasks() }).build(['ModA', 'ModB']);

    expect(saved).toEqual(['/instance/source/ModA', '/instance/source/Old ModB']);
    expect(predicates).toEqual([isPluginSourcePath, isPluginSourcePath]);
    expect(client.calls.map((call) => call.args[0])).toMatchObject([[{ name: 'ModA' }]]);
    expect(outcome).toMatchObject({
      refused: [{ item: 'ModB', reason: 'VS Code did not save its plugin source: /instance/source/Old ModB/plugin-source/B.esp/Cell.json' }],
    });
  });

  it('hands mEdit again a mod it refused for installation files its manifest names, with the downloaded files of those names', async () => {
    const client = new InMemoryMEditClient();
    const pack = { path: '/downloads/Pack.7z', page: undefined, size: 7, hash: 'H', entries: [] };
    client.setCommandHandler('build', (mods) => Promise.resolve((mods[0]?.installationFiles ?? []).length === 0
      ? { landed: [], refused: [{ item: 'ModA', reason: 'was not built: installation file Pack.7z is missing.', refusal: 'PackageLacking', installationFilesNotFound: [{ name: 'Pack.7z', hash: 'H' }] }] }
      : BUILT));
    const adapter = fakeAdapter({ downloadedFiles: new Map([['Pack.7z', { kind: 'read', answer: pack }]]) });

    const outcome = await sourceCommands({ client, adapter, saveUnsaved: savedAll, tasks: recordingTasks() }).build(['ModA']);

    expect(client.calls.map((call) => call.args[0])).toMatchObject([[{ name: 'ModA' }], [{ name: 'ModA', installationFiles: [{ path: '/downloads/Pack.7z', hash: 'H' }] }]]);
    expect(outcome).toMatchObject({ landed: [{ mod: 'ModA' }], refused: [] });
  });

  it('keeps the refusal of a mod whose installation file the downloads folder lacks, once mEdit is asked again', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', { landed: [], refused: [{ item: 'ModA', reason: 'was not built: installation file Pack.7z is missing.', refusal: 'PackageLacking', installationFilesNotFound: [{ name: 'Pack.7z', hash: 'H' }] }] });

    const outcome = await sourceCommands({ client, adapter: fakeAdapter(), saveUnsaved: savedAll, tasks: recordingTasks() }).build(['ModA']);

    expect(outcome).toMatchObject({ landed: [], refused: [{ item: 'ModA', reason: 'was not built: installation file Pack.7z is missing.' }] });
  });

  it('hands mEdit why an installation file its manifest names could not be read, by name', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', { landed: [], refused: [{ item: 'ModA', reason: 'was not built: installation file Pack.7z is missing.', refusal: 'PackageLacking', installationFilesNotFound: [{ name: 'Pack.7z', hash: 'H' }] }] });
    const adapter = fakeAdapter({ downloadedFiles: new Map([['Pack.7z', { kind: 'unreadable', reason: 'EACCES' }]]) });

    await sourceCommands({ client, adapter, saveUnsaved: savedAll, tasks: recordingTasks() }).build(['ModA']);

    expect(client.calls[1]?.args[0]).toMatchObject([{ name: 'ModA', installationFiles: [], unreadableInstallationFiles: { 'Pack.7z': 'EACCES' } }]);
  });

  describe('a game file its manifest takes', () => {
    const NEEDING = { landed: [], refused: [{ item: 'ModA', reason: 'was not built: game file textures/a.dds is missing.', refusal: 'PackageLacking' as const, installationFilesNotFound: [], gameFilesNotFound: ['textures/a.dds'] }] };
    const asksOnceThenBuilds = (client: InMemoryMEditClient): void => {
      client.setCommandHandler('build', (_mods, facts) => Promise.resolve((facts.gameFolder?.files ?? []).length === 0 ? NEEDING : BUILT));
    };
    const place = { dataFolder: '/game/Data', depots: [], depotProblems: [] };

    it('hands mEdit again the mod it refused for game files, with the files from every place of the game that holds them', async () => {
      const client = new InMemoryMEditClient();
      asksOnceThenBuilds(client);
      const file = { path: 'textures/a.dds', hash: 'G' };
      const adapter = fakeAdapter({ places: [{ ...place, gameFiles: new Map([['textures/a.dds', file]]) }] });

      const outcome = await sourceCommands({ client, adapter, saveUnsaved: savedAll, tasks: recordingTasks() }).build(['ModA']);

      expect(client.calls[1]?.args[1]).toMatchObject({ gameFolder: { name: 'Fallout4', dataFolder: '/game/Data', files: [file] } });
      expect(outcome).toMatchObject({ landed: [{ mod: 'ModA' }], refused: [] });
    });

    it('hands mEdit why a game file could not be read, by path', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('build', NEEDING);
      const adapter = fakeAdapter({ places: [{ ...place, unreadableGameFiles: new Map([['textures/a.dds', 'EACCES']]) }] });

      await sourceCommands({ client, adapter, saveUnsaved: savedAll, tasks: recordingTasks() }).build(['ModA']);

      expect(client.calls[1]?.args[0]).toMatchObject([{ name: 'ModA', unreadableGameFiles: { 'textures/a.dds': 'EACCES' } }]);
    });

    it('hands mEdit that the game folder was not found, for each game file its manifest takes', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('build', NEEDING);

      await sourceCommands({ client, adapter: fakeAdapter({ places: [] }), saveUnsaved: savedAll, tasks: recordingTasks() }).build(['ModA']);

      expect(client.calls[1]?.args[0]).toMatchObject([{ name: 'ModA', unreadableGameFiles: { 'textures/a.dds': 'the game folder was not found' } }]);
    });
  });

  it('hands mEdit no archive variant for a release the table names none for', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', BUILT);

    await sourceCommands({ client, adapter: fakeAdapter({}, 'SkyrimSE'), saveUnsaved: savedAll, tasks: recordingTasks() }).build(['ModA']);

    expect(client.calls.map((call) => call.args[1])).toEqual([{ exclusionMark: EXCLUSION_MARK, archives: null, statCache: '/instance/stat-cache', tasks: [] }]);
  });

  it.each<[string, InstanceAnswers, readonly string[], string, string, string]>([
    ['whose metadata cannot be read', { unreadableMetadata: new Map([['ModA', 'EISDIR: meta.ini']]) }, ['ModA', 'ModB'],
      'ModA', 'its metadata could not be read: EISDIR: meta.ini', 'ModB'],
    ['whose remote cannot be read', { hosts: new Map([['/instance/source/ModA', { kind: 'unreadable', reason: 'git remote failed' }]]) }, ['ModA', 'ModB'],
      'ModA', 'its remote could not be read: git remote failed', 'ModB'],
    ['no repository builds', {}, ['ModA', 'ModC'], 'ModC', 'no repository in the source folder builds it', 'ModA'],
    ['whose repository\'s manifest builds another mod', {}, ['ModA', 'ModD'], 'ModD', 'its folder is "ModD", but its repository\'s manifest builds "Other"', 'ModA'],
    ['whose repository\'s manifest is not named for the mod\'s own name', {}, ['ModA', 'ModE'], 'ModE', 'its repository\'s manifest is not named for its output "MODE"', 'ModA'],
  ])('refuses a mod %s, naming why, and builds the rest', async (_case, answers, mods, item, reason, sent) => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', BUILT);

    const outcome = await sourceCommands({ client, adapter: fakeAdapter(answers), saveUnsaved: savedAll, tasks: recordingTasks() }).build(mods);

    expect(client.calls).toMatchObject([{ args: [[{ name: sent }], expect.anything()] }]);
    expect(outcome).toEqual({ ...BUILT, refused: [{ item, reason }] });
  });
});

describe('sourceCommands build, in mod order', () => {
  const ORDER = [{ kind: 'mod', name: 'ModA', enabled: true }, { kind: 'separator', name: 'Group', enabled: true }, { kind: 'mod', name: 'ModB', enabled: true }] as const;
  const builtOf = (mod: string, steps: readonly ManifestStep[] = []) => ({ mod, compiled: [], refused: [], archivesRefused: [], overwritten: [], steps: [...steps], made: [] });
  const winningFirst = () => fakeInstanceAdapter(readingFixture({ mods: [...ORDER], sourceMods: sourceModsOf(SOURCES) })).adapter;

  it('builds the mods from the losing end of mod order, the winning mod last, whatever order they were asked in', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandHandler('build', (mods: readonly BuildMod[]) => Promise.resolve({ landed: mods.map((mod) => builtOf(mod.name)), refused: [] }));

    const outcome = await sourceCommands({ client, adapter: winningFirst(), saveUnsaved: savedAll, tasks: recordingTasks() }).build(['ModA', 'ModB']);

    expect(client.calls.map((call) => call.args[0])).toMatchObject([[{ name: 'ModB' }], [{ name: 'ModA' }]]);
    expect(outcome).toMatchObject({ landed: [{ mod: 'ModB' }, { mod: 'ModA' }] });
  });

  it('builds every source mod the adapter reads now, in mod order, when asked for every source', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandHandler('build', (mods: readonly BuildMod[]) => Promise.resolve({ landed: mods.map((mod) => builtOf(mod.name)), refused: [] }));

    const outcome = await sourceCommands({ client, adapter: winningFirst(), saveUnsaved: savedAll, tasks: recordingTasks() }).build([], true);

    expect(outcome).toMatchObject({ landed: [{ mod: 'ModB' }, { mod: 'ModA' }] });
  });

  it('reports the mods that built when mEdit refuses a later mod, and refuses that mod and the rest, naming why', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandHandler('build', (mods: readonly BuildMod[]) =>
      Promise.resolve(mods[0]?.name === 'ModB' ? { landed: [builtOf('ModB')], refused: [] } : { refused: true as const, message: 'mEdit stopped' }));

    const outcome = await sourceCommands({ client, adapter: winningFirst(), saveUnsaved: savedAll, tasks: recordingTasks() }).build(['ModA', 'ModB']);

    expect(outcome).toEqual({ landed: [builtOf('ModB')], refused: [{ item: 'ModA', reason: 'was not built: mEdit stopped' }] });
  });

  it('runs a mod\'s steps and has its manifest written before the next mod builds', async () => {
    const steps: ManifestStep[] = [{ task: 'Patch', args: [] }];
    const log: string[] = [];
    const client = new InMemoryMEditClient();
    client.setCommandHandler('build', (mods: readonly BuildMod[]) => {
      log.push(`${mods[0]?.made ? 'manifest' : 'build'} ${mods[0]?.name}`);
      return Promise.resolve({ landed: [builtOf(mods[0]?.name ?? '', mods[0]?.made ? [] : steps)], refused: [] });
    });
    const tasks = recordingTasks(['Patch']);
    const logging = { ...tasks, whyStepsFailed: (ran: readonly ManifestStep[], folder: string) => { log.push(`steps ${folder}`); return tasks.whyStepsFailed(ran, folder); } };

    await sourceCommands({ client, adapter: winningFirst(), saveUnsaved: savedAll, tasks: logging }).build(['ModA', 'ModB']);

    expect(log).toEqual(['build ModB', 'steps /instance/mods/ModB', 'manifest ModB', 'build ModA', 'steps /instance/mods/ModA', 'manifest ModA']);
  });
});

describe('sourceCommands build, of a mod with steps', () => {
  const STEPS = [{ task: 'Optimise textures', args: ['textures'] }, { task: 'Archive', args: [] }];
  const builtWithSteps = { mod: 'ModA', compiled: [], refused: [], archivesRefused: [], overwritten: [], steps: STEPS, made: ['a.nif'] };

  function mEdit(writing: BuildOutcome = { landed: [{ ...builtWithSteps, steps: [], made: [] }], refused: [] }) {
    const client = new InMemoryMEditClient();
    client.setCommandHandler('build', (mods: readonly BuildMod[]) =>
      Promise.resolve(mods.some((mod) => mod.made) ? writing : { landed: [builtWithSteps], refused: [] }));
    return client;
  }

  it('runs the mod\'s steps in its folder, then hands mEdit the files its build made, so mEdit writes its manifest last', async () => {
    const client = mEdit();
    const tasks = recordingTasks(['Optimise textures', 'Archive']);

    const outcome = await sourceCommands({ client, adapter: fakeAdapter(), saveUnsaved: savedAll, tasks }).build(['ModA']);

    expect(tasks.runs).toEqual([{ steps: STEPS, folder: '/instance/mods/ModA' }]);
    expect(client.calls.map((call) => call.args[0])).toMatchObject([[{ name: 'ModA' }], [{ name: 'ModA', made: ['a.nif'] }]]);
    expect(outcome).toEqual({ landed: [builtWithSteps], refused: [] });
  });

  it('names a mod whose step failed, has no manifest written for it, and has the next mod\'s written', async () => {
    const client = new InMemoryMEditClient();
    const written: string[][] = [];
    client.setCommandHandler('build', (mods: readonly BuildMod[]) => {
      if (mods.some((mod) => mod.made)) written.push(mods.map((mod) => mod.name));
      return Promise.resolve({ landed: mods.map((mod) => ({ ...builtWithSteps, mod: mod.name, ...(mod.made ? { steps: [], made: [] } : {}) })), refused: [] });
    });
    const tasks = recordingTasks([], { '/instance/mods/ModA': 'step \'Optimise textures\' exited with code 2' });

    const outcome = await sourceCommands({ client, adapter: fakeAdapter(), saveUnsaved: savedAll, tasks }).build(['ModA', 'ModB']);

    expect(written).toEqual([['ModB']]);
    expect(outcome).toEqual({
      landed: [
        { ...builtWithSteps, failure: 'The build stopped as its step \'Optimise textures\' exited with code 2, so its manifest was not written.' },
        { ...builtWithSteps, mod: 'ModB' },
      ],
      refused: [],
    });
  });

  it('names a mod whose manifest mEdit could not write once its steps ran', async () => {
    const client = mEdit({ landed: [{ ...builtWithSteps, steps: [], made: [], failure: 'The build could not write its manifest: EACCES' }], refused: [] });

    const outcome = await sourceCommands({ client, adapter: fakeAdapter(), saveUnsaved: savedAll, tasks: recordingTasks() }).build(['ModA']);

    expect(outcome).toEqual({ landed: [{ ...builtWithSteps, failure: 'The build could not write its manifest: EACCES' }], refused: [] });
  });
});

describe('sourceCommands decompileAndCommit', () => {
  it('hands mEdit each mod with the source folder decompile and commit makes its repository in and the mod manager\'s own files in the mod folder', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('decompileAndCommit', { landed: [{ mod: 'ModA', plugins: [] }, { mod: 'ModB', plugins: [] }], refused: [] });

    await sourceCommands({ client, adapter: fakeAdapter(), saveUnsaved: savedAll, tasks: recordingTasks() }).decompileAndCommit(['ModA', 'ModB']);

    expect(client.calls).toEqual([{
      method: 'decompileAndCommit',
      args: [[
        { name: 'ModA', sourceFolder: '/source/ModA', metadataFiles: ['meta.ini'] },
        { name: 'ModB', sourceFolder: '/source/ModB', metadataFiles: ['meta.ini'] },
      ], {}],
    }]);
  });

  it('hands mEdit each mod\'s installation file and its version as its metadata says', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('decompileAndCommit', { landed: [], refused: [] });
    const pack = { path: '/downloads/Pack.7z', page: undefined, size: 7, hash: 'H', entries: [{ path: 'a.dds', hash: 'E' }] };
    const adapter = fakeAdapter({ installations: new Map([['ModA', { kind: 'read', answer: pack }]]), metadata: new Map([['ModA', { version: '1.2.3' }]]) });

    await sourceCommands({ client, adapter, saveUnsaved: savedAll, tasks: recordingTasks() }).decompileAndCommit(['ModA']);

    expect(client.calls[0]?.args[0]).toEqual([{
      name: 'ModA', sourceFolder: '/source/ModA', metadataFiles: ['meta.ini'], version: '1.2.3',
      installationFile: { path: '/downloads/Pack.7z', size: 7, hash: 'H', entries: [{ path: 'a.dds', hash: 'E' }] },
    }]);
  });

  it('hands mEdit the game files each mod\'s files may be, with the depots the game folder records', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('decompileAndCommit', { landed: [], refused: [] });
    const file = { path: 'textures/a.dds', hash: 'G' };
    const adapter = fakeAdapter({
      places: [{ dataFolder: '/game/Data', depots: [{ id: '377162', version: '7' }], depotProblems: [] }],
      gameFilesTaken: new Map([['ModC', { kind: 'read', answer: { gameFiles: [file], notes: [] } }]]),
    });
    adapter.gameFilesTakenBy = (_dataFolder, folder) => Promise.resolve(folder.endsWith('ModC')
      ? { kind: 'read', answer: { gameFiles: [file], notes: [] } } : { kind: 'read', answer: { gameFiles: [], notes: [] } });

    await sourceCommands({ client, adapter, saveUnsaved: savedAll, tasks: recordingTasks() }).decompileAndCommit(['ModC']);

    expect(client.calls[0]?.args[0]).toMatchObject([
      { name: 'ModC', gameFolder: { name: 'Fallout4', dataFolder: '/game/Data', files: [file], depots: [{ id: '377162', version: '7' }] } },
    ]);
  });

  it('refuses a mod whose game files cannot be read, naming why, and commits the rest', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('decompileAndCommit', { landed: [], refused: [] });
    const adapter = fakeAdapter({ places: [{ dataFolder: '/game/Data', depots: [], depotProblems: [] }] });
    adapter.gameFilesTakenBy = (_dataFolder, folder) => Promise.resolve(folder.endsWith('ModC')
      ? { kind: 'unreadable', reason: 'EACCES' } : { kind: 'read', answer: { gameFiles: [], notes: [] } });

    const outcome = await sourceCommands({ client, adapter, saveUnsaved: savedAll, tasks: recordingTasks() }).decompileAndCommit(['ModC', 'ModF']);

    expect(client.calls[0]?.args[0]).toMatchObject([{ name: 'ModF' }]);
    expect(outcome).toMatchObject({ refused: [{ item: 'ModC', reason: 'EACCES' }] });
  });

  it.each<[string, InstanceAnswers, string]>([
    ['whose installation file cannot be read', { installations: new Map([['ModA', { kind: 'unreadable', reason: 'EACCES' }]]) }, 'EACCES'],
    ['whose metadata cannot be read', { unreadableMetadata: new Map([['ModA', 'EISDIR: meta.ini']]) }, 'its metadata could not be read: EISDIR: meta.ini'],
  ])('refuses a mod %s, naming why, and commits the rest', async (_case, answers, reason) => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('decompileAndCommit', { landed: [], refused: [] });

    const outcome = await sourceCommands({ client, adapter: fakeAdapter(answers), saveUnsaved: savedAll, tasks: recordingTasks() }).decompileAndCommit(['ModA', 'ModB']);

    expect(client.calls[0]?.args[0]).toMatchObject([{ name: 'ModB' }]);
    expect(outcome).toMatchObject({ refused: [{ item: 'ModA', reason }] });
  });

  it('refuses a mod whose name gives it no source folder, naming why', async () => {
    const client = new InMemoryMEditClient();

    const outcome = await sourceCommands({ client, adapter: fakeAdapter({ unsourcedMods: new Set(['Mods/ModA']) }), saveUnsaved: savedAll, tasks: recordingTasks() }).decompileAndCommit(['Mods/ModA']);

    expect(client.calls).toEqual([]);
    expect(outcome).toEqual({ landed: [], refused: [{ item: 'Mods/ModA', reason: 'its name gives it no source folder' }] });
  });
});
