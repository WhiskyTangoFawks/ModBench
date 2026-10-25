import { describe, it, expect, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, uriFile, uriFrom } from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, Uri: { file: uriFile, from: uriFrom },
}));

import { modsKeyContext } from '../gestureEntry';
import { file, folder } from './indexedValue';
import { ModNode, OverwriteNode, SeparatorNode } from '../ModListProvider';
import { FileNode, FolderNode } from '../modFiles';

const separatorRow = (name: string) => new SeparatorNode({ kind: 'separator', name, enabled: true }, []);

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

  it('the palette\'s decompile and commit sees a selection that holds a mod with no repository providing a plugin', () => {
    const withPlugin = new ModNode({ kind: 'mod', name: 'Patch', enabled: true }, { holdsPlugin: true, sourceMod: false });
    const sourceModWithPlugin = new ModNode({ kind: 'mod', name: 'SourceMod', enabled: true }, { holdsPlugin: true, sourceMod: true });
    expect(modsKeyContext([enabledMod, withPlugin], byRow).holdsNonSourceModWithPlugin).toBe(true);
    expect(modsKeyContext([enabledMod, sourceModWithPlugin], byRow).holdsNonSourceModWithPlugin).toBe(false);
    expect(modsKeyContext([enabledMod, group], byRow).holdsNonSourceModWithPlugin).toBe(false);
    expect(modsKeyContext([], byRow).holdsNonSourceModWithPlugin).toBe(false);
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

  const texturesFolder = new FolderNode(enabledMod, { kind: 'mod', name: 'On' }, folder('mods/On', 'textures'), [file('mods/On', 'textures/a.dds')], [], 'textures');
  const texturesLeaf = new FileNode(texturesFolder, texturesFolder.origin, file('mods/On', 'textures/a.dds'), 'a.dds');

  it.each([
    ['an enabled mod and a file', [enabledMod, texturesLeaf]],
    ['a disabled mod and a folder', [disabledMod, texturesFolder]],
    ['a separator and a file', [group, texturesLeaf]],
  ])('Space, Delete and F2 do nothing over %s, either of which may be the focused row', (_case, selection) => {
    expect(modsKeyContext(selection, byRow)).toMatchObject({ selectionToggle: undefined, selectionKind: undefined });
  });

  it('F2 and a singular gesture see whether exactly one row is selected', () => {
    expect(modsKeyContext([group], byRow).singleRow).toBe(true);
    expect(modsKeyContext([group, separatorRow('Other')], byRow).singleRow).toBe(false);
    expect(modsKeyContext([], byRow).singleRow).toBe(false);
  });

  it('go to mod sees exactly one selected file that is in a file order conflict', () => {
    const copy = file('mods/On', 'x/a.dds');
    const conflicting = new FileNode(enabledMod, { kind: 'mod', name: 'On' }, copy, 'a.dds', 'wins');
    const alone = new FileNode(enabledMod, { kind: 'mod', name: 'On' }, copy, 'a.dds');
    expect(modsKeyContext([conflicting], byRow).singleGoToModRow).toBe(true);
    expect(modsKeyContext([alone], byRow).singleGoToModRow).toBe(false);
    expect(modsKeyContext([conflicting, alone], byRow).singleGoToModRow).toBe(false);
    expect(modsKeyContext([enabledMod], byRow).singleGoToModRow).toBe(false);
    expect(modsKeyContext([], byRow).singleGoToModRow).toBe(false);
  });

  it('compare file sees exactly one selected file row that loses its file order conflict', () => {
    const copy = file('mods/On', 'x/a.dds');
    const origin = { kind: 'mod' as const, name: 'On' };
    const losing = new FileNode(enabledMod, origin, copy, 'a.dds', 'loses');
    const winning = new FileNode(enabledMod, origin, copy, 'a.dds', 'wins');
    expect(modsKeyContext([losing], byRow).singleCompareFileRow).toBe(true);
    expect(modsKeyContext([winning], byRow).singleCompareFileRow).toBe(false);
    expect(modsKeyContext([losing, losing], byRow).singleCompareFileRow).toBe(false);
    expect(modsKeyContext([enabledMod], byRow).singleCompareFileRow).toBe(false);
  });

  it('open source sees exactly one selected mod that holds a repository', () => {
    const facts = (sourceMod: boolean) => ({ holdsPlugin: false, sourceMod });
    const source = new ModNode({ kind: 'mod', name: 'Source', enabled: true }, facts(true));
    const plain = new ModNode({ kind: 'mod', name: 'Plain', enabled: true }, facts(false));
    expect(modsKeyContext([source], byRow).singleOpenSourceRow).toBe(true);
    expect(modsKeyContext([plain], byRow).singleOpenSourceRow).toBe(false);
    expect(modsKeyContext([source, plain], byRow).singleOpenSourceRow).toBe(false);
    expect(modsKeyContext([group], byRow).singleOpenSourceRow).toBe(false);
  });

  it('open folder sees exactly one selected row it takes: a mod, Overwrite, a file or a folder', () => {
    expect(modsKeyContext([texturesFolder], byRow).singleOpenFolderRow).toBe(true);
    expect(modsKeyContext([enabledMod], byRow).singleOpenFolderRow).toBe(true);
    expect(modsKeyContext([new OverwriteNode([], 'MO2')], byRow).singleOpenFolderRow).toBe(true);
    expect(modsKeyContext([texturesLeaf], byRow).singleOpenFolderRow).toBe(true);
    expect(modsKeyContext([group], byRow).singleOpenFolderRow).toBe(false);
    expect(modsKeyContext([enabledMod, texturesLeaf], byRow).singleOpenFolderRow).toBe(false);
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
    const fileAt = (relativePath: string, excluded: boolean, markedExcluded: boolean) =>
      ({ relativePath, path: `/instance/mods/On/${relativePath}`, sourcePath: `/instance/mods/On/${relativePath}`, excluded, markedExcluded, includedPath: relativePath });
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
