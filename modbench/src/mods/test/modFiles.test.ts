import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import type * as vscode from 'vscode';
import type { FileOrigin, InstanceValue, OriginFile, OriginFolder } from '../../instanceLoader/instance';
import type { ModlistEntry } from '../../instanceAdapter/instanceAdapter';
import { TreeItemCollapsibleState, ThemeIcon, ThemeColor, FakeUri } from '../../test/vscodeMock';
import { labelOf, modsViewOn } from './modsViewOn';
import { readFile, seen } from './modsVscode';
import { registerArchiveFiles } from '../archiveFiles';
import { modArgumentOf } from '../../drivingLib/argument';
import { currentBoxOf } from '../../drivingLib/test/nameFilterViewHarness';
import { FileConflictLookup, RUNTIME_OUTPUT, modOrigin } from '../../instanceLoader/fileConflictIndex';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { expectInstanceOf } from '../../test/expectInstanceOf';
import { settled } from '../../test/eventually';
import { present } from '../../ports/present';
import { mod, indexedValueOf } from './indexedValue';

type ArchiveRead = InstanceValue['archiveContents'] extends ReadonlyMap<string, infer Read> ? Read : never;

const file = (relativePath: string, path = `/instance/mods/${relativePath}`, sourcePath = path): OriginFile => ({ relativePath, path, sourcePath, excluded: false, markedExcluded: false, includedPath: relativePath });

function foldersHoldingFiles(files: readonly OriginFile[]): OriginFolder[] {
  const byPath = new Map<string, OriginFolder>();
  for (const { relativePath, path } of files) {
    const segments = relativePath.split('/');
    for (let depth = 1; depth < segments.length; depth++) {
      const folder = segments.slice(0, depth).join('/');
      byPath.set(folder, { relativePath: folder, path: path.slice(0, path.length - relativePath.length + folder.length), includedPath: folder, excluded: false });
    }
  }
  return [...byPath.values()];
}

function valueOver(
  mods: ModlistEntry[], filesByMod: Record<string, OriginFile[]>, overwriteFiles: OriginFile[] = [],
  folders: { byMod?: Record<string, OriginFolder[]>; overwrite?: OriginFolder[] } = {},
  archiveContents: ReadonlyMap<string, ArchiveRead> = new Map(),
): InstanceValue {
  return instanceValueFixture({
    mods, filesByMod: new Map(Object.entries(filesByMod)), overwriteFiles, archiveContents,
    foldersByMod: new Map(Object.entries(filesByMod).map(([name, files]) => [name, folders.byMod?.[name] ?? foldersHoldingFiles(files)])),
    overwriteFolders: folders.overwrite ?? foldersHoldingFiles(overwriteFiles),
  });
}

const viewOver = (...over: Parameters<typeof valueOver>) => modsViewOn({ value: valueOver(...over) });

type Shown = ReturnType<typeof modsViewOn>;
type Row = vscode.TreeItem;

const shown = async ({ rows }: Shown, parent?: Row): Promise<string[]> =>
  (await rows(parent)).map((row) => `${row.contextValue?.split(' ')[0]} ${modArgumentOf(row)?.name ?? labelOf(row)}`);

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
    const view = viewOver([mod('Armour')], { Armour: armour });
    const row = await view.row('Armour');
    const textures = await view.row('textures', row);

    expect(await shown(view, row)).toEqual(['folder meshes', 'folder textures', 'file Armour.esp', 'file readme.txt']);
    expect(await shown(view, textures)).toEqual(['folder armour', 'file icon.dds']);
    expect(await shown(view, await view.row('armour', textures))).toEqual(['file a.dds', 'file b.dds']);
  });

  it('by name as the Explorer orders them: case aside, and a number by its value', async () => {
    const view = viewOver([mod('Armour')], { Armour: [file('b.txt'), file('item10.txt'), file('A.txt'), file('item9.txt')] });

    expect(await shown(view, await view.row('Armour'))).toEqual(['file A.txt', 'file b.txt', 'file item9.txt', 'file item10.txt']);
  });

  it.each([
    ['as listed', [file('textures/a.dds'), file('Textures/b.dds'), file('a.txt'), file('A.txt')]],
    ['listed the other way', [file('A.txt'), file('a.txt'), file('Textures/b.dds'), file('textures/a.dds')]],
  ])('names that differ only in case keep one order whatever order the listing gives: %s', async (_case, listed) => {
    const view = viewOver([mod('Armour')], { Armour: listed });

    expect(await shown(view, await view.row('Armour'))).toEqual(['folder Textures', 'folder textures', 'file A.txt', 'file a.txt']);
  });

  it('a mod and each folder start collapsed, so the view opens clean, and a file has no expander', async () => {
    const view = viewOver([mod('Armour')], { Armour: armour });
    const row = await view.row('Armour');

    expect(row.collapsibleState).toBe(Collapsed);
    expect((await view.rows(row)).map((child) => [labelOf(child), child.collapsibleState])).toEqual([
      ['meshes', Collapsed], ['textures', Collapsed], ['Armour.esp', None], ['readme.txt', None],
    ]);
  });

  it('an empty folder is a row with no expander, and a folder holding only an empty folder opens into it, as the Explorer\'s do', async () => {
    const view = viewOver([mod('Armour')], { Armour: [file('Armour.esp')] }, [], {
      byMod: { Armour: [
        { relativePath: 'empty', path: '/instance/mods/Armour/empty', includedPath: 'empty', excluded: false },
        { relativePath: 'outer', path: '/instance/mods/Armour/outer', includedPath: 'outer', excluded: false },
        { relativePath: 'outer/inner', path: '/instance/mods/Armour/outer/inner', includedPath: 'outer/inner', excluded: false },
      ] },
    });
    const row = await view.row('Armour');

    expect((await view.rows(row)).map((child) => [labelOf(child), child.collapsibleState])).toEqual([['empty', None], ['outer', Collapsed], ['Armour.esp', None]]);
    expect(await shown(view, await view.row('outer', row))).toEqual(['folder inner']);
  });

  it('a disabled mod opens too', async () => {
    const view = viewOver([mod('Off', false)], { Off: [file('Off.esp')] });
    const row = await view.row('Off');

    expect(row.collapsibleState).toBe(Collapsed);
    expect(await shown(view, row)).toEqual(['file Off.esp']);
  });

  it('a mod with no files shows no expander', async () => {
    const { row } = viewOver([mod('Empty'), mod('Unlisted Folder')], { Empty: [] });

    expect([(await row('Empty')).collapsibleState, (await row('Unlisted Folder')).collapsibleState]).toEqual([None, None]);
  });

  it('a mod inside a separator opens the same', async () => {
    const view = viewOver([mod('Armour'), { kind: 'separator', name: 'Gear', enabled: false }], { Armour: [file('Armour.esp')] });
    const row = await view.row('Armour', await view.row('Gear'));

    expect(row.collapsibleState).toBe(Collapsed);
    expect(await shown(view, row)).toEqual(['file Armour.esp']);
  });
});

