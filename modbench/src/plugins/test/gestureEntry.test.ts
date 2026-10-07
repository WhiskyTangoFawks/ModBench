import { describe, it, expect, vi, beforeAll } from 'vitest';
import { TreeItem, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, uriFrom } from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  TreeItem, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon,
  Uri: { from: uriFrom },
}));

import { compilableSelected, pluginsKeyContext } from '../gestureEntry';
import { pluralArgument, selectionArgument, singularArgument } from '../../drivingLib/gestureEntry';
import { ImplicitMasterNode, PluginNode, type PluginsTreeNode } from '../PluginsTreeProvider';
import type { PluginTreeNode } from '../PluginTreeProvider';
import { recordSummaryFixture } from '../../client/test/fixtures';
import { cellRow, recordGroupRow, recordRow } from './browserRows';

const pluginRow = (name: string, origin = 'SomeMod') => new PluginNode({ name, enabled: true }, origin);
const lockedRow = (name: string) => new ImplicitMasterNode(name, 'Data');

describe('the locked rows (a plugin the game loads with no line) never carry the Argument', () => {
  const alpha = pluginRow('Alpha.esp');
  const locked = lockedRow('Fallout4.esm');

  it('a plural gesture drops a locked row from a mixed selection', () => {
    expect(pluralArgument({ clicked: alpha, selection: [locked, alpha] }, 'plugin')).toEqual([alpha]);
  });

  it('selectionArgument drops a locked row from a mixed selection too', () => {
    expect(selectionArgument({ clicked: alpha, selection: [locked, alpha] }, 'plugin')).toEqual([alpha]);
  });

  it('a singular gesture right-clicked on a locked row takes nothing', () => {
    expect(singularArgument<PluginsTreeNode, 'plugin'>({ clicked: locked, selection: [locked] }, 'plugin')).toBeUndefined();
  });
});

