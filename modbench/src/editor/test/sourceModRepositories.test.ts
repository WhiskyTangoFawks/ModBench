import { describe, it, expect, vi } from 'vitest';
import { modOfOriginIn } from '../../test/mo2/instanceValueFixture';

const { getExtension, openRepository } = vi.hoisted(() => ({
  getExtension: vi.fn(),
  openRepository: vi.fn(),
}));

vi.mock('vscode', () => ({
  extensions: { getExtension },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
}));

import { sourceModRepositoriesOver } from '../sourceModRepositories';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { pluginMetadataFixture } from '../../client/test/fixtures';

describe('sourceModRepositoriesOver', () => {
  const OTHER_IN_MODB = [{ name: 'Other.esp', origin: 'ModB' }];

  function setup(
    status: () => Promise<unknown> = () => Promise.resolve(),
    { plugins = OTHER_IN_MODB, listedSourceMods = ['ModB'], sourceDirs = { ModB: '/source/ModB' }, open = () => Promise.resolve({ status }) }: {
      plugins?: readonly { name: string; origin: string }[];
      listedSourceMods?: readonly string[];
      sourceDirs?: Record<string, string>;
      open?: (uri: { fsPath: string }) => Promise<unknown>;
    } = {},
  ) {
    openRepository.mockReset().mockImplementation(open);
    getExtension.mockReset().mockReturnValue({ isActive: true, exports: { getAPI: () => ({ openRepository }) } });
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', plugins.map((plugin) => pluginMetadataFixture(plugin)));
    const outputChannel = { warn: vi.fn(), error: vi.fn() };
    const sourcePlugin = sourceModRepositoriesOver({
      client, outputChannel,
      modOfOrigin: modOfOriginIn(...Object.keys(sourceDirs), ...listedSourceMods),
      listedSourceMods: () => new Set(listedSourceMods), sourceDirs: () => new Map(Object.entries(sourceDirs)),
    });
    return { sourcePlugin, outputChannel };
  }

  it('registers the source mod repository once per notice', async () => {
    const { sourcePlugin, outputChannel } = setup();

    await sourcePlugin.registerRepositories();

    expect(openRepository).toHaveBeenCalledOnce();
    expect(outputChannel.error).not.toHaveBeenCalled();
  });

  it('refreshes the repository a registration held for the plugin, and no other', async () => {
    const status = vi.fn(() => Promise.resolve());
    const { sourcePlugin } = setup(status);
    await sourcePlugin.registerRepositories();

    sourcePlugin.refreshSourceControlFor({ name: 'Other.esp', origin: 'ModB' });
    sourcePlugin.refreshSourceControlFor({ name: 'Other.esp', origin: 'ModC' });

    expect(status).toHaveBeenCalledOnce();
  });

  it('refreshes nothing before any registration', () => {
    const status = vi.fn(() => Promise.resolve());
    const { sourcePlugin } = setup(status);

    sourcePlugin.refreshSourceControlFor({ name: 'Other.esp', origin: 'ModB' });

    expect(status).not.toHaveBeenCalled();
  });

  it('logs a rejected status and does not surface it', async () => {
    const { sourcePlugin, outputChannel } = setup(() => Promise.reject(new Error('boom')));
    await sourcePlugin.registerRepositories();

    sourcePlugin.refreshSourceControlFor({ name: 'Other.esp', origin: 'ModB' });
    await vi.waitFor(() => { expect(outputChannel.error).toHaveBeenCalledOnce(); });
  });

  it('warns and registers nothing when vscode.git is absent', async () => {
    const { sourcePlugin, outputChannel } = setup();
    getExtension.mockReturnValue(undefined);

    await sourcePlugin.registerRepositories();

    expect(outputChannel.warn).toHaveBeenCalledOnce();
    expect(openRepository).not.toHaveBeenCalled();
  });

  it('opens the folder of a source plugin origin and none for its non-source plugin sibling', async () => {
    const { sourcePlugin } = setup(undefined, {
      plugins: [{ name: 'SourcePlugin.esp', origin: 'SourceMod' }, { name: 'NonSourcePlugin.esp', origin: 'NonSourceMod' }],
      listedSourceMods: ['SourceMod'], sourceDirs: { SourceMod: '/source/SourceMod', NonSourceMod: '/source/NonSourceMod' },
    });

    await sourcePlugin.registerRepositories();

    expect(openRepository.mock.calls).toEqual([[{ fsPath: '/source/SourceMod' }]]);
  });

  it('opens the folder of a source mod whatever the case of the origin that names it', async () => {
    const { sourcePlugin } = setup(undefined, { plugins: [{ name: 'SourcePlugin.esp', origin: 'sourcemod' }], listedSourceMods: ['SourceMod'], sourceDirs: { SourceMod: '/source/SourceMod' } });

    await sourcePlugin.registerRepositories();

    expect(openRepository.mock.calls).toEqual([[{ fsPath: '/source/SourceMod' }]]);
  });

  it('opens a folder once for two plugins sharing it, and refreshes the one repository for either', async () => {
    const status = vi.fn(() => Promise.resolve());
    const { sourcePlugin } = setup(status, {
      plugins: [{ name: 'A.esp', origin: 'SharedMod' }, { name: 'B.esp', origin: 'SharedMod' }],
      listedSourceMods: ['SharedMod'], sourceDirs: { SharedMod: '/source/SharedMod' },
    });
    await sourcePlugin.registerRepositories();

    sourcePlugin.refreshSourceControlFor({ name: 'A.esp', origin: 'SharedMod' });
    sourcePlugin.refreshSourceControlFor({ name: 'B.esp', origin: 'SharedMod' });

    expect(openRepository).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledTimes(2);
  });

  it('keeps two same-name plugins from different mods apart, each refreshing its own mod\'s repository', async () => {
    const statusA = vi.fn(() => Promise.resolve());
    const statusB = vi.fn(() => Promise.resolve());
    const { sourcePlugin } = setup(undefined, {
      plugins: [{ name: 'Shared.esp', origin: 'ModA' }, { name: 'Shared.esp', origin: 'ModB' }],
      listedSourceMods: ['ModA', 'ModB'], sourceDirs: { ModA: '/source/ModA', ModB: '/source/ModB' },
      open: ({ fsPath }) => Promise.resolve({ status: fsPath === '/source/ModA' ? statusA : statusB }),
    });
    await sourcePlugin.registerRepositories();

    sourcePlugin.refreshSourceControlFor({ name: 'Shared.esp', origin: 'ModA' });

    expect(statusA).toHaveBeenCalledOnce();
    expect(statusB).not.toHaveBeenCalled();
  });

  it('refreshes nothing for a plugin whose folder vscode.git declined to open', async () => {
    const status = vi.fn(() => Promise.resolve());
    const { sourcePlugin, outputChannel } = setup(status, { open: () => Promise.resolve(null) });
    await sourcePlugin.registerRepositories();

    sourcePlugin.refreshSourceControlFor({ name: 'Other.esp', origin: 'ModB' });

    expect(status).not.toHaveBeenCalled();
    expect(outputChannel.error).not.toHaveBeenCalled();
  });
});