describe('an archive opens into its files as a folder does (mods.md, The tree, story 13)', () => {
  const ARCHIVE = file('Armour - Main.ba2', '/instance/mods/Armour/Armour - Main.ba2', '/linked/Armour - Main.ba2');
  const holding = (...files: string[]) => new Map<string, ArchiveRead>([[ARCHIVE.sourcePath, { kind: 'read', answer: files }]]);
  const inMod = (archiveContents: ReadonlyMap<string, ArchiveRead>, gameName = 'Fallout 4') =>
    modsViewOn({ value: { ...valueOver([mod('Armour')], { Armour: [ARCHIVE] }, [], {}, archiveContents), gameName } });
  const inOverwrite = (archiveContents: ReadonlyMap<string, ArchiveRead>) => viewOver([], {}, [ARCHIVE], {}, archiveContents);
  const archiveIn = async (view: Shown, root: string) => ({ ...view, archive: await view.row('Armour - Main.ba2', await view.row(root)) });
  const archiveRow = (archiveContents: ReadonlyMap<string, ArchiveRead>) => archiveIn(inMod(archiveContents), 'Armour');

  it.each([['a mod', inMod, 'Armour'], ['Overwrite', inOverwrite, 'Overwrite']] as const)('in %s: folders first, then files, each by name, and a folder in it opens into its own', async (_where, over, root) => {
    const view = await archiveIn(over(holding('textures/b.dds', 'meshes/a.nif', 'Zed.txt', 'textures/sub/c.dds', 'A.txt')), root);
    const textures = await view.row('textures', view.archive);

    expect(await shown(view, view.archive)).toEqual(['archivedFolder meshes', 'archivedFolder textures', 'archivedFile A.txt', 'archivedFile Zed.txt']);
    expect(await shown(view, textures)).toEqual(['archivedFolder sub', 'archivedFile b.dds']);
  });

  it('starts collapsed, as each folder in it does, and a click on it only selects', async () => {
    const { archive, rows } = await archiveRow(holding('meshes/a.nif', 'A.txt'));

    expect([archive.collapsibleState, archive.command]).toEqual([Collapsed, undefined]);
    expect((await rows(archive)).map((row) => [labelOf(row), row.collapsibleState])).toEqual([['meshes', Collapsed], ['A.txt', None]]);
  });

  it.each([
    ['mEdit could not read', new Map<string, ArchiveRead>([['/linked/Armour - Main.ba2', { kind: 'unreadable', reason: 'it is no BA2' }]])],
    ['mEdit has not read', new Map<string, ArchiveRead>()],
    ['mEdit has not answered for', new Map<string, ArchiveRead>([['/linked/Armour - Main.ba2', { kind: 'unanswered' }]])],
    ['that holds no file', holding()],
  ])('an archive %s has no expander', async (_case, archiveContents) => {
    const { archive } = await archiveRow(archiveContents);

    expect(archive.collapsibleState).toBe(None);
  });

  it.each<[string, ArchiveRead, [string | undefined, string]]>([
    ['could not read says so in its row, and why', { kind: 'unreadable', reason: 'it is no BA2' }, ['cannot be read: it is no BA2', 'Armour - Main.ba2\ncannot be read: it is no BA2']],
    ['read says nothing', { kind: 'read', answer: ['a.nif'] }, [undefined, 'Armour - Main.ba2']],
    ['has not answered for says nothing', { kind: 'unanswered' }, [undefined, 'Armour - Main.ba2']],
  ])('an archive mEdit %s', async (_case, read, expected) => {
    const { archive } = await archiveRow(new Map([[ARCHIVE.sourcePath, read]]));

    expect([archive.description, archive.tooltip]).toEqual(expected);
  });

  it('a file or folder in it names its own kind as its contextValue, so no gesture of a file or folder in the mod is offered on it', async () => {
    const { archive, row } = await archiveRow(holding('meshes/a.nif'));
    const meshes = await row('meshes', archive);

    expect([meshes, await row('a.nif', meshes)].map(({ contextValue }) => contextValue)).toEqual(['archivedFolder', 'archivedFile']);
  });

  it('a click on a folder in it only selects, and a click on a file in it opens the file the read-only file system serves', async () => {
    const { archive, row, client } = await archiveRow(holding('meshes/a.nif'));
    const meshes = await row('meshes', archive);
    const leaf = await row('a.nif', meshes);
    client.setQueryAnswer('getArchiveFile', new Uint8Array([1]));
    registerArchiveFiles(client);

    expect(meshes.command).toBeUndefined();
    const [target, options] = present<unknown[]>(leaf.command?.arguments, 'the file row\'s command arguments');
    const uri = expectInstanceOf(target, FakeUri);
    expect([leaf.command?.command, options]).toEqual(['vscode.open', { preview: true }]);
    expect([uri.scheme, uri.path, JSON.parse(uri.query)]).toEqual([
      'modbench-archive', '/Armour - Main.ba2/meshes/a.nif', { gameRelease: 'Fallout4', archive: '/linked/Armour - Main.ba2' },
    ]);
    await readFile(uri);
    expect(client.calls.filter((call) => call.method === 'getArchiveFile').map((call) => call.args)).toEqual([['Fallout4', '/linked/Armour - Main.ba2', 'meshes/a.nif']]);
  });

  it('a file or folder in it is named by the path in its mod, through the archive, for its identity, its tooltip and the file icon theme', async () => {
    const { archive, row } = await archiveRow(holding('meshes/a.nif'));
    const meshes = await row('meshes', archive);
    const leaf = await row('a.nif', meshes);

    expect([meshes, leaf].map((each) => [each.id, each.resourceUri?.path, each.tooltip])).toEqual([
      [`${archive.id}/meshes`, '/mod/Armour/Armour - Main.ba2/meshes', 'Armour - Main.ba2/meshes'],
      [`${archive.id}/meshes/a.nif`, '/mod/Armour/Armour - Main.ba2/meshes/a.nif', 'Armour - Main.ba2/meshes/a.nif'],
    ]);
  });

  it('a file in an archive of a game the tables do not know has no command, since no release says how to read the archive', async () => {
    const { archive, row } = await archiveIn(inMod(holding('meshes/a.nif'), 'No Such Game'), 'Armour');

    expect((await row('a.nif', await row('meshes', archive))).command).toBeUndefined();
  });

  it('a file in it has the folder that holds it as its parent, then the archive', async () => {
    const { archive, row, parentOf } = await archiveRow(holding('meshes/a.nif'));
    const meshes = await row('meshes', archive);

    expect([parentOf(await row('a.nif', meshes)), parentOf(meshes)]).toEqual([meshes, archive]);
  });
});

