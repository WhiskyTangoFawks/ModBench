import { describe, it, expect } from 'vitest';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { FileRead, InstallationFile } from '../../instanceAdapter/instanceAdapter';
import { sourceCommands } from '../sourceCommands';

const INSTALLED: InstallationFile = {
  path: '/downloads/ModA-1.0.7z', size: 10, hash: 'H', entries: [{ path: 'textures/a.dds', hash: 'E' }],
};

const recording = (answers: Record<string, FileRead<readonly InstallationFile[]>>) => ({
  installationFiles: (mod: string) => Promise.resolve(answers[mod] ?? { kind: 'read' as const, answer: [] }),
  managerFilesInModFolder: ['meta.ini'],
});

describe('sourceCommands build', () => {
  it('fires mEdit\'s build with the mods', async () => {
    const client = new InMemoryMEditClient();
    const outcome = { landed: [{ mod: 'ModA', compiled: [], refused: [] }], refused: [] };
    client.setCommandResult('build', outcome);

    await sourceCommands({ client, adapter: recording({}) }).build(['ModA', 'ModB']);

    expect(client.calls).toEqual([{ method: 'build', args: [['ModA', 'ModB']] }]);
  });
});

describe('sourceCommands init', () => {
  it('hands mEdit each mod with the installation files the mod manager records and its own files in the mod folder', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('init', { landed: [{ mod: 'ModA', plugins: [] }, { mod: 'ModB', plugins: [] }], refused: [] });

    await sourceCommands({ client, adapter: recording({ ModA: { kind: 'read', answer: [INSTALLED] } }) }).init(['ModA', 'ModB']);

    expect(client.calls).toEqual([{
      method: 'init',
      args: [[
        { name: 'ModA', installationFiles: [INSTALLED], modManagerFiles: ['meta.ini'] },
        { name: 'ModB', installationFiles: [], modManagerFiles: ['meta.ini'] },
      ], {}],
    }]);
  });

  it('refuses a mod whose installation files cannot be answered, naming why, and inits the rest', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('init', { landed: [{ mod: 'ModB', plugins: [] }], refused: [] });
    const adapter = recording({ ModA: { kind: 'unreadable', reason: 'its installation file is not indexed' } });

    const outcome = await sourceCommands({ client, adapter }).init(['ModA', 'ModB']);

    expect(client.calls.map((call) => call.args[0])).toEqual([[{ name: 'ModB', installationFiles: [], modManagerFiles: ['meta.ini'] }]]);
    expect(outcome).toEqual({ landed: [{ mod: 'ModB', plugins: [] }], refused: [{ item: 'ModA', reason: 'its installation file is not indexed' }] });
  });

  it('calls mEdit with nothing when no mod\'s installation files can be answered', async () => {
    const client = new InMemoryMEditClient();
    const adapter = recording({ ModA: { kind: 'unreadable', reason: 'not indexed' } });

    const outcome = await sourceCommands({ client, adapter }).init(['ModA']);

    expect(client.calls).toEqual([]);
    expect(outcome).toEqual({ landed: [], refused: [{ item: 'ModA', reason: 'not indexed' }] });
  });
});
