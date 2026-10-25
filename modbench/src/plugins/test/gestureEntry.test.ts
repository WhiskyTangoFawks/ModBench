import { describe, it, expect, vi, beforeAll } from 'vitest';
import { TreeItem, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, uriFrom } from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  TreeItem, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon,
  Uri: { from: uriFrom },
}));

import { pluginsKeyContext, type PluginsKeyContext } from '../gestureEntry';
import { ImplicitMasterNode, PluginNode, type PluginsTreeNode } from '../pluginRows';
import type { RecordBrowserNode } from '../RecordBrowser';
import { recordSummaryFixture } from '../../client/test/fixtures';
import { cellRow, recordGroupRow, recordRow } from './browserRows';

const pluginRow = (name: string, origin = 'SomeMod') => new PluginNode({ name, enabled: true }, origin);
const lockedRow = (name: string) => new ImplicitMasterNode(name, 'Data/');

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

  type Case = [string, () => readonly PluginsTreeNode[], Partial<PluginsKeyContext>];
  const reads = (_label: string, selection: () => readonly PluginsTreeNode[], expected: Partial<PluginsKeyContext>) => {
    expect(context(selection())).toMatchObject(expected);
  };

  describe('reveal sees exactly one selected plugin, a locked one too', () => {
    it.each<Case>([
      ['one plugin', () => [alpha], { singlePlugin: true }],
      ['one locked plugin', () => [lockedRow('Fallout4.esm')], { singlePlugin: true }],
      ['two plugins', () => [alpha, beta], { singlePlugin: false }],
      ['a record-type group', () => [weapons], { singlePlugin: false }],
    ])('%s', reads);
  });

  describe('decompile and commit sees a selection of plugins in mods with no repository, every one', () => {
    it.each<Case>([
      ['two in mods with no repository', () => [nonCompiledPlugin, alsoNonCompiledPlugin], { allInNonSourceMod: true }],
      ['one beside a plugin in a source mod', () => [nonCompiledPlugin, compilable], { allInNonSourceMod: false }],
      ['one beside a plugin in Overwrite', () => [nonCompiledPlugin, inOverwrite], { allInNonSourceMod: false }],
      ['nothing', () => [], { allInNonSourceMod: false }],
    ])('%s', reads);
  });

  describe('decompile sees a selection of plugins in source mods, every one', () => {
    it.each<Case>([
      ['compiled, read-only and source-less plugins of source mods', () => [compilable, compiledPluginReadOnly, nonCompiledPluginInSourceMod], { allInSourceMod: true }],
      ['one beside a plugin in a mod with no repository', () => [compilable, nonCompiledPlugin], { allInSourceMod: false }],
      ['one beside a plugin in Overwrite', () => [compilable, inOverwrite], { allInSourceMod: false }],
      ['nothing', () => [], { allInSourceMod: false }],
    ])('%s', reads);
  });

  describe('decompile and repair sees a selection of malformed plugins in mods, every one', () => {
    const malformedInASourceMod = withFlags(pluginRow('Mu.esp', 'ModE'), 'plugin enabled inSourceMod compiledPlugin malformed');
    const malformedInNoSourceMod = withFlags(pluginRow('Nu.esp', 'ModC'), 'plugin enabled inNonSourceMod nonCompiledPlugin malformed');
    const malformedInTheGameFolder = withFlags(pluginRow('Xi.esp', 'Data/'), 'plugin enabled nonCompiledPlugin malformed');

    it.each<Case>([
      ['malformed plugins of a source mod and of a mod with no repository', () => [malformedInASourceMod, malformedInNoSourceMod], { allMalformedInAMod: true }],
      ['one beside a plugin not malformed', () => [malformedInASourceMod, compilable], { allMalformedInAMod: false }],
      ['a malformed plugin in the game folder', () => [malformedInTheGameFolder], { allMalformedInAMod: false }],
      ['nothing', () => [], { allMalformedInAMod: false }],
    ])('%s', reads);
  });

  describe('rename sees exactly one selected compiled plugin, editable or not', () => {
    it.each<Case>([
      ['an editable compiled plugin', () => [compilable], { singleCompiledPlugin: true }],
      ['a read-only compiled plugin', () => [compiledPluginReadOnly], { singleCompiledPlugin: true }],
      ['a plugin with no source', () => [nonCompiledPlugin], { singleCompiledPlugin: false }],
      ['two compiled plugins', () => [compilable, compiledPluginReadOnly], { singleCompiledPlugin: false }],
      ['a record-type group', () => [weapons], { singleCompiledPlugin: false }],
      ['nothing', () => [], { singleCompiledPlugin: false }],
    ])('%s', reads);
  });

  describe('create sees exactly one selected record type, plugin or container that is a compiled plugin\'s and editable', () => {
    it.each<Case>([
      ['an editable group', () => [weapons], { singleCreatable: true }],
      ['an editable compiled plugin', () => [compilable], { singleCreatable: true }],
      ['a group of a plugin with no source', () => [nonCompiledPluginWeapons], { singleCreatable: false }],
      ['a read-only compiled plugin', () => [compiledPluginReadOnly], { singleCreatable: false }],
      ['a plugin with no source', () => [nonCompiledPlugin], { singleCreatable: false }],
      ['a group and a plugin', () => [weapons, compilable], { singleCreatable: false }],
      ['a record that is no container', () => [own], { singleCreatable: false }],
      ['an editable group of a type the game cannot create', () => [quests], { singleCreatable: false }],
      ['an editable container', () => [quest], { singleCreatable: true }],
      ['an editable cell', () => [cell], { singleCreatable: true }],
      ['a read-only container', () => [readOnlyQuest], { singleCreatable: false }],
      ['two containers', () => [quest, cell], { singleCreatable: false }],
    ])('%s', reads);
  });

  describe('delete sees a selection of records, cells included, their plugins all let it remove', () => {
    it.each<Case>([
      ['a record and a cell of an editable plugin', () => [own, cell], { allDeletableRecords: true }],
      ['one beside a record of an immutable plugin', () => [own, immutable], { allDeletableRecords: false }],
      ['one beside a record of a plugin with no source', () => [own, nonCompiledPluginRecord], { allDeletableRecords: false }],
      ['one beside a plugin', () => [own, alpha], { allDeletableRecords: false }],
      ['nothing', () => [], { allDeletableRecords: false }],
    ])('%s', reads);
  });

  describe('copy sees a selection of records, cells included, whatever their plugins allow', () => {
    it.each<Case>([
      ['records of every plugin', () => [own, cell, immutable, nonCompiledPluginRecord], { allRecords: true }],
      ['one beside a plugin', () => [own, alpha], { allRecords: false }],
      ['nothing', () => [], { allRecords: false }],
    ])('%s', reads);
  });

  describe('Space takes the first selected plugin\'s direction, as its line is now, and does nothing over no plugin', () => {
    it.each<Case>([
      ['an enabled plugin first', () => [alpha, beta], { selectionToggle: 'disable' }],
      ['a disabled plugin first', () => [beta, alpha], { selectionToggle: 'enable' }],
      ['a disabled plugin after a record', () => [own, beta], { selectionToggle: 'enable' }],
      ['a record and a locked plugin', () => [own, lockedRow('Fallout4.esm')], { selectionToggle: undefined }],
    ])('%s', reads);
  });

  describe('enable sees a selection holding a plugin whose line is disabled now, disable one whose line is enabled', () => {
    it.each<Case>([
      ['an enabled and a disabled plugin', () => [alpha, beta], { holdsEnabledPlugin: true, holdsDisabledPlugin: true }],
      ['an enabled plugin', () => [alpha], { holdsEnabledPlugin: true, holdsDisabledPlugin: false }],
      ['a disabled plugin and a record', () => [beta, own], { holdsEnabledPlugin: false, holdsDisabledPlugin: true }],
      ['a record and a locked plugin', () => [own, lockedRow('Fallout4.esm')], { holdsEnabledPlugin: false, holdsDisabledPlugin: false }],
      ['nothing', () => [], { holdsEnabledPlugin: false, holdsDisabledPlugin: false }],
    ])('%s', reads);
  });

  describe('move sees a selection holding a plugin with a plugins.txt line', () => {
    it.each<Case>([
      ['a plugin among a record and a locked plugin', () => [own, lockedRow('Fallout4.esm'), alpha], { holdsPluginLine: true }],
      ['a record and a locked plugin', () => [own, lockedRow('Fallout4.esm')], { holdsPluginLine: false }],
      ['nothing', () => [], { holdsPluginLine: false }],
    ])('%s', reads);
  });
});