describe('Overwrite opens into its files', () => {
  it('as a folder tree, collapsed', async () => {
    const view = viewOver([mod('Armour')], {}, [file('F4SE/Plugins/a.log'), file('Tool.esp')]);
    const row = await view.row('Overwrite');

    expect(row.collapsibleState).toBe(Collapsed);
    expect(await shown(view, row)).toEqual(['folder F4SE', 'file Tool.esp']);
  });

  it('holding none, shows no expander', async () => {
    const { row } = viewOver([mod('Armour')], { Armour: [file('Armour.esp')] });

    expect((await row('Overwrite')).collapsibleState).toBe(None);
  });
});

describe('a file or folder row\'s parts (mods.md, A row, File and folder)', () => {
  const linked = file('textures/linked.dds', '/instance/mods/Armour/textures/linked.dds', '/outside/the/mod/real-target.dds');

  async function rowsOf() {
    const view = viewOver([mod('Armour')], { Armour: [linked] });
    const modRow = await view.row('Armour');
    const folder = await view.row('textures', modRow);
    const leaf = await view.row('linked.dds', folder);
    return { view, modRow, folder, leaf };
  }

  it('labels a file and a folder by its name, as the path in its mod has it, even when a link reads it from elsewhere', async () => {
    const { folder, leaf } = await rowsOf();

    expect([labelOf(folder), labelOf(leaf)]).toEqual(['textures', 'linked.dds']);
  });

  it('gives VS Code the name to take the file icon theme\'s icon from, and overrides no icon', async () => {
    const { folder, leaf } = await rowsOf();

    expect([folder, leaf].map((row) => [row.iconPath, row.resourceUri?.path.split('/').at(-1)])).toEqual([[undefined, 'textures'], [undefined, 'linked.dds']]);
  });

  it('names its row by no file: URI, so no diagnostic or file decoration published on the file reaches the row', async () => {
    const { folder, leaf } = await rowsOf();

    expect([folder, leaf].map((row) => row.resourceUri?.scheme)).toEqual(['modbench-mod-file', 'modbench-mod-file']);
  });

  it('opens a clicked file as a preview editor where it sits in its mod, a link too, and a clicked folder or mod only selects', async () => {
    const { view, modRow, folder, leaf } = await rowsOf();

    expect(leaf.command).toMatchObject({ command: 'vscode.open', arguments: [{ fsPath: '/instance/mods/Armour/textures/linked.dds' }, { preview: true }] });
    expect([folder.command, modRow.command, (await view.row('Overwrite')).command]).toEqual([undefined, undefined, undefined]);
  });

  it('shows each folder where it sits as the value names it, by its whole path in its mod, in a mod and in Overwrite', async () => {
    const { row, run } = viewOver([mod('Armour')], { Armour: [file('meshes/textures/a.nif'), file('textures/armour/a.dds')] }, [file('F4SE/a.log')], {
      byMod: { Armour: [
        { relativePath: 'meshes', path: '/instance/mods/Armour/meshes', includedPath: 'meshes', excluded: false },
        { relativePath: 'meshes/textures', path: '/instance/mods/Armour/meshes/textures', includedPath: 'meshes/textures', excluded: false },
        { relativePath: 'textures', path: '/instance/mods/Armour/textures', includedPath: 'textures', excluded: false },
        { relativePath: 'textures/armour', path: '/instance/mods/Armour/textures/armour', includedPath: 'textures/armour', excluded: false },
      ] },
      overwrite: [{ relativePath: 'F4SE', path: '/instance/overwrite/F4SE', includedPath: 'F4SE', excluded: false }],
    });
    const textures = await row('textures', await row('Armour'));
    const folders = [textures, await row('armour', textures), await row('F4SE', await row('Overwrite'))];

    await Promise.all(folders.map((folder) => run('modbench.mod.openFolder', folder)));

    expect(seen.executed.map(([command, uri]) => [command, expectInstanceOf(uri, FakeUri).fsPath])).toEqual([
      ['revealInExplorer', '/instance/mods/Armour/textures'], ['revealInExplorer', '/instance/mods/Armour/textures/armour'], ['revealInExplorer', '/instance/overwrite/F4SE'],
    ]);
  });

  it('shows the path in its mod as the tooltip', async () => {
    const { folder, leaf } = await rowsOf();

    expect([folder.tooltip, leaf.tooltip]).toEqual(['textures', 'textures/linked.dds']);
  });

  it('has no check box and no description', async () => {
    const { folder, leaf } = await rowsOf();

    expect([folder, leaf].map((row) => [row.checkboxState, row.description])).toEqual([[undefined, undefined], [undefined, undefined]]);
  });

  it('names its own kind as its contextValue, which the File and Folder menus match on', async () => {
    const { folder, leaf } = await rowsOf();

    expect([folder.contextValue, leaf.contextValue]).toEqual(['folder', 'file included']);
  });
});

