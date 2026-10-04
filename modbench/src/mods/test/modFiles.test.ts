import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mod, OriginFile, ModlistEntry, OriginFolder } from '../../instanceLoader/instance';
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
import { FileConflictLookup, RUNTIME_OUTPUT, modOrigin } from '../../instanceLoader/fileConflictIndex';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { accessTo } from '../../test/mo2/adapterOver';
import { expectInstanceOf } from '../../test/expectInstanceOf';
import { present } from '../../ports/present';

const mod = (name: string, enabled = true): Mod => ({ kind: 'mod', name, enabled });
const file = (relativePath: string, path = `/instance/mods/${relativePath}`, sourcePath = path): OriginFile => ({ relativePath, path, sourcePath, excluded: false, excludedByName: false });

function foldersHoldingFiles(files: readonly OriginFile[]): OriginFolder[] {
  const byPath = new Map<string, OriginFolder>();
  for (const { relativePath, path } of files) {
    const segments = relativePath.split('/');
    for (let depth = 1; depth < segments.length; depth++) {
      const folder = segments.slice(0, depth).join('/');
      byPath.set(folder, { relativePath: folder, path: path.slice(0, path.length - relativePath.length + folder.length), excluded: false });
    }
  }
  return [...byPath.values()];
}

function providerOver(
  mods: ModlistEntry[], filesByMod: Record<string, OriginFile[]>, overwriteFiles: OriginFile[] = [],
  folders: { byMod?: Record<string, OriginFolder[]>; overwrite?: OriginFolder[] } = {},
): ModListProvider {
  const value = instanceValueFixture({
    mods, filesByMod: new Map(Object.entries(filesByMod)), overwriteFiles,
    foldersByMod: new Map(Object.entries(filesByMod).map(([name, files]) => [name, folders.byMod?.[name] ?? foldersHoldingFiles(files)])),
    overwriteFolders: folders.overwrite ?? foldersHoldingFiles(overwriteFiles),
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

const { Collapsed, Expanded, None } = TreeItemCollapsibleState;

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
    const rowsFor = async (files: OriginFile[]) => {
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

  it('an empty folder is a row with no expander, and a folder holding only an empty folder opens into it, as the Explorer\'s do', async () => {
    const provider = providerOver([mod('Armour')], { Armour: [file('Armour.esp')] }, [], {
      byMod: { Armour: [
        { relativePath: 'empty', path: '/instance/mods/Armour/empty', excluded: false },
        { relativePath: 'outer', path: '/instance/mods/Armour/outer', excluded: false },
        { relativePath: 'outer/inner', path: '/instance/mods/Armour/outer/inner', excluded: false },
      ] },
    });
    const children = await provider.getChildren(await rootOf(provider, ModNode, 'Armour'));

    expect(children.map((child) => [`${child.kind} ${labelOf(child)}`, child.collapsibleState]))
      .toEqual([['folder empty', None], ['folder outer', Collapsed], ['file Armour.esp', None]]);
    expect(shown(await provider.getChildren(present(children[1], 'outer')))).toEqual(['folder inner']);
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
        { relativePath: 'meshes', path: '/instance/mods/Armour/meshes', excluded: false },
        { relativePath: 'meshes/textures', path: '/instance/mods/Armour/meshes/textures', excluded: false },
        { relativePath: 'textures', path: '/instance/mods/Armour/textures', excluded: false },
        { relativePath: 'textures/armour', path: '/instance/mods/Armour/textures/armour', excluded: false },
      ] },
      overwrite: [{ relativePath: 'F4SE', path: '/instance/overwrite/F4SE', excluded: false }],
    });
    const textures = expectInstanceOf(await childNamed(provider, await rootOf(provider, ModNode, 'Armour'), 'textures'), FolderNode);
    const armour = expectInstanceOf(await childNamed(provider, textures, 'armour'), FolderNode);
    const f4se = expectInstanceOf(await childNamed(provider, await rootOf(provider, OverwriteNode, 'Overwrite'), 'F4SE'), FolderNode);

    expect([textures.folder, armour.folder, f4se.folder]).toEqual([
      { relativePath: 'textures', path: '/instance/mods/Armour/textures', excluded: false },
      { relativePath: 'textures/armour', path: '/instance/mods/Armour/textures/armour', excluded: false },
      { relativePath: 'F4SE', path: '/instance/overwrite/F4SE', excluded: false },
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
    expect(leaf.contextValue).toBe('file included');
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
    const valueHolding = (enabled: boolean, files: OriginFile[]) =>
      instanceValueFixture({ mods: [mod('A', enabled)], filesByMod: new Map([['A', files]]), foldersByMod: new Map([['A', foldersHoldingFiles(files)]]) });
    const instance = new FakeInstance(valueHolding(true, [file('x/a.dds')]));
    const provider = new ModListProvider({ instance, access: accessTo('/instance'), log: () => undefined });
    const idsNow = async () => {
      const modRow = await rootOf(provider, ModNode, 'A');
      const folder = await childNamed(provider, modRow, 'x');
      return [folder.id, (await childNamed(provider, folder, 'a.dds')).id];
    };
    const before = await idsNow();

    instance.publish(valueHolding(false, [file('x/a.dds'), file('x/b.dds')]));

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
    expect(provider.getParent(modRow)).toEqual(gear);
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

describe('the name filter finds a file at every level (mods.md, Order and view state, story 2)', () => {
  const armour = [file('readme.txt'), file('textures/armour/b.dds'), file('textures/icon.dds'), file('meshes/armour.nif')];
  const gear = [mod('Armour'), mod('Boots'), { kind: 'separator', name: 'Gear', enabled: false } satisfies ModlistEntry];

  function filtered(
    term: string, grouping = true,
    over: { mods?: ModlistEntry[]; files?: Record<string, OriginFile[]>; overwrite?: OriginFile[]; folders?: Record<string, OriginFolder[]> } = {},
  ) {
    const provider = providerOver(
      over.mods ?? gear, over.files ?? { Armour: armour, Boots: [file('boots.esp')] }, over.overwrite, { byMod: over.folders },
    );
    provider.setFilter(term, grouping);
    return provider;
  }

  it('a mod whose name does not match is shown for the files that do, open, and a folder for the files below it', async () => {
    const provider = filtered('b.dds');
    const separator = await rootOf(provider, SeparatorNode, 'Gear');
    const row = expectInstanceOf((await provider.getChildren(separator))[0], ModNode);
    const textures = await childNamed(provider, row, 'textures');

    expect(shown(await provider.getChildren(separator))).toEqual(['mod Armour']);
    expect(row.collapsibleState).toBe(Expanded);
    expect(shown(await provider.getChildren(row))).toEqual(['folder textures']);
    expect(textures.collapsibleState).toBe(Expanded);
    expect(shown(await provider.getChildren(textures))).toEqual(['folder armour']);
    expect(shown(await provider.getChildren(await childNamed(provider, textures, 'armour')))).toEqual(['file b.dds']);
  });

  it('a separator is shown for a file it holds, open', async () => {
    const provider = filtered('b.dds');

    expect((await rootOf(provider, SeparatorNode, 'Gear')).collapsibleState).toBe(Expanded);
  });

  it('a mod whose name matches shows all its files, collapsed', async () => {
    const provider = filtered('armour');
    const separator = await rootOf(provider, SeparatorNode, 'Gear');
    const row = expectInstanceOf((await provider.getChildren(separator))[0], ModNode);

    expect(row.collapsibleState).toBe(Collapsed);
    expect(shown(await provider.getChildren(row))).toEqual(['folder meshes', 'folder textures', 'file readme.txt']);
  });

  it('a folder whose name matches shows all its children, collapsed, and a folder below it that does not match stays collapsed', async () => {
    const provider = filtered('textures');
    const row = expectInstanceOf((await provider.getChildren(await rootOf(provider, SeparatorNode, 'Gear')))[0], ModNode);
    const textures = await childNamed(provider, row, 'textures');

    expect(shown(await provider.getChildren(row))).toEqual(['folder textures']);
    expect(textures.collapsibleState).toBe(Collapsed);
    expect(shown(await provider.getChildren(textures))).toEqual(['folder armour', 'file icon.dds']);
    expect((await childNamed(provider, textures, 'armour')).collapsibleState).toBe(Collapsed);
  });

  it('a separator whose name matches shows all its mods, and each opens into all its files', async () => {
    const provider = filtered('gear');
    const separator = await rootOf(provider, SeparatorNode, 'Gear');
    const [boots] = await provider.getChildren(separator);

    expect(shown(await provider.getChildren(separator))).toEqual(['mod Boots', 'mod Armour']);
    expect(shown(await provider.getChildren(present(boots, 'Boots')))).toEqual(['file boots.esp']);
  });

  it('with no separators, a mod is listed for the files that match, and opens to them only', async () => {
    const provider = filtered('icon', false);
    const row = await rootOf(provider, ModNode, 'Armour');

    expect(shown(await provider.getChildren())).toEqual(['mod Armour', 'overwrite Overwrite']);
    expect(shown(await provider.getChildren(row))).toEqual(['folder textures']);
  });

  it('a mod with no file or name that matches is not shown, with or without a separator', async () => {
    const withSeparator = filtered('icon');
    const ungrouped = filtered('icon', true, { mods: [mod('Armour'), mod('Boots')] });

    expect(shown(await withSeparator.getChildren(await rootOf(withSeparator, SeparatorNode, 'Gear')))).toEqual(['mod Armour']);
    expect(shown(await ungrouped.getChildren())).toEqual(['mod Armour', 'overwrite Overwrite']);
  });

  it('Overwrite stays, does not match by its own name, and shows only its files that do', async () => {
    const overwrite = [file('F4SE/Plugins/a.log'), file('Tool.esp')];
    const named = filtered('overwrite', true, { overwrite });
    const found = filtered('a.log', true, { overwrite });
    const row = await rootOf(found, OverwriteNode, 'Overwrite');

    expect(row.collapsibleState).toBe(Expanded);
    expect(shown(await found.getChildren(row))).toEqual(['folder F4SE']);
    expect((await rootOf(named, OverwriteNode, 'Overwrite')).collapsibleState).toBe(None);
    expect(shown(await named.getChildren(await rootOf(named, OverwriteNode, 'Overwrite')))).toEqual([]);
  });

  it('with no separators, a mod whose name matches opens to all its files, collapsed', async () => {
    const provider = filtered('armour', false);
    const row = await rootOf(provider, ModNode, 'Armour');

    expect(row.collapsibleState).toBe(Collapsed);
    expect(shown(await provider.getChildren(row))).toEqual(['folder meshes', 'folder textures', 'file readme.txt']);
  });

  it('Overwrite counts and tints all its files, whatever the filter lists under it', async () => {
    const provider = filtered('a.log', true, { overwrite: [file('F4SE/Plugins/a.log'), file('Tool.esp')] });
    const row = await rootOf(provider, OverwriteNode, 'Overwrite');

    expect(row.description).toBe('2');
    expect(expectInstanceOf(row.iconPath, ThemeIcon).color).toBeDefined();
  });

  it('Overwrite holding files, none of them found, still counts and tints them, and lists none', async () => {
    const provider = filtered('zzz', true, { overwrite: [file('Tool.esp')] });
    const row = await rootOf(provider, OverwriteNode, 'Overwrite');

    expect(row.description).toBe('1');
    expect(expectInstanceOf(row.iconPath, ThemeIcon).color).toBeDefined();
    expect(row.lists()).toBe(false);
  });

  it('a mod whose only match is an empty folder is shown, and opens to it', async () => {
    const empty: OriginFolder = { relativePath: 'empty', path: '/instance/mods/Armour/empty', excluded: false };
    const provider = filtered('empty', true, { mods: [mod('Armour')], files: { Armour: [] }, folders: { Armour: [empty] } });
    const row = await rootOf(provider, ModNode, 'Armour');

    expect(row.collapsibleState).toBe(Expanded);
    expect(shown(await provider.getChildren(row))).toEqual(['folder empty']);
  });
});

describe('a file row\'s context, which the File menu\'s go to mod reads (mods.md, Menus and keys)', () => {
  const flagsOf = async (providers: Parameters<FileConflictLookup['set']>[0]['providers'], rowOfMod: string) => {
    const files = new FileConflictLookup();
    files.set({ relativePath: 'a.dds', winner: '/w', winnerOrigin: providers[0] ?? RUNTIME_OUTPUT, providers });
    const value = instanceValueFixture({
      mods: [mod('High'), mod('Low')], files,
      filesByMod: new Map([['High', [file('a.dds')]], ['Low', [file('a.dds')]]]),
      overwriteFiles: [file('a.dds')],
    });
    const provider = new ModListProvider({ instance: new FakeInstance(value), access: accessTo('/instance'), log: () => undefined });
    const row = rowOfMod === 'Overwrite' ? await rootOf(provider, OverwriteNode, 'Overwrite') : await rootOf(provider, ModNode, rowOfMod);
    return (await provider.getChildren(row)).map((child) => child.contextValue);
  };

  it('flags a file whose path another enabled copy provides, in a mod or Overwrite', async () => {
    expect(await flagsOf([modOrigin('High'), modOrigin('Low')], 'Low')).toEqual(['file conflict included']);
    expect(await flagsOf([RUNTIME_OUTPUT, modOrigin('Low')], 'Overwrite')).toEqual(['file conflict included']);
  });

  it('flags no file that is the only copy, or whose mod does not provide it', async () => {
    expect(await flagsOf([modOrigin('High')], 'High')).toEqual(['file included']);
    expect(await flagsOf([modOrigin('High'), modOrigin('Other')], 'Low')).toEqual(['file included']);
  });
});

describe('a file row\'s context, which the File menu\'s exclude or include reads (mods.md, Menus and keys, story 7)', () => {
  const flags = (row: ModlistNode): string[] => row.contextValue?.split(' ') ?? [];
  const excludedFile = (relativePath: string, excludedByName = true): OriginFile =>
    ({ ...file(relativePath), excluded: true, excludedByName });

  it('flags a file the game may get included, and a file excluded by its own name excluded', async () => {
    const provider = providerOver([mod('M')], { M: [file('a.dds'), excludedFile('b.dds.mohidden')] });
    const row = await rootOf(provider, ModNode, 'M');

    expect(flags(await childNamed(provider, row, 'a.dds'))).toEqual(['file', 'included']);
    expect(flags(await childNamed(provider, row, 'b.dds.mohidden'))).toEqual(['file', 'excluded']);
  });

  it.each([
    ['a.dds', 'included'], ['b.dds.mohidden', 'excluded'],
  ])('flags a file its folder excludes by its own name: %s is %s', async (name, flag) => {
    const files = [excludedFile('Textures.mohidden/a.dds', false), excludedFile('Textures.mohidden/b.dds.mohidden')];
    const folder: OriginFolder = { relativePath: 'Textures.mohidden', path: '/instance/mods/Textures.mohidden', excluded: true };
    const provider = providerOver([mod('M')], { M: files }, [], { byMod: { M: [folder] } });
    const textures = await childNamed(provider, await rootOf(provider, ModNode, 'M'), 'Textures.mohidden');

    expect(flags(await childNamed(provider, textures, name))).toEqual(['file', flag]);
  });
});

describe('an excluded or included file while the disk has not confirmed it (common.md, Unconfirmed writes, story 2)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const valueHolding = (modFiles: OriginFile[], overwriteFiles: OriginFile[] = []) => instanceValueFixture({
    mods: [mod('M')], filesByMod: new Map([['M', modFiles]]), foldersByMod: new Map([['M', []]]),
    overwriteFiles, overwriteFolders: [],
  });
  const setUp = (modFiles: OriginFile[], overwriteFiles: OriginFile[] = []) => {
    const instance = new FakeInstance(valueHolding(modFiles, overwriteFiles));
    const logged: string[] = [];
    const provider = new ModListProvider({ instance, access: accessTo('/instance'), log: (line) => logged.push(line) });
    return { instance, logged, provider };
  };
  const spinningIn = async (provider: ModListProvider, origin: 'M' | 'Overwrite'): Promise<string[]> => {
    const row = origin === 'M' ? await rootOf(provider, ModNode, 'M') : await rootOf(provider, OverwriteNode, 'Overwrite');
    return (await provider.getChildren(row))
      .filter((child) => child.iconPath instanceof ThemeIcon && child.iconPath.id === 'sync~spin').map(labelOf);
  };
  const inM = { origin: modOrigin('M'), relativePath: 'a.dds' };

  it('keeps the row as it is, and marks it only after a delay', async () => {
    const { provider } = setUp([file('a.dds')]);

    provider.markExclusions([inM], 'Excluded');
    expect(await spinningIn(provider, 'M')).toEqual([]);

    vi.advanceTimersByTime(1000);
    expect(await spinningIn(provider, 'M')).toEqual(['a.dds']);
  });

  it('marks only the copy in the origin it was written to, not one at the same path in another', async () => {
    const { provider } = setUp([file('a.dds')], [file('a.dds')]);

    provider.markExclusions([inM], 'Excluded');
    vi.advanceTimersByTime(1000);

    expect(await spinningIn(provider, 'Overwrite')).toEqual([]);
  });

  it('the mark goes silently once the disk lists no file at its path', async () => {
    const { instance, logged, provider } = setUp([file('a.dds')]);
    provider.markExclusions([inM], 'Excluded');
    vi.advanceTimersByTime(1000);

    instance.publish(valueHolding([{ ...file('a.dds.mohidden'), excluded: true }]));

    expect(await spinningIn(provider, 'M')).toEqual([]);
    expect(logged).toEqual([]);
  });

  it('shows the disk\'s row unmarked, and logs one line naming the file and its mod, after a second value that still lists it', async () => {
    const { instance, logged, provider } = setUp([file('a.dds')], [file('b.ini')]);
    provider.markExclusions([inM, { origin: RUNTIME_OUTPUT, relativePath: 'b.ini' }], 'Excluded');
    vi.advanceTimersByTime(1000);

    instance.publish(valueHolding([file('a.dds')], [file('b.ini')]));
    expect(await spinningIn(provider, 'M')).toEqual(['a.dds']);
    instance.publish(valueHolding([file('a.dds')], [file('b.ini')]));

    expect(await spinningIn(provider, 'M')).toEqual([]);
    expect(logged).toEqual([
      '"a.dds" in "M" was excluded, and the disk does not show it.',
      '"b.ini" in Overwrite was excluded, and the disk does not show it.',
    ]);
  });

  it('a write forgotten never shows the mark', async () => {
    const { provider } = setUp([file('a.dds')]);
    provider.markExclusions([inM], 'Included');

    provider.forgetUnconfirmedExclusions([inM]);
    vi.advanceTimersByTime(1000);

    expect(await spinningIn(provider, 'M')).toEqual([]);
  });
});
