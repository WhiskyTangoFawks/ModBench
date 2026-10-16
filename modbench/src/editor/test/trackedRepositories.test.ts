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

import { trackedRepositoriesOver } from '../trackedRepositories';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { pluginMetadataFixture } from '../../client/test/fixtures';

describe('trackedRepositoriesOver', () => {
  const OTHER_IN_MODB = [{ name: 'Other.esp', origin: 'ModB' }];

  function setup(
    status: () => Promise<unknown> = () => Promise.resolve(),
    { plugins = OTHER_IN_MODB, trackedMods = ['ModB'], sourceDirs = { ModB: '/source/ModB' }, open = () => Promise.resolve({ status }) }: {
      plugins?: readonly { name: string; origin: string }[];
      trackedMods?: readonly string[];
      sourceDirs?: Record<string, string>;
      open?: (uri: { fsPath: string }) => Promise<unknown>;
    } = {},
  ) {
    openRepository.mockReset().mockImplementation(open);
    getExtension.mockReset().mockReturnValue({ isActive: true, exports: { getAPI: () => ({ openRepository }) } });
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', plugins.map((plugin) => pluginMetadataFixture(plugin)));
    const outputChannel = { warn: vi.fn(), error: vi.fn() };
    const tracked = trackedRepositoriesOver({
      client, outputChannel,
      modOfOrigin: modOfOriginIn(...Object.keys(sourceDirs), ...trackedMods),
      trackedMods: () => new Set(trackedMods), sourceDirs: () => new Map(Object.entries(sourceDirs)),
    });
    return { tracked, outputChannel };
  }

  it('registers the tracked repository once per notice', async () => {
    const { tracked, outputChannel } = setup();

    await tracked.registerRepositories();

    expect(openRepository).toHaveBeenCalledOnce();
    expect(outputChannel.error).not.toHaveBeenCalled();
  });

  it('refreshes the repository a registration held for the plugin, and no other', async () => {
    const status = vi.fn(() => Promise.resolve());
    const { tracked } = setup(status);
    await tracked.registerRepositories();

    tracked.refreshSourceControlFor({ name: 'Other.esp', origin: 'ModB' });
    tracked.refreshSourceControlFor({ name: 'Other.esp', origin: 'ModC' });

    expect(status).toHaveBeenCalledOnce();
  });

  it('refreshes nothing before any registration', () => {
    const status = vi.fn(() => Promise.resolve());
    const { tracked } = setup(status);

    tracked.refreshSourceControlFor({ name: 'Other.esp', origin: 'ModB' });

    expect(status).not.toHaveBeenCalled();
  });

  it('logs a rejected status and does not surface it', async () => {
    const { tracked, outputChannel } = setup(() => Promise.reject(new Error('boom')));
    await tracked.registerRepositories();

    tracked.refreshSourceControlFor({ name: 'Other.esp', origin: 'ModB' });
    await vi.waitFor(() => { expect(outputChannel.error).toHaveBeenCalledOnce(); });
  });

  it('warns and registers nothing when vscode.git is absent', async () => {
    const { tracked, outputChannel } = setup();
    getExtension.mockReturnValue(undefined);

    await tracked.registerRepositories();

    expect(outputChannel.warn).toHaveBeenCalledOnce();
    expect(openRepository).not.toHaveBeenCalled();
  });

  it('opens the folder of a tracked origin and none for its untracked sibling', async () => {
    const { tracked } = setup(undefined, {
      plugins: [{ name: 'Tracked.esp', origin: 'TrackedMod' }, { name: 'Untracked.esp', origin: 'UntrackedMod' }],
      trackedMods: ['TrackedMod'], sourceDirs: { TrackedMod: '/source/TrackedMod', UntrackedMod: '/source/UntrackedMod' },
    });

    await tracked.registerRepositories();

    expect(openRepository.mock.calls).toEqual([[{ fsPath: '/source/TrackedMod' }]]);
  });

  it('opens the folder of a tracked mod whatever the case of the origin that names it', async () => {
    const { tracked } = setup(undefined, { plugins: [{ name: 'Tracked.esp', origin: 'trackedmod' }], trackedMods: ['TrackedMod'], sourceDirs: { TrackedMod: '/source/TrackedMod' } });

    await tracked.registerRepositories();

    expect(openRepository.mock.calls).toEqual([[{ fsPath: '/source/TrackedMod' }]]);
  });

  it('opens a folder once for two plugins sharing it, and refreshes the one repository for either', async () => {
    const status = vi.fn(() => Promise.resolve());
    const { tracked } = setup(status, {
      plugins: [{ name: 'A.esp', origin: 'SharedMod' }, { name: 'B.esp', origin: 'SharedMod' }],
      trackedMods: ['SharedMod'], sourceDirs: { SharedMod: '/source/SharedMod' },
    });
    await tracked.registerRepositories();

    tracked.refreshSourceControlFor({ name: 'A.esp', origin: 'SharedMod' });
    tracked.refreshSourceControlFor({ name: 'B.esp', origin: 'SharedMod' });

    expect(openRepository).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledTimes(2);
  });

  it('keeps two same-name plugins from different mods apart, each refreshing its own mod\'s repository', async () => {
    const statusA = vi.fn(() => Promise.resolve());
    const statusB = vi.fn(() => Promise.resolve());
    const { tracked } = setup(undefined, {
      plugins: [{ name: 'Shared.esp', origin: 'ModA' }, { name: 'Shared.esp', origin: 'ModB' }],
      trackedMods: ['ModA', 'ModB'], sourceDirs: { ModA: '/source/ModA', ModB: '/source/ModB' },
      open: ({ fsPath }) => Promise.resolve({ status: fsPath === '/source/ModA' ? statusA : statusB }),
    });
    await tracked.registerRepositories();

    tracked.refreshSourceControlFor({ name: 'Shared.esp', origin: 'ModA' });

    expect(statusA).toHaveBeenCalledOnce();
    expect(statusB).not.toHaveBeenCalled();
  });

  it('refreshes nothing for a plugin whose folder vscode.git declined to open', async () => {
    const status = vi.fn(() => Promise.resolve());
    const { tracked, outputChannel } = setup(status, { open: () => Promise.resolve(null) });
    await tracked.registerRepositories();

    tracked.refreshSourceControlFor({ name: 'Other.esp', origin: 'ModB' });

    expect(status).not.toHaveBeenCalled();
    expect(outputChannel.error).not.toHaveBeenCalled();
  });
});
