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

const { uninstallMod } = vi.hoisted(() => ({ uninstallMod: vi.fn() }));

vi.mock('./commands/modlist', () => ({
  createEmptyMod: vi.fn(), deleteSeparator: vi.fn(), insertSeparator: vi.fn(),
  moveModToSeparator: vi.fn(), renameSeparator: vi.fn(), uninstallMod,
}));

import { registerModContextCommands, registerModInstallCommands, type ModInstallDeps } from './modManagementCommands';
import { ModNode } from './ModListProvider';
import { scriptedDialog } from '../test/surfacingDoubles';
import { instanceValueFixture } from './test/instanceValueFixture';

function invoke(commandId: string, ...args: unknown[]): Promise<unknown> {
  const call = registerCommand.mock.calls.find((c) => c[0] === commandId);
  if (!call) throw new Error(`command not registered: ${commandId}`);
  return Promise.resolve(call[1](...args));
}

function deps(over: Partial<ModInstallDeps> = {}): ModInstallDeps {
  return {
    instanceRoot: '/instance',
    instance: { value: instanceValueFixture() },
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


// Uninstall is the Mods tree's one destructive gesture, so the modal it asks and what a cancel
// leaves untouched are the behaviour worth pinning (ADR-0019's dialog seam).
describe('registerModContextCommands: the uninstall confirmation', () => {
  beforeEach(() => vi.clearAllMocks());

  const instance = { value: instanceValueFixture({ activeProfile: 'Default' }) };
  const modNode = new ModNode({ kind: 'mod', name: 'My Mod', enabled: true, archiveFilename: 'my-mod.7z' });
  const runModAction = async (_label: string, _fail: string, action: () => Promise<void>) => action();

  it('asks one modal naming the mod, then deletes the folder once it is confirmed', async () => {
    uninstallMod.mockResolvedValueOnce({ applied: true });
    const ask = scriptedDialog('Uninstall');

    registerModContextCommands('/instance', instance, runModAction, ask);
    await invoke('modbench.modList.mod.uninstall', modNode);

    expect(ask.asked).toEqual([{
      message: 'Uninstall "My Mod"? This will permanently delete the mod folder from disk.',
      detail: undefined,
      buttons: ['Uninstall'],
    }]);
    expect(uninstallMod).toHaveBeenCalledWith('/instance', 'Default', 'My Mod', 'my-mod.7z');
  });

  it('uninstalls nothing when the modal is dismissed', async () => {
    uninstallMod.mockResolvedValue({ applied: true }); // so a lost guard would get all the way through

    registerModContextCommands('/instance', instance, runModAction, scriptedDialog(undefined));
    await invoke('modbench.modList.mod.uninstall', modNode);

    expect(uninstallMod).not.toHaveBeenCalled();
  });
});