describe('a row\'s context, which the publisher tag items of the menus read (mods.md, Menus and keys)', () => {
  const INCLUDE = { name: 'Include', badge: 'IN', marksPaths: true };
  const LISTED = new Set(['/instance/mods/M', '/instance/mods/textures', '/instance/mods/textures/a.dds', '/instance/overwrite/o.log']);
  const publisherView = () => {
    const value = instanceValueFixture({
      mods: [mod('M')],
      filesByMod: new Map([['M', [file('textures/a.dds'), file('textures/b.dds')]]]),
      foldersByMod: new Map([['M', [{ relativePath: 'textures', path: '/instance/mods/textures', includedPath: 'textures', excluded: false }]]]),
      overwriteFiles: [file('o.log', '/instance/overwrite/o.log'), file('p.log', '/instance/overwrite/p.log')],
      paths: { overwriteDir: undefined, downloadsDir: '', modDirs: new Map([['M', '/instance/mods/M']]), sourceDirs: new Map() },
    });
    const publisherConfiguration = { kind: 'read', covering: () => [], listed: (path: string) => (LISTED.has(path) ? [INCLUDE] : []), pathProblems: [], unshippable: { file: '', reason: () => undefined } } as const;
    return modsViewOn({ value: { ...value, publisherTags: [INCLUDE], publisherConfiguration } });
  };
  const contextOf = async ({ rows }: Shown, parent: Row): Promise<Record<string, string | undefined>> =>
    Object.fromEntries((await rows(parent)).map((child) => [String(labelOf(child)), child.contextValue]));

  it('flags a mod, folder or file the configuration lists a publisher tag on, and no other', async () => {
    const view = publisherView();
    const mRow = await view.row('M');

    expect(mRow.contextValue).toContain('holdsPublisherTag');
    expect(await contextOf(view, mRow)).toEqual({ textures: 'folder holdsPublisherTag' });
    expect(await contextOf(view, await view.row('textures', mRow))).toEqual({ 'a.dds': 'file included holdsPublisherTag', 'b.dds': 'file included' });
  });

  it('flags an Overwrite row\'s files inOverwrite, which no publisher tag item is offered on, and a mod\'s files not', async () => {
    const view = publisherView();

    expect(await contextOf(view, await view.row('Overwrite'))).toEqual({ 'o.log': 'file included inOverwrite holdsPublisherTag', 'p.log': 'file included inOverwrite' });
  });
});

