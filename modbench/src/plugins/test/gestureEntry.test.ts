import { describe, it, expect, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, uriFrom } from '../../test/vscodeMock';

const { registerCommand } = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler })),
}));

vi.mock('vscode', () => ({
  commands: { registerCommand },
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon,
  Uri: { from: uriFrom },
}));

import {
  PLUGINS_KEY_ARGS, compilableSelected, pluginsKeyContext, pluralArgument, registerPluginsGesture, selectionArgument, singularArgument,
  type GestureEntry,
} from '../gestureEntry';
import { ImplicitMasterNode, PluginNode, type PluginsTreeNode } from '../PluginsTreeProvider';
import { CellNode, RecordNode, RecordTypeNode } from '../PluginTreeProvider';
import { recordSummaryFixture } from '../../client/test/fixtures';

const pluginRow = (name: string, origin?: string) => new PluginNode({ name, enabled: true }, origin);
const lockedRow = (name: string) => new ImplicitMasterNode(name);

// VS Code's own calling convention: a context menu passes the right-clicked row, and the
// selection only when several rows are selected and the right-clicked row is among them. A key
// and the palette pass nothing.
function entryWhenInvoked(viewSelection: readonly PluginsTreeNode[], ...args: unknown[]): GestureEntry {
  let received: GestureEntry | undefined;
  const disposable = registerPluginsGesture('modbench.test.gesture', () => viewSelection, (entry) => { received = entry; });
  const call = registerCommand.mock.calls.at(-1);
  if (!call || call[0] !== 'modbench.test.gesture') throw new Error('the gesture registered no command');
  call[1](...args);
  disposable.dispose();
  if (!received) throw new Error('the gesture was not run');
  return received;
}

describe('what VS Code hands a Plugins gesture becomes its entry', () => {
  const alpha = pluginRow('Alpha.esp');
  const beta = pluginRow('Beta.esp');
  const gamma = pluginRow('Gamma.esp');

  it('a right-click inside a multi-selection gives a plural gesture the selection', () => {
    const entry = entryWhenInvoked([alpha, beta], beta, [alpha, beta]);
    expect(pluralArgument(entry, 'plugin')).toEqual([alpha, beta]);
  });

  it('a right-click outside the selection gives a plural gesture the right-clicked row alone', () => {
    const entry = entryWhenInvoked([alpha, beta], gamma, undefined);
    expect(pluralArgument(entry, 'plugin')).toEqual([gamma]);
  });

  it('a right-click gives a singular gesture the right-clicked row', () => {
    const entry = entryWhenInvoked([alpha, beta], beta, [alpha, beta]);
    expect(singularArgument(entry, 'plugin')).toBe(beta);
  });

  it('the palette gives a plural gesture the view\'s selection', () => {
    const entry = entryWhenInvoked([alpha, gamma]);
    expect(pluralArgument(entry, 'plugin')).toEqual([alpha, gamma]);
  });

  // A keybinding with no args of its own is invoked with null (VS Code 1.24 release notes).
  it('a key gives a plural gesture the view\'s selection', () => {
    const entry = entryWhenInvoked([beta, gamma], null);
    expect(pluralArgument(entry, 'plugin')).toEqual([beta, gamma]);
  });

  it('the palette gives a singular gesture the one selected row', () => {
    const entry = entryWhenInvoked([alpha]);
    expect(singularArgument(entry, 'plugin')).toBe(alpha);
  });

  it('the palette gives a singular gesture nothing while several rows are selected', () => {
    const entry = entryWhenInvoked([alpha, beta]);
    expect(singularArgument(entry, 'plugin')).toBeUndefined();
  });

  it('a key\'s own args give a plural gesture the view\'s selection, not the args', () => {
    const entry = entryWhenInvoked([beta, gamma], PLUGINS_KEY_ARGS);
    expect(pluralArgument(entry, 'plugin')).toEqual([beta, gamma]);
  });

  it('a key\'s own args give a singular gesture the one selected row', () => {
    const entry = entryWhenInvoked([gamma], PLUGINS_KEY_ARGS);
    expect(singularArgument(entry, 'plugin')).toBe(gamma);
  });

  it('fired from a key with one row selected, gives a plural gesture that one row', () => {
    const entry = entryWhenInvoked([beta], null);
    expect(pluralArgument(entry, 'plugin')).toEqual([beta]);
  });
});

