import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, EventEmitter, uriFrom,
} from '../../test/vscodeMock';

// Captures every registerCommand(id, handler) so the row's handler can be invoked directly.
const {
  handlers, registerCommand, executeCommand, showInputBox, showQuickPick,
} = vi.hoisted(() => {
  const handlers = new Map<string, (ctx?: unknown) => Promise<void> | void>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (ctx?: unknown) => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    executeCommand: vi.fn(),
    showInputBox: vi.fn(),
    showQuickPick: vi.fn(),
  };
});

vi.mock('vscode', () => ({
  commands: { registerCommand, executeCommand },
  window: { showInputBox, showQuickPick },
  Uri: { file: (p: string) => ({ fsPath: p }), from: uriFrom },
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, EventEmitter,
}));

vi.mock('../../pluginsCommands/plugins', () => ({ appendPlugin: vi.fn() }));

import {
  pluginsCopyValueText, registerCreatePluginCommand, registerPluginSortCommands, registerRevealInExplorerCommand,
} from '../pluginListCommands';
import { PLUGINS_KEY_ARGS } from '../gestureEntry';
import { CellNode, PlacedNode, RecordNode, RecordTypeNode, WorldspaceNode } from '../PluginTreeProvider';
import { recordSummaryFixture } from '../../client/test/fixtures';
import { ImplicitMasterNode, PluginNode, PluginsTreeProvider, pluginFileOf, type PluginsTreeNode } from '../PluginsTreeProvider';
import { appendPlugin } from '../../pluginsCommands/plugins';
import { InMemoryMEditClient } from '../../client';
import { recordingReporter } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { expectInstancesOf } from '../../test/expectInstanceOf';

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

function makeMo2() {
  return {
    instance: {
      value: instanceValueFixture({
        paths: { overwriteDir: '/instance/overwrite', downloadsDir: '/instance/downloads', modDirs: new Map() },
      }),
    },
    instanceRoot: '/instance',
  };
}

describe('registerCreatePluginCommand', () => {
  function invoke(client: InMemoryMEditClient, mo2: ReturnType<typeof makeMo2> | undefined) {
    const reporter = recordingReporter();
    registerCreatePluginCommand(client, mo2, reporter);
    return { run: present(handlers.get('modbench.plugin.create'), "the create plugin command's registered handler"), reporter };
  }

  it('appends the created plugin to the load order and lands the created toast', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('createPlugin', { name: 'MyPatch.esp', path: '/mods/MyMod/MyPatch.esp', origin: 'MyMod', slot: null, version: 1 });
    const mo2 = makeMo2();
    showInputBox.mockResolvedValue('MyPatch.esp');
    showQuickPick.mockResolvedValue({ choice: 'overwrite' });
    vi.mocked(appendPlugin).mockResolvedValue({ applied: true, wrote: true });

    const { run, reporter } = invoke(client, mo2);
    await run();

    expect(client.calls).toContainEqual({ method: 'createPlugin', args: ['MyPatch.esp', '/instance/overwrite', 'overwrite'] });
    expect(appendPlugin).toHaveBeenCalledWith('/instance', 'Default', 'MyPatch.esp');
    expect(reporter.landings).toEqual(['Created "MyPatch.esp".']);
    expect(reporter.reports).toEqual([]);
  });

  // The rival: landing the created toast (or appending to the load order) on a refusal too would
  // add a plugins.txt line for a file the backend never actually wrote.
  it('reports the ready-to-show message at error and never appends to the load order when the backend refuses', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('createPlugin', { refused: true, message: 'Failed to create plugin — Bad Request' });
    const mo2 = makeMo2();
    showInputBox.mockResolvedValue('MyPatch.esp');
    showQuickPick.mockResolvedValue({ choice: 'overwrite' });

    const { run, reporter } = invoke(client, mo2);
    await run();

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to create plugin — Bad Request', detail: undefined },
    ]);
    expect(appendPlugin).not.toHaveBeenCalled();
    expect(reporter.landings).toEqual([]);
  });

  // ADR-0007: the create landed, so the file exists — only its load-order line is missing, and
  // the user is told that much rather than a bare "created".
  it('reports a failed load-order append at error with the refusal as its detail, never the created toast', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('createPlugin', { name: 'MyPatch.esp', path: '/mods/MyMod/MyPatch.esp', origin: 'MyMod', slot: null, version: 1 });
    const mo2 = makeMo2();
    showInputBox.mockResolvedValue('MyPatch.esp');
    showQuickPick.mockResolvedValue({ choice: 'overwrite' });
    vi.mocked(appendPlugin).mockResolvedValue({ applied: false, refusal: 'plugins.txt is read-only' });

    const { run, reporter } = invoke(client, mo2);
    await run();

    expect(reporter.reports).toEqual([{
      severity: 'error',
      message: 'Created "MyPatch.esp", but could not add it to the load order.',
      detail: 'plugins.txt is read-only',
    }]);
    expect(reporter.landings).toEqual([]);
  });

  // ADR-0015 invariant 2: create plugin writes and returns, and the new row arrives with the
  // Instance loader's next value.
  it('refreshes nothing once the plugin lands, and the rows show it when the next instance value arrives', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('createPlugin', { name: 'MyPatch.esp', path: '/instance/overwrite/MyPatch.esp', origin: 'overwrite', slot: null, version: 1 });
    showInputBox.mockResolvedValue('MyPatch.esp');
    showQuickPick.mockResolvedValue({ choice: 'overwrite' });
    vi.mocked(appendPlugin).mockResolvedValue({ applied: true, wrote: true });
    const mo2 = makeMo2();
    const instance = new FakeInstance(mo2.instance.value);
    const tree = new PluginsTreeProvider({ instance, source: { reorderPlugins: () => Promise.resolve() } });
    expect(await tree.getChildren()).toEqual([]);
    let changes = 0;
    tree.onDidChangeTreeData(() => { changes++; });

    const { run } = invoke(client, { ...mo2, instance });
    await run();

    expect(changes).toBe(0);
    expect(await tree.getChildren()).toEqual([]);

    instance.publish(instanceValueFixture({
      ...mo2.instance.value,
      plugins: [{ name: 'MyPatch.esp', path: '/instance/overwrite/MyPatch.esp', origin: 'overwrite', slot: 0, enabled: true, winning: true }],
    }));

    expect(changes).toBeGreaterThan(0);
    expect(expectInstancesOf(await tree.getChildren(), PluginNode).map((row) => row.plugin.name)).toEqual(['MyPatch.esp']);
  });

  it('reports the missing-workspace refusal at error and prompts for nothing', async () => {
    const { run, reporter } = invoke(new InMemoryMEditClient(), undefined);

    await run();

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Creating a plugin needs an open MO2 instance workspace.', detail: undefined },
    ]);
    expect(showInputBox).not.toHaveBeenCalled();
  });
});