describe('a file or folder row\'s identity is its mod or Overwrite, and the path in it', () => {
  it('two mods, Overwrite and a mod folder named overwrite holding one path are four rows', async () => {
    const { rows, row } = viewOver(
      [mod('A'), mod('B'), mod('overwrite')],
      { A: [file('x/a.dds')], B: [file('x/a.dds')], overwrite: [file('x/a.dds')] },
      [file('x/a.dds')],
    );
    const roots = await rows();
    const folders = await Promise.all(roots.map((root) => row('x', root)));
    const leaves = await Promise.all(folders.map((folder) => row('a.dds', folder)));
    const ids = [...folders, ...leaves].map(({ id }) => id);
    const uris = [...folders, ...leaves].map(({ resourceUri }) => resourceUri?.path);

    expect([new Set(ids).size, new Set(uris).size, new Set([...ids, ...roots.map(({ id }) => id)]).size]).toEqual([8, 8, 12]);
  });

  it('stays as it was across a new instance value, so selection and expansion survive a change on disk', async () => {
    const valueHolding = (enabled: boolean, files: OriginFile[]) =>
      instanceValueFixture({ mods: [mod('A', enabled)], filesByMod: new Map([['A', files]]), foldersByMod: new Map([['A', foldersHoldingFiles(files)]]) });
    const { instance, row } = modsViewOn({ value: valueHolding(true, [file('x/a.dds')]) });
    const idsNow = async () => {
      const folder = await row('x', await row('A'));
      return [folder.id, (await row('a.dds', folder)).id];
    };
    const before = await idsNow();

    instance.publish(valueHolding(false, [file('x/a.dds'), file('x/b.dds')]));

    expect(await idsNow()).toEqual(before);
  });
});

describe('a file or folder row\'s parent, which VS Code\'s reveal walks up through getParent', () => {
  it('is the folder that holds it, then the mod, then the mod\'s separator', async () => {
    const { row, parentOf } = viewOver([mod('Armour'), { kind: 'separator', name: 'Gear', enabled: false }], { Armour: [file('x/a.dds')] });
    const gear = await row('Gear');
    const modRow = await row('Armour', gear);
    const folder = await row('x', modRow);

    expect([parentOf(await row('a.dds', folder)), parentOf(folder), parentOf(modRow)]).toEqual([folder, modRow, gear]);
  });

  it('is Overwrite for a file at its root', async () => {
    const { row, parentOf } = viewOver([], {}, [file('a.log')]);
    const overwrite = await row('Overwrite');

    expect(parentOf(await row('a.log', overwrite))).toBe(overwrite);
  });
});

describe('nothing drops on files and folders (mods.md, Drag and drop, story 7)', () => {
  it.each<[string, (folder: Row, leaf: Row) => Row]>([
    ['folder', (folder) => folder],
    ['leaf', (_folder, leaf) => leaf],
  ])('a mod dropped on a %s moves nothing', async (_target, targetOf) => {
    const { row, drop, adapter } = viewOver([mod('Armour'), mod('Other')], { Armour: [file('x/a.dds')] });
    const folder = await row('x', await row('Armour'));

    await drop([await row('Other')], targetOf(folder, await row('a.dds', folder)));

    expect(adapter.calls).toEqual([]);
  });
});

const currentBox = currentBoxOf(seen);