describe('what the Plugins palette entries and keys read off the selection', () => {
  const withFlags = <T extends PluginsTreeNode>(row: T, contextValue: string): T => {
    row.contextValue = contextValue;
    return row;
  };
  const alpha = pluginRow('Alpha.esp', 'ModA');
  const beta = pluginRow('Beta.esp', 'ModB');
  const untracked = withFlags(pluginRow('Gamma.esp', 'ModC'), 'plugin enabled inUntrackedMod untracked editable');
  const alsoUntracked = withFlags(pluginRow('Zeta.esp', 'ModZ'), 'plugin enabled inUntrackedMod untracked editable');
  const inOverwrite = withFlags(pluginRow('Eta.esp', 'overwrite'), 'plugin enabled inOverwrite untracked editable');
  const compilable = withFlags(pluginRow('Eps.esp', 'ModE'), 'plugin enabled inTrackedMod tracked editable');
  const trackedReadOnly = withFlags(pluginRow('Iota.esp', 'ModI'), 'plugin enabled inTrackedMod tracked');
  const untrackedInTrackedMod = withFlags(pluginRow('Kappa.esp', 'ModE'), 'plugin enabled inTrackedMod untracked editable');
  const ALPHA = { name: 'Alpha.esp', origin: 'ModA' };
  const EDITABLE = { tracked: true, editable: true };
  const WEAPON = { type: 'weap', count: 3, displayName: 'Weapon' };
  const ownRecord = (formKey: string, plugin: string, origin: string, conditions: { tracked: boolean; editable: boolean }, recordType?: string) =>
    recordRow(recordSummaryFixture({ formKey, plugin }), origin, conditions, recordType);
  let weapons: PluginTreeNode;
  let untrackedWeapons: PluginTreeNode;
  let quests: PluginTreeNode;
  let own: PluginTreeNode;
  let immutable: PluginTreeNode;
  let untrackedRecord: PluginTreeNode;
  let cell: PluginTreeNode;
  let quest: PluginTreeNode;
  let readOnlyQuest: PluginTreeNode;
  beforeAll(async () => {
    weapons = await recordGroupRow(WEAPON, ALPHA, EDITABLE);
    untrackedWeapons = await recordGroupRow(WEAPON, { name: 'Beta.esp', origin: 'ModB' });
    quests = await recordGroupRow({ type: 'qust', count: 1, displayName: 'Quest', isCreatable: false }, ALPHA, EDITABLE);
    own = await ownRecord('000800:Alpha.esp', 'Alpha.esp', 'ModA', EDITABLE);
    immutable = await ownRecord('000801:Alpha.esp', 'Alpha.esp', 'ModA', { tracked: true, editable: false });
    untrackedRecord = await ownRecord('000802:Beta.esp', 'Beta.esp', 'ModB', { tracked: false, editable: true });
    cell = await cellRow({
      formKey: '000803:Alpha.esp', editorId: 'Cell', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false, hasChildren: false, fullName: null, hasParseFailure: false,
    }, ALPHA, EDITABLE);
    quest = await ownRecord('000804:Alpha.esp', 'Alpha.esp', 'ModA', EDITABLE, 'qust');
    readOnlyQuest = await ownRecord('000805:Alpha.esp', 'Alpha.esp', 'ModA', { tracked: true, editable: false }, 'qust');
  });
  const enabledNow = (row: PluginNode) => row !== beta;
  const context = (selection: readonly PluginsTreeNode[]) => pluginsKeyContext(selection, enabledNow);

  it('reveal sees exactly one selected plugin, a locked one too', () => {
    expect(context([alpha]).singlePlugin).toBe(true);
    expect(context([lockedRow('Fallout4.esm')]).singlePlugin).toBe(true);
    expect(context([alpha, beta]).singlePlugin).toBe(false);
    expect(context([weapons]).singlePlugin).toBe(false);
  });

  it('track sees a selection of plugins in mods with no repository, every one', () => {
    expect(context([untracked, alsoUntracked])).toMatchObject({ allInUntrackedMod: true });
    expect(context([untracked, compilable])).toMatchObject({ allInUntrackedMod: false });
    expect(context([untracked, inOverwrite])).toMatchObject({ allInUntrackedMod: false });
    expect(context([])).toMatchObject({ allInUntrackedMod: false });
  });

  it('decompile sees a selection of plugins in tracked mods, every one', () => {
    expect(context([compilable, trackedReadOnly, untrackedInTrackedMod])).toMatchObject({ allInTrackedMod: true });
    expect(context([compilable, untracked])).toMatchObject({ allInTrackedMod: false });
    expect(context([compilable, inOverwrite])).toMatchObject({ allInTrackedMod: false });
    expect(context([])).toMatchObject({ allInTrackedMod: false });
  });

  it('rename sees exactly one selected tracked plugin, editable or not', () => {
    expect(context([compilable]).singleTracked).toBe(true);
    expect(context([trackedReadOnly]).singleTracked).toBe(true);
    expect(context([untracked]).singleTracked).toBe(false);
    expect(context([compilable, trackedReadOnly]).singleTracked).toBe(false);
    expect(context([weapons]).singleTracked).toBe(false);
    expect(context([]).singleTracked).toBe(false);
  });

  it('compile takes exactly one selected tracked, editable plugin', () => {
    expect(compilableSelected([compilable])).toBe(compilable);
    expect(compilableSelected([trackedReadOnly])).toBeUndefined();
    expect(compilableSelected([untracked])).toBeUndefined();
    expect(compilableSelected([compilable, alpha])).toBeUndefined();
  });

  it('create sees exactly one selected record type or plugin that is tracked and editable', () => {
    expect(context([weapons]).singleCreatable).toBe(true);
    expect(context([compilable]).singleCreatable).toBe(true);
    expect(context([untrackedWeapons]).singleCreatable).toBe(false);
    expect(context([trackedReadOnly]).singleCreatable).toBe(false);
    expect(context([untracked]).singleCreatable).toBe(false);
    expect(context([weapons, compilable]).singleCreatable).toBe(false);
    expect(context([own]).singleCreatable).toBe(false);
  });

  it('create does not see a tracked, editable group of a type the game cannot create', () => {
    expect(context([quests]).singleCreatable).toBe(false);
  });

  it('create sees exactly one selected container whose plugin is tracked and editable, a cell included', () => {
    expect(context([quest]).singleCreatable).toBe(true);
    expect(context([cell]).singleCreatable).toBe(true);
    expect(context([readOnlyQuest]).singleCreatable).toBe(false);
    expect(context([own]).singleCreatable).toBe(false);
    expect(context([quest, cell]).singleCreatable).toBe(false);
  });

  it('delete sees a selection of records, cells included, their plugins all let it remove', () => {
    expect(context([own, cell]).allDeletableRecords).toBe(true);
    expect(context([own, immutable]).allDeletableRecords).toBe(false);
    expect(context([own, untrackedRecord]).allDeletableRecords).toBe(false);
    expect(context([own, alpha]).allDeletableRecords).toBe(false);
    expect(context([]).allDeletableRecords).toBe(false);
  });

  it('copy sees a selection of records, cells included, whatever their plugins allow', () => {
    expect(context([own, cell, immutable, untrackedRecord]).allRecords).toBe(true);
    expect(context([own, alpha]).allRecords).toBe(false);
    expect(context([]).allRecords).toBe(false);
  });

  it('Space takes the first selected plugin\'s direction, as its line is now', () => {
    expect(context([alpha, beta]).selectionToggle).toBe('disable');
    expect(context([beta, alpha]).selectionToggle).toBe('enable');
    expect(context([own, beta]).selectionToggle).toBe('enable');
  });

  it('Space does nothing over a selection with no plugin', () => {
    expect(context([own, lockedRow('Fallout4.esm')]).selectionToggle).toBeUndefined();
  });
});
