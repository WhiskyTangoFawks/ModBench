import { describe, it, expect } from 'vitest';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { fakeInstanceAdapter, readingFixture, sourceModsOf, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { sourceCommands } from '../sourceCommands';
import { isPluginSourcePath } from '../../instanceAdapter/instanceAdapter';
import { recordingTasks } from '../../test/recordingTasks';
import type { BuildMod, BuildOutcome } from '../../client';

const SOURCES = { ModA: '/instance/source/ModA', ModB: '/instance/source/Old ModB' };

const fakeAdapter = (answers: InstanceAnswers = {}, gameRelease = 'Fallout4') =>
  fakeInstanceAdapter(readingFixture({ gameRelease, sourceMods: sourceModsOf(SOURCES) }), answers).adapter;

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
    expect(client.calls).toEqual([{
      method: 'build',
      args: [[
        { name: 'ModA', sourceFolder: '/instance/source/ModA', folder: '/mods/ModA', metadataFiles: ['meta.ini'], version: '1.2.3', isSubmodule: true },
        { name: 'ModB', sourceFolder: '/instance/source/Old ModB', folder: '/mods/ModB', metadataFiles: ['meta.ini'], isSubmodule: false },
      ], { exclusionMark: EXCLUSION_MARK, archives: { general: ba2, textures: ba2 }, statCache: '/instance/stat-cache', tasks: ['Optimise textures'] }],
    }]);
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
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.args[0]).toMatchObject([{ name: 'ModA' }]);
    expect(outcome).toMatchObject({
      refused: [{ item: 'ModB', reason: 'VS Code did not save its plugin source: /instance/source/Old ModB/plugin-source/B.esp/Cell.json' }],
    });
  });

  it('hands mEdit again a mod it refused for installation files its manifest names, with the downloaded files of those names', async () => {
    const client = new InMemoryMEditClient();
    const pack = { path: '/downloads/Pack.7z', page: undefined, size: 7, hash: 'H', entries: [] };
    client.setCommandHandler('build', (mods) => Promise.resolve((mods[0]?.installationFiles ?? []).length === 0
      ? { landed: [], refused: [{ item: 'ModA', reason: 'was not built: installation file Pack.7z is missing.', refusal: 'InstallationFileLacking', installationFilesNotFound: [{ name: 'Pack.7z', hash: 'H' }] }] }
      : BUILT));
    const adapter = fakeAdapter({ downloadedFiles: new Map([['Pack.7z', { kind: 'read', answer: pack }]]) });

    const outcome = await sourceCommands({ client, adapter, saveUnsaved: savedAll, tasks: recordingTasks() }).build(['ModA']);

    expect(client.calls.map((call) => call.args[0])).toMatchObject([[{ name: 'ModA' }], [{ name: 'ModA', installationFiles: [{ path: '/downloads/Pack.7z', hash: 'H' }] }]]);
    expect(outcome).toMatchObject({ landed: [{ mod: 'ModA' }], refused: [] });
  });

  it('keeps the refusal of a mod whose installation file the downloads folder lacks, once mEdit is asked again', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', { landed: [], refused: [{ item: 'ModA', reason: 'was not built: installation file Pack.7z is missing.', refusal: 'InstallationFileLacking', installationFilesNotFound: [{ name: 'Pack.7z', hash: 'H' }] }] });

    const outcome = await sourceCommands({ client, adapter: fakeAdapter(), saveUnsaved: savedAll, tasks: recordingTasks() }).build(['ModA']);

    expect(outcome).toMatchObject({ landed: [], refused: [{ item: 'ModA', reason: 'was not built: installation file Pack.7z is missing.' }] });
  });

  it('hands mEdit why an installation file its manifest names could not be read, by name', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', { landed: [], refused: [{ item: 'ModA', reason: 'was not built: installation file Pack.7z is missing.', refusal: 'InstallationFileLacking', installationFilesNotFound: [{ name: 'Pack.7z', hash: 'H' }] }] });
    const adapter = fakeAdapter({ downloadedFiles: new Map([['Pack.7z', { kind: 'unreadable', reason: 'EACCES' }]]) });

    await sourceCommands({ client, adapter, saveUnsaved: savedAll, tasks: recordingTasks() }).build(['ModA']);

    expect(client.calls[1]?.args[0]).toMatchObject([{ name: 'ModA', installationFiles: [], unreadableInstallationFiles: { 'Pack.7z': 'EACCES' } }]);
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
  ])('refuses a mod %s, naming why, and builds the rest', async (_case, answers, mods, item, reason, sent) => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', BUILT);

    const outcome = await sourceCommands({ client, adapter: fakeAdapter(answers), saveUnsaved: savedAll, tasks: recordingTasks() }).build(mods);

    expect(client.calls).toMatchObject([{ args: [[{ name: sent }], expect.anything()] }]);
    expect(outcome).toEqual({ ...BUILT, refused: [{ item, reason }] });
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

    expect(tasks.runs).toEqual([{ steps: STEPS, folder: '/mods/ModA' }]);
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
    const tasks = recordingTasks([], { '/mods/ModA': 'step \'Optimise textures\' exited with code 2' });

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

  it('refuses a mod whose name gives it no source folder, naming why', async () => {
    const client = new InMemoryMEditClient();

    const outcome = await sourceCommands({ client, adapter: fakeAdapter({ unsourcedMods: new Set(['Mods/ModA']) }), saveUnsaved: savedAll, tasks: recordingTasks() }).decompileAndCommit(['Mods/ModA']);

    expect(client.calls).toEqual([]);
    expect(outcome).toEqual({ landed: [], refused: [{ item: 'Mods/ModA', reason: 'its name gives it no source folder' }] });
  });
});