describe('registerRevealInExplorerCommand', () => {
  function invoke(resolvePluginPath: (name: string) => Promise<string | undefined>, viewSelection: readonly PluginsTreeNode[] = []) {
    const reporter = recordingReporter();
    registerRevealInExplorerCommand(
      { resolvePluginPath: (row) => resolvePluginPath(pluginFileOf(row)) }, reporter, () => viewSelection);
    return { run: present(handlers.get('modbench.plugin.reveal'), "the reveal plugin command's registered handler"), reporter };
  }

  // plugins.md, Menus and keys: the locked row's reveal opens the game folder's copy.
  it('reveals a locked row\'s file from the row the tree resolves it to', async () => {
    const { run } = invoke((name) => Promise.resolve(`/game/Data/${name}`));

    await run(new ImplicitMasterNode('Fallout4.esm', 'Data'));

    expect(executeCommand).toHaveBeenCalledWith('revealFileInOS', { fsPath: '/game/Data/Fallout4.esm' });
  });

  it('says the game folder was not found when a locked row resolves to no file', async () => {
    const { run, reporter } = invoke(() => Promise.resolve(undefined));

    await run(new ImplicitMasterNode('Fallout4.esm', 'Data'));

    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not resolve a file location for "Fallout4.esm" — the game folder was not found.', detail: undefined,
    }]);
  });

  it('reveals the one selected locked row from the palette', async () => {
    const { run } = invoke((name) => Promise.resolve(`/game/Data/${name}`), [new ImplicitMasterNode('Fallout4.esm', 'Data')]);

    await run();

    expect(executeCommand).toHaveBeenCalledWith('revealFileInOS', { fsPath: '/game/Data/Fallout4.esm' });
  });

  it('reveals the resolved file in the OS explorer and says nothing', async () => {
    const { run, reporter } = invoke(() => Promise.resolve('/instance/mods/MyMod/MyMod.esp'));

    await run(new PluginNode({ name: 'MyMod.esp', enabled: true }, 'SomeMod'));

    expect(executeCommand).toHaveBeenCalledWith('revealFileInOS', { fsPath: '/instance/mods/MyMod/MyMod.esp' });
    expect(reporter.reports).toEqual([]);
    expect(reporter.landings).toEqual([]);
  });

  it('reports an unresolved file location at error, naming why, rather than doing nothing', async () => {
    const { run, reporter } = invoke(() => Promise.resolve(undefined));

    await run(new PluginNode({ name: 'MyMod.esp', enabled: true }, 'SomeMod'));

    expect(reporter.reports).toEqual([
      {
        severity: 'error',
        message: 'Could not resolve a file location for "MyMod.esp" — no mod or Overwrite holds this file.',
        detail: undefined,
      },
    ]);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  // commands.md, Where: the palette hands the gesture no row, so it takes the one selected plugin.
  it('reveals the one selected plugin from the palette', async () => {
    const { run } = invoke(
      (name) => Promise.resolve(`/instance/mods/MyMod/${name}`), [new PluginNode({ name: 'Selected.esp', enabled: true }, 'SomeMod')]);

    await run();

    expect(executeCommand).toHaveBeenCalledWith('revealFileInOS', { fsPath: '/instance/mods/MyMod/Selected.esp' });
  });

  it('reveals nothing from the palette over a selection of several plugins', async () => {
    const { run } = invoke(() => Promise.resolve('/instance/mods/MyMod/MyMod.esp'), [
      new PluginNode({ name: 'A.esp', enabled: true }, 'SomeMod'), new PluginNode({ name: 'B.esp', enabled: true }, 'SomeMod'),
    ]);

    await run();

    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('reports a rejected reveal at error with the thrown message as its detail', async () => {
    executeCommand.mockRejectedValue(new Error('no file manager'));
    const { run, reporter } = invoke(() => Promise.resolve('/instance/mods/MyMod/MyMod.esp'));

    await run(new PluginNode({ name: 'MyMod.esp', enabled: true }, 'SomeMod'));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to reveal "MyMod.esp" in Explorer.', detail: 'no file manager' },
    ]);
  });
});

