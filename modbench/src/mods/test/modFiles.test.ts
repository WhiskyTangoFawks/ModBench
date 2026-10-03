import { describe, it, expect, vi } from 'vitest';
import type { Mod, ModFile, ModlistEntry, OriginFolder } from '../../instanceLoader/instance';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  uriFile, uriFrom, DataTransferItem, DataTransfer, FakeCancellationToken,
} from '../../test/vscodeMock';

const { executeCommand } = vi.hoisted(() => ({ executeCommand: vi.fn((_id: string, ..._args: unknown[]) => Promise.resolve()) }));

vi.mock('vscode', () => ({
  commands: { executeCommand },
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  Uri: { file: uriFile, from: uriFrom }, DataTransferItem, DataTransfer,
}));

import { ModListProvider, ModNode, OverwriteNode, SeparatorNode, type ModlistNode } from '../ModListProvider';
import { FolderNode } from '../modFiles';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { accessTo } from '../../test/mo2/adapterOver';
import { expectInstanceOf } from '../../test/expectInstanceOf';
import { present } from '../../ports/present';

const mod = (name: string, enabled = true): Mod => ({ kind: 'mod', name, enabled });
const file = (relativePath: string, path = `/instance/mods/${relativePath}`, sourcePath = path): ModFile => ({ relativePath, path, sourcePath });

function providerOver(
  mods: ModlistEntry[], filesByMod: Record<string, ModFile[]>, overwriteFiles: ModFile[] = [],
  folders: { byMod?: Record<string, OriginFolder[]>; overwrite?: OriginFolder[] } = {},
): ModListProvider {
  const value = instanceValueFixture({
    mods, filesByMod: new Map(Object.entries(filesByMod)), overwriteFiles,
    foldersByMod: new Map(Object.entries(folders.byMod ?? {})), overwriteFolders: folders.overwrite ?? [],
  });
  return new ModListProvider({ instance: new FakeInstance(value), access: accessTo('/instance'), log: () => undefined });
}

const labelOf = (row: ModlistNode): string => (typeof row.label === 'string' ? row.label : row.label?.label ?? '');
const shown = (rows: readonly ModlistNode[]): string[] => rows.map((row) => `${row.kind} ${labelOf(row)}`);

async function rootOf<T>(provider: ModListProvider, ctor: new (...args: never[]) => T, label: string): Promise<T> {
  return expectInstanceOf((await provider.getChildren()).find((row) => labelOf(row) === label), ctor);
}

async function childNamed(provider: ModListProvider, parent: ModlistNode, label: string): Promise<ModlistNode> {
  return present((await provider.getChildren(parent)).find((row) => labelOf(row) === label), label);
}

const { Collapsed, None } = TreeItemCollapsibleState;

