import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, uriFile } from '../test/vscodeMock';

const { registerCommand, showOpenDialog } = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler })),
  showOpenDialog: vi.fn(),
}));

vi.mock('vscode', () => ({
  commands: { registerCommand },
  window: { showOpenDialog },
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  Uri: { file: uriFile },
}));

const { installFromArchive, installFromFolder } = vi.hoisted(() => ({
  installFromArchive: vi.fn(),
  installFromFolder: vi.fn(),
}));

vi.mock('./commands/install', () => ({ installFromArchive, installFromFolder }));

import { registerModInstallCommands, type ModInstallDeps } from './modManagementCommands';

function invoke(commandId: string, ...args: unknown[]): Promise<unknown> {
  const call = registerCommand.mock.calls.find((c) => c[0] === commandId);
  if (!call) throw new Error(`command not registered: ${commandId}`);
  return call[1](...args) as Promise<unknown>;
}

function deps(over: Partial<ModInstallDeps> = {}): ModInstallDeps {
  return {
    instanceRoot: '/instance',
    instance: { value: { mods: [] } } as unknown as ModInstallDeps['instance'],
    runModAction: async (_label, _fail, action) => action(),
    promptModName: vi.fn(),
    warnIfFomod: vi.fn(),
    ...over,
  };
}

describe('registerModInstallCommands: the install target', () => {
  beforeEach(() => vi.clearAllMocks());

  it('an upgrade choice bypasses the name prompt and installs as an upgrade of that mod', async () => {
    const promptModName = vi.fn();
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    registerModInstallCommands(deps({ promptModName }));
    const succeeded = await invoke(
      'modbench.modList.installFromArchive', '/archive/foo.7z', '111', '222', '3.0',
      { kind: 'upgrade', name: 'Existing Mod' },
    );

    expect(promptModName).not.toHaveBeenCalled();
    expect(installFromArchive).toHaveBeenCalledWith(
      '/instance', { kind: 'upgrade', name: 'Existing Mod' }, '/archive/foo.7z',
      { modID: '111', fileID: '222', version: '3.0' },
    );
    expect(succeeded).toBe(true);
  });

  it('a new-mod choice reaches the name prompt and installs as a new mod', async () => {
    const promptModName = vi.fn().mockResolvedValueOnce('New Mod');
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    registerModInstallCommands(deps({ promptModName }));
    const succeeded = await invoke('modbench.modList.installFromArchive', '/archive/foo.7z', undefined, undefined, undefined, { kind: 'new' });

    expect(promptModName).toHaveBeenCalledWith('foo', expect.any(Function));
    expect(installFromArchive).toHaveBeenCalledWith(
      '/instance', { kind: 'new', name: 'New Mod' }, '/archive/foo.7z',
      { modID: undefined, fileID: undefined, version: undefined },
    );
    expect(succeeded).toBe(true);
  });

  // Rival: default the absent choice to an upgrade of the prompted name. The Mods-view entry
  // would then adopt any folder that happens to share the name, and this fails.
  it('the Mods-view entry, invoked with no choice, installs as a new mod', async () => {
    const promptModName = vi.fn().mockResolvedValueOnce('New Mod');
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    registerModInstallCommands(deps({ promptModName }));
    const succeeded = await invoke('modbench.modList.installFromArchive', '/archive/foo.7z');

    expect(promptModName).toHaveBeenCalledWith('foo', expect.any(Function));
    expect(installFromArchive).toHaveBeenCalledWith(
      '/instance', { kind: 'new', name: 'New Mod' }, '/archive/foo.7z',
      { modID: undefined, fileID: undefined, version: undefined },
    );
    expect(succeeded).toBe(true);
  });

  it('no choice and a cancelled prompt installs nothing', async () => {
    const promptModName = vi.fn().mockResolvedValueOnce(undefined);

    registerModInstallCommands(deps({ promptModName }));
    const succeeded = await invoke('modbench.modList.installFromArchive', '/archive/foo.7z');

    expect(installFromArchive).not.toHaveBeenCalled();
    expect(succeeded).toBe(false);
  });

  it('the Mods-view folder entry installs as a new mod under the prompted name', async () => {
    const promptModName = vi.fn().mockResolvedValueOnce('New Mod');
    showOpenDialog.mockResolvedValueOnce([{ fsPath: '/somewhere/Loose Files' }]);
    installFromFolder.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    registerModInstallCommands(deps({ promptModName }));
    await invoke('modbench.modList.installFromFolder');

    expect(promptModName).toHaveBeenCalledWith('Loose Files', expect.any(Function));
    expect(installFromFolder).toHaveBeenCalledWith(
      '/instance', { kind: 'new', name: 'New Mod' }, '/somewhere/Loose Files',
    );
  });
});