// plugins.md, Menus and keys, story 8: copy value copies each selected plugin as its file name and
// each selected record as `EditorID [FormKey]`, or the FormKey alone with no EditorID, one to a line.
describe('pluginsCopyValueText', () => {
  const plugin = new PluginNode({ name: 'Alpha.esp', enabled: true }, 'ModA');
  const locked = new ImplicitMasterNode('Fallout4.esm', 'Data');
  const record = new RecordNode(recordSummaryFixture({ formKey: '000800:Alpha.esp', plugin: 'Alpha.esp', editorId: 'Gun' }), 'ModA');
  const unnamed = new RecordNode(recordSummaryFixture({ formKey: '000801:Alpha.esp', plugin: 'Alpha.esp', editorId: null }), 'ModA');
  const worldspace = new WorldspaceNode('Alpha.esp', { formKey: '000802:Alpha.esp', editorId: 'World', hasParseFailure: false, hasChildren: true });
  const cell = new CellNode('Alpha.esp', {
    formKey: '000803:Alpha.esp', editorId: 'Room', cellX: null, cellY: null, isPersistentWorldspaceCell: false, hasChildren: false, fullName: 'A Room', hasParseFailure: false,
  });
  const placedRef = new PlacedNode('Alpha.esp', {
    formKey: '000804:Alpha.esp', editorId: null, baseFormKey: '000800:Alpha.esp', recordType: 'refr', hasParseFailure: false,
  });
  const group = new RecordTypeNode('Alpha.esp', 'weap', 2, 'Weapon');
  const mixed = [plugin, record, locked, unnamed, worldspace, cell, placedRef, group];
  const LINES = [
    'Alpha.esp', 'Gun [000800:Alpha.esp]', 'Fallout4.esm', '000801:Alpha.esp',
    'World [000802:Alpha.esp]', 'Room [000803:Alpha.esp]', '000804:Alpha.esp',
  ].join('\n');

  it('copies a mixed selection right-clicked in the tree, a row that stands for neither adding nothing', () => {
    expect(pluginsCopyValueText(() => mixed)(record, mixed)).toBe(LINES);
  });

  it('copies the selection the Plugins key hands it', () => {
    expect(pluginsCopyValueText(() => mixed)(PLUGINS_KEY_ARGS, undefined)).toBe(LINES);
  });

  it('copies the right-clicked row alone when it is outside the selection', () => {
    expect(pluginsCopyValueText(() => mixed)(locked, undefined)).toBe('Fallout4.esm');
  });

  // Another view's row or key, and the palette's bare call, belong to the next adapter.
  it('defers what is not the Plugins view\'s', () => {
    const copy = pluginsCopyValueText(() => mixed);
    expect(copy(undefined, undefined)).toBeUndefined();
    expect(copy({ view: 'modbench.modList' }, undefined)).toBeUndefined();
    expect(copy(new TreeItem('a Mods row'), undefined)).toBeUndefined();
  });
});

// plugins.md, Order and view state, story 1; common.md, A view, story 4: a lens, not a setting.
describe('the sort direction', () => {
  const directionKeys = () => executeCommand.mock.calls
    .filter((c) => c[0] === 'setContext' && (c as unknown[])[1] === 'modbench.plugin.winningAtTop')
    .map((c) => (c as unknown[])[2]);
  const run = (command: string) => present(handlers.get(command), command)();

  // A context key outlives an extension host restart; the view's direction does not.
  it('starts losing at the top, and the title-bar icon agrees', () => {
    const setViewDirection = vi.fn();
    registerPluginSortCommands({ setViewDirection });

    expect(setViewDirection).not.toHaveBeenCalled();
    expect(directionKeys()).toEqual([false]);
  });

  it('each title-bar icon sets its own direction, whatever the view last showed', async () => {
    const setViewDirection = vi.fn();
    registerPluginSortCommands({ setViewDirection });

    await run('modbench.plugin.sortLosingAtTop');
    await run('modbench.plugin.sortWinningAtTop');
    await run('modbench.plugin.sortWinningAtTop');

    expect(setViewDirection.mock.calls).toEqual([['losingAtTop'], ['winningAtTop'], ['winningAtTop']]);
    expect(directionKeys()).toEqual([false, false, true, true]);
  });
});