describe('the name filter finds a file at every level (mods.md, Order and view state, story 2)', () => {
  const armour = [file('readme.txt'), file('textures/armour/b.dds'), file('textures/icon.dds'), file('meshes/armour.nif')];
  const gear = [mod('Armour'), mod('Boots'), { kind: 'separator', name: 'Gear', enabled: false } satisfies ModlistEntry];

  function filtered(
    term: string,
    over: {
      mods?: ModlistEntry[]; files?: Record<string, OriginFile[]>; overwrite?: OriginFile[]; folders?: Record<string, OriginFolder[]>;
      archives?: ReadonlyMap<string, ArchiveRead>;
    } = {},
  ): Shown {
    const view = viewOver(over.mods ?? gear, over.files ?? { Armour: armour, Boots: [file('boots.esp')] }, over.overwrite, { byMod: over.folders }, over.archives);
    view.mods.nameFilter.open();
    currentBox().type(term);
    return view;
  }

  const ungrouped = (term: string): Shown => {
    const view = filtered(term);
    currentBox().pressButton();
    return view;
  };

  const armourIn = async (view: Shown) => view.row('Armour', await view.row('Gear'));

  it('a mod whose name does not match is shown for the files that do, open, and a folder for the files below it', async () => {
    const view = filtered('b.dds');
    const separator = await view.row('Gear');
    const row = await view.row('Armour', separator);
    const textures = await view.row('textures', row);

    expect(await shown(view, separator)).toEqual(['mod Armour']);
    expect([row.collapsibleState, textures.collapsibleState]).toEqual([Expanded, Expanded]);
    expect(await shown(view, row)).toEqual(['folder textures']);
    expect(await shown(view, textures)).toEqual(['folder armour']);
    expect(await shown(view, await view.row('armour', textures))).toEqual(['file b.dds']);
  });

  describe('in an archive (mods.md, The tree, story 13)', () => {
    const archive = file('Armour - Main.ba2');
    const holdingMeshes = {
      files: { Armour: [archive, file('readme.txt')], Boots: [file('boots.esp')] },
      archives: new Map<string, ArchiveRead>([[archive.sourcePath, { kind: 'read', answer: ['meshes/c.nif', 'textures/x.dds'] }]]),
    };

    it('a mod and an archive whose names do not match are shown for a file in it that does, open, and a folder in it for the files below it', async () => {
      const view = filtered('c.nif', holdingMeshes);
      const row = await armourIn(view);
      const archiveRow = await view.row('Armour - Main.ba2', row);
      const meshes = await view.row('meshes', archiveRow);

      expect(await shown(view, row)).toEqual(['file Armour - Main.ba2']);
      expect([archiveRow.collapsibleState, meshes.collapsibleState]).toEqual([Expanded, Expanded]);
      expect(await shown(view, archiveRow)).toEqual(['archivedFolder meshes']);
      expect(await shown(view, meshes)).toEqual(['archivedFile c.nif']);
    });

    it('an archive whose name matches shows all its files, collapsed', async () => {
      const view = filtered('main.ba2', holdingMeshes);
      const archiveRow = await view.row('Armour - Main.ba2', await armourIn(view));

      expect(archiveRow.collapsibleState).toBe(Collapsed);
      expect(await shown(view, archiveRow)).toEqual(['archivedFolder meshes', 'archivedFolder textures']);
    });
  });

  it('a separator is shown for a file it holds, open', async () => {
    const { row } = filtered('b.dds');

    expect((await row('Gear')).collapsibleState).toBe(Expanded);
  });

  it('a mod whose name matches shows all its files, collapsed', async () => {
    const view = filtered('armour');
    const row = await armourIn(view);

    expect(row.collapsibleState).toBe(Collapsed);
    expect(await shown(view, row)).toEqual(['folder meshes', 'folder textures', 'file readme.txt']);
  });

  it('a folder whose name matches shows all its children, collapsed, and a folder below it that does not match stays collapsed', async () => {
    const view = filtered('textures');
    const row = await armourIn(view);
    const textures = await view.row('textures', row);

    expect(await shown(view, row)).toEqual(['folder textures']);
    expect(textures.collapsibleState).toBe(Collapsed);
    expect(await shown(view, textures)).toEqual(['folder armour', 'file icon.dds']);
    expect((await view.row('armour', textures)).collapsibleState).toBe(Collapsed);
  });

  it('a separator whose name matches shows all its mods, and each opens into all its files', async () => {
    const view = filtered('gear');
    const separator = await view.row('Gear');

    expect(await shown(view, separator)).toEqual(['mod Boots', 'mod Armour']);
    expect(await shown(view, await view.row('Boots', separator))).toEqual(['file boots.esp']);
  });

  it.each([
    { term: 'icon', roots: ['mod Armour', 'runtimeOutput Overwrite'], children: ['folder textures'], state: Expanded },
    { term: 'armour', roots: ['mod Armour', 'runtimeOutput Overwrite'], children: ['folder meshes', 'folder textures', 'file readme.txt'], state: Collapsed },
  ])('with no separators, "$term" lists the mod for its files or its name, and opens it to what matches', async ({ term, roots, children, state }) => {
    const view = ungrouped(term);
    const row = await view.row('Armour');

    expect(await shown(view)).toEqual(roots);
    expect(row.collapsibleState).toBe(state);
    expect(await shown(view, row)).toEqual(children);
  });

  it('a mod with no file or name that matches is not shown, with or without a separator', async () => {
    const withSeparator = filtered('icon');
    const separatorShows = await shown(withSeparator, await withSeparator.row('Gear'));
    const noSeparator = filtered('icon', { mods: [mod('Armour'), mod('Boots')] });

    expect([separatorShows, await shown(noSeparator)]).toEqual([['mod Armour'], ['mod Armour', 'runtimeOutput Overwrite']]);
  });

  it('Overwrite stays, does not match by its own name, and shows only its files that do', async () => {
    const overwrite = [file('F4SE/Plugins/a.log'), file('Tool.esp')];
    const found = filtered('a.log', { overwrite });
    const foundRow = await found.row('Overwrite');
    const foundShows = [foundRow.collapsibleState, await shown(found, foundRow)];
    const named = filtered('overwrite', { overwrite });
    const namedRow = await named.row('Overwrite');

    expect(foundShows).toEqual([Expanded, ['folder F4SE']]);
    expect([namedRow.collapsibleState, await shown(named, namedRow)]).toEqual([None, []]);
  });

  it('Overwrite counts and tints all its files, whatever the filter lists under it', async () => {
    const { row } = filtered('a.log', { overwrite: [file('F4SE/Plugins/a.log'), file('Tool.esp')] });
    const overwrite = await row('Overwrite');

    expect([overwrite.description, overwrite.iconPath]).toEqual(['2', new ThemeIcon('folder', new ThemeColor('charts.red'))]);
  });

  it('Overwrite holding files, none of them found, still counts and tints them, and lists none, so the filter says no match', async () => {
    const { row, view } = filtered('zzz', { overwrite: [file('Tool.esp')] });
    const overwrite = await row('Overwrite');

    expect([overwrite.description, overwrite.iconPath, overwrite.collapsibleState]).toEqual(['1', new ThemeIcon('folder', new ThemeColor('charts.red')), None]);
    await settled(() => { expect(view.message).toBe('No matches for "zzz".'); });
  });

  it('a mod whose only match is an empty folder is shown, and opens to it', async () => {
    const empty: OriginFolder = { relativePath: 'empty', path: '/instance/mods/Armour/empty', includedPath: 'empty', excluded: false };
    const view = filtered('empty', { mods: [mod('Armour')], files: { Armour: [] }, folders: { Armour: [empty] } });
    const row = await view.row('Armour');

    expect(row.collapsibleState).toBe(Expanded);
    expect(await shown(view, row)).toEqual(['folder empty']);
  });
});

