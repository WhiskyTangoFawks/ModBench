import { describe, it, expect } from 'vitest';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { FileRead, InstallationFile } from '../../instanceAdapter/instanceAdapter';
import { fakeInstanceAdapter, readingFixture, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { sourceCommands } from '../sourceCommands';

const INSTALLED: InstallationFile = {
  path: '/downloads/ModA-1.0.7z', size: 10, hash: 'H', entries: [{ path: 'textures/a.dds', hash: 'E' }],
};

const SOURCES: ReadonlyMap<string, string> = new Map([['ModA', '/instance/source/ModA'], ['ModB', '/instance/source/Old ModB']]);

const fakeAdapter = (answers: InstanceAnswers = {}) => fakeInstanceAdapter(readingFixture(), answers).adapter;
const recording = (files: readonly InstallationFile[]): FileRead<readonly InstallationFile[]> => ({ kind: 'read', answer: files });
const unreadable = (reason: string): FileRead<readonly InstallationFile[]> => ({ kind: 'unreadable', reason });

const BUILT = { landed: [{ mod: 'ModA', compiled: [], refused: [], archivesRefused: [], overwritten: [] }], refused: [] };

describe('sourceCommands build', () => {
  it('hands mEdit each mod with the source folder that builds it, its folder, its installation files and the files the repository commits itself, the release\'s archive variants and the stat cache\'s folder', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', BUILT);
    const adapter = fakeAdapter({ installations: new Map([['ModA', recording([INSTALLED])]]), versions: new Map([['ModA', '1.2.3']]) });

    await sourceCommands({ client, adapter }).build(['ModA', 'ModB'], 'Fallout4', SOURCES);

    const ba2 = { ba2: { version: 1, compressed: true } };
    expect(client.calls).toEqual([{
      method: 'build',
      args: [[
        { name: 'ModA', sourceFolder: '/instance/source/ModA', folder: '/mods/ModA', installationFiles: [INSTALLED], committedFiles: ['meta.ini'], version: '1.2.3' },
        { name: 'ModB', sourceFolder: '/instance/source/Old ModB', folder: '/mods/ModB', installationFiles: [], committedFiles: ['meta.ini'] },
      ], { excludedSuffix: '.excluded', archives: { general: ba2, textures: ba2 }, statCache: '/instance/stat-cache' }],
    }]);
  });

  it('hands mEdit no archive variant for a release the table names none for', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', BUILT);

    await sourceCommands({ client, adapter: fakeAdapter() }).build(['ModA'], undefined, SOURCES);

    expect(client.calls.map((call) => call.args[1])).toEqual([{ excludedSuffix: '.excluded', archives: null, statCache: '/instance/stat-cache' }]);
  });

  it('refuses a mod no repository builds, or whose installation files cannot be answered, naming why, and builds the rest', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', BUILT);
    const adapter = fakeAdapter({ installations: new Map([['ModB', unreadable('its installation file is not indexed')]]) });

    const outcome = await sourceCommands({ client, adapter }).build(['ModA', 'ModB', 'ModC'], 'Fallout4', SOURCES);

    expect(client.calls).toEqual([{ method: 'build', args: [[expect.objectContaining({ name: 'ModA' })], expect.anything()] }]);
    expect(outcome).toEqual({
      ...BUILT,
      refused: [{ item: 'ModB', reason: 'its installation file is not indexed' }, { item: 'ModC', reason: 'no repository in the source folder builds it' }],
    });
  });
});

describe('sourceCommands decompileAndCommit', () => {
  it('hands mEdit each mod with the source folder decompile and commit makes its repository in, the installation files the mod manager records and its own files in the mod folder', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('init', { landed: [{ mod: 'ModA', plugins: [] }, { mod: 'ModB', plugins: [] }], refused: [] });
    const adapter = fakeAdapter({ installations: new Map([['ModA', recording([INSTALLED])]]) });

    await sourceCommands({ client, adapter }).decompileAndCommit(['ModA', 'ModB']);

    expect(client.calls).toEqual([{
      method: 'init',
      args: [[
        { name: 'ModA', sourceFolder: '/source/ModA', installationFiles: [INSTALLED], modManagerFiles: ['meta.ini'] },
        { name: 'ModB', sourceFolder: '/source/ModB', installationFiles: [], modManagerFiles: ['meta.ini'] },
      ], {}],
    }]);
  });

  it('refuses a mod whose installation files cannot be answered, naming why, and decompiles and commits the rest', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('init', { landed: [{ mod: 'ModB', plugins: [] }], refused: [] });
    const adapter = fakeAdapter({ installations: new Map([['ModA', unreadable('its installation file is not indexed')]]) });

    const outcome = await sourceCommands({ client, adapter }).decompileAndCommit(['ModA', 'ModB']);

    expect(client.calls.map((call) => call.args[0])).toEqual([[{ name: 'ModB', sourceFolder: '/source/ModB', installationFiles: [], modManagerFiles: ['meta.ini'] }]]);
    expect(outcome).toEqual({ landed: [{ mod: 'ModB', plugins: [] }], refused: [{ item: 'ModA', reason: 'its installation file is not indexed' }] });
  });

  it('reports the phase of reading each mod\'s installation files, naming the mod, while the Instance adapter reads them', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('init', { landed: [], refused: [] });
    const happened: unknown[] = [];
    const adapter = fakeAdapter();
    const reading = { ...adapter, installationFiles: (mod: string) => { happened.push(`read ${mod}`); return adapter.installationFiles(mod); } };

    await sourceCommands({ client, adapter: reading }).decompileAndCommit(['ModA', 'ModB'], { onProgress: (status) => happened.push(status) });

    const phase = (mod: string) => ({ mod, phase: 'ReadingInstallationFiles' });
    expect(happened).toEqual([phase('ModA'), 'read ModA', phase('ModB'), 'read ModB']);
  });

  it('refuses a mod whose name gives it no source folder, naming why', async () => {
    const client = new InMemoryMEditClient();

    const outcome = await sourceCommands({ client, adapter: fakeAdapter({ unsourcedMods: new Set(['Mods/ModA']) }) }).decompileAndCommit(['Mods/ModA']);

    expect(client.calls).toEqual([]);
    expect(outcome).toEqual({ landed: [], refused: [{ item: 'Mods/ModA', reason: 'its name gives it no source folder' }] });
  });

  it('calls mEdit with nothing when no mod\'s installation files can be answered', async () => {
    const client = new InMemoryMEditClient();
    const adapter = fakeAdapter({ installations: new Map([['ModA', unreadable('not indexed')]]) });

    const outcome = await sourceCommands({ client, adapter }).decompileAndCommit(['ModA']);

    expect(client.calls).toEqual([]);
    expect(outcome).toEqual({ landed: [], refused: [{ item: 'ModA', reason: 'not indexed' }] });
  });
});
