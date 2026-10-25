import { describe, it, expect, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, uriFrom } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, Uri: { from: uriFrom } }));

import { targetsOf, viewOf, type ModTargets } from '../sourceGestureTargets';
import { ModNode } from '../ModListProvider';
import { PluginRowStandIn } from './sourceGestureHarness';
import { modOfOriginIn } from '../../test/mo2/instanceValueFixture';

const modRow = (name: string) => new ModNode({ kind: 'mod', name, enabled: true });
const pluginRow = (name: string, origin: string) => new PluginRowStandIn({ name, origin });
const columnHeader = (name: string, origin: string) =>
  ({ webviewSection: 'recordHeader', argument: { kind: 'record', formKey: `000801:${name}`, plugin: { name, origin } } });
const PLUGINS_VIEW = 'modbench.pluginListTree';

describe('the mods a source gesture sends for the rows it was given', () => {
  it.each<[string, unknown[], ModTargets]>([
    ['a Mods row sends its mod, the mod order listing it or not', [modRow('Unlisted')], { mods: ['Unlisted'], refusedRows: [] }],
    ['a plugin row sends its plugin\'s mod', [pluginRow('A.esp', 'ModA')], { mods: ['ModA'], refusedRows: [] }],
    ['a record tab\'s column header sends its plugin\'s mod', [columnHeader('B.esp', 'ModB')], { mods: ['ModB'], refusedRows: [] }],
    ['a selection sends each mod once, in the order first given', [pluginRow('A.esp', 'ModA'), modRow('ModB'), modRow('ModA'), pluginRow('Also.esp', 'ModA')],
      { mods: ['ModA', 'ModB'], refusedRows: [] }],
    ['a plugin no mod provides is refused as not in a mod', [pluginRow('Loose.esp', 'Overwrite')],
      { mods: [], refusedRows: [{ item: 'Loose.esp (Overwrite)', reason: 'it is not in a mod' }] }],
    ['a row that carries no mod or plugin is refused', [new TreeItem('Separator')],
      { mods: [], refusedRows: [{ item: 'Separator', reason: 'it carries no mod or plugin' }] }],
  ])('%s', (_case, rows, targets) => {
    expect(targetsOf(rows, modOfOriginIn('ModA', 'ModB'))).toEqual(targets);
  });
});

describe('the view whose bar a source gesture runs under', () => {
  it.each<[string, unknown[], string]>([
    ['the Mods view for a Mods row', [modRow('ModA')], 'modbench.modList'],
    ['the Mods view for a selection holding a Mods row', [pluginRow('A.esp', 'ModA'), modRow('ModB')], 'modbench.modList'],
    ['the Plugins view for a plugin row', [pluginRow('A.esp', 'ModA')], PLUGINS_VIEW],
    ['the Plugins view for a column header', [columnHeader('B.esp', 'ModB')], PLUGINS_VIEW],
  ])('is %s', (_case, rows, view) => {
    expect(viewOf(rows, PLUGINS_VIEW)).toBe(view);
  });
});