describe('a file row\'s context, which the File menu\'s go to mod and compare file read (mods.md, Menus and keys)', () => {
  const flagsOf = async (providers: FileOrigin[], rowOfMod: string) => {
    const files = new FileConflictLookup();
    files.set({ relativePath: 'a.dds', winner: '/w', winnerOrigin: providers[0] ?? RUNTIME_OUTPUT, providers });
    const { rows, row } = modsViewOn({ value: instanceValueFixture({
      mods: [mod('High'), mod('Low')], files,
      filesByMod: new Map([['High', [file('a.dds')]], ['Low', [file('a.dds')]]]),
      overwriteFiles: [file('a.dds')],
    }) });
    return (await rows(await row(rowOfMod))).map(({ contextValue }) => contextValue);
  };

  it.each<[string, FileOrigin[], string, string]>([
    ['a mod\'s winning copy of a path another enabled copy provides as in conflict', [modOrigin('High'), modOrigin('Low')], 'High', 'file conflict included'],
    ['Overwrite\'s copy of a path another enabled copy provides as in conflict', [RUNTIME_OUTPUT, modOrigin('Low')], 'Overwrite', 'file conflict included inOverwrite'],
    ['a copy that loses the conflict losing, as compare file reads it', [modOrigin('High'), modOrigin('Low')], 'Low', 'file conflict losing included'],
    ['the only copy as in no conflict', [modOrigin('High')], 'High', 'file included'],
    ['a copy whose mod does not provide the path as in no conflict', [modOrigin('High'), modOrigin('Other')], 'Low', 'file included'],
  ])('flags %s', async (_case, providers, rowOfMod, flags) => {
    expect(await flagsOf(providers, rowOfMod)).toEqual([flags]);
  });
});

describe('a file row\'s context, which the File menu\'s exclude or include reads (mods.md, Menus and keys, story 7)', () => {
  const excludedFile = (relativePath: string, markedExcluded = true): OriginFile =>
    ({ ...file(relativePath), excluded: true, markedExcluded });

  const flagsAt = async (path: string[]) => {
    const files = [file('a.dds'), excludedFile('b.dds.mohidden'), excludedFile('Textures.mohidden/a.dds', false), excludedFile('Textures.mohidden/b.dds.mohidden')];
    const hidden: OriginFolder = { relativePath: 'Textures.mohidden', path: '/instance/mods/Textures.mohidden', includedPath: 'Textures', excluded: true };
    const { row } = viewOver([mod('M')], { M: files }, [], { byMod: { M: [hidden] } });
    const found = await path.reduce(async (parent, label) => row(label, await parent), row('M'));
    return found.contextValue?.split(' ');
  };

  it.each([
    ['a file the game may get', 'included', ['a.dds']],
    ['a file excluded by its own name', 'excluded', ['b.dds.mohidden']],
    ['a file only its folder excludes, by its own name', 'included', ['Textures.mohidden', 'a.dds']],
    ['a file its own name excludes inside an excluded folder', 'excluded', ['Textures.mohidden', 'b.dds.mohidden']],
  ])('flags %s as %s', async (_case, flag, path) => {
    expect(await flagsAt(path)).toEqual(['file', flag]);
  });
});