describe('a mod opens into its files as a folder tree (mods.md, The tree, story 7)', () => {
  const armour = [
    file('readme.txt'),
    file('textures/armour/b.dds'),
    file('Armour.esp'),
    file('meshes/armour.nif'),
    file('textures/armour/a.dds'),
    file('textures/icon.dds'),
  ];

  it('folders first, then files, each by name, and a folder opens into its own', async () => {
    const provider = providerOver([mod('Armour')], { Armour: armour });
    const row = await rootOf(provider, ModNode, 'Armour');
    const textures = await childNamed(provider, row, 'textures');

    expect(shown(await provider.getChildren(row))).toEqual(['folder meshes', 'folder textures', 'file Armour.esp', 'file readme.txt']);
    expect(shown(await provider.getChildren(textures))).toEqual(['folder armour', 'file icon.dds']);
    expect(shown(await provider.getChildren(await childNamed(provider, textures, 'armour')))).toEqual(['file a.dds', 'file b.dds']);
  });

  it('by name as the Explorer orders them: case aside, and a number by its value', async () => {
    const provider = providerOver([mod('Armour')], { Armour: [file('b.txt'), file('item10.txt'), file('A.txt'), file('item9.txt')] });

    expect(shown(await provider.getChildren(await rootOf(provider, ModNode, 'Armour'))))
      .toEqual(['file A.txt', 'file b.txt', 'file item9.txt', 'file item10.txt']);
  });

  it('names that differ only in case keep one order whatever order the listing gives', async () => {
    const listed = [file('textures/a.dds'), file('Textures/b.dds'), file('a.txt'), file('A.txt')];
    const rowsFor = async (files: ModFile[]) => {
      const provider = providerOver([mod('Armour')], { Armour: files });
      return shown(await provider.getChildren(await rootOf(provider, ModNode, 'Armour')));
    };

    expect(await rowsFor(listed)).toEqual(['folder Textures', 'folder textures', 'file A.txt', 'file a.txt']);
    expect(await rowsFor([...listed].reverse())).toEqual(['folder Textures', 'folder textures', 'file A.txt', 'file a.txt']);
  });

  it('a mod and each folder start collapsed, so the view opens clean, and a file has no expander', async () => {
    const provider = providerOver([mod('Armour')], { Armour: armour });
    const row = await rootOf(provider, ModNode, 'Armour');
    const children = await provider.getChildren(row);

    expect(row.collapsibleState).toBe(Collapsed);
    expect(children.map((child) => [labelOf(child), child.collapsibleState])).toEqual([
      ['meshes', Collapsed], ['textures', Collapsed], ['Armour.esp', None], ['readme.txt', None],
    ]);
  });

  it('a disabled mod opens too', async () => {
    const provider = providerOver([mod('Off', false)], { Off: [file('Off.esp')] });
    const row = await rootOf(provider, ModNode, 'Off');

    expect(row.collapsibleState).toBe(Collapsed);
    expect(shown(await provider.getChildren(row))).toEqual(['file Off.esp']);
  });

  it('a mod with no files shows no expander', async () => {
    const provider = providerOver([mod('Empty'), mod('Unlisted Folder')], { Empty: [] });

    expect((await rootOf(provider, ModNode, 'Empty')).collapsibleState).toBe(None);
    expect((await rootOf(provider, ModNode, 'Unlisted Folder')).collapsibleState).toBe(None);
  });

  it('a mod inside a separator opens the same', async () => {
    const provider = providerOver([mod('Armour'), { kind: 'separator', name: 'Gear', enabled: false }], { Armour: [file('Armour.esp')] });
    const row = expectInstanceOf((await provider.getChildren(await rootOf(provider, SeparatorNode, 'Gear')))[0], ModNode);

    expect(row.collapsibleState).toBe(Collapsed);
    expect(shown(await provider.getChildren(row))).toEqual(['file Armour.esp']);
  });
});

describe('Overwrite opens into its files', () => {
  it('as a folder tree, collapsed', async () => {
    const provider = providerOver([mod('Armour')], {}, [file('F4SE/Plugins/a.log'), file('Tool.esp')]);
    const row = await rootOf(provider, OverwriteNode, 'Overwrite');

    expect(row.collapsibleState).toBe(Collapsed);
    expect(shown(await provider.getChildren(row))).toEqual(['folder F4SE', 'file Tool.esp']);
  });

  it('holding none, shows no expander', async () => {
    const provider = providerOver([mod('Armour')], { Armour: [file('Armour.esp')] });

    expect((await rootOf(provider, OverwriteNode, 'Overwrite')).collapsibleState).toBe(None);
  });
});

