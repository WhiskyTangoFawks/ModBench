import { describe, it, expect, vi, beforeAll } from 'vitest';
import { TreeItem, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, uriFrom } from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  TreeItem, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon,
  Uri: { from: uriFrom },
}));

import { pluginsKeyContext } from '../gestureEntry';
import { pluralArgument, selectionArgument, singularArgument } from '../../drivingLib/gestureEntry';
import { ImplicitMasterNode, PluginNode, type PluginsTreeNode } from '../pluginRows';
import type { RecordBrowserNode } from '../RecordBrowser';
import { recordSummaryFixture } from '../../client/test/fixtures';
import { cellRow, recordGroupRow, recordRow } from './browserRows';

const pluginRow = (name: string, origin = 'SomeMod') => new PluginNode({ name, enabled: true }, origin);
const lockedRow = (name: string) => new ImplicitMasterNode(name, 'Data/');

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
  const nonCompiledPlugin = withFlags(pluginRow('Gamma.esp', 'ModC'), 'plugin enabled inNonSourceMod nonCompiledPlugin');
  const alsoNonCompiledPlugin = withFlags(pluginRow('Zeta.esp', 'ModZ'), 'plugin enabled inNonSourceMod nonCompiledPlugin');
  const inOverwrite = withFlags(pluginRow('Eta.esp', 'overwrite/'), 'plugin enabled inOverwrite nonCompiledPlugin');
  const compilable = withFlags(pluginRow('Eps.esp', 'ModE'), 'plugin enabled inSourceMod compiledPlugin editable');
  const compiledPluginReadOnly = withFlags(pluginRow('Iota.esp', 'ModI'), 'plugin enabled inSourceMod compiledPlugin');
  const nonCompiledPluginInSourceMod = withFlags(pluginRow('Kappa.esp', 'ModE'), 'plugin enabled inSourceMod nonCompiledPlugin');
  const ALPHA = { name: 'Alpha.esp', origin: 'ModA' };
  const EDITABLE = { editable: true };
  const WEAPON = { type: 'weap', count: 3, displayName: 'Weapon' };
  const ownRecord = (formKey: string, plugin: string, origin: string, conditions: { editable: boolean }, recordType?: string) =>
    recordRow(recordSummaryFixture({ formKey, plugin }), origin, conditions, recordType);
  let weapons: RecordBrowserNode;
  let nonCompiledPluginWeapons: RecordBrowserNode;
  let quests: RecordBrowserNode;
  let own: RecordBrowserNode;
  let immutable: RecordBrowserNode;
  let nonCompiledPluginRecord: RecordBrowserNode;
  let cell: RecordBrowserNode;
  let quest: RecordBrowserNode;
  let readOnlyQuest: RecordBrowserNode;
  beforeAll(async () => {
    weapons = await recordGroupRow(WEAPON, ALPHA, EDITABLE);
    nonCompiledPluginWeapons = await recordGroupRow(WEAPON, { name: 'Beta.esp', origin: 'ModB' });
    quests = await recordGroupRow({ type: 'qust', count: 1, displayName: 'Quest', isCreatable: false }, ALPHA, EDITABLE);
    own = await ownRecord('000800:Alpha.esp', 'Alpha.esp', 'ModA', EDITABLE);
    immutable = await ownRecord('000801:Alpha.esp', 'Alpha.esp', 'ModA', { editable: false });
    nonCompiledPluginRecord = await ownRecord('000802:Beta.esp', 'Beta.esp', 'ModB', { editable: false });
    cell = await cellRow({
      formKey: '000803:Alpha.esp', editorId: 'Cell', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false, hasChildren: false, fullName: null, hasParseFailure: false, workingTreeState: 'None',
    }, ALPHA, EDITABLE);
    quest = await ownRecord('000804:Alpha.esp', 'Alpha.esp', 'ModA', EDITABLE, 'qust');
    readOnlyQuest = await ownRecord('000805:Alpha.esp', 'Alpha.esp', 'ModA', { editable: false }, 'qust');
  });
  const enabledNow = (row: PluginNode) => row !== beta;
  const context = (selection: readonly PluginsTreeNode[]) => pluginsKeyContext(selection, enabledNow);

  it('reveal sees exactly one selected plugin, a locked one too', () => {
    expect(context([alpha]).singlePlugin).toBe(true);
    expect(context([lockedRow('Fallout4.esm')]).singlePlugin).toBe(true);
    expect(context([alpha, beta]).singlePlugin).toBe(false);
    expect(context([weapons]).singlePlugin).toBe(false);
  });

  it('decompile and commit sees a selection of plugins in mods with no repository, every one', () => {
    expect(context([nonCompiledPlugin, alsoNonCompiledPlugin])).toMatchObject({ allInNonSourceMod: true });
    expect(context([nonCompiledPlugin, compilable])).toMatchObject({ allInNonSourceMod: false });
    expect(context([nonCompiledPlugin, inOverwrite])).toMatchObject({ allInNonSourceMod: false });
    expect(context([])).toMatchObject({ allInNonSourceMod: false });
  });

  it('decompile sees a selection of plugins in source mods, every one', () => {
    expect(context([compilable, compiledPluginReadOnly, nonCompiledPluginInSourceMod])).toMatchObject({ allInSourceMod: true });
    expect(context([compilable, nonCompiledPlugin])).toMatchObject({ allInSourceMod: false });
    expect(context([compilable, inOverwrite])).toMatchObject({ allInSourceMod: false });
    expect(context([])).toMatchObject({ allInSourceMod: false });
  });

  it('rename sees exactly one selected compiled plugin, editable or not', () => {
    expect(context([compilable]).singleCompiledPlugin).toBe(true);
    expect(context([compiledPluginReadOnly]).singleCompiledPlugin).toBe(true);
    expect(context([nonCompiledPlugin]).singleCompiledPlugin).toBe(false);
    expect(context([compilable, compiledPluginReadOnly]).singleCompiledPlugin).toBe(false);
    expect(context([weapons]).singleCompiledPlugin).toBe(false);
    expect(context([]).singleCompiledPlugin).toBe(false);
  });

  it('create sees exactly one selected record type or plugin that is a compiled plugin and editable', () => {
    expect(context([weapons]).singleCreatable).toBe(true);
    expect(context([compilable]).singleCreatable).toBe(true);
    expect(context([nonCompiledPluginWeapons]).singleCreatable).toBe(false);
    expect(context([compiledPluginReadOnly]).singleCreatable).toBe(false);
    expect(context([nonCompiledPlugin]).singleCreatable).toBe(false);
    expect(context([weapons, compilable]).singleCreatable).toBe(false);
    expect(context([own]).singleCreatable).toBe(false);
  });

  it('create does not see a compiled plugin, editable group of a type the game cannot create', () => {
    expect(context([quests]).singleCreatable).toBe(false);
  });

  it('create sees exactly one selected container whose plugin is a compiled plugin and editable, a cell included', () => {
    expect(context([quest]).singleCreatable).toBe(true);
    expect(context([cell]).singleCreatable).toBe(true);
    expect(context([readOnlyQuest]).singleCreatable).toBe(false);
    expect(context([own]).singleCreatable).toBe(false);
    expect(context([quest, cell]).singleCreatable).toBe(false);
  });

  it('delete sees a selection of records, cells included, their plugins all let it remove', () => {
    expect(context([own, cell]).allDeletableRecords).toBe(true);
    expect(context([own, immutable]).allDeletableRecords).toBe(false);
    expect(context([own, nonCompiledPluginRecord]).allDeletableRecords).toBe(false);
    expect(context([own, alpha]).allDeletableRecords).toBe(false);
    expect(context([]).allDeletableRecords).toBe(false);
  });

  it('copy sees a selection of records, cells included, whatever their plugins allow', () => {
    expect(context([own, cell, immutable, nonCompiledPluginRecord]).allRecords).toBe(true);
    expect(context([own, alpha]).allRecords).toBe(false);
    expect(context([]).allRecords).toBe(false);
  });

  it('Space takes the first selected plugin\'s direction, as its line is now', () => {
    expect(context([alpha, beta]).selectionToggle).toBe('disable');
    expect(context([beta, alpha]).selectionToggle).toBe('enable');
    expect(context([own, beta]).selectionToggle).toBe('enable');
  });

  it('enable sees a selection holding a plugin whose line is disabled now, disable one whose line is enabled', () => {
    expect(context([alpha, beta])).toMatchObject({ holdsEnabledPlugin: true, holdsDisabledPlugin: true });
    expect(context([alpha])).toMatchObject({ holdsEnabledPlugin: true, holdsDisabledPlugin: false });
    expect(context([beta, own])).toMatchObject({ holdsEnabledPlugin: false, holdsDisabledPlugin: true });
    expect(context([own, lockedRow('Fallout4.esm')])).toMatchObject({ holdsEnabledPlugin: false, holdsDisabledPlugin: false });
    expect(context([])).toMatchObject({ holdsEnabledPlugin: false, holdsDisabledPlugin: false });
  });

  it('move sees a selection holding a plugin with a plugins.txt line', () => {
    expect(context([own, lockedRow('Fallout4.esm'), alpha]).holdsPluginLine).toBe(true);
    expect(context([own, lockedRow('Fallout4.esm')]).holdsPluginLine).toBe(false);
    expect(context([]).holdsPluginLine).toBe(false);
  });

  it('Space does nothing over a selection with no plugin', () => {
    expect(context([own, lockedRow('Fallout4.esm')]).selectionToggle).toBeUndefined();
  });
});