describe('a plural Plugins gesture\'s Argument', () => {
  const alpha = pluginRow('Alpha.esp');
  const beta = pluginRow('Beta.esp');
  const gamma = pluginRow('Gamma.esp');

  it('is the whole selection from a context menu', () => {
    expect(pluralArgument({ clicked: beta, selection: [alpha, beta, gamma] }, 'plugin')).toEqual([alpha, beta, gamma]);
  });

  it('is the whole selection from a key', () => {
    expect(pluralArgument({ focused: gamma, selection: [alpha, beta, gamma] }, 'plugin')).toEqual([alpha, beta, gamma]);
  });

  it('is the whole selection from the palette', () => {
    expect(pluralArgument({ selection: [alpha, beta, gamma] }, 'plugin')).toEqual([alpha, beta, gamma]);
  });

  it('is nothing with no row and no selection', () => {
    expect(pluralArgument({ selection: [] }, 'plugin')).toEqual([]);
  });
});

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
    expect(singularArgument({ clicked: locked, selection: [locked] }, 'plugin')).toBeUndefined();
  });
});

describe('selectionArgument over a Plugins selection', () => {
  const alpha = pluginRow('Alpha.esp');
  const beta = pluginRow('Beta.esp');

  it('keeps every selected row of the kinds given, regardless of the right-clicked row\'s kind', () => {
    expect(selectionArgument({ clicked: beta, selection: [alpha, beta] }, 'plugin')).toEqual([alpha, beta]);
  });

  it('keeps every selected row of the kinds given for a key or the palette too', () => {
    expect(selectionArgument({ focused: beta, selection: [alpha, beta] }, 'plugin')).toEqual([alpha, beta]);
    expect(selectionArgument({ selection: [alpha, beta] }, 'plugin')).toEqual([alpha, beta]);
  });
});

describe('a singular Plugins gesture\'s Argument', () => {
  const alpha = pluginRow('Alpha.esp');
  const beta = pluginRow('Beta.esp');
  const gamma = pluginRow('Gamma.esp');

  it('is the right-clicked row, not the selection around it', () => {
    expect(singularArgument({ clicked: beta, selection: [alpha, beta, gamma] }, 'plugin')).toBe(beta);
  });

  it('is the focused row when reached by a key', () => {
    expect(singularArgument({ focused: gamma, selection: [alpha, beta, gamma] }, 'plugin')).toBe(gamma);
  });

  it('is nothing with no right-clicked or focused row', () => {
    expect(singularArgument({ selection: [] }, 'plugin')).toBeUndefined();
  });
});