describe('a file or folder row\'s parts (mods.md, A row, File and folder)', () => {
  const linked = file('textures/linked.dds', '/instance/mods/Armour/textures/linked.dds', '/outside/the/mod/real-target.dds');

  async function rowsOf() {
    const provider = providerOver([mod('Armour')], { Armour: [linked] });
    const modRow = await rootOf(provider, ModNode, 'Armour');
    const folder = await childNamed(provider, modRow, 'textures');
    const leaf = await childNamed(provider, folder, 'linked.dds');
    return { folder, leaf };
  }

  it('labels a file and a folder by its name, as the path in its mod has it, even when a link reads it from elsewhere', async () => {
    const { folder, leaf } = await rowsOf();

    expect(labelOf(folder)).toBe('textures');
    expect(labelOf(leaf)).toBe('linked.dds');
  });

  it('gives VS Code the name to take the file icon theme\'s icon from, and overrides no icon', async () => {
    const { folder, leaf } = await rowsOf();

    expect(folder.iconPath).toBeUndefined();
    expect(leaf.iconPath).toBeUndefined();
    expect(folder.resourceUri?.path.split('/').at(-1)).toBe('textures');
    expect(leaf.resourceUri?.path.split('/').at(-1)).toBe('linked.dds');
  });

  it('names its row by no file: URI, so no diagnostic or file decoration published on the file reaches the row', async () => {
    const { folder, leaf } = await rowsOf();

    for (const row of [folder, leaf]) expect(row.resourceUri?.scheme).toMatch(/^(?!file$)\w/);
  });

  it('opens a clicked file as a preview editor where it sits in its mod, a link too, and a clicked folder or mod only selects', async () => {
    const provider = providerOver([mod('Armour')], { Armour: [linked] });
    const modRow = await rootOf(provider, ModNode, 'Armour');
    const folder = await childNamed(provider, modRow, 'textures');
    const leaf = await childNamed(provider, folder, 'linked.dds');

    expect(leaf.command).toMatchObject({ command: 'vscode.open', arguments: [{ fsPath: '/instance/mods/Armour/textures/linked.dds' }, { preview: true }] });
    expect(folder.command).toBeUndefined();
    expect(modRow.command).toBeUndefined();
    expect((await rootOf(provider, OverwriteNode, 'Overwrite')).command).toBeUndefined();
  });

  it('carries where each folder sits as the value names it, by its whole path in its mod, in a mod and in Overwrite', async () => {
    const provider = providerOver([mod('Armour')], { Armour: [file('meshes/textures/a.nif'), file('textures/armour/a.dds')] }, [file('F4SE/a.log')], {
      byMod: { Armour: [
        { relativePath: 'meshes', path: '/instance/mods/Armour/meshes' },
        { relativePath: 'meshes/textures', path: '/instance/mods/Armour/meshes/textures' },
        { relativePath: 'textures', path: '/linked/textures' },
        { relativePath: 'textures/armour', path: '/linked/textures/armour' },
      ] },
      overwrite: [{ relativePath: 'F4SE', path: '/instance/overwrite/F4SE' }],
    });
    const textures = expectInstanceOf(await childNamed(provider, await rootOf(provider, ModNode, 'Armour'), 'textures'), FolderNode);
    const armour = expectInstanceOf(await childNamed(provider, textures, 'armour'), FolderNode);
    const f4se = expectInstanceOf(await childNamed(provider, await rootOf(provider, OverwriteNode, 'Overwrite'), 'F4SE'), FolderNode);

    expect([textures.folder, armour.folder, f4se.folder]).toEqual([
      { relativePath: 'textures', path: '/linked/textures' },
      { relativePath: 'textures/armour', path: '/linked/textures/armour' },
      { relativePath: 'F4SE', path: '/instance/overwrite/F4SE' },
    ]);
  });

  it('shows the path in its mod as the tooltip', async () => {
    const { folder, leaf } = await rowsOf();

    expect(folder.tooltip).toBe('textures');
    expect(leaf.tooltip).toBe('textures/linked.dds');
  });

  it('has no check box and no description', async () => {
    const { folder, leaf } = await rowsOf();

    for (const row of [folder, leaf]) {
      expect(row.checkboxState).toBeUndefined();
      expect(row.description).toBeUndefined();
    }
  });

  it('names its own kind as its contextValue, which the File and Folder menus match on', async () => {
    const { folder, leaf } = await rowsOf();

    expect(folder.contextValue).toBe('folder');
    expect(leaf.contextValue).toBe('file');
  });
});

