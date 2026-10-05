import { describe, it, expect, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, uriFile, uriFrom } from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, Uri: { file: uriFile, from: uriFrom },
}));

import { modsKeyContext } from '../gestureEntry';
import { pluralArgument, selectionArgument } from '../../drivingLib/gestureEntry';
import { ModNode, OverwriteNode, SeparatorNode } from '../ModListProvider';
import { FileNode, FolderNode } from '../modFiles';

const modRow = (name: string) => new ModNode({ kind: 'mod', name, enabled: true });
const separatorRow = (name: string) => new SeparatorNode({ kind: 'separator', name, enabled: true }, []);

describe('a selection mixing mods and separators', () => {
  const alpha = modRow('Alpha');
  const groupA = separatorRow('Group A');
  const beta = modRow('Beta');
  const groupB = separatorRow('Group B');
  const mixed = [alpha, groupA, beta, groupB];

  it('gives the rows of the right-clicked row\'s kind', () => {
    expect(pluralArgument({ clicked: beta, selection: mixed }, 'mod', 'separator')).toEqual([alpha, beta]);
    expect(pluralArgument({ clicked: groupB, selection: mixed }, 'mod', 'separator')).toEqual([groupA, groupB]);
  });

  it('gives the rows of the focused row\'s kind for a key', () => {
    expect(pluralArgument({ focused: groupA, selection: mixed }, 'mod', 'separator')).toEqual([groupA, groupB]);
    expect(pluralArgument({ focused: alpha, selection: mixed }, 'mod', 'separator')).toEqual([alpha, beta]);
  });

  it('gives nothing to a gesture that does not take the right-clicked row\'s kind', () => {
    expect(pluralArgument({ clicked: groupA, selection: mixed }, 'mod')).toEqual([]);
  });
});

describe('selectionArgument over a selection mixing mods and separators', () => {
  const alpha = modRow('Alpha');
  const groupA = separatorRow('Group A');
  const beta = modRow('Beta');
  const groupB = separatorRow('Group B');
  const mixed = [alpha, groupA, beta, groupB];

  it('keeps every selected row of the kinds given, regardless of the right-clicked row\'s kind', () => {
    expect(selectionArgument({ clicked: beta, selection: mixed }, 'mod', 'separator')).toEqual(mixed);
    expect(selectionArgument({ clicked: groupB, selection: mixed }, 'mod', 'separator')).toEqual(mixed);
  });

  it('keeps every selected row of the kinds given for a key or the palette too', () => {
    expect(selectionArgument({ focused: groupA, selection: mixed }, 'mod', 'separator')).toEqual(mixed);
    expect(selectionArgument({ selection: mixed }, 'mod', 'separator')).toEqual(mixed);
  });

  it('still excludes a kind not requested', () => {
    expect(selectionArgument({ clicked: beta, selection: mixed }, 'mod')).toEqual([alpha, beta]);
  });
});