// commands.md, Where: a palette entry and a key are handed no row, so their `when` reads what the
// Plugins selection holds, and the gesture is absent where it would have nothing to act on.
describe('what the Plugins palette entries and keys read off the selection', () => {
  const withFlags = <T extends PluginsTreeNode>(row: T, contextValue: string): T => {
    row.contextValue = contextValue;
    return row;
  };
  const alpha = pluginRow('Alpha.esp', 'ModA');
  const beta = pluginRow('Beta.esp', 'ModB');
  const untracked = withFlags(pluginRow('Gamma.esp', 'ModC'), 'plugin enabled inMod untracked editable');
  const alsoUntracked = withFlags(pluginRow('Zeta.esp', 'ModZ'), 'plugin enabled inMod untracked editable');
  const inOverwrite = withFlags(pluginRow('Eta.esp', 'overwrite'), 'plugin enabled inOverwrite untracked editable');
  const compilable = withFlags(pluginRow('Eps.esp', 'ModE'), 'plugin enabled inMod tracked editable');
  const trackedReadOnly = withFlags(pluginRow('Iota.esp', 'ModI'), 'plugin enabled inMod tracked');
  const weapons = new RecordTypeNode('Alpha.esp', 'weap', 3, 'Weapon', 'ModA', false, { tracked: true, editable: true });
  const untrackedWeapons = new RecordTypeNode('Beta.esp', 'weap', 3, 'Weapon', 'ModB');
  const own = new RecordNode(recordSummaryFixture({ formKey: '000800:Alpha.esp', plugin: 'Alpha.esp' }), 'ModA', false, true);
  const immutable = new RecordNode(recordSummaryFixture({ formKey: '000801:Alpha.esp', plugin: 'Alpha.esp' }), 'ModA', true, true);
  const untrackedRecord = new RecordNode(recordSummaryFixture({ formKey: '000802:Beta.esp', plugin: 'Beta.esp' }), 'ModB');
  const cell = new CellNode('Alpha.esp', {
    formKey: '000803:Alpha.esp', editorId: 'Cell', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false, fullName: null, hasParseFailure: false,
  }, 'ModA', { tracked: true, editable: true });
  const enabledNow = (row: PluginNode) => row !== beta;
  const context = (selection: readonly PluginsTreeNode[]) => pluginsKeyContext(selection, enabledNow);

  it('reveal sees exactly one selected plugin, a locked one too', () => {
    expect(context([alpha]).singlePlugin).toBe(true);
    expect(context([lockedRow('Fallout4.esm')]).singlePlugin).toBe(true);
    expect(context([alpha, beta]).singlePlugin).toBe(false);
    expect(context([weapons]).singlePlugin).toBe(false);
  });

  it('track sees a selection of untracked plugins in mods, every one', () => {
    expect(context([untracked, alsoUntracked])).toMatchObject({ allUntrackedInMod: true });
    expect(context([untracked, compilable])).toMatchObject({ allUntrackedInMod: false });
    expect(context([untracked, inOverwrite])).toMatchObject({ allUntrackedInMod: false });
    expect(context([])).toMatchObject({ allUntrackedInMod: false });
  });

  it('compile takes exactly one selected tracked, editable plugin', () => {
    expect(compilableSelected([compilable])).toBe(compilable);
    expect(compilableSelected([trackedReadOnly])).toBeUndefined();
    expect(compilableSelected([untracked])).toBeUndefined();
    expect(compilableSelected([compilable, alpha])).toBeUndefined();
  });

  // plugins.md, Menus and keys, story 7: no record edit on an untracked plugin.
  it('create sees exactly one selected record type whose plugin is tracked and editable', () => {
    expect(context([weapons]).singleEditableRecordType).toBe(true);
    expect(context([untrackedWeapons]).singleEditableRecordType).toBe(false);
    expect(context([weapons, alpha]).singleEditableRecordType).toBe(false);
  });

  // No item is sent that the gesture would refuse.
  it('delete sees a selection of records, cells included, their plugins all let it remove', () => {
    expect(context([own, cell]).allDeletableRecords).toBe(true);
    expect(context([own, immutable]).allDeletableRecords).toBe(false);
    expect(context([own, untrackedRecord]).allDeletableRecords).toBe(false);
    expect(context([own, alpha]).allDeletableRecords).toBe(false);
    expect(context([]).allDeletableRecords).toBe(false);
  });

  // A copy reads its source, so any record copies, whatever its plugin allows.
  it('copy sees a selection of records, cells included, whatever their plugins allow', () => {
    expect(context([own, cell, immutable, untrackedRecord]).allRecords).toBe(true);
    expect(context([own, alpha]).allRecords).toBe(false);
    expect(context([]).allRecords).toBe(false);
  });

  // mods.md, Menus and keys, story 3, which plugins.md story 5 follows: Space takes the focused
  // row's direction, and a selection of one row stands for the focused row.
  it('Space takes the first selected plugin\'s direction, as its line is now', () => {
    expect(context([alpha, beta]).selectionToggle).toBe('disable');
    expect(context([beta, alpha]).selectionToggle).toBe('enable');
    expect(context([own, beta]).selectionToggle).toBe('enable');
  });

  it('Space does nothing over a selection with no plugin', () => {
    expect(context([own, lockedRow('Fallout4.esm')]).selectionToggle).toBeUndefined();
  });
});