describe('a file or folder row\'s identity is its mod or Overwrite, and the path in it', () => {
  it('two mods, Overwrite and a mod folder named overwrite holding one path are four rows', async () => {
    const provider = providerOver(
      [mod('A'), mod('B'), mod('overwrite')],
      { A: [file('x/a.dds')], B: [file('x/a.dds')], overwrite: [file('x/a.dds')] },
      [file('x/a.dds')],
    );
    const roots = (await provider.getChildren()).filter((row) => row instanceof ModNode || row instanceof OverwriteNode);
    const folders = await Promise.all(roots.map((row) => childNamed(provider, row, 'x')));
    const leaves = await Promise.all(folders.map((folder) => childNamed(provider, folder, 'a.dds')));
    const ids = [...folders, ...leaves].map((row) => row.id);
    const uris = [...folders, ...leaves].map((row) => row.resourceUri?.path);

    expect(new Set(ids).size).toBe(8);
    expect(new Set(uris).size).toBe(8);
    expect(new Set([...ids, ...roots.map((row) => row.id)]).size).toBe(12);
  });

  it('stays as it was across a new instance value, so selection and expansion survive a change on disk', async () => {
    const instance = new FakeInstance(instanceValueFixture({ mods: [mod('A')], filesByMod: new Map([['A', [file('x/a.dds')]]]) }));
    const provider = new ModListProvider({ instance, access: accessTo('/instance'), log: () => undefined });
    const idsNow = async () => {
      const modRow = await rootOf(provider, ModNode, 'A');
      const folder = await childNamed(provider, modRow, 'x');
      return [folder.id, (await childNamed(provider, folder, 'a.dds')).id];
    };
    const before = await idsNow();

    instance.publish(instanceValueFixture({ mods: [mod('A', false)], filesByMod: new Map([['A', [file('x/a.dds'), file('x/b.dds')]]]) }));

    expect(await idsNow()).toEqual(before);
  });
});

describe('a file or folder row\'s parent, which VS Code\'s reveal walks up through getParent', () => {
  it('is the folder that holds it, then the mod, then the mod\'s separator', async () => {
    const provider = providerOver([mod('Armour'), { kind: 'separator', name: 'Gear', enabled: false }], { Armour: [file('x/a.dds')] });
    const gear = await rootOf(provider, SeparatorNode, 'Gear');
    const modRow = present((await provider.getChildren(gear))[0], 'Armour');
    const folder = await childNamed(provider, modRow, 'x');
    const leaf = await childNamed(provider, folder, 'a.dds');

    expect(provider.getParent(leaf)).toBe(folder);
    expect(provider.getParent(folder)).toBe(modRow);
    expect(provider.getParent(modRow)).toBe(gear);
  });

  it('is Overwrite for a file at its root', async () => {
    const provider = providerOver([], {}, [file('a.log')]);
    const overwrite = await rootOf(provider, OverwriteNode, 'Overwrite');

    expect(provider.getParent(await childNamed(provider, overwrite, 'a.log'))).toBe(overwrite);
  });
});

describe('files and folders are not dragged, and nothing drops on them (mods.md, Drag and drop, story 7)', () => {
  const DND_MIME = 'application/vnd.medit.modlist-node';

  async function fileRows() {
    const provider = providerOver([mod('Armour'), mod('Other')], { Armour: [file('x/a.dds')] });
    const modRow = await rootOf(provider, ModNode, 'Armour');
    const folder = await childNamed(provider, modRow, 'x');
    const leaf = await childNamed(provider, folder, 'a.dds');
    return { provider, modRow, folder, leaf };
  }

  it('a drag of files and folders carries nothing', async () => {
    const { provider, folder, leaf } = await fileRows();
    const dataTransfer = new DataTransfer();

    provider.handleDrag([folder, leaf], dataTransfer, new FakeCancellationToken());

    expect(dataTransfer.get(DND_MIME)).toBeUndefined();
  });

  it('a drag of a mod beside a file carries the mod alone', async () => {
    const { provider, modRow, leaf } = await fileRows();
    const dataTransfer = new DataTransfer();

    provider.handleDrag([modRow, leaf], dataTransfer, new FakeCancellationToken());

    expect(dataTransfer.get(DND_MIME)?.value).toEqual({ rows: [modRow], focused: modRow });
  });

  it('a mod dropped on a file or a folder moves nothing', async () => {
    const { provider, folder, leaf } = await fileRows();
    const other = await rootOf(provider, ModNode, 'Other');
    executeCommand.mockClear();

    for (const target of [folder, leaf]) {
      const dataTransfer = new DataTransfer();
      provider.handleDrag([other], dataTransfer, new FakeCancellationToken());
      await provider.handleDrop(target, dataTransfer, new FakeCancellationToken());
    }

    expect(executeCommand).not.toHaveBeenCalled();
  });
});