describe('an archived file\'s tooltip names the game folder\'s file that wins over it (mods.md, File and folder, Tooltip)', () => {
  const ARCHIVE = file('Armour - Main.ba2', '/instance/mods/Armour/Armour - Main.ba2');
  const tooltipOf = async (gameFolderFiles: string[], loose: OriginFile[]) => {
    const value = await indexedValueOf([mod('Armour')], { Armour: { files: [ARCHIVE, ...loose] } }, { files: [] }, [{ origin: modOrigin('Armour'), archive: ARCHIVE.sourcePath, files: ['meshes/a.nif'] }]);
    const { row } = modsViewOn({ value: {
      ...value,
      archiveContents: new Map<string, ArchiveRead>([[ARCHIVE.sourcePath, { kind: 'read', answer: ['meshes/a.nif'] }]]),
      dataFolderFiles: { kind: 'listed', files: new Map(gameFolderFiles.map((relativePath) => [relativePath.toLowerCase(), { relativePath, path: `/game/Data/${relativePath}` }])) },
    } });
    const archive = await row('Armour - Main.ba2', await row('Armour'));
    return (await row('a.nif', await row('meshes', archive))).tooltip;
  };

  it.each<[string, string[], OriginFile[], string]>([
    ['the path in its mod, then the game folder\'s loose file at that path', ['Meshes/A.nif'], [], 'Armour - Main.ba2/meshes/a.nif\nwon by the game folder: /game/Data/Meshes/A.nif'],
    ['the path alone when the game folder holds no file at it', ['meshes/b.nif'], [], 'Armour - Main.ba2/meshes/a.nif'],
    ['the path alone when a mod\'s loose file covers the game folder\'s', ['meshes/a.nif'], [file('meshes/a.nif')], 'Armour - Main.ba2/meshes/a.nif'],
  ])('is %s', async (_case, gameFolderFiles, loose, tooltip) => {
    expect(await tooltipOf(gameFolderFiles, loose)).toBe(tooltip);
  });
});

describe('the tooltip Symbols reads for a file is its winning copy\'s row\'s (symbols.md, The symbols)', () => {
  const ARCHIVE = file('Armour - Main.ba2', '/instance/mods/Armour/Armour - Main.ba2');
  const LOOSE = file('b.nif', '/instance/mods/Armour/b.nif');
  const OLD_LOOSE = file('b.nif', '/instance/mods/Old Armour/b.nif');
  const shownOver = async (archive: ArchiveRead, gameFolderFiles: string[]) => {
    const value = {
      ...await indexedValueOf(
        [mod('Armour'), mod('Old Armour')], { 'Armour': { files: [ARCHIVE, LOOSE] }, 'Old Armour': { files: [OLD_LOOSE] } }, { files: [] },
        [{ origin: modOrigin('Armour'), archive: ARCHIVE.sourcePath, files: archive.kind === 'read' ? archive.answer : undefined }],
      ),
      archiveContents: new Map<string, ArchiveRead>([[ARCHIVE.sourcePath, archive]]),
      dataFolderFiles: { kind: 'listed' as const, files: new Map(gameFolderFiles.map((relativePath) => [relativePath.toLowerCase(), { relativePath, path: `/game/Data/${relativePath}` }])) },
    };
    const view = modsViewOn({ value });
    return { ...view, armour: await view.row('Armour'), tooltipOf: view.mods.symbolRows.fileTooltip };
  };

  it('is a loose file\'s row\'s, whatever the case of the path asked', async () => {
    const { tooltipOf, row, armour } = await shownOver({ kind: 'read', answer: [] }, []);

    expect([tooltipOf('B.nif'), (await row('b.nif', armour)).tooltip]).toEqual(['b.nif', 'b.nif']);
  });

  it('is an archived file\'s row\'s, naming the game folder\'s file that wins over it', async () => {
    const { tooltipOf, row, armour } = await shownOver({ kind: 'read', answer: ['meshes/a.nif'] }, ['meshes/a.nif']);
    const leaf = await row('a.nif', await row('meshes', await row('Armour - Main.ba2', armour)));

    expect([tooltipOf('meshes/a.nif'), leaf.tooltip]).toEqual(Array.from({ length: 2 }, () => 'Armour - Main.ba2/meshes/a.nif\nwon by the game folder: /game/Data/meshes/a.nif'));
  });

  it('is an unreadable archive\'s row\'s, saying why', async () => {
    const { tooltipOf, row, armour } = await shownOver({ kind: 'unreadable', reason: 'it is no BA2' }, []);

    expect([tooltipOf('Armour - Main.ba2'), (await row('Armour - Main.ba2', armour)).tooltip]).toEqual(Array.from({ length: 2 }, () => 'Armour - Main.ba2\ncannot be read: it is no BA2'));
  });

  it('is none for a path no mod or Overwrite holds', async () => {
    const { tooltipOf } = await shownOver({ kind: 'read', answer: [] }, ['meshes/c.nif']);

    expect(tooltipOf('meshes/c.nif')).toBeUndefined();
  });
});
