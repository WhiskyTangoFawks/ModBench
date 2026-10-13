import { describe, it, expect } from 'vitest';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { FileRead, InstallationFile } from '../../instanceAdapter/instanceAdapter';
import { sourceCommands } from '../sourceCommands';

const INSTALLED: InstallationFile = {
  path: '/downloads/ModA-1.0.7z', size: 10, hash: 'H', entries: [{ path: 'textures/a.dds', hash: 'E' }],
};

const SOURCES: ReadonlyMap<string, string> = new Map([['ModA', '/instance/source/ModA'], ['ModB', '/instance/source/Old ModB']]);

const recording = (answers: Record<string, FileRead<readonly InstallationFile[]>>) => ({
  installationFiles: (mod: string) => Promise.resolve(answers[mod] ?? { kind: 'read' as const, answer: [] }),
  managerFilesInModFolder: ['meta.ini'],
  sourceFolder: (mod: string) => (mod.includes('/') ? undefined : `/instance/source/${mod}`),
  sourceMods: () => Promise.resolve({ folders: SOURCES, folderOf: (mod: string) => SOURCES.get(mod), notes: [] }),
  modFolderPath: (mod: string) => Promise.resolve(mod.includes('/') ? undefined : `/instance/mods/${mod}`),
  excludedSuffix: '.excluded',
});

const BUILT = { landed: [{ mod: 'ModA', compiled: [], refused: [], archivesRefused: [], overwritten: [] }], refused: [] };

describe('sourceCommands build', () => {
  it('hands mEdit each mod with the source folder that builds it, its folder and its installation files, and the release\'s archive variants', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', BUILT);

    await sourceCommands({ client, adapter: recording({ ModA: { kind: 'read', answer: [INSTALLED] } }) }).build(['ModA', 'ModB'], 'Fallout4');

    const ba2 = { ba2: { version: 1, compressed: true } };
    expect(client.calls).toEqual([{
      method: 'build',
      args: [[
        { name: 'ModA', sourceFolder: '/instance/source/ModA', folder: '/instance/mods/ModA', installationFiles: [INSTALLED] },
        { name: 'ModB', sourceFolder: '/instance/source/Old ModB', folder: '/instance/mods/ModB', installationFiles: [] },
      ], { excludedSuffix: '.excluded', archives: { general: ba2, textures: ba2 } }],
    }]);
  });

  it('hands mEdit no archive variant for a release the table names none for', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', BUILT);

    await sourceCommands({ client, adapter: recording({}) }).build(['ModA'], undefined);

    expect(client.calls.map((call) => call.args[1])).toEqual([{ excludedSuffix: '.excluded', archives: null }]);
  });

  it('refuses a mod no repository builds, or whose installation files cannot be answered, naming why, and builds the rest', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', BUILT);
    const adapter = recording({ ModB: { kind: 'unreadable', reason: 'its installation file is not indexed' } });

    const outcome = await sourceCommands({ client, adapter }).build(['ModA', 'ModB', 'ModC'], 'Fallout4');

    expect(client.calls).toEqual([{ method: 'build', args: [[expect.objectContaining({ name: 'ModA' })], expect.anything()] }]);
    expect(outcome).toEqual({
      ...BUILT,
      refused: [{ item: 'ModB', reason: 'its installation file is not indexed' }, { item: 'ModC', reason: 'no repository in the source folder builds it' }],
    });
  });
});

describe('sourceCommands init', () => {
  it('hands mEdit each mod with the source folder init makes its repository in, the installation files the mod manager records and its own files in the mod folder', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('init', { landed: [{ mod: 'ModA', plugins: [] }, { mod: 'ModB', plugins: [] }], refused: [] });

    await sourceCommands({ client, adapter: recording({ ModA: { kind: 'read', answer: [INSTALLED] } }) }).init(['ModA', 'ModB']);

    expect(client.calls).toEqual([{
      method: 'init',
      args: [[
        { name: 'ModA', sourceFolder: '/instance/source/ModA', installationFiles: [INSTALLED], modManagerFiles: ['meta.ini'] },
        { name: 'ModB', sourceFolder: '/instance/source/ModB', installationFiles: [], modManagerFiles: ['meta.ini'] },
      ], {}],
    }]);
  });

  it('refuses a mod whose installation files cannot be answered, naming why, and inits the rest', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('init', { landed: [{ mod: 'ModB', plugins: [] }], refused: [] });
    const adapter = recording({ ModA: { kind: 'unreadable', reason: 'its installation file is not indexed' } });

    const outcome = await sourceCommands({ client, adapter }).init(['ModA', 'ModB']);

    expect(client.calls.map((call) => call.args[0])).toEqual([[{ name: 'ModB', sourceFolder: '/instance/source/ModB', installationFiles: [], modManagerFiles: ['meta.ini'] }]]);
    expect(outcome).toEqual({ landed: [{ mod: 'ModB', plugins: [] }], refused: [{ item: 'ModA', reason: 'its installation file is not indexed' }] });
  });

  it('refuses a mod whose name gives it no source folder, naming why', async () => {
    const client = new InMemoryMEditClient();

    const outcome = await sourceCommands({ client, adapter: recording({}) }).init(['Mods/ModA']);

    expect(client.calls).toEqual([]);
    expect(outcome).toEqual({ landed: [], refused: [{ item: 'Mods/ModA', reason: 'its name gives it no source folder' }] });
  });

  it('calls mEdit with nothing when no mod\'s installation files can be answered', async () => {
    const client = new InMemoryMEditClient();
    const adapter = recording({ ModA: { kind: 'unreadable', reason: 'not indexed' } });

    const outcome = await sourceCommands({ client, adapter }).init(['ModA']);

    expect(client.calls).toEqual([]);
    expect(outcome).toEqual({ landed: [], refused: [{ item: 'ModA', reason: 'not indexed' }] });
  });
});
