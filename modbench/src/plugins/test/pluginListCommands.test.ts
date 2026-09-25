import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, uriFrom } from '../../test/vscodeMock';

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
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon,
}));

vi.mock('../../pluginsCommands/plugins', () => ({ appendPlugin: vi.fn() }));

import { pluginsCopyValueText, registerCreatePluginCommand, registerRevealInExplorerCommand } from '../pluginListCommands';
import { PLUGINS_KEY_ARGS } from '../gestureEntry';
import { CellNode, PlacedNode, RecordNode, RecordTypeNode, WorldspaceNode } from '../PluginTreeProvider';
import { recordSummaryFixture } from '../../client/test/fixtures';
import { ImplicitMasterNode, PluginNode, pluginFileOf, type PluginsTreeNode } from '../PluginsTreeProvider';
import { appendPlugin } from '../../pluginsCommands/plugins';
import { InMemoryMEditClient } from '../../client';
import { recordingReporter } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';

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
    pluginsTree: { invalidate: vi.fn() },
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
      { resolvePluginPath: (row) => resolvePluginPath(pluginFileOf(row) ?? '') }, reporter, () => viewSelection);
    return { run: present(handlers.get('modbench.plugin.reveal'), "the reveal plugin command's registered handler"), reporter };
  }

  // plugins.md, Menus and keys: the locked row's reveal opens the game folder's copy.
  it('reveals a locked row\'s file from the row the tree resolves it to', async () => {
    const { run } = invoke((name) => Promise.resolve(`/game/Data/${name}`));

    await run(new ImplicitMasterNode('Fallout4.esm'));

    expect(executeCommand).toHaveBeenCalledWith('revealFileInOS', { fsPath: '/game/Data/Fallout4.esm' });
  });

  it('says the game folder was not found when a locked row resolves to no file', async () => {
    const { run, reporter } = invoke(() => Promise.resolve(undefined));

    await run(new ImplicitMasterNode('Fallout4.esm'));

    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not resolve a file location for "Fallout4.esm" — the game folder was not found.', detail: undefined,
    }]);
  });

  it('reveals the one selected locked row from the palette', async () => {
    const { run } = invoke((name) => Promise.resolve(`/game/Data/${name}`), [new ImplicitMasterNode('Fallout4.esm')]);

    await run();

    expect(executeCommand).toHaveBeenCalledWith('revealFileInOS', { fsPath: '/game/Data/Fallout4.esm' });
  });

  it('reveals the resolved file in the OS explorer and says nothing', async () => {
    const { run, reporter } = invoke(() => Promise.resolve('/instance/mods/MyMod/MyMod.esp'));

    await run(new PluginNode({ name: 'MyMod.esp', enabled: true }));

    expect(executeCommand).toHaveBeenCalledWith('revealFileInOS', { fsPath: '/instance/mods/MyMod/MyMod.esp' });
    expect(reporter.reports).toEqual([]);
    expect(reporter.landings).toEqual([]);
  });

  it('reports an unresolved file location at error, naming why, rather than doing nothing', async () => {
    const { run, reporter } = invoke(() => Promise.resolve(undefined));

    await run(new PluginNode({ name: 'MyMod.esp', enabled: true }));

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
      (name) => Promise.resolve(`/instance/mods/MyMod/${name}`), [new PluginNode({ name: 'Selected.esp', enabled: true })]);

    await run();

    expect(executeCommand).toHaveBeenCalledWith('revealFileInOS', { fsPath: '/instance/mods/MyMod/Selected.esp' });
  });

  it('reveals nothing from the palette over a selection of several plugins', async () => {
    const { run } = invoke(() => Promise.resolve('/instance/mods/MyMod/MyMod.esp'), [
      new PluginNode({ name: 'A.esp', enabled: true }), new PluginNode({ name: 'B.esp', enabled: true }),
    ]);

    await run();

    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('reports a rejected reveal at error with the thrown message as its detail', async () => {
    executeCommand.mockRejectedValue(new Error('no file manager'));
    const { run, reporter } = invoke(() => Promise.resolve('/instance/mods/MyMod/MyMod.esp'));

    await run(new PluginNode({ name: 'MyMod.esp', enabled: true }));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to reveal "MyMod.esp" in Explorer.', detail: 'no file manager' },
    ]);
  });
});

// plugins.md, Menus and keys, story 8: copy value copies each selected plugin as its file name and
// each selected record as `EditorID [FormKey]`, or the FormKey alone with no EditorID, one to a line.
describe('pluginsCopyValueText', () => {
  const plugin = new PluginNode({ name: 'Alpha.esp', enabled: true }, 'ModA');
  const locked = new ImplicitMasterNode('Fallout4.esm');
  const record = new RecordNode(recordSummaryFixture({ formKey: '000800:Alpha.esp', plugin: 'Alpha.esp', editorId: 'Gun' }), 'ModA');
  const unnamed = new RecordNode(recordSummaryFixture({ formKey: '000801:Alpha.esp', plugin: 'Alpha.esp', editorId: null }), 'ModA');
  const worldspace = new WorldspaceNode('Alpha.esp', { formKey: '000802:Alpha.esp', editorId: 'World', hasParseFailure: false });
  const cell = new CellNode('Alpha.esp', {
    formKey: '000803:Alpha.esp', editorId: 'Room', cellX: null, cellY: null, isPersistentWorldspaceCell: false, fullName: 'A Room', hasParseFailure: false,
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

  it('defers another view\'s row or key, and the palette\'s bare call, to the next adapter', () => {
    const copy = pluginsCopyValueText(() => mixed);
    expect(copy(undefined, undefined)).toBeUndefined();
    expect(copy({ view: 'modbench.modList' }, undefined)).toBeUndefined();
    expect(copy(new TreeItem('a Mods row'), undefined)).toBeUndefined();
  });
});
