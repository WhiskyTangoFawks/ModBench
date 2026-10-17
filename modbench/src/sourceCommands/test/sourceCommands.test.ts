import { describe, it, expect } from 'vitest';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { fakeInstanceAdapter, readingFixture, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { sourceCommands } from '../sourceCommands';

const SOURCES: ReadonlyMap<string, string> = new Map([['ModA', '/instance/source/ModA'], ['ModB', '/instance/source/Old ModB']]);

const fakeAdapter = (answers: InstanceAnswers = {}) => fakeInstanceAdapter(readingFixture(), answers).adapter;

const BUILT = { landed: [{ mod: 'ModA', compiled: [], refused: [], archivesRefused: [], overwritten: [] }], refused: [] };

describe('sourceCommands build', () => {
  it('hands mEdit each mod with the source folder that builds it, its folder and its metadata files, the release\'s archive variants and the stat cache\'s folder', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', BUILT);
    const adapter = fakeAdapter({ metadata: new Map([['ModA', { version: '1.2.3' }]]) });

    await sourceCommands({ client, adapter }).build(['ModA', 'ModB'], 'Fallout4', SOURCES);

    const ba2 = { ba2: { version: 1, compressed: true } };
    expect(client.calls).toEqual([{
      method: 'build',
      args: [[
        { name: 'ModA', sourceFolder: '/instance/source/ModA', folder: '/mods/ModA', metadataFiles: ['meta.ini'], version: '1.2.3' },
        { name: 'ModB', sourceFolder: '/instance/source/Old ModB', folder: '/mods/ModB', metadataFiles: ['meta.ini'] },
      ], { excludedSuffix: '.excluded', archives: { general: ba2, textures: ba2 }, statCache: '/instance/stat-cache' }],
    }]);
  });

  it('refuses a mod whose metadata cannot be read, naming why, and builds the rest', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', BUILT);
    const adapter = fakeAdapter({ unreadableMetadata: new Map([['ModA', 'EISDIR: meta.ini']]) });

    const outcome = await sourceCommands({ client, adapter }).build(['ModA', 'ModB'], undefined, SOURCES);

    expect(client.calls).toMatchObject([{ args: [[{ name: 'ModB' }], expect.anything()] }]);
    expect(outcome).toMatchObject({ refused: [{ item: 'ModA', reason: 'its metadata could not be read: EISDIR: meta.ini' }] });
  });

  it('hands mEdit no archive variant for a release the table names none for', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', BUILT);

    await sourceCommands({ client, adapter: fakeAdapter() }).build(['ModA'], undefined, SOURCES);

    expect(client.calls.map((call) => call.args[1])).toEqual([{ excludedSuffix: '.excluded', archives: null, statCache: '/instance/stat-cache' }]);
  });

  it('refuses a mod no repository builds, naming why, and builds the rest', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', BUILT);

    const outcome = await sourceCommands({ client, adapter: fakeAdapter() }).build(['ModA', 'ModC'], 'Fallout4', SOURCES);

    expect(client.calls).toEqual([{ method: 'build', args: [[expect.objectContaining({ name: 'ModA' })], expect.anything()] }]);
    expect(outcome).toEqual({
      ...BUILT,
      refused: [{ item: 'ModC', reason: 'no repository in the source folder builds it' }],
    });
  });
});

describe('sourceCommands decompileAndCommit', () => {
  it('hands mEdit each mod with the source folder decompile and commit makes its repository in and the mod manager\'s own files in the mod folder', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('init', { landed: [{ mod: 'ModA', plugins: [] }, { mod: 'ModB', plugins: [] }], refused: [] });

    await sourceCommands({ client, adapter: fakeAdapter() }).decompileAndCommit(['ModA', 'ModB']);

    expect(client.calls).toEqual([{
      method: 'init',
      args: [[
        { name: 'ModA', sourceFolder: '/source/ModA', metadataFiles: ['meta.ini'] },
        { name: 'ModB', sourceFolder: '/source/ModB', metadataFiles: ['meta.ini'] },
      ], {}],
    }]);
  });

  it('refuses a mod whose name gives it no source folder, naming why', async () => {
    const client = new InMemoryMEditClient();

    const outcome = await sourceCommands({ client, adapter: fakeAdapter({ unsourcedMods: new Set(['Mods/ModA']) }) }).decompileAndCommit(['Mods/ModA']);

    expect(client.calls).toEqual([]);
    expect(outcome).toEqual({ landed: [], refused: [{ item: 'Mods/ModA', reason: 'its name gives it no source folder' }] });
  });
});