describe('what the Mods keys read off the selection', () => {
  const enabledMod = new ModNode({ kind: 'mod', name: 'On', enabled: true });
  const disabledMod = new ModNode({ kind: 'mod', name: 'Off', enabled: false });
  const group = separatorRow('Group');
  const byRow = (row: ModNode) => row.mod.enabled;

  it('Space disables a selection of enabled mods, and enables a selection of disabled ones', () => {
    expect(modsKeyContext([enabledMod], byRow).selectionToggle).toBe('disable');
    expect(modsKeyContext([disabledMod], byRow).selectionToggle).toBe('enable');
  });

  it('Space takes the first selected mod\'s direction over a mixed selection', () => {
    expect(modsKeyContext([group, disabledMod, enabledMod], byRow).selectionToggle).toBe('enable');
    expect(modsKeyContext([enabledMod, disabledMod], byRow).selectionToggle).toBe('disable');
  });

  it('Space reads the mod\'s state as it is now, not as the row was built', () => {
    expect(modsKeyContext([enabledMod], () => false).selectionToggle).toBe('enable');
  });

  it('the palette\'s track sees a selection that holds a mod with no repository providing a plugin', () => {
    const withPlugin = new ModNode({ kind: 'mod', name: 'Patch', enabled: true }, { holdsPlugin: true, tracked: false, fileOrderConflict: false });
    const trackedWithPlugin = new ModNode({ kind: 'mod', name: 'Tracked', enabled: true }, { holdsPlugin: true, tracked: true, fileOrderConflict: false });
    expect(modsKeyContext([enabledMod, withPlugin], byRow).holdsUntrackedModWithPlugin).toBe(true);
    expect(modsKeyContext([enabledMod, trackedWithPlugin], byRow).holdsUntrackedModWithPlugin).toBe(false);
    expect(modsKeyContext([enabledMod, group], byRow).holdsUntrackedModWithPlugin).toBe(false);
    expect(modsKeyContext([], byRow).holdsUntrackedModWithPlugin).toBe(false);
  });

  it('Space does nothing over a selection with no mod', () => {
    expect(modsKeyContext([group], byRow).selectionToggle).toBeUndefined();
    expect(modsKeyContext([], byRow).selectionToggle).toBeUndefined();
  });

  it('Delete and F2 see one kind: mods, or separators', () => {
    expect(modsKeyContext([enabledMod, disabledMod], byRow).selectionKind).toBe('mod');
    expect(modsKeyContext([group, separatorRow('Other')], byRow).selectionKind).toBe('separator');
  });

  it('Delete and F2 see no kind over a selection mixing mods and separators, or over none', () => {
    expect(modsKeyContext([enabledMod, group], byRow).selectionKind).toBeUndefined();
    expect(modsKeyContext([], byRow).selectionKind).toBeUndefined();
  });

  it('Space, Delete and F2 do nothing over a selection that holds a file or a folder, which may be the focused row', () => {
    const file = { relativePath: 'textures/a.dds', path: '/instance/mods/On/textures/a.dds', sourcePath: '/instance/mods/On/textures/a.dds', excluded: false, excludedByName: false };
    const folder = new FolderNode(enabledMod, { kind: 'mod', name: 'On' }, { relativePath: 'textures', path: '/instance/mods/On/textures', excluded: false }, [file], [], 'textures');
    const leaf = new FileNode(folder, folder.origin, file, 'a.dds');

    for (const selection of [[enabledMod, leaf], [disabledMod, folder], [group, leaf]]) {
      expect(modsKeyContext(selection, byRow)).toMatchObject({ selectionToggle: undefined, selectionKind: undefined });
    }
  });

  it('F2 and a singular gesture see whether exactly one row is selected', () => {
    expect(modsKeyContext([group], byRow).singleRow).toBe(true);
    expect(modsKeyContext([group, separatorRow('Other')], byRow).singleRow).toBe(false);
    expect(modsKeyContext([], byRow).singleRow).toBe(false);
  });

  it('go to mod sees exactly one selected file that is in a file order conflict', () => {
    const copy = { relativePath: 'x/a.dds', path: '/instance/mods/On/x/a.dds', sourcePath: '/instance/mods/On/x/a.dds', excluded: false, excludedByName: false };
    const conflicting = new FileNode(enabledMod, { kind: 'mod', name: 'On' }, copy, 'a.dds', 'wins');
    const alone = new FileNode(enabledMod, { kind: 'mod', name: 'On' }, copy, 'a.dds');
    expect(modsKeyContext([conflicting], byRow).singleGoToModRow).toBe(true);
    expect(modsKeyContext([alone], byRow).singleGoToModRow).toBe(false);
    expect(modsKeyContext([conflicting, alone], byRow).singleGoToModRow).toBe(false);
    expect(modsKeyContext([enabledMod], byRow).singleGoToModRow).toBe(false);
    expect(modsKeyContext([], byRow).singleGoToModRow).toBe(false);
  });

  it('compare file sees exactly one selected file row that loses its file order conflict', () => {
    const copy = { relativePath: 'x/a.dds', path: '/instance/mods/On/x/a.dds', sourcePath: '/instance/mods/On/x/a.dds', excluded: false, excludedByName: false };
    const origin = { kind: 'mod' as const, name: 'On' };
    const losing = new FileNode(enabledMod, origin, copy, 'a.dds', 'loses');
    const winning = new FileNode(enabledMod, origin, copy, 'a.dds', 'wins');
    expect(modsKeyContext([losing], byRow).singleCompareFileRow).toBe(true);
    expect(modsKeyContext([winning], byRow).singleCompareFileRow).toBe(false);
    expect(modsKeyContext([losing, losing], byRow).singleCompareFileRow).toBe(false);
    expect(modsKeyContext([enabledMod], byRow).singleCompareFileRow).toBe(false);
  });

  it('open conflicts sees exactly one selected mod that has a file order conflict', () => {
    const facts = (fileOrderConflict: boolean) => ({ holdsPlugin: false, tracked: false, fileOrderConflict });
    const conflicting = new ModNode({ kind: 'mod', name: 'Shares', enabled: true }, facts(true));
    const alone = new ModNode({ kind: 'mod', name: 'Alone', enabled: true }, facts(false));
    expect(modsKeyContext([conflicting], byRow).singleOpenConflictsRow).toBe(true);
    expect(modsKeyContext([alone], byRow).singleOpenConflictsRow).toBe(false);
    expect(modsKeyContext([conflicting, alone], byRow).singleOpenConflictsRow).toBe(false);
    expect(modsKeyContext([group], byRow).singleOpenConflictsRow).toBe(false);
    expect(modsKeyContext([], byRow).singleOpenConflictsRow).toBe(false);
  });

  it('open folder sees exactly one selected row it takes: a mod, Overwrite, a file or a folder', () => {
    const file = { relativePath: 'x/a.dds', path: '/instance/mods/On/x/a.dds', sourcePath: '/instance/mods/On/x/a.dds', excluded: false, excludedByName: false };
    const folder = new FolderNode(enabledMod, { kind: 'mod', name: 'On' }, { relativePath: 'x', path: '/instance/mods/On/x', excluded: false }, [file], [], 'x');
    const leaf = new FileNode(folder, folder.origin, file, 'a.dds');
    expect(modsKeyContext([folder], byRow).singleOpenFolderRow).toBe(true);
    expect(modsKeyContext([enabledMod], byRow).singleOpenFolderRow).toBe(true);
    expect(modsKeyContext([new OverwriteNode([], 'MO2')], byRow).singleOpenFolderRow).toBe(true);
    expect(modsKeyContext([leaf], byRow).singleOpenFolderRow).toBe(true);
    expect(modsKeyContext([group], byRow).singleOpenFolderRow).toBe(false);
    expect(modsKeyContext([enabledMod, leaf], byRow).singleOpenFolderRow).toBe(false);
    expect(modsKeyContext([], byRow).singleOpenFolderRow).toBe(false);
  });

  it('enable sees a selected disabled mod, and disable a selected enabled one, read as they are now', () => {
    expect(modsKeyContext([enabledMod, group], byRow)).toMatchObject({ holdsEnabledMod: true, holdsDisabledMod: false });
    expect(modsKeyContext([disabledMod], byRow)).toMatchObject({ holdsEnabledMod: false, holdsDisabledMod: true });
    expect(modsKeyContext([enabledMod, disabledMod], byRow)).toMatchObject({ holdsEnabledMod: true, holdsDisabledMod: true });
    expect(modsKeyContext([enabledMod], () => false)).toMatchObject({ holdsEnabledMod: false, holdsDisabledMod: true });
    expect(modsKeyContext([group], byRow)).toMatchObject({ holdsEnabledMod: false, holdsDisabledMod: false });
  });

  it('exclude sees a selected file whose own name has no mark, and include one whose own name has, whatever its folder', () => {
    const origin = { kind: 'mod', name: 'On' } as const;
    const fileAt = (relativePath: string, excluded: boolean, excludedByName: boolean) =>
      ({ relativePath, path: `/instance/mods/On/${relativePath}`, sourcePath: `/instance/mods/On/${relativePath}`, excluded, excludedByName });
    const included = new FileNode(enabledMod, origin, fileAt('a.dds', false, false), 'a.dds');
    const excluded = new FileNode(enabledMod, origin, fileAt('b.dds.mohidden', true, true), 'b.dds.mohidden');
    const hidingFolder = new FolderNode(enabledMod, origin, { relativePath: 'x.mohidden', path: '/instance/mods/On/x.mohidden', excluded: true }, [], [], 'x.mohidden');
    const plainInFolder = new FileNode(hidingFolder, origin, fileAt('x.mohidden/c.dds', true, false), 'c.dds');
    const markedInFolder = new FileNode(hidingFolder, origin, fileAt('x.mohidden/d.dds.mohidden', true, true), 'd.dds.mohidden');

    expect(modsKeyContext([included, group], byRow)).toMatchObject({ holdsIncludedFile: true, holdsExcludedFile: false });
    expect(modsKeyContext([excluded], byRow)).toMatchObject({ holdsIncludedFile: false, holdsExcludedFile: true });
    expect(modsKeyContext([included, excluded], byRow)).toMatchObject({ holdsIncludedFile: true, holdsExcludedFile: true });
    expect(modsKeyContext([plainInFolder, enabledMod], byRow)).toMatchObject({ holdsIncludedFile: true, holdsExcludedFile: false });
    expect(modsKeyContext([markedInFolder], byRow)).toMatchObject({ holdsIncludedFile: false, holdsExcludedFile: true });
  });
});
